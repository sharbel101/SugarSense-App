#!/usr/bin/env bash
# One-off ops step on the VM (run by a human after migration 0011 is applied). Creates the two DB roles with random passwords and writes
# ~/garmin-mcp/service.env (chmod 600). Prints NO secret. Polling stays OFF until you set GARMIN_POLLING_ENABLED=true.
set -euo pipefail
ENVF=/home/ubuntu/garmin-mcp/service.env
[ -e "$ENVF" ] && { echo "$ENVF exists; refusing to overwrite"; exit 1; }
DB=${1:-sugarsense}
rnd() { head -c 24 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 28; }
SVC=$(rnd); RO=$(rnd); TOK=$(head -c 32 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 40)
sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -c "CREATE ROLE garmin_svc LOGIN PASSWORD '$SVC'" -c "CREATE ROLE garmin_ro LOGIN PASSWORD '$RO'"
sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d "$DB" <<SQL
GRANT CONNECT ON DATABASE $DB TO garmin_svc, garmin_ro;
GRANT USAGE ON SCHEMA public TO garmin_svc, garmin_ro;
GRANT SELECT, INSERT, UPDATE ON garmin_observations, garmin_job_state TO garmin_svc;
GRANT SELECT, INSERT, UPDATE, DELETE ON garmin_poll_runs TO garmin_svc;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO garmin_svc;
GRANT SELECT ON garmin_observations, garmin_poll_runs, garmin_job_state TO garmin_ro;
SQL
umask 177
cat > "$ENVF" <<EOF
GARMIN_WORKER_DATABASE_URL=postgresql://garmin_svc:$SVC@127.0.0.1/$DB
GARMIN_API_DATABASE_URL=postgresql://garmin_ro:$RO@127.0.0.1/$DB
GARMIN_API_TOKEN=$TOK
GARMIN_API_HOST=127.0.0.1
GARMIN_API_PORT=8310
GARMIN_LOCAL_TZ=Asia/Beirut
GARMIN_POLLING_ENABLED=false
GARMIN_POLL_MIN=10
# Put your Garmin Personal API key on the next line by hand (Garmin Connect > Settings > Personal API token). Never commit it.
GARMIN_PERSONAL_API_KEY=
EOF
echo "roles created, $ENVF written (600). Polling is OFF."
