#!/bin/bash
# Daily logical backup of the sugarsense database (custom format, compressed). Runs as root via systemd;
# dumps as the postgres OS user over the local socket, so no password is involved or stored.
# Keeps the newest 14 dumps. Restore procedure: backend/db/README.md.
set -euo pipefail
umask 077
DIR=/var/backups/sugarsense-db
KEEP=14
install -d -m 700 -o postgres -g postgres "$DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DIR/sugarsense-$STAMP.dump"
sudo -u postgres pg_dump --format=custom --no-owner --dbname=sugarsense --file="$OUT"
sudo -u postgres pg_restore --list "$OUT" > /dev/null   # fails if the archive is unreadable
echo "backup ok: $OUT ($(stat -c %s "$OUT") bytes)"
ls -1t "$DIR"/sugarsense-*.dump | tail -n +$((KEEP + 1)) | xargs -r rm --
