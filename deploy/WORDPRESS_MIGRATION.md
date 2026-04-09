# Datorsc Scraper — WordPress Server Migration Guide

# ──────────────────────────────────────────────────────────────────────────────

## Prerequisites

- VPS / dedicated server running WordPress (Linux, Nginx, PHP-FPM)
- Node.js ≥ 20 installed (`node -v`)
- PM2 installed globally (`npm i -g pm2`)
- MySQL 8.x (same DB used by WordPress host or a separate DB)
- Let's Encrypt SSL already active on the WordPress domain

---

## 1. Clone / upload the project

```bash
git clone <your-repo> /var/www/datorsc-scraper
cd /var/www/datorsc-scraper
npm ci --omit=dev
```

## 2. Create .env

```bash
cp env.example .env
nano .env
```

Required variables:

- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `ADMIN_SECRET_KEY=<long random string>` # password for the admin panel
- `ADMIN_PORT=3001` # must match nginx-admin.conf.example
- All proxy + affiliate keys

## 3. Run DB migrations

```bash
node migrations/run.js
```

Creates all tables including `dsc_source_flags` (migration 011).

## 4. Start both processes with PM2

```bash
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup   # follow the printed command to auto-start on boot
```

Processes started:

- `datorsc-scraper` — cron scheduler (lib/scheduler.js)
- `datorsc-admin` — admin panel (admin/server.js, port 3001)

## 5. Configure Nginx

```bash
cp deploy/nginx-admin.conf.example /etc/nginx/sites-available/datorsc-admin
# Edit: replace dator.se with your real domain
nano /etc/nginx/sites-available/datorsc-admin

ln -s /etc/nginx/sites-available/datorsc-admin \
      /etc/nginx/sites-enabled/datorsc-admin

nginx -t && systemctl reload nginx
```

The admin panel is now accessible at: `https://dator.se/scraper-admin/`

## 6. Verify

```bash
# Check PM2 processes
pm2 status

# Tail logs
pm2 logs datorsc-admin --lines 50
pm2 logs datorsc-scraper --lines 50

# Test admin panel auth
curl -u admin:YOUR_SECRET_KEY https://dator.se/scraper-admin/
```

## 7. Security checklist

- [ ] `ADMIN_SECRET_KEY` is ≥ 32 random characters
- [ ] `.env` is not in the git repository (check `.gitignore`)
- [ ] Nginx is enforcing HTTPS (HTTP → 301 redirect is in config)
- [ ] Admin panel is only reachable via Nginx (Node.js binds to 127.0.0.1)
- [ ] Consider IP allowlist in Nginx `location /scraper-admin/` block
- [ ] `pm2 save` and `pm2 startup` run so processes survive reboots

---

## Updating the scraper

```bash
cd /var/www/datorsc-scraper
git pull
npm ci --omit=dev
node migrations/run.js   # safe to re-run; skips already-applied migrations
pm2 restart ecosystem.config.js
```
