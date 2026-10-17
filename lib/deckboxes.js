// Deck boxes: binders that hold a (physical) deck, and which deck owns them.
//
// A binder's effective type is the one the user picked (binders.type, v14),
// else the auto rule: deck-box names ("Deck box: X", ManaBox precon binders
// like "Commander Deck: X") and binders linked to a deck are deck boxes. The
// copies in a deck box are RESERVED for that box (lib/decks.js allocation):
// free only for the deck that owns it, "in deck box X · can be moved" for every
// other deck. Setting the type to anything else un-reserves a binder.
//
// Owner of a box: the deck whose box_binder (the explicit link, also set by
// "Put into deck box") or ManaBox binder names it; failing that a deck whose
// name is the binder name or "Deck box: <name>". A box without owner reserves
// its copies for nobody: the UI suggests a link when a deck's name closely
// matches (boxSuggestion), never links on its own.
//
// Kept free of lib/decks.js and lib/binders.js imports (both use it).

export const BINDER_TYPES = ["binder", "deck_box", "bulk", "trade", "other"];
export const DECK_BOX_PREFIX = "Deck box: ";
const MAX_BINDER_NAME = 100;
// "Deck box: X" and ManaBox precon binders ("Commander Deck: X", "Foundation Commander: X", ...).
const DECKISH_NAME = /^(?:deck box|[^:]*\b(?:commander|deck|precon)\b[^:]*):/i;

/** Auto type of a binder: 'deck_box' for deck-box names or a binder linked to a deck, else 'binder'. */
export function autoBinderType(name, linkedToDeck = false) {
  return linkedToDeck || DECKISH_NAME.test(String(name || "")) ? "deck_box" : "binder";
}

const boxNameOf = (deckName) => `${DECK_BOX_PREFIX}${deckName}`.slice(0, MAX_BINDER_NAME).trim();

/** lower(binder name) -> [{id, name, status}] of the decks boxed in, synced from or named like it. */
export function deckLinks(db) {
  const map = new Map();
  for (const d of db.prepare("SELECT id, name, status, box_binder, manabox_binder FROM decks ORDER BY id").all()) {
    for (const b of new Set([d.box_binder, d.manabox_binder, d.name].filter(Boolean).map((x) => x.toLowerCase()))) {
      if (!map.has(b)) map.set(b, []);
      map.get(b).push({ id: Number(d.id), name: d.name, status: d.status });
    }
  }
  return map;
}

/**
 * Every binder whose effective type is deck_box: Map lower(name) -> {name, owners:[{id, name,
 * status, via: 'link'|'manabox'|'name'}]} (owners empty = nobody's box; first = the shown one).
 */
export function deckBoxes(db) {
  const table = new Map(db.prepare("SELECT name, type FROM binders").all().map((r) => [r.name.toLowerCase(), r]));
  const names = new Map();
  for (const t of table.values()) names.set(t.name.toLowerCase(), t.name);
  for (const r of db.prepare("SELECT MIN(binder) AS name FROM collection WHERE binder <> '' GROUP BY lower(binder)").all()) {
    if (!names.has(r.name.toLowerCase())) names.set(r.name.toLowerCase(), r.name);
  }
  const links = deckLinks(db);
  const decks = db.prepare("SELECT id, name, status, box_binder, manabox_binder FROM decks ORDER BY id").all();
  const out = new Map();
  for (const [k, name] of names) {
    const set = table.get(k)?.type;
    const type = BINDER_TYPES.includes(set) ? set : autoBinderType(name, (links.get(k) ?? []).length > 0);
    if (type !== "deck_box") continue;
    const by = (via, test) => decks.filter(test).map((d) => ({ id: Number(d.id), name: d.name, status: d.status, via }));
    let owners = by("link", (d) => d.box_binder?.toLowerCase() === k);
    if (!owners.length) owners = by("manabox", (d) => d.manabox_binder?.toLowerCase() === k);
    if (!owners.length) owners = by("name", (d) => d.name.toLowerCase() === k || boxNameOf(d.name).toLowerCase() === k);
    out.set(k, { name, owners });
  }
  return out;
}

// Words that only say "this is a deck" and never tell two decks apart.
const FILLER = new Set(["deck", "decks", "box", "commander", "precon", "preconstructed", "edh", "cedh"]);

/** Name as comparable words: lower case, & = and, punctuation dropped, filler words removed. */
export function boxNameWords(name) {
  return String(name || "").toLowerCase().replace(/&/g, " and ").split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !FILLER.has(w));
}

/** Similarity 0..1 of two names (shared words / all words; needs ≥ 2 words in common unless equal). */
export function boxNameSimilarity(a, b) {
  const x = new Set(boxNameWords(a));
  const y = new Set(boxNameWords(b));
  if (!x.size || !y.size) return 0;
  const common = [...x].filter((w) => y.has(w)).length;
  const sim = common / new Set([...x, ...y]).size;
  return sim < 1 && common < 2 ? 0 : sim;
}

export const BOX_SUGGEST_MIN = 0.75;

/**
 * Deck that looks like the owner of an unowned deck box, {id, name, status, similarity} or null:
 * the closest deck name (≥ BOX_SUGGEST_MIN) among decks that own no existing box yet.
 */
export function boxSuggestion(binderName, decks, ownedDeckIds = new Set()) {
  let best = null;
  for (const d of decks) {
    if (ownedDeckIds.has(Number(d.id))) continue;
    const sim = boxNameSimilarity(binderName, d.name);
    if (sim >= BOX_SUGGEST_MIN && (!best || sim > best.similarity)) {
      best = { id: Number(d.id), name: d.name, status: d.status, similarity: Math.round(sim * 100) / 100 };
    }
  }
  return best;
}
