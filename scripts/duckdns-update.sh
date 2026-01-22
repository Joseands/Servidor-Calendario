#!/usr/bin/env bash
set -euo pipefail
source /opt/ff-news/.env
resp="$(curl -fsS "https://www.duckdns.org/update?domains=${DUCKDNS_DOMAIN}&token=${DUCKDNS_TOKEN}&ip=")"
ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "$ts duckdns_update=$resp" >> /opt/ff-news/logs/duckdns.log
echo "$resp"
