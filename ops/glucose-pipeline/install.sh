#!/usr/bin/env bash
# Installs the glucose-pipeline hardening on the Oracle VM. Idempotent; safe to re-run.
#
#   tar czf - -C ops glucose-pipeline | \
#     ssh -i ~/.ssh/oracle_sep5.key ubuntu@139.185.53.135 \
#     'rm -rf /tmp/gp && mkdir /tmp/gp && tar xzf - -C /tmp/gp && bash /tmp/gp/glucose-pipeline/install.sh'
#
# What it does (nothing else is touched; bg.service, forecast, models, bg.db, bg_service.py are NOT modified):
#   1. copies bg-guardian to /home/ubuntu/bg/guardian (keeps a timestamped backup of any previous copy)
#   2. installs two systemd units: bg-cloudflared (supervised 2nd quick tunnel) and bg-guardian
#   3. adds ONE nginx location (= /agent/endpoints -> 127.0.0.1:8002) to the sugarsense-gateway site,
#      backs the site file up first, runs nginx -t, and restores the backup on any failure
#   4. disables sugarsense-ngrok (enabled-but-inactive; at boot it would fight bg-ngrok-tunnel over the
#      single free ngrok domain and take the watch API down)
#   5. starts the units and prints a verification report
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TS="$(date -u +%Y%m%d-%H%M%S)"
G=/home/ubuntu/bg/guardian
GATEWAY=/etc/nginx/sites-available/sugarsense-gateway
SNIPPET=/etc/nginx/snippets/bg-guardian.conf

say() { printf '\n== %s\n' "$*"; }

say "1/5 guardian files"
install -d -m 755 "$G" "$G/incidents"
if [ -f "$G/bg-guardian.mjs" ] && ! cmp -s "$G/bg-guardian.mjs" "$HERE/guardian/bg-guardian.mjs"; then
  cp -a "$G/bg-guardian.mjs" "$G/bg-guardian.mjs.bak-$TS"; echo "previous copy backed up"
fi
install -m 644 "$HERE/guardian/bg-guardian.mjs" "$G/bg-guardian.mjs"
install -m 644 "$HERE/guardian/guardian.test.mjs" "$G/guardian.test.mjs"
echo "running the guardian's own tests on the VM's Node:"
( cd "$G" && /usr/bin/node --test guardian.test.mjs 2>&1 | grep -E "^# (tests|pass|fail)" )
( cd "$G" && /usr/bin/node --test guardian.test.mjs >/dev/null 2>&1 ) || { echo "TESTS FAILED - aborting before touching services"; exit 1; }

say "2/5 systemd units"
sudo install -m 644 "$HERE/systemd/bg-cloudflared.service" /etc/systemd/system/bg-cloudflared.service
sudo install -m 644 "$HERE/systemd/bg-guardian.service" /etc/systemd/system/bg-guardian.service
sudo systemctl daemon-reload

say "3/5 nginx: expose /agent/endpoints"
sudo install -d /etc/nginx/snippets
sudo tee "$SNIPPET" >/dev/null <<'EOF'
# bg-guardian: tunnel discovery for the phone collector (token-authenticated by the guardian itself)
location = /agent/endpoints {
    proxy_pass http://127.0.0.1:8002;
    proxy_set_header Host $host;
}
EOF
if ! grep -q 'snippets/bg-guardian.conf' "$GATEWAY"; then
  sudo cp -a "$GATEWAY" "$GATEWAY.bak-$TS"
  sudo python3 - "$GATEWAY" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
marker = "    location /bg {"
assert marker in s, "marker location /bg not found - refusing to edit"
s = s.replace(marker, "    include /etc/nginx/snippets/bg-guardian.conf;\n\n" + marker, 1)
open(p, "w").write(s)
PY
  if sudo nginx -t; then sudo systemctl reload nginx; echo "nginx reloaded"
  else echo "nginx -t FAILED - restoring backup"; sudo cp -a "$GATEWAY.bak-$TS" "$GATEWAY"; sudo nginx -t; exit 1; fi
else
  echo "already included"; sudo nginx -t
fi

say "4/5 ngrok unit conflict"
if systemctl is-enabled --quiet sugarsense-ngrok 2>/dev/null; then sudo systemctl disable sugarsense-ngrok; fi
echo "bg-ngrok-tunnel: enabled=$(systemctl is-enabled bg-ngrok-tunnel) active=$(systemctl is-active bg-ngrok-tunnel)"
echo "sugarsense-ngrok: enabled=$(systemctl is-enabled sugarsense-ngrok 2>/dev/null || true)"

say "5/5 start + verify"
sudo systemctl enable --now bg-cloudflared
sleep 12
sudo systemctl enable --now bg-guardian
sleep 40
set +e
TOKEN="$(grep '^API_AUTH_TOKEN=' /home/ubuntu/API/.env | cut -d= -f2-)"
echo "bg-cloudflared: $(systemctl is-active bg-cloudflared)   bg-guardian: $(systemctl is-active bg-guardian)"
URL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /home/ubuntu/bg-cloudflared.log | tail -1)"
echo "new supervised tunnel: ${URL:-<not up yet>}"
[ -n "${URL:-}" ] && curl -s -m 15 -o /dev/null -w "  via new tunnel /agent/status -> HTTP %{http_code}\n" -H "Authorization: $TOKEN" "$URL/agent/status"
curl -s -m 8 -o /dev/null -w "  guardian endpoint, no token  -> HTTP %{http_code} (want 401)\n" http://127.0.0.1:8002/agent/endpoints
echo "  guardian endpoint, with token -> $(curl -s -m 8 -H "Authorization: $TOKEN" http://127.0.0.1:8002/agent/endpoints)"
curl -s -m 8 -o /dev/null -w "  via nginx :80, no token      -> HTTP %{http_code} (want 401)\n" http://127.0.0.1/agent/endpoints
curl -s -m 8 -o /dev/null -w "  via nginx :80, with token    -> HTTP %{http_code} (want 200)\n" -H "Authorization: $TOKEN" http://127.0.0.1/agent/endpoints
echo "  bg_service still fine         -> $(curl -s -m 8 -H "Authorization: $TOKEN" http://127.0.0.1:8000/bg | head -c 120)"
echo "--- guardian status.json (findings)"
python3 - <<'PY'
import json
try:
    s = json.load(open('/home/ubuntu/bg/guardian/status.json'))
    print(" units:", s['units']); print(" tunnels:", s['tunnels']); print(" findings:", [(f['code'], f['severity']) for f in s['findings']]); print(" incident:", s['incident'] and s['incident']['codes'])
except Exception as e:
    print(" status.json not written yet:", e)
PY
echo
echo "Done. Roll back with:  sudo systemctl disable --now bg-guardian bg-cloudflared"
echo "  and restore nginx:   sudo cp -a $GATEWAY.bak-$TS $GATEWAY && sudo nginx -t && sudo systemctl reload nginx"
