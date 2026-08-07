# Design: der Startbildschirm der Desktop-App

**Status: Entwurf, nicht gebaut.** Vorschlag zur Entscheidung. Der aktuelle Zustand (ein statischer
Bon mit gestrichelter Kante) ist ein Zwischenschritt, kein Ziel.

## Das Problem

Zwei Sekunden bei jedem Start, ~60 Sekunden beim allerersten. Der Bildschirm hat genau eine
Aufgabe: **die Zeit erklären, statt sie nur zu füllen.**

Der ursprüngliche Text („Beim ersten Start wird die Datenbank angelegt") stand bei *jedem* Start da
und las sich beim zehnten Mal wie ein Defekt. Ein Ladebildschirm, der nichts über dich weiß, ist
verschenkte Zeit. Einer, der etwas über dich weiß, ist der Moment, in dem die App zeigt, dass sie
sich erinnert.

---

## Die Inszenierung: der Bon wird abgeschnitten

Martins Idee, und sie ist die richtige — auf der Website sitzt an mehreren Stellen ein kleines
Scherensymbol, das hier zur tragenden Bewegung wird.

```
   ①  Bon fährt von oben ins Bild
       ┌─────────────────────────┐
       │  VORRATSDATENSPEICHER   │
       │  ---------------------  │
       │  Datenbank          ✓   │
       │  Belege             ✓   │
       │  ---------------------  │
   ②  ✂- - - - - - - - - - - - -    ← Schere gleitet rechts → links,
       │  TOTAL erfasst  1.284,55│      die Perforation entsteht in ihrer Spur
       │  Willkommen zurück      │
       └─────────────────────────┘
   ③  oberer Teil fährt nach oben weg, der untere bleibt in der Mitte
```

**Der Ablauf, an echte Startschritte gekoppelt:**

| Phase | Was passiert | Dauer |
|---|---|---|
| Einfahren | Bon kommt von oben herein, leichtes Nachfedern (Papier hat Trägheit) | ~400 ms |
| Drucken | Zeilen erscheinen einzeln, ~120 ms Abstand — **jede Zeile ein wirklich fertiger Schritt** | variabel |
| Schnitt | Schere gleitet rechts → links, hinter ihr entsteht die gezackte Kante + ein leises Zittern des Papiers | ~500 ms |
| Abriss | Oberer Teil fährt nach oben aus dem Bild, unterer bleibt zentriert stehen | ~300 ms |
| Warten | Der abgeschnittene Rest liegt in der Mitte, bis das Backend antwortet | 0 – 60 s |
| Übergabe | Bon fährt ab, App erscheint | ~200 ms |

Das Kunststück: **der Schnitt kommt erst, wenn wirklich alles geladen ist.** Beim normalen Start
folgt er nach zwei Sekunden, beim allerersten nach einer Minute — die Schere ist der
Fortschrittsbalken, nur ohne zu lügen. Bleibt eine Zeile ungedruckt stehen, siehst du sofort, *wo*
es klemmt.

**Details:**

- Die Schere ist **auf den Bon gedruckt**, nicht darübergelegt — gleiche Farbe, gleiche Unschärfe
  wie der Rest des Thermodrucks. Sie gehört zum Papier.
- Die Perforation entsteht **in der Spur der Schere**, nicht vorher. Sonst verrät der Bon die
  Pointe.
- `prefers-reduced-motion`: alles sofort da, kein Einfahren, kein Schnitt. Nur der fertige Rest.

---

## Was auf dem Bon steht

Das Herz. Der obere Teil (der weggeschnitten wird) trägt die **Startschritte**, der untere Teil (der
bleibt) trägt die **Botschaft**.

### Immer: die eigene Zahl

```
     ---------------------------
     TOTAL erfasst     1.284,55
     ---------------------------
```

Beim allerersten Start: `TOTAL 0,00 — fangen wir an.`

### Manchmal: was die Daten über den Haushalt erzählen

Nicht bei jedem Start — **etwa jeder 10.**, damit es besonders bleibt. Ein Hintergrund-Job leitet
aus den eigenen Daten kleine Beobachtungen ab:

> „Eure Katze frisst gerade mehr als sonst." — *Katzenfutter, 3 Wochen: +40 %*

Weitere Sorten, damit es nicht monoton wird:

| Sorte | Beispiel |
|---|---|
| **Veränderung** | „Kaffee ist bei euch seit Januar 18 % teurer geworden." |
| **Treue** | „Ihr habt Butter 14-mal hintereinander bei Rewe gekauft. Beim Aldi war sie jedes Mal günstiger." |
| **Jahreszeit** | „Erdbeeren sind wieder da — zum ersten Mal seit 240 Tagen auf einem Beleg." |
| **Rekord** | „Der größte Einkauf des Jahres: 187,40 € am 23. Dezember. Verständlich." |
| **Beharrlichkeit** | „Seit 62 Wochen ohne Unterbrechung: Milch." |
| **Kurios** | „Ihr habt dieses Jahr 4,2 kg Nudeln gekauft und 5,1 kg Nudelsoße. Da stimmt was nicht." |
| **Rückblick** | „Vor genau einem Jahr, am 8. August, habt ihr zum ersten Mal einen Beleg gescannt. 412 sind es inzwischen." |
| **Sparen** | „Wenn ihr Kaffee immer im Angebot gekauft hättet, wären das 34 € weniger gewesen." |
| **Vorrat** | „Nach unserer Rechnung ist das Klopapier am Donnerstag alle." |

⚠️ **Die Zahlen kommen aus der Datenbank, nie aus dem Modell.** Das ist dieselbe Regel, die schon
für die Analytics-Seite und die Statistik-KI gilt: der Job rechnet deterministisch, die KI darf
ausschließlich **formulieren**. Ein Ladebildschirm, der sich Zahlen ausdenkt, ist schlimmer als
einer, der schweigt — und man würde es nie merken. Der Job speichert also `{fakt, zahlen, text}`,
und wenn die KI nicht erreichbar ist, gibt es eine deterministische Formulierung als Rückfall.

**Wann läuft der Job?** Nicht beim Start — der Bildschirm darf auf nichts warten. Sondern
gelegentlich im Hintergrund (beim Churner-Lauf, nachts), der schreibt ein paar fertige Sprüche in
die Datenbank, und die Shell legt sich den nächsten beim Beenden als Datei zurecht. Der
Startbildschirm liest nur noch eine Zeile Text.

---

## Was es dafür braucht

Der Startbildschirm läuft, **bevor** das Backend antwortet — Zahl und Spruch können also nicht per
API kommen.

> **Lösung:** die Shell schreibt beim Beenden Summe und nächsten Spruch in eine kleine Datei und
> liest sie beim nächsten Start. Zeigt den Stand von gestern — für einen Gruß völlig ausreichend
> und technisch trivial.

Umsetzung bleibt eine `data:`-URL ohne Abhängigkeiten (sie muss rendern, bevor irgendetwas anderes
existiert). Einzige offene Frage ist der Zeichensatz: eine echte Monospace mit Charakter müsste als
Data-URI eingebettet werden (~30 kB), sonst tut es eine sorgfältig gewählte System-Monospace.

**Optik:** Papier `#fffdf7`, Druck `#2c2620` mit minimal ungleichmäßiger Schwärze (Thermodruck ist
nie ganz schwarz), weicher Schlagschatten, Datum und Uhrzeit oben rechts wie auf einem echten Bon.
Im dunklen Modus **nicht invertieren** — das sieht aus wie ein Röntgenbild. Stattdessen bleibt das
Papier hell und der Hintergrund wird dunkel: ein beleuchteter Bon auf dunklem Tisch.

---

## Offen für Martin

- **Die Zahl ist vor dem Login sichtbar.** Auf einem privaten Rechner harmlos, in einer WG oder im
  Büro nicht unbedingt. Vorschlag: standardmäßig an, im Profil abschaltbar; notfalls nur die Anzahl
  der Belege statt des Betrags — weniger verräterisch, fast genauso schön. **Gilt für die Sprüche
  genauso** — „Eure Katze frisst mehr" vor dem Login ist charmant, „Der größte Einkauf des Jahres:
  187,40 €" vielleicht nicht.
- Zeichensatz einbetten oder System-Monospace?
- Jeder 10. Start — oder lieber an besondere Momente knüpfen (erster Start im Monat, Jahrestag des
  ersten Belegs, nach einem Rekord-Einkauf)? Seltener heißt wertvoller.
- Soll der Bon auch beim **Beenden** abgeschnitten werden? Schön symmetrisch, verlängert das
  Schließen aber um 300 ms — und nichts nervt mehr als eine App, die sich langsam verabschiedet.
