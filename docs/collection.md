# Collection, binders and imports

How your collection gets into the app, how binders work, who is the "master"
of your collection, how to edit copies, and the search syntax.

- [Importing from ManaBox](#importing-from-manabox)
- [Browsing and searching](#browsing-and-searching)
- [Binders](#binders)
- [The collection master](#the-collection-master)
- [Editing owned copies](#editing-owned-copies)
- [Search syntax](#search-syntax)
- [API](#api)

## Importing from ManaBox

You keep your collection in the [ManaBox](https://manabox.app/) app and upload
its CSV export from your phone's browser.

1. In ManaBox, open **Collection** and tap the **⋯** menu, then **Export**,
   then **CSV**. You can also export a single binder.
2. Save or share the file to your phone.
3. In mtg-planner, open **Settings** (gear icon), pick the file and choose a
   mode. The default follows the [collection master](#the-collection-master):
   *Replace (sync)* while ManaBox is the master, *Only new copies (delta)* once
   mtg-planner is. *Add everything* adds every copy in the file again.

The three modes:

- **Replace** does a full sync: ManaBox is the source of truth. It replaces
  only rows that came from ManaBox. A *replace* upload in which nothing can be
  resolved is refused, so the collection is never wiped by accident.
- **Delta** (only new copies) adds only the copies that are new since the last
  ManaBox export. Fewer copies are reported but never deleted, and the same
  file imported twice changes nothing.
- **Add** adds every copy in the file again (the app warns about duplicates).

The app remembers the last ManaBox export (every import rewrites that
snapshot). A *delta* import compares the file with it per printing, finish,
language, condition and binder: increases are added into their ManaBox binder,
decreases are listed as "ManaBox has fewer copies of X (−n)" and nothing is
deleted.

Every printing is resolved against Scryfall, which also refreshes its price.
ManaBox **deck binders** become decks automatically (a *replace* import also
removes decks whose binder is gone), and **list binders** (wish lists) are
skipped.

The import needs the `Name` column plus either `Scryfall ID` or `Set code`.
It also understands `Collector number`, `Foil`, `Quantity`, `Condition`,
`Language`, `Purchase price`, `Purchase price currency`, `Binder Name` and
`Binder Type`. Comma and semicolon delimiters both work, and a UTF-8 BOM is
fine.

## Browsing and searching

The **Collection** tab uses Scryfall-style search syntax (`t:creature c<=bg
cmc<=3 eur>2 -is:foil`, see [Search syntax](#search-syntax)). You can group by
card or by printing and sort by name, mana value, price, quantity, set or
rarity. Card details show every printing you own and every deck that uses
the card.

Prices are in EUR. A foreign printing without its own EUR price uses its
English printing's EUR price, so values never fall back to USD.

## Binders

A binder is a named group of owned copies; copies without one are *Unsorted*.
In the **Collection** tab:

- the binder bar filters the list by binder (or *Unsorted*); **New binder**
  creates an empty binder, **Manage** renames (renaming onto an existing name
  merges the two) and deletes binders. Deleting asks what happens to the
  cards: move them to *Unsorted* (default) or delete them too (logged and
  undoable, see [Editing owned copies](#editing-owned-copies)).
- a card's details list every owned copy with a **Move…** action: pick how
  many copies and the target binder (or a new one).
- **Select** turns the grid or list into a selection; **Move to…** moves every
  copy of the selected cards, or, while a binder filter is active, only the
  copies in that binder.

## The collection master

**Who is the master of the collection?** By default ManaBox is: a *replace*
import rebuilds every row that came from ManaBox. The first time you move,
rename or unsort ManaBox cards in the app, mtg-planner asks once and then
becomes the master:

- the moved copies turn into app-owned rows (source `app`) that no import
  touches, so your binder assignments win;
- ManaBox imports default to **Only new copies (delta)**; *Replace* stays
  available behind an explicit warning (it still deletes only rows that came
  from ManaBox, and copies you already moved in the app are counted against
  the file instead of being loaded a second time, also after switching the
  master back to ManaBox);
- deleting a binder may delete its ManaBox cards too (while ManaBox is the
  master this is refused, so ManaBox data is never deleted silently).

The **Settings** tab (Collection) shows the current master and can switch it
back.

## Editing owned copies

A card's details list every owned copy with **Move… / Edit… / Delete…**:

- **Edit…** changes the language (to the same set and number in that
  language, or just the language tag), the printing (same card), the finish
  (one the printing exists in) or the condition, for some or all copies of
  that row.
- **Delete…** removes copies after a second confirmation. **Select** in the
  Collection tab can delete many cards at once (you type the number of copies
  to confirm).
- Every edit and delete shows a toast with **Undo**, and is listed under
  **Settings → Collection → Recent changes**, where it can be undone later
  (newest first, as long as the copies weren't changed again since). Undo
  restores the rows exactly.
- Editing or deleting ManaBox copies makes mtg-planner the
  [collection master](#the-collection-master), after asking once.
  Later ManaBox imports respect these changes: an edited or deleted copy is
  not loaded again while the export still lists it, and once ManaBox shows the
  same change the edit simply counts as done.
- Claude's `edit_copies` tool uses the same edits (logged with Claude as the
  author, undoable the same way); it cannot delete.

## Search syntax

The collection browser and Claude's `search_collection` tool use the same
query language. Terms are combined with AND, a leading `-` negates a term, and
values with spaces go in quotes.

| Query | Meaning |
| --- | --- |
| `bolt`, `n:"sol ring"` | name contains |
| `t:creature`, `t:legendary` | type line contains |
| `o:"draw a card"` | oracle text contains |
| `k:flying` | has keyword |
| `c:wu` | colors include white **and** blue |
| `c=wu`, `c!=wu` | exactly / not exactly white-blue |
| `c<=wu` | only white and/or blue (or colorless) |
| `c<wu`, `c>u` | strict subset / superset |
| `c:m`, `c:c` | multicolor / colorless; `c:red`, guild and shard names (`c:azorius`, `id:esper`) also work |
| `id:bg` | color identity within black-green (commander deck building) |
| `cmc<=3`, `mv=2` | mana value (`= < > <= >= !=`) |
| `r:mythic`, `r:u` | rarity (`common`, `uncommon`, `rare`, `mythic`, `special`, `bonus`) |
| `s:mh3` | set code |
| `f:commander` | legal (or restricted) in format |
| `is:foil`, `is:nonfoil`, `is:etched` | owned finish |
| `is:commander` | legendary creature or "can be your commander" |
| `eur>5`, `usd<1` | price of the owned finish (foil/etched prices for foil/etched copies) |
| `qty>=4` | total owned copies (summed over the grouped rows) |
| `avail>=1` (`free`, `available`) | copies not claimed by built decks (all printings; `avail<0` = short) |
| `used>=1`, `is:used`, `used:no` | copies claimed by built decks |
| `b:"trade binder"` | binder name contains (any binder) |
| `lang:de` | card language |
| `src:manabox`, `src:scan`, `src:app` | where the copy came from (ManaBox import, scanner, organised in the app) |
| `-t:land` | negation of any term |

All terms are ANDed; there is no `or` and no parentheses.

Unknown keys return an error that lists the supported syntax.

## API

JSON; state-changing calls need `Content-Type: application/json` and a
same-origin request.

| Route | |
| --- | --- |
| `GET /api/binders` | `{binders: [{name, cards, unique_cards, copies, sources, by_source, created_at, empty}], unsorted, collection_master}` |
| `POST /api/binders {name}` | create an empty binder: 201, 409 if it exists, 400 if empty or longer than 100 |
| `PATCH /api/binders/:name {name, confirm_master?}` | rename, merging into an existing binder |
| `DELETE /api/binders/:name?cards=unsort\|delete&confirm_master=1` | delete; `unsort` (default) moves the cards to Unsorted, `delete` deletes them (logged in the edit log, undoable) |
| `POST /api/collection/move` | `{items, to_binder, create?, confirm_master?}`; an item is `{scryfall_id, finish, language, condition, binder, source?, quantity}` (copies of one row key), `{oracle_id, from_binder?}` (every copy of a card) or `{printing_id, from_binder?}` (every copy of a printing); `to_binder: ""` is Unsorted |
| `GET /api/collection?binder=` | the collection list filtered by exact binder (`binder=` = Unsorted) |
| `GET\|PATCH /api/settings` | `{collection_master: "manabox" \| "app"}` (also in `GET /api/stats`) |
| `POST /api/import/manabox?mode=replace\|delta\|add` | raw CSV body; the summary lists `added` and `decreased` rows in delta mode |
| `POST /api/refresh-prices` | re-fetch card data and prices of everything you own or use in a deck |
| `PATCH /api/decks/:id {status}` | `idea` or `built` |
| `GET /api/shopping-list` | `{built: {items, total_eur}, per_deck}` |
| `POST /api/decks/:id/to-binder {binder?, confirm_master?}` | move the deck's owned copies into `Deck box: <name>` (or `binder`); returns `moved` and `missing` |

A move, rename or unsort that touches ManaBox rows while ManaBox is the master
answers `409 {code: "confirm_master", manabox_copies}`; repeat it with
`confirm_master` to proceed. A *replace* import while mtg-planner is the master
answers `409 {code: "confirm_replace"}` unless `confirm_replace=1` is set.

Editing copies: `POST /api/collection/edit {items, set: {language?,
printing_id?, finish?, condition?}, confirm_master?}`,
`POST /api/collection/delete {items, confirm: true, expected_copies?,
confirm_master?}` (items as for `/api/collection/move`; `expected_copies` = the
number of copies the user confirmed: when the items now select another number,
nothing is deleted and the answer is `409 {code: "changed", copies}`),
`GET /api/collection/edits` and `POST /api/collection/edits/:id/undo`.
