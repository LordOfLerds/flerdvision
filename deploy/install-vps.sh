#!/usr/bin/env bash
#
# Canonical Flerdvision VPS installer.
#
# Installs one exact release into /opt/flerdvision/releases/<sha> and atomically points
# /opt/flerdvision/current at it. Runtime state, browser profiles, Drive credentials and Telegram
# secrets live outside the release and are NEVER copied from another installation.
#
#   sudo bash deploy/install-vps.sh --repo <read-only-git-url> --release <exact-sha>
#   sudo bash deploy/install-vps.sh --check
#
# Idempotent: an already-built exact release is reused; config/state are kept untouched.

set -euo pipefail

RELEASE_SHA=""
CHECK_ONLY=false
REPO_URL="${FLERDVISION_REPO_URL:-}"

PREFIX=/opt/flerdvision
SOURCE_DIR="$PREFIX/source"
RELEASES_DIR="$PREFIX/releases"
CURRENT_LINK="$PREFIX/current"
ETC_DIR=/etc/flerdvision
RUNTIME_DIR=/var/lib/flerdvision
BACKUP_DIR=/var/backups/flerdvision
CHROME_DIR=/opt/chrome
RUN_USER=flerdvision
TIMEZONE="${FLERDVISION_TIMEZONE:-Europe/Vienna}"

while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE_SHA="${2:-}"; shift 2 ;;
    --repo) REPO_URL="${2:-}"; shift 2 ;;
    --check) CHECK_ONLY=true; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   ok    %s\n' "$*"; }
todo() { printf '   TODO  %s\n' "$*"; }
die()  { printf '\n\033[31mabort: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo bash deploy/install-vps.sh ...)"

# ---------------------------------------------------------------- check mode
if $CHECK_ONLY; then
  say "Checking an existing installation"
  status=0
  check() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else todo "$1"; status=1; fi; }
  check "operating user $RUN_USER exists"          "id $RUN_USER"
  check "node 22 or newer"                         "test \"\$(node -p 'process.versions.node.split(\".\")[0]' 2>/dev/null || echo 0)\" -ge 22"
  check "ffprobe present"                          "command -v ffprobe"
  check "sqlite3 present"                          "command -v sqlite3"
  check "Xvfb present"                             "command -v Xvfb"
  check "Chrome for Testing pinned"                "test -x $CHROME_DIR/current/chrome"
  check "source cache present"                     "test -d $SOURCE_DIR/.git"
  check "current release symlink"                  "test -L $CURRENT_LINK && test -f $CURRENT_LINK/dist/cli/flerdvision.js"
  check "secrets file $ETC_DIR/secrets.env"        "test -f $ETC_DIR/secrets.env"
  check "release pin $ETC_DIR/release.env"         "test -f $ETC_DIR/release.env"
  check "canonical spec $ETC_DIR/flerdvision.json" "test -f $ETC_DIR/flerdvision.json"
  check "runtime root $RUNTIME_DIR/runtime"        "test -d $RUNTIME_DIR/runtime"
  check "Xvfb service active"                      "systemctl is-active flerdvision-xvfb"
  check "loopback noVNC backend active"            "systemctl is-active flerdvision-novnc"
  check "daemon unit installed"                    "test -f /etc/systemd/system/flerdvision-daemon.service"
  check "firewall enabled"                         "ufw status | grep -q 'Status: active'"
  exit $status
fi

[ -n "$RELEASE_SHA" ] || die "--release <exact-sha> is required"

# ------------------------------------------------- base system, user, firewall
say "Base system, operating user, firewall"
timedatectl set-timezone "$TIMEZONE"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get -y -qq dist-upgrade
id "$RUN_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "Flerdvision runtime" "$RUN_USER"
apt-get install -y -qq ufw unattended-upgrades
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
dpkg-reconfigure -f noninteractive unattended-upgrades
ok "firewall active; no browser/VNC port opened"

# ------------------------------------------------------------- packages
say "Node 22, media tools, private display stack"
if [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
node --version | grep -q '^v2[2-9]' || die "node 22+ required, found $(node --version 2>/dev/null || echo none)"
apt-get install -y -qq git unzip curl ffmpeg sqlite3 openssl \
  xvfb x11vnc novnc websockify fonts-liberation fonts-noto-color-emoji
apt-get install -y -qq libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 \
  libcups2t64 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libatspi2.0-0t64 \
  libx11-6 libxcb1 libxext6 libxi6 libxtst6 libglib2.0-0t64 xdg-utils
ok "packages installed"

# --------------------------------------------- Chrome for Testing, pinned per host
say "Chrome for Testing"
if [ ! -x "$CHROME_DIR/current/chrome" ]; then
  CFT_VERSION="$(curl -fsSL https://googlechromelabs.github.io/chrome-for-testing/LATEST_RELEASE_STABLE)"
  mkdir -p "$CHROME_DIR/versions"
  curl -fsSL -o /tmp/chrome-linux64.zip \
    "https://storage.googleapis.com/chrome-for-testing-public/${CFT_VERSION}/linux64/chrome-linux64.zip"
  unzip -q -o /tmp/chrome-linux64.zip -d "$CHROME_DIR/versions/${CFT_VERSION}"
  rm -f /tmp/chrome-linux64.zip
  ln -sfn "$CHROME_DIR/versions/${CFT_VERSION}/chrome-linux64" "$CHROME_DIR/current"
fi
ok "$("$CHROME_DIR/current/chrome" --version)"

cat > /etc/apparmor.d/chrome-for-testing <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>
profile chrome-for-testing /opt/chrome/versions/*/chrome-linux64/chrome flags=(unconfined) {
  userns,
  include if exists <local/chrome-for-testing>
}
PROFILE
apparmor_parser -r /etc/apparmor.d/chrome-for-testing 2>/dev/null || true

# ------------------------------------------------------- source cache + immutable release
say "Pinned immutable release"
mkdir -p "$PREFIX" "$RELEASES_DIR"
chown "$RUN_USER:$RUN_USER" "$PREFIX" "$RELEASES_DIR"
if [ ! -d "$SOURCE_DIR/.git" ]; then
  [ -n "$REPO_URL" ] || die "first install needs --repo <read-only-git-url>"
  sudo -u "$RUN_USER" git clone --quiet "$REPO_URL" "$SOURCE_DIR"
fi
sudo -u "$RUN_USER" git -C "$SOURCE_DIR" fetch --quiet origin --prune
sudo -u "$RUN_USER" git -C "$SOURCE_DIR" cat-file -e "${RELEASE_SHA}^{commit}" \
  || die "release $RELEASE_SHA is not present after fetch"
FULL_SHA="$(sudo -u "$RUN_USER" git -C "$SOURCE_DIR" rev-parse "${RELEASE_SHA}^{commit}")"
RELEASE_DIR="$RELEASES_DIR/$FULL_SHA"

if [ ! -d "$RELEASE_DIR" ]; then
  sudo -u "$RUN_USER" git -C "$SOURCE_DIR" worktree add --quiet --detach "$RELEASE_DIR" "$FULL_SHA"
  sudo -iu "$RUN_USER" bash -lc "cd '$RELEASE_DIR' && npm ci --silent"
  # Brother host consumes a release that was already release-gated. It only builds/smoke-checks;
  # the historical full suite is NOT re-run on production installation.
  sudo -iu "$RUN_USER" bash -lc "cd '$RELEASE_DIR' && npm run build"
else
  READBACK="$(sudo -u "$RUN_USER" git -C "$RELEASE_DIR" rev-parse HEAD 2>/dev/null || true)"
  [ "$READBACK" = "$FULL_SHA" ] || die "existing release directory $RELEASE_DIR is not $FULL_SHA"
  [ -f "$RELEASE_DIR/dist/cli/flerdvision.js" ] || sudo -iu "$RUN_USER" bash -lc "cd '$RELEASE_DIR' && npm ci --silent && npm run build"
fi
[ -f "$RELEASE_DIR/dist/cli/flerdvision.js" ] || die "release build missing dist/cli/flerdvision.js"
node --check "$RELEASE_DIR/dist/cli/flerdvision.js" >/dev/null
ok "release built and smoke-checked: $FULL_SHA"

TMP_LINK="$PREFIX/.current-$$"
rm -f "$TMP_LINK"
ln -s "$RELEASE_DIR" "$TMP_LINK"
mv -Tf "$TMP_LINK" "$CURRENT_LINK"
ok "current -> releases/$FULL_SHA"

# ------------------------------------------------------------ private persistent directories
say "Persistent config/state"
mkdir -p "$RUNTIME_DIR/runtime" "$RUNTIME_DIR/cache" "$BACKUP_DIR" "$ETC_DIR"
chown -R "$RUN_USER:$RUN_USER" "$RUNTIME_DIR" "$BACKUP_DIR"
chmod 700 "$RUNTIME_DIR" "$RUNTIME_DIR/runtime" "$BACKUP_DIR"
chown "root:$RUN_USER" "$ETC_DIR"
chmod 750 "$ETC_DIR"

if [ ! -f "$ETC_DIR/secrets.env" ]; then
  install -o root -g "$RUN_USER" -m 640 "$CURRENT_LINK/deploy/flerdvision.env.example" "$ETC_DIR/secrets.env"
  todo "fill $ETC_DIR/secrets.env with BROTHER's own OAuth/Telegram data; keep ALLOW_FINAL_PUBLISH=false"
else
  ok "existing secrets.env kept untouched"
fi

printf 'FLERDVISION_RELEASE_SHA=%s\n' "$FULL_SHA" > "$ETC_DIR/release.env"
chown "root:$RUN_USER" "$ETC_DIR/release.env"
chmod 640 "$ETC_DIR/release.env"

if [ ! -f "$ETC_DIR/flerdvision.json" ]; then
  todo "create $ETC_DIR/flerdvision.json (root:$RUN_USER, mode 640) with workspace.runtimeRoot=$RUNTIME_DIR/runtime"
else
  ok "existing canonical spec kept untouched"
fi

if [ -f "$ETC_DIR/flerdvision.env" ]; then
  todo "legacy $ETC_DIR/flerdvision.env exists but is NOT loaded; migrate required values manually to secrets.env, then remove it"
fi
if [ -d "$PREFIX/app" ]; then
  todo "legacy $PREFIX/app exists but is NOT executed; remove it only after production parity (WP10)"
fi

# --------------------------------------------------------- systemd
say "systemd units"
install -m 644 "$CURRENT_LINK/deploy/flerdvision-xvfb.service" /etc/systemd/system/
install -m 644 "$CURRENT_LINK/deploy/flerdvision-novnc.service" /etc/systemd/system/
install -m 644 "$CURRENT_LINK/deploy/flerdvision-daemon.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now flerdvision-xvfb
systemctl enable --now flerdvision-novnc
# Never auto-authorize posting on install/update.
systemctl disable flerdvision-daemon >/dev/null 2>&1 || true
systemctl stop flerdvision-daemon >/dev/null 2>&1 || true
ok "Xvfb + loopback-only noVNC active; posting daemon remains disabled"

cat <<NEXT

Installed immutable release $FULL_SHA.
Code:    $RELEASE_DIR
Current: $CURRENT_LINK
Config:  $ETC_DIR
State:   $RUNTIME_DIR

No full historical test suite was run on this production host. Release testing belongs to the
release-candidate gate, not every installation.

Brother setup (own accounts/state only):
  1. fill $ETC_DIR/secrets.env; create/verify $ETC_DIR/flerdvision.json
  2. set -a; . $ETC_DIR/secrets.env; . $ETC_DIR/release.env; set +a
  3. cd $CURRENT_LINK && node dist/cli/flerdvision.js setup status
  4. drive-auth -> setup confirm-root -> setup confirm-topology -> setup activate
  5. login each social channel; notify-test; setup status must reach READY
  6. loopback noVNC is already running on 127.0.0.1:6080. Configure FLERDVISION_REMOTE_SCREEN_URL
     only to an authenticated/private HTTPS or tailnet gateway that proxies this loopback endpoint.
     NEVER expose 6080/5900 publicly.
  7. qualify this host/accounts, then explicitly authorize ONE canary before enabling the daemon

The installer never copies Luca's DB, browser profiles, Drive refresh token or Telegram secrets.
NEXT
