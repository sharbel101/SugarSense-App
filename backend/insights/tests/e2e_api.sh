#!/usr/bin/env bash
# End-to-end check of GET /insights on the VM against the TEST database (never production). Run by hand:
#   ssh vm 'bash -s' < tests/e2e_api.sh        (needs ~/insights-dev/{be,sugarsense_insights,migrations,venv} and the model container image)
# Steps: apply 0010 to sugarsense_test, run the real engine + real local model for the test user, start the new backend on :3101, compare the HTTP
# response with the stored rows, test limit/empty/expired/unavailable, test an nginx proxy rule on :8191, then clean everything up.
set -uo pipefail
cd ~/insights-dev
set -a; . ~/sugarsense-test-db.env; set +a
PY=~/insights-dev/venv/bin/python
FAIL=0
ok()   { echo "PASS $*"; }
bad()  { echo "FAIL $*"; FAIL=1; }
owner(){ psql "$TEST_DATABASE_MIGRATE_URL" -At -q "$@"; }

cleanup() {
  [ -n "${NGX_PID:-}" ] && kill "$NGX_PID" 2>/dev/null
  pkill -f "nginx: master process nginx -c /tmp/ngx-insights" 2>/dev/null
  [ -n "${BE_PID:-}" ] && kill "$BE_PID" 2>/dev/null
  owner -c "DROP TABLE IF EXISTS insights, insight_runs" >/dev/null 2>&1
  docker stop insights-bench >/dev/null 2>&1; docker rm insights-bench >/dev/null 2>&1
  echo "cleanup: insight tables left in sugarsense_test=$(owner -c "select count(*) from information_schema.tables where table_name like 'insight%'") model container left=$(docker ps -a --format '{{.Names}}' | grep -c insights-bench)"
}
trap cleanup EXIT

UID_=$(owner -c "SELECT user_id::text FROM glucose_readings GROUP BY user_id ORDER BY count(*) DESC LIMIT 1")
NEWEST=$(owner -c "SELECT to_char(max(measured_at) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS+00:00') FROM glucose_readings WHERE user_id='$UID_'")
owner -v ON_ERROR_STOP=1 -1 -f migrations/0010_insights.sql >/dev/null && ok "migration 0010 applied to the TEST database" || { bad "migration"; exit 1; }

echo "== start the model (4 CPUs, localhost only) and run the real engine for the test user"
docker run -d --name insights-bench --cpus 4 --memory 8g -p 127.0.0.1:8181:8080 -v /home/ubuntu/models:/models:ro ghcr.io/ggml-org/llama.cpp:server -m /models/Qwen3.5-4B-Q4_K_M.gguf -c 8192 -t 4 --parallel 1 --host 0.0.0.0 --port 8080 --jinja --chat-template-kwargs '{"enable_thinking":false}' >/dev/null
for i in $(seq 1 40); do [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8181/health)" = 200 ] && break; sleep 2; done
for k in morning evening; do
  DATABASE_URL="$TEST_DATABASE_URL" INSIGHTS_LOCK=/tmp/insights-e2e.lock PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. $PY -m sugarsense_insights run $k --user "$UID_" --now "$NEWEST" 2>&1 | tail -1 | $PY -c "import sys,json; d=json.loads(sys.stdin.read()); print('engine',d['run_key'],'state',d['state'],'insights',d['insights'],d['categories'],'llm_calls',d['llm_calls'],'fallbacks',d['fallbacks'],'latency',d['llm_latency_s'])"
done
docker stop insights-bench >/dev/null 2>&1; docker rm insights-bench >/dev/null 2>&1
# the engine ran with a historical clock (the test data is old), so give the stored rows a live expiry for the API check
owner -c "UPDATE insights SET expires_at = now() + interval '1 day'" >/dev/null
STORED=$(owner -c "SELECT count(*) FROM insights WHERE status='active'")
[ "$STORED" -gt 0 ] && ok "engine stored $STORED active insights" || { bad "no insights stored"; exit 1; }

echo "== start the new backend on :3101 (test database, primary user pinned)"
cd ~/insights-dev/be
PORT=3101 DATABASE_URL="$TEST_DATABASE_URL" PRIMARY_USER_ID="$UID_" CORS_ORIGINS=http://localhost nohup node dist/main.js > ../be.log 2>&1 &
BE_PID=$!
for i in $(seq 1 30); do [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:3101/health)" = 200 ] && break; sleep 1; done
cd ~/insights-dev
curl -s -m 10 -D hdr.txt http://127.0.0.1:3101/insights -o api.json
grep -qi '^cache-control: no-store' hdr.txt && ok "Cache-Control: no-store" || bad "no-store header missing"
head -1 hdr.txt | grep -q " 200" && ok "HTTP 200" || bad "status: $(head -1 hdr.txt)"

owner -c "SELECT json_agg(t) FROM (SELECT insight_id::text AS id, category, priority::float AS priority, content FROM insights WHERE user_id='$UID_' AND status='active' AND expires_at > now() ORDER BY priority DESC, created_at DESC LIMIT 5) t" > stored.json
$PY - <<'PY'
import json
api = json.load(open("api.json")); st = json.load(open("stored.json"))
fails = 0
def chk(name, cond, extra=""):
    global fails
    print(("PASS " if cond else "FAIL ") + name + (("  " + extra) if extra else "")); fails += (not cond)
chk("status ok", api.get("status") == "ok", str(api.get("status")))
chk("same number of insights as stored", api["count"] == len(st) == len(api["insights"]), f"api={api['count']} stored={len(st)}")
chk("same ids in the same (priority) order", [i["id"] for i in api["insights"]] == [s["id"] for s in st])
chk("same categories in order", [i["category"] for i in api["insights"]] == [s["category"] for s in st], str([i["category"] for i in api["insights"]]))
chk("factsText equals stored facts_text for every insight", all(i["factsText"] == s["content"]["facts_text"] for i, s in zip(api["insights"], st)))
chk("explanation equals stored (or null)", all(i["explanation"] == (s["content"].get("explanation") or None) for i, s in zip(api["insights"], st)))
chk("headline equals stored", all(i["headline"] == s["content"]["headline"] for i, s in zip(api["insights"], st)))
chk("no citation tags in reader text", all("[E" not in (i["explanation"] or "") for i in api["insights"]))
chk("every insight has facts text, limitations list, validation, window and priority", all(i["factsText"] and isinstance(i["limitations"], list) and i["validation"] in ("valid", "fallback", "not_applicable") and i["observationStart"] and i["priority"] >= 0 for i in api["insights"]))
chk("notice present and says not medical advice", "not medical advice" in api["notice"])
chk("evidence facts exposed", all(isinstance(i["evidence"]["facts"], list) for i in api["insights"]))
chk("no internal fields leak (user_id, sql, dsn)", not any(k in json.dumps(api).lower() for k in ("user_id", "select ", "postgres://")))
print("sample:", json.dumps({k: api["insights"][0][k] for k in ("category", "headline", "validation", "priority")}), "|", api["insights"][0]["factsText"][0][:110])
raise SystemExit(1 if fails else 0)
PY
[ $? -eq 0 ] || FAIL=1

echo "== limit / empty / expired"
curl -s -m 10 "http://127.0.0.1:3101/insights?limit=1" | $PY -c "import sys,json; d=json.load(sys.stdin); print('PASS limit=1 returns 1' if d['count']==1 else 'FAIL limit=1 '+str(d['count']))"
for bad in 0 11 abc; do c=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:3101/insights?limit=$bad"); [[ "$c" = 400 || "$c" = 422 ]] && ok "limit=$bad rejected ($c)" || bad "limit=$bad -> $c"; done
TOP=$(owner -c "SELECT insight_id::text FROM insights WHERE status='active' ORDER BY priority DESC, created_at DESC LIMIT 1")
owner -c "UPDATE insights SET expires_at = now() - interval '1 minute' WHERE insight_id = '$TOP'" >/dev/null
curl -s -m 10 "http://127.0.0.1:3101/insights?limit=10" | TOP="$TOP" STORED="$STORED" $PY -c "import sys,json,os; d=json.load(sys.stdin); ids=[i['id'] for i in d['insights']]; print('PASS the expired insight is not returned ('+str(d['count'])+' of '+os.environ['STORED']+' stored)') if os.environ['TOP'] not in ids and d['count']==int(os.environ['STORED'])-1 else print('FAIL expired insight still returned', d['count'])"
owner -c "UPDATE insights SET status='superseded'" >/dev/null
curl -s -m 10 http://127.0.0.1:3101/insights | $PY -c "import sys,json; d=json.load(sys.stdin); print('PASS none active -> status', d['status'], d.get('reason')) if d['status']=='empty' and d['reason']=='none_active' else print('FAIL', d)"
owner -c "UPDATE insights SET status='active', expires_at = now() + interval '1 day'" >/dev/null

echo "== nginx: the proxy rule that will go into the sugarsense-web site, tested in a throwaway instance on :8191"
mkdir -p /tmp/ngx-insights/logs
cat > /tmp/ngx-insights.conf <<'NGX'
pid /tmp/ngx-insights/nginx.pid;
error_log /tmp/ngx-insights/error.log;
events {}
http {
  access_log off;
  client_body_temp_path /tmp/ngx-insights/body; proxy_temp_path /tmp/ngx-insights/proxy; fastcgi_temp_path /tmp/ngx-insights/fc; uwsgi_temp_path /tmp/ngx-insights/uw; scgi_temp_path /tmp/ngx-insights/sc;
  server {
    listen 127.0.0.1:8191;
    location ~ ^/(health|meals|glucose|forecast|events|therapy|insights)(/|$) { proxy_pass http://127.0.0.1:3101; proxy_set_header Host $host; proxy_read_timeout 120s; }
    location / { return 200 'spa-fallback'; }
  }
}
NGX
nginx -t -c /tmp/ngx-insights.conf 2>&1 | tail -1
nginx -c /tmp/ngx-insights.conf && sleep 1
[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8191/insights)" = 200 ] && ok "/insights proxied through nginx" || bad "nginx proxy"
curl -s -m 5 -D - -o /dev/null http://127.0.0.1:8191/insights | grep -qi 'cache-control: no-store' && ok "no-store survives the proxy" || bad "no-store lost in proxy"
[ "$(curl -s -m 5 http://127.0.0.1:8191/Insights)" = "spa-fallback" ] && ok "capitalised /Insights (a client-side route) still falls through to the app" || bad "capitalised path"
nginx -c /tmp/ngx-insights.conf -s stop 2>/dev/null; sleep 1

echo "== unavailable when the table is missing (as before the migration is applied)"
owner -c "DROP TABLE insights, insight_runs" >/dev/null
r=$(curl -s -m 10 -w ' HTTP%{http_code}' http://127.0.0.1:3101/insights)
echo "$r" | grep -q '"status":"unavailable"' && echo "$r" | grep -q 'HTTP503' && ok "503 unavailable with a fixed body: $r" || bad "unavailable: $r"
echo "$r" | grep -qiE 'relation|42P01|does not exist' && bad "driver text leaked" || ok "no driver text in the error"
echo; [ $FAIL -eq 0 ] && echo "E2E RESULT: ALL PASSED" || echo "E2E RESULT: FAILURES"
