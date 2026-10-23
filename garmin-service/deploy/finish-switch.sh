#!/usr/bin/env bash
# One-off, run ON THE VM as ubuntu after the new garmin-service code has been copied to ~/garmin-mcp (README, "Switching an existing VM install").
# Does: asks for the Garmin Personal API key (hidden, never echoed or logged), patches the two nginx Garmin blocks to allow POST /refresh
# (backs both files up first, `nginx -t` before reload), restarts the API and the poller, runs one fetch and prints the result.
set -euo pipefail
cd /home/ubuntu/garmin-mcp

read -r -s -p "Garmin Personal API key (input hidden; leave empty to keep the current one): " KEY; echo
if [ -n "$KEY" ]; then
  KEY="$KEY" python3 - <<'PY'
import os, re
p = "service.env"
s = open(p).read()
line = "GARMIN_PERSONAL_API_KEY=" + os.environ["KEY"]
s = re.sub(r"(?m)^GARMIN_PERSONAL_API_KEY=.*$", lambda _: line, s) if re.search(r"(?m)^GARMIN_PERSONAL_API_KEY=", s) else s.rstrip("\n") + "\n" + line + "\n"
open(p, "w").write(s)
PY
  chmod 600 service.env
fi
unset KEY
grep -q '^GARMIN_PERSONAL_API_KEY=.\+' service.env || { echo "No key in service.env yet; run again with the key."; exit 1; }
sed -i 's/^GARMIN_POLLING_ENABLED=.*/GARMIN_POLLING_ENABLED=true/' service.env

stamp=$(date +%Y%m%d%H%M)
for f in sugarsense-gateway sugarsense-web; do
  sudo cp "/etc/nginx/sites-available/$f" "/etc/nginx/sites-available/$f.bak-$stamp"
  sudo python3 - "/etc/nginx/sites-available/$f" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
m = re.search(r"location /api/garmin/ \{.*?\n    \}", s, re.S)
assert m, "garmin location block not found in " + p
b = m.group(0)
b = b.replace("proxy_read_timeout 15s;", "proxy_read_timeout 40s;").replace("proxy_send_timeout 15s;", "proxy_send_timeout 40s;")
b = b.replace("limit_except GET { deny all; }", "limit_except GET POST { deny all; }")
open(p, "w").write(s[:m.start()] + b + s[m.end():])
PY
done
sudo nginx -t
sudo systemctl reload nginx

sudo systemctl daemon-reload
sudo systemctl restart sugarsense-garmin-api sugarsense-garmin-worker
sleep 3
systemctl is-active sugarsense-garmin-api sugarsense-garmin-worker
echo "--- one fetch right now ---"
venv/bin/python -m gsvc.cli once
TOKEN=$(grep '^GARMIN_API_TOKEN=' service.env | cut -d= -f2-)
echo "--- POST /refresh (what the app's refresh button sends) ---"
curl -s -m 40 -X POST -H "x-app-token: $TOKEN" http://127.0.0.1:8310/api/garmin/v1/refresh; echo
echo "--- latest heart rate ---"
curl -s -H "x-app-token: $TOKEN" "http://127.0.0.1:8310/api/garmin/v1/metrics/latest?metrics=heart_rate" | head -c 400; echo
