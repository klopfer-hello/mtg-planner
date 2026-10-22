// Deck text: the importable decklist export, buy lists ("Export list"), the
// compact deck text for Claude (get_deck / save_deck) and the ready-made
// answer summary save_deck hands the planner (plan v1.3.0: the model does not
// keep a length limit, so the numbers come from the app in a fixed shape).

import { formatPrice } from "./db.js";
import { accessoriesText } from "./accessories.js";
import { BOARDS } from "./deckrules.js";
import { powerLines } from "./deckpower.js";

/** ManaBox/Moxfield-importable text export. */
export function exportDeck(detail) {
  const label = { commander: "Commander", main: "Deck", side: "Sideboard", maybe: "Maybeboard" };
  const out = [];
  // The companion comes first in its own section, so a re-import keeps the flag.
  const companions = detail.cards.filter((c) => c.companion);
  if (companions.length) {
    out.push("Companion");
    for (const c of companions) out.push(`${c.quantity} ${c.name}${c.set_code ? ` (${c.set_code.toUpperCase()}) ${c.collector_number}` : ""}`);
  }
  for (const board of BOARDS) {
    const cards = detail.cards.filter((c) => c.board === board && !c.companion);
    if (!cards.length) continue;
    if (out.length) out.push("");
    out.push(label[board]);
    for (const c of cards) out.push(`${c.quantity} ${c.name}${c.set_code ? ` (${c.set_code.toUpperCase()}) ${c.collector_number}` : ""}`);
  }
  return out.join("\n") + "\n";
}

/**
 * A buy list as text ("<copies> <name>" per line, sorted by name), for the "Export list" buttons:
 * a deck's To buy (shopping.items, key to_buy/need) and the built decks' shortage (built.items, key short).
 */
export function buyListText(items, qtyKey = "need") {
  const lines = (items || [])
    .map((it) => ({ name: it.name, n: Number(it[qtyKey] ?? it.need ?? it.quantity) || 0 }))
    .filter((x) => x.name && x.n > 0)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .map((x) => `${x.n} ${x.name}`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/**
 * The commander's rules text plus the build-around rule, for the top of every deck text Claude reads
 * (#084: the planner judged a Yennett deck by mana value alone). '' without a commander.
 */
export function commanderPlanText(detail) {
  const cmd = detail.cards.filter((c) => c.board === "commander");
  if (!cmd.length) return "";
  return [
    ...cmd.map((c) => `Commander: ${c.card_name || c.name}: ${(c.oracle_text || "(text not known; read it with get_cards)").replace(/\n/g, " / ")}`),
    "Build around the commander: its text and the deck's theme decide every add and cut (they make the deck fun); anchors and staples are only hints.",
  ].join("\n");
}

/** Compact text rendering for Claude. */
export function deckToText(detail) {
  const status = detail.status === "built" ? "BUILT (physical deck, claims its cards)" : "idea (plan, claims nothing)";
  const lines = [`Deck #${detail.id} "${detail.name}"${detail.format ? ` [${detail.format}]` : ""} (source: ${detail.source}, status: ${status})`];
  const plan = commanderPlanText(detail);
  if (plan) lines.push(plan);
  if (detail.description) lines.push(`Notes (Markdown, update_deck_notes changes them):\n${detail.description}`);
  if (detail.box?.binder) lines.push(`Deck box: ${detail.box.binder} (locked binder: its copies are free for this deck, locked for all others).`);
  const built = detail.status === "built";
  const inUseEur = `~€${(detail.in_use_eur ?? 0).toFixed(2)}`;
  // in_use splits into copies other built decks claim and copies lying in locked binders.
  const inBoxes = detail.in_use_locked_count ?? 0;
  const inDecks = (detail.in_use_count ?? 0) - inBoxes;
  const boxNote = inBoxes ? ` In locked binders: ${inBoxes} cards (owned, locked for another deck or for all decks, can be moved over).` : "";
  const inUseNote = (!inDecks ? ""
    : built
      ? ` Shared with other built decks: ${inDecks} cards (CONFLICT: owned copies are needed by both built decks; buy extra ${inUseEur} to play all built decks at once).`
      : ` In other built decks: ${inDecks} cards (owned, can be moved over; buying them instead ${inUseEur}).`) + boxNote;
  lines.push(`Counts: ${BOARDS.map((b) => `${b} ${detail.counts[b]}`).join(", ")}. To buy (not owned at all): ${detail.to_buy_count} cards (~€${detail.to_buy_eur.toFixed(2)}).${inUseNote}`);
  const v = detail.value;
  if (v) {
    lines.push(`Value: €${v.total_eur.toFixed(2)} (owned €${v.owned_eur.toFixed(2)}, to buy €${v.to_buy_eur.toFixed(2)}; maybeboard €${v.maybe_eur.toFixed(2)})`
      + (v.no_eur_price ? `; ${v.no_eur_price} cards have no EUR price.` : "."));
  }
  if (detail.stats) lines.push(...powerLines(detail));
  const extras = accessoriesText(detail.accessories);
  if (extras) lines.push(extras);
  if (detail.conflicts?.length) {
    lines.push(`Conflicts (${detail.conflict_count}, cards also claimed by another built deck): ` + detail.conflicts.map((c) =>
      `${c.name} owned ${c.owned}, needed ${c.demand} (${c.decks.map((d) => `#${d.deck_id} ${d.name} ${d.quantity}x`).join(", ")})`).join("; "));
  }
  if (detail.shopping?.items.length) {
    const top = detail.shopping.items.slice(0, 10).map((it) => `${it.need}x ${it.name}${it.price_eur != null ? ` €${it.price_eur.toFixed(2)}` : ""}`);
    lines.push(`Shopping list: ${detail.shopping.items.length} cards, €${detail.shopping.total_eur.toFixed(2)}: ${top.join(", ")}${detail.shopping.items.length > 10 ? ", ..." : ""}`);
  }
  if (detail.shopping?.in_use?.length) {
    const list = detail.shopping.in_use;
    const where = (it) => [...it.decks.map((d) => d.name), ...(it.boxes ?? []).map((b) => `locked binder ${b.binder}`)].join(", ");
    const top = list.slice(0, 10).map((it) => `${it.quantity}x ${it.name} (in ${where(it)})`);
    lines.push(`${built && inDecks ? `Shared with other built decks${inBoxes ? " or in locked binders" : ""} (both need them; buy extra to play both)` : built ? "Owned but in locked binders (move them over instead of buying)" : inBoxes ? "Owned but in other built decks or locked binders (move them over instead of buying)" : "Owned but in other built decks (move them over instead of buying)"}: ${top.join(", ")}${list.length > 10 ? ", ..." : ""}`);
  }
  if (detail.commander_suggestions?.length) {
    lines.push(`No commander set. Possible commanders in the deck: ${detail.commander_suggestions.map((c) => c.name).join(", ")}.`);
  }
  for (const board of BOARDS) {
    const cards = detail.cards.filter((c) => c.board === board);
    if (!cards.length) continue;
    lines.push(`\n## ${board}`);
    for (const c of cards) {
      const free = Math.max(0, c.available_for_this ?? c.owned);
      const elsewhere = (c.used_elsewhere ?? []).map((d) => d.name).join(", ");
      const boxes = (c.in_locked ?? []).map((b) => b.binder).join(", ");
      const parts = [];
      if (c.basic) parts.push("basic");
      else {
        if (c.to_buy) parts.push(`TO BUY ${c.to_buy}`);
        const inBox = c.in_use_locked ?? 0;
        const inDeck = c.in_use - inBox;
        if (inDeck > 0) {
          parts.push(c.conflict
            ? `SHARED ${inDeck} with ${elsewhere} (CONFLICT: both built decks need it; buy extra to play both)`
            : `IN USE ${inDeck} in other deck(s): ${elsewhere} (can be moved)`);
        }
        if (inBox > 0) parts.push(`IN USE ${inBox} in locked binder ${boxes} (can be moved)`);
        parts.push(`owned ${c.owned}${free !== c.owned ? `, free ${free}` : ""}`);
        if (c.used_elsewhere?.length && !c.in_use && !c.conflict) parts.push(`also in ${elsewhere}`);
        if (c.conflict && !c.in_use) parts.push(`CONFLICT (also in ${elsewhere})`);
      }
      const own = parts.join(", ");
      lines.push(`${c.quantity}x ${c.name} | ${c.mana_cost || ""} | ${c.type_line || "?"} | ${own} | ${formatPrice(c.price)}`);
    }
  }
  return lines.join("\n");
}

/**
 * The planner's answer for a saved deck, ready to repeat: name + commander + where it is, ownership
 * (owned · from other decks or locked binders · to buy with €), power or size, and the cards changed
 * when `changed` (removed copies vs the previous list) is given. Bold numbers, no card lists.
 */
export function deckSummary(detail, { updated = false, changed = null } = {}) {
  const claim = ["commander", "main", "side"];
  const total = claim.reduce((a, b) => a + (detail.counts?.[b] ?? 0), 0);
  const buy = detail.to_buy_count ?? 0, moved = detail.in_use_count ?? 0;
  const cmd = detail.cards.filter((c) => c.board === "commander").map((c) => c.name);
  const what = cmd.length ? cmd.join(" + ") : detail.format || "deck";
  const lines = [`**${detail.name}** (${what}) · ${updated ? "updated, old list in History" : `saved as ${detail.status === "built" ? "built" : "idea"}`} · Decks tab`];
  lines.push(`Owned **${total - buy - moved}** · from other decks **${moved}** · to buy **${buy}** (**€${(detail.to_buy_eur ?? 0).toFixed(2)}**)`);
  const p = detail.power;
  const stats = detail.stats?.avg_mv != null ? ` · avg MV ${detail.stats.avg_mv}` : "";
  const legal = p?.legality && !p.legality.ok ? ` · **not legal**: ${p.legality.problems.map((x) => x.rule).join(", ")}` : "";
  if (p?.bracket) lines.push(`Bracket **${p.bracket.display}** · score **${p.score?.display ?? "?"}/10**${legal}`);
  else lines.push(`**${total}** cards${stats}${legal}`);
  if (changed != null) lines.push(`Changed **${changed}** cards`);
  return lines.join("\n");
}
