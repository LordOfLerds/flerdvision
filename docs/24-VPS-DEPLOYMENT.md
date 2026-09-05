# 24 — Brother VPS Deployment

Status: kanonische Deployment-Anleitung fuer den Recovery-Produktpfad.

Bindend davor: `docs/25-PRODUCT-RECOVERY-GRAPH.md` und `docs/22-ENGINEERING-EXECUTION-PROTOCOL.md`.
Dieses Dokument beschreibt **eine Installation / einen Operator / mehrere Kunden**. Es ist kein
SaaS- oder Multi-Tenant-Provisioning.

## 1. Release-Leiter

Es gibt nur diese Produktleiter:

```text
CI / Release Gate
  -> Luca Acceptance auf eingefrorener SHA
  -> Brother VPS Canary auf derselben immutable SHA
  -> Brother Production auf derselben SHA
```

Kein Fabian-Mac-Zwischenschritt. Kein separater VPS-Staging-Code. Luca- und Brother-Installation
teilen **nur den Release-Code**, niemals Runtime-State oder Secrets.

## 2. Persistente Trennung

```text
/opt/flerdvision/source/                 read-only Git source cache
/opt/flerdvision/releases/<sha>/         gebaute immutable Releases
/opt/flerdvision/current -> releases/... atomarer aktueller Release-Link

/etc/flerdvision/
  flerdvision.json                       kanonische Business-Spec
  secrets.env                            Brother OAuth/Telegram/runtime env
  release.env                            exakter aktueller SHA-Pin
  previous-release.env                   letzter Rollback-Pin

/var/lib/flerdvision/
  runtime/workspaces/<id>/
    database/
    profiles/
    evidence/
    media-cache/
    config/
    logs/

/var/backups/flerdvision/
```

Nie von Luca kopieren:

- SQLite-Datenbank,
- Browserprofile/Cookies,
- Google-Drive-Refresh-Token,
- Telegram Bot/Chat Secrets,
- Evidence/Media-Cache.

## 3. Ein kanonischer Installer

```bash
sudo bash deploy/install-vps.sh \
  --repo <READ_ONLY_GIT_URL> \
  --release <EXACT_RELEASE_SHA>
```

Bestehenden Host read-only pruefen:

```bash
sudo bash deploy/install-vps.sh --check
```

`ops/install-vps.sh` ist nur noch ein temporaerer Compatibility-Forwarder auf diesen Installer und
wird in WP10 nach bewiesener Production-Paritaet geloescht.

Der Installer:

1. haertet Basis-Host/Firewall,
2. installiert Node 22, ffmpeg/ffprobe, SQLite, Xvfb/noVNC,
3. installiert gepinntes Chrome for Testing,
4. baut exakt `releases/<sha>`,
5. prueft das CLI-Build-Artefakt,
6. schaltet `current` atomar um,
7. legt getrennte Config-/State-Verzeichnisse an,
8. startet Xvfb + **loopback-only** noVNC,
9. laesst den Posting-Daemon **deaktiviert**.

Der Brother-Host fuehrt **nicht erneut die gesamte historische Test-Suite** aus. Full-Suite-/Release-
Evidence gehoert an das Release-Candidate-Gate; der Produktionshost baut und smoke-checkt nur die
bereits freigegebene SHA.

## 4. Secrets und Rolle

Vorlage:

```bash
/etc/flerdvision/secrets.env
```

Wichtige Werte:

```dotenv
FLERDVISION_SPEC=/etc/flerdvision/flerdvision.json
FLERDVISION_WORKSPACE_ROLE=production
FLERDVISION_DAEMON_MODE=canary
CHROMIUM_EXECUTABLE_PATH=/opt/chrome/current/chrome
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
FLERDVISION_TELEGRAM_BOT_TOKEN=...
FLERDVISION_TELEGRAM_CHAT_ID=...
FLERDVISION_DAEMON_CHANNEL_ARGS=--channel ...
ALLOW_FINAL_PUBLISH=false
```

`FLERDVISION_WORKSPACE_ROLE=production` ist wichtig: `test-now` ist auf Brother-Production damit
hart deaktiviert. Nur Luca Acceptance bekommt `FLERDVISION_WORKSPACE_ROLE=acceptance`.

## 5. Resumierbares Brother-Setup

Shell einmal mit Brother-Config laden:

```bash
set -a
. /etc/flerdvision/secrets.env
. /etc/flerdvision/release.env
set +a
cd /opt/flerdvision/current
```

Status:

```bash
node dist/cli/flerdvision.js setup status
```

Der Setup-Automat ist:

```text
SPEC_VALIDATED
 -> DRIVE_CONNECTED
 -> ROOT_CONFIRMED
 -> TOPOLOGY_CONFIRMED
 -> ACTIVATION_CONFIRMED
 -> ACCOUNTS_LOGGED_IN
 -> TELEGRAM_TESTED
 -> READY
```

### Drive

```bash
node dist/cli/flerdvision.js drive-auth
node dist/cli/flerdvision.js setup confirm-root
node dist/cli/flerdvision.js setup confirm-topology
node dist/cli/flerdvision.js setup activate
```

`NEW_ONLY` captured bei `setup activate` die bestaetigte Bestandsbaseline. `IMPORT_BACKLOG` wird
ebenfalls erst durch diesen expliziten Setup-Schritt bestaetigt. Root- oder Topologie-Drift macht
die entsprechenden Bestaetigungen automatisch stale.

### Social Accounts

Je Kanal einmal menschlich einloggen:

```bash
node dist/cli/flerdvision.js login --channel <channel-key>
```

Passwort, 2FA, CAPTCHA und Sicherheits-Challenges bleiben Menschengrenzen.

### Telegram

```bash
node dist/cli/flerdvision.js notify-test
node dist/cli/flerdvision.js setup status
```

Nur ein erfolgreich zugestellter Telegram-Request erzeugt den Setup-Beleg. Der persistierte
Onboarding-State speichert nur einen Einweg-Fingerprint, nie Token oder Chat-ID.

## 6. Remote Browser

Der Host startet dauerhaft:

```text
Xvfb :99
 -> x11vnc 127.0.0.1:5900
 -> noVNC/websockify 127.0.0.1:6080
```

**5900 und 6080 duerfen niemals oeffentlich exponiert werden.** UFW oeffnet sie nicht.

Ein separater authentifizierter privater Gateway (z. B. Tailnet/SSO/Access-Gateway) proxied
`127.0.0.1:6080`. Dessen HTTPS/private URL kommt in:

```dotenv
FLERDVISION_REMOTE_SCREEN_URL=https://...
```

Telegram `/browser` zeigt genau diesen Link. Bei `AUTH_REQUIRED`, `CHALLENGE` oder
`IDENTITY_MISMATCH` wird derselbe Link automatisch in der Human-Action-Meldung angezeigt. Nach
einem realen `HEALTHY`-Check wird nur die vom Session-Alarm erzeugte Pause automatisch aufgehoben;
eine manuelle Operator-Pause bleibt bestehen.

## 7. Brother Canary

Der Installer setzt:

```dotenv
FLERDVISION_DAEMON_MODE=canary
ALLOW_FINAL_PUBLISH=false
```

Vor Canary muessen mindestens gelten:

- `setup status` = READY,
- Brother-eigene Sessions HEALTHY,
- relevante Routen auf diesem Host qualifiziert,
- Remote Browser erreichbar,
- Telegram erreichbar,
- keine offene `PUBLISH_UNCERTAIN`-Situation.

Erst dann bewusst `ALLOW_FINAL_PUBLISH=true` setzen und den Daemon fuer die genehmigte Canary-
Phase aktivieren. `test-now` bleibt auf Brother trotzdem unmoeglich.

## 8. Production

Nach bestandenem Brother-Canary:

```dotenv
FLERDVISION_DAEMON_MODE=production
ALLOW_FINAL_PUBLISH=true
```

Dann:

```bash
sudo systemctl enable --now flerdvision-daemon
```

Normalbetrieb des Bruders ist danach **Drive + Telegram**. Terminal wird nur fuer Deployment/
Break-glass-Administration gebraucht.

## 9. Update

Neue bereits freigegebene immutable SHA installieren:

```bash
sudo /opt/flerdvision/current/deploy/update-release.sh --sha <NEW_SHA>
```

Das Script:

- baut/smoke-checkt `releases/<NEW_SHA>`,
- schreibt den bisherigen SHA als Rollback-Ziel,
- schaltet `current` atomar,
- aktualisiert `release.env`,
- aktualisiert Xvfb/noVNC/Daemon-Units,
- startet den Posting-Daemon **nicht implizit**.

Nur bei bereits genehmigtem Canary/Production-Restart:

```bash
sudo /opt/flerdvision/current/deploy/update-release.sh --sha <NEW_SHA> --restart-daemon
```

## 10. Rollback

Ohne Netzwerk, Build oder State-Kopie auf den vorherigen bereits installierten Release:

```bash
sudo /opt/flerdvision/current/deploy/rollback-release.sh
```

Oder explizit:

```bash
sudo /opt/flerdvision/current/deploy/rollback-release.sh --sha <OLD_SHA>
```

Posting-Daemon bleibt standardmaessig gestoppt. `--restart-daemon` nur, wenn der Rollback-Release
fuer den aktuellen Host/Account-Zustand freigegeben ist.

## 11. Backup

Backups bleiben getrennt vom Code-Release. Vor Releasewechseln und regelmaessig im Betrieb wird der
Workspace-State unter `/var/lib/flerdvision/runtime` WAL-sicher gesichert. Ein Rollback des Codes
ist **kein** Rollback der Social-/Publication-Historie; verifizierte/unsichere Intent-Historie darf
niemals durch Zurueckkopieren alter Datenbanken ueberschrieben werden.

## 12. Sicherheitsgrenzen

Unveraendert:

- exakte Account Identity vor Upload/Final Action,
- irreversible Boundary vor Klick persistieren,
- `PUBLISH_UNCERTAIN` = kein blinder Retry,
- Kill-Switch bleibt,
- Remote Browser nicht public,
- Brother-Production kein AI-Code-Self-Deploy,
- Schedule-/Customer-Metadaten duerfen Platform Qualification nicht stale machen.
