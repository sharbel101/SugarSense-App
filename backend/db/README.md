# SugarSense database (PostgreSQL 16 on the Oracle VM)

Status 2026-10-16: installed, migrated (0001-0005) and verified on the VM. **Nothing in the Nest backend reads
or writes it yet** (persistence of meals/glucose/predictions is the next step; the ORM choice is still open in
`../../CLAUDE.md` section 15). No real data is in it.

## Layout

| Item | Where |
|---|---|
| Engine | PostgreSQL 16.15 (Ubuntu 24.04 package `postgresql`), cluster `16/main`, data in `/var/lib/postgresql/16/main` (root disk, persistent), service `postgresql` (enabled, starts on boot) |
| Network | `listen_addresses = 'localhost'`, port 5432 bound to 127.0.0.1 only; `pg_hba.conf` allows local peer and 127.0.0.1/::1 with `scram-sha-256`. No remote access. |
| Settings | `/etc/postgresql/16/main/conf.d/sugarsense.conf`: `max_connections = 30`, slow-query log > 500 ms, lock-wait logging, UTC. Log: `/var/log/postgresql/postgresql-16-main.log` |
| Database | `sugarsense`, owner `sugarsense_owner`, schema `public` |
| Roles | `sugarsense_owner` (runs migrations, 5 connections), `sugarsense_app` (the application, 15 connections, no superuser/createdb/createrole, DML only). The `postgres` superuser is used only by an admin over the local socket. |
| Credentials | `~ubuntu/sugarsense-db.env` on the VM, mode 600, **not in git**. Keys: `DATABASE_MIGRATE_URL` (owner) and `DATABASE_URL` (app). The app must only ever receive `DATABASE_URL`. |
| Migrations | `backend/db/migrations/NNNN_name.sql`, applied by `backend/db/migrate.mjs` |
| Tests | `backend/db/tests/verify.sql` (as the app role) and `verify_owner.sql` (FKs and append-only triggers) |
| Backups | `/usr/local/sbin/sugarsense-db-backup` + `sugarsense-db-backup.timer` (daily 03:15 UTC) -> `/var/backups/sugarsense-db/`, newest 14 kept. Source in `backend/db/ops/`. |

## Tables

`users`, `glucose_readings`, `context_features`, `meal_events`, `meal_items`, `meal_corrections`,
`insulin_events`, `activity_events`, `sleep_events`, `predictions`, `prediction_outcomes`,
`model_parameters`, `model_performance` (+ `schema_migrations`).

Rules baked into the schema (CLAUDE.md section 3):
- mg/dL only, `timestamptz` (UTC) plus a separate `utc_offset_minutes` where local time matters.
- `NULL` = unknown, never a stand-in zero. A confirmed zero is `0` (e.g. a confirmed meal must have carbs; a
  confirmed insulin event must have `units_administered`).
- `units_suggested` and `units_administered` are separate columns.
- Idempotency: `UNIQUE (user_id, source, measured_at)` for glucose; `(user_id, client_uuid)` for meals and
  insulin; partial unique indexes on `(user_id, source, external_id)`.
- `predictions` and `prediction_outcomes` are append-only (triggers block UPDATE/DELETE even for the owner).
  An outcome is a separate row; a prediction is never rewritten. `model_parameters` is versioned
  (one row per user/name/version); the app may change only `status`.
- Users with history cannot be deleted (`ON DELETE RESTRICT`).
- JSONB only for `profile`, `metadata`, `analysis_raw` and the prediction `input_snapshot`.
- The app role has SELECT/INSERT everywhere, UPDATE on a few mutable tables, DELETE only on `meal_items`,
  no DDL, no TRUNCATE, no access to `schema_migrations`.

## Everyday commands (on the VM)

```bash
cd ~/sugarsense-db-staging          # runner + migrations (see "Deploying migrations")
export DB_ENV_FILE=$HOME/sugarsense-db.env
node migrate.mjs --status           # applied / pending
node migrate.mjs                    # apply pending (owner role)
node migrate.mjs --check            # health check as the app role: prints user and database, no secrets
sudo -u postgres psql -d sugarsense # admin shell (local socket)
```

Migrations are forward-only and checksummed: never edit an applied file, add the next number. Keep
each file in one transaction-safe unit.

### Deploying migrations

Until this folder is pushed and pulled to the VM, the runner lives in `~/sugarsense-db-staging` (a copy of
`backend/db/` with `node_modules` symlinked to `~/sugarsense-app/backend/node_modules`). The push-to-deploy
pipeline does **not** run migrations; run them by hand after a deploy that adds a file:

```bash
cd ~/sugarsense-app/backend && DB_ENV_FILE=$HOME/sugarsense-db.env node db/migrate.mjs
```

## Backup and restore

Backup runs daily via `sugarsense-db-backup.timer`; run one now with `sudo systemctl start sugarsense-db-backup`
(output: `journalctl -u sugarsense-db-backup -n 5`). Dumps are `pg_dump --format=custom`, mode 600, in a
postgres-owned 700 directory. They are on the same disk as the database, so **copy them off the VM** regularly
(manual step, not set up).

Restore into a scratch database first to check it, then swap if needed:

```bash
F=$(sudo bash -c 'ls -1t /var/backups/sugarsense-db/*.dump | head -1')
sudo -u postgres createdb sugarsense_restore_test
sudo -u postgres pg_restore --no-owner --dbname=sugarsense_restore_test "$F"
sudo -u postgres psql -d sugarsense_restore_test -c 'select count(*) from glucose_readings'
sudo -u postgres dropdb sugarsense_restore_test          # when done
```

Disaster restore into a fresh `sugarsense` database: stop whatever uses it, `createdb -O sugarsense_owner sugarsense`,
`pg_restore --no-owner --role=sugarsense_owner --dbname=sugarsense <dump>`, then re-run `node migrate.mjs --status`
(nothing should be pending) and the grants in `0004`/`0005` apply because they are part of the dump.
Never `dropdb sugarsense` without a verified dump.

## Not done / manual follow-ups

- Off-VM copy of backups; a tested point-in-time-recovery setup (WAL archiving) if the data ever matters more.
- Wiring the Nest backend to the database (needs the ORM/query-layer decision) and putting `DATABASE_URL` into
  `backend/.env` for that process.
- Auth/consent tables (`care_relationship`, `audit_log`) and `therapy_settings`/`sensor_*` are not created yet.
- `users.timezone` is length-checked only; validate the IANA name in the app.
