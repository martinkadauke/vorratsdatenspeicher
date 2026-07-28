// AUTO-GENERATED — DO NOT EDIT BY HAND.
// The three category trees a new DEMO household can choose between in the intro wizard
// ("simple" / "medium" / "complex"). They are the SAME tree at three depths: level 1 and 2 are
// identical in all three; medium adds a coarse level 3, complex a finer one. So a product moves
// predictably, e.g. Bio-Banane → "Obst & Gemüse" / "Obst" / "Bio-Obst".
// Meta/Pfand + Meta/Rabatt are NOT listed — they are system categories added separately.
// Pre-computed so choosing a granularity costs no AI tokens (see seedReceipts.ts).

export interface DemoCategory { path: string; emoji?: string }
export type DemoTreeKey = 'simple' | 'medium' | 'complex';

export const DEMO_TREES: Record<DemoTreeKey, DemoCategory[]> = {
  "simple": [
    {
      "path": "Lebensmittel",
      "emoji": "🛒"
    },
    {
      "path": "Lebensmittel/Obst & Gemüse"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch"
    },
    {
      "path": "Lebensmittel/Brot & Backwaren"
    },
    {
      "path": "Lebensmittel/Nudeln, Reis & Trockenware"
    },
    {
      "path": "Lebensmittel/Fertiggerichte & Snacks"
    },
    {
      "path": "Lebensmittel/Süßes & Gebäck"
    },
    {
      "path": "Lebensmittel/Saucen & Gewürze"
    },
    {
      "path": "Getränke",
      "emoji": "🥤"
    },
    {
      "path": "Getränke/Softdrinks & Energy"
    },
    {
      "path": "Getränke/Wasser & Saft"
    },
    {
      "path": "Getränke/Kaffee & Tee"
    },
    {
      "path": "Tiernahrung",
      "emoji": "🐾"
    },
    {
      "path": "Tiernahrung/Katzenfutter"
    },
    {
      "path": "Pflanzen & Garten",
      "emoji": "🌿"
    },
    {
      "path": "Pflanzen & Garten/Kräuter & Pflanzen"
    },
    {
      "path": "Pflanzen & Garten/Pflanzzubehör"
    },
    {
      "path": "Drogerie & Körperpflege",
      "emoji": "🧴"
    },
    {
      "path": "Drogerie & Körperpflege/Haarpflege"
    },
    {
      "path": "Drogerie & Körperpflege/Dusche & Bad"
    },
    {
      "path": "Haushalt",
      "emoji": "🧹"
    },
    {
      "path": "Haushalt/Reinigung"
    },
    {
      "path": "Haushalt/Papier & Hygiene"
    },
    {
      "path": "Haushalt/Textilien"
    },
    {
      "path": "Haushalt/Küchenzubehör"
    }
  ],
  "medium": [
    {
      "path": "Lebensmittel",
      "emoji": "🛒"
    },
    {
      "path": "Lebensmittel/Obst & Gemüse"
    },
    {
      "path": "Lebensmittel/Obst & Gemüse/Obst"
    },
    {
      "path": "Lebensmittel/Obst & Gemüse/Gemüse"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Milch & Milchgetränke"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Joghurt"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Käse"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Eier"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch/Fleisch & Wurst"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch/Fisch"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch/Vegetarisch & Vegan"
    },
    {
      "path": "Lebensmittel/Brot & Backwaren"
    },
    {
      "path": "Lebensmittel/Brot & Backwaren/Brot & Brötchen"
    },
    {
      "path": "Lebensmittel/Nudeln, Reis & Trockenware"
    },
    {
      "path": "Lebensmittel/Nudeln, Reis & Trockenware/Nudeln & Spätzle"
    },
    {
      "path": "Lebensmittel/Nudeln, Reis & Trockenware/Getreide & Müsli"
    },
    {
      "path": "Lebensmittel/Fertiggerichte & Snacks"
    },
    {
      "path": "Lebensmittel/Fertiggerichte & Snacks/Knabbersnacks"
    },
    {
      "path": "Lebensmittel/Süßes & Gebäck"
    },
    {
      "path": "Lebensmittel/Süßes & Gebäck/Kekse & Cookies"
    },
    {
      "path": "Lebensmittel/Süßes & Gebäck/Speiseeis"
    },
    {
      "path": "Lebensmittel/Saucen & Gewürze"
    },
    {
      "path": "Lebensmittel/Saucen & Gewürze/Saucen"
    },
    {
      "path": "Lebensmittel/Saucen & Gewürze/Gewürze & Kräuter"
    },
    {
      "path": "Getränke",
      "emoji": "🥤"
    },
    {
      "path": "Getränke/Softdrinks & Energy"
    },
    {
      "path": "Getränke/Softdrinks & Energy/Energy Drinks"
    },
    {
      "path": "Getränke/Wasser & Saft"
    },
    {
      "path": "Getränke/Wasser & Saft/Wasser"
    },
    {
      "path": "Getränke/Wasser & Saft/Saft"
    },
    {
      "path": "Getränke/Kaffee & Tee"
    },
    {
      "path": "Getränke/Kaffee & Tee/Kaffee"
    },
    {
      "path": "Tiernahrung",
      "emoji": "🐾"
    },
    {
      "path": "Tiernahrung/Katzenfutter"
    },
    {
      "path": "Tiernahrung/Katzenfutter/Nassfutter"
    },
    {
      "path": "Tiernahrung/Katzenfutter/Trockenfutter"
    },
    {
      "path": "Pflanzen & Garten",
      "emoji": "🌿"
    },
    {
      "path": "Pflanzen & Garten/Kräuter & Pflanzen"
    },
    {
      "path": "Pflanzen & Garten/Kräuter & Pflanzen/Kräuter"
    },
    {
      "path": "Pflanzen & Garten/Kräuter & Pflanzen/Zierpflanzen"
    },
    {
      "path": "Pflanzen & Garten/Pflanzzubehör"
    },
    {
      "path": "Pflanzen & Garten/Pflanzzubehör/Töpfe & Schalen"
    },
    {
      "path": "Drogerie & Körperpflege",
      "emoji": "🧴"
    },
    {
      "path": "Drogerie & Körperpflege/Haarpflege"
    },
    {
      "path": "Drogerie & Körperpflege/Haarpflege/Shampoo"
    },
    {
      "path": "Drogerie & Körperpflege/Haarpflege/Coloration"
    },
    {
      "path": "Drogerie & Körperpflege/Dusche & Bad"
    },
    {
      "path": "Drogerie & Körperpflege/Dusche & Bad/Duschpflege"
    },
    {
      "path": "Haushalt",
      "emoji": "🧹"
    },
    {
      "path": "Haushalt/Reinigung"
    },
    {
      "path": "Haushalt/Reinigung/Bad & WC"
    },
    {
      "path": "Haushalt/Papier & Hygiene"
    },
    {
      "path": "Haushalt/Papier & Hygiene/Papierprodukte"
    },
    {
      "path": "Haushalt/Papier & Hygiene/Feuchttücher"
    },
    {
      "path": "Haushalt/Textilien"
    },
    {
      "path": "Haushalt/Textilien/Handtücher"
    },
    {
      "path": "Haushalt/Küchenzubehör"
    },
    {
      "path": "Haushalt/Küchenzubehör/Geschirr & Becher"
    }
  ],
  "complex": [
    {
      "path": "Lebensmittel",
      "emoji": "🛒"
    },
    {
      "path": "Lebensmittel/Obst & Gemüse"
    },
    {
      "path": "Lebensmittel/Obst & Gemüse/Bio-Obst"
    },
    {
      "path": "Lebensmittel/Obst & Gemüse/Obst"
    },
    {
      "path": "Lebensmittel/Obst & Gemüse/Bio-Gemüse"
    },
    {
      "path": "Lebensmittel/Obst & Gemüse/Gemüse"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Milch"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Proteinmilch & Drinks"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Joghurt"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Griechischer Joghurt"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Frischkäse"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Schnittkäse"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Grillkäse"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Bio-Eier"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Eier Bodenhaltung"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch/Bacon & Speck"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch/Geflügel"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch/Burger & Patties"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch/Fisch & Thunfisch"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch/Vegetarisch & Vegan"
    },
    {
      "path": "Lebensmittel/Brot & Backwaren"
    },
    {
      "path": "Lebensmittel/Brot & Backwaren/Brötchen"
    },
    {
      "path": "Lebensmittel/Brot & Backwaren/Schwäbische Spezialitäten"
    },
    {
      "path": "Lebensmittel/Nudeln, Reis & Trockenware"
    },
    {
      "path": "Lebensmittel/Nudeln, Reis & Trockenware/Nudeln"
    },
    {
      "path": "Lebensmittel/Nudeln, Reis & Trockenware/Spätzle & Knöpfle"
    },
    {
      "path": "Lebensmittel/Nudeln, Reis & Trockenware/Gefüllte Teigwaren"
    },
    {
      "path": "Lebensmittel/Nudeln, Reis & Trockenware/Müsli & Cerealien"
    },
    {
      "path": "Lebensmittel/Fertiggerichte & Snacks"
    },
    {
      "path": "Lebensmittel/Fertiggerichte & Snacks/Knabbersnacks"
    },
    {
      "path": "Lebensmittel/Süßes & Gebäck"
    },
    {
      "path": "Lebensmittel/Süßes & Gebäck/Kekse"
    },
    {
      "path": "Lebensmittel/Süßes & Gebäck/Cookies"
    },
    {
      "path": "Lebensmittel/Süßes & Gebäck/Speiseeis"
    },
    {
      "path": "Lebensmittel/Süßes & Gebäck/Dessert-Zubehör"
    },
    {
      "path": "Lebensmittel/Saucen & Gewürze"
    },
    {
      "path": "Lebensmittel/Saucen & Gewürze/Barbecue & Grillsaucen"
    },
    {
      "path": "Lebensmittel/Saucen & Gewürze/Tomatensaucen"
    },
    {
      "path": "Lebensmittel/Saucen & Gewürze/Bio-Gewürzkräuter"
    },
    {
      "path": "Lebensmittel/Saucen & Gewürze/Gewürzkräuter"
    },
    {
      "path": "Getränke",
      "emoji": "🥤"
    },
    {
      "path": "Getränke/Softdrinks & Energy"
    },
    {
      "path": "Getränke/Softdrinks & Energy/Energy Drinks"
    },
    {
      "path": "Getränke/Softdrinks & Energy/Energy Drinks Zero"
    },
    {
      "path": "Getränke/Wasser & Saft"
    },
    {
      "path": "Getränke/Wasser & Saft/Mineralwasser"
    },
    {
      "path": "Getränke/Wasser & Saft/Multivitaminsaft"
    },
    {
      "path": "Getränke/Kaffee & Tee"
    },
    {
      "path": "Getränke/Kaffee & Tee/Kaffeepulver"
    },
    {
      "path": "Tiernahrung",
      "emoji": "🐾"
    },
    {
      "path": "Tiernahrung/Katzenfutter"
    },
    {
      "path": "Tiernahrung/Katzenfutter/Nassfutter"
    },
    {
      "path": "Tiernahrung/Katzenfutter/Trockenfutter"
    },
    {
      "path": "Pflanzen & Garten",
      "emoji": "🌿"
    },
    {
      "path": "Pflanzen & Garten/Kräuter & Pflanzen"
    },
    {
      "path": "Pflanzen & Garten/Kräuter & Pflanzen/Bio-Kräuter"
    },
    {
      "path": "Pflanzen & Garten/Kräuter & Pflanzen/Kräuter"
    },
    {
      "path": "Pflanzen & Garten/Kräuter & Pflanzen/Zierpflanzen"
    },
    {
      "path": "Pflanzen & Garten/Kräuter & Pflanzen/Samen"
    },
    {
      "path": "Pflanzen & Garten/Pflanzzubehör"
    },
    {
      "path": "Pflanzen & Garten/Pflanzzubehör/Pflanztöpfe"
    },
    {
      "path": "Pflanzen & Garten/Pflanzzubehör/Untersetzer & Schalen"
    },
    {
      "path": "Drogerie & Körperpflege",
      "emoji": "🧴"
    },
    {
      "path": "Drogerie & Körperpflege/Haarpflege"
    },
    {
      "path": "Drogerie & Körperpflege/Haarpflege/Shampoo"
    },
    {
      "path": "Drogerie & Körperpflege/Haarpflege/Coloration"
    },
    {
      "path": "Drogerie & Körperpflege/Dusche & Bad"
    },
    {
      "path": "Drogerie & Körperpflege/Dusche & Bad/Duschgel & Schaumbad"
    },
    {
      "path": "Haushalt",
      "emoji": "🧹"
    },
    {
      "path": "Haushalt/Reinigung"
    },
    {
      "path": "Haushalt/Reinigung/WC-Reinigung"
    },
    {
      "path": "Haushalt/Reinigung/Fenster & Glas"
    },
    {
      "path": "Haushalt/Papier & Hygiene"
    },
    {
      "path": "Haushalt/Papier & Hygiene/Servietten"
    },
    {
      "path": "Haushalt/Papier & Hygiene/Feuchttücher"
    },
    {
      "path": "Haushalt/Papier & Hygiene/Tragetaschen"
    },
    {
      "path": "Haushalt/Textilien"
    },
    {
      "path": "Haushalt/Textilien/Handtücher"
    },
    {
      "path": "Haushalt/Küchenzubehör"
    },
    {
      "path": "Haushalt/Küchenzubehör/Dessertbecher & Eisbecher"
    }
  ]
};
