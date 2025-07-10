const createTeslaInventory = require('tesla-inventory');
const TelegramBot = require('node-telegram-bot-api');
const winston = require('winston');
require('dotenv').config();

// Logger yapılandırması
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level.toUpperCase()}] ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'tesla-inventory-bot.log' })
    ]
});

class TeslaInventoryTracker {
    constructor() {
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
        this.chatId = process.env.TELEGRAM_CHAT_ID;
        this.lastInventoryCount = 0;
        this.lastInventoryVins = new Set();
        this.checkInterval = null;
        
        // Tesla inventory API setup with TR-optimized fetcher
        const fetcher = async (url) => {
            logger.info(`API Request: ${url}`);
            
            // TR-specific optimizations
            const isTrRequest = url.includes('market":"TR') || url.includes('tr');
            
            try {
                const headers = {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': isTrRequest ? 'tr-TR,tr;q=0.9,en;q=0.8' : 'de-DE,de;q=0.9,en;q=0.8',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'Sec-Fetch-Dest': 'empty',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'same-origin'
                };
                
                // TR için özel referrer
                if (isTrRequest) {
                    headers['Referer'] = 'https://www.tesla.com/tr_TR/';
                    headers['Origin'] = 'https://www.tesla.com';
                } else {
                    headers['Referer'] = 'https://www.tesla.com/';
                    headers['Origin'] = 'https://www.tesla.com';
                }
                
                const response = await fetch(url, {
                    method: 'GET',
                    headers: headers,
                    timeout: isTrRequest ? 45000 : 30000 // TR için daha uzun timeout
                });
                
                logger.info(`API Response Status: ${response.status} ${response.statusText}`);
                
                if (!response.ok) {
                    const errorText = await response.text();
                    logger.error(`API Error Response: ${errorText.substring(0, 200)}`);
                    
                    // TR-specific error handling
                    if (isTrRequest && (response.status === 403 || response.status === 429)) {
                        throw new Error(`TR market blocked (${response.status}) - will retry with backoff`);
                    }
                    
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                
                const text = await response.text();
                logger.info(`API Response Length: ${text.length} characters`);
                
                // HTML response kontrolü
                if (text.trim().startsWith('<') || text.includes('<HTML>')) {
                    logger.error('HTML response received instead of JSON');
                    
                    if (isTrRequest) {
                        throw new Error('TR market returned HTML - likely geo-blocked or rate limited');
                    } else {
                        throw new Error('Tesla API returned HTML instead of JSON - likely blocked or rate limited');
                    }
                }
                
                return text;
                
            } catch (error) {
                logger.error(`Fetcher error: ${error.message}`);
                throw error;
            }
        };
        
        this.teslaInventory = createTeslaInventory(fetcher);
    }

    async sendTelegramMessage(title, message) {
        try {
            await this.bot.sendMessage(this.chatId, `*${title}*\n\n${message}`, {
                parse_mode: 'Markdown',
                disable_web_page_preview: false
            });
            logger.info(`Telegram mesajı gönderildi: ${title}`);
        } catch (error) {
            logger.error(`Telegram mesajı gönderilemedi: ${error.message}`);
        }
    }

    formatCarDetails(car) {
        let message = `🚗 *${car.Year} Tesla Model ${car.Model?.toUpperCase()}*\n`;
        
        if (car.TrimName) {
            message += `Trim: ${car.TrimName}\n`;
        }
        
        if (car.Price && car.CurrencyCode) {
            message += `💰 Fiyat: ${car.Price} ${car.CurrencyCode}\n`;
        }
        
        if (car.VIN) {
            message += `🔢 VIN: ${car.VIN}\n`;
        }
        
        // Renk bilgisi
        if (car.PAINT && car.PAINT.length > 0) {
            message += `🎨 Renk: ${car.PAINT[0]}\n`;
        }
        
        // İç mekan
        if (car.INTERIOR && car.INTERIOR.length > 0) {
            message += `🪑 İç Mekan: ${car.INTERIOR[0]}\n`;
        }
        
        // Tesla link oluştur
        if (car.VIN) {
            const carLink = `https://www.tesla.com/tr_tr/my/order/${car.VIN}?titleStatus=new&redirect=no#overview`;
            message += `\n🔗 [Tesla'da Görüntüle](${carLink})`;
        }
        
        return message;
    }

    async checkInventory() {
        try {
            logger.info('Tesla TR Model Y envanteri kontrol ediliyor...');
            
            // TR market birinci öncelik - özel retry logic ile
            let results;
            let market = 'tr';
            let trRetryCount = 0;
            const maxTrRetries = 3;
            
            // TR için özel retry logic
            while (trRetryCount < maxTrRetries) {
                try {
                    logger.info(`TR market deneniyor... (Deneme ${trRetryCount + 1}/${maxTrRetries})`);
                    
                    results = await this.teslaInventory('tr', {
                        model: 'y',
                        condition: 'new',
                        arrangeby: 'Price',
                        order: 'asc'
                    });
                    
                    logger.info('🇹🇷 TR market başarılı!');
                    break; // Başarılı olduysa loop'tan çık
                    
                } catch (trError) {
                    trRetryCount++;
                    logger.warn(`TR market deneme ${trRetryCount} başarısız: ${trError.message}`);
                    
                    if (trRetryCount < maxTrRetries) {
                        // TR için özel bekleme süresi - her denemede artan süre
                        const waitTime = trRetryCount * 5000; // 5s, 10s, 15s
                        logger.info(`TR retry için ${waitTime}ms bekleniyor...`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                    }
                }
            }
            
            // TR başarısız olduysa alternatif marketler
            if (!results) {
                logger.warn('🇹🇷 TR market 3 denemede başarısız. Alternatif marketler deneniyor...');
                
                try {
                    // DE alternatif
                    logger.info('🇩🇪 DE market deneniyor...');
                    results = await this.teslaInventory('de', {
                        model: 'y',
                        condition: 'new',
                        arrangeby: 'Price',
                        order: 'asc'
                    });
                    market = 'de';
                    logger.info('🇩🇪 DE market başarılı (TR yedeği)');
                    
                    // TR yedeği kullanıldığını bildir
                    await this.sendTelegramMessage(
                        '⚠️ TR Market Sorunu',
                        '🇹🇷 TR market şu anda erişilemez durumda.\n' +
                        '🇩🇪 Geçici olarak DE market kullanılıyor.\n' +
                        '🔄 TR market tekrar denenmeye devam edilecek.'
                    );
                    
                } catch (deError) {
                    logger.warn(`DE market da başarısız: ${deError.message}`);
                    
                    // Son çare US
                    logger.info('🇺🇸 US market deneniyor...');
                    results = await this.teslaInventory('us', {
                        model: 'y',
                        condition: 'new',
                        arrangeby: 'Price',
                        order: 'asc'
                    });
                    market = 'us';
                    logger.info('🇺🇸 US market başarılı (son çare)');
                    
                    await this.sendTelegramMessage(
                        '🚨 Market Sorunu',
                        '🇹🇷 TR ve 🇩🇪 DE marketler erişilemez.\n' +
                        '🇺🇸 Geçici olarak US market kullanılıyor.\n' +
                        '⚠️ Fiyatlar USD cinsinden olacak!'
                    );
                }
            }
            
            const currentCount = results.length;
            const currentVins = new Set(results.map(car => car.VIN).filter(vin => vin));
            
            logger.info(`Mevcut envanter (${market.toUpperCase()}): ${currentCount} araç`);
            
            // İlk çalıştırma
            if (this.lastInventoryCount === 0) {
                this.lastInventoryCount = currentCount;
                this.lastInventoryVins = currentVins;
                
                const message = `📊 Tesla ${market.toUpperCase()} Model Y envanterinde ${currentCount} araç bulundu\n\n` +
                              `🌍 Market: ${market.toUpperCase()}\n` +
                              `🔄 Bot başlatıldı ve takip ediliyor.`;
                
                await this.sendTelegramMessage('Tesla Envanter Bot Başlatıldı', message);
                
                // İlk 3 aracın detaylarını gönder
                if (results.length > 0) {
                    const carsToShow = Math.min(results.length, 3);
                    for (let i = 0; i < carsToShow; i++) {
                        const carDetails = this.formatCarDetails(results[i]);
                        await this.sendTelegramMessage(`Mevcut Araç ${i + 1}/${results.length}`, carDetails);
                        
                        // Rate limit için bekle
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                    
                    if (results.length > 3) {
                        await this.sendTelegramMessage(
                            'Daha Fazla Araç',
                            `Ve ${results.length - 3} araç daha mevcut...`
                        );
                    }
                }
                
                return;
            }
            
            // Yeni araç kontrolü
            if (currentCount > this.lastInventoryCount) {
                const newCarCount = currentCount - this.lastInventoryCount;
                logger.info(`${newCarCount} yeni araç tespit edildi!`);
                
                // Yeni araçları bul
                const newCars = results.filter(car => 
                    car.VIN && !this.lastInventoryVins.has(car.VIN)
                );
                
                // Genel bildirim gönder
                const alertMessage = `🎉 *Tesla Model Y Envanterinde Yeni Araç!*\n\n` +
                                   `📈 ${newCarCount} yeni araç eklendi\n` +
                                   `📊 Toplam: ${currentCount} araç\n` +
                                   `⏰ ${new Date().toLocaleString('tr-TR')}`;
                
                await this.sendTelegramMessage('🚨 YENİ ARAÇ ALARMI', alertMessage);
                
                // Her yeni aracın detaylarını gönder
                for (let i = 0; i < newCars.length; i++) {
                    const car = newCars[i];
                    const carDetails = this.formatCarDetails(car);
                    await this.sendTelegramMessage(`🆕 Yeni Araç ${i + 1}/${newCars.length}`, carDetails);
                    
                    // Rate limit
                    await new Promise(resolve => setTimeout(resolve, 1500));
                }
                
            } else if (currentCount < this.lastInventoryCount) {
                const removedCount = this.lastInventoryCount - currentCount;
                logger.info(`${removedCount} araç envanterden çıkarıldı`);
                
                const message = `📉 ${removedCount} araç envanterden çıkarıldı\n` +
                              `📊 Kalan: ${currentCount} araç`;
                
                await this.sendTelegramMessage('Envanter Güncellemesi', message);
            }
            
            // Son durumu güncelle
            this.lastInventoryCount = currentCount;
            this.lastInventoryVins = currentVins;
            
        } catch (error) {
            logger.error(`Envanter kontrolü hatası: ${error.message}`);
            
            const errorMessage = `❌ Tesla API hatası: ${error.message}\n\n` +
                                `🔄 Bir sonraki kontrolde tekrar denenecek.`;
            
            await this.sendTelegramMessage('Tesla Bot Hatası', errorMessage);
        }
    }

    async start() {
        logger.info('Tesla Inventory Tracker başlatılıyor...');
        
        // Environment variables kontrolü
        if (!process.env.TELEGRAM_BOT_TOKEN) {
            throw new Error('TELEGRAM_BOT_TOKEN environment variable gerekli');
        }
        if (!process.env.TELEGRAM_CHAT_ID) {
            throw new Error('TELEGRAM_CHAT_ID environment variable gerekli');
        }
        
        try {
            // İlk kontrolü hemen yap
            await this.checkInventory();
            
            // Her 2 dakikada bir kontrol et (tesla-inventory daha az agresif)
            this.checkInterval = setInterval(() => {
                this.checkInventory().catch(error => {
                    logger.error(`Periyodik kontrol hatası: ${error.message}`);
                });
            }, 120000); // 2 dakika
            
            logger.info('Tesla Inventory Tracker başlatıldı. Her 2 dakika kontrol edilecek.');
            
        } catch (error) {
            logger.error(`Bot başlatılamadı: ${error.message}`);
            throw error;
        }
    }

    async stop() {
        logger.info('Tesla Inventory Tracker durduruluyor...');
        
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
        }
        
        await this.sendTelegramMessage(
            'Tesla Bot Durduruldu',
            '🛑 Tesla Inventory Tracker durduruldu.'
        );
        
        logger.info('Tesla Inventory Tracker durduruldu.');
    }
}

// Ana fonksiyon
async function main() {
    const tracker = new TeslaInventoryTracker();
    
    // Graceful shutdown
    process.on('SIGINT', async () => {
        logger.info('SIGINT sinyali alındı...');
        await tracker.stop();
        process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
        logger.info('SIGTERM sinyali alındı...');
        await tracker.stop();
        process.exit(0);
    });
    
    try {
        await tracker.start();
    } catch (error) {
        logger.error(`Tracker başlatılamadı: ${error.message}`);
        process.exit(1);
    }
}

// Uygulamayı başlat
main();