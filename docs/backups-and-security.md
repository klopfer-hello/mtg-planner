# Backups and security

How to back up and restore your data, and how to keep the app safe.

- [Backups](#backups)
- [Security](#security)

## Backups

The **Backup & restore** panel in the Settings tab works by hand only: there
are no scheduled backups, and Claude's MCP tools have no access to backups.

- **Create backup** writes a consistent snapshot of the app database
  (SQLite `VACUUM INTO`, safe while the app runs) as
  `mtg-planner-YYYYMMDD-HHMMSS.db.gz` to `BACKUP_DIR`, plus a small `.json`
  manifest (app version, schema version, time, and counts of copies, printings,
  decks, binders, scans and chats). It holds the collection, binders, decks,
  the scan list with calibration data, planner chats and settings. It doesn't
  hold the scanner's card index, fingerprints, scan photos or Claude's sessions.
  Those are rebuilt, or not worth keeping.
- **Download** saves the `.db.gz` file. Store it somewhere other than the server.
- **Restore** (from the list, or **Restore from file** with a downloaded
  `.db.gz`, at most 50 MB) replaces **all** app data after a confirmation. The
  file is unpacked and checked first (SQLite integrity check, the expected
  tables, a schema not newer than the running app). Then a
  `...-pre-restore.db.gz` safety backup of the current data is taken and the
  database file is swapped. Backups from older app versions are upgraded by the
  usual migrations. If anything fails, the current data stays as it was. The
  backup being restored is never deleted by the safety backup's retention.
  Scan photos stay in place on disk, so restoring the safety backup later brings
  them back with their scans. A restore is
  refused (409) while an import, a scan or a planner answer is running.

`BACKUP_KEEP` (default 20) manual backups are kept; pre-restore safety backups
are kept separately (the last 5). See [setup.md](setup.md#configuration).

API: `GET /api/backups`, `POST /api/backups`,
`GET /api/backups/<name>/download`, `DELETE /api/backups/<name>`,
`POST /api/backups/<name>/restore` with `{"confirm": true}`, and
`POST /api/backups/restore-upload?confirm=1` with the `.db.gz` as an
`application/gzip` body.

## Security

**There is no authentication.** Anyone who can reach the app can read your
collection, import over it, edit and delete decks, and **use your Claude
subscription** through the chat. Run it only on a trusted LAN, or behind a
reverse proxy that handles authentication (for example Authelia, oauth2-proxy
or basic auth in Caddy/nginx). Don't expose it to the internet as it is.

State-changing API requests that a browser marks as cross-site (via
`Sec-Fetch-Site` or an `Origin` that doesn't match the `Host`) are refused,
and the API requires `application/json` bodies (ManaBox import: `text/csv`, or
`text/plain` only together with the app's `X-Requested-With` header; backup
upload: `application/gzip` or `application/octet-stream`). A plain HTML form
can send none of these, so other web pages open in a LAN browser can't
trigger imports, restores, scans or deck changes. This is not a
substitute for authentication.

The Claude CLI runs without built-in tools or slash commands, but its two MCP
servers can reach the internet (Scryfall), write decks and edit owned copies
(never delete them; every edit can be undone in the app).

**Outbound calls.** Besides Scryfall (card data and prices) the app calls
[Commander Spellbook](https://commanderspellbook.com/) for the combo check:
every Commander deck change (also ManaBox import rebuilds and drafts Claude
checks with `evaluate_deck`) sends the card names and quantities of the
commander and main deck, plus the server's public IP like any web request.
Results are cached for 14 days. Turn it off in Settings → Online services
(restoring a backup keeps it off), or for good with `SPELLBOOK_ENABLED=false`
in `.env`. The names go to `backend.commanderspellbook.com` unless the server
admin points `SPELLBOOK_URL` in `.env` elsewhere; the app's API can't change
that address. Details:
[decks.md](decks.md#combo-check-commander-spellbook).
