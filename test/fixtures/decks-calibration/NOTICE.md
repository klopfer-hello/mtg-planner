# Calibration decks: sources and credits

These files are the calibration set for the Commander bracket and the 1-10
score (`lib/power.js`, `test/calibration.test.js`). They are test data only:
nothing here is shipped in the image or shown in the app.

## Decklists

Each `.txt` file starts with its source URL and author.

| File | Deck | Source | Author |
| --- | --- | --- | --- |
| `precon-blight-curse.txt` | Blight Curse (Lorwyn Eclipsed Commander, 2026) | Wizards of the Coast product decklist, via [MTGJSON](https://mtgjson.com/) | Wizards of the Coast |
| `precon-lorehold-spirit.txt` | Lorehold Spirit (Secrets of Strixhaven Commander, 2026) | Wizards of the Coast product decklist, via MTGJSON | Wizards of the Coast |
| `precon-doom-prevails.txt` | Doom Prevails (Marvel Super Heroes Commander, 2026) | Wizards of the Coast product decklist, via MTGJSON | Wizards of the Coast |
| `precon-temur-roar.txt` | Temur Roar (Tarkir: Dragonstorm Commander, 2025) | Wizards of the Coast product decklist, via MTGJSON | Wizards of the Coast |
| `edge-precon-world-shaper.txt` | World Shaper (Edge of Eternities Commander, 2025) | Wizards of the Coast product decklist, via MTGJSON | Wizards of the Coast |
| `upgraded-lorehold-spirit.txt` | Indi-elephant Jones: Lorehold Spirit precon upgrade | <https://archidekt.com/decks/21339969> | cjw217 |
| `upgraded-world-shaper.txt` | Land-ocrats: World Shaper precon upgrade | <https://archidekt.com/decks/5443206> | cloudprince |
| `upgraded-blight-curse.txt` | Auntie Ool's Blight Curse (heavily modified precon) | <https://archidekt.com/decks/20289302> | big_deck |
| `edge-upgraded-temur-roar.txt` | "Temur Roar" precon upgrade | <https://archidekt.com/decks/12356066> | mjburns |
| `optimized-chatterfang.txt` | Chatterfang, Squirrel General | <https://archidekt.com/decks/3188140> | zhopa |
| `optimized-edgar-markov.txt` | High Power Aristocrats Edgar Markov | <https://archidekt.com/decks/7319967> | Ozymandias- |
| `optimized-wilhelt.txt` | Wilhelt, the Rotcleaver Bracket 4 Optimized Zombie Tribal | <https://archidekt.com/decks/5072301> | Wertos |
| `cedh-tymna-thrasios.txt` | TnT cEDH 2026, Tymna / Thrasios | <https://archidekt.com/decks/1727139> | Clutchness |
| `cedh-vivi-storm.txt` | Vivi Ornitier Storm, cEDH | <https://archidekt.com/decks/13764494> | alexmorris092 |

The lists were retrieved on 2026-10-15 and are kept unchanged (only the
deck's own cards: no maybeboard, no sideboard). Thanks to every author for
publishing them. The authors' own bracket labels are in the file headers;
`index.json` holds the bracket the app's rules give (see
[docs/decks.md](../../../docs/decks.md)).

MTGJSON data is released under the MIT License (<https://mtgjson.com/license/>).

## Card data

`cards.json`: card objects from the [Scryfall API](https://scryfall.com/docs/api)
(`/cards/collection`, recorded 2026-10-15), trimmed to the fields the app
stores. Used under the Scryfall API guidelines. Not produced by or endorsed by
Scryfall.

## Combo data

`spellbook.json`: answers of [Commander Spellbook](https://commanderspellbook.com/)'s
`estimate-bracket` endpoint for these lists (card names only were sent,
recorded 2026-10-15), trimmed to the fields `lib/spellbook.js` reads. Commander
Spellbook's backend is MIT-licensed
(<https://github.com/SpaceCowMedia/commander-spellbook-backend>). Combo data
by the Commander Spellbook community.

## Magic: The Gathering

Card names and card text are © Wizards of the Coast LLC. This is unofficial
Fan Content permitted under the
[Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy),
not approved or endorsed by Wizards of the Coast.
