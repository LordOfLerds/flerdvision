#!/usr/bin/env bash
#
# Flerdvision VPS installer — sections 2 to 8 of docs/24-VPS-DEPLOYMENT.md as one idempotent run.
#
# Deliberately stops where the document stops being mechanical: it never fills in secrets, never
# writes the canonical spec, never enables the posting daemon. Those are the steps that need a
# human and an authorization, and section 9 onwards walks through them.
#
#   sudo bash deploy/install-vps.sh --release <sha>
#   sudo bash deploy/install-vps.sh --check          # verify an existing host, change nothing
#
# Safe to re-run: every step checks its own result first.

set -euo pipefail

RELEASE_SHA=""
CHECK_ONLY=false
REPO_URL="${FLERDVISION_REPO_URL:-}"

APP_DIR=/opt/flerdvision/app
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
  check "operating user $RUN_USER exists"        "id $RUN_USER"
  check "node 22 or newer"                       "test \"\$(node -p 'process.versions.node.split(\".\")[0]' 2>/dev/null || echo 0)\" -ge 22"
  check "ffprobe present"                        "command -v ffprobe"
  check "sqlite3 present"                        "command -v sqlite3"
  check "Xvfb present"                           "command -v Xvfb"
  check "Chrome for Testing pinned"              "test -x $CHROME_DIR/current/chrome"
  check "AppArmor profile for Chrome"            "test -f /etc/apparmor.d/chrome-for-testing"
  check "repository at $APP_DIR"                 "test -d $APP_DIR/.git"
  check "dependencies installed"                 "test -d $APP_DIR/node_modules"
  check "env file $ETC_DIR/flerdvision.env"      "test -f $ETC_DIR/flerdvision.env"
  check "release pin $ETC_DIR/release.env"       "test -f $ETC_DIR/release.env"
  check "canonical spec $ETC_DIR/flerdvision.json" "test -f $ETC_DIR/flerdvision.json"
  check "runtime root $RUNTIME_DIR/runtime"      "test -d $RUNTIME_DIR/runtime"
  check "Xvfb service active"                    "systemctl is-active flerdvision-xvfb"
  check "firewall enabled"                       "ufw status | grep -q 'Status: active'"
  exit $status
fi

[ -n "$RELEASE_SHA" ] || die "--release <sha> is required: the host runs one pinned, qualified release"

# ------------------------------------------------- 2. base system, user, firewall
say "Base system, operating user, firewall"
timedatectl set-timezone "$TIMEZONE"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get -y -qq dist-upgrade
id "$RUN_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "Flerdvision runtime" "$RUN_USER"
ok "user $RUN_USER"
apt-get install -y -qq ufw unattended-upgrades
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
dpkg-reconfigure -f noninteractive unattended-upgrades
ok "firewall active, unattended security updates on"

# ------------------------------------------------------------- 3. packages
say "Node 22, media tools, display stack"
if [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
node --version | grep -q '^v2[2-9]' || die "node 22+ required, found $(node --version 2>/dev/null || echo none)"
apt-get install -y -qq git unzip curl ffmpeg sqlite3 \
  xvfb x11vnc novnc websockify fonts-liberation fonts-noto-color-emoji
# Chrome for Testing runtime libraries (Ubuntu 24.04 package names).
apt-get install -y -qq libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 \
  libcups2t64 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libatspi2.0-0t64 \
  libx11-6 libxcb1 libxext6 libxi6 libxtst6 libglib2.0-0t64 xdg-utils
ok "packages installed"

# --------------------------------------------- 4. Chrome for Testing, pinned
say "Chrome for Testing (pinned — apt would drift the surface under us)"
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

# Ubuntu 24.04 refuses unprivileged user namespaces to unprofiled binaries, and the headful
# login browser starts WITH its sandbox. Without this profile the login window dies instantly.
cat > /etc/apparmor.d/chrome-for-testing <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile chrome-for-testing /opt/chrome/versions/*/chrome-linux64/chrome flags=(unconfined) {
  userns,
  include if exists <local/chrome-for-testing>
}
PROFILE
apparmor_parser -r /etc/apparmor.d/chrome-for-testing 2>/dev/null || true
ok "AppArmor profile loaded"

# ------------------------------------------------------- 5. repository, pinned
say "Repository at the pinned release"
mkdir -p /opt/flerdvision
chown "$RUN_USER:$RUN_USER" /opt/flerdvision
if [ ! -d "$APP_DIR/.git" ]; then
  [ -n "$REPO_URL" ] || die "first install needs --repo <git-url> (a read-only deploy key, see docs/24 section 5)"
  sudo -u "$RUN_USER" git clone --quiet "$REPO_URL" "$APP_DIR"
fi
sudo -u "$RUN_USER" git -C "$APP_DIR" fetch --quiet --all
sudo -u "$RUN_USER" git -C "$APP_DIR" checkout --quiet --detach "$RELEASE_SHA"
ACTUAL_SHA="$(sudo -u "$RUN_USER" git -C "$APP_DIR" rev-parse HEAD)"
ok "checked out $ACTUAL_SHA"

say "Dependencies and the full test suite on exactly this release"
sudo -iu "$RUN_USER" bash -lc "cd $APP_DIR && npm ci --silent" || die "npm ci failed"
sudo -iu "$RUN_USER" bash -lc "cd $APP_DIR && TZ=$TIMEZONE npm test" \
  || die "test suite is red on $ACTUAL_SHA — stop here, keep the evidence, repair per docs/22"
ok "suite green on the pinned release"

# ------------------------------------------------------------ 6. directories
say "Directories"
mkdir -p "$RUNTIME_DIR/runtime" "$RUNTIME_DIR/cache" "$BACKUP_DIR" "$ETC_DIR"
chown -R "$RUN_USER:$RUN_USER" "$RUNTIME_DIR" "$BACKUP_DIR"
chmod 700 "$RUNTIME_DIR" "$RUNTIME_DIR/runtime" "$BACKUP_DIR"
chown "root:$RUN_USER" "$ETC_DIR"
chmod 750 "$ETC_DIR"
ok "runtime, cache, backups, config"

# ------------------------------------------------------- 7. env, release pin
say "Environment and release pin"
if [ ! -f "$ETC_DIR/flerdvision.env" ]; then
  install -o "$RUN_USER" -g "$RUN_USER" -m 600 "$APP_DIR/deploy/flerdvision.env.example" "$ETC_DIR/flerdvision.env"
  todo "fill in $ETC_DIR/flerdvision.env (Google OAuth, Telegram, CHROMIUM_EXECUTABLE_PATH=$CHROME_DIR/current/chrome)"
else
  ok "env file kept as it is"
fi
printf 'FLERDVISION_RELEASE_SHA=%s\n' "$ACTUAL_SHA" > "$ETC_DIR/release.env"
chown "root:$RUN_USER" "$ETC_DIR/release.env"
chmod 640 "$ETC_DIR/release.env"
ok "release pinned to $ACTUAL_SHA"

# The spec carries private deployment facts and is never generated here — but its absence must
# be loud, because every later command reads it.
if [ ! -f "$ETC_DIR/flerdvision.json" ]; then
  todo "create $ETC_DIR/flerdvision.json (mode 600, owner $RUN_USER) with \"runtimeRoot\": \"$RUNTIME_DIR/runtime\" — absolute, the daemon's working directory differs from your shell"
fi

# --------------------------------------------------------- 8. systemd units
say "systemd units"
install -m 644 "$APP_DIR/deploy/flerdvision-xvfb.service" /etc/systemd/system/
install -m 644 "$APP_DIR/deploy/flerdvision-daemon.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now flerdvision-xvfb
ok "Xvfb running; the posting daemon stays disabled until the canary authorization (docs/24 section 12)"

cat <<NEXT

Installed on release $ACTUAL_SHA.

Next, and each of these needs you rather than the installer:
  1. fill $ETC_DIR/flerdvision.env and create $ETC_DIR/flerdvision.json
  2. cd $APP_DIR && npm run flerdvision -- bootstrap
  3. npm run flerdvision -- drive-auth        (over an SSH tunnel, docs/24 section 9.2)
  4. npm run flerdvision -- notify-test       (proves the Telegram channel)
  5. npm run flerdvision -- login --channel <key>   (headful over noVNC, docs/24 section 9.4)
  6. npm run flerdvision -- doctor --release-sha $ACTUAL_SHA
  7. requalify every channel on this release before any real post
NEXT
