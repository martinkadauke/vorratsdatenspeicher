// AUTO-GENERATED demo seed data — DO NOT EDIT BY HAND.
// 5 pre-parsed receipts every new DEMO household starts with, so the app looks alive
// immediately. Inserted as finished data — NO OCR, NO AI call — because a demo household is
// throwaway (swept nightly) and random visitors must not burn API tokens.
// Each position carries a PRE-COMPUTED category for each of the three onboarding
// granularities (simple / medium / complex, see seedTrees.ts), so picking a granularity costs
// nothing at signup. The 6th receipt is NOT here: it ships as a bundled image the "scan your
// first receipt" dialog pre-loads, so the user watches ONE real OCR run.
// Images live OUTSIDE this repo (it is public) — bind-mounted on the demo host, see
// DEMO_ASSETS_PATH in index.ts.

export interface DemoSeedItem { name: string; canonical: string | null; cats: { simple: string | null; medium: string | null; complex: string | null }; menge: number; einheit: string; preis: number | null; guess: string | null; orig: string | null; sort: number }
export interface DemoSeedReceipt { store: string; total: number; daysAgo: number; image: string; items: DemoSeedItem[] }

export const DEMO_SEED_RECEIPTS: DemoSeedReceipt[] = [
  {
    "store": "DM-drogerie Gomaringen",
    "total": 40.15,
    "daysAgo": 2,
    "image": "/demo-receipts/demo-4-dm.jpg",
    "items": [
      {
        "name": "Profissimo 2in1-Badtuch",
        "canonical": "Badetuch",
        "menge": 1,
        "einheit": "stk",
        "preis": 1.75,
        "guess": "Badetuch",
        "orig": "Prof. 2in1-Badtuch",
        "sort": 0,
        "cats": {
          "simple": "Haushalt/Textilien",
          "medium": "Haushalt/Textilien/Handtücher",
          "complex": "Haushalt/Textilien/Handtücher"
        }
      },
      {
        "name": "Profissimo Fenstertücher Set Mikrofaser",
        "canonical": "Fenstertuch Mikrofaser",
        "menge": 1,
        "einheit": "stk",
        "preis": 2.95,
        "guess": "Fenstertücher Mikrofaser",
        "orig": "Prof. Fenstertücher Set Mikrof",
        "sort": 1,
        "cats": {
          "simple": "Haushalt/Reinigung",
          "medium": "Haushalt/Reinigung/Bad & WC",
          "complex": "Haushalt/Reinigung/Fenster & Glas"
        }
      },
      {
        "name": "Profissimo WC-Bürste grau/creme",
        "canonical": "WC-Bürste",
        "menge": 1,
        "einheit": "stk",
        "preis": 0.85,
        "guess": "WC-Bürste",
        "orig": "Profissimo WC Bürste grau/crem",
        "sort": 2,
        "cats": {
          "simple": "Haushalt/Reinigung",
          "medium": "Haushalt/Reinigung/Bad & WC",
          "complex": "Haushalt/Reinigung/WC-Reinigung"
        }
      },
      {
        "name": "Profissimo Back- und Dessertbecher",
        "canonical": "Dessertbecher",
        "menge": 1,
        "einheit": "stk",
        "preis": 2.95,
        "guess": "Backbecher/Dessertbecher",
        "orig": "Prof. Back-und Dessertbecher",
        "sort": 3,
        "cats": {
          "simple": "Haushalt/Küchenzubehör",
          "medium": "Haushalt/Küchenzubehör/Geschirr & Becher",
          "complex": "Haushalt/Küchenzubehör/Dessertbecher & Eisbecher"
        }
      },
      {
        "name": "Profissimo Servietten Farbverlauf 25x25cm",
        "canonical": "Servietten",
        "menge": 1,
        "einheit": "stk",
        "preis": 0.85,
        "guess": "Servietten",
        "orig": "Prof. Serv. Farbverl. 25x25cm",
        "sort": 4,
        "cats": {
          "simple": "Haushalt/Papier & Hygiene",
          "medium": "Haushalt/Papier & Hygiene/Papierprodukte",
          "complex": "Haushalt/Papier & Hygiene/Servietten"
        }
      },
      {
        "name": "babylove Feuchttücher Wasser 4x80",
        "canonical": "Feuchttücher",
        "menge": 4,
        "einheit": "stk",
        "preis": 4.95,
        "guess": "Baby-Feuchttücher",
        "orig": "babylove Feuchttüch.Wasser4x80",
        "sort": 5,
        "cats": {
          "simple": "Haushalt/Papier & Hygiene",
          "medium": "Haushalt/Papier & Hygiene/Feuchttücher",
          "complex": "Haushalt/Papier & Hygiene/Feuchttücher"
        }
      },
      {
        "name": "SauBär Träum Schön Schaumbad",
        "canonical": "Schaumbad",
        "menge": 6,
        "einheit": "stk",
        "preis": 4.5,
        "guess": "Schaumbad",
        "orig": "6x 0,75 SauBär Träum Schön Sch",
        "sort": 6,
        "cats": {
          "simple": "Drogerie & Körperpflege/Dusche & Bad",
          "medium": "Drogerie & Körperpflege/Dusche & Bad/Duschpflege",
          "complex": "Drogerie & Körperpflege/Dusche & Bad/Duschgel & Schaumbad"
        }
      },
      {
        "name": "dmBio Knabbertiere 100g",
        "canonical": "Knabbersnacks",
        "menge": 100,
        "einheit": "g",
        "preis": 1.35,
        "guess": "Kinder-Snack Knabbertiere",
        "orig": "dmBio Knabbertiere 100g",
        "sort": 7,
        "cats": {
          "simple": "Lebensmittel/Fertiggerichte & Snacks",
          "medium": "Lebensmittel/Fertiggerichte & Snacks/Knabbersnacks",
          "complex": "Lebensmittel/Fertiggerichte & Snacks/Knabbersnacks"
        }
      },
      {
        "name": "dmBio Käse Tortellini",
        "canonical": "Tortellini",
        "menge": 2,
        "einheit": "stk",
        "preis": 3.9,
        "guess": "Käse-Tortellini",
        "orig": "2x 1,95 dmBio Käse Tortellini",
        "sort": 8,
        "cats": {
          "simple": "Lebensmittel/Nudeln, Reis & Trockenware",
          "medium": "Lebensmittel/Nudeln, Reis & Trockenware/Nudeln & Spätzle",
          "complex": "Lebensmittel/Nudeln, Reis & Trockenware/Gefüllte Teigwaren"
        }
      },
      {
        "name": "dmBio Pasta Gigli 500g",
        "canonical": "Spirelli",
        "menge": 500,
        "einheit": "g",
        "preis": 1.95,
        "guess": "Pasta Gigli",
        "orig": "dmBio Pasta Gigli 500g*",
        "sort": 9,
        "cats": {
          "simple": "Lebensmittel/Nudeln, Reis & Trockenware",
          "medium": "Lebensmittel/Nudeln, Reis & Trockenware/Nudeln & Spätzle",
          "complex": "Lebensmittel/Nudeln, Reis & Trockenware/Nudeln"
        }
      },
      {
        "name": "dmBio Spaghetti 500g",
        "canonical": "Spaghetti",
        "menge": 500,
        "einheit": "g",
        "preis": 0.85,
        "guess": "Spaghetti",
        "orig": "dmBio Spaghetti 500g",
        "sort": 10,
        "cats": {
          "simple": "Lebensmittel/Nudeln, Reis & Trockenware",
          "medium": "Lebensmittel/Nudeln, Reis & Trockenware/Nudeln & Spätzle",
          "complex": "Lebensmittel/Nudeln, Reis & Trockenware/Nudeln"
        }
      },
      {
        "name": "dmBio Spirelli 500g",
        "canonical": "Spirelli",
        "menge": 3,
        "einheit": "stk",
        "preis": 2.55,
        "guess": "Nudeln Spirelli",
        "orig": "3x 0,85 dmBio Spirelli 500g",
        "sort": 11,
        "cats": {
          "simple": "Lebensmittel/Nudeln, Reis & Trockenware",
          "medium": "Lebensmittel/Nudeln, Reis & Trockenware/Nudeln & Spätzle",
          "complex": "Lebensmittel/Nudeln, Reis & Trockenware/Nudeln"
        }
      },
      {
        "name": "dmBio Haferflocken Feinblatt 1000g",
        "canonical": "Haferflocken",
        "menge": 1000,
        "einheit": "g",
        "preis": 1.55,
        "guess": "Haferflocken",
        "orig": "dmBio HaferflockenFeinbl.1000g",
        "sort": 12,
        "cats": {
          "simple": "Lebensmittel/Nudeln, Reis & Trockenware",
          "medium": "Lebensmittel/Nudeln, Reis & Trockenware/Getreide & Müsli",
          "complex": "Lebensmittel/Nudeln, Reis & Trockenware/Müsli & Cerealien"
        }
      },
      {
        "name": "Sante Haarfarbe Naturrot",
        "canonical": "Haarfarbe Naturrot",
        "menge": 1,
        "einheit": "stk",
        "preis": 7.95,
        "guess": "Pflanzenhaarfarbe Naturrot",
        "orig": "Sante Haarfarbe Naturrot",
        "sort": 13,
        "cats": {
          "simple": "Drogerie & Körperpflege/Haarpflege",
          "medium": "Drogerie & Körperpflege/Haarpflege/Coloration",
          "complex": "Drogerie & Körperpflege/Haarpflege/Coloration"
        }
      },
      {
        "name": "Balea Professional Shampoo Traumlocken",
        "canonical": "Shampoo",
        "menge": 1,
        "einheit": "stk",
        "preis": 1.25,
        "guess": "Shampoo",
        "orig": "Balea Prof. SH Traumlocken",
        "sort": 14,
        "cats": {
          "simple": "Drogerie & Körperpflege/Haarpflege",
          "medium": "Drogerie & Körperpflege/Haarpflege/Shampoo",
          "complex": "Drogerie & Körperpflege/Haarpflege/Shampoo"
        }
      }
    ]
  },
  {
    "store": "ALDI Gomaringen",
    "total": 24.55,
    "daysAgo": 4,
    "image": "/demo-receipts/demo-3-aldi.jpg",
    "items": [
      {
        "name": "Tragetasche",
        "canonical": "Papiertragetasche",
        "menge": 1,
        "einheit": "stk",
        "preis": 0.25,
        "guess": "Einkaufstasche",
        "orig": "Tragetasche Altp",
        "sort": 0,
        "cats": {
          "simple": "Meta/Pfand",
          "medium": "Meta/Pfand",
          "complex": "Haushalt/Papier & Hygiene/Tragetaschen"
        }
      },
      {
        "name": "Leibniz Choco",
        "canonical": "Leibniz Kekse",
        "menge": 1,
        "einheit": "stk",
        "preis": 1.49,
        "guess": "Leibniz Schokokekse",
        "orig": "Leibniz Choco",
        "sort": 1,
        "cats": {
          "simple": "Lebensmittel/Süßes & Gebäck",
          "medium": "Lebensmittel/Süßes & Gebäck/Kekse & Cookies",
          "complex": "Lebensmittel/Süßes & Gebäck/Kekse"
        }
      },
      {
        "name": "Oreo Box",
        "canonical": "Cookies",
        "menge": 1,
        "einheit": "stk",
        "preis": 1.29,
        "guess": "Oreo Kekse",
        "orig": "Oreo Box",
        "sort": 2,
        "cats": {
          "simple": "Lebensmittel/Süßes & Gebäck",
          "medium": "Lebensmittel/Süßes & Gebäck/Kekse & Cookies",
          "complex": "Lebensmittel/Süßes & Gebäck/Cookies"
        }
      },
      {
        "name": "Bacon 150g",
        "canonical": "Bacon",
        "menge": 150,
        "einheit": "g",
        "preis": 2.19,
        "guess": "Bacon",
        "orig": "Bacon 150g HF3",
        "sort": 3,
        "cats": {
          "simple": "Lebensmittel/Fleisch & Fisch",
          "medium": "Lebensmittel/Fleisch & Fisch/Fleisch & Wurst",
          "complex": "Lebensmittel/Fleisch & Fisch/Bacon & Speck"
        }
      },
      {
        "name": "Veganes Burger Sortiment",
        "canonical": "Vegane Burger",
        "menge": 1,
        "einheit": "stk",
        "preis": 2.25,
        "guess": "Veggie Burger Patties",
        "orig": "Veg Burger Sortime",
        "sort": 4,
        "cats": {
          "simple": "Lebensmittel/Fleisch & Fisch",
          "medium": "Lebensmittel/Fleisch & Fisch/Vegetarisch & Vegan",
          "complex": "Lebensmittel/Fleisch & Fisch/Vegetarisch & Vegan"
        }
      },
      {
        "name": "Rind Hamburger",
        "canonical": "Hamburger-Patties",
        "menge": 1,
        "einheit": "stk",
        "preis": 5.79,
        "guess": "Rinder-Hamburger Patties",
        "orig": "F&G Rind Hamburger",
        "sort": 5,
        "cats": {
          "simple": "Lebensmittel/Fleisch & Fisch",
          "medium": "Lebensmittel/Fleisch & Fisch/Vegetarisch & Vegan",
          "complex": "Lebensmittel/Fleisch & Fisch/Burger & Patties"
        }
      },
      {
        "name": "Double Choc Cookie",
        "canonical": "Cookies",
        "menge": 1,
        "einheit": "stk",
        "preis": 0.79,
        "guess": "Schokoladenkeks",
        "orig": "Double Choc Cookie",
        "sort": 6,
        "cats": {
          "simple": "Lebensmittel/Süßes & Gebäck",
          "medium": "Lebensmittel/Süßes & Gebäck/Kekse & Cookies",
          "complex": "Lebensmittel/Süßes & Gebäck/Cookies"
        }
      },
      {
        "name": "Double Choc Cookie",
        "canonical": "Cookies",
        "menge": 1,
        "einheit": "stk",
        "preis": 0.79,
        "guess": "Schokoladenkeks",
        "orig": "Double Choc Cookie",
        "sort": 7,
        "cats": {
          "simple": "Lebensmittel/Süßes & Gebäck",
          "medium": "Lebensmittel/Süßes & Gebäck/Kekse & Cookies",
          "complex": "Lebensmittel/Süßes & Gebäck/Cookies"
        }
      },
      {
        "name": "Gefüllte Kissen",
        "canonical": "Caramel Cereal",
        "menge": 1,
        "einheit": "stk",
        "preis": 2.79,
        "guess": "Gefüllte Blätterteig-Kissen",
        "orig": "Gefüllte Kissen",
        "sort": 8,
        "cats": {
          "simple": "Lebensmittel/Nudeln, Reis & Trockenware",
          "medium": "Lebensmittel/Nudeln, Reis & Trockenware/Getreide & Müsli",
          "complex": "Lebensmittel/Nudeln, Reis & Trockenware/Müsli & Cerealien"
        }
      },
      {
        "name": "Laugenbrötchen",
        "canonical": "Brötchen",
        "menge": 1,
        "einheit": "stk",
        "preis": 0.39,
        "guess": "Laugenbrötchen",
        "orig": "Laugenbroetchen",
        "sort": 9,
        "cats": {
          "simple": "Lebensmittel/Brot & Backwaren",
          "medium": "Lebensmittel/Brot & Backwaren/Brot & Brötchen",
          "complex": "Lebensmittel/Brot & Backwaren/Brötchen"
        }
      },
      {
        "name": "Laugenbrötchen",
        "canonical": "Brötchen",
        "menge": 1,
        "einheit": "stk",
        "preis": 0.39,
        "guess": "Laugenbrötchen",
        "orig": "Laugenbroetchen",
        "sort": 10,
        "cats": {
          "simple": "Lebensmittel/Brot & Backwaren",
          "medium": "Lebensmittel/Brot & Backwaren/Brot & Brötchen",
          "complex": "Lebensmittel/Brot & Backwaren/Brötchen"
        }
      },
      {
        "name": "Gurke Stück",
        "canonical": "Gurken",
        "menge": 1,
        "einheit": "stk",
        "preis": 1.19,
        "guess": "Salatgurke",
        "orig": "Gurke Stk",
        "sort": 11,
        "cats": {
          "simple": "Lebensmittel/Obst & Gemüse",
          "medium": "Lebensmittel/Obst & Gemüse/Gemüse",
          "complex": "Lebensmittel/Obst & Gemüse/Gemüse"
        }
      },
      {
        "name": "Gurke Stück",
        "canonical": "Gurken",
        "menge": 1,
        "einheit": "stk",
        "preis": 1.19,
        "guess": "Salatgurke",
        "orig": "Gurke Stk",
        "sort": 12,
        "cats": {
          "simple": "Lebensmittel/Obst & Gemüse",
          "medium": "Lebensmittel/Obst & Gemüse/Gemüse",
          "complex": "Lebensmittel/Obst & Gemüse/Gemüse"
        }
      },
      {
        "name": "BBQ Sauce 300ml",
        "canonical": "Barbecue Sauce",
        "menge": 300,
        "einheit": "ml",
        "preis": 1.39,
        "guess": "Barbecue Sauce",
        "orig": "BBQ Sauce 300ml",
        "sort": 13,
        "cats": {
          "simple": "Lebensmittel/Saucen & Gewürze",
          "medium": "Lebensmittel/Saucen & Gewürze/Saucen",
          "complex": "Lebensmittel/Saucen & Gewürze/Barbecue & Grillsaucen"
        }
      },
      {
        "name": "Sonnentomaten lose",
        "canonical": "Mini Tomaten",
        "menge": 0.518,
        "einheit": "kg",
        "preis": 2.37,
        "guess": "Cherry-/Sonnentomaten",
        "orig": "Sonnentomaten lose 0,518 kg x 4,58 EUR/kg",
        "sort": 14,
        "cats": {
          "simple": "Lebensmittel/Obst & Gemüse",
          "medium": "Lebensmittel/Obst & Gemüse/Gemüse",
          "complex": "Lebensmittel/Obst & Gemüse/Gemüse"
        }
      }
    ]
  },
  {
    "store": "Kaufland Tübingen",
    "total": 108.92,
    "daysAgo": 7,
    "image": "/demo-receipts/demo-1-kaufland.jpg",
    "items": [
      {
        "name": "SWM H-Milch Protein",
        "canonical": "Proteinmilch",
        "menge": 12,
        "einheit": "stk",
        "preis": 23.88,
        "guess": "Haltbarmilch mit Protein",
        "orig": "SWM H-MilchProtein 12*1,99",
        "sort": 0,
        "cats": {
          "simple": "Lebensmittel/Molkerei & Eier",
          "medium": "Lebensmittel/Molkerei & Eier/Milch & Milchgetränke",
          "complex": "Lebensmittel/Molkerei & Eier/Proteinmilch & Drinks"
        }
      },
      {
        "name": "Bio Haltbarmilch 3,5%",
        "canonical": "Milch",
        "menge": 12,
        "einheit": "stk",
        "preis": 23.88,
        "guess": "Bio H-Milch",
        "orig": "Biol.H-Milch 3,5 12*1,99",
        "sort": 1,
        "cats": {
          "simple": "Lebensmittel/Molkerei & Eier",
          "medium": "Lebensmittel/Molkerei & Eier/Milch & Milchgetränke",
          "complex": "Lebensmittel/Molkerei & Eier/Milch"
        }
      },
      {
        "name": "K-Classic Gouda Scheiben",
        "canonical": "Gouda in Scheiben",
        "menge": 2,
        "einheit": "stk",
        "preis": 4.9,
        "guess": "Gouda Käsescheiben",
        "orig": "KLC.Gouda.Sch. 2*2,45",
        "sort": 2,
        "cats": {
          "simple": "Lebensmittel/Molkerei & Eier",
          "medium": "Lebensmittel/Molkerei & Eier/Käse",
          "complex": "Lebensmittel/Molkerei & Eier/Schnittkäse"
        }
      },
      {
        "name": "K-Classic Joghurt griechischer Art",
        "canonical": "Griechischer Joghurt",
        "menge": 3,
        "einheit": "stk",
        "preis": 6.57,
        "guess": "Griechischer Joghurt",
        "orig": "K.Jogh. grie. Art 3*2,19",
        "sort": 3,
        "cats": {
          "simple": "Lebensmittel/Molkerei & Eier",
          "medium": "Lebensmittel/Molkerei & Eier/Joghurt",
          "complex": "Lebensmittel/Molkerei & Eier/Griechischer Joghurt"
        }
      },
      {
        "name": "Eier Freilandhaltung",
        "canonical": "Bio Eier",
        "menge": 1,
        "einheit": "stk",
        "preis": 4.29,
        "guess": "Freilandeier",
        "orig": "Eier Freilandhalt.",
        "sort": 4,
        "cats": {
          "simple": "Lebensmittel/Molkerei & Eier",
          "medium": "Lebensmittel/Molkerei & Eier/Eier",
          "complex": "Lebensmittel/Molkerei & Eier/Bio-Eier"
        }
      },
      {
        "name": "Äpfel Pink Lady 900g",
        "canonical": "Äpfel",
        "menge": 900,
        "einheit": "g",
        "preis": 2.99,
        "guess": "Pink Lady Äpfel",
        "orig": "Äpfel Pink 900g",
        "sort": 5,
        "cats": {
          "simple": "Lebensmittel/Obst & Gemüse",
          "medium": "Lebensmittel/Obst & Gemüse/Obst",
          "complex": "Lebensmittel/Obst & Gemüse/Obst"
        }
      },
      {
        "name": "K-Classic Gouda mittelalt 450g",
        "canonical": "Gouda mittelalt",
        "menge": 450,
        "einheit": "g",
        "preis": 4.29,
        "guess": "Gouda Käse",
        "orig": "KLC Gou.mitt.450g",
        "sort": 6,
        "cats": {
          "simple": "Lebensmittel/Molkerei & Eier",
          "medium": "Lebensmittel/Molkerei & Eier/Käse",
          "complex": "Lebensmittel/Molkerei & Eier/Schnittkäse"
        }
      },
      {
        "name": "Monster Energy Fiesta Mango",
        "canonical": "Monster Energy",
        "menge": 1,
        "einheit": "stk",
        "preis": 1.49,
        "guess": "Energy Drink",
        "orig": "Monster Fiesta Man",
        "sort": 7,
        "cats": {
          "simple": "Getränke/Softdrinks & Energy",
          "medium": "Getränke/Softdrinks & Energy/Energy Drinks",
          "complex": "Getränke/Softdrinks & Energy/Energy Drinks"
        }
      },
      {
        "name": "Pfand",
        "canonical": "Pfand",
        "menge": 1,
        "einheit": "stk",
        "preis": 0.25,
        "guess": "Flaschenpfand",
        "orig": "Pfandartikel",
        "sort": 8,
        "cats": {
          "simple": "Meta/Pfand",
          "medium": "Meta/Pfand",
          "complex": "Meta/Pfand"
        }
      },
      {
        "name": "Chili 50g",
        "canonical": "Chilis",
        "menge": 50,
        "einheit": "g",
        "preis": 1.99,
        "guess": "Chilischoten",
        "orig": "Chili 50g",
        "sort": 9,
        "cats": {
          "simple": "Lebensmittel/Saucen & Gewürze",
          "medium": "Lebensmittel/Saucen & Gewürze/Gewürze & Kräuter",
          "complex": "Lebensmittel/Obst & Gemüse/Gemüse"
        }
      },
      {
        "name": "K-Classic Schupfnudeln",
        "canonical": "Schupfnudeln",
        "menge": 1,
        "einheit": "stk",
        "preis": 1.89,
        "guess": "Schupfnudeln",
        "orig": "K.Schupfnudeln",
        "sort": 10,
        "cats": {
          "simple": "Lebensmittel/Nudeln, Reis & Trockenware",
          "medium": "Lebensmittel/Nudeln, Reis & Trockenware/Nudeln & Spätzle",
          "complex": "Lebensmittel/Nudeln, Reis & Trockenware/Spätzle & Knöpfle"
        }
      },
      {
        "name": "K-Classic Haferflocken zart",
        "canonical": "Haferflocken",
        "menge": 2,
        "einheit": "stk",
        "preis": 1.38,
        "guess": "Zarte Haferflocken",
        "orig": "KLC Haferfl.zart 2*0,69",
        "sort": 11,
        "cats": {
          "simple": "Lebensmittel/Nudeln, Reis & Trockenware",
          "medium": "Lebensmittel/Nudeln, Reis & Trockenware/Getreide & Müsli",
          "complex": "Lebensmittel/Nudeln, Reis & Trockenware/Müsli & Cerealien"
        }
      },
      {
        "name": "K-Purland Hähnchenbrustfilet",
        "canonical": "Hähnchenbrust",
        "menge": 1,
        "einheit": "stk",
        "preis": 9.99,
        "guess": "Hähnchenbrustfilet",
        "orig": "KPur.H.Brustfilet",
        "sort": 12,
        "cats": {
          "simple": "Lebensmittel/Fleisch & Fisch",
          "medium": "Lebensmittel/Fleisch & Fisch/Fleisch & Wurst",
          "complex": "Lebensmittel/Fleisch & Fisch/Geflügel"
        }
      },
      {
        "name": "Dallmayr Classic",
        "canonical": "Kaffeepulver",
        "menge": 1,
        "einheit": "stk",
        "preis": 6.99,
        "guess": "Kaffee",
        "orig": "Dall.Classic",
        "sort": 13,
        "cats": {
          "simple": "Getränke/Kaffee & Tee",
          "medium": "Getränke/Kaffee & Tee/Kaffee",
          "complex": "Getränke/Kaffee & Tee/Kaffeepulver"
        }
      },
      {
        "name": "K-Classic Peanut Butter",
        "canonical": "Eisbecher",
        "menge": 1,
        "einheit": "stk",
        "preis": 2.79,
        "guess": "Erdnussbutter",
        "orig": "K.Peanut Butter",
        "sort": 14,
        "cats": {
          "simple": "Lebensmittel/Süßes & Gebäck",
          "medium": "Lebensmittel/Süßes & Gebäck/Speiseeis",
          "complex": "Haushalt/Küchenzubehör/Dessertbecher & Eisbecher"
        }
      },
      {
        "name": "K-Classic No Sugar Eis",
        "canonical": "Eisbecher",
        "menge": 1,
        "einheit": "stk",
        "preis": 2.99,
        "guess": "Zuckerfreies Eis",
        "orig": "K.NoSugarEis",
        "sort": 15,
        "cats": {
          "simple": "Lebensmittel/Süßes & Gebäck",
          "medium": "Lebensmittel/Süßes & Gebäck/Speiseeis",
          "complex": "Haushalt/Küchenzubehör/Dessertbecher & Eisbecher"
        }
      },
      {
        "name": "Bananen",
        "canonical": "Bananen",
        "menge": 1.152,
        "einheit": "kg",
        "preis": 1.49,
        "guess": "Bananen",
        "orig": "Bananen kg 1,152 kg",
        "sort": 16,
        "cats": {
          "simple": "Lebensmittel/Obst & Gemüse",
          "medium": "Lebensmittel/Obst & Gemüse/Obst",
          "complex": "Lebensmittel/Obst & Gemüse/Obst"
        }
      },
      {
        "name": "Mini Romatomaten 500g",
        "canonical": "Mini Tomaten",
        "menge": 500,
        "einheit": "g",
        "preis": 1.89,
        "guess": "Cherry Romatomaten",
        "orig": "Miniromato. 500g",
        "sort": 17,
        "cats": {
          "simple": "Lebensmittel/Obst & Gemüse",
          "medium": "Lebensmittel/Obst & Gemüse/Gemüse",
          "complex": "Lebensmittel/Obst & Gemüse/Gemüse"
        }
      },
      {
        "name": "Zwiebeln 2kg",
        "canonical": "Zwiebeln",
        "menge": 2,
        "einheit": "kg",
        "preis": 2.49,
        "guess": "Speisezwiebeln",
        "orig": "Zwiebeln 2kg",
        "sort": 18,
        "cats": {
          "simple": "Lebensmittel/Obst & Gemüse",
          "medium": "Lebensmittel/Obst & Gemüse/Gemüse",
          "complex": "Lebensmittel/Obst & Gemüse/Gemüse"
        }
      },
      {
        "name": "Eier aus Bodenhaltung",
        "canonical": "Eier Bodenhaltung",
        "menge": 1,
        "einheit": "stk",
        "preis": 2.49,
        "guess": "Eier",
        "orig": "Eier Bodenhaltung",
        "sort": 19,
        "cats": {
          "simple": "Lebensmittel/Molkerei & Eier",
          "medium": "Lebensmittel/Molkerei & Eier/Eier",
          "complex": "Lebensmittel/Molkerei & Eier/Eier Bodenhaltung"
        }
      }
    ]
  },
  {
    "store": "BAUHAUS Reutlingen",
    "total": 73.06,
    "daysAgo": 9,
    "image": "/demo-receipts/demo-5-bauhaus.jpg",
    "items": [
      {
        "name": "Helichrysum bracteatum",
        "canonical": "Strohblume (Pflanze)",
        "menge": 1,
        "einheit": "stk",
        "preis": 3.99,
        "guess": "Strohblume (Pflanze)",
        "orig": "Helichrysum bracteat",
        "sort": 0,
        "cats": {
          "simple": "Pflanzen & Garten/Kräuter & Pflanzen",
          "medium": "Pflanzen & Garten/Kräuter & Pflanzen/Zierpflanzen",
          "complex": "Pflanzen & Garten/Kräuter & Pflanzen/Zierpflanzen"
        }
      },
      {
        "name": "Helianthus annuus",
        "canonical": "Sonnenblumensamen",
        "menge": 1,
        "einheit": "stk",
        "preis": 2.99,
        "guess": "Sonnenblume (Pflanze)",
        "orig": "Helianthus annuus 13",
        "sort": 1,
        "cats": {
          "simple": "Pflanzen & Garten/Kräuter & Pflanzen",
          "medium": "Pflanzen & Garten/Kräuter & Pflanzen/Zierpflanzen",
          "complex": "Pflanzen & Garten/Kräuter & Pflanzen/Samen"
        }
      },
      {
        "name": "Untersetzer XL D28,2",
        "canonical": "Pflanzenuntersetzer XL",
        "menge": 1,
        "einheit": "stk",
        "preis": 9.99,
        "guess": "Pflanzenuntersetzer XL",
        "orig": "UNTERSETZER XL D28,2",
        "sort": 2,
        "cats": {
          "simple": "Pflanzen & Garten/Pflanzzubehör",
          "medium": "Pflanzen & Garten/Pflanzzubehör/Töpfe & Schalen",
          "complex": "Pflanzen & Garten/Pflanzzubehör/Untersetzer & Schalen"
        }
      },
      {
        "name": "Pflanzschale Wave",
        "canonical": "Pflanzschale",
        "menge": 1,
        "einheit": "stk",
        "preis": 9.99,
        "guess": "Pflanzschale",
        "orig": "PFLANZSCHALE WAVE",
        "sort": 3,
        "cats": {
          "simple": "Pflanzen & Garten/Pflanzzubehör",
          "medium": "Pflanzen & Garten/Pflanzzubehör/Töpfe & Schalen",
          "complex": "Pflanzen & Garten/Pflanzzubehör/Untersetzer & Schalen"
        }
      },
      {
        "name": "Pflanztopf Tonrot",
        "canonical": "Terracotta-Pflanztopf",
        "menge": 3,
        "einheit": "stk",
        "preis": 17.97,
        "guess": "Terracotta-Pflanztopf",
        "orig": "PFLANZTOPF TONROT 3 ST x 5,99 EUR",
        "sort": 4,
        "cats": {
          "simple": "Pflanzen & Garten/Pflanzzubehör",
          "medium": "Pflanzen & Garten/Pflanzzubehör/Töpfe & Schalen",
          "complex": "Pflanzen & Garten/Pflanzzubehör/Pflanztöpfe"
        }
      },
      {
        "name": "Lavandula angustifolia",
        "canonical": "Lavendel (Pflanze)",
        "menge": 1,
        "einheit": "stk",
        "preis": 7.99,
        "guess": "Lavendel (Pflanze)",
        "orig": "Lavandula angustifol",
        "sort": 5,
        "cats": {
          "simple": "Pflanzen & Garten/Kräuter & Pflanzen",
          "medium": "Pflanzen & Garten/Kräuter & Pflanzen/Kräuter",
          "complex": "Pflanzen & Garten/Kräuter & Pflanzen/Zierpflanzen"
        }
      },
      {
        "name": "Greenbar Cocktailminze",
        "canonical": "Cocktailminze (Kräuterpflanze)",
        "menge": 1,
        "einheit": "stk",
        "preis": 3.29,
        "guess": "Cocktailminze (Kräuterpflanze)",
        "orig": "GREENBAR Cocktailmin",
        "sort": 6,
        "cats": {
          "simple": "Pflanzen & Garten/Kräuter & Pflanzen",
          "medium": "Pflanzen & Garten/Kräuter & Pflanzen/Kräuter",
          "complex": "Pflanzen & Garten/Kräuter & Pflanzen/Kräuter"
        }
      },
      {
        "name": "Bio Thymus vulgaris",
        "canonical": "Bio-Thymian",
        "menge": 1,
        "einheit": "stk",
        "preis": 3.49,
        "guess": "Bio Thymian (Pflanze)",
        "orig": "Bio Thymus vulgaris",
        "sort": 7,
        "cats": {
          "simple": "Pflanzen & Garten/Kräuter & Pflanzen",
          "medium": "Pflanzen & Garten/Kräuter & Pflanzen/Kräuter",
          "complex": "Pflanzen & Garten/Kräuter & Pflanzen/Bio-Kräuter"
        }
      },
      {
        "name": "Greenbar Currykraut",
        "canonical": "Currykraut",
        "menge": 1,
        "einheit": "stk",
        "preis": 3.29,
        "guess": "Currykraut (Kräuterpflanze)",
        "orig": "GREENBAR Currykraut",
        "sort": 8,
        "cats": {
          "simple": "Pflanzen & Garten/Kräuter & Pflanzen",
          "medium": "Pflanzen & Garten/Kräuter & Pflanzen/Kräuter",
          "complex": "Pflanzen & Garten/Kräuter & Pflanzen/Kräuter"
        }
      },
      {
        "name": "Greenbar Rosmarin",
        "canonical": "Rosmarin (Kräuterpflanze)",
        "menge": 1,
        "einheit": "stk",
        "preis": 3.29,
        "guess": "Rosmarin (Kräuterpflanze)",
        "orig": "GREENBAR Rosmarin",
        "sort": 9,
        "cats": {
          "simple": "Pflanzen & Garten/Kräuter & Pflanzen",
          "medium": "Pflanzen & Garten/Kräuter & Pflanzen/Kräuter",
          "complex": "Pflanzen & Garten/Kräuter & Pflanzen/Kräuter"
        }
      },
      {
        "name": "Thymus citriodorus",
        "canonical": "Zitronenthymian",
        "menge": 1,
        "einheit": "stk",
        "preis": 3.49,
        "guess": "Zitronenthymian (Pflanze)",
        "orig": "Thymus limone 14",
        "sort": 10,
        "cats": {
          "simple": "Pflanzen & Garten/Kräuter & Pflanzen",
          "medium": "Pflanzen & Garten/Kräuter & Pflanzen/Kräuter",
          "complex": "Pflanzen & Garten/Kräuter & Pflanzen/Kräuter"
        }
      },
      {
        "name": "Greenbar Basilikum",
        "canonical": "Tomatensauce Basilikum",
        "menge": 1,
        "einheit": "stk",
        "preis": 3.29,
        "guess": "Basilikum (Kräuterpflanze)",
        "orig": "GREENBAR Basilikum",
        "sort": 11,
        "cats": {
          "simple": "Lebensmittel/Saucen & Gewürze",
          "medium": "Lebensmittel/Saucen & Gewürze/Saucen",
          "complex": "Lebensmittel/Saucen & Gewürze/Tomatensaucen"
        }
      }
    ]
  },
  {
    "store": "LIDL Gomaringen",
    "total": 61.49,
    "daysAgo": 12,
    "image": "/demo-receipts/demo-2-lidl.jpg",
    "items": [
      {
        "name": "Banane lose",
        "canonical": "Bananen",
        "menge": 1.496,
        "einheit": "kg",
        "preis": 1.93,
        "guess": "Bananen",
        "orig": "Banane lose",
        "sort": 10,
        "cats": {
          "simple": "Lebensmittel/Obst & Gemüse",
          "medium": "Lebensmittel/Obst & Gemüse/Obst",
          "complex": "Lebensmittel/Obst & Gemüse/Obst"
        }
      },
      {
        "name": "Griechischer Joghurt 10%",
        "canonical": "Joghurt",
        "menge": 2,
        "einheit": "stk",
        "preis": 4.38,
        "guess": "Griechischer Joghurt",
        "orig": "Griech.Joghurt10%",
        "sort": 20,
        "cats": {
          "simple": "Lebensmittel/Molkerei & Eier",
          "medium": "Lebensmittel/Molkerei & Eier/Joghurt",
          "complex": "Lebensmittel/Molkerei & Eier/Griechischer Joghurt"
        }
      },
      {
        "name": "Eierknöpfle",
        "canonical": "Eierknöpfle",
        "menge": 1,
        "einheit": "stk",
        "preis": 2.79,
        "guess": "Eierspätzle",
        "orig": "Eierknöpfle",
        "sort": 30,
        "cats": {
          "simple": "Lebensmittel/Nudeln, Reis & Trockenware",
          "medium": "Lebensmittel/Nudeln, Reis & Trockenware/Nudeln & Spätzle",
          "complex": "Lebensmittel/Nudeln, Reis & Trockenware/Spätzle & Knöpfle"
        }
      },
      {
        "name": "Feine Buabenspätzle",
        "canonical": "Buabaspitzle",
        "menge": 1,
        "einheit": "stk",
        "preis": 1.89,
        "guess": "Spätzle",
        "orig": "Feine Buabaspitzle",
        "sort": 40,
        "cats": {
          "simple": "Lebensmittel/Nudeln, Reis & Trockenware",
          "medium": "Lebensmittel/Nudeln, Reis & Trockenware/Nudeln & Spätzle",
          "complex": "Lebensmittel/Nudeln, Reis & Trockenware/Spätzle & Knöpfle"
        }
      },
      {
        "name": "Gazi Käse Natur",
        "canonical": "Grillkäse",
        "menge": 2,
        "einheit": "stk",
        "preis": 5.98,
        "guess": "Gazi Hirtenkäse Natur",
        "orig": "GAZI Käse Natur",
        "sort": 50,
        "cats": {
          "simple": "Lebensmittel/Molkerei & Eier",
          "medium": "Lebensmittel/Molkerei & Eier/Käse",
          "complex": "Lebensmittel/Molkerei & Eier/Grillkäse"
        }
      },
      {
        "name": "Irische Butter",
        "canonical": "Irische Butter",
        "menge": 2,
        "einheit": "stk",
        "preis": 3.78,
        "guess": "Butter",
        "orig": "Irische Butter",
        "sort": 60,
        "cats": {
          "simple": "Lebensmittel/Molkerei & Eier",
          "medium": "Lebensmittel/Molkerei & Eier",
          "complex": "Lebensmittel/Molkerei & Eier/Frischkäse"
        }
      },
      {
        "name": "Frischkäse Sahnig",
        "canonical": "Frischkäse",
        "menge": 1,
        "einheit": "stk",
        "preis": 1.59,
        "guess": "Frischkäse",
        "orig": "Frischkäse Sahnige",
        "sort": 70,
        "cats": {
          "simple": "Lebensmittel/Molkerei & Eier",
          "medium": "Lebensmittel/Molkerei & Eier/Käse",
          "complex": "Lebensmittel/Molkerei & Eier/Frischkäse"
        }
      },
      {
        "name": "Patros Käse Gouda & Tomate",
        "canonical": "Grillkäse",
        "menge": 1,
        "einheit": "stk",
        "preis": 1.99,
        "guess": "Käse",
        "orig": "Patros Käse G&O Toma",
        "sort": 80,
        "cats": {
          "simple": "Lebensmittel/Molkerei & Eier",
          "medium": "Lebensmittel/Molkerei & Eier/Käse",
          "complex": "Lebensmittel/Molkerei & Eier/Grillkäse"
        }
      },
      {
        "name": "Thunfischsteak",
        "canonical": "Thunfisch",
        "menge": 12,
        "einheit": "stk",
        "preis": 16.68,
        "guess": "Thunfischsteak",
        "orig": "Thunfischsteak",
        "sort": 90,
        "cats": {
          "simple": "Lebensmittel/Fleisch & Fisch",
          "medium": "Lebensmittel/Fleisch & Fisch/Fisch",
          "complex": "Lebensmittel/Fleisch & Fisch/Fisch & Thunfisch"
        }
      },
      {
        "name": "Preisvorteil",
        "canonical": "Preisvorteil ",
        "menge": 1,
        "einheit": "stk",
        "preis": -1.2,
        "guess": "Preisvorteil ",
        "orig": "manuell hinzugefügt",
        "sort": 100,
        "cats": {
          "simple": "Meta/Rabatt",
          "medium": "Meta/Rabatt",
          "complex": "Meta/Rabatt"
        }
      },
      {
        "name": "Rabatt",
        "canonical": "Rabatt",
        "menge": 1,
        "einheit": "stk",
        "preis": -2.04,
        "guess": "Rabatt",
        "orig": "manuell hinzugefügt",
        "sort": 105,
        "cats": {
          "simple": "Meta/Rabatt",
          "medium": "Meta/Rabatt",
          "complex": "Meta/Rabatt"
        }
      },
      {
        "name": "Mineralwasser",
        "canonical": "Sprudel",
        "menge": 6,
        "einheit": "stk",
        "preis": 1.74,
        "guess": "Mineralwasser",
        "orig": "Mineralwasser",
        "sort": 110,
        "cats": {
          "simple": "Getränke/Wasser & Saft",
          "medium": "Getränke/Wasser & Saft/Wasser",
          "complex": "Getränke/Wasser & Saft/Mineralwasser"
        }
      },
      {
        "name": "Pfand 0,25 Einwegflasche",
        "canonical": "Pfand",
        "menge": 6,
        "einheit": "stk",
        "preis": 1.5,
        "guess": "Pfand",
        "orig": "Pfand 0.25 EM",
        "sort": 120,
        "cats": {
          "simple": "Meta/Pfand",
          "medium": "Meta/Pfand",
          "complex": "Meta/Pfand"
        }
      },
      {
        "name": "Energy Drink Zero",
        "canonical": "Energy Drink Zero",
        "menge": 4,
        "einheit": "stk",
        "preis": 2.76,
        "guess": "Energy Drink Zero",
        "orig": "Energy Drink Zero",
        "sort": 130,
        "cats": {
          "simple": "Getränke/Softdrinks & Energy",
          "medium": "Getränke/Softdrinks & Energy/Energy Drinks",
          "complex": "Getränke/Softdrinks & Energy/Energy Drinks Zero"
        }
      },
      {
        "name": "Pfand 0,25 Einwegflasche",
        "canonical": "Pfand",
        "menge": 4,
        "einheit": "stk",
        "preis": 1,
        "guess": "Pfand",
        "orig": "Pfand 0.25 EM",
        "sort": 140,
        "cats": {
          "simple": "Meta/Pfand",
          "medium": "Meta/Pfand",
          "complex": "Meta/Pfand"
        }
      },
      {
        "name": "Multivitaminsaft",
        "canonical": "Multivitaminsaft",
        "menge": 1,
        "einheit": "stk",
        "preis": 2.09,
        "guess": "Multivitaminsaft",
        "orig": "Multivitaminsaft",
        "sort": 150,
        "cats": {
          "simple": "Getränke/Wasser & Saft",
          "medium": "Getränke/Wasser & Saft/Saft",
          "complex": "Getränke/Wasser & Saft/Multivitaminsaft"
        }
      },
      {
        "name": "Katzentrockenfutter Lachs & Vollkorn",
        "canonical": "Katzentrockenfutter",
        "menge": 1,
        "einheit": "stk",
        "preis": 2.35,
        "guess": "Katzentrockenfutter",
        "orig": "Katzentr.Lachs&Vollk",
        "sort": 160,
        "cats": {
          "simple": "Tiernahrung/Katzenfutter",
          "medium": "Tiernahrung/Katzenfutter/Trockenfutter",
          "complex": "Tiernahrung/Katzenfutter/Trockenfutter"
        }
      },
      {
        "name": "Katzenfutter",
        "canonical": "Katzennassfutter",
        "menge": 1,
        "einheit": "stk",
        "preis": 2.29,
        "guess": "Katzenfutter",
        "orig": "Katzenfutter",
        "sort": 170,
        "cats": {
          "simple": "Tiernahrung/Katzenfutter",
          "medium": "Tiernahrung/Katzenfutter/Nassfutter",
          "complex": "Tiernahrung/Katzenfutter/Nassfutter"
        }
      },
      {
        "name": "Hähnchenbrustfilet",
        "canonical": "Hähnchenbrust",
        "menge": 1,
        "einheit": "stk",
        "preis": 9.99,
        "guess": "Hähnchenbrustfilet",
        "orig": "Hähnchenbrustfilet",
        "sort": 180,
        "cats": {
          "simple": "Lebensmittel/Fleisch & Fisch",
          "medium": "Lebensmittel/Fleisch & Fisch/Fleisch & Wurst",
          "complex": "Lebensmittel/Fleisch & Fisch/Geflügel"
        }
      }
    ]
  }
];
