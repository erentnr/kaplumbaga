#!/bin/sh
# Deploys a commit of main on the VPS.
#
# Installed as /usr/local/bin/kaplumbaga-deploy and set as the forced command of
# the GitHub Actions deploy key in /root/.ssh/authorized_keys:
#
#   restrict,command="/usr/local/bin/kaplumbaga-deploy" ssh-ed25519 AAAA... kaplumbaga-deploy
#
# so that key can't run anything else. The command the client sends
# (SSH_ORIGINAL_COMMAND) is the commit to deploy.
set -eu

sha="${SSH_ORIGINAL_COMMAND:-${1:-}}"
case "$sha" in
  *[!0-9a-f]*) valid=no ;;
  *) [ "${#sha}" -eq 40 ] && valid=yes || valid=no ;;
esac
if [ "$valid" != yes ]; then
  echo "usage: kaplumbaga-deploy <40 character commit sha>" >&2
  exit 2
fi

cd /opt/kaplumbaga
git fetch --quiet origin main
# only commits that are on main can be deployed
if ! git merge-base --is-ancestor "$sha" origin/main; then
  echo "$sha is not on main" >&2
  exit 1
fi
# .env is untracked and ignored, reset keeps it
git reset --hard --quiet "$sha"

docker compose up --detach --build --remove-orphans --wait --wait-timeout 120
docker image prune --force > /dev/null
echo "deployed $sha"
