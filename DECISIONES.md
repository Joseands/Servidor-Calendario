# Decisiones del proyecto (Etapa 0)

## Objetivo
Ingerir el calendario de ForexFactory cada 5 minutos y exponerlo por API JSON HTTPS para consumo desde un EA de MT4.

## Stack (fijo)
- Nginx + Let's Encrypt (Certbot)
- Node.js LTS + PM2
- Ingesta cada 5 minutos con systemd timer
- Cache JSON obligatoria (SQLite opcional más adelante)

## Dominio y red
- Dominio público: servcalendario.duckdns.org
- Backend interno: 127.0.0.1:8081
- Nginx será reverse proxy en 80/443

## Contrato de API
- Endpoint principal: GET /v1/calendar (retorna cache JSON)
- Endpoint estado: GET /v1/status
- Formato de fechas: datetime_utc ISO 8601 en UTC (YYYY-MM-DDTHH:mm:ssZ)

## Ingesta y cache
- systemd timer cada 300s (5 min)
- El proceso de ingesta actualiza /opt/ff-news/cache/latest.json de forma atómica (escritura a tmp + mv)
- El API solo sirve el cache (sin scrapear en tiempo real)

## Logs
- app: /opt/ff-news/logs/app.log
- ingesta: /opt/ff-news/logs/ingest.log
