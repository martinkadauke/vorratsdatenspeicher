# Design: automatische Sicherungen und Wiederherstellung

**Status: Entwurf, nicht gebaut.** Idee von Martin, 2026-08-08.

## Ziel

Wer seine Installation zerschießt, soll zurückkönnen. Täglich automatisch, ohne daran zu denken,
im Verwaltungsbereich einzuschalten. Ziele: **Google Drive, Dropbox, externe Festplatte** — und ein
**Import**, der aus so einer Sicherung wieder eine laufende Installation macht.

## Was es schon gibt

`backend/src/routes/backup.ts` kann bereits das Wesentliche: `GET /api/backup/download` erzeugt ein
`.tar.gz` aus einem `pg_dump` (**database.sql**) plus dem **kompletten Belegordner**. Ausgelöst wird
es über einen signierten Einmal-Link (`/api/backup/prepare`). Das ist die halbe Miete — es fehlen
**Zeitplan**, **Ziel** und **Rückweg**.

⚠️ `pg_dump` muss im Desktop-Build vorhanden sein. `embedded-postgres` bringt es mit (gleicher
`bin/`-Ordner wie `initdb`), aber der Pfad ist ein anderer als im Container — vor dem Bauen prüfen.

## Die wichtigste Entscheidung: kein OAuth

Der naheliegende Weg wäre, Google Drive und Dropbox per API anzubinden. **Dagegen spricht viel:**

- Es bräuchte einen **OAuth-Client, den Martin registriert** — also eine Entwickler-Identität im
  Datenpfad jedes Nutzers. Genau das wollte er nie („ich will als Developer nichts mit den
  Instanzen der User zu tun haben").
- Googles Überprüfung für Drive-Zugriff ist ein echtes Verfahren, kein Häkchen.
- Und wir wissen seit dem Tunnel-Abend: **Google verweigert Anmeldungen in eingebetteten Fenstern.**
  Jeder OAuth-Fluss müsste ohnehin durch den Systembrowser.

**Der elegante Weg für eine Desktop-App: ein Ordner.** Drive, Dropbox, OneDrive und Nextcloud haben
alle einen Client, der einen lokalen Ordner synchronisiert. VDS legt seine Sicherung dort ab — den
Rest macht der Dienst, den der Nutzer sowieso schon eingerichtet hat.

> **Ein Ordnerpfad deckt alle drei Wünsche ab.** `…/Google Drive/VDS-Backups`,
> `…/Dropbox/VDS-Backups` oder `E:\VDS-Backups` auf der externen Platte — dieselbe Funktion,
> kein Konto, kein Token, kein Entwickler dazwischen. Und es funktioniert mit Anbietern, an die
> wir nie gedacht haben.

Im Verwaltungsbereich also: **„Ordner wählen"** plus drei Verknüpfungen, die die üblichen Pfade
vorschlagen, wenn sie existieren. Eine echte API-Anbindung bleibt später möglich, falls jemand sie
wirklich will — sie ist dann eine Erweiterung, keine Voraussetzung.

## Verschlüsselung — nicht optional

Eine Sicherung enthält **das gesamte Belegarchiv des Haushalts**. Sie unverschlüsselt in eine Cloud
zu legen, widerspricht allem, wofür VDS steht („deine Daten bleiben bei dir").

- Die Sicherung wird **vor dem Schreiben verschlüsselt** (AES-256-GCM, Schlüssel aus einer
  Passphrase via scrypt/argon2).
- Beim Einschalten zeigt VDS **einmalig einen Wiederherstellungsschlüssel** und verlangt, dass der
  Nutzer bestätigt, ihn gesichert zu haben. Ohne ihn ist die Sicherung wertlos — das muss brutal
  klar dastehen, an genau dieser Stelle und nicht im Hilfetext.
- ⚠️ Der Schlüssel darf **nicht** in derselben Datenbank liegen, die gesichert wird. Sonst rettet
  die Sicherung genau die Installation, deren Verlust sie abfedern soll.

Für „externe Festplatte" könnte man Verschlüsselung optional machen — aber zwei Wege bedeuten zwei
Fehlerquellen und eine Frage an den Nutzer, die er nicht beantworten kann. Lieber immer.

## Zeitplan und Aufbewahrung

- **Täglich**, mit den vorhandenen Cron-Mechanismen (`maintenance/*`, wie Churner und Reminders).
- ⚠️ Der Desktop läuft nicht durch. Also **nicht** „täglich um 3 Uhr", sondern *„beim Start, wenn
  die letzte Sicherung älter als 24 Stunden ist"* — plus ein Lauf beim Beenden, wenn seither viel
  passiert ist.
- **Aufbewahrung:** die letzten 7 täglichen, 4 wöchentlichen, 3 monatlichen. Sonst läuft eine
  Cloud-Ablage in wenigen Monaten voll und der Nutzer schaltet entnervt ab.
- **Nur bei Änderungen** sichern: gab es seit der letzten Sicherung keinen neuen Beleg, entfällt
  der Lauf. Spart Platz und Bandbreite.

## Der Rückweg — die schwierigere Hälfte

Sichern ist einfach, Zurückholen nicht. Das ist der Teil, an dem solche Funktionen scheitern.

1. **Wiederherstellung beim Start**, nicht im laufenden Betrieb. Eine Datenbank, die gerade benutzt
   wird, kann man nicht unter sich austauschen. Die Shell bekommt eine Auswahl **vor** dem Öffnen
   des Fensters: „Sicherung wiederherstellen?"
2. **Versionsprüfung.** Eine Sicherung aus 0.24 in eine 0.31 zurückzuspielen heißt: Dump einspielen,
   **dann Migrationen laufen lassen**. Umgekehrt (neuere Sicherung in ältere App) muss VDS
   **verweigern** — das zerstört Daten still.
3. **Nie über die laufende Installation drüber.** Erst in eine frische Datenbank daneben einspielen,
   prüfen, dann umschalten. Die alte bleibt liegen, bis der Nutzer bestätigt.
4. **Trockenlauf.** Vor dem echten Zurückspielen: Dump lesbar? Belegordner vollständig? Schlüssel
   richtig? Eine Sicherung, die man erst im Ernstfall als kaputt erkennt, ist keine.
5. ⚠️ **Regelmäßig prüfen, ob die Sicherung überhaupt etwas taugt.** Einmal im Monat automatisch
   entpacken und den Dump validieren — und das Ergebnis in der Verwaltung anzeigen. „Letzte
   Sicherung: gestern, 14,2 MB, geprüft ✓" ist die einzige Anzeige, der man glauben kann.

## Was der Nutzer sieht

**Verwaltung → Sicherung** (nur Betreiber/Admin):

- Schalter **„Täglich sichern"**
- **Ordner** + Vorschläge für Drive/Dropbox/Festplatte, wenn vorhanden
- Der **Wiederherstellungsschlüssel**, einmalig, mit Bestätigung
- **Letzte Sicherung**: wann, wie groß, geprüft — und ein **„Jetzt sichern"**
- **Wiederherstellen…** → erklärt, dass die App dafür neu startet

Beim Docker-Build zeigt derselbe Bereich stattdessen einen Hinweis auf `docker cp` bzw. das
vorhandene Download-Backup — dort hat der Betreiber ohnehin eigene Werkzeuge.

## Offen für Martin

- Verschlüsselung **immer**, oder für die externe Festplatte optional?
- Aufbewahrung 7/4/3 — oder schlicht „die letzten 30 Sicherungen"?
- Soll eine Sicherung beim **Beenden** laufen (frischer, verlängert aber das Schließen) oder nur
  beim Start?
- Echte Drive/Dropbox-API später — oder bewusst nie?
