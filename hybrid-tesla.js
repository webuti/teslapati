const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const TelegramBot = require('node-telegram-bot-api');
const winston = require('winston');
require('dotenv').config();

// Stealth plugin
puppeteer.use(StealthPlugin());

// Logger
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
        new winston.transports.File({ filename: 'hybrid-tesla-bot.log' })
    ]
});

class HybridTeslaTracker {
    constructor() {
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
        this.chatId = process.env.TELEGRAM_CHAT_ID;
        this.lastInventoryCount = 0;
        this.lastInventoryVins = new Set();
        this.checkInterval = null;
        this.browser = null;
        this.page = null;
    }

    async initializeBrowser() {
        try {
            this.browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--no-first-run',
                    '--disable-default-apps',
                    '--disable-extensions'
                ]
            });
            
            this.page = await this.browser.newPage();
            
            // TR locale optimized browser
            await this.page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36');
            await this.page.setViewport({ width: 1920, height: 1080 });
            
            // Additional stealth
            await this.page.evaluateOnNewDocument(() => {
                delete navigator.__proto__.webdriver;
                
                window.chrome = {
                    runtime: {
                        onConnect: undefined,
                        onMessage: undefined
                    }
                };
                
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3]
                });
            });
            
            logger.info('Browser başarıyla başlatıldı');
            
        } catch (error) {
            logger.error(`Browser başlatılamadı: ${error.message}`);
            throw error;
        }
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
        let message = `🚗 *Tesla Model Y*\n`;
        
        if (car.vin) {
            message += `🔢 VIN: ${car.vin}\n`;
        }
        
        if (car.price) {
            message += `💰 Fiyat: ${car.price}\n`;
        }
        
        if (car.color) {
            message += `🎨 Renk: ${car.color}\n`;
        }
        
        if (car.interior) {
            message += `🪑 İç Mekan: ${car.interior}\n`;
        }
        
        if (car.link) {
            message += `\n🔗 [Tesla'da Görüntüle](${car.link})`;
        }
        
        return message;
    }

    async visitTeslaPage() {
        try {
            logger.info('Tesla TR inventory sayfasına gidiliyor...');
            
            // Önce ana sayfaya git
            await this.page.goto('https://www.tesla.com/tr_TR', { 
                waitUntil: 'networkidle2',
                timeout: 60000 
            });
            
            // Biraz bekle
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Inventory sayfasına git
            await this.page.goto('https://www.tesla.com/tr_TR/inventory/new/my?arrangeby=plh&zip=&range=0', { 
                waitUntil: 'networkidle2',
                timeout: 60000 
            });
            
            // Sayfa yüklenmesini bekle
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            logger.info('Tesla inventory sayfası yüklendi');
            
        } catch (error) {
            logger.error(`Tesla sayfası yüklenemedi: ${error.message}`);
            throw error;
        }
    }

    async scrapeInventoryFromPage() {
        try {
            logger.info('Sayfa üzerinden envanter verisi alınıyor...');
            
            // Sayfayı yenile
            await this.page.reload({ waitUntil: 'networkidle2' });
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Sayfa verisini al
            const inventoryData = await this.page.evaluate(() => {
                // Tesla'nın araç kartlarını bul
                const carCards = document.querySelectorAll('[data-testid="InventoryCard"], .result-tile, .inventory-card, .vehicle-card');
                
                const cars = [];
                
                carCards.forEach((card, index) => {
                    try {
                        const car = {
                            id: index,
                            vin: null,
                            price: null,
                            color: null,
                            interior: null,
                            link: null
                        };
                        
                        // VIN bul
                        const vinElement = card.querySelector('[data-testid="vin"], .vin, [class*="vin"]');
                        if (vinElement) {
                            car.vin = vinElement.textContent?.trim();
                        }
                        
                        // Fiyat bul
                        const priceElement = card.querySelector('[data-testid="price"], .price, [class*="price"]');
                        if (priceElement) {
                            car.price = priceElement.textContent?.trim();
                        }
                        
                        // Renk bul
                        const colorElement = card.querySelector('[data-testid="color"], .color, [class*="color"]');
                        if (colorElement) {
                            car.color = colorElement.textContent?.trim();
                        }
                        
                        // İç mekan bul
                        const interiorElement = card.querySelector('[data-testid="interior"], .interior, [class*="interior"]');
                        if (interiorElement) {
                            car.interior = interiorElement.textContent?.trim();
                        }
                        
                        // Link bul
                        const linkElement = card.querySelector('a[href*="/order/"], a[href*="/my/"]');
                        if (linkElement) {
                            car.link = linkElement.href;
                        }
                        
                        cars.push(car);
                        
                    } catch (error) {
                        console.log('Araç kartı işlenirken hata:', error);
                    }
                });
                
                // "Araç bulunamadı" mesajını kontrol et
                const noResultsElements = document.querySelectorAll('*');
                let hasNoResults = false;
                
                for (let element of noResultsElements) {
                    const text = element.textContent || '';
                    if (text.includes('Aradığınız Tesla') || 
                        text.includes('göremiyor musunuz') ||
                        text.includes('No vehicles found') ||
                        text.includes('Keine Fahrzeuge')) {
                        hasNoResults = true;
                        break;
                    }
                }
                
                return {
                    cars: cars,
                    hasNoResults: hasNoResults,
                    totalFound: cars.length,
                    pageTitle: document.title,
                    url: window.location.href
                };
            });
            
            logger.info(`Sayfa analizi tamamlandı: ${inventoryData.totalFound} araç bulundu`);
            
            return inventoryData;
            
        } catch (error) {
            logger.error(`Sayfa analizi hatası: ${error.message}`);
            throw error;
        }
    }

    async checkInventory() {
        try {
            logger.info('🇹🇷 Tesla TR Model Y envanteri kontrol ediliyor...');
            
            const inventoryData = await this.scrapeInventoryFromPage();
            
            const currentCount = inventoryData.totalFound;
            const currentVins = new Set(
                inventoryData.cars
                    .map(car => car.vin)
                    .filter(vin => vin && vin.length > 5)
            );
            
            logger.info(`Mevcut envanter: ${currentCount} araç`);
            
            // İlk çalıştırma - sadece araç varsa bildirim gönder
            if (this.lastInventoryCount === 0) {
                this.lastInventoryCount = currentCount;
                this.lastInventoryVins = currentVins;
                
                // Sadece araç varsa başlangıç mesajı gönder
                if (currentCount > 0) {
                    const message = `📊 Tesla TR Model Y envanterinde ${currentCount} araç bulundu\n\n` +
                                  `🌍 Kaynak: Sayfa scraping (TR)\n` +
                                  `🔄 Bot başlatıldı ve takip ediliyor.`;
                    
                    await this.sendTelegramMessage('🇹🇷 Tesla TR Bot - Araç Bulundu!', message);
                    
                    // İlk 3 aracın detaylarını gönder
                    const carsToShow = Math.min(inventoryData.cars.length, 3);
                    for (let i = 0; i < carsToShow; i++) {
                        const carDetails = this.formatCarDetails(inventoryData.cars[i]);
                        await this.sendTelegramMessage(`Mevcut Araç ${i + 1}/${inventoryData.cars.length}`, carDetails);
                        
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                    
                    if (inventoryData.cars.length > 3) {
                        await this.sendTelegramMessage(
                            'Daha Fazla Araç',
                            `Ve ${inventoryData.cars.length - 3} araç daha mevcut...`
                        );
                    }
                } else {
                    // Araç yoksa sadece log, Telegram mesajı yok
                    logger.info('🇹🇷 Tesla TR Bot başlatıldı. Şu anda araç yok, sessiz takip modunda.');
                }
                
                return;
            }
            
            // Yeni araç kontrolü
            if (currentCount > this.lastInventoryCount) {
                const newCarCount = currentCount - this.lastInventoryCount;
                logger.info(`${newCarCount} yeni araç tespit edildi!`);
                
                // Yeni araçları bul
                const newCars = inventoryData.cars.filter(car => 
                    car.vin && !this.lastInventoryVins.has(car.vin)
                );
                
                // Genel bildirim
                const alertMessage = `🎉 *Tesla Model Y TR Envanterinde Yeni Araç!*\n\n` +
                                   `📈 ${newCarCount} yeni araç eklendi\n` +
                                   `📊 Toplam: ${currentCount} araç\n` +
                                   `⏰ ${new Date().toLocaleString('tr-TR')}`;
                
                await this.sendTelegramMessage('🚨 YENİ ARAÇ ALARMI', alertMessage);
                
                // Yeni araçların detayları
                for (let i = 0; i < newCars.length; i++) {
                    const car = newCars[i];
                    const carDetails = this.formatCarDetails(car);
                    await this.sendTelegramMessage(`🆕 Yeni Araç ${i + 1}/${newCars.length}`, carDetails);
                    
                    await new Promise(resolve => setTimeout(resolve, 1500));
                }
                
            } else if (currentCount < this.lastInventoryCount) {
                const removedCount = this.lastInventoryCount - currentCount;
                logger.info(`${removedCount} araç envanterden çıkarıldı`);
                
                // Sadece araç kaldıysa bildirim gönder (tüm araçlar gittiyse sessiz)
                if (currentCount > 0) {
                    const message = `📉 ${removedCount} araç envanterden çıkarıldı\n` +
                                  `📊 Kalan: ${currentCount} araç`;
                    
                    await this.sendTelegramMessage('Envanter Güncellemesi', message);
                } else {
                    logger.info('Tüm araçlar envanterden çıkarıldı. Sessiz takip devam ediyor.');
                }
            } else {
                // Araç sayısı değişmedi - sadece log
                logger.info(`Envanter değişmedi: ${currentCount} araç`);
            }
            
            // Son durumu güncelle
            this.lastInventoryCount = currentCount;
            this.lastInventoryVins = currentVins;
            
        } catch (error) {
            logger.error(`Envanter kontrolü hatası: ${error.message}`);
            
            const errorMessage = `❌ Tesla sayfa analizi hatası: ${error.message}\n\n` +
                                `🔄 Bir sonraki kontrolde tekrar denenecek.`;
            
            await this.sendTelegramMessage('Tesla Bot Hatası', errorMessage);
        }
    }

    async start() {
        logger.info('Hybrid Tesla Tracker başlatılıyor...');
        
        if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
            throw new Error('TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID gerekli');
        }
        
        try {
            await this.initializeBrowser();
            await this.visitTeslaPage();
            
            // İlk kontrolü yap
            await this.checkInventory();
            
            // Her 3 dakikada bir kontrol et (sayfa scraping daha az agresif olmalı)
            this.checkInterval = setInterval(() => {
                this.checkInventory().catch(error => {
                    logger.error(`Periyodik kontrol hatası: ${error.message}`);
                });
            }, 180000); // 3 dakika
            
            logger.info('Hybrid Tesla Tracker başlatıldı. Her 3 dakika kontrol edilecek.');
            
        } catch (error) {
            logger.error(`Tracker başlatılamadı: ${error.message}`);
            throw error;
        }
    }

    async stop() {
        logger.info('Hybrid Tesla Tracker durduruluyor...');
        
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
        }
        
        if (this.browser) {
            await this.browser.close();
        }
        
        // Bot durdurulurken sadece log, Telegram spam'i önlemek için mesaj yok
        logger.info('🛑 Hybrid Tesla Tracker temiz şekilde durduruldu.');
        
        logger.info('Hybrid Tesla Tracker durduruldu.');
    }
}

// Ana fonksiyon
async function main() {
    const tracker = new HybridTeslaTracker();
    
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

main();