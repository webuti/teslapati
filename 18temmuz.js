const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
require('dotenv').config();

// Telegram bot ayarları
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

// Token kontrolü
if (!token || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID environment variables gerekli');
    process.exit(1);
}

const bot = new TelegramBot(token);

// Tesla modelleri - sadece Model Y
const models = ['my'];

// Temel sorgu parametreleri (working curl'den alındı)
const baseQuery = {
  condition: 'new',
  options: {},
  arrangeby: 'Price',
  order: 'asc',
  market: 'TR',
  language: 'tr',
  super_region: 'north america',
  lng: 28.9601,
  lat: 41.03,
  zip: '34080',
  range: 0
};

// Önceki araç VIN'lerini saklamak için
let previousVins = new Set();

// Bot algılama karşıtı stratejiler
const userAgents = [
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
];

const getRandomUserAgent = () => userAgents[Math.floor(Math.random() * userAgents.length)];

const getRandomDelay = () => Math.floor(Math.random() * 3000) + 1000;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Belirli bir model için envanteri getiren fonksiyon
async function fetchInventory(model, attempt = 1) {
  const query = {
    query: {
      ...baseQuery,
      model
    },
    offset: 0,
    count: 24,
    outsideOffset: 0,
    outsideSearch: false,
    isFalconDeliverySelectionEnabled: true,
    version: 'v2'
  };

  const encodedQuery = encodeURIComponent(JSON.stringify(query));
  const url = `https://www.tesla.com/coinorder/api/v4/inventory-results?query=${encodedQuery}`;

  const strategies = [
    // Strateji 1: Çalışan curl'ün tam kopyası
    {
      headers: {
        'accept': '*/*',
        'accept-language': 'tr-TR,tr;q=0.9,en;q=0.8,ja;q=0.7,ru;q=0.6',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'priority': 'u=1, i',
        'referer': 'https://www.tesla.com/tr_tr/inventory/new/my',
        'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
      },
      cookies: 'tsla-cookie-consent=accepted; _gcl_au=1.1.1331641573.1752777198; _ga=GA1.1.961358143.1752777198; optimizelyEndUserId=oeu1752777241908r0.6631413698015863; ip_info={"ip":"212.125.10.68","location":{"latitude":41.03,"longitude":28.9601},"region":{"longName":"Istanbul","regionCode":"34"},"city":"Istanbul","country":"TÃ¼rkiye","countryCode":"TR","postalCode":"34080"}; coin_auth_session=ceed9633b05c5716364c3653b459e5f9'
    },
    // Strateji 2: Minimal headers
    {
      headers: {
        'accept': '*/*',
        'accept-language': 'tr-TR,tr;q=0.9,en;q=0.8',
        'referer': 'https://www.tesla.com/tr_tr/inventory/new/my',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
      }
    },
    // Strateji 3: Chrome modern
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
        'Referer': 'https://www.tesla.com/tr_tr/inventory/new/my',
        'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"'
      }
    }
  ];

  const maxAttempts = strategies.length;
  
  for (let i = 0; i < maxAttempts; i++) {
    const strategy = strategies[i];
    
    try {
      const userAgent = strategy.headers['User-Agent'] || strategy.headers['user-agent'] || 'Unknown';
      console.log(`Model ${model} için deneme ${i + 1}/${maxAttempts} - Strateji: ${userAgent.substring(0, 50)}...`);
      
      // Her deneme arasında rastgele bekleme
      if (i > 0) {
        const delay = getRandomDelay();
        console.log(`${delay}ms bekleniyor...`);
        await sleep(delay);
      }

      const requestConfig = {
        headers: strategy.headers,
        timeout: 15000,
        validateStatus: function (status) {
          return status < 500; // 500'den küçük statusları kabul et
        }
      };

      // Eğer cookies varsa ekle
      if (strategy.cookies) {
        requestConfig.headers['cookie'] = strategy.cookies;
      }

      const response = await axios.get(url, requestConfig);

      console.log(`Response status: ${response.status}`);
      
      if (response.status === 200) {
        console.log(`✅ Model ${model} için başarılı! Status: ${response.status}`,response.data);
        return response.data.results || [];
      } else {
        console.log(`❌ Model ${model} için başarısız. Status: ${response.status}`);
      }
      
    } catch (error) {
      console.error(`Model ${model} deneme ${i + 1} hata:`, error.response?.status || error.message);
    }
  }

  console.log(`❌ Model ${model} için tüm stratejiler başarısız oldu.`);
  return [];
}

// Ana envanter kontrol fonksiyonu
async function checkInventory() {
  let allVehicles = [];

  // Her model için envanteri al
  for (const model of models) {
    const vehicles = await fetchInventory(model);
    allVehicles = allVehicles.concat(vehicles);
  }

  // Mevcut VIN'leri al
  const currentVins = new Set(allVehicles.map(v => v.vin));

  // İlk çalıştırmada bildirim gönderme, sadece VIN'leri kaydet
  if (previousVins.size > 0) {
    const newVins = [...currentVins].filter(vin => !previousVins.has(vin));

    // Yeni araçlar için Telegram bildirimi gönder
    for (const vin of newVins) {
      const vehicle = allVehicles.find(v => v.vin === vin);
      const message = `Yeni araç eklendi: Model ${vehicle.model}, Fiyat ${vehicle.price}, Bağlantı: ${vehicle.url || 'Bağlantı mevcut değil'}`;
      bot.sendMessage(chatId, message).catch(error => {
        console.error('Telegram mesajı gönderilirken hata:', error.message);
      });
    }
  }

  // Önceki VIN'leri güncelle
  previousVins = currentVins;
}

// İlk çalıştırmada envanteri başlat
checkInventory().then(() => {
  // Her 15 dakikada bir kontrol et
  cron.schedule('*/5 * * * *', checkInventory);
  console.log('Bot başlatıldı, envanter kontrolü her 5 dakikada bir yapılacak.');
});
