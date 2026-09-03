# Neuer Kanal in 5 Schritten

Diese Anleitung richtet sich an jemanden **ohne Chat-Kontext** aus vorherigen Claude-Sessions:
alles, was zum Anlegen von Kanal Nummer 4 (oder 5, 6, …) nötig ist, steht hier. Plattform-Details
(welche Felder ein `reel`/`trial_reel`/`tiktok`/`short`-Block erwartet) stehen in
`docs/25-TIKTOK-CHANNEL-TEMPLATE.md`, `docs/26-YOUTUBE-CHANNEL-TEMPLATE.md` und
`docs/27-INSTAGRAM-CHANNEL-TEMPLATE.md`; diese Anleitung ist der Ablauf drumherum.

Voraussetzung: die kanonische Spec-Datei existiert bereits (`$FLERDVISION_SPEC`, siehe
`docs/23-CLAUDE-REAL-ACCOUNT-ACCEPTANCE.md` §5) und mindestens ein Kanal läuft schon. Neue Kanäle
werden **angehängt**, nicht neu aufgesetzt.

## Die 5 Schritte im Überblick

1. Kanal-Eintrag in der Spec (`$FLERDVISION_SPEC`)
2. `npm run flerdvision -- bootstrap`
3. `npm run flerdvision -- login --channel <key>`
4. `npm run flerdvision -- demo --channel <key>`
5. `npm run flerdvision -- doctor`

Kein Schritt braucht generierte IDs, Selektor-Listen oder SQLite-Bearbeitung von Hand — das
erledigt der Compiler in Schritt 2.

---

## Schritt 1 — Kanal-Eintrag in der Spec

In `$FLERDVISION_SPEC` unter `channels` einen neuen Block anhängen. Beispiel für einen vierten
Kanal, ein zweiter Instagram-Testkanal mit Trial Reels (Feldreferenz: `docs/27`):

```json
{
  "key": "instagram-flerdvision-test",
  "name": "Flerdvision Instagram Test",
  "platform": "instagram",
  "handle": "flerdvision_test",
  "formats": [
    {
      "type": "trial_reel",
      "times": ["17:00"],
      "sourceMatch": ["trial"],
      "captionTemplate": "{filenameText}\n\n[FV:{contentId}]",
      "hashtags": [],
      "verificationMarker": true,
      "requirement": "REQUIRED",
      "settings": { "commentsEnabled": true, "shareToFeed": true, "crosspostFacebook": false }
    }
  ]
}
```

Pflichtfelder pro Format: `type` (plattformabhängig erlaubt, siehe `docs/25`–`27`), `sourceMatch`
(Abschnitt "Drive-Layout und sourceMatch" unten), `requirement` (`REQUIRED` oder `OPTIONAL`) und die passende Caption/Title-Vorlage. `key` muss
über alle Kanäle eindeutig sein — er wird zu `account:<platform>:<key>` und
`browser:<platform>:<key>` (`accountIdForChannel`/`identityIdForChannel` in
`src/application/workspace-spec-compiler.ts`), also zur stabilen Konto- und Browser-Profil-ID.

## Schritt 2 — `npm run flerdvision -- bootstrap`

```bash
npm run flerdvision -- bootstrap --spec "$FLERDVISION_SPEC"
```

Das kompiliert die gesamte Spec neu (alle Kanäle, nicht nur den neuen) und legt Konto, Browser-
Identität, Zeitplan und Copy-Vorlage für den neuen Kanal an. Erfolgsausgabe (Auszug, Feldnamen
exakt wie im Code):

```json
{
  "workspaceId": "flerdvision",
  "ownerEmail": "info@flerdvision.com",
  "topologyVerified": true,
  "sourceWarnings": [],
  "compile": { "lanes": 4, "accounts": 4, "routes": 4, "schedulePolicies": 4, "warnings": [] },
  "next": "login_or_demo"
}
```

`sourceWarnings` (identisch mit `compile.warnings`) ist die erste Fehlerquelle, die ein
Nicht-Techniker selbst lesen kann. Zwei häufige Einträge:

- `"Google Drive is not authenticated yet; ..."` → erst `npm run flerdvision -- drive-auth --spec
  "$FLERDVISION_SPEC"` ausführen, dann bootstrap wiederholen.
- `"<key>/<format>: sourceMatch [<tokens>] matched no discovered folder; using ... instead"` →
  der neue Kanal hat ein `sourceMatch`-Token, das in **keinem** Drive-Ordnernamen vorkommt
  (Tippfehler oder Ordner fehlt noch). Der Kanal läuft trotzdem (Fallback auf eine
  Ähnlichkeits-Vermutung oder das Root-Verzeichnis), aber vermutlich mit dem falschen Ordner —
  siehe Abschnitt "Drive-Layout und sourceMatch" unten, wie der Ordnername korrigiert wird, statt die Warnung zu ignorieren.

## Schritt 3 — `npm run flerdvision -- login --channel <key>`

```bash
npm run flerdvision -- login --spec "$FLERDVISION_SPEC" --channel instagram-flerdvision-test
```

Öffnet einen isolierten Browser für **genau dieses eine** Konto (eigenes Profilverzeichnis, keine
Cookies/Bookmarks von anderen Kanälen). Ein Mensch loggt sich normal ein (inkl. 2FA/Challenge);
Claude/das Skript wartet, ohne den Browser vorher anzufassen, bis die plattformeigene
Session-Cookie existiert (`sessionCookieNames` in `src/application/headless-login.ts`). Zeitfenster
15 Minuten, änderbar mit `--login-timeout <Minuten>`.

Erfolgsausgabe:

```json
{
  "channelKey": "instagram-flerdvision-test",
  "accountId": "account:instagram:instagram-flerdvision-test",
  "identityId": "browser:instagram:instagram-flerdvision-test",
  "observedHandle": "flerdvision_test",
  "checkedAt": "2026-09-03T08:14:02.000Z",
  "profileDirectory": "runtime/.../profiles/instagram/instagram-flerdvision-test"
}
```

Sobald die Session als `HEALTHY` mit bewiesenem Handle erkannt ist, meldet sich der Kanal **von
selbst im Betreiber-Chat** (Telegram, falls `FLERDVISION_TELEGRAM_BOT_TOKEN`/`_CHAT_ID` gesetzt
sind — sonst passiert nichts, kein Fehler):

```text
✅ Flerdvision Instagram Test angemeldet als @flerdvision_test — bereit für die Qualifikation.
```

Das ist der sichtbare Beweis für "die Schritte zeigen sich im Betreiber-Chat" — ohne dass jemand
in ein Terminal oder eine SQLite-Datei schauen muss.

## Schritt 4 — `npm run flerdvision -- demo --channel <key>`

```bash
npm run flerdvision -- demo --spec "$FLERDVISION_SPEC" --channel instagram-flerdvision-test --release-sha "$FLERDVISION_RELEASE_SHA"
```

Führt den kompletten PREPARE_ONLY-Durchlauf für **nur diesen** Kanal aus: Quellscan, Planung,
Surface-Discovery, **drei** echte Prepare-Only-Replays, finaler Button erreicht — **nicht
geklickt**. Erfolgsreport (Stages aus `src/application/headless-demo.ts`):

```text
BOOTSTRAP PASS
LOGIN SKIPPED  (übersprungen, wenn Schritt 3 schon eine kalibrierte Session hinterlassen hat)
INGEST_PLAN PASS
QUALIFY PASS
SCHEDULE PASS
PRIVATE_PUBLISH SKIPPED
success = true
```

Ein `false` bei `success` oder ein `FAIL`-Stage ist **kein** Grund, generierte IDs oder Selektoren
von Hand zu reparieren — siehe Abschnitt "Typische Fehler" unten und `docs/22-ENGINEERING-EXECUTION-PROTOCOL.md`
für den Reparatur-Loop.

## Schritt 5 — `npm run flerdvision -- doctor`

```bash
npm run flerdvision -- doctor --spec "$FLERDVISION_SPEC" --release-sha "$FLERDVISION_RELEASE_SHA"
```

Read-only Statusbericht über **alle** Kanäle, inklusive des neuen. Relevanter Ausschnitt
(`HeadlessDoctorReport` in `src/application/headless-status.ts`):

```json
{
  "overall": "PASS",
  "checks": [
    { "key": "channel:instagram-flerdvision-test", "status": "PASS", "detail": "HEALTHY; 1/1 routes autonomous-ready" }
  ],
  "channels": [
    {
      "channelKey": "instagram-flerdvision-test",
      "latestSessionState": "HEALTHY",
      "routes": [{ "routeId": "route:...", "blockers": [], "readyForAutonomousPublish": true }]
    }
  ]
}
```

`overall: "PASS"` heißt: Node/Chromium/ffprobe vorhanden, Drive verbunden, jeder Kanal
registriert, jede Route ohne `blockers`. Ein Kanal ist **noch nicht** produktionsreif für den
autonomen Betrieb, solange er offene `blockers` hat — Erklärung der häufigsten im Abschnitt "Typische Fehler" unten.

---

## Drive-Layout und `sourceMatch` — wie ein Ordner zu einem Kanal/Format findet

Empfohlenes Layout: **ein Ordner pro Creator/Quelle**, darunter je ein Unterordner pro
Plattform/Format:

```text
Flerdvision (Drive-Root, aus source.root)
├── LordOfLerds/
│   ├── Instagram Reels/
│   ├── TikTok/
│   └── YouTube Shorts/
└── Flerdvision Test/            <- neuer Ordner für Kanal Nr. 4
    └── Trial Reels/
```

Die Discovery (`discoverSourceTopology` in `src/application/source-structure-discovery.ts`)
durchläuft **den gesamten Baum** bis `source.maxDepth` und bewertet **jeden Ordner gegen jede
Kanal/Format-Kombination** mit `scoreNode`. Die Punktevergabe, exakt aus dem Code:

| Kriterium | Punkte | Beispiel |
|---|---|---|
| ein Token aus `format.sourceMatch` kommt im Ordnerpfad vor | **+30** pro Token, markiert den Treffer als `"explicit"` | `sourceMatch: ["trial"]` matcht einen Ordner "Trial Reels" |
| ein Plattform-Token kommt vor (`instagram`/`insta`/`ig`, `tiktok`/`tik`/`tt`, `youtube`/`yt`) | +7 | Ordner "Instagram Reels" |
| ein Format-Token kommt vor (`formatTokens`: `trial_reel`→`trial,test,trialreel,testreel,reel`; `reel`→`reel,reels,instagram`; `tiktok`→`tiktok,video,videos`; `short`→`short,shorts,youtube`) | +10 | Ordner "Trial Reels" für `trial_reel` |
| ein Token aus Kanalname/Handle/`key` kommt vor | +4 | Ordner "Flerdvision Test" für `key: instagram-flerdvision-test` |
| der Ordner enthält direkt Videos (nicht nur in Unterordnern) | +2 | — |
| Tiefe im Baum | **−max(0, Tiefe − 1)** | ein Ordner drei Ebenen tief verliert 2 Punkte gegenüber einem gleich passenden auf Ebene 1 |

Der Ordner mit der höchsten Summe gewinnt (`matchedBy: "explicit"`, wenn ein `sourceMatch`-Token
beigetragen hat). Ohne jeden Treffer (`matchedBy: "semantic"`) rät die Discovery über
Plattform/Format/Name; findet gar kein Ordner irgendeinen Punkt, fällt sie auf das Drive-Root
zurück (`matchedBy: "root_fallback"`) — beides funktioniert technisch, postet aber im Zweifel aus
dem falschen Ordner.

**Deshalb**: für einen neuen Kanal immer ein **eigenes, eindeutiges Wort** im `sourceMatch` UND im
tatsächlichen Ordnernamen verwenden (wie `"trial"` oben) — das allein gibt +30 Punkte und macht
den Treffer robust gegen jede andere Ordnerbenennung im Baum. Seit dieser Slice warnt `bootstrap`
(Schritt 2 oben) explizit mit Kanal- und Format-Namen, wenn das eigene `sourceMatch`-Token in **keinem**
gefundenen Ordner vorkam — das ist der Moment, den Ordnernamen zu korrigieren, nicht die Warnung
zu ignorieren.

## Dateiname = Caption + Hashtags + Sortierung

Jede Datei im Quellordner heißt so, wie sie später gepostet werden soll, plus eine
Sortier-Nummer voran:

```text
01_Testwelle Mi 1830 TikTok #flerdvision #test.mp4
```

`filenameParts` (`src/adapters/publish/workspace-payload-resolver.ts`) trennt das in:

- führendes `NN_` (ein bis drei Ziffern + Unterstrich) → **nur Sortierung**, erscheint nie im Post;
- jedes `#tag` irgendwo im Namen → wandert in `{filenameHashtags}`;
- der Rest → `{filenameText}`, unverändert (Groß-/Kleinschreibung, Bindestriche bleiben so, wie
  die Person sie geschrieben hat).

Details und die volle Tabelle stehen in `docs/25-TIKTOK-CHANNEL-TEMPLATE.md`, "Caption from the
filename" — identisch für jeden Kanal, jede Plattform.

## Typische Fehler

**`route_release_stale`** (in `doctor`-Blockers und beim autonomen Lauf): die Qualifikation
(Schritt 4) wurde auf einem älteren Git-SHA bestanden als dem aktuellen HEAD. Jeder neue Commit
entwertet eine vorher bestandene Qualifikation — das ist Absicht, nicht ein Bug. Fix: Schritt 4
(`demo --channel <key>`) auf dem aktuellen `$FLERDVISION_RELEASE_SHA` wiederholen.

**Upload-Limit-Refusal** (v.a. YouTube): Studio meldet ein erschöpftes Tageslimit nicht als
Fehler, sondern schreibt „Tägliches Upload-Limit erreicht" in den Dialog und sperrt das Formular.
Der Lauf stoppt mit `Platform refused this account: "Tägliches Upload-Limit erreicht"`
(`src/adapters/browser/platform-refusal.ts`) — das ist ein Konto-Zustand, kein UI-Drift, also
**kein** Selektor-Problem und kein automatischer Retry. Fix: 24 Stunden warten oder den Kanal unter
`youtube.com/verify` verifizieren; Qualifikationsläufe danach sparsam wiederholen (jeder Lauf
verbraucht ein Upload).

**`AUTH_REQUIRED`**: die gespeicherte Session gilt nicht mehr als eingeloggt (abgelaufen, nie
erfolgreich gewesen, oder auf ein anderes Konto umgeschaltet). Sichtbar in `doctor`s
`latestSessionState` oder als offener Incident. Fix: Schritt 3 (`login --channel <key>`)
wiederholen — niemals Cookies/Session-Dateien von Hand bearbeiten oder ersetzen.

Keiner dieser drei Fehler ist ein Grund, `legacy:control-center`, `legacy:setup-ui` oder eine der
anderen Legacy-Oberflächen zu verwenden (`CLAUDE.md`, Abschnitt "Current headless product path").
