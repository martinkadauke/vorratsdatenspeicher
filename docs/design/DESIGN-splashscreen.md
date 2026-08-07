# Design: der Startbildschirm der Desktop-App

**Status: Entwurf, nicht gebaut.** Vorschlag zur Entscheidung. Der aktuelle Zustand (ein kleiner
Kassenbon mit gestrichelter Abrisskante) ist ein Zwischenschritt, kein Ziel.

## Das Problem

Zwei Sekunden bei jedem Start, ~60 Sekunden beim allerersten. Der Bildschirm hat genau eine
Aufgabe: **die Zeit erklären, statt sie nur zu füllen.** Der ursprüngliche Text („Beim ersten Start
wird die Datenbank angelegt") stand bei jedem Start da und las sich beim zehnten Mal wie ein
Defekt. Der aktuelle Bon ist ehrlicher, aber langweilig — er zeigt nichts, was mit *dieser*
Installation zu tun hat.

Ein Ladebildschirm, der nichts über dich weiß, ist verschenkte Zeit. Ein Ladebildschirm, der etwas
über dich weiß, ist das Gegenteil: der Moment, in dem die App zeigt, dass sie sich erinnert.

## Der Vorschlag: der Bon druckt sich selbst

**Ein Kassenbon, der sich während des Starts Zeile für Zeile ausdruckt** — jede Zeile ein echter
Startschritt, mit dem Zeichensatz und dem Rhythmus eines Thermodruckers.

```
        VORRATSDATENSPEICHER
     ---------------------------
     Datenbank              ✓
     Belege                 ✓
     Preise                 ·
     ---------------------------
```

Warum das trägt:

- **Es ist die Bildsprache des Produkts.** VDS liest Kassenbons; die Website ist ein Kassenbon. Ein
  Startbildschirm, der sich ausdruckt, erklärt in zwei Sekunden ohne ein Wort, worum es geht.
- **Fortschritt braucht keinen Balken.** Jede gedruckte Zeile ist ein wirklich abgeschlossener
  Schritt. Ein Balken, der 1,8 Sekunden lang scheinbar rechnet, ist eine Lüge; ein Bon, der bei
  einer Zeile hängt, sagt dir, *wo* es klemmt.
- **Es skaliert über beide Fälle.** Beim ersten Start druckt er langsam und mit einer erklärenden
  Fußzeile; danach ist er in unter einer Sekunde durch und man sieht nur den Abriss.

### Die Zahl als Belohnung

**Auf dem Bon steht am Ende eine echte Zahl aus dem eigenen Haushalt** — die Summe, die
Vorratsdatenspeicher bisher erfasst hat:

```
     ---------------------------
     TOTAL erfasst     1.284,55
     ---------------------------
       Willkommen zurück, Lena
```

Das ist der Unterschied zwischen einem Ladebildschirm und einem *Gruß*. Man sieht beim Warten
etwas, das nur die eigene Installation zeigen kann. (Beim allerersten Start steht dort
stattdessen `TOTAL 0,00 — fangen wir an.` — auch das ist ein Versprechen.)

⚠️ **Datenschutz-Vorbehalt:** die Zahl ist vor dem Login sichtbar. Auf einem privaten Rechner ist
das harmlos, in einer WG oder einem Büro nicht unbedingt. Vorschlag: **standardmäßig an, im Profil
abschaltbar** („Beim Start meine Gesamtsumme zeigen"). Notfalls nur die Anzahl der Belege statt des
Betrags — weniger verräterisch, fast genauso schön.

### Bewegung

Kein Spinner, keine Animation um ihrer selbst willen. Nur:

- Zeilen erscheinen **einzeln**, mit ~120 ms Abstand, leicht versetzt von links — wie Papier, das
  aus dem Schlitz kommt.
- Der Punkt hinter dem laufenden Schritt **blinkt** im Takt eines Druckkopfs.
- Ist alles fertig, **reißt der Bon ab**: die gestrichelte Kante wandert einmal kurz nach unten,
  dann übernimmt die App. Das ist die einzige Stelle, an der etwas „passiert".
- `prefers-reduced-motion`: alle Zeilen sofort, kein Abriss.

### Details, die den Unterschied machen

- **Zeichensatz:** eine echte Monospace mit Charakter, keine System-Monospace. Der Bon lebt vom
  ungleichen Grau eines Thermodrucks — leichte Unschärfe, nicht ganz schwarz (`#2c2620` auf
  `#fffdf7`), Zeilen minimal unterschiedlich stark.
- **Papier:** ein Hauch Textur und ein weicher Schlagschatten. Der Bon liegt auf dem
  Fensterhintergrund, er ist nicht der Hintergrund.
- **Datum und Uhrzeit** oben rechts, wie auf einem echten Bon. Kostet nichts, wirkt sofort echt.
- **Dunkler Modus:** kein invertierter Bon (sieht aus wie ein Röntgenbild). Stattdessen bleibt das
  Papier hell und der Fensterhintergrund wird dunkel — ein beleuchteter Bon auf dunklem Tisch.

## Was es dafür braucht

Der Startbildschirm läuft, **bevor** das Backend antwortet — die Zahl kann also nicht per API
kommen. Zwei Möglichkeiten:

1. **Zwischenspeichern:** die Shell schreibt beim letzten Beenden die Summe in eine kleine Datei
   und liest sie beim nächsten Start. Zeigt also den Stand von *gestern* — für einen Gruß völlig
   ausreichend und technisch trivial.
2. **Nachladen:** der Bon druckt die Zahlenzeile erst, wenn das Backend antwortet. Ehrlicher, aber
   die schönste Zeile erscheint dann ausgerechnet zum Schluss, kurz bevor das Fenster wechselt.

Empfehlung: **(1)**. Der Startbildschirm soll nicht auf etwas warten.

Umsetzung bleibt eine `data:`-URL ohne Abhängigkeiten (er muss rendern, bevor irgendetwas anderes
existiert) — außer dem Zeichensatz, der als Data-URI eingebettet werden müsste. Alternativ eine
sorgfältig gewählte System-Monospace; dann kostet der ganze Bildschirm nichts.

## Offen für Martin

- Zahl auf dem Bon: **ja / nur Belegzahl / nein**?
- Zeichensatz einbetten (~30 kB) oder System-Monospace?
- Soll der Abriss auch beim *Beenden* laufen (Bon reißt ab, Fenster schließt)? Nett, aber
  verlängert das Schließen um 300 ms — und nichts nervt mehr als eine App, die sich langsam
  verabschiedet.
