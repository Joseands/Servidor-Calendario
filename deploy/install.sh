#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-servcalendario.duckdns.org}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-estarlingg01@gmail.com}"
DUCKDNS_DOMAIN="${DUCKDNS_DOMAIN:-servcalendario}"
DUCKDNS_TOKEN="${DUCKDNS_TOKEN:-}"
BACKEND_PORT="${BACKEND_PORT:-8081}"
TZ="${TZ:-UTC}"

BASE="/opt/ff-news"
HOST="127.0.0.1"
CACHE_FILE="${CACHE_FILE:-/opt/ff-news/cache/latest.json}"
LOG_DIR="${LOG_DIR:-/opt/ff-news/logs}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

need_cmd() { command -v "$1" >/dev/null 2>&1; }
msg() { echo "== $*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecuta como root (usa: sudo bash)"; exit 1
fi

if [ -z "$DUCKDNS_TOKEN" ]; then
  echo "DUCKDNS_TOKEN vacío."
  read -rsp "Pega tu DUCKDNS_TOKEN: " DUCKDNS_TOKEN; echo
  if [ -z "$DUCKDNS_TOKEN" ]; then echo "Token requerido."; exit 1; fi
fi

msg "Instalando dependencias base"
apt-get update -y
apt-get install -y curl ca-certificates jq nginx certbot rsync

msg "Instalando Node.js LTS + PM2"
if ! need_cmd node; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! need_cmd pm2; then
  npm install -g pm2
fi

msg "Creando usuario y estructura /opt/ff-news"
id -u ffnews >/dev/null 2>&1 || useradd --system --home /opt/ff-news --shell /usr/sbin/nologin ffnews
install -d -m 0755 -o ffnews -g ffnews "$BASE"/{app,ingest,cache,logs,scripts,nginx,snapshots}
install -d -m 0755 -o ffnews -g ffnews "$BASE/.pm2"

msg "Escribiendo .env"
tee "$BASE/.env" >/dev/null <<EOF
DOMAIN=$DOMAIN
LETSENCRYPT_EMAIL=$LETSENCRYPT_EMAIL
DUCKDNS_DOMAIN=$DUCKDNS_DOMAIN
DUCKDNS_TOKEN=$DUCKDNS_TOKEN
BACKEND_PORT=$BACKEND_PORT
CACHE_FILE=$CACHE_FILE
LOG_DIR=$LOG_DIR
TZ=$TZ
EOF
chown ffnews:ffnews "$BASE/.env"
chmod 0640 "$BASE/.env"

msg "Copiando app/ e ingest/ desde el repo"
rsync -a --delete --exclude node_modules/ "$REPO_ROOT/app/" "$BASE/app/"
rsync -a --delete --exclude node_modules/ "$REPO_ROOT/ingest/" "$BASE/ingest/"
chown -R ffnews:ffnews "$BASE/app" "$BASE/ingest"

msg "Instalando dependencias Node (app/ e ingest/)"
runuser -u ffnews -- bash -lc "cd $BASE/app && npm install --omit=dev"
runuser -u ffnews -- bash -lc "cd $BASE/ingest && npm install --omit=dev"

msg "DuckDNS updater + timer"
tee "$BASE/scripts/duckdns-update.sh" >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source /opt/ff-news/.env
resp="$(curl -fsS "https://www.duckdns.org/update?domains=${DUCKDNS_DOMAIN}&token=${DUCKDNS_TOKEN}&ip=")"
ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "$ts duckdns_update=$resp" >> /opt/ff-news/logs/duckdns.log
echo "$resp"
EOF
chown ffnews:ffnews "$BASE/scripts/duckdns-update.sh"
chmod 0755 "$BASE/scripts/duckdns-update.sh"
touch "$BASE/logs/duckdns.log" && chown ffnews:ffnews "$BASE/logs/duckdns.log"

tee /etc/systemd/system/ff-news-duckdns.service >/dev/null <<'EOF'
[Unit]
Description=ff-news DuckDNS update
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
User=ffnews
Group=ffnews
ExecStart=/opt/ff-news/scripts/duckdns-update.sh
EOF

tee /etc/systemd/system/ff-news-duckdns.timer >/dev/null <<'EOF'
[Unit]
Description=Run ff-news DuckDNS update every 5 minutes
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
AccuracySec=30s
Persistent=true
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now ff-news-duckdns.timer
runuser -u ffnews -- bash -lc "/opt/ff-news/scripts/duckdns-update.sh >/dev/null || true"

msg "Preparando Nginx (snippets + rate limit + logging + site http)"
install -d -m 0755 /var/www/letsencrypt
install -d -m 0755 /etc/nginx/snippets

tee /etc/nginx/conf.d/ff-news-rate-limit.conf >/dev/null <<'EOF'
limit_req_zone $binary_remote_addr zone=ffnews_api:10m rate=30r/m;
EOF

tee /etc/nginx/conf.d/ff-news-hardening.conf >/dev/null <<'EOF'
server_tokens off;
EOF

tee /etc/nginx/conf.d/ff-news-logging.conf >/dev/null <<'EOF'
log_format ffnews_api '$remote_addr - $remote_user [$time_local] '
                      '"$request" $status $body_bytes_sent '
                      '"$http_referer" "$http_user_agent" '
                      'rt=$request_time uct=$upstream_connect_time '
                      'uht=$upstream_header_time urt=$upstream_response_time';
map $request_uri $ffnews_is_api {
  default 0;
  ~^/v1/  1;
  ~^/api/ 1;
  =/health 1;
  =/metrics 1;
}
EOF

tee /etc/nginx/snippets/ff-news-headers.conf >/dev/null <<'EOF'
add_header X-Content-Type-Options nosniff always;
add_header X-Frame-Options DENY always;
add_header Referrer-Policy no-referrer always;
EOF

tee /etc/nginx/snippets/ff-news-proxy.conf >/dev/null <<'EOF'
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_http_version 1.1;
proxy_set_header Connection "";
EOF

tee /etc/nginx/sites-available/ff-news.conf >/dev/null <<EOF
server {
  listen 80;
  server_name $DOMAIN;
  location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; default_type "text/plain"; }
  location = /nginx-health { return 200 "ok\n"; add_header Content-Type text/plain; }
  location / { return 200 "ff-news http ready\n"; add_header Content-Type text/plain; }
}
EOF

rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/ff-news.conf /etc/nginx/sites-enabled/ff-news.conf
nginx -t
systemctl reload nginx

msg "Esperando DNS DuckDNS -> IP pública"
PUB_IP="$(curl -fsS https://api.ipify.org)"
OK_DNS=0
for i in $(seq 1 60); do
  DNS_IP="$(getent ahosts "$DOMAIN" | awk 'NR==1{print $1}' || true)"
  if [ "$DNS_IP" = "$PUB_IP" ]; then OK_DNS=1; break; fi
  sleep 5
done
if [ "$OK_DNS" -ne 1 ]; then
  echo "DNS aún no apunta a $PUB_IP. Reintenta en 1-2 min y vuelve a correr install.sh"; exit 1
fi

msg "Certbot (webroot)"
certbot certonly --webroot -w /var/www/letsencrypt -d "$DOMAIN" --email "$LETSENCRYPT_EMAIL" --agree-tos --non-interactive

msg "Nginx final (HTTPS + proxy)"
tee /etc/nginx/sites-available/ff-news.conf >/dev/null <<EOF
server {
  listen 80;
  server_name $DOMAIN;
  location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
  location / { return 301 https://\$host\$request_uri; }
}

server {
  listen 443 ssl http2;
  server_name $DOMAIN;

  ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;

  include /etc/nginx/snippets/ff-news-headers.conf;
  access_log /var/log/nginx/ff-news-api.access.log ffnews_api if=\$ffnews_is_api;

  location = /nginx-health { return 200 "ok\n"; add_header Content-Type text/plain; }

  location = /health {
    limit_req zone=ffnews_api burst=10 nodelay;
    include /etc/nginx/snippets/ff-news-proxy.conf;
    limit_except GET HEAD { deny all; }
    proxy_pass http://$HOST:$BACKEND_PORT/v1/health;
  }

  location = /metrics {
    limit_req zone=ffnews_api burst=10 nodelay;
    include /etc/nginx/snippets/ff-news-proxy.conf;
    limit_except GET HEAD { deny all; }
    proxy_pass http://$HOST:$BACKEND_PORT/metrics;
  }

  location /v1/ {
    limit_req zone=ffnews_api burst=10 nodelay;
    include /etc/nginx/snippets/ff-news-proxy.conf;
    limit_except GET HEAD { deny all; }
    proxy_pass http://$HOST:$BACKEND_PORT;
  }

  location /api/ {
    limit_req zone=ffnews_api burst=10 nodelay;
    include /etc/nginx/snippets/ff-news-proxy.conf;
    limit_except GET HEAD { deny all; }
    proxy_pass http://$HOST:$BACKEND_PORT;
  }

  location / { return 404; }
}
EOF

nginx -t
systemctl reload nginx

msg "PM2 + systemd (ff-news-api)"
tee /etc/systemd/system/pm2-ffnews.service >/dev/null <<'EOF'
[Unit]
Description=PM2 process manager (ffnews)
Documentation=https://pm2.keymetrics.io/
After=network.target
[Service]
Type=simple
User=ffnews
Group=ffnews
WorkingDirectory=/opt/ff-news
Environment=PM2_HOME=/opt/ff-news/.pm2
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Restart=on-failure
ExecStart=/usr/lib/node_modules/pm2/bin/pm2 resurrect --no-daemon
ExecReload=/usr/lib/node_modules/pm2/bin/pm2 reload all
ExecStop=/usr/lib/node_modules/pm2/bin/pm2 kill
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
runuser -u ffnews -- env HOME=/opt/ff-news PM2_HOME=/opt/ff-news/.pm2 pm2 start /opt/ff-news/app/ecosystem.config.cjs
runuser -u ffnews -- env HOME=/opt/ff-news PM2_HOME=/opt/ff-news/.pm2 pm2 save
systemctl enable --now pm2-ffnews

msg "Ingest systemd timer"
tee /etc/systemd/system/ff-news-ingest.service >/dev/null <<'EOF'
[Unit]
Description=ff-news ingest ForexFactory calendar -> JSON cache
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
User=ffnews
Group=ffnews
WorkingDirectory=/opt/ff-news/ingest
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/ff-news/ingest/src/ingest.js
EOF

tee /etc/systemd/system/ff-news-ingest.timer >/dev/null <<'EOF'
[Unit]
Description=Run ff-news ingest every 5 minutes
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
AccuracySec=30s
Persistent=true
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now ff-news-ingest.timer
systemctl start ff-news-ingest.service

msg "Logrotate"
tee /etc/logrotate.d/ff-news >/dev/null <<'EOF'
/opt/ff-news/logs/*.log /opt/ff-news/.pm2/logs/*.log {
  daily
  rotate 14
  missingok
  notifempty
  compress
  delaycompress
  copytruncate
  su ffnews ffnews
  create 0640 ffnews ffnews
}
EOF

msg "Checks"
curl -fsS "https://$DOMAIN/health" | jq .status >/dev/null && echo "OK health"
curl -fsS "https://$DOMAIN/v1/calendar" | jq .meta.count >/dev/null && echo "OK calendar"
curl -fsS "https://$DOMAIN/metrics" | head -n 3 >/dev/null && echo "OK metrics"
echo "Listo: https://$DOMAIN/health  https://$DOMAIN/v1/calendar  https://$DOMAIN/api/news/latest.json  https://$DOMAIN/metrics"
