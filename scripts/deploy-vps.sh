#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Invoked over SSH after CI has uploaded the tested artifact and checksum.
base=${1:?Deployment directory is required}
run_key=${2:?Run identifier is required}
sha=${3:?Commit SHA is required}
service=eishin-flash.service
[[ "$base" =~ ^/([a-zA-Z0-9_-][a-zA-Z0-9._-]*/)*[a-zA-Z0-9_-][a-zA-Z0-9._-]*$ ]] || exit 1
[[ "$run_key" =~ ^[0-9]+-[0-9]+$ && "$sha" =~ ^[0-9a-f]{40}$ ]] || exit 1

for command in node npm tar sha256sum flock systemctl journalctl; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
[[ -f "$base/shared/.env" ]] || { echo "Missing $base/shared/.env" >&2; exit 1; }
[[ ! -e "$base/current" || -L "$base/current" ]] || { echo 'current must be a symlink.' >&2; exit 1; }

mkdir -p "$base/releases"
exec 9>"$base/.deploy.lock"
flock -w 120 9
cd "$base/incoming/$run_key"
sha256sum --check SHA256SUMS
release=$(mktemp -d "$base/releases/$sha.XXXXXX")
tar -xzf "eishin-flash-$sha.tar.gz" --no-same-owner -C "$release"
cd "$release"
expected_node="v$(tr -d '\r\n' < .node-version)"
[[ "$(node --version)" == "$expected_node" ]] || { echo "VPS needs Node.js $expected_node installed system-wide." >&2; exit 1; }
npm ci --omit=dev --no-audit --no-fund
ln -s "$base/shared/.env" "$release/.env"
# Fail on invalid credentials before stopping the currently running bot.
npm run db:check

previous=$(readlink -f "$base/current" 2>/dev/null || true)
if [[ -L "$base/current" ]]; then
  [[ "$previous" == "$base/releases/"* && -d "$previous" ]] || { echo 'Invalid previous release.' >&2; exit 1; }
else
  previous=''
fi
was_active=false
if systemctl is-active --quiet "$service"; then was_active=true; fi
commands_attempted=false

switch_release() {
  ln -s "$1" "$base/current.next-$run_key" || return 1
  mv -Tf "$base/current.next-$run_key" "$base/current"
}

wait_for_login() {
  local invocation current logs
  invocation=$(systemctl show "$service" --property=InvocationID --value) || return 1
  [[ "$invocation" =~ ^[0-9a-f]{32}$ ]] || return 1
  for ((attempt = 0; attempt < 60; attempt++)); do
    systemctl is-active --quiet "$service" || return 1
    current=$(systemctl show "$service" --property=InvocationID --value) || return 1
    [[ "$current" == "$invocation" ]] || return 1
    logs=$(journalctl --quiet --no-pager --output=cat "_SYSTEMD_INVOCATION_ID=$invocation") || return 1
    if grep -Fq 'Đăng nhập thành công:' <<< "$logs"; then return 0; fi
    sleep 1
  done
  echo 'Bot did not confirm Discord login within 60 seconds.' >&2
  return 1
}

rollback() {
  local status=$1
  trap - ERR INT TERM HUP
  set +e
  echo 'Deployment failed; attempting to restore the previous code release.' >&2
  # Never start the old process until the new process has stopped.
  if ! systemctl stop "$service"; then
    echo 'Could not stop the service; manual recovery is required.' >&2
    exit "$status"
  fi
  if [[ -n "$previous" ]]; then
    if ! switch_release "$previous"; then
      echo 'Could not restore the previous symlink; manual recovery is required.' >&2
      exit "$status"
    fi
    if [[ "$commands_attempted" == true ]]; then
      (cd "$previous" && npm run deploy) || echo 'Could not restore previous slash commands.' >&2
    fi
    if [[ "$was_active" == true ]]; then
      if systemctl start "$service" && wait_for_login; then
        echo 'Previous code release is running again.' >&2
      else
        echo 'Previous release did not recover; inspect the service logs.' >&2
      fi
    fi
  elif [[ -L "$base/current" && "$(readlink -f "$base/current")" == "$release" ]]; then
    unlink "$base/current"
  fi
  echo 'Database migrations are not rolled back automatically.' >&2
  exit "$status"
}

trap 'rollback $?' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM HUP
systemctl stop "$service"
npm run db:migrate
commands_attempted=true
npm run deploy
switch_release "$release"
systemctl start "$service"
wait_for_login
trap - ERR INT TERM HUP
echo "Deployment successful: $sha"
