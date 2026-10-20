// Error translation for the HTTP layer: the lib/ modules throw their own error
// classes with a status (a binder that doesn't exist, a deck version that
// can't be restored, ...); the server answers them with that status. Scryfall
// failures during imports are split into "the file was wrong" (400) and "the
// service failed" (502).

import { HttpError } from "./http.js";
import { BackupError } from "../lib/backups.js";
import { BinderError } from "../lib/binders.js";
import { PerfError } from "../lib/debugperf.js";
import { DebugError } from "../lib/debugsessions.js";
import { BuildError } from "../lib/deckbuild.js";
import { DeckHistoryError } from "../lib/deckhistory.js";
import { DeckError } from "../lib/decks.js";
import { DownloadError } from "../lib/downloads.js";
import { ScanError } from "../lib/scans.js";
import { SpellbookError } from "../lib/spellbook.js";
import { WishlistError } from "../lib/wishlist.js";

const LIB_ERRORS = [
  BackupError, BinderError, BuildError, DebugError, DeckError, DeckHistoryError, DownloadError, PerfError, ScanError, SpellbookError,
  WishlistError,
];

/** A lib/ error class with a status → HttpError (keeping `extra`, e.g. {code: 'confirm_master'}); null for anything else. */
export function libHttpError(err) {
  if (err instanceof HttpError) return err;
  if (LIB_ERRORS.some((cls) => err instanceof cls)) return new HttpError(err.status ?? 400, err.message, err.extra ?? null);
  return null;
}

/**
 * Errors of work that calls Scryfall (imports, commits, deck saves): lib/ errors keep their status,
 * a Scryfall 4xx (it rejected something from the user's file) and everything else (bad CSV) become
 * 400, Scryfall outages and network errors 502.
 */
export function importError(err) {
  const known = libHttpError(err);
  if (known) return known;
  if (err.status >= 400 && err.status < 500 && err.status !== 429) return new HttpError(400, `Scryfall rejected the request: ${err.message}`);
  // scryfall() sets err.status; fetch() network failures are TypeErrors with a cause.
  if (err.status || (err instanceof TypeError && err.cause)) return new HttpError(502, `Scryfall request failed: ${err.message}`);
  return new HttpError(400, err.message);
}

/** Rethrow `err` as importError(err) (for .catch handlers). */
export const throwImportError = (err) => { throw importError(err); };
