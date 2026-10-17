# Decks

How decks, idea vs. built decks, conflicts, to-buy lists, deck boxes,
the build list, the deck history, deck stats and the power level (bracket and
score) work.

- [Adding decks](#adding-decks)
- [What a deck shows](#what-a-deck-shows)
- [Deck stats](#deck-stats)
- [Bracket and power score](#bracket-and-power-score)
- [Combo check (Commander Spellbook)](#combo-check-commander-spellbook)
- [Idea vs. built decks](#idea-vs-built-decks)
- [Deck boxes are reserved](#deck-boxes-are-reserved)
- [To buy](#to-buy)
- [Put into deck box](#put-into-deck-box)
- [Build list](#build-list)
- [Deck history](#deck-history)
- [API](#api)

## Adding decks

- Paste a list in MTGA, Moxfield or ManaBox format.
- Let Claude build one in the [planner](claude.md); it is saved as an *idea*.
- ManaBox **deck binders** become decks automatically on import (see
  [collection.md](collection.md#importing-from-manabox)).
- Add scanned cards straight to a deck (see
  [scanner.md](scanner.md#scan-list--binder-or-deck)).

Decks can be exported as a text list you can import elsewhere.

## What a deck shows

- Each card shows how many copies you own (counted across all printings) and
  how many are **missing**.
- The deck shows its **value in EUR** (owned, to buy, maybeboard) and the
  **cost of the missing cards**. Copies are shared between main, side and
  maybe boards. Basic lands are never missing.
- You can set the **commander** (up to two for partner/background pairs;
  legendary creatures in the deck are suggested) and move cards between
  boards.
- A **cover picture**: the commander, else the most expensive card (EUR,
  basic lands never). The deck list shows it as a thumbnail on phones and as
  the card art on wider screens.
- **Share** (the arrow next to the deck name) sends a link to the deck
  (`#decks/<id>`): the phone's share menu, else the link is copied. Anyone on
  your home network opens it straight in the app.

## Deck stats

Open **Stats** on any deck (every format):

- **Mana curve:** how many cards cost 0, 1, 2 … 7+, split into creatures and
  other spells. X spells get an "X" mark.
- **Colours:** for each colour, how much the spells ask for (mana symbols)
  and how many lands make it. A warning shows when the lands fall behind.
- **Facts:** lands (double-faced cards with a land back count extra), average
  mana value, creatures, instants and sorceries.
- The commander and a companion are shown as chips. Side and maybe boards are
  not counted.
- Cards without card data yet are listed as **unknown**, never as free.

## Tokens & extras

Open **Tokens & extras** on any deck (also while you only plan it) to see what
you need on the table besides the cards:

- **Tokens**: picture, name, power/toughness, which cards make them
  (*from Battle Screech ×4*), roughly how many to have ready (*have ~16*) and
  how many token cards you own, with their binder (*you own 3 (Tokens)*).
- **Counters and markers**: +1/+1 and −1/−1 counters, loyalty, poison,
  energy, lore, time, shield, oil and other named counters, dice (with their
  size), coins, the Monarch, the Initiative, Day/Night, City's Blessing,
  dungeons, The Ring, emblems, face-down cards and token copies. Each names the
  cards that need it.
- The estimate is a rough guide: copies × tokens per card, twice for
  flashback and for triggered or activated abilities, *X* effects count 2,
  capped at 20.
- Sideboard cards count and are marked *side*; the maybeboard is left out.
- Where the data comes from: Scryfall's list of the tokens a card makes and
  the token cards themselves (fetched once in the background and cached),
  else the card text. Without a connection the names and counts still come
  from the card text.
- The **Build list** ends with a *Tokens & extras* group: token cards you own
  per binder, the rest as *need*, then the counters and markers. They can be
  ticked but don't count towards *picked*.
- The planner sees a short *Tokens & extras* line for saved decks and drafts.

## Bracket and power score

Commander decks get two badges at the top, for example **B3 Upgraded** and
**6.5/10**. Tap one for the details. Other formats only get the stats.

A deck counts as a Commander deck when its format is Commander/EDH/cEDH, or
when it has no format (ManaBox decks) but has a commander or about 100 cards.

### The bracket (1-5)

The bracket follows WotC's official
[Commander Brackets](https://magic.wizards.com/en/formats/commander) (rules as
of 9 Feb 2026). The app only uses rules it can show you, and it names the
cards behind each one:

| What the deck has | Bracket at least |
| --- | --- |
| Nothing below | 2 |
| 1-3 **Game Changers** (WotC's list, 53 cards) | 3 |
| 4 or more Game Changers | 4 |
| **Mass land denial** (Armageddon, Blood Moon, …) | 4 |
| 3 or more **extra-turn** cards (1-2 are fine) | 3 |
| A **2-card combo** that wins or goes infinite and costs 4 mana or less to assemble | 4 |
| A slower 2-card combo, or one that only "arguably" needs 2 cards | 3 |

"Costs to assemble" = the mana the combo needs (Commander Spellbook) plus
the mana value of every piece that must already be on the battlefield. So
Thassa's Oracle + Demonic Consultation (3) counts as fast, Vito + Exquisite
Blood (3 + 5 = 8) as a slower combo.

- **Brackets 1 and 5 are your call.** They are about intent, so the app
  never sets them. Pick one in the details ("Auto" or 1-5); a ✎ shows it.
  If you pick a lower one than the rules give, the app tells you why.
- Very fast decks get a hint: **"Looks cEDH-like"**. Set 5 yourself if you
  agree.
- **Tutors don't change the bracket** (WotC dropped that rule on
  21 Oct 2025). They only count toward the score.
- **"≥3"** means "at least 3": the combo check hasn't run yet (offline, off
  or still loading) or some cards aren't identified. It can only go up.
- The 2-card combo and extra-turn rules are the app's reading of WotC's
  "no two-card combos before turn 6" and "no chaining extra turns". They are
  marked as heuristics.
- **Not legal** (red badge): banned cards, cards outside the commander's
  colours, duplicates, not 100 cards, or commanders that can't pair. It never
  changes the bracket number.
- Commander Spellbook's own estimate is shown as a second opinion only. It
  never raises the app's bracket.

### The power score (1-10)

The score says how strong the deck is *inside* its bracket. It is
1 + points from eight parts, each with a maximum:

| Part | Max | What gives points |
| --- | --- | --- |
| Speed | 1 | A low average mana value |
| Fast mana | 1.75 | Mana Vault, Chrome Mox, rituals … (Sol Ring counts less: every precon has it) |
| Tutors | 1 | Cards that search your library; cheap ones count more |
| Combos | 2 | Combos found by the combo check; fast 2-card combos count most |
| Interaction | 1 | Removal, counterspells, board wipes, free spells, protection |
| Card draw | 1 | Draw engines most, then "draw three" and cantrips |
| Ramp | 0.75 | Mana rocks, mana creatures, land search |
| Mana base | 0.5 | Lands that make 2+ of your colours, enough sources per colour |

- Each part shows as a bar with plain words and its top cards.
- The score is not tied to the bracket. When it is unusual for the bracket, a
  note says why, e.g. "Score is high for Bracket 2 because of fast mana".
  The usual ranges follow the
  [playgroup.gg bracket calculator](https://playgroup.gg/commander/bracket-calculator):
  Brackets 1-2 about 1-4.5, Bracket 3 about 4.5-7.5, Bracket 4 about 7-9.5.
- Unknown cards add nothing and are listed. Without the combo check the
  combos part is 0 and the score shows **"≥"**.
- The weights were tuned on 14 public decklists (WotC precons, upgraded
  precons, optimized decks, cEDH lists). Precons land around 3.5-4.5,
  cEDH lists around 9-9.5.

### In the planner

Claude sees the bracket and the score of every deck. Ask for a target
("build a bracket 3 deck"): Claude checks the draft with `evaluate_deck`
before saving it and swaps the cards that push it too high.

## Combo check (Commander Spellbook)

Combos come from [Commander Spellbook](https://commanderspellbook.com/)
("Combos by Commander Spellbook"). Each combo links to its page there.

**What is sent:** for Commander decks only, the **card names and
quantities** of the commander and main deck. Nothing else from your
collection, no prices, no deck names. Like any web request it also reveals
your server's public IP address.

**When:** after a Commander deck changes (also ManaBox import rebuilds and
drafts Claude checks with `evaluate_deck`), at most one call every 1.5 s.
Results are cached for 14 days; identical decks share a result.

**Turn it off:** Settings → **Online services** → **Check combos online**.
To force it off for good, set `SPELLBOOK_ENABLED=false` in `.env` (this wins
over the switch, also for the planner). When it is off or the service can't
be reached, the app still works: the bracket and score show "≥" and combos
show as not checked.

Commander Spellbook asks API users to keep to a few calls per user action and
under 80 per minute, and to name the app; the app does all three (usage notes
in the [API description](https://backend.commanderspellbook.com/schema/)).
Its backend is MIT-licensed
([source](https://github.com/SpaceCowMedia/commander-spellbook-backend)).

## Idea vs. built decks

A deck is an *idea* (a plan) or *built* (a physical deck; decks synced from
ManaBox deck binders start as built).

- Built decks **claim** their copies (commander, main and side boards; basic
  lands never count), so every deck and card shows *owned* and *free* copies.
- A card you own but that another built deck uses is shown as **in other
  decks** ("can be moved"), separate from what you still need **to buy**.
- Two built decks that need more copies than you own are flagged as a
  **conflict**.
- Copies in a **deck box** belong to that box: see below.

## Deck boxes are reserved

A precon or a boxed deck stays whole: its cards are not used for other decks.

- Copies in a binder of type **Deck box** (see
  [collection.md](collection.md#binders)) are **free only for the deck that
  owns the box**.
- Every other deck shows them as **in deck box <name> · can be moved** (⇄),
  like copies another built deck has. They are never free and never "to buy".
- A box **nobody owns** (e.g. `Commander Deck: …` with no deck in the app)
  is reserved for every deck.
- A built deck's own box and its claim count once: the deck takes its cards
  from its own box first.
- A deck box never makes a **conflict**; conflicts stay between built decks.
- Basic lands stay free, also in a box.
- To use a box's cards freely, set the binder's type to *Binder* (or Trade,
  Bulk, Other) in its **⋯** menu.

**Which deck owns a box?** The deck linked to it: binder **⋯ → Belongs to
deck**, or *Put into deck box*. A ManaBox deck owns its ManaBox binder, and a
binder named like the deck (or `Deck box: <deck>`) counts too. One box per
deck, one deck per box. When a box's name looks like a deck's name
(`Secret Lair Commander: Odds and Ends` ↔ `Secret Lair Commander Deck: Odds
and Ends`), its page asks once: "Looks like the box of …? **Link** / **No**".
It never links on its own. The deck page shows its box under the value.

## To buy

Each deck shows its own **To buy** list. **Market → To buy** shows what each
deck still needs and, across all built decks, what to buy with a € total (see
[finance.md](finance.md#to-buy)).

## Put into deck box

**Put into deck box** moves the copies a built deck needs into a
`Deck box: <name>` binder:

- Unsorted copies are taken first, then plain binders. Never copies out of
  another deck box (any deck's, linked or not) or another built deck's binder.
- The box is remembered, also when the deck or the binder is renamed.
- A ManaBox deck's own binder already counts as boxed.

## Build list

**Build list** helps you collect a deck's cards from your binders, mainly for
an idea deck you are about to build.

- Cards are grouped by the **binder** their free copies are in (Unsorted
  first). It uses the same order as *Put into deck box*.
- **In other decks or boxes**: you own them, but another built deck or a deck
  box has them ("in deck box … · reserved").
- **Basic lands**: basics you don't own enough of.
- **To buy**: cards you don't own, with prices.
- **Already in …**: copies already in the deck box. They count as picked.
- Tap a card to tick it. Ticks are saved on the server, so you can switch
  devices. A bar shows *23 / 61 picked*.
- At the end: **Put picked cards into deck box** (moves only the ticked cards)
  and **Mark deck as built**.
- Ticking never moves cards. A card that leaves the deck loses its tick.

## Deck history

Every change to a deck is saved as a **version**: edits in the app, decks
Claude saves, ManaBox imports and scanner commits.

- **History** lists the versions: when, who (you, Claude, ManaBox import,
  scanner) and what changed (for example *+2 −1 cards*).
- Tap a version to see what was added, removed or changed per board.
- **Restore this version** puts its cards, name, format and bracket back. It is
  saved as a new version, so nothing is lost. The status (idea / built) stays.
- The newest 50 versions per deck are kept. Saving the same state twice does
  not add a version. Deleting a deck deletes its history.
- Decks that existed before the history started get one starting version.
- Claude can read a deck's history (`get_deck_history`), but can't restore it.

## API

JSON; state-changing calls need `Content-Type: application/json` and a
same-origin request.

| Route | |
| --- | --- |
| `GET /api/decks/:id` | the deck; adds `cover: {scryfall_id, name, image_small, image_normal, image_art, source}` (`source` is `commander` or `top`; null without a card image; the rows of `GET /api/decks` carry it too) and `accessories: {status, tokens: [{key, name, type_line, pt, colors, oracle_text, image_small, scryfall_ids, source, from: [{name, quantity, side?}], estimate, estimate_note, side_only?, owned: {quantity, binders: [{binder, quantity}]}}], markers: [{key, label, kind, note?, sizes?, from, side_only?}], maybe_skipped, unknown}`; `status` is `ok`, `pending` (token data is being fetched: read again after a few seconds) or `unavailable` (card text only); deck boxes: `box {binder, via}` (the box this deck owns), per card `in_boxes [{binder, deck_id, deck_name, quantity}]` (other deck boxes holding it) and `in_use_box` (the part of `in_use` lying there), `in_use_box_count`, and `shopping.in_use[]` items add `boxes` and `in_box` |
| `POST /api/decks/evaluate` | also returns `accessories` for the draft |
| `GET /api/decks/:id/build` | the build list: `{deck_id, name, status, box_binder, total, picked, complete, movable_picked, groups: [{key, kind, title, binder?, quantity, picked, lines: [{key, source, name, quantity, picked, oracle_id, scryfall_id, commander, binder?, decks?, price_eur?}]}]}`; `kind` is `binder`, `other`, `basics`, `buy`, `box` or `tokens` (token lines with `token`, `need`; marker lines with `marker`; not counted in `total`/`picked`) |
| `PUT /api/decks/:id/build/picks {key, source, quantity}` | tick (`quantity` = the line's copies) or untick (`0`) one line; returns the list; 404 when the line is gone |
| `DELETE /api/decks/:id/build/picks` | untick everything; returns the list |
| `POST /api/decks/:id/to-binder {binder?, confirm_master?, picked_only?}` | *Put into deck box*; `picked_only: true` moves only the cards ticked in a binder group (400 when none) |
| `GET /api/decks/:id/history` | `{deck_id, keep, versions: [{id, at, actor, summary, card_count, name, restored_from, current}]}`, newest first; `actor` is `app`, `claude`, `import`, `scan` or `system` (starting version) |
| `GET /api/decks/:id/history/:version` | `{version: {…, meta, cards}, diff, restore}`: `diff` = changes against the version before (null for the oldest), `restore` = what restoring would change |
| `POST /api/decks/:id/history/:version/restore {confirm: true}` | restore that version (400 without `confirm`); returns the deck plus `restored: {version_id, restored_from}` |

A diff is `{boards: [{board, added: [{name, quantity}], removed: [...],
changed: [{name, from, to, printing?}]}], meta: [{field, from, to}], added,
removed, moved}`.
