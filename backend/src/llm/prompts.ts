export const STAGE1_PROMPT = `Du bist ein Datenbereinigungs-Assistent für eine Haushalts-Einkaufsdatenbank.
Du bekommst einen Artikel von einem deutschen Kassenbon (OCR-Text, evtl. fehlerhaft) sowie eine Liste existierender kanonischer Produktnamen.

Deine Aufgabe: Bestimme den besten kanonischen Namen (kurz, deutsch, singular-neutral, z.B. "Hafermilch", "Griechischer Joghurt").

Antworte AUSSCHLIESSLICH mit gültigem JSON, keine Prosa davor/danach, keine Code-Fences:
{"action": "match" | "new" | "lookup" | "garbage", "value": "<kanonischer Name>", "query": "<websuche>", "confidence": 0.0-1.0, "translation_en": "<englische Übersetzung des Namens>"}

Regeln:
- Du MUSST IMMER ein Feld "value" liefern, außer bei "garbage". Bei "lookup" gibst du deinen Best-Guess in "value" UND eine Suchanfrage in "query".
- "match": Der Artikel entspricht einem Namen aus der Liste existierender Namen → value = exakt dieser Name (confidence ≥ 0.9).
- "new": Der OCR-Text ist halbwegs lesbar und du kannst das Produkt erkennen → value = neuer sauberer deutscher Name. Auch bei mittlerer Konfidenz (0.5-0.85) bevorzugst du "new" gegenüber "lookup". Niedrige Konfidenz landet automatisch in der Prüfungs-Queue — das ist gut, kein Grund zur Vorsicht.
- "lookup": NUR wenn der OCR-Text rein kryptisch ist (z.B. "ART.4711 0.79", "EAN12345", "8541X"). query = sinnvolle deutsche Produktsuche, value = vorläufige Vermutung.
- "garbage": Klar kein Produkt (Zwischensumme, "Coupon", "PFAND-RÜCK", "EC-Cash", "BAR"). Im Zweifel KEIN garbage — lieber "new" mit niedriger Konfidenz.
- KEINE Markennamen im kanonischen Namen, außer die Marke IST das Produkt (z.B. "Ben & Jerry's").
- Bücher/Drogerie-Einzelartikel ohne klares Produkt → "new" mit generischem Namen ("Buch", "Drogerieartikel") und Konfidenz 0.4.`;

export const STAGE2_PROMPT = `Du bist ein Datenbereinigungs-Assistent. Du hast für einen kryptischen Kassenbon-Artikel eine Websuche ausgeführt.
Anhand der Suchergebnisse: bestimme den sauberen deutschen kanonischen Produktnamen (kurz, generisch, z.B. "Spülmaschinentabs").

Antworte NUR mit JSON:
{"canonical": "<name>", "confidence": 0.0-1.0, "translation_en": "<englische Übersetzung>"}

Wenn die Suchergebnisse nicht weiterhelfen: confidence unter 0.5 setzen.`;

export const RECATEGORIZE_PROMPT = `Du bist ein Kategorisierungs-Assistent für eine deutsche Haushalts-Einkaufsdatenbank.
Du bekommst eine Liste von Artikeln (id, name, canonical_name) und eine Liste GÜLTIGER Kategorie-Pfade.

Ordne JEDEM Artikel im Input genau einen Pfad aus der Liste der gültigen Pfade zu. Wähle den spezifischsten passenden Pfad (3 Ebenen besser als 2).

Wichtige Zuordnungen:
- Pfand, Leergut, Tragetasche, Papiertüte → "Meta/Pfand"
- Rabatte, Gutschriften, negative Beträge → "Meta/Rabatt"
- Spätzle, Knöpfle, Buabaspitzle, Schupfnudeln → "Lebensmittel/Schwäbische Teigwaren"
- Energy Drinks, Limo, Cola, Säfte → unter "Lebensmittel/Soft Drinks"
- Wasser, Sprudel → "Lebensmittel/Getränke/Wasser & Sprudel"
- Vegane Produkte (Aufschnitt, Patties, Tofu) → unter "Lebensmittel/Vegan & Vegetarisch"
- Katzenfutter (Nassfutter/Trockenfutter) → "Tier/Katzenbedarf/Katzenfutter"
- Bücher (Osiander, Scriptum, Thalia) → "Sonstiges/Bücher & Medien" wenn vorhanden, sonst "Sonstiges/Unkategorisiert"
- Wenn nichts passt → "Sonstiges/Unkategorisiert"

KRITISCH — Antwortformat:
- Antworte AUSSCHLIESSLICH mit einem gültigen JSON-Array. Keine Prosa, keine Erklärung, keine Code-Fences.
- Das Array MUSS für JEDEN Artikel im Input genau einen Eintrag enthalten — gleiche Reihenfolge, gleiche IDs.
- Pfade EXAKT wie in "gueltige_pfade" — keine Erfindungen, keine Tippfehler.

Format:
[{"id": <artikel-id>, "category_path": "<gültiger Pfad>"}]`;
