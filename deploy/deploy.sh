#!/usr/bin/env bash
# SugarSense push-to-deploy. Polls GitHub, builds the web app and/or backend, and swaps them in only
# if every guard passes. Fails closed: a broken build never replaces a working one.
# Run by sugarsense-deploy.service (systemd timer). Reads config from $DEPLOY_CONFIG
# (default /etc/sugarsense-deploy.env). No secrets are read, written or logged here.
#
# NOTE on errexit: functions below are called as `fn || ...`, which disables `set -e` inside them.
# Every step therefore ends with an explicit `|| return 1`.
# Long-lived children (npm, node, the restart command) run with fd 9 closed (`9>&-`) so a stray
# process can never inherit and hold the flock after this script exits.
set -Euo pipefail

CONFIG_FILE="${DEPLOY_CONFIG:-/etc/sugarsense-deploy.env}"
if [ -r "$CONFIG_FILE" ]; then set -a; . "$CONFIG_FILE"; set +a; fi

: "${DEPLOY_BRANCH:=main}"
: "${REPO_URL:=https://github.com/sharbel101/SugarSense-App.git}"
: "${BUILD_DIR:=$HOME/sugarsense-deploy/src}"
: "${STATE_DIR:=/var/lib/sugarsense-deploy}"
: "${RELEASES_DIR:=/var/www/releases}"
: "${WEB_LINK:=/var/www/sugarsense-web}"      # nginx root; a symlink to $RELEASES_DIR/current
: "${WEB_CHECK_URL:=http://127.0.0.1:8090}"
: "${BACKEND_DIR:=$HOME/sugarsense-app}"
: "${BACKEND_RESTART_CMD:=sudo systemctl restart sugarsense-backend}"
: "${GARMIN_WEB_ENV_FILE:=/etc/sugarsense-garmin.env}"   # root-only file with EXPO_PUBLIC_GARMIN_API_TOKEN=... (never in git)
: "${BACKEND_HEALTH_URL:=http://127.0.0.1:3000/health}"
: "${KEEP_RELEASES:=5}"
: "${RETRY_AFTER_SEC:=1800}"
: "${MIN_BUNDLE_BYTES:=512000}"
# Test hook only (acceptance test 4): pretend the post-switch web check failed.
: "${DEPLOY_TEST_FAIL_POST_SWITCH:=0}"

STATE_FILE="$STATE_DIR/state.json"
LOCK_FILE="$STATE_DIR/deploy.lock"
WORK_DIR="$(dirname "$BUILD_DIR")/work"
LOCK_STAMP="$(dirname "$BUILD_DIR")/mobile-lock.sha"
START_TS=$(date +%s)

log() { echo "deploy: $*"; }

state_get() { [ -f "$STATE_FILE" ] && jq -r --arg k "$1" '.[$k] // empty' "$STATE_FILE" 2>/dev/null; return 0; }
state_put() {
  local cur='{}'
  [ -f "$STATE_FILE" ] && cur=$(cat "$STATE_FILE")
  jq --arg k "$1" --arg v "$2" '.[$k]=$v' <<<"$cur" >"$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
}

mkdir -p "$STATE_DIR" "$(dirname "$BUILD_DIR")" || { log "cannot create state/build dirs"; exit 1; }
exec 9>"$LOCK_FILE"
flock -n 9 || { log "another deploy is running; exiting"; exit 0; }

# ---------------------------------------------------------------- decide whether to run
remote_sha=$(git ls-remote "$REPO_URL" "refs/heads/$DEPLOY_BRANCH" 2>/dev/null | awk '{print $1}')
if [ -z "$remote_sha" ]; then
  log "WARN cannot resolve $DEPLOY_BRANCH at remote (network or branch missing); nothing done"
  exit 0
fi

last_deployed=$(state_get lastDeployedSha)
last_attempt=$(state_get lastAttemptSha)
last_result=$(state_get lastResult)
last_time=$(state_get lastAttemptEpoch)

if [ "$remote_sha" = "$last_deployed" ]; then
  log "no change sha=${remote_sha:0:9}"
  exit 0
fi
if [ "$remote_sha" = "$last_attempt" ] && [ "$last_result" = "failed" ] \
   && [ $(( $(date +%s) - ${last_time:-0} )) -lt "$RETRY_AFTER_SEC" ]; then
  log "skip: ${remote_sha:0:9} failed recently; retry after ${RETRY_AFTER_SEC}s or when origin moves"
  exit 0
fi

state_put lastAttemptSha "$remote_sha"
state_put lastAttemptEpoch "$(date +%s)"
state_put lastResult running

# ---------------------------------------------------------------- source checkout
if [ ! -d "$BUILD_DIR/.git" ]; then
  git clone -q --branch "$DEPLOY_BRANCH" --single-branch "$REPO_URL" "$BUILD_DIR" || { log "FAILED clone"; state_put lastResult failed; exit 1; }
fi
git -C "$BUILD_DIR" remote set-url origin "$REPO_URL"
if ! git -C "$BUILD_DIR" fetch -q origin "$DEPLOY_BRANCH"; then
  log "FAILED fetch"; state_put lastResult failed; state_put time "$(date -u +%FT%TZ)"; exit 1
fi
new_sha=$(git -C "$BUILD_DIR" rev-parse FETCH_HEAD)
subject=$(git -C "$BUILD_DIR" log -1 --format=%s "$new_sha")
state_put lastAttemptSha "$new_sha"

web_sha=$(state_get webSha)
backend_sha=$(state_get backendSha)

# changed_since BASE PATH: true when PATH changed between BASE and new_sha, or BASE is unknown.
changed_since() {
  local base="$1" path="$2"
  [ -z "$base" ] && return 0
  git -C "$BUILD_DIR" cat-file -e "${base}^{commit}" 2>/dev/null || return 0
  [ -n "$(git -C "$BUILD_DIR" diff --name-only "$base" "$new_sha" -- "$path")" ]
}

need_web=0;     changed_since "$web_sha" mobile/ && need_web=1
need_backend=0; changed_since "$backend_sha" backend/ && need_backend=1

# ---------------------------------------------------------------- BACKEND
deploy_backend() {
  local sha="$1" b="$BACKEND_DIR/backend" prev_head
  [ -d "$BACKEND_DIR/.git" ] || { log "backend: $BACKEND_DIR is not a git checkout"; return 1; }
  if [ -n "$(git -C "$BACKEND_DIR" status --porcelain --untracked-files=no)" ]; then
    log "backend: working tree is dirty; aborting, nothing changed"; return 1
  fi
  prev_head=$(git -C "$BACKEND_DIR" rev-parse HEAD) || return 1
  # Keep the rollback copies out of `git status` without touching the repo's .gitignore.
  grep -qxF 'backend/dist.prev/' "$BACKEND_DIR/.git/info/exclude" 2>/dev/null     || printf 'backend/dist.prev/
backend/dist.failed/
' >>"$BACKEND_DIR/.git/info/exclude"

  # Take the commit from the build checkout (same objects, no second network fetch).
  git -C "$BUILD_DIR" update-ref refs/heads/deploy-head "$sha" || return 1
  git -C "$BACKEND_DIR" fetch -q "$BUILD_DIR" refs/heads/deploy-head || return 1
  if git -C "$BACKEND_DIR" merge-base --is-ancestor HEAD "$sha" 2>/dev/null; then
    git -C "$BACKEND_DIR" merge -q --ff-only "$sha" || return 1
  else
    log "backend: $sha is not a descendant of HEAD; checking it out detached"
    git -C "$BACKEND_DIR" checkout -q --detach "$sha" || return 1
  fi

  backend_revert() { git -C "$BACKEND_DIR" reset -q --hard "$prev_head" 2>/dev/null; }

  (cd "$b" && npm install --no-audit --no-fund >/dev/null) 9>&- || { log "backend: npm install failed"; backend_revert; return 1; }
  git -C "$BACKEND_DIR" checkout -q -- backend/package-lock.json 2>/dev/null
  mkdir -p "$WORK_DIR"
  (cd "$b" && npm run typecheck && npm test) >"$WORK_DIR/backend-check.log" 2>&1 9>&-     || { log "backend: typecheck/test failed; not restarting (tail follows)"; tail -n 25 "$WORK_DIR/backend-check.log"; backend_revert; return 1; }
  log "backend: typecheck + tests passed"

  rm -rf "$b/dist.prev"
  [ -d "$b/dist" ] && cp -a "$b/dist" "$b/dist.prev"
  rm -f "$b/tsconfig.build.tsbuildinfo"
  if ! (cd "$b" && npm run build >/dev/null) 9>&-; then
    log "backend: build failed; restoring previous dist"
    rm -rf "$b/dist"; [ -d "$b/dist.prev" ] && mv "$b/dist.prev" "$b/dist"
    backend_revert; return 1
  fi

  backend_health() {
    local i
    for i in $(seq 1 30); do
      curl -fsS -m 3 -o /dev/null "$BACKEND_HEALTH_URL" 2>/dev/null && return 0
      sleep 1
    done
    return 1
  }
  $BACKEND_RESTART_CMD 9>&- || log "backend: restart command returned non-zero"
  if backend_health; then
    log "backend: healthy at ${sha:0:9}"
    return 0
  fi
  log "backend: unhealthy within 30s; restoring previous dist"
  rm -rf "$b/dist.failed"; mv "$b/dist" "$b/dist.failed"
  [ -d "$b/dist.prev" ] && cp -a "$b/dist.prev" "$b/dist"
  backend_revert
  $BACKEND_RESTART_CMD 9>&- || true
  backend_health && log "backend: previous build restored and healthy" || log "backend: ERROR previous build also unhealthy"
  return 1
}

# ---------------------------------------------------------------- WEB
check_bundle() {
  # Expo may emit several index-*.js chunks; forbidden strings must be absent from ALL of them,
  # /meals/analyze must be present in at least one, and the largest must exceed MIN_BUNDLE_BYTES.
  local out="$1" f n js any=0 biggest=0 sz
  local jsfiles=("$out"/_expo/static/js/web/index-*.js)
  [ -f "${jsfiles[0]}" ] || { log "guard: no index-*.js bundle"; return 1; }
  for js in "${jsfiles[@]}"; do
    for f in __SAME_ORIGIN__ "localhost:3000" "ngrok-free.dev"; do
      n=$(grep -c -F -- "$f" "$js"); n=${n:-0}
      [ "$n" -eq 0 ] || { log "guard: $(basename "$js") contains forbidden string '$f'"; return 1; }
    done
    grep -q -F -- "/meals/analyze" "$js" && any=1
    sz=$(stat -c %s "$js"); [ "$sz" -gt "$biggest" ] && biggest=$sz
  done
  [ "$any" = 1 ] || { log "guard: no bundle contains /meals/analyze"; return 1; }
  [ "$biggest" -gt "$MIN_BUNDLE_BYTES" ] || { log "guard: largest bundle is $biggest bytes (< $MIN_BUNDLE_BYTES)"; return 1; }
  [ -f "$out/index.html" ] || { log "guard: no index.html"; return 1; }
  local ref
  ref=$(grep -o 'src="[^"]*\.js"' "$out/index.html" | head -1 | sed -E 's/^src="//; s/"$//')
  [ -n "$ref" ] && [ -f "$out/${ref#/}" ] || { log "guard: index.html script reference missing"; return 1; }
  return 0
}

web_check() {  # $1 expected sha
  local i
  [ "$DEPLOY_TEST_FAIL_POST_SWITCH" = "1" ] && { log "web: TEST HOOK forcing post-switch failure"; return 1; }
  for i in 1 2 3 4 5; do
    if curl -fsS -m 5 -o /dev/null "$WEB_CHECK_URL/" 2>/dev/null \
       && [ "$(curl -fsS -m 5 "$WEB_CHECK_URL/version.json" 2>/dev/null | jq -r .sha 2>/dev/null)" = "$1" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

point_current_at() {  # atomic: $1 = release dir
  ln -sfn "$1" "$RELEASES_DIR/current.new" && mv -T "$RELEASES_DIR/current.new" "$RELEASES_DIR/current"
}

deploy_web() {
  local sha="$1" out="$WORK_DIR/out" mobile="$BUILD_DIR/mobile" lockhash prev rel
  git -C "$BUILD_DIR" reset -q --hard "$sha" || return 1
  git -C "$BUILD_DIR" clean -qfd || return 1

  lockhash=$(cat "$mobile/package-lock.json" "$mobile/package.json" | sha256sum | cut -d' ' -f1)
  if [ ! -d "$mobile/node_modules" ] || [ "$(cat "$LOCK_STAMP" 2>/dev/null)" != "$lockhash" ]; then
    log "web: installing dependencies (lockfile changed)"
    (cd "$mobile" && { npm ci --no-audit --no-fund >/dev/null || npm install --no-audit --no-fund >/dev/null; }) 9>&- \
      || { log "web: dependency install failed"; return 1; }
    echo "$lockhash" >"$LOCK_STAMP"
  fi

  rm -rf "$out"; mkdir -p "$WORK_DIR"
  # --clear is mandatory: Metro's cache otherwise reuses a previously baked API URL.
  # Garmin: the web build gets the API token from a root-only file (read with sudo, never from git, never logged) and NO Garmin URL, so the app uses the
  # same-origin path /api/garmin/v1, which nginx proxies to the Garmin service. Without the file the Wearable screen simply stays on its demo data.
  local garmin_token="" genv=()
  garmin_token=$(sudo -n cat "$GARMIN_WEB_ENV_FILE" 2>/dev/null | sed -n 's/^EXPO_PUBLIC_GARMIN_API_TOKEN=//p' | head -n 1)
  if [ -n "$garmin_token" ]; then genv=("EXPO_PUBLIC_GARMIN_API_TOKEN=$garmin_token"); else log "web: no Garmin token file ($GARMIN_WEB_ENV_FILE); Wearable stays on demo data"; fi
  (cd "$mobile" && env -u EXPO_PUBLIC_GARMIN_API_URL ${genv[@]+"${genv[@]}"} EXPO_PUBLIC_API_URL=__SAME_ORIGIN__ EXPO_PUBLIC_WEB_SAME_ORIGIN=1 CI=1 \
      timeout 1200 npx expo export --platform web --clear --output-dir "$out" >"$WORK_DIR/export.log" 2>&1) 9>&- \
    || { log "web: expo export failed (tail of $WORK_DIR/export.log follows)"; tail -n 15 "$WORK_DIR/export.log"; return 1; }

  # Same-origin API: API_URL becomes "" so fetch("/meals/analyze") stays on the page's own origin.
  find "$out/_expo/static/js/web" -name 'index-*.js' -exec sed -i 's/__SAME_ORIGIN__//g' {} + || return 1
  check_bundle "$out" || return 1

  jq -n --arg sha "$sha" --arg at "$(date -u +%FT%TZ)" --arg subject "$subject" \
    '{sha:$sha, builtAt:$at, subject:$subject}' >"$out/version.json" || return 1

  mkdir -p "$RELEASES_DIR" || return 1
  rel="$RELEASES_DIR/$sha"
  rm -rf "$rel.partial"; cp -a "$out" "$rel.partial" || return 1
  rm -rf "$rel"; mv -T "$rel.partial" "$rel" || return 1

  prev=$(readlink -f "$RELEASES_DIR/current" 2>/dev/null || true)
  point_current_at "$rel" || return 1
  if ! web_check "$sha"; then
    log "web: post-switch check FAILED; rolling back to ${prev:-<none>}"
    [ -n "$prev" ] && [ -d "$prev" ] && point_current_at "$prev"
    return 1
  fi
  log "web: live at ${sha:0:9}"

  # Keep the newest KEEP_RELEASES releases (plus whatever current points at).
  local keep cur
  cur=$(readlink -f "$RELEASES_DIR/current")
  ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | sed 's:/$::' | tail -n +"$((KEEP_RELEASES + 1))" | while read -r d; do
    [ "$d" = "$cur" ] || rm -rf "$d"
  done
  return 0
}

# ---------------------------------------------------------------- run
result_web=skipped; result_backend=skipped; rc=0

if [ "$need_backend" = 1 ]; then
  if deploy_backend "$new_sha"; then result_backend=ok; state_put backendSha "$new_sha"
  else result_backend=failed; rc=1; fi
fi
if [ "$need_web" = 1 ]; then
  if deploy_web "$new_sha"; then result_web=ok; state_put webSha "$new_sha"
  else result_web=failed; rc=1; fi
fi
# A component that did not need a change still "is at" the new commit.
[ "$need_backend" = 0 ] && state_put backendSha "$new_sha"
[ "$need_web" = 0 ] && state_put webSha "$new_sha"

state_put time "$(date -u +%FT%TZ)"
if [ "$rc" = 0 ]; then
  state_put lastDeployedSha "$new_sha"; state_put lastResult ok
else
  state_put lastResult failed
fi
log "SUMMARY sha=${new_sha:0:9} branch=$DEPLOY_BRANCH web=$result_web backend=$result_backend result=$([ $rc = 0 ] && echo ok || echo failed) seconds=$(( $(date +%s) - START_TS ))"
exit "$rc"
