// Wishlist tools (lib/wishlist.js): list + add only; removing items is app-only.

import { addWishlistItem, listWishlist, WishlistError } from "../../lib/wishlist.js";
import { getDb } from "../context.js";
import { eurText, ToolError } from "../format.js";

export const TOOLS = [
  {
    name: "list_wishlist",
    description:
      "The user's wishlist (cards they want to buy, outside decks): per item the wanted copies, how many they own already " +
      "(got it = owned >= wanted), the current EUR price (cheapest known printing when any printing will do), the user's max " +
      "price and whether the price is below it, priority and note, plus the total EUR to buy.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Wishlist", readOnlyHint: true, openWorldHint: false },
    run: listWishlistTool,
  },
  {
    name: "add_to_wishlist",
    description:
      "Add a card to the user's wishlist (only when the user asks for it). Give the name; set + collector_number only when the " +
      "user wants that exact printing. Adding a card already on the list adds the quantity. Removing items is only possible " +
      "in the app (Market tab → Wishlist).",
    inputSchema: {
      type: "object",
      properties: {
        card: { type: "string", description: "Card name." },
        set: { type: "string", description: "Set code, only for one specific printing." },
        collector_number: { type: "string", description: "Collector number (with set)." },
        quantity: { type: "integer", minimum: 1, maximum: 99, description: "Copies wanted (default 1)." },
        finish: { type: "string", enum: ["any", "normal", "foil", "etched"], description: "Default any." },
        language: { type: "string", description: "Language code (en, de, ja, ...); default any." },
        max_price_eur: { type: "number", minimum: 0, description: "The most the user wants to pay per copy, in EUR." },
        priority: { type: "string", enum: ["high", "normal", "low"] },
        note: { type: "string", description: "Short note (why, for which deck)." },
      },
      required: ["card"],
      additionalProperties: false,
    },
    annotations: { title: "Add to wishlist", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: addToWishlistTool,
  },
];

function wishLine(i) {
  const printing = i.any_printing ? "any printing" : `${String(i.set_code || "").toUpperCase()} #${i.collector_number}`;
  const extra = [i.finish === "normal" ? "non-foil" : i.finish, i.language ? i.language.toUpperCase() : null].filter(Boolean);
  return `  #${i.id} ${i.quantity}x ${i.name} (${printing}${extra.length ? `, ${extra.join(", ")}` : ""}) | owned ${i.owned}` +
    `${i.got_it ? " | GOT IT" : ` | to buy ${i.to_buy}, ${eurText(i.price_eur)} each`}` +
    `${i.max_price_eur != null ? ` | max €${i.max_price_eur.toFixed(2)}${i.below_max ? " (price is below max)" : ""}` : ""}` +
    `${i.priority !== "normal" ? ` | ${i.priority} priority` : ""}${i.note ? ` | note: ${i.note}` : ""}`;
}

function listWishlistTool() {
  const { items, totals } = listWishlist(getDb());
  if (!items.length) return "The wishlist is empty.";
  return [`Wishlist: ${totals.items} items, ${totals.to_buy} copies to buy for ${eurText(totals.to_buy_eur)}` +
    `${totals.unpriced ? ` (${totals.unpriced} without EUR price)` : ""}${totals.got_it ? `; ${totals.got_it} already owned (got it)` : ""}:`,
  ...items.slice(0, 200).map(wishLine), ...(items.length > 200 ? [`  ... ${items.length - 200} more`] : [])].join("\n");
}

async function addToWishlistTool(args) {
  const name = String(args.card ?? "").trim();
  if (!name) throw new ToolError("card is required.");
  if (args.collector_number != null && !args.set) throw new ToolError("collector_number needs set.");
  try {
    const { item, merged } = await addWishlistItem(getDb(), {
      name, set: args.set || undefined, collector_number: args.collector_number ?? undefined, quantity: args.quantity,
      finish: args.finish, language: args.language, max_price_eur: args.max_price_eur, priority: args.priority, note: args.note,
    }, { source: "claude" });
    return `${merged ? "Updated" : "Added"} wishlist item:\n${wishLine(item)}\nThe user sees it in the app (Market tab → Wishlist).`;
  } catch (err) {
    if (err instanceof WishlistError) throw new ToolError(err.message);
    throw err;
  }
}
