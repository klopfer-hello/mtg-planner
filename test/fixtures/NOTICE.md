# Test fixtures: sources and credits

Recorded once from public APIs for the offline unit tests. Test data only:
nothing here is shipped in the image or shown in the app.

| File | Source |
| --- | --- |
| `scryfall-v9-cards.json` | Card data from [Scryfall](https://scryfall.com/) (`/cards/search`, `/cards/collection`), trimmed |
| `cards-classify.json` | Card data from Scryfall, with [Scryfall Tagger](https://tagger.scryfall.com/) tags (`otag:` searches) as the classifier's reference |
| `spellbook-estimate-*.json` | Responses of [Commander Spellbook](https://commanderspellbook.com/)'s `estimate-bracket` API (MIT-licensed backend, <https://github.com/SpaceCowMedia/commander-spellbook-backend>), trimmed |
| `decks-calibration/` | Calibration decklists and their recorded data; see [decks-calibration/NOTICE.md](decks-calibration/NOTICE.md) |

Card names, text and data are © Wizards of the Coast. Scryfall data is used
under the [Scryfall API guidelines](https://scryfall.com/docs/api).
