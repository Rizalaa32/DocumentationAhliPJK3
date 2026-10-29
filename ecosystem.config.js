// ecosystem.config.js — Konfigurasi PM2 untuk Server Produksi Tencent Cloud
module.exports = {
  apps: [
    {
      name: 'riksauji-pjk3',
      script: './server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '750M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};

