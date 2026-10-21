#!/usr/bin/env bash
# Adds /insights to the API paths the web site (:8090) proxies to the NestJS backend. Idempotent; backs the file up; runs nginx -t; restores on failure.
# The gateway on :80 (ngrok / Expo Go) already forwards everything except /bg and /agent/ to the backend, so it needs no change.
# NOT APPLIED by the change that added GET /insights. Run on the VM when the backend with the route is deployed:  bash add-insights-route.sh
set -euo pipefail
SITE=/etc/nginx/sites-available/sugarsense-web
TS="$(date -u +%Y%m%d-%H%M%S)"
if grep -qE 'location ~ \^/\([^)]*\binsights\b' "$SITE"; then echo "already routed"; sudo nginx -t; exit 0; fi
sudo cp -a "$SITE" "$SITE.bak-$TS"
sudo python3 - "$SITE" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
new, n = re.subn(r"(location ~ \^/\([a-z|]+?)(\)\(/\|\$\) \{)", r"\1|insights\2", s, count=1)
assert n == 1, "could not find the API location block - refusing to edit"
open(p, "w").write(new)
PY
if sudo nginx -t; then sudo systemctl reload nginx && echo "nginx reloaded; /insights is now proxied on :8090"
else echo "nginx -t FAILED: restoring backup"; sudo cp -a "$SITE.bak-$TS" "$SITE"; sudo nginx -t; exit 1; fi
grep -n "location ~" "$SITE"
echo "rollback: sudo cp -a $SITE.bak-$TS $SITE && sudo nginx -t && sudo systemctl reload nginx"
