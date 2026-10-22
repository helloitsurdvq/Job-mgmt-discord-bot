#!/usr/bin/env bash
set -Eeuo pipefail

# Exercise real release/symlink operations with fake npm and systemd.
# No Discord, MySQL, network connections or real services are used.
script=$(cd "$(dirname "$0")/.." && pwd)/scripts/deploy-vps.sh
test_root=$(mktemp -d /tmp/eishin-cd-test.XXXXXX)
cleanup() {
  if [[ "$test_root" == /tmp/eishin-cd-test.* && "$(realpath "$test_root")" == "$test_root" ]]; then
    rm -rf -- "$test_root"
  fi
}
trap cleanup EXIT
trap 'echo "Deployment test failed at line $LINENO" >&2; if [[ -n ${base:-} && -f "$base/output" ]]; then cat "$base/output" >&2; fi' ERR
mkdir "$test_root/bin"

cat > "$test_root/bin/node" <<'MOCK'
#!/usr/bin/env bash
printf 'v%s\n' "$(tr -d '\r\n' < .node-version)"
MOCK
cat > "$test_root/bin/npm" <<'MOCK'
#!/usr/bin/env bash
echo "npm $* in $PWD" >> "$CASE_BASE/events"
if [[ "$PWD" != "$CASE_BASE/releases/previous" ]]; then
  [[ "$FAIL_STAGE" != dependencies || "$*" != ci* ]] || exit 1
  [[ "$FAIL_STAGE" != migration || "$*" != 'run db:migrate' ]] || exit 1
  [[ "$FAIL_STAGE" != commands || "$*" != 'run deploy' ]] || exit 1
fi
MOCK
cat > "$test_root/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
case "$1" in
  stop) echo stop >> "$CASE_BASE/events"; echo inactive > "$CASE_BASE/state" ;;
  start) echo start >> "$CASE_BASE/events"; echo active > "$CASE_BASE/state" ;;
  show) printf '%032d\n' 1 ;;
  is-active)
    [[ "$(cat "$CASE_BASE/state")" == active ]] || exit 1
    if [[ "$FAIL_STAGE" == startup && "$(readlink -f "$CASE_BASE/current")" != "$CASE_BASE/releases/previous" ]]; then exit 1; fi
    ;;
  *) exit 1 ;;
esac
MOCK
cat > "$test_root/bin/journalctl" <<'MOCK'
#!/usr/bin/env bash
echo 'Đăng nhập thành công: test-bot'
MOCK
# Git Bash on Windows has no flock; serialization is provided by real flock in Linux CI.
if ! command -v flock >/dev/null; then
  printf '#!/usr/bin/env bash\nexit 0\n' > "$test_root/bin/flock"
fi
chmod +x "$test_root/bin/"*
export PATH="$test_root/bin:$PATH"
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

run_case() {
  local stage=$1 initial=$2 status=0 base
  base="$test_root/$stage-$initial"
  mkdir -p "$base/shared" "$base/incoming/1-1" "$base/releases/previous" "$base/source"
  printf 'DO_NOT_CHANGE=test\n' > "$base/shared/.env"
  echo 24.22.1 > "$base/source/.node-version"
  echo 24.22.1 > "$base/releases/previous/.node-version"
  if [[ "$initial" == previous ]]; then
    ln -s "$base/releases/previous" "$base/current"
    echo active > "$base/state"
  else
    echo inactive > "$base/state"
  fi
  : > "$base/events"
  tar -czf "$base/incoming/1-1/eishin-flash-$sha.tar.gz" -C "$base/source" .node-version
  (cd "$base/incoming/1-1" && sha256sum "eishin-flash-$sha.tar.gz" > SHA256SUMS)
  if [[ "$stage" == checksum ]]; then echo corrupted >> "$base/incoming/1-1/eishin-flash-$sha.tar.gz"; fi
  CASE_BASE="$base" FAIL_STAGE="$stage" bash "$script" "$base" 1-1 "$sha" > "$base/output" 2>&1 || status=$?
  if [[ "$stage" == success && "$status" != 0 ]]; then cat "$base/output" >&2; fi
  [[ "$(cat "$base/shared/.env")" == DO_NOT_CHANGE=test ]]
  if [[ "$stage" == success ]]; then
    [[ "$status" == 0 && "$(readlink -f "$base/current")" == "$base/releases/$sha."* ]]
    [[ "$(cat "$base/state")" == active ]]
    [[ "$(grep -c '^stop$' "$base/events")" == 1 ]]
    grep -q '^npm run db:migrate' "$base/events"
    grep -q '^npm run deploy' "$base/events"
    [[ "$(readlink -f "$base/current/.env")" == "$base/shared/.env" ]]
  else
    [[ "$status" != 0 ]]
    if [[ "$initial" == previous ]]; then
      [[ "$(readlink -f "$base/current")" == "$base/releases/previous" ]]
      [[ "$(cat "$base/state")" == active ]]
    else
      [[ ! -L "$base/current" && "$(cat "$base/state")" == inactive ]]
    fi
    if [[ "$stage" == dependencies || "$stage" == checksum ]]; then
      ! grep -q '^stop$' "$base/events"
    fi
    if [[ "$initial" == previous && ( "$stage" == startup || "$stage" == commands ) ]]; then
      grep -q "^npm run deploy in $base/releases/previous$" "$base/events"
    fi
  fi
  echo "PASS: $stage ($initial)"
}

run_case success previous
run_case success first
run_case dependencies previous
run_case checksum previous
run_case migration previous
run_case commands previous
run_case startup previous
run_case startup first
