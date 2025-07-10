module.exports = {
  apps: [{
    name: 'tesla-bot',
    script: './index.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    
    // Yeniden başlatma stratejisi
    min_uptime: '10s',
    max_restarts: 10,
    restart_delay: 4000,
    
    // Ortam değişkenleri
    env: {
      NODE_ENV: 'production'
    },
    
    // Log ayarları
    error_file: './logs/tesla-bot-error.log',
    out_file: './logs/tesla-bot-out.log',
    log_file: './logs/tesla-bot-combined.log',
    time: true,
    
    // Crash durumunda
    exp_backoff_restart_delay: 100,
    
    // Graceful shutdown
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 3000
  }]
};