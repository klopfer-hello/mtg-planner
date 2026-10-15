# Decks

How decks, idea vs. built decks, conflicts, the shopping list and deck boxes
work.

- [Adding decks](#adding-decks)
- [What a deck shows](#what-a-deck-shows)
- [Idea vs. built decks](#idea-vs-built-decks)
- [Shopping list](#shopping-list)
- [Put into deck box](#put-into-deck-box)

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

## Idea vs. built decks

A deck is an *idea* (a plan) or *built* (a physical deck; decks synced from
ManaBox deck binders start as built).

- Built decks **claim** their copies (commander, main and side boards; basic
  lands never count), so every deck and card shows *owned* and *free* copies.
- A card you own but that another built deck uses is shown as **in other
  decks** ("can be moved"), separate from what you still need **to buy**.
- Two built decks that need more copies than you own are flagged as a
  **conflict**.

## Shopping list

The **shopping list** shows what each deck still needs and, across all built
decks, what to buy with a € total.

## Put into deck box

**Put into deck box** moves the copies a built deck needs into a
`Deck box: <name>` binder:

- Unsorted copies are taken first, never copies out of another built deck's
  box.
- The box is remembered, also when the deck or the binder is renamed.
- A ManaBox deck's own binder already counts as boxed.
