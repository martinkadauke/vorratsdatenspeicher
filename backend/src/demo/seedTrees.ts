// Hand-maintained demo seed data (the original generator was never committed — edit this
// file directly and keep it in sync with seedReceipts.ts).
// The three category trees a new DEMO household can choose between in the intro wizard
// ("simple" / "medium" / "complex"). They are the SAME tree at three depths: level 1 and 2 are
// identical in all three; medium adds a coarse level 3, complex a finer one. So a product moves
// predictably, e.g. Bio-Banane → "Obst & Gemüse" / "Obst" / "Bio-Obst".
// Meta/Pfand + Meta/Rabatt are NOT listed — they are system categories added separately.
// Pre-computed so choosing a granularity costs no AI tokens (see seedReceipts.ts).
// `en` feeds category.display_en: without it an English demo visitor gets a German tree,
// because every consumer falls back to `display` when display_en is NULL.

export interface DemoCategory { path: string; en?: string; emoji?: string }
export type DemoTreeKey = 'simple' | 'medium' | 'complex';

export const DEMO_TREES: Record<DemoTreeKey, DemoCategory[]> = {
  "simple": [
    {
      "path": "Lebensmittel",
      "en": "Groceries",
      "emoji": "🛒"
    },
    {
      "path": "Lebensmittel/Obst & Gemüse",
      "en": "Fruit & Vegetables"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier",
      "en": "Dairy & Eggs"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch",
      "en": "Meat & Fish"
    },
    {
      "path": "Lebensmittel/Brot & Backwaren",
      "en": "Bread & Bakery"
    },
    {
      "path": "Lebensmittel/Nudeln, Reis & Trockenware",
      "en": "Pasta, Rice & Dry Goods"
    },
    {
      "path": "Lebensmittel/Fertiggerichte & Snacks",
      "en": "Ready Meals & Snacks"
    },
    {
      "path": "Lebensmittel/Süßes & Gebäck",
      "en": "Sweets & Baked Goods"
    },
    {
      "path": "Lebensmittel/Saucen & Gewürze",
      "en": "Sauces & Seasonings"
    },
    {
      "path": "Getränke",
      "en": "Drinks",
      "emoji": "🥤"
    },
    {
      "path": "Getränke/Softdrinks & Energy",
      "en": "Soft Drinks & Energy"
    },
    {
      "path": "Getränke/Wasser & Saft",
      "en": "Water & Juice"
    },
    {
      "path": "Getränke/Kaffee & Tee",
      "en": "Coffee & Tea"
    },
    {
      "path": "Tiernahrung",
      "en": "Pet Food",
      "emoji": "🐾"
    },
    {
      "path": "Tiernahrung/Katzenfutter",
      "en": "Cat Food"
    },
    {
      "path": "Pflanzen & Garten",
      "en": "Plants & Garden",
      "emoji": "🌿"
    },
    {
      "path": "Pflanzen & Garten/Kräuter & Pflanzen",
      "en": "Herbs & Plants"
    },
    {
      "path": "Pflanzen & Garten/Pflanzzubehör",
      "en": "Garden Supplies"
    },
    {
      "path": "Drogerie & Körperpflege",
      "en": "Health & Beauty",
      "emoji": "🧴"
    },
    {
      "path": "Drogerie & Körperpflege/Haarpflege",
      "en": "Hair Care"
    },
    {
      "path": "Drogerie & Körperpflege/Dusche & Bad",
      "en": "Bath & Shower"
    },
    {
      "path": "Haushalt",
      "en": "Household",
      "emoji": "🧹"
    },
    {
      "path": "Haushalt/Reinigung",
      "en": "Cleaning"
    },
    {
      "path": "Haushalt/Papier & Hygiene",
      "en": "Paper & Hygiene"
    },
    {
      "path": "Haushalt/Textilien",
      "en": "Home Textiles"
    },
    {
      "path": "Haushalt/Küchenzubehör",
      "en": "Kitchenware"
    }
  ],
  "medium": [
    {
      "path": "Lebensmittel",
      "en": "Groceries",
      "emoji": "🛒"
    },
    {
      "path": "Lebensmittel/Obst & Gemüse",
      "en": "Fruit & Vegetables"
    },
    {
      "path": "Lebensmittel/Obst & Gemüse/Obst",
      "en": "Fruit"
    },
    {
      "path": "Lebensmittel/Obst & Gemüse/Gemüse",
      "en": "Vegetables"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier",
      "en": "Dairy & Eggs"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Milch & Milchgetränke",
      "en": "Milk & Milk Drinks"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Joghurt",
      "en": "Yoghurt"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Käse",
      "en": "Cheese"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Butter & Fette",
      "en": "Butter & Spreads"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Eier",
      "en": "Eggs"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch",
      "en": "Meat & Fish"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch/Fleisch & Wurst",
      "en": "Meat & Sausage"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch/Fisch",
      "en": "Fish"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch/Vegetarisch & Vegan",
      "en": "Vegetarian & Vegan"
    },
    {
      "path": "Lebensmittel/Brot & Backwaren",
      "en": "Bread & Bakery"
    },
    {
      "path": "Lebensmittel/Brot & Backwaren/Brot & Brötchen",
      "en": "Bread & Rolls"
    },
    {
      "path": "Lebensmittel/Nudeln, Reis & Trockenware",
      "en": "Pasta, Rice & Dry Goods"
    },
    {
      "path": "Lebensmittel/Nudeln, Reis & Trockenware/Nudeln & Spätzle",
      "en": "Pasta & Spaetzle"
    },
    {
      "path": "Lebensmittel/Nudeln, Reis & Trockenware/Getreide & Müsli",
      "en": "Cereals & Muesli"
    },
    {
      "path": "Lebensmittel/Fertiggerichte & Snacks",
      "en": "Ready Meals & Snacks"
    },
    {
      "path": "Lebensmittel/Fertiggerichte & Snacks/Knabbersnacks",
      "en": "Savoury Snacks"
    },
    {
      "path": "Lebensmittel/Süßes & Gebäck",
      "en": "Sweets & Baked Goods"
    },
    {
      "path": "Lebensmittel/Süßes & Gebäck/Kekse & Cookies",
      "en": "Biscuits & Cookies"
    },
    {
      "path": "Lebensmittel/Süßes & Gebäck/Speiseeis",
      "en": "Ice Cream"
    },
    {
      "path": "Lebensmittel/Saucen & Gewürze",
      "en": "Sauces & Seasonings"
    },
    {
      "path": "Lebensmittel/Saucen & Gewürze/Saucen",
      "en": "Sauces"
    },
    {
      "path": "Lebensmittel/Saucen & Gewürze/Gewürze & Kräuter",
      "en": "Herbs & Spices"
    },
    {
      "path": "Getränke",
      "en": "Drinks",
      "emoji": "🥤"
    },
    {
      "path": "Getränke/Softdrinks & Energy",
      "en": "Soft Drinks & Energy"
    },
    {
      "path": "Getränke/Softdrinks & Energy/Energy Drinks",
      "en": "Energy Drinks"
    },
    {
      "path": "Getränke/Wasser & Saft",
      "en": "Water & Juice"
    },
    {
      "path": "Getränke/Wasser & Saft/Wasser",
      "en": "Water"
    },
    {
      "path": "Getränke/Wasser & Saft/Saft",
      "en": "Juice"
    },
    {
      "path": "Getränke/Kaffee & Tee",
      "en": "Coffee & Tea"
    },
    {
      "path": "Getränke/Kaffee & Tee/Kaffee",
      "en": "Coffee"
    },
    {
      "path": "Tiernahrung",
      "en": "Pet Food",
      "emoji": "🐾"
    },
    {
      "path": "Tiernahrung/Katzenfutter",
      "en": "Cat Food"
    },
    {
      "path": "Tiernahrung/Katzenfutter/Nassfutter",
      "en": "Wet Food"
    },
    {
      "path": "Tiernahrung/Katzenfutter/Trockenfutter",
      "en": "Dry Food"
    },
    {
      "path": "Pflanzen & Garten",
      "en": "Plants & Garden",
      "emoji": "🌿"
    },
    {
      "path": "Pflanzen & Garten/Kräuter & Pflanzen",
      "en": "Herbs & Plants"
    },
    {
      "path": "Pflanzen & Garten/Kräuter & Pflanzen/Kräuter",
      "en": "Herbs"
    },
    {
      "path": "Pflanzen & Garten/Kräuter & Pflanzen/Zierpflanzen",
      "en": "Ornamental Plants"
    },
    {
      "path": "Pflanzen & Garten/Pflanzzubehör",
      "en": "Garden Supplies"
    },
    {
      "path": "Pflanzen & Garten/Pflanzzubehör/Töpfe & Schalen",
      "en": "Pots & Bowls"
    },
    {
      "path": "Drogerie & Körperpflege",
      "en": "Health & Beauty",
      "emoji": "🧴"
    },
    {
      "path": "Drogerie & Körperpflege/Haarpflege",
      "en": "Hair Care"
    },
    {
      "path": "Drogerie & Körperpflege/Haarpflege/Shampoo",
      "en": "Shampoo"
    },
    {
      "path": "Drogerie & Körperpflege/Haarpflege/Coloration",
      "en": "Hair Colour"
    },
    {
      "path": "Drogerie & Körperpflege/Dusche & Bad",
      "en": "Bath & Shower"
    },
    {
      "path": "Drogerie & Körperpflege/Dusche & Bad/Duschpflege",
      "en": "Shower Care"
    },
    {
      "path": "Haushalt",
      "en": "Household",
      "emoji": "🧹"
    },
    {
      "path": "Haushalt/Reinigung",
      "en": "Cleaning"
    },
    {
      "path": "Haushalt/Reinigung/Bad & WC",
      "en": "Bath & Toilet"
    },
    {
      "path": "Haushalt/Reinigung/Fenster & Glas",
      "en": "Windows & Glass"
    },
    {
      "path": "Haushalt/Papier & Hygiene",
      "en": "Paper & Hygiene"
    },
    {
      "path": "Haushalt/Papier & Hygiene/Papierprodukte",
      "en": "Paper Products"
    },
    {
      "path": "Haushalt/Papier & Hygiene/Feuchttücher",
      "en": "Wet Wipes"
    },
    {
      "path": "Haushalt/Textilien",
      "en": "Home Textiles"
    },
    {
      "path": "Haushalt/Textilien/Handtücher",
      "en": "Towels"
    },
    {
      "path": "Haushalt/Küchenzubehör",
      "en": "Kitchenware"
    },
    {
      "path": "Haushalt/Küchenzubehör/Geschirr & Becher",
      "en": "Dishes & Cups"
    }
  ],
  "complex": [
    {
      "path": "Lebensmittel",
      "en": "Groceries",
      "emoji": "🛒"
    },
    {
      "path": "Lebensmittel/Obst & Gemüse",
      "en": "Fruit & Vegetables"
    },
    {
      "path": "Lebensmittel/Obst & Gemüse/Bio-Obst",
      "en": "Organic Fruit"
    },
    {
      "path": "Lebensmittel/Obst & Gemüse/Obst",
      "en": "Fruit"
    },
    {
      "path": "Lebensmittel/Obst & Gemüse/Bio-Gemüse",
      "en": "Organic Vegetables"
    },
    {
      "path": "Lebensmittel/Obst & Gemüse/Gemüse",
      "en": "Vegetables"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier",
      "en": "Dairy & Eggs"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Milch",
      "en": "Milk"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Proteinmilch & Drinks",
      "en": "Protein Milk & Drinks"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Joghurt",
      "en": "Yoghurt"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Griechischer Joghurt",
      "en": "Greek Yoghurt"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Frischkäse",
      "en": "Cream Cheese"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Schnittkäse",
      "en": "Sliced Cheese"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Grillkäse",
      "en": "Grilling Cheese"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Butter & Fette",
      "en": "Butter & Spreads"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Bio-Eier",
      "en": "Organic Eggs"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Eier Freilandhaltung",
      "en": "Free-Range Eggs"
    },
    {
      "path": "Lebensmittel/Molkerei & Eier/Eier Bodenhaltung",
      "en": "Barn Eggs"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch",
      "en": "Meat & Fish"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch/Bacon & Speck",
      "en": "Bacon & Cured Meat"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch/Geflügel",
      "en": "Poultry"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch/Burger & Patties",
      "en": "Burgers & Patties"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch/Fisch & Thunfisch",
      "en": "Fish & Tuna"
    },
    {
      "path": "Lebensmittel/Fleisch & Fisch/Vegetarisch & Vegan",
      "en": "Vegetarian & Vegan"
    },
    {
      "path": "Lebensmittel/Brot & Backwaren",
      "en": "Bread & Bakery"
    },
    {
      "path": "Lebensmittel/Brot & Backwaren/Brötchen",
      "en": "Bread Rolls"
    },
    {
      "path": "Lebensmittel/Brot & Backwaren/Schwäbische Spezialitäten",
      "en": "Swabian Specialities"
    },
    {
      "path": "Lebensmittel/Nudeln, Reis & Trockenware",
      "en": "Pasta, Rice & Dry Goods"
    },
    {
      "path": "Lebensmittel/Nudeln, Reis & Trockenware/Nudeln",
      "en": "Pasta"
    },
    {
      "path": "Lebensmittel/Nudeln, Reis & Trockenware/Spätzle & Knöpfle",
      "en": "Spaetzle & Knoepfle"
    },
    {
      "path": "Lebensmittel/Nudeln, Reis & Trockenware/Gefüllte Teigwaren",
      "en": "Filled Pasta"
    },
    {
      "path": "Lebensmittel/Nudeln, Reis & Trockenware/Müsli & Cerealien",
      "en": "Muesli & Cereals"
    },
    {
      "path": "Lebensmittel/Fertiggerichte & Snacks",
      "en": "Ready Meals & Snacks"
    },
    {
      "path": "Lebensmittel/Fertiggerichte & Snacks/Knabbersnacks",
      "en": "Savoury Snacks"
    },
    {
      "path": "Lebensmittel/Süßes & Gebäck",
      "en": "Sweets & Baked Goods"
    },
    {
      "path": "Lebensmittel/Süßes & Gebäck/Kekse",
      "en": "Biscuits"
    },
    {
      "path": "Lebensmittel/Süßes & Gebäck/Cookies",
      "en": "Cookies"
    },
    {
      "path": "Lebensmittel/Süßes & Gebäck/Speiseeis",
      "en": "Ice Cream"
    },
    {
      "path": "Lebensmittel/Süßes & Gebäck/Dessert-Zubehör",
      "en": "Dessert Supplies"
    },
    {
      "path": "Lebensmittel/Saucen & Gewürze",
      "en": "Sauces & Seasonings"
    },
    {
      "path": "Lebensmittel/Saucen & Gewürze/Barbecue & Grillsaucen",
      "en": "Barbecue & Grill Sauces"
    },
    {
      "path": "Lebensmittel/Saucen & Gewürze/Tomatensaucen",
      "en": "Tomato Sauces"
    },
    {
      "path": "Lebensmittel/Saucen & Gewürze/Bio-Gewürzkräuter",
      "en": "Organic Culinary Herbs"
    },
    {
      "path": "Lebensmittel/Saucen & Gewürze/Gewürzkräuter",
      "en": "Culinary Herbs"
    },
    {
      "path": "Getränke",
      "en": "Drinks",
      "emoji": "🥤"
    },
    {
      "path": "Getränke/Softdrinks & Energy",
      "en": "Soft Drinks & Energy"
    },
    {
      "path": "Getränke/Softdrinks & Energy/Energy Drinks",
      "en": "Energy Drinks"
    },
    {
      "path": "Getränke/Softdrinks & Energy/Energy Drinks Zero",
      "en": "Zero-Sugar Energy Drinks"
    },
    {
      "path": "Getränke/Wasser & Saft",
      "en": "Water & Juice"
    },
    {
      "path": "Getränke/Wasser & Saft/Mineralwasser",
      "en": "Mineral Water"
    },
    {
      "path": "Getränke/Wasser & Saft/Multivitaminsaft",
      "en": "Multivitamin Juice"
    },
    {
      "path": "Getränke/Kaffee & Tee",
      "en": "Coffee & Tea"
    },
    {
      "path": "Getränke/Kaffee & Tee/Kaffeepulver",
      "en": "Ground Coffee"
    },
    {
      "path": "Tiernahrung",
      "en": "Pet Food",
      "emoji": "🐾"
    },
    {
      "path": "Tiernahrung/Katzenfutter",
      "en": "Cat Food"
    },
    {
      "path": "Tiernahrung/Katzenfutter/Nassfutter",
      "en": "Wet Food"
    },
    {
      "path": "Tiernahrung/Katzenfutter/Trockenfutter",
      "en": "Dry Food"
    },
    {
      "path": "Pflanzen & Garten",
      "en": "Plants & Garden",
      "emoji": "🌿"
    },
    {
      "path": "Pflanzen & Garten/Kräuter & Pflanzen",
      "en": "Herbs & Plants"
    },
    {
      "path": "Pflanzen & Garten/Kräuter & Pflanzen/Bio-Kräuter",
      "en": "Organic Herbs"
    },
    {
      "path": "Pflanzen & Garten/Kräuter & Pflanzen/Kräuter",
      "en": "Herbs"
    },
    {
      "path": "Pflanzen & Garten/Kräuter & Pflanzen/Zierpflanzen",
      "en": "Ornamental Plants"
    },
    {
      "path": "Pflanzen & Garten/Kräuter & Pflanzen/Samen",
      "en": "Seeds"
    },
    {
      "path": "Pflanzen & Garten/Pflanzzubehör",
      "en": "Garden Supplies"
    },
    {
      "path": "Pflanzen & Garten/Pflanzzubehör/Pflanztöpfe",
      "en": "Plant Pots"
    },
    {
      "path": "Pflanzen & Garten/Pflanzzubehör/Untersetzer & Schalen",
      "en": "Saucers & Bowls"
    },
    {
      "path": "Drogerie & Körperpflege",
      "en": "Health & Beauty",
      "emoji": "🧴"
    },
    {
      "path": "Drogerie & Körperpflege/Haarpflege",
      "en": "Hair Care"
    },
    {
      "path": "Drogerie & Körperpflege/Haarpflege/Shampoo",
      "en": "Shampoo"
    },
    {
      "path": "Drogerie & Körperpflege/Haarpflege/Coloration",
      "en": "Hair Colour"
    },
    {
      "path": "Drogerie & Körperpflege/Dusche & Bad",
      "en": "Bath & Shower"
    },
    {
      "path": "Drogerie & Körperpflege/Dusche & Bad/Duschgel & Schaumbad",
      "en": "Shower Gel & Bubble Bath"
    },
    {
      "path": "Haushalt",
      "en": "Household",
      "emoji": "🧹"
    },
    {
      "path": "Haushalt/Reinigung",
      "en": "Cleaning"
    },
    {
      "path": "Haushalt/Reinigung/WC-Reinigung",
      "en": "Toilet Cleaning"
    },
    {
      "path": "Haushalt/Reinigung/Fenster & Glas",
      "en": "Windows & Glass"
    },
    {
      "path": "Haushalt/Papier & Hygiene",
      "en": "Paper & Hygiene"
    },
    {
      "path": "Haushalt/Papier & Hygiene/Servietten",
      "en": "Napkins"
    },
    {
      "path": "Haushalt/Papier & Hygiene/Feuchttücher",
      "en": "Wet Wipes"
    },
    {
      "path": "Haushalt/Papier & Hygiene/Tragetaschen",
      "en": "Carrier Bags"
    },
    {
      "path": "Haushalt/Textilien",
      "en": "Home Textiles"
    },
    {
      "path": "Haushalt/Textilien/Handtücher",
      "en": "Towels"
    },
    {
      "path": "Haushalt/Küchenzubehör",
      "en": "Kitchenware"
    },
    {
      "path": "Haushalt/Küchenzubehör/Dessertbecher",
      "en": "Dessert Bowls"
    }
  ]
};
