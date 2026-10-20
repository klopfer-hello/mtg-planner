// Collection export: the owned copies as a CSV file, either in ManaBox's own
// export layout (so the collection can go back into ManaBox, or into another
// mtg-planner, once the app is the collection master) or as a plain sheet for
// spreadsheets. One line per collection row (printing, finish, language,
// condition, binder, source); rows of all sources are exported. Prices are EUR
// only (the English twin's price for a foreign printing without its own, like
// everywhere else); never USD.

import { eurOf, parsePrices } from "./db.js";

export const EXPORT_FORMATS = ["manabox", "csv"];

// ManaBox's collection export columns, in its order (lib/manabox.js reads them back).
const MANABOX_COLUMNS = [
  "Binder Name", "Binder Type", "Name", "Set code", "Set name", "Collector number", "Foil", "Rarity", "Quantity",
  "ManaBox ID", "Scryfall ID", "Purchase price", "Misprint", "Altered", "Condition", "Language", "Purchase price currency",
];
const PLAIN_COLUMNS = [
  "name", "set", "set_name", "collector_number", "finish", "language", "condition", "binder", "quantity",
  "price_eur", "value_eur", "source", "scryfall_id",
];

const PRICE_KEY = { normal: "eur", foil: "eur_foil", etched: "eur_etched" };

/** One CSV field: quoted when it holds a comma, quote, line break or leading/trailing space. */
export function csvField(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvLine = (fields) => fields.map(csvField).join(",");

/**
 * The owned rows to export, sorted by binder, name, set and number. `binder` null = everything,
 * '' = Unsorted, else that binder (case-insensitive, like /api/collection). Each row carries
 * binder_type ('deck' when a ManaBox deck binder, else 'binder') and price_eur (per copy, or null).
 */
export function exportRows(db, { binder = null } = {}) {
  const where = binder == null ? "" : "WHERE col.binder = ? COLLATE NOCASE";
  const rows = db.prepare(
    `SELECT col.scryfall_id, col.finish, col.language, col.condition, col.binder, col.quantity, col.purchase_price,
            col.purchase_currency, col.source, c.name, c.set_code, c.set_name, c.collector_number, c.rarity, c.prices
       FROM collection col JOIN cards c ON c.scryfall_id = col.scryfall_id
       ${where}
      ORDER BY col.binder COLLATE NOCASE, c.name COLLATE NOCASE, c.set_code, c.collector_number, col.finish, col.language, col.condition`,
  ).all(...(binder == null ? [] : [String(binder)]));
  const deckBinders = new Set(db.prepare("SELECT lower(manabox_binder) AS b FROM decks WHERE manabox_binder IS NOT NULL").all().map((r) => r.b));
  return rows.map((r) => ({
    ...r,
    binder_type: r.binder && deckBinders.has(r.binder.toLowerCase()) ? "deck" : "binder",
    price_eur: eurOf(parsePrices(r.prices), PRICE_KEY[r.finish] ?? "eur") ?? null,
  }));
}

/** ManaBox-layout CSV text (header + one line per row, CRLF like ManaBox). */
export function manaboxCsv(rows) {
  const lines = [csvLine(MANABOX_COLUMNS)];
  for (const r of rows) {
    lines.push(csvLine([
      r.binder, r.binder_type, r.name, String(r.set_code || "").toUpperCase(), r.set_name, r.collector_number,
      r.finish, r.rarity, r.quantity, "", r.scryfall_id, r.purchase_price ?? "", "false", "false", r.condition,
      r.language, r.purchase_price != null ? r.purchase_currency || "EUR" : "",
    ]));
  }
  return lines.join("\r\n") + "\r\n";
}

/** Plain CSV for spreadsheets: EUR price per copy and value of the line. */
export function plainCsv(rows) {
  const money = (n) => (n == null ? "" : n.toFixed(2));
  const lines = [csvLine(PLAIN_COLUMNS)];
  for (const r of rows) {
    lines.push(csvLine([
      r.name, String(r.set_code || "").toUpperCase(), r.set_name, r.collector_number, r.finish, r.language, r.condition,
      r.binder, r.quantity, money(r.price_eur), money(r.price_eur == null ? null : r.price_eur * r.quantity), r.source,
      r.scryfall_id,
    ]));
  }
  return lines.join("\r\n") + "\r\n";
}

/** {text, rows} of the export in `format` (manabox | csv); throws on an unknown format. */
export function exportCollection(db, { format = "manabox", binder = null } = {}) {
  if (!EXPORT_FORMATS.includes(format)) throw new Error(`format must be ${EXPORT_FORMATS.join(" or ")}`);
  const rows = exportRows(db, { binder });
  return { rows: rows.length, text: format === "manabox" ? manaboxCsv(rows) : plainCsv(rows) };
}
