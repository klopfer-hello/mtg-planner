# Value and wishlist

The **Value** tab has two parts: what your collection is worth over time, and
your **wishlist**. All prices are in euros (Scryfall's Cardmarket prices; a
foreign printing without its own price uses the English printing's). A card
with only a USD price counts as "without € price", never as dollars.

- [Collection value](#collection-value)
- [Wishlist](#wishlist)
- [How the history is stored](#how-the-history-is-stored)
- [API](#api)

## Collection value

- **Collection value** at the top: every owned copy at its finish's price.
- **Today / 7 days / 30 days:** how much the value changed. Tap one to see why:
  - **Added cards:** new copies, at today's price.
  - **Removed cards:** copies that are gone (sold, deleted), at their old price.
  - **Price changes:** the market moving on the cards you kept.
- **Over time:** a chart of the daily value (30 days, 90 days, 1 year, all).
  Tap or move over it to read a day.
- **Price moves:** the biggest risers and fallers among cards you held the
  whole time (7 or 30 days), by euros gained or lost.
- **Most valuable:** your 20 most expensive printings (per copy), with the
  binders they are in.
- **Value per binder** and **per rarity**.

**History starts the day you install (or update to) this version.** The app
saves the value once a day, so the changes and the chart need a day or two.

## Wishlist

Cards you want to buy, outside your decks.

- **Add a card:** in the Value tab tap **Add card** and search by name; or
  tap **♡ Wishlist** in a card's details; or tap ♡ next to a card in a deck's
  **To buy** list (or **Add all to wishlist**), also in the shopping list.
- **Any printing or one printing:** "any printing" uses the cheapest price the
  app knows for that card and counts every copy you own. "Only this printing"
  counts and prices just that one.
- **Max price:** the most you want to pay per copy. Cards at or below it are
  marked **✓ below your max**.
- **Got it:** when you own as many copies as you want, the card moves to
  **Got it**. Tap **Remove, I have it** to clear it.
- The global **shopping list** (Decks → Shopping list) shows the wishlist's
  open cards in their own section.
- **Claude** can read the wishlist and add cards when you ask (it cannot
  remove them).

Wishlist cards get their prices refreshed every night, like your collection.

## How the history is stored

- One snapshot per day (container local time, so set `TZ`): total value,
  copies and the value per binder. It is written at start-up, after every
  collection change (import, scan, move, edit, delete, restore) and by the
  nightly maintenance after the price refresh. Later snapshots on the same day
  replace that day's numbers.
- Per printing and finish, the number of copies and the price are stored only
  when one of them changes, so the history stays small (a few thousand cards
  for years take a few MB).
- The nightly price refresh runs every night by default
  (`PRICE_REFRESH_DAYS=1`, see [setup.md](setup.md#index-and-price-refresh)).
  With a larger value the chart moves in steps.
- The history is part of the database, so it is included in backups.

## API

All JSON, all `GET` unless noted.

| Endpoint | Returns |
| --- | --- |
| `/api/finance/summary` | `{today, history_start, value_eur, copies, printings, unpriced_copies, changes{today, d7, d30}, binders[], rarities[]}`. Each change is `null` until the history reaches that far back, else `{from_day, value_from_eur, change_eur, added_eur, removed_eur, price_eur, added_copies, removed_copies}`. |
| `/api/finance/history?days=90` | `{days, from_day, today, history_start, points[{day, value_eur, copies}]}`; the last point is the live value. |
| `/api/finance/movers?days=7&limit=10` | `{from_day, available, risers[], fallers[]}`; each `{scryfall_id, name, set_code, collector_number, finish, held, from_eur, to_eur, change_eur, change_total_eur, change_pct}`. |
| `/api/finance/top?limit=20` | `{cards[{scryfall_id, name, set_code, collector_number, finish, quantity, price_eur, value_eur, binders[{binder, quantity}]}]}`. |
| `/api/finance/card/:scryfall_id?finish=normal` | `{points[{day, quantity, eur}]}`: the stored changes of one printing. |
| `/api/wishlist` | `{items[], totals{items, to_buy, to_buy_eur, unpriced, got_it, below_max}}`. Items: `{id, name, oracle_id, scryfall_id, any_printing, finish, language, quantity, max_price_eur, note, priority, source, price_eur, owned, got_it, to_buy, cost_eur, below_max, ...}`. |
| `POST /api/wishlist` | Body `{scryfall_id | oracle_id | name (+ set, collector_number), any_printing?, finish?, language?, quantity?, max_price_eur?, note?, priority? (high/normal/low)}`. `201 {item, merged:false}`, or `200 {item, merged:true}` when the same card was already on the list (quantity added). |
| `PATCH /api/wishlist/:id` | Any of `quantity, max_price_eur (null clears), note, priority, finish, language, any_printing`. |
| `DELETE /api/wishlist/:id` | `204`. |

`GET /api/shopping-list` also returns `wishlist{items[{id, name, need, price_eur, cost_eur, max_price_eur, below_max, priority}], total_eur}`.
