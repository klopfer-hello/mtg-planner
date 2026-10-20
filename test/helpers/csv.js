// ManaBox collection export CSV for the import tests (binder export columns included).

export const MANABOX_HEADER = "Binder Name,Binder Type,Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID," +
  "Purchase price,Misprint,Altered,Condition,Language,Purchase price currency";

/** One export line; opts {type 'binder'|'deck'|'list', foil 'normal'|'foil'|'etched', price, condition, lang}. */
export function manaboxLine(binder, name, set, num, qty, id, { type = "binder", foil = "normal", price = "", condition = "near_mint", lang = "en" } = {}) {
  return [binder, type, `"${name}"`, set, "", num, foil, "", qty, "", id, price, "false", "false", condition, lang, price ? "EUR" : ""].join(",");
}

/** A whole export file of manaboxLine()s. */
export const manaboxCsv = (...lines) => [MANABOX_HEADER, ...lines].join("\n") + "\n";
