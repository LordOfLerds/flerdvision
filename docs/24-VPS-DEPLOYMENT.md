# 24 — VPS-Deployment (Hetzner, Ubuntu 24.04)

Status: Anleitung fuer das erste echte VPS-Deployment des headless Produktpfads
(`npm run flerdvision -- <command>`). Jeder Schritt ist als reinpastebarer Befehl formuliert.

Dieses Dokument ersetzt **keine** Freigabe: `docs/23-CLAUDE-REAL-ACCOUNT-ACCEPTANCE.md` bleibt die
kanonische Testprozedur, `AGENTS.md` die bindenden Invarianten. Insbesondere:

- Die Host-Qualifikationsleiter ist Release-SHA-strikt: `LUCA_MAC -> FABIAN_MAC -> VPS_STAGING ->
  VPS_PRODUCTION_READY`. Ein gruener Testlauf auf dem VPS ist kein uebersprungener Leiter-Schritt.
- Die VPS-Installation haelt `ALLOW_FINAL_PUBLISH=false`. `true` ist die explizite, spaetere
  Canary-Autorisierung (Abschnitt 12).
- `--mode production` ist fuer dieses Deployment nicht vorgesehen; der Daemon laeuft
  `--mode canary`.
- Keine Secrets im Repo. Alle privaten Dateien liegen unter `/etc/flerdvision/` mit Mode 600.

Rollenkonvention in den Befehlen:

- `root#` — als root (bzw. `sudo -i`),
- `flerdvision$` — als Betriebs-User `flerdvision` (`sudo -iu flerdvision`),
- `laptop$` — auf dem eigenen Rechner des Operators.

---

## 1. Server bestellen

Anforderungen (aus dem Laufzeitprofil: Chrome + Node + SQLite + Video-Mediacache):

| Punkt | Wert |
| --- | --- |
| Anbieter/Klasse | Hetzner Cloud, **CPX31** (4 vCPU AMD, 8 GB RAM, 160 GB NVMe) oder CX32 (4 vCPU, 8 GB) — ~10–15 €/Monat |
| Region | EU (Falkenstein `fsn1` oder Nuernberg `nbg1`) |
| Image | **Ubuntu 24.04 LTS** |
| Zugriff | Nur SSH-Key (beim Anlegen hinterlegen), kein Passwort-Login |
| Hetzner-Firewall | Eingehend nur `22/tcp` (SSH); alles andere zu. Es wird **kein** weiterer Port oeffentlich exponiert — noVNC/Drive-OAuth laufen ausschliesslich ueber SSH-Tunnel |

Warum 8 GB: ein headful Chrome unter Xvfb + Node-Build + SQLite bleiben damit weit von OOM
entfernt; 4 vCPU beschleunigen `npm test` (voller Suite-Lauf ist Teil jedes Updates).

## 1a. Abkuerzung: Installer statt Handarbeit

Die Abschnitte 2 bis 8 laufen auch als ein idempotenter Befehl. Er macht genau das, was unten
steht, und hoert dort auf, wo ein Mensch gebraucht wird: er traegt keine Secrets ein, schreibt
keine Spec und aktiviert den Posting-Daemon nicht.

```bash
root# bash deploy/install-vps.sh --repo git@github.com:<ORG>/flerdvision-post.git --release <RELEASE_SHA>
root# bash deploy/install-vps.sh --check      # spaeter: bestehenden Host pruefen, aendert nichts
```

Danach weiter bei Abschnitt 7 (Env/Spec ausfuellen) und Abschnitt 9 (Erst-Setup). Wer lieber
Schritt fuer Schritt vorgeht oder etwas nachvollziehen will, liest die Abschnitte unten — sie
bleiben die Referenz, der Installer ist nur ihre Ausfuehrung.

## 2. Grund-Setup: Zeitzone, Updates, User, Firewall

```bash
root# timedatectl set-timezone Europe/Vienna
root# apt-get update && apt-get -y dist-upgrade
```

Betriebs-User anlegen (ohne sudo-Rechte; alles Privilegierte macht root):

```bash
root# adduser --disabled-password --gecos "Flerdvision runtime" flerdvision
```

Host-Firewall (zusaetzlich zur Hetzner-Firewall, doppelter Boden):

```bash
root# apt-get install -y ufw
root# ufw default deny incoming
root# ufw default allow outgoing
root# ufw allow OpenSSH
root# ufw --force enable
```

Unattended Security-Updates fuer das OS (der Browser wird davon **nicht** beruehrt, weil Chrome
for Testing nicht aus apt kommt — Versions-Pinning bleibt intakt):

```bash
root# apt-get install -y unattended-upgrades
root# dpkg-reconfigure -f noninteractive unattended-upgrades
```

## 3. Pakete: Node 22, ffmpeg/ffprobe, sqlite3, Xvfb, noVNC

Node 22 (Repo verlangt `engines.node >= 22`):

```bash
root# curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
root# apt-get install -y nodejs
root# node --version   # muss v22.x sein
```

Werkzeuge und Display-Stack:

```bash
root# apt-get install -y git unzip curl ffmpeg sqlite3 \
    xvfb x11vnc novnc websockify \
    fonts-liberation fonts-noto-color-emoji
```

Hinweise:

- `ffmpeg` liefert `ffprobe` mit; der Code findet `/usr/bin/ffprobe` selbst
  (`src/adapters/media/resolve-ffprobe.ts`), `FFPROBE_EXECUTABLE_PATH` ist nur fuer Sonderpfade.
- `sqlite3` (CLI) braucht `deploy/backup.sh` fuer WAL-sichere `.backup`-Snapshots.

Laufzeit-Bibliotheken fuer Chrome for Testing (Ubuntu 24.04-Paketnamen):

```bash
root# apt-get install -y libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 \
    libcups2t64 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libatspi2.0-0t64 \
    libx11-6 libxcb1 libxext6 libxi6 libxtst6 libglib2.0-0t64 xdg-utils
```

## 4. Chrome for Testing (gepinnt, headful-faehig mit Xvfb)

Bewusst **Chrome for Testing** statt `google-chrome-stable` aus apt: keine automatischen
Browser-Updates, die mitten im Betrieb die Surface driften lassen — die Version wird exakt
gepinnt und nur ueber die Update-Prozedur gewechselt.

```bash
root# CFT_VERSION="$(curl -fsSL https://googlechromelabs.github.io/chrome-for-testing/LATEST_RELEASE_STABLE)"
root# echo "Pinne Chrome for Testing ${CFT_VERSION}"
root# mkdir -p /opt/chrome/versions
root# curl -fsSL -o /tmp/chrome-linux64.zip "https://storage.googleapis.com/chrome-for-testing-public/${CFT_VERSION}/linux64/chrome-linux64.zip"
root# unzip -q /tmp/chrome-linux64.zip -d "/opt/chrome/versions/${CFT_VERSION}"
root# rm /tmp/chrome-linux64.zip
root# ln -sfn "/opt/chrome/versions/${CFT_VERSION}/chrome-linux64" /opt/chrome/current
root# /opt/chrome/current/chrome --version
```

Der Pfad `/opt/chrome/current/chrome` kommt als `CHROMIUM_EXECUTABLE_PATH` in die Env-Datei
(Schritt 7); der Code honoriert diese Variable explizit
(`src/adapters/browser/resolve-chromium.ts`).

**Ubuntu-24.04-Pflichtschritt (AppArmor / User-Namespaces):** Headful startet Chrome **mit**
Sandbox (`--no-sandbox` wird im Code nur im Headless-Zweig gesetzt,
`src/adapters/browser/chromium-cdp.ts::buildChromiumArgs`). Ubuntu 24.04 blockiert unprivilegierte
User-Namespaces fuer Binaries ohne AppArmor-Profil — ohne das folgende Profil crasht der
Login-/Qualifikations-Browser sofort:

```bash
root# cat > /etc/apparmor.d/chrome-for-testing <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile chrome-for-testing /opt/chrome/versions/*/chrome-linux64/chrome flags=(unconfined) {
  userns,
  include if exists <local/chrome-for-testing>
}
EOF
root# apparmor_parser -r /etc/apparmor.d/chrome-for-testing
```

Funktionstest headful unter Xvfb (erst nach Schritt 8 moeglich, dort wiederholt):

```bash
flerdvision$ DISPLAY=:99 /opt/chrome/current/chrome --user-data-dir=/tmp/cft-smoke about:blank & sleep 5; kill %1
```

## 5. Repo deployen (git, Release-SHA-Pinning)

Read-only-Deploy-Key fuer den Server erzeugen und bei GitHub als **Deploy Key ohne
Schreibrecht** hinterlegen:

```bash
root# sudo -u flerdvision ssh-keygen -t ed25519 -N "" -C "flerdvision-vps-deploy" -f /home/flerdvision/.ssh/id_ed25519
root# cat /home/flerdvision/.ssh/id_ed25519.pub   # -> GitHub Repo -> Settings -> Deploy keys (read-only)
```

Klonen nach `/opt/flerdvision/app` und exakte SHA auschecken (`<RELEASE_SHA>` ist die auf der
Leiter zuvor qualifizierte bzw. zu qualifizierende SHA von `rebuild/headless-agentic-v1`):

```bash
root# mkdir -p /opt/flerdvision
root# chown flerdvision:flerdvision /opt/flerdvision
root# sudo -u flerdvision git clone git@github.com:<ORG>/flerdvision-post.git /opt/flerdvision/app
root# sudo -u flerdvision git -C /opt/flerdvision/app checkout --detach <RELEASE_SHA>
```

Abhaengigkeiten und voller Testlauf auf exakt dieser SHA:

```bash
root# sudo -iu flerdvision bash -lc 'cd /opt/flerdvision/app && npm ci && TZ=Europe/Vienna npm test'
```

STOP bei rotem Test — nicht weiter installieren, Evidence sichern, Reparatur laut
`docs/22-ENGINEERING-EXECUTION-PROTOCOL.md`.

## 6. Verzeichnisse

```bash
root# mkdir -p /var/lib/flerdvision/runtime /var/lib/flerdvision/cache /var/backups/flerdvision /etc/flerdvision
root# chown -R flerdvision:flerdvision /var/lib/flerdvision /var/backups/flerdvision
root# chmod 700 /var/lib/flerdvision /var/lib/flerdvision/runtime /var/backups/flerdvision
root# chmod 750 /etc/flerdvision
root# chown root:flerdvision /etc/flerdvision
```

Layout danach (der Code erzwingt Owner-only-Rechte selbst, `src/application/workspaces.ts`):

```text
/opt/flerdvision/app                          # Repo, detached auf gepinnter SHA
/etc/flerdvision/flerdvision.env              # Secrets/Env (600)
/etc/flerdvision/release.env                  # FLERDVISION_RELEASE_SHA (von update-release.sh)
/etc/flerdvision/flerdvision.json             # kanonische Spec (600)
/var/lib/flerdvision/runtime                  # Runtime-Root
  └─ workspaces/<id>/{database,profiles,evidence,media-cache,config,logs}
/var/backups/flerdvision/<timestamp>/         # Backups (700)
```

## 7. Env-Dateien und Spec (`/etc/flerdvision/`, Mode 600)

Env-Datei aus der Vorlage anlegen und ausfuellen — jede Variable darin wird nachweislich vom
Code gelesen (Fundstellen stehen als Kommentar in der Vorlage):

```bash
root# install -o flerdvision -g flerdvision -m 600 /opt/flerdvision/app/deploy/flerdvision.env.example /etc/flerdvision/flerdvision.env
root# nano /etc/flerdvision/flerdvision.env
```

Auszufuellen: `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` (Desktop-App-Client laut
`docs/23` Abschnitt 4), `FLERDVISION_TELEGRAM_BOT_TOKEN`/`FLERDVISION_TELEGRAM_CHAT_ID`,
`FLERDVISION_DAEMON_CHANNEL_ARGS`. `ALLOW_FINAL_PUBLISH` bleibt `false`.

Release-SHA pinnen (spaeter uebernimmt das `deploy/update-release.sh`):

```bash
root# printf 'FLERDVISION_RELEASE_SHA=%s\n' "$(sudo -u flerdvision git -C /opt/flerdvision/app rev-parse HEAD)" > /etc/flerdvision/release.env
root# chown root:flerdvision /etc/flerdvision/release.env && chmod 640 /etc/flerdvision/release.env
```

Kanonische Spec anlegen. **Wichtig:** `workspace.runtimeRoot` muss auf dem VPS **absolut** sein
(`/var/lib/flerdvision/runtime`) — der Code aufloest den Wert relativ zum Prozess-CWD
(`src/application/headless-bootstrap.ts`), und der Daemon laeuft mit anderem CWD als eine
Operator-Shell:

```bash
root# install -o flerdvision -g flerdvision -m 600 /opt/flerdvision/app/config/flerdvision.example.json /etc/flerdvision/flerdvision.json
root# nano /etc/flerdvision/flerdvision.json
```

Dort eintragen: `"runtimeRoot": "/var/lib/flerdvision/runtime"`, echte Drive-Folder-URL, exakte
Handles/Channel-Keys, Posting-Zeiten; `"ownerEmail": "info@flerdvision.com"` bleibt. Die
ausgefuellte Spec enthaelt private Deployment-Fakten und wird nie committet (`docs/23`
Abschnitt 5).

## 8. systemd-Units: Xvfb und Daemon

```bash
root# install -m 644 /opt/flerdvision/app/deploy/flerdvision-xvfb.service /etc/systemd/system/
root# install -m 644 /opt/flerdvision/app/deploy/flerdvision-daemon.service /etc/systemd/system/
root# systemctl daemon-reload
root# systemctl enable --now flerdvision-xvfb
root# systemctl status flerdvision-xvfb --no-pager
```

Warum Xvfb: `login` oeffnet den Browser **immer headful**
(`src/application/headless-login.ts`, `headless: false` — der Mensch muss Passwort/2FA tippen
koennen), und `demo` (PREPARE_ONLY-Qualifikation) laeuft ohne `--headless`-Flag ebenfalls headful
(`src/cli/flerdvision.ts`). Der Daemon selbst laeuft headless und braucht das Display nicht.

Den **Daemon jetzt noch nicht enablen.** `systemctl enable flerdvision-daemon` ist Teil der
Canary-Autorisierung in Abschnitt 12 — vorher verweigert er den Start ohnehin hart, solange
`ALLOW_FINAL_PUBLISH=false` ist (`src/cli/flerdvision.ts::authorizedMode`).

## 9. Erst-Setup am Server (bootstrap → drive-auth → login → doctor → PREPARE_ONLY)

Alle Schritte in einer Operator-Shell als `flerdvision`; die Env wird aus den privaten Dateien
geladen (Muster aus `docs/23` Abschnitt 4):

```bash
root# sudo -iu flerdvision
flerdvision$ cd /opt/flerdvision/app
flerdvision$ set -a; . /etc/flerdvision/flerdvision.env; . /etc/flerdvision/release.env; set +a
flerdvision$ export DISPLAY=:99
flerdvision$ git rev-parse HEAD   # muss FLERDVISION_RELEASE_SHA entsprechen
```

### 9.1 Bootstrap

```bash
flerdvision$ npm run flerdvision -- bootstrap
```

Meldet der Output `next: "drive-auth"`, weiter mit 9.2, sonst direkt zu 9.3.

### 9.2 Drive-Autorisierung (ueber SSH-Tunnel)

`drive-auth` lauscht auf `127.0.0.1:8765` (`FLERDVISION_DRIVE_OAUTH_PORT`); die Google-Anmeldung
macht der Mensch im **lokalen** Browser, der Callback wird zurueckgetunnelt:

```bash
laptop$ ssh -L 8765:127.0.0.1:8765 <operator>@<vps>
```

Im Tunnel-Login dann (die ausgegebene URL am Laptop oeffnen, mit dem Google-Konto anmelden, das
den Drive-Ordner oeffnen kann):

```bash
flerdvision$ npm run flerdvision -- drive-auth --no-open
flerdvision$ npm run flerdvision -- bootstrap   # muss jetzt topologyVerified: true melden
```

### 9.3 Telegram-Kanal beweisen

```bash
flerdvision$ npm run flerdvision -- notify-test
```

Erwartet: `Telegram OK · message_id …` und die Testnachricht im Operator-Chat.

### 9.4 Social-Login (headful, ueber noVNC zusehen)

Zweite SSH-Session: temporaeren Fernbildschirm starten (Abschnitt 10 erklaert das Skript):

```bash
flerdvision$ /opt/flerdvision/app/deploy/novnc-session.sh --minutes 45
```

Tunnel und Browser am Laptop wie vom Skript ausgegeben, dann in der ersten Session:

```bash
flerdvision$ npm run flerdvision -- login --channel instagram-flerdvision --login-timeout 45
```

Der Mensch tippt Login/2FA im noVNC-Fenster; die Erkennung ist automatisch. PASS nur, wenn das
Profil den exakten erwarteten Handle beweist (`docs/23` Abschnitt 7). Danach noVNC-Session mit
Strg-C beenden.

### 9.5 Doctor + PREPARE_ONLY-Qualifikation

```bash
flerdvision$ npm run flerdvision -- doctor
flerdvision$ npm run flerdvision -- demo --channel instagram-flerdvision
```

Erwartetes Demo-Ergebnis (`docs/23` Abschnitt 8): `BOOTSTRAP PASS`, `INGEST_PLAN PASS`,
`QUALIFY PASS`, `SCHEDULE PASS`, `PRIVATE_PUBLISH SKIPPED`, `success = true` — der finale
Share/Publish wird erreicht, aber **nicht** geklickt. Ein Fehlschlag ist keine Erlaubnis fuer
Legacy-UIs; Reparaturweg siehe `docs/23` Abschnitt 9.

Alles Weitere (optionaler one-shot `--private-publish`, Verifikation, Cleanup) laeuft exakt nach
`docs/23` Abschnitte 10–12 und braucht jeweils explizite menschliche Freigaben.

## 10. Re-Login-Konzept bei Session-Verlust

Verhalten: Verliert ein Konto seine Browser-Session, faellt der betroffene Kanal fail-closed aus
der Verarbeitung — `AUTH_REQUIRED`/Challenge/Identitaets-Ambiguitaet wird nie automatisch
„repariert“ (`AGENTS.md`), und Publikations-/Stoerungs-Ergebnisse des Due-Pfads erreichen den
Telegram-Operator-Kanal. Die Profile bleiben am Server; der Operator loggt sich **direkt am
VPS** neu ein — Profile werden nie vom Server wegkopiert.

Ablauf:

```bash
root# sudo -iu flerdvision
flerdvision$ /opt/flerdvision/app/deploy/novnc-session.sh --minutes 45
# -> gibt SSH-Tunnel-Befehl, URL und Einmal-Passwort aus
```

```bash
laptop$ ssh -L 6080:127.0.0.1:6080 <operator>@<vps>
# Browser: http://127.0.0.1:6080/vnc.html?autoconnect=1  + Einmal-Passwort
```

Zweite Server-Shell:

```bash
flerdvision$ cd /opt/flerdvision/app
flerdvision$ set -a; . /etc/flerdvision/flerdvision.env; . /etc/flerdvision/release.env; set +a
flerdvision$ DISPLAY=:99 npm run flerdvision -- login --channel <channel-key> --login-timeout 45
```

Eigenschaften von `deploy/novnc-session.sh`: on-demand, Einmal-Passwort pro Session, bindet nur
an `127.0.0.1` (Zugriff ausschliesslich per SSH-Tunnel), raeumt sich nach Ablauf/Strg-C selbst
weg, dauerhaft laeuft kein VNC. Ein Telegram-Hinweis mit URL ist als Platzhalter im Skript
markiert und bewusst noch nicht implementiert.

## 11. Logs, Log-Rotation, Health-Check, Backup

### 11.1 Logs und Rotation

Der Daemon loggt nach stdout/stderr → journald. Groesse deckeln statt logrotate:

```bash
root# mkdir -p /etc/systemd/journald.conf.d
root# printf '[Journal]\nSystemMaxUse=1G\nMaxRetentionSec=30day\n' > /etc/systemd/journald.conf.d/flerdvision.conf
root# systemctl restart systemd-journald
```

Live mitlesen:

```bash
root# journalctl -u flerdvision-daemon -f
```

Evidence (Screenshots/Reports unter `…/workspaces/<id>/evidence`) waechst mit jedem Lauf; es ist
Beweismaterial und wird **nicht** automatisch rotiert. Bei Plattenknappheit bewusst und manuell
archivieren, nie blind loeschen.

### 11.2 Health-Check

```bash
root# systemctl status flerdvision-xvfb flerdvision-daemon --no-pager
root# sudo -iu flerdvision bash -lc 'cd /opt/flerdvision/app && set -a; . /etc/flerdvision/flerdvision.env; . /etc/flerdvision/release.env; set +a; npm run flerdvision -- doctor'
```

`doctor` liest Workspace-Zustand, Qualifikation und Warnungen fuer die exakte Release-SHA zurueck.
Zusaetzlich meldet der Daemon Publikations-/Stoerungs-Ereignisse ueber den durablen
Notification-Outbox-Pfad an Telegram (Transport ist nie Source of Truth, `AGENTS.md`).

### 11.3 Backup (taeglich, Rotation 14 Tage)

`deploy/backup.sh` sichert je Workspace die SQLite-DB WAL-sicher (`sqlite3 .backup` +
Integrity-Check), `config/` und `profiles/` als Tarball, plus die Workspace-Registry, und loescht
Backups aelter als 14 Tage. **Profile-Backups enthalten eingeloggte Sessions — wie Credentials
behandeln.**

```bash
root# cat > /etc/systemd/system/flerdvision-backup.service <<'EOF'
[Unit]
Description=Flerdvision daily backup (sqlite + config + profiles)

[Service]
Type=oneshot
User=flerdvision
Group=flerdvision
UMask=0077
ExecStart=/opt/flerdvision/app/deploy/backup.sh --runtime-root /var/lib/flerdvision/runtime --backup-root /var/backups/flerdvision --retention-days 14
EOF
root# cat > /etc/systemd/system/flerdvision-backup.timer <<'EOF'
[Unit]
Description=Flerdvision daily backup timer

[Timer]
OnCalendar=*-*-* 04:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
root# systemctl daemon-reload
root# systemctl enable --now flerdvision-backup.timer
root# systemctl start flerdvision-backup.service && ls -la /var/backups/flerdvision/
```

04:30 liegt bewusst ausserhalb der Posting-Zeiten (laufende Browser machen Profil-Tarballs
inkonsistent). Restore-Skizze: Daemon stoppen, DB-Datei nach
`…/workspaces/<id>/database/flerdvision.sqlite` zuruecklegen (WAL/SHM-Dateien vorher entfernen),
`config`/`profiles`-Tarballs an Ort entpacken, Rechte 700/600 pruefen, `doctor` laufen lassen.

## 12. Update-Prozedur (neues Release ⇒ Qualifikationsleiter!)

Ein Release-Update ist **nie** nur `git pull`. `deploy/update-release.sh` erzwingt den sauberen
Pfad: Daemon stoppen → `fetch` → `checkout <SHA>` (detached) → `npm ci` → `npm test` (voller
Suite-Lauf inkl. Build; **Abbruch bei rot**, Daemon bleibt gestoppt) → SHA nach
`/etc/flerdvision/release.env` pinnen.

```bash
root# /opt/flerdvision/app/deploy/update-release.sh --sha <NEUE_RELEASE_SHA>
```

Danach gilt die Leiter, bevor der Daemon wieder laeuft:

1. **PREPARE_ONLY-Qualifikation auf exakt der neuen SHA** (Abschnitt 9.5) — Routen sind pro
   Release/Surface-Contract qualifiziert, eine neue SHA startet unqualifiziert.
2. Falls die Leiter es fuer dieses Release verlangt (z. B. Aenderungen an Publisher/Boundary):
   **private E2E laut `docs/23` Abschnitt 10** mit separater menschlicher one-shot-Freigabe.
3. Erst dann:

```bash
root# systemctl start flerdvision-daemon
```

(oder gleich `update-release.sh --sha <SHA> --restart-daemon`, wenn die Qualifikation fuer diese
SHA bereits erledigt ist).

Chrome-Update ist ein eigener, bewusster Schritt (neue Version nach
`/opt/chrome/versions/<v>` entpacken, Symlink umsetzen, danach ebenfalls PREPARE_ONLY neu
qualifizieren — die Surface kann sich mit dem Browser aendern).

## 13. Canary-Freigabe des Daemons (separat autorisiert)

`run-once`/`daemon` sind durch eine erfolgreiche private E2E **nicht** impliziert (`docs/23`
Abschnitt 13). Erst nach Review der Evidence und expliziter menschlicher Freigabe:

1. In `/etc/flerdvision/flerdvision.env`: `ALLOW_FINAL_PUBLISH=true` setzen (das ist die
   Autorisierung — dokumentieren, wer/wann).
2. Einmaliger Canary von Hand:

```bash
flerdvision$ cd /opt/flerdvision/app
flerdvision$ set -a; . /etc/flerdvision/flerdvision.env; . /etc/flerdvision/release.env; set +a
flerdvision$ npm run flerdvision -- run-once --channel instagram-flerdvision --mode canary --confirm AUTONOMOUS_FINAL_PUBLISH
```

3. Erst wenn dieser eine `run-once` verifiziert erfolgreich war und der kontinuierliche Betrieb
   separat freigegeben ist:

```bash
root# systemctl enable --now flerdvision-daemon
root# journalctl -u flerdvision-daemon -f
```

Grenzen, die bestehen bleiben (`AGENTS.md`, `docs/23`): `--mode production` ist hier verboten;
`PUBLISH_UNCERTAIN` ist ein harter Stopp und wird nie automatisch wiederholt (ein
Daemon-Neustart aendert daran nichts — der Zustand ist durabel in SQLite); Kill-Switches und
Account-Allowlists bleiben aktiv; die Kanal-Allowlist des Daemons steht explizit in
`FLERDVISION_DAEMON_CHANNEL_ARGS`.

## 14. Kurzreferenz: Dateien dieses Deployments

| Datei | Zweck |
| --- | --- |
| `deploy/flerdvision-xvfb.service` | Dauerhaftes virtuelles Display `:99` fuer headful Login/Qualifikation |
| `deploy/flerdvision-daemon.service` | Autonomer Daemon (`--mode canary`), startet nur mit allen drei Freigaben |
| `deploy/flerdvision.env.example` | Vorlage fuer `/etc/flerdvision/flerdvision.env` (jede Variable mit Code-Fundstelle) |
| `deploy/novnc-session.sh` | On-demand x11vnc+noVNC mit Einmal-Passwort, nur via SSH-Tunnel |
| `deploy/backup.sh` | Taegliches WAL-sicheres Backup + 14-Tage-Rotation |
| `deploy/update-release.sh` | Release-Update mit Test-Gate und Leiter-Hinweis |
