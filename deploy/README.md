# SugarSense push-to-deploy

A systemd timer on the Oracle VM polls GitHub every 3 minutes. When `DEPLOY_BRANCH` moves it builds the
changed part (web and/or backend), runs guards, and only then swaps it in. A failed build, guard, test or
health check leaves the running site/backend untouched (or restores the previous one).

No inbound webhook, no new port, no secrets in GitHub or in these files.

## What it does

| Changed paths (since last deployed commit) | Action |
|---|---|
| `mobile/**` | Web deploy: `expo export` -> guards -> new release dir -> symlink swap -> check -> auto rollback |
| `backend/**` | Backend deploy: ff the clone, `npm install`, `typecheck` + `test`, `build`, restart, 30 s `/health` poll, auto restore of `dist.prev` |
| anything else (docs, deploy/, ...) | Nothing, state is just advanced |

Web guards (fail closed): bundle has no `__SAME_ORIGIN__`, `localhost:3000` or `ngrok-free.dev`; contains
`/meals/analyze`; is > 500 KB; `index.html` exists and its script file exists.

Layout on the VM:

```
/home/ubuntu/sugarsense-deploy/deploy.sh     the script (copied from deploy/ by install.sh)
/home/ubuntu/sugarsense-deploy/src           build checkout (+ persistent mobile/node_modules)
/etc/sugarsense-deploy.env                   config, no secrets
/var/lib/sugarsense-deploy/state.json        lastDeployedSha, lastAttemptSha, lastResult, time, webSha, backendSha
/var/www/sugarsense-web -> releases/current -> releases/<sha>     (nginx root, path unchanged)
/var/www/releases/<sha>/version.json         {sha, builtAt, subject}
/home/ubuntu/sugarsense-app/backend/dist.prev  previous backend build
```

## Everyday commands (on the VM)

```bash
sudo systemctl start sugarsense-deploy           # run now (same as the timer)
journalctl -u sugarsense-deploy -n 100 --no-pager   # logs; one "deploy: SUMMARY ..." line per real run
systemctl list-timers | grep sugarsense-deploy
cat /var/lib/sugarsense-deploy/state.json
curl -s http://127.0.0.1:8090/version.json       # what is live (add the public URL from outside)
```

## Pause / resume

```bash
sudo systemctl stop sugarsense-deploy.timer      # pause
sudo systemctl start sugarsense-deploy.timer     # resume
```

## Change the deployed branch

Edit `DEPLOY_BRANCH` in `/etc/sugarsense-deploy.env` (no restart needed, read on every run). To keep
half-finished work off the live site, use `release` and promote manually: `git push origin main:release`.

## Roll back by hand

Web (instant, no build):

```bash
ls -1dt /var/www/releases/*/            # newest first
ln -sfn /var/www/releases/<sha> /var/www/releases/current.new && mv -T /var/www/releases/current.new /var/www/releases/current
```

Then pause the timer, or the next poll will not redeploy the same sha (state says it is deployed), but a
new commit will replace your rollback. Backend:

```bash
cd ~/sugarsense-app/backend && rm -rf dist.failed && mv dist dist.failed && cp -a dist.prev dist
sudo systemctl restart sugarsense-backend
```

## Install / reinstall (once)

On the VM, from a checkout of this repo: `sudo bash deploy/install.sh`, review `/etc/sugarsense-deploy.env`,
then `sudo systemctl enable --now sugarsense-deploy.timer`. The installer migrates the web root to the
release layout (`/var/www/sugarsense-web` becomes a symlink; nginx config is unchanged).

## Rules it relies on

- The deploy never restarts nginx or any tunnel (the public trycloudflare URL must not rotate), never reads
  `backend/.env`, never pushes, and refuses to deploy the backend over a dirty working tree.
- The VM only pulls. If the repo becomes private, give the VM a read-only deploy key and set `REPO_URL` to
  the SSH URL.
- A commit that fails is not retried every poll: retry happens when origin moves or after 30 min.
- Push to the deployed branch = live in ~5 minutes. Other sessions' pushes included.
- Backend `GET /glucose` needs, once and outside this automation: a systemd drop-in with
  `EnvironmentFile=/home/ubuntu/forecast/forecast.env`, and `glucose` added to the nginx `:8090` regex.
  Until then it answers `status:"unavailable"` (expected).

## Test hook

`DEPLOY_TEST_FAIL_POST_SWITCH=1` makes the post-switch web check fail, to prove automatic rollback.
Never set it in `/etc/sugarsense-deploy.env`.

## Known blocker (2026-10-14): web build from GitHub main fails

`mobile/babel.config.js` requires `react-native-worklets/plugin`, but `mobile/package.json` does not declare
`react-native-worklets`. A clean checkout therefore cannot build the web bundle
(`Cannot find module 'react-native-worklets/plugin'`). The deploy fails closed (live site untouched) until
this lands on the deployed branch:

```bash
git apply deploy/patches/mobile-worklets-dependency.patch   # adds "react-native-worklets": "0.10.1" + lockfile flags
```

Backend deploys are not affected. Optional cleanup afterwards: `mobile/src/config.ts` now reads
`EXPO_PUBLIC_WEB_SAME_ORIGIN`, which the deploy build sets; the `__SAME_ORIGIN__` sentinel replacement stays as
a harmless fallback and the bundle guards remain either way.

## How this was tested (sandbox, not production)

A local bare repo on the VM (`~/sandbox/origin.git`) with a separate web root, state dir and a backend on
:3100 exercised: visible-text change goes live and `version.json` shows the new sha; a syntactically broken
commit is rejected and not retried every poll; a forced post-switch failure rolls the symlink back; a
backend-only commit builds, tests, restarts and `/health` is 200; a failing unit test blocks the restart.
