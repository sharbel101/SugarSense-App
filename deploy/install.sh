#!/usr/bin/env bash
# One-time installer, run ON THE VM as root from the repo's deploy/ folder:  sudo bash install.sh
# Idempotent. Does not touch nginx, tunnels or any other service.
set -euo pipefail
cd "$(dirname "$0")"
U=ubuntu
install -d -o $U -g $U /home/ubuntu/sugarsense-deploy /var/lib/sugarsense-deploy /var/www/releases
install -m 0755 -o $U -g $U deploy.sh /home/ubuntu/sugarsense-deploy/deploy.sh
[ -f /etc/sugarsense-deploy.env ] || install -m 0644 sugarsense-deploy.env.example /etc/sugarsense-deploy.env
install -m 0644 sugarsense-deploy.service sugarsense-deploy.timer /etc/systemd/system/

# Migrate the web root: /var/www/sugarsense-web becomes a symlink to /var/www/releases/current,
# which points at the active release directory. nginx's root path does not change.
if [ -d /var/www/sugarsense-web ] && [ ! -L /var/www/sugarsense-web ]; then
  mv /var/www/sugarsense-web /var/www/releases/initial
  ln -sfn /var/www/releases/initial /var/www/releases/current
  ln -s /var/www/releases/current /var/www/sugarsense-web   # sub-millisecond window after the mv
  chown -h $U:$U /var/www/releases/current
  echo "migrated web root to releases/initial"
fi
systemctl daemon-reload
echo "installed. enable with: systemctl enable --now sugarsense-deploy.timer"
