"use strict";

// PM2 process manager configuration.
// Usage:
//   pm2 start ecosystem.config.js           # start
//   pm2 restart ecosystem.config.js         # restart
//   pm2 stop datorsc-scraper                # stop
//   pm2 logs datorsc-scraper                # tail logs
//   pm2 save && pm2 startup                 # persist across reboots

module.exports = {
  apps: [
    {
      name: "datorsc-admin",
      script: "admin/server.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      error_file: "logs/admin-error.log",
      out_file: "logs/admin-out.log",
      merge_logs: true,
      env: {
        NODE_ENV: "development",
      },
      env_production: {
        NODE_ENV: "production",
      },
    },
    {
      name: "datorsc-scraper",
      script: "lib/scheduler.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      // PM2 log rotation handled by pm2-logrotate module
      error_file: "logs/pm2-error.log",
      out_file: "logs/pm2-out.log",
      merge_logs: true,
      env: {
        NODE_ENV: "development",
      },
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
