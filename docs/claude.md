# Claude planner

How the chat works, how to connect your Claude subscription, and what Claude
can and cannot do with your data.

- [What the planner does](#what-the-planner-does)
- [Getting the token](#getting-claude_code_oauth_token)
- [Claude Code CLI (installed at runtime)](#claude-code-cli-installed-at-runtime)

## What the planner does

<img src="img/planner.webp" width="260" alt="A chat in the Planner tab">

The **Planner** tab is a chat that runs the
[Claude Code CLI](https://claude.com/claude-code) headless
with exactly two MCP servers:

- **collection**, this repo's own MCP server: it reads your collection and
  decks, reads up to 40 cards per call with their text, roles and ownership
  (`get_cards`; the planner is told to read cards before it recommends them
  instead of trusting its memory), saves decks (`save_deck`), writes a deck's notes only when you ask (`update_deck_notes`,
  Markdown, only the notes; the old text stays in the deck's History; updating a deck keeps its notes) and can correct owned copies
  (`edit_copies`: language, printing, finish or condition, after stating the
  exact change). It cannot delete anything; every edit is logged and can be
  undone in the app. It has no access to backups. `get_deck` and
  `list_decks` show each Commander deck's bracket and 1-10 score;
  `evaluate_deck` checks a draft list (stats, bracket, score, combos) without
  saving it, and `save_deck`/`evaluate_deck` take a `target_bracket` and answer
  OK, OVER (with the cards that push it up) or UNDER. See
  [decks.md](decks.md#bracket-and-power-score). `list_wishlist` shows the
  wishlist and `add_to_wishlist` adds a card when you ask; removing items is
  only possible in the app ([finance.md](finance.md#wishlist)).
  `get_deck_history` reads a deck's [history](decks.md#deck-history) (read-only).
  Knowledge tools (v1.3.0), all read-only:
  - `deck_gaps`: a deck's lands, ramp, draw, removal, wipes, protection, recursion,
    cheap plays and curve against tuned public decks of its format and bracket,
    with your free cards that fill each gap ([decks.md](decks.md#gaps-and-goldfish)).
  - `simulate_deck`: 10 000 solo test games (opening hands, land drops,
    colour screw, commander on curve, combos).
  - `commander_staples`: what other players run with a commander (EDHREC).
  - `owned_combos`: combos your collection already holds (Commander Spellbook).
  - `recent_cards`: cards from the last months, newer than the model's knowledge.
  - `rules_lookup` and `get_rulings`: the Comprehensive Rules and card rulings,
    so rules answers cite a rule number.
  - `meta_decks` and `compare_to_meta`: the Pauper tournament meta from MTGO.
  `save_deck` refuses a new Commander or Pauper deck that breaks its format's
  rules and starts its answer with a short summary the planner repeats.
- **[bmurdock/scryfall-mcp](https://github.com/bmurdock/scryfall-mcp)** gives
  access to every card ever printed, prices, the comprehensive rules, staple
  and synergy searches, and deck and mana-base analysis.

Ask things like *"Build me a budget Atraxa superfriends deck using mostly
cards I own, max €40 to buy"*. Claude checks what you own first and saves the
deck so it appears in the Decks tab as an *idea*. Ask it to build *"only from
free cards"* and it leaves the copies your built decks use alone. Answers are
kept short for a phone screen: the answer first, a few bullets, and a deck
summary instead of the full list (ask for details when you want them).
Conversations keep going across restarts (`--resume`).

Each deck has **its own chat**: ✨ on a deck page opens it (made on first use,
titled *Deck: name*) with everything said before, and sends nothing by itself.
When that chat starts a new Claude session, the first message carries the
deck's current list, notes and prices (what `get_deck` shows). Deleting the deck
keeps the chat as a normal one.

**Deck guides** (Decks → a deck → **Guide**) use Claude too, but not the chat:
one request without any tools gets the deck's facts and list and answers with
the strategy parts as JSON (`CLAUDE_GUIDE_MODEL`, default `sonnet`; budget
`CLAUDE_GUIDE_MAX_BUDGET_USD`, default 0.50; timeout `CLAUDE_GUIDE_TIMEOUT_MS`,
default 180000). It shares the limit of parallel Claude runs with the chat and
the scanner. `get_deck` tells Claude whether a deck has a guide (and whether the deck
changed since), so it can point you to it. See [decks.md](decks.md#deck-guide).

**Settings → Planner** chooses the model (Default, Sonnet or Opus; `CLAUDE_MODEL`
in `.env` wins) and holds a short profile the planner reads before every answer:
the formats you play, your usual Commander bracket, a budget per upgrade, what
to avoid and one free line (for example "short, precise answers"). It stays in
your database. The section also shows what the last answer cost.

**👍 / 👎 under each answer** teach the planner. With 👎 you can add one line on
what was wrong. About 20 seconds after your last rating (and never while a chat
is answering) Claude merges the ratings into at most six short rules, one small
request on your Claude plan. The planner reads these rules before every answer.
They show under **Settings → Planner → Learned from your ratings**, where you
can edit or clear them. Ratings keep a copy of the question and answer, so
deleting a chat does not lose them; they stay in your database.

Claude's `search_collection` tool uses the same
[search syntax](collection.md#search-syntax) as the collection browser.
Binder names, each row's source (ManaBox, scan or app) and owned vs. free
copies are visible to Claude.

## Getting `CLAUDE_CODE_OAUTH_TOKEN`

On any machine where Claude Code is installed and logged in to your Claude
subscription (Pro or Max), run:

```bash
claude setup-token
```

and paste the printed token into `.env`. The planner then **uses your Claude
subscription's usage**, not API credits. Each chat turn starts one
`claude -p` process.

The planner has **no built-in Claude Code tools**: no shell, no file access
and no web. It is started with `--tools ""` and `--strict-mcp-config`, so it can
only use the two MCP servers listed above.

The same token is used by the scanner's optional Claude fallback (see
[scanner.md](scanner.md#how-a-card-is-identified)).

## Claude Code CLI (installed at runtime)

The Claude Code CLI is proprietary software of Anthropic and is **not part of
this repository or the published image**. The image's entrypoint
(`scripts/entrypoint.sh`) installs the pinned version on start:

```
npm install -g --prefix /claude/cli @anthropic-ai/claude-code@$CLAUDE_CODE_VERSION
```

It runs only when `/claude/cli` is missing or holds a different version, so it
downloads once per volume and version; later starts skip it. The install goes
into a temporary directory first, so a failed upgrade keeps the working
version. If the install fails (for example without network access), the app
still starts: the chat and the scanner's Claude fallback report that the CLI
is not installed, and `/healthz` shows
`claude_cli: {status: "missing", ...}` (`"installed"` with the version once it
works). Restart the container to retry. You use the CLI under
[Anthropic's terms](https://www.anthropic.com/legal/consumer-terms) with your
own subscription.

Related settings (`CLAUDE_CODE_VERSION`, `CLAUDE_CLI_INSTALL`, `CLAUDE_MODEL`,
`CLAUDE_MAX_CONCURRENT`, `CLAUDE_TIMEOUT_MS`) are listed in
[setup.md](setup.md#configuration).
