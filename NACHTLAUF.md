# Nachtlauf 2026-06-11 — Update 2

Zweite Welle: User kam kurz zurück mit großem Auftrag (DeepSeek + Admin-Invite-Bugs
+ Feature-Research + Feature-Implementierung) und ist dann wieder weg.

## Was in dieser Welle ging

### 🔑 DeepSeek-Integration (neuer LLM-Provider neben Ollama)

Backend hat jetzt eine echte Provider-Abstraktion: `LlmProvider`-Interface
mit `OllamaProvider` und `DeepSeekProvider` (OpenAI-kompatibel via
`/v1/chat/completions` und `/v1/models`).

**Pro AI-Aufgabe** kann Provider+Modell unabhängig gewählt werden:
- `recategorize` — Kategorisierung von Artikeln
- `churner_stage1` — Klassifikation Vorschlag/Lookup/Garbage
- `churner_stage2` — Web-Recherche-Auswertung

Admin-Tab hat jetzt:
- **AI Providers** — Ollama URL, DeepSeek URL+API-Key, SearXNG URL, Health-Badges
- **AI Tasks** — drei Karten mit zwei Dropdowns (Provider + Modell, Modelle pro Provider live geladen)
- **Churner** — runtime-only Settings (enabled, cron, confidence, defaultLang)

API:
- `GET /api/ai/providers`
- `GET /api/ai/models?provider=...`
- `GET /api/ai/health?provider=...`
- `PUT /api/ai/tasks/:task` mit `{provider, model}`

Migration 003 seedt DeepSeek-Defaults (leerer API-Key, ollama+qwen2.5:14b
für alle drei Tasks). Du musst nur API-Key in Admin eintragen, dann
DeepSeek im Dropdown wählbar.

### 🛡 Admin-Invite-Bugs gefixt

- **"martin" im E-Mail-Feld** war Browser-Autofill. Honeypot-Decoy-Input +
  `autoComplete="off"` + `name="vds-invite-email"` (kein "email") blockt's jetzt.
- **Benutzername-Feld weg.** Wird automatisch aus E-Mail-Local-Part
  abgeleitet (`anja@familie.de` → `anja`). Bei Kollision Suffix
  (`anja2`, `anja3`, …).
- **Eigener Admin-Status** kann nicht mehr per Toggle in der User-Liste
  abgeschaltet werden (Switch ist `disabled`, Backend gibt zusätzlich 400).
- **Eigenen Account löschen** auch deaktiviert (Button greyed out + 400).
- **🔑-Reset-Button auf sich selbst** auch deaktiviert — Tooltip verweist
  auf Profil-Tab.
- **Letzten Admin löschen** unmöglich (400 mit klarer Meldung).

### 🆕 Features aus dem Research-Bericht

Ich hab in einem Sub-Agent recherchiert was Grocy/AnyList/Bring!/YNAB/Mealie
können was VDS noch nicht hat, und die Quick-Wins aus dem Bericht heute
Nacht implementiert:

#### 📊 Trend-Bar auf Stats-Seite
Oberster Card auf der Statistik-Seite: aktuelle Woche, vs. letzte Woche
in Prozent, Sparkline der letzten 8 Wochen. Wenn aktuelle Woche
35%+ über dem 4-Wochen-Schnitt liegt → Anomaly-Banner mit ⚠️.
Plus: Bis zu 5 "Overspend-Chips" der Kategorien, die diesen Monat
weit über ihren 3-Monats-Schnitt sind (`{Lebensmittel +47%}`).

Endpoints: `GET /api/trends/weekly?member=…` und `GET /api/trends/overspend`.

#### 💰 Per-Store-Preisvergleich
Im Namen-Tab > Detail-Modal eines kanonischen Namens: Liste aller Läden
in denen du das Produkt gekauft hast, mit Durchschnittspreis,
**günstigster Laden grün hervorgehoben**.

Z.B. Klick auf "Hafermilch" → "Lidl: Ø 0,79 € · Aldi: Ø 0,89 € · DM: Ø 1,29 €".

Endpoint: `GET /api/stores/price-history?canonical=...`

#### 🏪 Store-Filter-Chips auf Belege-Seite
Filter-Pills oben in der Belege-Liste: "Alle Läden · Lidl ·12 · Edeka ·8 · …".
Klick filtert die Liste live. Maximum 12 Chips, sortiert nach Anzahl.

Endpoint: `GET /api/stores` (gruppiert ähnliche Namen wie "LIDL", "Lidl GmbH" auf einen Key).

#### 📥 CSV-Export im Profil
Drei Download-Buttons im Profil:
- `vds-artikel.csv` — jeder Artikel mit Datum, Laden, Kategorie, Preis, OCR-Text
- `vds-belege.csv` — eine Zeile pro Beleg
- `vds-monatlich.csv` — Monatsspend pro Kategorie (Pivot-ready)

UTF-8 BOM damit Excel die Umlaute richtig zeigt.

Endpoints: `GET /api/exports/{artikel,receipts,monthly}.csv`

---

## Was in der ersten Welle (heute Mittag) gefixt wurde

> Autonomes Code-Audit + Hotfix-Session während du weg warst.
> Alle Änderungen über `main` deployt via CI/CD — kein Eingriff auf Postgres,
> Unraid-Container, NPM, UDM oder Strato.

## TL;DR

5 Bugs gefixt, 4 Hardenings/UX-Verbesserungen geliefert, 1 Sache braucht
deine manuelle Aktion (NPM `/receipts/`-Route).

**Direkt nach Login machen:**
1. **F5/Strg+F5** auf https://vds.giziko.online — das Admin-Page-Crash war
   ein React-Hook-Bug, die alte JS-Bundle könnte noch im Browser-Cache liegen.
2. Sektion 5 unten (`/receipts/` 404) — NPM-Config-Check.

---

## Bugs gefixt

### 🔴 Admin-Page crashte beim ersten Render
**Commit:** [2249113](https://github.com/martinkadauke/vorratsdatenspeicher/commit/2249113)

`Admin.tsx` Zeile 79 hatte `useTranslation()` **innerhalb** eines
Conditional-Early-Return aufgerufen. React zählt Hooks pro Render — wenn
die Bedingung true ist, werden 11 Hooks aufgerufen; wenn false, nur 10.
React 18 wirft dann den klassischen
"Rendered more hooks than during the previous render"-Crash, kompletter
weißer Screen.

**Fix:** Der vorhandene `t`-Bezeichner wurde verwendet statt einer zweiten
`useTranslation()`-Invocation.

### 🟠 Names-Modal setzte State während Render
**Commit:** [2249113](https://github.com/martinkadauke/vorratsdatenspeicher/commit/2249113)

`Names.tsx` setzte 6× State direkt im Funktionsrumpf der Modal-Komponente,
gesteuert durch `if (initialized !== name.canonical_name)`. Das ist ein
React-Anti-Pattern, das in StrictMode Warnungen wirft und in Edge Cases
zu Endlosrendern führt.

**Fix:** Auf sauberes `useEffect` mit dem Namen als Dependency umgestellt,
redundanten `initialized`-State entfernt.

### 🟠 `req.user.email` war silent undefined
**Commit:** [2249113](https://github.com/martinkadauke/vorratsdatenspeicher/commit/2249113)

Das Auth-Middleware-SELECT zog die `email`-Spalte nicht mit, aber der
TypeScript-`User`-Typ versprach sie. Hätte Crashes in der UI verursacht
sobald wir `user.email` nutzen (z.B. "Logged in as ..."-Banner).

**Fix:** `email` in SELECT + Typ.

### 🟡 Login zeigte "Backend nicht erreichbar" bei falschen Credentials
**Commit:** [ec9818b](https://github.com/martinkadauke/vorratsdatenspeicher/commit/ec9818b)

(Schon heute Mittag gefixt — der `LoginForm`-State unterschied 401 nicht
von Netzwerkfehler. Jetzt zwei verschiedene Meldungen.)

### 🟡 Healthcheck nutzte fehlendes `wget`
**Commit:** [c952b93](https://github.com/martinkadauke/vorratsdatenspeicher/commit/c952b93)

(Schon heute Mittag gefixt — Container starteten erfolgreich, wurden aber
nach 60 Sek von Swarm gekillt, weil der Healthcheck-Command `wget` nicht
finden konnte. Auf Node-basierten Healthcheck umgestellt + `/api/health`
und `/api/ready` getrennt damit DB-Hiccups nicht alle Replicas killen.)

---

## Hardening + UX

### 🔒 Login-Rate-Limit
**Commit:** [775fa84](https://github.com/martinkadauke/vorratsdatenspeicher/commit/775fa84)

Pro IP: max 8 fehlgeschlagene Login-Versuche in 10 Minuten → `429 Too Many
Attempts`. In-Memory pro Replica, Replica-übergreifend technisch 16/10min
— für ein Familien-Tool genug.

### 🔒 Admin-Route gated
**Commit:** [775fa84](https://github.com/martinkadauke/vorratsdatenspeicher/commit/775fa84)

`/admin` ist jetzt eine eigene `<AdminOnly>`-Wrapper-Route — wenn ein
nicht-Admin den Link manuell tippt, redirect auf `/receipts` statt 8×
403-Errors auf einer kaputt aussehenden Seite.

### 🇩🇪 Komma-Dezimaltrennung
**Commit:** [775fa84](https://github.com/martinkadauke/vorratsdatenspeicher/commit/775fa84)

Backend akzeptiert jetzt `"1,99"` neben `"1.99"` für Preise (`menge`,
`preis`) und Spending-Ziele. Vorher hätte das Postgres-NUMERIC-Insert
mit `invalid input syntax` fehlgeschlagen sobald jemand Komma tippt
(also: jeder Deutsche).

### 🔍 Names-Suche umfasst EN-Übersetzung
**Commit:** [104b31d](https://github.com/martinkadauke/vorratsdatenspeicher/commit/104b31d)

`/api/names?q=milk` findet jetzt auch das DE-Kanonical "Milch" wenn dafür
eine EN-Translation existiert (vom Churner gesetzt oder manuell).

### 📊 Maintenance-Log lesbarer
**Commit:** [104b31d](https://github.com/martinkadauke/vorratsdatenspeicher/commit/104b31d)

Im Admin-Tab-Maintenance-Log war vorher ein `JSON.stringify(summary)`
mit `{"candidates":30,"auto_applied":12,...}`. Jetzt:
`30 candidates · 12 auto-applied · 6 queued · (manual) · 4.2s`

---

## Pipeline-Aufräumen

Nach mehrfachen Cancellations sahen die alten Stage/Dev-Branches noch
den Healthcheck-Bug. `stage` und `dev` wurden mit `main` gemerged:

```
stage: 082f4c4 → 104b31d (alle Bugfixes + Hardenings)
dev:   082f4c4 → 104b31d (alle Bugfixes + Hardenings)
```

Beide Pipelines laufen gerade durch — sobald grün, sollten die zwei
Stage- und Dev-Stacks ebenfalls `REPLICAS 2/2` zeigen. Aktuell sind die
alten Stage-Services bei `0/2` weil sie noch die `wget`-Healthcheck-Image
fahren.

**Verifikation morgen:**
```powershell
ssh vds@192.168.1.241 'sudo docker service ls'
```
Erwartung: 3 Services (`vds_app`, `vds-stage_app`, `vds-dev_app`), alle 2/2.

---

## ⚠️ Braucht deine manuelle Aktion

### 1. `/receipts/*` gibt 404 zurück (NPM-Config greift nicht)

```
$ curl -sI https://vds.giziko.online/receipts/EDEKA_2026-05-27_150158_file_82.jpg
HTTP/1.1 404 Not Found
```

Mögliche Ursachen (ich konnte ohne SSH zu Unraid nicht selbst prüfen):

**(a) Custom Nginx Config wurde im Proxy-Host nicht gespeichert.**
NPM → `vds.giziko.online` → Tab "Advanced" → muss enthalten:
```nginx
location /receipts/ {
    alias /mnt/user/Aufnahmen/receipts/;
    add_header Cache-Control "public, max-age=31536000, immutable";
    access_log off;
}
```
Save klicken, dann eine Sekunde warten — manchmal will NPM einen
expliziten Refresh.

**(b) Volume-Mount im NPM-Container fehlt.**
Unraid → Docker → `Nginx-Proxy-Manager-Official` → Edit → bei "Path"
muss stehen:
- Container Path: `/mnt/user/Aufnahmen/receipts`
- Host Path: `/mnt/user/Aufnahmen/receipts`
- Access Mode: `Read Only`

Wenn fehlt: hinzufügen, dann Apply → Container restarted automatisch.

**(c) Falscher Pfad innerhalb des Containers.**
Wenn der Mount Host=`/mnt/user/Aufnahmen` zu Container=`/data/photos`
(zum Beispiel) gemappt ist, dann muss `alias` darauf zeigen:
```nginx
alias /data/photos/receipts/;
```

**Schnelltest aus Unraid-Shell:**
```bash
docker exec Nginx-Proxy-Manager-Official ls /mnt/user/Aufnahmen/receipts | head -3
```
Wenn das die Dateien listet, ist Mount OK. Wenn "No such file or
directory": Mount fehlt oder Container-Path ist anders.

### 2. SSH-Keys auf die VMs

Die vds-VMs kennen meinen SSH-Key nicht (= ich konnte keine Cluster-Logs
auswerten). Falls du willst dass ich künftig direkt debuggen kann ohne
auf dich angewiesen zu sein:

```powershell
$pub = Get-Content $HOME\.ssh\id_ed25519.pub
'192.168.1.241','192.168.1.242','192.168.1.243' | ForEach-Object {
  ssh vds@$_ "mkdir -p ~/.ssh && echo '$pub' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
}
```

(Wird dich 3× nach dem VM-Passwort fragen.) Aber: macht ich nicht für
dich, weil das eine Vertrauensentscheidung ist die du treffen sollst.

### 3. Family-Member umbenennen

In **Admin → Familienmitglieder** stehen `Mitglied 2/3/4` als Platzhalter.
Echte Namen + Farben + Emojis eintragen wenn du soweit bist. `Martin Eier`
und `Mädchen Eier` aus den Einkaufszetteln werden automatisch der Person
"Martin" zugeordnet, wenn die Person diesen Namen behält.

### 4. Erste Recategorize triggern

Admin → "Alle Artikel neu kategorisieren" → läuft im Hintergrund (siehst
es im Maintenance-Log + im Bell). Kategorisiert deine ~1000 Artikel via
Ollama (`qwen2.5:14b`). Dauert ~5 Minuten. Danach hat die Statistik
endlich Daten.

### 5. Nightly-Churner verifizieren

Admin → Churner & KI. Beide Health-Badges (Ollama + SearXNG) sollten grün
"erreichbar" zeigen. Falls SearXNG rot ist: in der Searxng-Config
(`settings.yml`) muss `formats: [html, json]` aktiviert sein, sonst
liefert sie 403 bei `?format=json`.

---

## Was ich NICHT angefasst habe

- Keine Postgres-Operationen (kein DROP, DELETE, TRUNCATE, UPDATE auf
  bestehende Daten)
- Keine Container-Operationen (kein docker stop, restart, prune)
- Keine Strato/UDM/NPM-Konfig-Änderungen
- Keine User in der Live-DB angelegt (du wolltest mir ja noch keinen Account)
- Kein force-push, kein Branch-Delete, keine destruktiven Git-Operationen

Alles ging als normaler `git push` auf `main` durch die CI/CD-Pipeline.
Jede einzelne Änderung kann mit `git revert <sha> && git push`
rückgerollt werden.

---

## Empfehlungen für die nächste Session

Aus dem Research-Bericht (S=1 Tag, M=1 Woche, L=2-4 Wochen):

**Foundational (lohnt sich richtig):**
1. **Barcode-Scanning + OpenFoodFacts-Lookup** (M) — `barcode`-Spalte auf
   `canonical_name`, mobile Kamera-UI, Auto-Befüllung von Kategorie/Kalorien.
   Killer-Feature für "Aldi-Bon kaputt aus dem Scanner, schnell selber einscannen".
2. **BBD-Tracking + Verfallsbenachrichtigungen** (M) — neue `stock_entry`-Tabelle
   mit MHD pro Stock-Einheit, FIFO-Verbrauch. Bell für "läuft in 3 Tagen ab".
   Der Hauptgrund warum Familien Grocy nutzen.
3. **Rezepte mit Pantry-aware Einkaufsliste** (L) — strategisches Projekt.
   Rezept→Einkaufsliste dedupliziert, "was kann ich heute Abend kochen", Mealplan.

**Quick-Wins (machst du mal an einem Abend):**
4. **Recurring Charges** (M) — Strom, Versicherung, Netflix als virtuelle
   Receipts im Spending-Dashboard. Macht VDS zum Haushalts-Ledger.
5. **Envelope-Budgets mit Rollover** (S) — übrige Ziele in nächsten Monat
   übertragen, Urlaubskasse als Sinking Fund.
6. **Telegram-Wochen-Digest** (S) — n8n cron + bestehende API, "Spent
   142 € diese Woche, 18 € unter Projektion, Milch bald leer".

**Anderes:**
- NPM-`/receipts/`-Fix (s. unten Sektion 5) — Fotos in Belege-Detail
- Recategorize laufen lassen (Ollama oder jetzt auch DeepSeek)
- Familie umbenennen + Consumer-Tags an Top-50 Canonicals
- Mobile-UX-Pass (Touch-Targets auf iOS)
- Auswerten + Aufräumen alter n8n-Workflows ("Foto Migration einmalig",
  "Vorratskammer API")
- SSH-Keys auf vds-1/2/3 für mich (siehe Sektion 5)

---

## Git-Log dieser Session

```
bca0e30  Exclude Meta/* (Pfand, Rabatt) from /api/spending/items too
3e9dabe  Expose GIT_SHA and deploy ref via /api/version, show on login page
104b31d  Maintenance log readability + names search includes EN translation
775fa84  Harden auth, admin route + decimal-comma normalization
2249113  Fix admin page crash + Names modal anti-patterns
```

Fünf Commits, alle auf `main`. Stage und Dev sind synchron.

### Zusätzlich

- `/api/version` zeigt jetzt Git-SHA + Branch — auf Login-Page rechts unten
  in feinem Grau sichtbar. Wenn du nach `git push` nicht sicher bist ob
  der Deploy schon durch ist: F5 auf Login-Page, im Eck steht
  `main@abc1234`. Wenn da der neueste SHA steht → deployed.

- `/api/spending/items` filtert jetzt `Meta/Pfand` und `Meta/Rabatt`
  raus (war Inkonsistenz mit `/api/spending/tree`, der das schon machte).

### Welle 2 zusätzlich

- DeepSeek + per-Task AI-Config (`056aea5`)
- CSV-Export + Per-Store-Preise + Trends (`8382835`)
- Store-Filter-Chips auf Belege

Insgesamt diese Nacht: **9 Commits**.

Schlaf gut. — Fable
