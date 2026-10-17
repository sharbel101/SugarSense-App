# ops/glucose-pipeline

Reliability package for the glucose collection pipeline (follower phone -> tunnels -> `bg_service` on the VM).
Diagnosis and design notes: `RUNBOOK.md` (also the agent's instructions). Nothing here changes `bg_service.py`,
the models, `bg.db` or any alert threshold.

| Path | What | Where it runs |
|---|---|---|
| `phone/glucose_sync.js` | AutoJs6 collector v3 (failover, timeouts, reporting, queue) | Follower phone, `/sdcard/Download/glucose_sync.js` (already deployed 2026-10-17) |
| `guardian/bg-guardian.mjs` + `guardian.test.mjs` | Watchdog, incident alarm, tunnel discovery. `cd guardian && node --test guardian.test.mjs` | VM `~/bg/guardian/` |
| `systemd/bg-cloudflared.service` | Supervised 2nd quick tunnel for the phone | VM |
| `systemd/bg-guardian.service` | Runs the guardian | VM |
| `install.sh` | Idempotent installer with nginx auto-rollback and a verification report | run on the VM |

Install (from the repo root, PowerShell or Git Bash):

```bash
tar czf - -C ops glucose-pipeline | ssh -i ~/.ssh/oracle_sep5.key ubuntu@139.185.53.135 'rm -rf /tmp/gp && mkdir /tmp/gp && tar xzf - -C /tmp/gp && bash /tmp/gp/glucose-pipeline/install.sh'
```

The phone script embeds no token: it reads `endpoint` / `token` / optional `endpoints[]` / `fallback` from
`/sdcard/Download/glucose_config.json` on the phone.
