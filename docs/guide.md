# Using mtg-planner

A friendly tour for every day: scan cards, sort them, plan decks, ask Claude.

Not set up yet? Start with the [Installation guide](install.md).

**Contents**

1. [First steps](#1-first-steps)
2. [Scanning](#2-scanning)
3. [Your collection](#3-your-collection)
4. [Decks](#4-decks)
5. [Ask Claude](#5-ask-claude)
6. [Backups and safety](#6-backups-and-safety)
7. [FAQ](#7-faq)

**Words used here**

- **Printing**: one version of a card (set, number, language).
- **Binder**: a named group of your cards, like a real binder.
- **Board**: a part of a deck: main, side, commander or maybe.

**The six tabs** at the bottom of the screen:

| Tab | What it is for |
| --- | --- |
| **Scan** | Scan cards with your phone's camera. |
| **Binders** | Your binders; see, search and sort the cards you own. |
| **Decks** | Plan decks and see what you still need. |
| **Market** | Your collection's value, your wishlist, and what to buy for your decks. |
| **Planner** | Chat with Claude about your cards. |
| **Settings** | Import, backups, recent changes, scanner data. |

---

## 1. First steps

Already use the ManaBox app? Import your collection first.
No ManaBox? Go straight to [Scanning](#2-scanning).

**In ManaBox:**

1. Open **Binders**.
2. Tap the **⋯** menu.
3. Tap **Export**, then **CSV** (a simple table file).
4. Save the file to your phone.

**In mtg-planner:**

1. Open the **Settings** tab (the gear).
2. Tap **Choose CSV file** and pick the file.
3. Keep the **Mode** marked **default**.
4. Optional: under **Put the cards into**, pick a binder or **+ New binder…**.
   Leave it at **Binders as in ManaBox** to keep ManaBox's binders.
5. Tap **Import**.

**You should now see:** "Import complete." and a short summary. Your cards
are in the **Binders** tab, with prices.

**Good to know**

- ManaBox **deck binders** become decks in the **Decks** tab.
- Import again later with a new export. At first the default (**Replace**)
  makes the app match the file: cards you removed in ManaBox disappear here
  too.
- Once you start sorting cards in mtg-planner, the default switches to
  **Only new copies**.
- Scanned cards and cards you sorted here are never removed by an import.

> **If it doesn't work**
>
> - "Nothing new since the last ManaBox export": the file has no new cards.
>   That's fine.
> - Error about missing columns: export the **collection** as **CSV** again,
>   not a deck list.
> - Mode details: [collection.md](collection.md#importing-from-manabox).

---

## 2. Scanning

### Start the camera

1. Open the **Scan** tab.
2. Tap **Start camera**.
3. Allow camera access.

**You should now see:** the camera picture and a bubble saying "Place a card
in view".

### Scan cards

1. Lay one card in view, face up.
2. Hold still.
3. Wait for the sound or the green outline.
4. Swap in the next card. No button needed.

**You should now see:** the card's name and price at the bottom. The bubble
says "Done: next card". The card is in your **scan list**, not yet in your
collection.

No sound? Your phone may be on silent. The green outline still tells you it
worked.

### What you see and hear

- **Purple outline**: card found, hold still.
- **Green outline**: done, next card.
- **Red outline**: not recognised.
- **Sound**: card added. A **cash** sound: worth €5 or more.
- **Top right**: last card's price, and **Σ** = total of this session.
- A dark, plain surface or box works best. After about three cards the app
  learns where your box is. Good light, no shiny reflections.

Each scanned card gets a label:

| Label | Meaning | What you do |
| --- | --- | --- |
| **✓ matched** | The app is sure. | Nothing. |
| **? confirm** | Probably right. | Tap **Confirm**, or **Pick** another printing. |
| **✗ pick** | Not sure. | Tap **Pick printing** and choose. |
| **= same as last** | Same card again. | Tap **+1 copy** if it is a second copy. |

### Second copies and foils

- The app never adds the same card twice by itself. Second copy? Tap **+1**.
- Newer cards (from 2014) show **★** (foil) or **•** at the bottom. The app
  reads that.
- Older cards: set **Auto**, **Non-foil** or **✦ Foil** below the camera.
- A finish with **?** was guessed. Tap it to switch.

### Wrong card?

- **Discard** (trash icon): removes a scan. You get a few seconds to tap
  **Undo**.
- **Undo** (above the scan list): takes back the last action.

### A card isn't recognised

1. The bubble says **"Not recognised – tap to capture"**.
2. Tap it (or the round shutter button).
3. The app takes a careful photo and tries harder.

Still no luck? Tap **Find by name** and type the name. Red cards also have a
**Rescan** button.

**Claude can help with hard cards** (needs the Claude token):

- A card lies still and stays unknown → the app asks Claude once.
- Sometimes a red card shows **Ask Claude**. Tap it to let Claude try.
- Claude's answers show **✦ Claude** and **? confirm**. You confirm them.
- Turn it off: **More scan settings → Ask Claude automatically for hard cards**.

### Put the scans into a binder or deck

1. Scroll to the scan list.
2. Pick a printing for every red card.
3. Tap **Add all to…**.
4. Choose **Binder** or **Deck**.
5. Pick one, or tap **New binder…** and type a name.
6. Tap **Add**.

**You should now see:** an empty scan list. The cards are in the
**Binders** tab (binder) or on the deck list (deck).

> **If it doesn't work**
>
> - **Camera doesn't start:** the address must start with `https://`. See
>   [Make the phone camera work](install.md#7-make-the-phone-camera-work-https).
> - **"The card index is still being built":** after the first start, newer
>   cards work after a few minutes, older cards after about two hours.
> - **Nothing happens:** is **Auto-scan** on? Is a sheet open? Scanning
>   pauses while one is open.
> - **"Warming up the scanner…":** the server just started. Wait a few
>   seconds.
> - More: [scanner.md](scanner.md#limits).

---

## 3. Your collection

Open the **Binders** tab. It starts with your binders: cover card, copies
and value, grouped by type. **All cards** and **Unsorted** sit there too.

### Binders

- **Open a binder:** tap it. Its page has its own search and sections (by set,
  colour, rarity or type). Cards without a binder are **Unsorted**.
- **New binder:** tap **New binder**.
- **Rename or delete:** tap **Manage**.

**Move cards:**

1. Tap **Select**.
2. Tap the cards. Or tap **All**: it selects every card of the current view
   (search and binder filter), not just the ones on screen.
3. Tap **Move to…**.
4. Pick the binder.

**You should now see:** a message like "Moved 3 copies to Trade binder".

The first time you move ManaBox cards, the app asks **"Organise ManaBox cards
here?"** Say yes to sort in mtg-planner from now on.

### Search

| Type this | Finds |
| --- | --- |
| `sol ring` | cards with "sol ring" in the name |
| `t:creature c:g` | green creatures |
| `eur>5` | cards worth more than €5 |
| `is:foil` | your foil copies |

All codes: [collection.md](collection.md#search-syntax).

### Edit, move or delete a copy

1. Tap a card.
2. Next to a copy, tap **Move…**, **Edit…** or **Delete…**.
3. Follow the sheet. Deleting asks twice.

**Undo:** tap **Undo** in the message right after. Missed it? Open
**Settings → Recent changes** and tap **Undo** there.

> **If it doesn't work**
>
> - **Search says "unknown key":** check the code's spelling. There is no
>   `or`.
> - **No Undo next to a change:** the copies changed again since. Undo the
>   newer change first.

---

## 4. Decks

Open the **Decks** tab.

### Add a deck

- Tap **Import decklist** and paste a list (`1 Sol Ring` per line).
- Or ask Claude to build one.
- ManaBox deck binders arrive with each import.

**You should now see:** the deck in the list, with its value.

### Idea or built?

- **Idea** = a plan. It doesn't hold on to any cards.
- **Built** = the deck exists for real. It **reserves** its cards.

To switch:

1. Open the deck.
2. Tap **Built** at the top.
3. If the app warns about shared cards, confirm.

**You should now see:** "Built" selected. Cards other built decks also use get
**⇄** or **⚠**.

### What each card row shows

| Mark | Meaning |
| --- | --- |
| ✓ | You own it and it's free. |
| **⇄ n** | You own it, but it's in another built deck. Move it, or buy another. |
| **⚠ n** | Conflict: two built decks need it, and you don't own enough. |
| **✗ n** | You don't own it. Buy it. |

Basic lands never count as missing. The **To buy** list is below the cards.
**Market → To buy** collects what all built decks need. Tap a deck there to
open it.

### Put into deck box

1. Open the deck.
2. Make sure it is **Built** (see above).
3. Tap **Put into deck box**.
4. Tap **Move cards into “Deck box: …”**.

**You should now see:** where each card came from. The cards sit in the
binder `Deck box: <deck name>`.

> **If it doesn't work**
>
> - **No Put into deck box button?** The deck is still an **Idea**.
> - **A decklist line wasn't recognised:** check the spelling, or paste the
>   line exactly as ManaBox or Scryfall writes it.
> - **Lots of ⇄ marks:** another deck is **Built**. Switch it to **Idea** if
>   it doesn't exist anymore.
> - More: [decks.md](decks.md).

---

## 5. Ask Claude

The **Planner** tab is a chat with Claude. Claude sees your cards and decks.
It needs the Claude token:
[Connect Claude](install.md#6-connect-claude-optional).

1. Open the **Planner** tab.
2. Tap a suggestion, or type a question.
3. Wait a moment.

**You should now see:** a short answer with a few bullet points.

Examples:

- *"Which of my cards are worth more than €10?"*
- *"Suggest 10 upgrades under €2 for my Elves deck."*
- *"Build a deck only from free cards."*

Good to know:

- New decks from Claude appear in **Decks** as **Idea**.
- Claude can **correct** a copy (language, printing, foil, condition). It
  tells you the change first. Undo it in **Settings → Recent changes**.
- Claude can **never delete** cards.
- Old chats: tap **☰ Chats**. **＋ New chat** starts a fresh one.

> **If it doesn't work**
>
> - **"Claude is not configured on the server":** the token is missing. See
>   [Connect Claude](install.md#6-connect-claude-optional).
> - **"Claude Code CLI is not installed":** restart the app once it has
>   internet.
> - **No answer yet:** Claude keeps working if you leave. Come back later.

---

## 6. Backups and safety

**Make a backup:** see
[Installation guide → Update, stop, back up](install.md#9-update-stop-back-up).
Do it before big changes and every few weeks.

**Restore a backup:**

1. Open **Settings → Backups**.
2. Tap **Restore** next to a backup (or **Restore from file**).
3. Confirm.

**You should now see:** "Backup restored." The app saved your current data
first, just in case.

**Stay safe:** there is **no login**. Use the app only on your home network,
or a private network app like Tailscale. Never put it on the open internet.

> **If it doesn't work**
>
> - **Restore refused:** an import, scan or Claude answer is running. Wait a
>   moment.
> - **File "invalid":** use a `.db.gz` file this app made.
> - More: [backups-and-security.md](backups-and-security.md).

---

## 7. FAQ

**Why does an old card need a pick?**
Older cards carry less information. Right after the first start, the app
still learns card pictures. Pick the printing once and you're done.

**Can a ManaBox import wipe my scanned cards?**
No. Scanned cards and cards you sorted here are never removed by an import.

**Why euros only?**
The app uses Scryfall's euro prices. Foreign cards without a price use the
English card's price. Prices refresh about once a week, at night.

**Does the chat cost extra?**
It uses your own Claude plan. Scans that ask Claude count too (there is an
hourly limit).

More: [setup.md](setup.md), [scanner.md](scanner.md),
[collection.md](collection.md), [decks.md](decks.md), [claude.md](claude.md).
