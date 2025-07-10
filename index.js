const axios = require('axios');
const fs = require('fs').promises;
const { HttpsProxyAgent } = require('https-proxy-agent');
const winston = require('winston');
const TelegramBot = require('node-telegram-bot-api');
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
        new winston.transports.File({ filename: 'tesla-bot.log' })
    ]
});

class TelegramNotifier {
    constructor() {
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
        this.chatId = process.env.TELEGRAM_CHAT_ID;
    }

    async sendNotification(title, message) {
        try {
            await this.bot.sendMessage(this.chatId, `*${title}*\n\n${message}`, {
                parse_mode: 'Markdown',
                disable_web_page_preview: false
            });
            logger.info(`Telegram bildirimi gönderildi: ${title}`);
        } catch (error) {
            logger.error(`Telegram bildirimi gönderilemedi: ${error.message}`);
        }
    }

    async sendInventoryUpdate(title, message) {
        await this.sendNotification(title, message);
    }

    async sendErrorNotification(title, message) {
        await this.sendNotification(title, message);
    }
}

class TeslaInventoryBot {
    constructor() {
        this.telegramNotifier = new TelegramNotifier();
        this.lastTotalMatches = 0;
        this.isErrorState = false;
        this.lastErrorTime = null;
        this.ERROR_NOTIFICATION_INTERVAL_MINUTES = 30;
        this.proxyList = [];
        this.checkInterval = null;
        this.TESLA_API_BASE_URL = 'https://www.tesla.com/coinorder/api/v4/inventory-results';
    }

    async loadProxyList() {
        try {
            const data = await fs.readFile('proxy-list.txt', 'utf8');
            this.proxyList = data.split('\n')
                .map(line => line.trim())
                .filter(line => line && line.includes(':'));
            logger.info(`${this.proxyList.length} proxy yüklendi`);
        } catch (error) {
            logger.error(`Proxy listesi yüklenemedi: ${error.message}`);
        }
    }

    getRandomProxy() {
        if (this.proxyList.length === 0) return null;
        const proxy = this.proxyList[Math.floor(Math.random() * this.proxyList.length)];
        return `http://${proxy}`;
    }

    buildTeslaApiUrl() {
        const market = process.env.TESLA_MARKET || 'DE';
        const language = process.env.TESLA_LANGUAGE || 'de';
        
        let superRegion = 'europe';
        if (market === 'US' || market === 'CA') {
            superRegion = 'north america';
        }

        const query = {
            query: {
                model: 'my',
                condition: 'new',
                options: {},
                arrangeby: 'Price',
                order: 'asc',
                market: market,
                language: language,
                super_region: superRegion,
                lng: '',
                lat: '',
                zip: '',
                range: 0
            },
            offset: 0,
            count: 24,
            outsideOffset: 0,
            outsideSearch: false,
            isFalconDeliverySelectionEnabled: true,
            version: 'v2'
        };

        return `${this.TESLA_API_BASE_URL}?query=${encodeURIComponent(JSON.stringify(query))}`;
    }

    buildTeslaCarLink(vin) {
        const market = process.env.TESLA_MARKET || 'DE';
        const language = process.env.TESLA_LANGUAGE || 'de';
        const locale = `${language.toLowerCase()}_${market.toUpperCase()}`;
        
        return `https://www.tesla.com/${locale}/my/order/${vin}?titleStatus=new&redirect=no#overview`;
    }

    buildCarDetailsMessage(car, carIndex, totalCars) {
        const vin = car.VIN || '';
        const model = car.Model || '';
        const trimName = car.TrimName || '';
        const year = car.Year || '';
        const price = car.Price || '';
        const currency = car.CurrencyCode || '';
        
        let message = `${year} ${model} ${trimName}\n`;
        
        if (price) {
            message += `Fiyat: ${price} ${currency}\n`;
        }
        
        if (vin) {
            message += `VIN: ${vin}\n`;
        }
        
        // Renk
        if (car.PAINT && car.PAINT.length > 0) {
            message += `Renk: ${car.PAINT[0]}\n`;
        }
        
        // İç mekan
        if (car.INTERIOR && car.INTERIOR.length > 0) {
            message += `İç Mekan: ${car.INTERIOR[0]}\n`;
        }
        
        // Tesla link
        if (vin) {
            const carLink = this.buildTeslaCarLink(vin);
            message += `\nTesla'da Görüntüle: ${carLink}`;
        }
        
        logger.info(`Araç detayları oluşturuldu: VIN=${vin}, Model=${model}, Fiyat=${price}`);
        
        return message;
    }

    async checkInventory() {
        try {
            logger.info('Tesla envanter kontrol ediliyor...');
            
            const apiUrl = this.buildTeslaApiUrl();
            const proxyUrl = this.getRandomProxy();
            
            const axiosConfig = {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                    'Accept': 'application/json'
                },
                timeout: 60000,
                maxRedirects: 5
            };
            
            if (proxyUrl) {
                axiosConfig.httpsAgent = new HttpsProxyAgent(proxyUrl);
                axiosConfig.proxy = false; // axios'un kendi proxy ayarını devre dışı bırak
            }
            
            const response = await axios.get(apiUrl, axiosConfig);
            const data = response.data;
            
            const totalMatches = data.total_matches_found || 0;
            let results = data.results || [];
            
            // results bir array değilse exact/approximate kontrol et
            if (!Array.isArray(results)) {
                const exactResults = results.exact || [];
                const approximateResults = results.approximate || [];
                results = [...exactResults, ...approximateResults];
            }
            
            logger.info(`Toplam eşleşme: ${totalMatches}, Results: ${results.length}`);
            
            // Hata durumunu temizle
            if (this.isErrorState) {
                this.isErrorState = false;
                this.lastErrorTime = null;
                logger.info('API hatası düzeldi. Normal kontroller devam ediyor.');
            }
            
            // Yeni araç geldi mi kontrol et
            if (totalMatches !== this.lastTotalMatches && this.lastTotalMatches > 0) {
                const newCars = totalMatches - this.lastTotalMatches;
                const message = `🎉 Tesla envanterinde ${newCars} yeni araç bulundu!\nToplam: ${totalMatches} araç\n\n`;
                
                // Yeni araçların detaylarını gönder
                if (results.length > 0) {
                    logger.info(`${results.length} yeni araç bulundu, detaylı mesajlar gönderiliyor...`);
                    
                    for (let i = 0; i < Math.min(results.length, newCars); i++) {
                        const car = results[i];
                        const carDetails = this.buildCarDetailsMessage(car, i + 1, results.length);
                        await this.telegramNotifier.sendInventoryUpdate('🚗 Yeni Tesla Araç', carDetails);
                        
                        // Telegram rate limit için küçük bir gecikme
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
                
                await this.telegramNotifier.sendInventoryUpdate('Tesla Envanter Güncellemesi', message);
                logger.info('Yeni araç bildirimi gönderildi');
            }
            
            // İlk çalıştırma
            if (this.lastTotalMatches === 0 && totalMatches > 0) {
                const message = `📊 Tesla envanterinde ${totalMatches} araç bulundu\n\n`;
                await this.telegramNotifier.sendInventoryUpdate('Tesla Envanter Durumu', message);
                
                // İlk 5 aracın detaylarını gönder
                const carsToShow = Math.min(results.length, 5);
                for (let i = 0; i < carsToShow; i++) {
                    const car = results[i];
                    const carDetails = this.buildCarDetailsMessage(car, i + 1, results.length);
                    await this.telegramNotifier.sendInventoryUpdate('Araç', carDetails);
                    
                    // Telegram rate limit için küçük bir gecikme
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                
                if (results.length > 5) {
                    await this.telegramNotifier.sendNotification(
                        'Daha Fazla Araç',
                        `Toplamda ${results.length} araç mevcut. İlk 5 tanesi gösterildi.`
                    );
                }
                
                logger.info(`İlk başlatmada araç detayları gönderildi. Toplam: ${results.length}`);
            }
            
            this.lastTotalMatches = totalMatches;
            
        } catch (error) {
            this.handleError(`API isteği hatası: ${error.message}`);
        }
    }

    async handleError(errorMessage) {
        logger.error(`Hata: ${errorMessage}`);
        
        if (!this.isErrorState) {
            // İlk hata
            this.isErrorState = true;
            this.lastErrorTime = new Date();
            await this.telegramNotifier.sendErrorNotification(
                'Tesla Bot Hatası',
                `❌ Tesla API'sine erişim hatası: ${errorMessage}`
            );
            logger.info('İlk hata bildirimi gönderildi');
        } else {
            // Sürekli hata durumu - 30 dakika kontrol et
            const now = new Date();
            const timeDiff = (now - this.lastErrorTime) / 1000 / 60; // dakika
            
            if (timeDiff >= this.ERROR_NOTIFICATION_INTERVAL_MINUTES) {
                await this.telegramNotifier.sendErrorNotification(
                    'Tesla Bot Sürekli Hata',
                    `⚠️ Tesla API hatası ${this.ERROR_NOTIFICATION_INTERVAL_MINUTES} dakikadır devam ediyor: ${errorMessage}`
                );
                this.lastErrorTime = now;
                logger.info('Sürekli hata bildirimi gönderildi');
            }
        }
    }

    async start() {
        logger.info('Tesla Envanter Bot başlatılıyor...');
        
        try {
            // Proxy listesini yükle
            await this.loadProxyList();
            
            // Bot başlatma bildirimi gönder
            await this.telegramNotifier.sendNotification(
                'Tesla Bot Başlatıldı',
                '🚀 Tesla Envanter Bot başarıyla başlatıldı ve çalışıyor.'
            );
            
            // İlk kontrolü hemen yap
            await this.checkInventory();
            
            // Her 10 saniyede bir kontrol et
            this.checkInterval = setInterval(() => {
                this.checkInventory().catch(error => {
                    logger.error(`Kontrol sırasında hata: ${error.message}`);
                });
            }, 10000);
            
            logger.info('Bot başlatıldı. Her 10 saniye Tesla envanteri kontrol edilecek.');
            
        } catch (error) {
            logger.error(`Bot başlatılırken hata oluştu: ${error.message}`);
            await this.telegramNotifier.sendErrorNotification(
                'Tesla Bot Başlatma Hatası',
                `❌ Bot başlatılırken hata oluştu: ${error.message}`
            );
            throw error;
        }
    }

    async stop() {
        logger.info('Bot durduruluyor...');
        
        try {
            // Interval'i temizle
            if (this.checkInterval) {
                clearInterval(this.checkInterval);
            }
            
            // Bot kapatma bildirimi gönder
            await this.telegramNotifier.sendNotification(
                'Tesla Bot Durduruldu',
                '🛑 Tesla Envanter Bot durduruldu.'
            );
            
            logger.info('Bot durduruldu.');
            
        } catch (error) {
            logger.error(`Bot durdurulurken hata oluştu: ${error.message}`);
            
            try {
                await this.telegramNotifier.sendErrorNotification(
                    'Tesla Bot Durdurma Hatası',
                    `⚠️ Bot durdurulurken hata oluştu: ${error.message}`
                );
            } catch (notificationError) {
                logger.error(`Durdurma hatası bildirimi gönderilemedi: ${notificationError.message}`);
            }
        }
    }
}

// Ana fonksiyon
async function main() {
    const bot = new TeslaInventoryBot();
    
    // Graceful shutdown
    process.on('SIGINT', async () => {
        logger.info('SIGINT sinyali alındı...');
        await bot.stop();
        process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
        logger.info('SIGTERM sinyali alındı...');
        await bot.stop();
        process.exit(0);
    });
    
    try {
        await bot.start();
    } catch (error) {
        logger.error(`Bot başlatılamadı: ${error.message}`);
        process.exit(1);
    }
}

// Uygulamayı başlat
main();