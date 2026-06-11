#!/usr/bin/env node
/** Insert the 4 receipts that failed auto-import (user provided the data manually). */
import { readFileSync } from 'node:fs';
import { rename, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';

for (const l of readFileSync(path.join(import.meta.dirname, '.env'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}
const sql = postgres(process.env.DATABASE_URL_DEV, { onnotice: () => {} });
const SOURCE_ROOT = process.env.SOURCE_ROOT;

const RECEIPTS = [
  {
    file: 'photos/file_40.jpg',
    laden: 'Café Bäcker Mayer',
    kette: 'CAFE_BAECKER_MAYER',
    datum: '2026-03-02',
    gesamt: 5.82,
    artikel: [
      { name: 'Laugenstange', original_text: 'Laugenstange', ai_guess: 'Laugenstange', menge: 4, einheit: 'Stk', preis: 3.92, kategorie: 'Backwaren' },
      { name: 'Bella-Berliner', original_text: 'Bella-Berliner', ai_guess: 'Berliner', menge: 1, einheit: 'Stk', preis: 1.90, kategorie: 'Backwaren' },
    ],
  },
  {
    file: 'photos/file_68.jpg',
    laden: 'Shoe4You',
    kette: 'SHOE4YOU',
    datum: '2026-05-06',
    gesamt: 62.98,
    artikel: [
      { name: 'Kinder Hausschuhe Gr.23', original_text: 'Kinder Hausschuhe Gr. 23', ai_guess: 'Kinder Hausschuhe', menge: 1, einheit: 'Stk', preis: 32.99, kategorie: 'Kleidung' },
      { name: 'Kinder Hausschuhe Gr.26', original_text: 'Kinder Hausschuhe Gr.26', ai_guess: 'Kinder Hausschuhe', menge: 1, einheit: 'Stk', preis: 29.99, kategorie: 'Kleidung' },
    ],
  },
  {
    file: 'photos/file_51.jpg',
    laden: 'ALDI Süd Gomaringen',
    kette: 'ALDI_SUED',
    datum: '2026-04-02',
    gesamt: 72.77,
    artikel: [
      { name: 'Gartenhandschuhe',          original_text: 'Gartenhandschuhe',      ai_guess: 'Gartenhandschuhe',      preis: 1.99, kategorie: 'Garten' },
      { name: 'Profi Pinselset',           original_text: 'Profi Pinselset',       ai_guess: 'Pinselset',             preis: 2.49, kategorie: 'Hobby' },
      { name: 'Bio Haferpops',             original_text: 'Bio Haferpops',         ai_guess: 'Haferpops',             preis: 2.45, kategorie: 'Cerealien' },
      { name: 'Reibekuchen',               original_text: 'Reibekuchen',           ai_guess: 'Reibekuchen',           preis: 1.69, kategorie: 'Fertiggerichte' },
      { name: 'Flabatta',                  original_text: 'Flabatta',              ai_guess: 'Flabatta',              preis: 0.59, kategorie: 'Backwaren' },
      { name: 'Flabatta',                  original_text: 'Flabatta',              ai_guess: 'Flabatta',              preis: 0.59, kategorie: 'Backwaren' },
      { name: 'Gartengeräte Kind',         original_text: 'Gartengeräte Kind',     ai_guess: 'Gartengeräte für Kinder', preis: 2.49, kategorie: 'Garten' },
      { name: 'Haferflocken kernig',       original_text: 'Haferflocken kern.',    ai_guess: 'Haferflocken kernig',   preis: 0.69, kategorie: 'Cerealien' },
      { name: 'Haferflocken zart',         original_text: 'Haferflocken zart',     ai_guess: 'Haferflocken zart',     preis: 0.69, kategorie: 'Cerealien' },
      { name: 'Pistazien-Croissant',       original_text: 'PistazienCroissant',    ai_guess: 'Pistazien-Croissant',   preis: 0.99, kategorie: 'Backwaren' },
      { name: 'Gouda mittelalt am Stück',  original_text: 'Gouda mittelalt St',    ai_guess: 'Gouda mittelalt',       preis: 4.29, kategorie: 'Käse' },
      { name: 'Vegane Feinkost-Mix',       original_text: 'Veg. Feinkost-MiX',     ai_guess: 'Veganer Aufschnitt',    preis: 0.99, kategorie: 'Vegan' },
      { name: 'Frischkäse Natur',          original_text: 'Frischkaese Natur',     ai_guess: 'Frischkäse Natur',      preis: 1.59, kategorie: 'Milchprodukte' },
      { name: 'Hähnchenbrustfilet XXL',    original_text: 'Hähn. Brustf. XXL',     ai_guess: 'Hähnchenbrustfilet',    preis: 9.99, kategorie: 'Fleisch' },
      { name: 'Bio Zitrone/Limette',       original_text: 'Bio Zitrone/Limett',    ai_guess: 'Zitrone/Limette',       preis: 0.79, kategorie: 'Obst' },
      { name: 'Mini Stickerbuch',          original_text: 'Mini Stickerbücher',    ai_guess: 'Stickerbuch',           preis: 1.99, kategorie: 'Hobby' },
      { name: 'Mini Stickerbuch',          original_text: 'Mini Stickerbücher',    ai_guess: 'Stickerbuch',           preis: 1.99, kategorie: 'Hobby' },
      { name: 'Mini Stickerbuch',          original_text: 'Mini Stickerbücher',    ai_guess: 'Stickerbuch',           preis: 1.99, kategorie: 'Hobby' },
      { name: 'Mini Stickerbuch',          original_text: 'Mini Stickerbücher',    ai_guess: 'Stickerbuch',           preis: 1.99, kategorie: 'Hobby' },
      { name: 'Schatzsuche/Vorlesebuch',   original_text: 'Schatzsu/Vorleseb',     ai_guess: 'Kinderbuch',            preis: 2.99, kategorie: 'Hobby' },
      { name: 'Griechischer Joghurt 1kg',  original_text: 'Joghurt gr Art 1kg',    ai_guess: 'Griechischer Joghurt',  preis: 2.19, kategorie: 'Milchprodukte' },
      { name: 'Champignons braun 400g',    original_text: 'Champ. Braun 400g',     ai_guess: 'Champignons',           preis: 2.19, kategorie: 'Gemüse' },
      { name: 'Champignons braun 400g',    original_text: 'Champ. Braun 400g',     ai_guess: 'Champignons',           preis: 2.19, kategorie: 'Gemüse' },
      { name: 'Salatherzen 2er',           original_text: 'Salatherzen 2er',       ai_guess: 'Salatherzen',           preis: 0.99, kategorie: 'Gemüse' },
      { name: 'Bananen Bio',               original_text: 'Bananen Bio',           ai_guess: 'Bananen',               preis: 2.22, kategorie: 'Obst' },
      { name: 'Gurke',                     original_text: 'Gurke Stk',             ai_guess: 'Gurke',                 preis: 0.44, kategorie: 'Gemüse' },
      { name: 'Gurke',                     original_text: 'Gurke Stk',             ai_guess: 'Gurke',                 preis: 0.44, kategorie: 'Gemüse' },
      { name: 'Laugenbrötchen',            original_text: 'Laugenbroetchen',       ai_guess: 'Laugenbrötchen',        preis: 0.39, kategorie: 'Backwaren' },
      { name: 'Laugenbrötchen',            original_text: 'Laugenbroetchen',       ai_guess: 'Laugenbrötchen',        preis: 0.39, kategorie: 'Backwaren' },
      { name: 'BBQ Grillkäse',             original_text: 'BBQ Grillkäse',         ai_guess: 'Grillkäse',             preis: 1.99, kategorie: 'Käse' },
      { name: 'BBQ Grillkäse',             original_text: 'BBQ Grillkäse',         ai_guess: 'Grillkäse',             preis: 1.99, kategorie: 'Käse' },
      { name: 'Bio Tomaten 500g',          original_text: 'Bio Tomaten 500g',      ai_guess: 'Tomaten',               preis: 2.69, kategorie: 'Gemüse' },
      { name: 'Datteltomaten 500g',        original_text: 'Datteltomaten 500g',    ai_guess: 'Datteltomaten',         preis: 2.49, kategorie: 'Gemüse' },
      { name: 'Trauben hell 500g',         original_text: 'Trauben hell 500g',     ai_guess: 'Trauben',               preis: 2.19, kategorie: 'Obst' },
      { name: 'Schlagsahne 200g',          original_text: 'Schlagsahne 200g',      ai_guess: 'Schlagsahne',           preis: 0.89, kategorie: 'Milchprodukte' },
      { name: 'Creme Fraiche 200g',        original_text: 'Creme Fraiche 200g',    ai_guess: 'Creme Fraiche',         preis: 0.99, kategorie: 'Milchprodukte' },
      { name: 'Katzenfutter 85g',          original_text: 'Katzenfutter 85g',      ai_guess: 'Nassfutter',            preis: 0.45, kategorie: 'Katzenfutter' },
      { name: 'Katzenfutter 85g',          original_text: 'Katzenfutter 85g',      ai_guess: 'Nassfutter',            preis: 0.45, kategorie: 'Katzenfutter' },
      { name: 'Energy Drink SF 250ml',     original_text: 'Energy SF 250ml',       ai_guess: 'Energy Drink Zero',     preis: 0.29, kategorie: 'Energy Drinks' },
      { name: 'Pfand',                     original_text: 'Pfand',                 ai_guess: 'Pfand',                 preis: 0.25, kategorie: 'Pfand' },
      { name: 'Energy Drink 250ml',        original_text: 'Energy 250ml',          ai_guess: 'Energy Drink',          preis: 0.29, kategorie: 'Energy Drinks' },
      { name: 'Pfand',                     original_text: 'Pfand',                 ai_guess: 'Pfand',                 preis: 0.25, kategorie: 'Pfand' },
      { name: 'Katzenfutter 85g',          original_text: 'Katzenfutter 85g',      ai_guess: 'Nassfutter',            preis: 0.45, kategorie: 'Katzenfutter' },
      { name: 'Katzenfutter 85g',          original_text: 'Katzenfutter 85g',      ai_guess: 'Nassfutter',            preis: 0.45, kategorie: 'Katzenfutter' },
      { name: 'Acrylfarben 100ml',         original_text: 'Acrylfarben 100 ml',    ai_guess: 'Acrylfarben',           preis: 0.49, kategorie: 'Hobby' },
      { name: 'Acrylfarben 100ml',         original_text: 'Acrylfarben 100 ml',    ai_guess: 'Acrylfarben',           preis: 0.49, kategorie: 'Hobby' },
      { name: 'Acrylfarben 100ml',         original_text: 'Acrylfarben 100 ml',    ai_guess: 'Acrylfarben',           preis: 0.49, kategorie: 'Hobby' },
      { name: 'Acrylfarben 100ml',         original_text: 'Acrylfarben 100 ml',    ai_guess: 'Acrylfarben',           preis: 0.49, kategorie: 'Hobby' },
    ],
  },
  {
    file: 'photos/file_71.jpg',
    laden: 'LIDL Gomaringen',
    kette: 'LIDL',
    datum: '2026-05-16',
    gesamt: 137.55,
    artikel: [
      { name: 'Bananen lose',              original_text: 'Banane lose',           ai_guess: 'Bananen',               preis: 1.67, kategorie: 'Obst' },
      { name: 'Tomate Cherry',             original_text: 'Tomate Cherrys',        ai_guess: 'Cherry Tomaten',        preis: 3.36, kategorie: 'Gemüse' },
      { name: 'Snack Gurken',              original_text: 'Snack Gurken',          ai_guess: 'Snack Gurken',          preis: 5.07, kategorie: 'Gemüse' },
      { name: 'Blumensamen',               original_text: 'Blumensämereien',       ai_guess: 'Blumensamen',           preis: 0.19, kategorie: 'Garten' },
      { name: 'Blumensamen',               original_text: 'Blumensämereien',       ai_guess: 'Blumensamen',           preis: 0.19, kategorie: 'Garten' },
      { name: 'Wagner Piccolini Käse',     original_text: 'Wagner Piccoli. Käse',  ai_guess: 'Pizza Piccolini',       preis: 4.99, kategorie: 'Tiefkühl' },
      { name: 'Smoothie Erdbeer/Heidel.',  original_text: 'Smoothie Erdb.,Heid.',  ai_guess: 'Smoothie',              preis: 2.49, kategorie: 'Smoothies' },
      { name: 'Crispies',                  original_text: 'Crispies Crispies',     ai_guess: 'Crispies',              preis: 6.99, kategorie: 'Müsli' },
      { name: 'Billie Grüne Veg. Baguette', original_text: 'Billie Gr.veg.Baguet', ai_guess: 'Vegane Baguette',       preis: 1.69, kategorie: 'Vegan' },
      { name: 'Veg. Aufschnitt Mortadella', original_text: 'Veg.Aufs.Mortadella',  ai_guess: 'Veganer Aufschnitt',    preis: 2.38, kategorie: 'Vegan' },
      { name: 'Eierknöpfle',               original_text: 'Eierknöpfle',           ai_guess: 'Eierknöpfle',           preis: 3.78, kategorie: 'Teigwaren' },
      { name: 'Gouda mittelalt',           original_text: 'Gouda mittelalt',       ai_guess: 'Gouda mittelalt',       preis: 4.29, kategorie: 'Käse' },
      { name: 'Gouda in Scheiben XXL',     original_text: 'Gouda in ScheibenXXL',  ai_guess: 'Gouda in Scheiben',     preis: 3.49, kategorie: 'Käse' },
      { name: 'XXL Pizzateig',             original_text: 'XXL Pizzateig',         ai_guess: 'Pizzateig',             preis: 1.29, kategorie: 'Backzutaten' },
      { name: 'Vegane Leberwurst Fein',    original_text: 'Veg. Leberwurst Fein',  ai_guess: 'Vegane Leberwurst',     preis: 1.72, kategorie: 'Vegan' },
      { name: 'Griechischer Joghurt 10%',  original_text: 'Griech.Joghurt 10%',    ai_guess: 'Griechischer Joghurt',  preis: 8.76, kategorie: 'Milchprodukte' },
      { name: 'Bio Hummus Natur',          original_text: 'Bio Hummus Natur',      ai_guess: 'Hummus',                preis: 1.49, kategorie: 'Aufstriche' },
      { name: 'Falafel spicy',             original_text: 'Falafel spicy',         ai_guess: 'Falafel',               preis: 1.79, kategorie: 'Vegan' },
      { name: 'Vegane Rostbratwürstchen',  original_text: 'Vegan.Rostbratwürst.',  ai_guess: 'Vegane Bratwürste',     preis: 1.67, kategorie: 'Vegan' },
      { name: 'Falafel Knobi & Kräuter',   original_text: 'Falafel Knobl.&Krau.',  ai_guess: 'Falafel',               preis: 1.79, kategorie: 'Vegan' },
      { name: 'Schupfnudeln',              original_text: 'Schupfnudeln',          ai_guess: 'Schupfnudeln',          preis: 1.89, kategorie: 'Teigwaren' },
      { name: 'Feine Buabaspitzle',        original_text: 'Feine Buabaspitzle',    ai_guess: 'Buabaspitzle',          preis: 1.89, kategorie: 'Teigwaren' },
      { name: 'Milbona Mini Käse Snack',   original_text: 'Milbona Mini Käse Sn',  ai_guess: 'Mini Käse Snack',       preis: 1.99, kategorie: 'Käse' },
      { name: 'Knorr Delikatess Brühe',    original_text: 'Knorr Del. Brühe 161',  ai_guess: 'Brühe',                 preis: 2.89, kategorie: 'Würzen' },
      { name: 'Kurkuma gemahlen',          original_text: 'Kurkuma gemahlen',      ai_guess: 'Kurkuma',               preis: 0.85, kategorie: 'Gewürze' },
      { name: 'Curry 45g',                 original_text: 'Curry 45g',             ai_guess: 'Curry',                 preis: 0.85, kategorie: 'Gewürze' },
      { name: 'Eier Bodenhaltung 18er',    original_text: 'Eier Bodenhalt. 18er',  ai_guess: 'Eier',                  menge: 2, einheit: 'Pack', preis: 8.38, kategorie: 'Eier' },
      { name: 'Bio-Eier 10er',             original_text: 'Bio-Eier OKT 10er',     ai_guess: 'Bio Eier',              preis: 3.99, kategorie: 'Eier' },
      { name: 'Erdnussbutter Creamy',      original_text: 'Erdnussbutter Creamy',  ai_guess: 'Erdnussbutter',         preis: 2.79, kategorie: 'Aufstriche' },
      { name: 'Kaffee Gold UTZ',           original_text: 'Kaffee Gold UTZ',       ai_guess: 'Kaffeepulver',          preis: 5.99, kategorie: 'Kaffee' },
      { name: 'Preisvorteil',              original_text: 'Preisvorteil',          ai_guess: 'Rabatt',                preis: -0.20, kategorie: 'Rabatt' },
      { name: 'Jasmin Reis',               original_text: 'Jasmin Reis',           ai_guess: 'Jasmin Reis',           preis: 3.98, kategorie: 'Reis' },
      { name: 'Monster Zero Sugar',        original_text: 'Monster Zero Sugar',    ai_guess: 'Monster White Zero',    preis: 2.98, kategorie: 'Energy Drinks' },
      { name: 'Pfand',                     original_text: 'Pfand 0,25 M',          ai_guess: 'Pfand',                 preis: 0.50, kategorie: 'Pfand' },
      { name: 'Multivitaminsaft',          original_text: 'Multivitaminsaft',      ai_guess: 'Multivitaminsaft',      preis: 2.09, kategorie: 'Saft' },
      { name: 'Bio Tomatensaft',           original_text: 'Bio Tomatensaft',       ai_guess: 'Tomatensaft',           preis: 1.79, kategorie: 'Saft' },
      { name: 'Mineralwasser',             original_text: 'Mineralwasser',         ai_guess: 'Mineralwasser',         preis: 1.74, kategorie: 'Wasser' },
      { name: 'Pfand',                     original_text: 'Pfand 0,25 EM',         ai_guess: 'Pfand',                 preis: 1.50, kategorie: 'Pfand' },
      { name: 'Mixx Max',                  original_text: 'Mixx Max 1,51',         ai_guess: 'Mixx Max',              preis: 3.90, kategorie: 'Energy Drinks' },
      { name: 'Pfand',                     original_text: 'Pfand 0,25 EM',         ai_guess: 'Pfand',                 preis: 1.50, kategorie: 'Pfand' },
      { name: 'Brot Bauernmild',           original_text: 'Brot Bauernmil.',       ai_guess: 'Brot',                  preis: 1.85, kategorie: 'Brot' },
      { name: 'Vollkorn Toast',            original_text: 'Vollkorn Toast',        ai_guess: 'Vollkorn Toast',        preis: 0.79, kategorie: 'Brot' },
      { name: 'Katzentrockenfutter Lachs & Vollkorn', original_text: 'Katzentr.Lachs&Vollk', ai_guess: 'Trockenfutter', preis: 2.35, kategorie: 'Katzenfutter' },
      { name: 'Katzennassnahrung',         original_text: 'Katzennassnahru',       ai_guess: 'Nassfutter',            preis: 4.29, kategorie: 'Katzenfutter' },
      { name: 'Katzenstreu weiß',          original_text: 'Katzenstreu weiß',      ai_guess: 'Katzenstreu',           preis: 7.90, kategorie: 'Katzenstreu' },
      { name: 'Safa Hähnchenbrustfilet',   original_text: 'Safa -Hähnchenbrustf',  ai_guess: 'Hähnchenbrustfilet',    preis: 9.99, kategorie: 'Fleisch' },
    ],
  },
];

async function ensureFiliale(ladenName, kette) {
  let k = await sql`SELECT id FROM ladenkette WHERE LOWER(name) = LOWER(${kette})`;
  if (!k.length) k = await sql`INSERT INTO ladenkette (name) VALUES (${kette}) RETURNING id`;
  let f = await sql`SELECT id FROM filiale WHERE ladenkette_id = ${k[0].id} AND LOWER(name) = LOWER(${ladenName})`;
  if (!f.length) f = await sql`INSERT INTO filiale (ladenkette_id, name) VALUES (${k[0].id}, ${ladenName}) RETURNING id`;
  return f[0].id;
}

async function main() {
  // First: get rid of the duplicate Shoe4You file
  try {
    const trashDir = path.join(SOURCE_ROOT, '_deleted');
    try { await mkdir(trashDir, { recursive: true }); } catch { /* exists */ }
    const oldPath = path.join(SOURCE_ROOT, 'probablyWrong', 'SHOE4YOU_2026-05-07_025335_file_1.jpg');
    const newPath = path.join(trashDir, 'SHOE4YOU_2026-05-07_025335_file_1.jpg');
    await access(oldPath);
    await rename(oldPath, newPath);
    console.log(`✓ moved duplicate Shoe4You to _deleted/`);
  } catch (e) {
    console.log(`(skipped Shoe4You dup: ${e.code ?? e.message})`);
  }

  for (const r of RECEIPTS) {
    const filialeId = await ensureFiliale(r.laden, r.kette);
    const oldName = r.file.split('/').pop();
    const newName = `${r.kette}_${r.datum}_000000_${oldName}`;
    const bildPfad = `https://vds.giziko.online/receipts/${newName}`;

    const [e] = await sql`
      INSERT INTO einkauf (datum, filiale_id, gesamt_betrag, telegram_user, roh_ladenname, bild_pfad)
      VALUES (${r.datum}, ${filialeId}, ${r.gesamt}, 'manual-rescue', ${r.laden}, ${bildPfad})
      RETURNING id
    `;
    for (const a of r.artikel) {
      await sql`
        INSERT INTO artikel (einkauf_id, name, menge, einheit, preis, kategorie, original_text, ai_guess, canonical_name)
        VALUES (${e.id}, ${a.name}, ${a.menge ?? null}, ${a.einheit ?? ''}, ${a.preis}, ${a.kategorie}, ${a.original_text}, ${a.ai_guess}, NULL)
      `;
    }
    // Rename source file
    try {
      const src = path.join(SOURCE_ROOT, r.file);
      const dst = path.join(SOURCE_ROOT, newName);
      await rename(src, dst);
    } catch (err) {
      console.warn(`  (rename failed: ${err.message})`);
    }
    console.log(`✓ einkauf #${e.id}: ${r.laden} · ${r.datum} · ${r.gesamt}€ · ${r.artikel.length} items`);
  }

  await sql.end();
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
