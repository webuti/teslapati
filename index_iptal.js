const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs').promises;
const winston = require('winston');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

// Stealth plugin'i ekle
puppeteer.use(StealthPlugin());

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
        this.browser = null;
        this.page = null;
        this.checkInterval = null;
    }

    async initializeBrowser() {
        try {
            this.browser = await puppeteer.launch({
                headless: false,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--no-first-run',
                    '--disable-default-apps',
                    '--disable-extensions',
                    '--disable-gpu',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--disable-ipc-flooding-protection'
                ],
                ignoreDefaultArgs: ['--enable-blink-features=IdleDetection']
            });
            
            this.page = await this.browser.newPage();
            
            // Session ve cookie yönetimi
            await this.page.setCacheEnabled(true);
            await this.page.setJavaScriptEnabled(true);
            
            // Gerçekçi cookies ekle
            await this.page.setCookie(
                {
                    name: '_ga',
                    value: `GA1.2.${Math.floor(Math.random() * 1000000000)}.${Math.floor(Date.now() / 1000)}`,
                    domain: '.tesla.com'
                },
                {
                    name: '_gid',
                    value: `GA1.2.${Math.floor(Math.random() * 1000000000)}`,
                    domain: '.tesla.com'
                },
                {
                    name: 'sessionid',
                    value: Math.random().toString(36).substring(2, 15),
                    domain: '.tesla.com'
                }
            );
            
            // Gerçek tarayıcı gibi görün
            await this.page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36');
            await this.page.setViewport({ 
                width: 1920 + Math.floor(Math.random() * 100), 
                height: 1080 + Math.floor(Math.random() * 100),
                deviceScaleFactor: 1
            });
            
            // Ek stealth measures
            await this.page.evaluateOnNewDocument(() => {
                // Remove webdriver traces
                delete navigator.__proto__.webdriver;
                
                // Mock screen resolution
                Object.defineProperty(window, 'screen', {
                    value: {
                        availHeight: 1050,
                        availWidth: 1920,
                        colorDepth: 24,
                        height: 1080,
                        width: 1920,
                        pixelDepth: 24
                    }
                });
                
                // Mock Chrome runtime more realistically
                window.chrome = {
                    runtime: {
                        onConnect: undefined,
                        onMessage: undefined
                    }
                };
                
                // Mock realistic plugin list
                Object.defineProperty(navigator, 'plugins', {
                    get: () => ({
                        length: 3,
                        0: { name: 'Chrome PDF Plugin' },
                        1: { name: 'Chrome PDF Viewer' },
                        2: { name: 'Native Client' }
                    })
                });
                
                // Mock WebGL vendor
                const getParameter = WebGLRenderingContext.prototype.getParameter;
                WebGLRenderingContext.prototype.getParameter = function(parameter) {
                    if (parameter === 37445) {
                        return 'Intel Inc.';
                    }
                    if (parameter === 37446) {
                        return 'Intel Iris Pro OpenGL Engine';
                    }
                    return getParameter.call(this, parameter);
                };
            });
            
            logger.info('Browser başarıyla başlatıldı');
            
        } catch (error) {
            logger.error(`Browser başlatılamadı: ${error.message}`);
            throw error;
        }
    }

    async simulateHumanBehavior() {
        // Random mouse movement
        await this.page.mouse.move(
            Math.floor(Math.random() * 1920), 
            Math.floor(Math.random() * 1080)
        );
        
        // Random scroll
        await this.page.evaluate(() => {
            window.scrollTo(0, Math.floor(Math.random() * 500));
        });
        
        // Random pause
        await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 3000));
    }

    async visitTeslaPage() {
        try {
            // Önce Google'dan geliyormuş gibi referrer ayarla
            logger.info('Google üzerinden Tesla\'ya yönlendiriliyor...');
            
            // Google search sayfasını simüle et
            await this.page.setExtraHTTPHeaders({
                'Referer': 'https://www.google.com/',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1'
            });
            
            // Önce Tesla ana sayfasına git
            logger.info('Tesla ana sayfasına gidiliyor...');
            await this.page.goto('https://www.tesla.com/tr_TR', { 
                waitUntil: 'networkidle2',
                timeout: 60000 
            });
            
            // Human behavior simulation
            await this.simulateHumanBehavior();
            
            // Referrer'ı Tesla ana sayfa olarak güncelle
            await this.page.setExtraHTTPHeaders({
                'Referer': 'https://www.tesla.com/tr_TR',
                'Sec-Fetch-Site': 'same-origin'
            });
            
            // Şimdi inventory sayfasına git
            logger.info('Tesla envanter sayfasına gidiliyor...');
            await this.page.goto('https://www.tesla.com/tr_TR/inventory/new/my?arrangeby=plh&zip=&range=0', { 
                waitUntil: 'networkidle2',
                timeout: 60000 
            });
            
            // Sayfa yüklendikten sonra human behavior
            await this.simulateHumanBehavior();
            
            logger.info('Tesla envanter sayfası yüklendi');
            
        } catch (error) {
            logger.error(`Tesla sayfası yüklenemedi: ${error.message}`);
            throw error;
        }
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

    async checkInventory(retryCount = 0) {
        try {
            logger.info('Tesla envanter kontrol ediliyor...');
            
            // Önce sayfayı yenile - human timing ile
            await this.page.reload({ waitUntil: 'networkidle2' });
            
            // Human behavior simulation before checking
            await this.simulateHumanBehavior();
            
            // Random wait time (human-like)
            const waitTime = 3000 + Math.random() * 4000;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            
            // Sayfadaki mevcut araç durumunu kontrol et
            const pageInfo = await this.page.evaluate(() => {
                // "Aradığınız Tesla'yı göremiyor musunuz?" mesajını kontrol et
                const noResultsMessage = document.querySelector('[data-testid="no-results-message"]') || 
                                         document.querySelector('.no-results') ||
                                         document.querySelector('*');
                
                let hasNoResults = false;
                if (noResultsMessage) {
                    const text = noResultsMessage.textContent || '';
                    hasNoResults = text.includes('Aradığınız Tesla') || 
                                   text.includes('göremiyor musunuz') ||
                                   text.includes('No vehicles found') ||
                                   text.includes('Keine Fahrzeuge');
                }
                
                // Araç kartlarını say
                const carCards = document.querySelectorAll('[data-testid="result-tile"]') ||
                                document.querySelectorAll('.result-tile') ||
                                document.querySelectorAll('.inventory-item');
                
                return {
                    hasNoResults: hasNoResults,
                    carCount: carCards.length,
                    pageTitle: document.title,
                    url: window.location.href
                };
            });
            
            logger.info(`Sayfa durumu: ${JSON.stringify(pageInfo)}`);
            
            let totalMatches = 0;
            let results = [];
            
            if (pageInfo.hasNoResults) {
                logger.info('Sayfada "araç bulunamadı" mesajı var');
                totalMatches = 0;
            } else if (pageInfo.carCount > 0) {
                logger.info(`Sayfada ${pageInfo.carCount} araç kartı bulundu`);
                totalMatches = pageInfo.carCount;
                
                // API çağrısını da dene
                try {
                    const apiResult = await this.page.evaluate(async () => {
                        const query = {
                            query: {
                                model: 'my',
                                condition: 'new',
                                market: 'TR',
                                language: 'tr'
                            },
                            count: 24,
                            outsideOffset: 0,
                            outsideSearch: true
                        };
                        
                        const apiUrl = `https://www.tesla.com/inventory/api/v4/inventory-results?query=${encodeURIComponent(JSON.stringify(query))}`;
                        
                        const response = await fetch(apiUrl, {
                            method: 'GET',
                            headers: {
                                'Accept': 'application/json, text/plain, */*',
                                'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
                                'Cache-Control': 'no-cache',
                                'Pragma': 'no-cache'
                            }
                        });
                        
                        if (response.ok) {
                            return await response.json();
                        }
                        return null;
                    });
                    
                    if (apiResult && apiResult.total_matches_found !== undefined) {
                        totalMatches = apiResult.total_matches_found || 0;
                        results = apiResult.results || [];
                        logger.info(`API'den alınan veri: ${totalMatches} araç`);
                    }
                } catch (apiError) {
                    logger.warn(`API çağrısı başarısız, sayfa verisini kullanıyor: ${apiError.message}`);
                }
            } else {
                logger.info('Sayfa durumu belirsiz, API çağrısı deneniyor');
                // API çağrısını dene
                try {
                    const apiResult = await this.page.evaluate(async () => {
                        const query = {
                            query: {
                                model: 'my',
                                condition: 'new',
                                market: 'TR',
                                language: 'tr'
                            },
                            count: 24,
                            outsideOffset: 0,
                            outsideSearch: true
                        };
                        
                        const apiUrl = `https://www.tesla.com/inventory/api/v4/inventory-results?query=${encodeURIComponent(JSON.stringify(query))}`;
                        
                        const response = await fetch(apiUrl);
                        if (response.ok) {
                            return await response.json();
                        }
                        throw new Error(`HTTP ${response.status}`);
                    });
                    
                    totalMatches = apiResult.total_matches_found || 0;
                    results = apiResult.results || [];
                } catch (apiError) {
                    throw new Error(`Hem sayfa hem API kontrolü başarısız: ${apiError.message}`);
                }
            }
            
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
            if (retryCount < 3) {
                logger.warn(`API hatası, ${retryCount + 1}. deneme: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, 10000));
                return this.checkInventory(retryCount + 1);
            }
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
        
        // Environment variables validation
        if (!process.env.TELEGRAM_BOT_TOKEN) {
            throw new Error('TELEGRAM_BOT_TOKEN environment variable is required');
        }
        if (!process.env.TELEGRAM_CHAT_ID) {
            throw new Error('TELEGRAM_CHAT_ID environment variable is required');
        }
        
        try {
            // Browser'ı başlat
            await this.initializeBrowser();
            
            // Tesla sayfasına git
            await this.visitTeslaPage();
            
            // Bot başlatma bildirimi gönder
            await this.telegramNotifier.sendNotification(
                'Tesla Bot Başlatıldı',
                '🚀 Tesla Envanter Bot başarıyla başlatıldı ve çalışıyor.'
            );
            
            // İlk kontrolü hemen yap
            await this.checkInventory();
            
            // Her 5 dakikada bir kontrol et (Tesla API rate limit için)
            this.checkInterval = setInterval(() => {
                this.checkInventory().catch(error => {
                    logger.error(`Kontrol sırasında hata: ${error.message}`);
                });
            }, 300000 + Math.random() * 60000); // Random interval between 5-6 minutes
            
            logger.info('Bot başlatıldı. Her 5 dakika Tesla envanteri kontrol edilecek.');
            
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
            
            // Browser'ı kapat
            if (this.browser) {
                await this.browser.close();
                logger.info('Browser kapatıldı');
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