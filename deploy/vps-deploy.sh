#!/bin/sh
# Deploys a commit of main on the VPS: runs the server image CI pushed to
# ghcr.io for that commit, with the commit's docker-compose.yml.
#
# Installed as /usr/local/bin/kaplumbaga-deploy and set as the forced command of
# the GitHub Actions deploy key in /root/.ssh/authorized_keys:
#
#   restrict,command="/usr/local/bin/kaplumbaga-deploy" ssh-ed25519 AAAA... kaplumbaga-deploy
#
# so that key can't run anything else. The command the client sends
# (SSH_ORIGINAL_COMMAND) is the commit to deploy. After a deploy the script
# installs its own version from that commit, so changes to it deploy too.
set -eu

installed=/usr/local/bin/kaplumbaga-deploy
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
running=$(git rev-parse HEAD)

# Runs the server image of a commit. A failed pull changes nothing.
up() {
  # .env is untracked and ignored, reset keeps it
  git reset --hard --quiet "$1" &&
    SERVER_TAG="$1" docker compose pull --quiet server &&
    SERVER_TAG="$1" docker compose up --detach --no-build --remove-orphans --wait --wait-timeout 120
}

if ! up "$sha"; then
  echo "$sha didn't come up healthy, going back to $running" >&2
  up "$running" || echo "$running didn't come up healthy either" >&2
  exit 1
fi

# images of earlier deploys, ghcr.io still has them for going back
docker image prune --all --force \
  --filter "label=org.opencontainers.image.source=https://github.com/erentnr/kaplumbaga" > /dev/null

# The next deploy runs this commit's version of the script. It's moved over
# the old file, so the shell still reading that one isn't disturbed.
if sh -n deploy/vps-deploy.sh; then
  install -m 755 deploy/vps-deploy.sh "$installed.new" && mv "$installed.new" "$installed"
else
  echo "deploy/vps-deploy.sh has a syntax error, $installed is unchanged" >&2
fi
echo "deployed $sha"
