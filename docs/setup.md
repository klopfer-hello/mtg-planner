# Setup and configuration

How to install mtg-planner, connect Claude, reach it from your phone and tune
its settings.

- [Install](#install)
- [First start](#first-start) (card index, warm-up)
- [The Settings tab](#the-settings-tab)
- [Phones and HTTPS](#phones-and-https)
- [Configuration](#configuration)
- [Volumes](#volumes)
- [Index and price refresh](#index-and-price-refresh)

Claude token and the Claude Code CLI: see [claude.md](claude.md).

## Install

The short version is the README's [Quick start](../README.md#quick-start).
Beginner walkthrough: [install.md](install.md). This section adds the options.
The published image is amd64 only for now (no ARM: Raspberry Pi, Apple-chip Macs).

mtg-planner is one Docker container. With Docker Compose:

```bash
git clone https://github.com/klopfer-hello/mtg-planner.git
cd mtg-planner
cp .env.example .env        # paste your CLAUDE_CODE_OAUTH_TOKEN (optional)
docker compose up -d        # pulls ghcr.io/klopfer-hello/mtg-planner:latest
```

Then open `http://<host>:8080` (change the host port with `MTG_PLANNER_PORT`).

Without Compose:

```bash
docker run -d --name mtg-planner --restart unless-stopped \
  -p 8080:8080 \
  -e CLAUDE_CODE_OAUTH_TOKEN=... \
  -v mtg-planner-data:/data \
  -v mtg-planner-claude:/claude \
  ghcr.io/klopfer-hello/mtg-planner:latest
```

On the first start the container downloads the Claude Code CLI into the
`/claude` volume (see [claude.md](claude.md#claude-code-cli-installed-at-runtime)),
which needs access to `registry.npmjs.org` once.

Host-specific additions such as a local build or reverse-proxy labels and
networks go into a gitignored `docker-compose.override.yml` (see
`docker-compose.override.yml.example`), so the committed compose file stays
generic.

Everything except the chat and the scanner's Claude fallback works without a
Claude token. The camera scanner needs HTTPS (see
[Phones and HTTPS](#phones-and-https)).

## First start

### Building the card index

The scanner needs a local card index, which is built in the background on
first start (turn this off with `SCAN_AUTO_INDEX=false`):

1. **Card metadata.** The app streams Scryfall's `all_cards` bulk file
   (about 400 MB gzipped) into `/data/cardindex.db`. This takes minutes and a
   few hundred MB of disk.
2. **Fingerprints.** The app downloads one small reference image per unique
   artwork and frame (about 78,000 images; the number follows Scryfall's
   catalogue) and hashes it. With at most two polite connections this takes
   **about two hours**. By default the images are kept under `/data/images`
   (**about 1.2 GB**) so that a future change to the hash only means
   re-hashing (with `FP_KEEP_IMAGES=false` they are hashed in memory and not
   stored). The job resumes on its own: after a restart or redeploy (with
   `SCAN_AUTO_INDEX` on) it continues where it stopped. While it runs, cards
   identified by the fingerprint alone are never accepted automatically.

The **Settings** tab (Scanner & data) shows the index status and has
**Refresh index** and **Build fingerprints** buttons. Refresh the index now
and then so new sets are recognised (the [nightly refresh](#index-and-price-refresh)
does this for you). Until fingerprints exist, scanning still works on cards
with a modern collector line, but older cards need more manual picking.

### Warm-up after a start

The fingerprints are loaded in a worker thread right after the server starts
(a few seconds; once after an upgrade that adds columns to the index, longer).
`/healthz` shows `scanner.matcher.state` (`loading`, `ready` or `error`) and
the load time. A scan sent while it is still loading waits for it, at most
`SCAN_MATCHER_WAIT_MS`, and the Scan tab says "warming up the scanner".

## The Settings tab

The **Settings** tab (gear icon, formerly *Import*) holds the ManaBox import,
the collection master and default import mode, recent changes with undo,
backups, and the scanner's card index.

## Phones and HTTPS

Beginner walkthrough (Tailscale): [install.md](install.md#7-make-the-phone-camera-work-https).

Phones only allow the camera on a secure address (`https://`). Common ways
to get one at home:

- **A reverse proxy** such as [Caddy](https://caddyserver.com/) or
  [Traefik](https://traefik.io/) in front of the app, with a certificate your
  phones trust (for example one made with
  [mkcert](https://github.com/FiloSottile/mkcert); install its root
  certificate on each phone).
- **A VPN or tunnel tool** that gives your devices HTTPS addresses for home
  services.

Details:

- Browsers only allow camera access in a **secure context**, which means
  HTTPS or `localhost`. Plain `http://<lan-ip>:8080` loads the app, but the
  camera won't start.
- The scanner works on **iOS Safari 17+** and **Android Chrome**. Probes use
  frames of the video stream (up to 4K). On Android a shutter scan can take a
  full-resolution still with `ImageCapture.takePhoto()` (a scan setting), and
  the torch can be toggled; on iPhone the torch only works on some devices.
- The camera starts only when you tap, and stops when you leave the tab.

Scanning tips are in [scanner.md](scanner.md#tips-for-good-scans).

## Configuration

Set these in `.env`, which `docker-compose.yml` loads if it exists:

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | *(empty)* | Token for the Claude Code CLI from `claude setup-token`. Without it the chat is disabled and `/healthz` reports `claude_configured: false`. |
| `CLAUDE_CODE_VERSION` | *(pinned in the image, 2.1.296)* | Claude Code CLI version the entrypoint installs into `/claude/cli`. Changing it installs that version on the next start. |
| `CLAUDE_CLI_INSTALL` | `true` | `false` skips the runtime install (bring your own CLI via `CLAUDE_BIN`, or run without the chat). |
| `CLAUDE_MODEL` | *(CLI default)* | Optional `--model` for the planner, e.g. `sonnet` or `opus`. |
| `CLAUDE_MAX_CONCURRENT` | `2` | Maximum number of Claude CLI processes running at once (one per chat turn). |
| `CLAUDE_TIMEOUT_MS` | `600000` | Hard timeout for a single chat turn. |
| `MTG_PLANNER_PORT` | `8080` | Host port published by `docker-compose.yml`. Only used for compose interpolation. |
| `SCRYFALL_USER_AGENT` | `mtg-planner/1.0 (+repo url)` | User-Agent for the app's own Scryfall requests. |
| `SCAN_CLAUDE_PER_HOUR` | `60` | Maximum Claude vision calls per hour for uncertain scans. `0` disables the Claude fallback. |
| `CLAUDE_SCAN_MODEL` | `sonnet` | Model for the scanner's vision fallback. |
| `SCAN_THRESHOLDS` | *(empty)* | JSON object that overrides single decision thresholds (see [Calibration mode](scanner.md#calibration-mode)). |
| `SCAN_AUTO_INDEX` | `true` | Build the card index and then the fingerprints automatically when the index is empty. |
| `FP_KEEP_IMAGES` | `true` | Keep downloaded reference images under `FP_IMAGE_DIR` (about 1.2 GB) for cheap re-hashing. |
| `FP_INDEX_SETS` | *(empty)* | Comma-separated set codes that limit the fingerprint job (for testing). Empty means all sets. |
| `INDEX_BULK_SOURCE` | *(empty)* | Local path (or URL) of a Scryfall `all_cards` .jsonl.gz to build the index from instead of downloading it. Empty means download. |
| `SCAN_DUPLICATE_WINDOW_MS` | `20000` | A shutter scan of the same printing and finish within this window is offered as +1 instead of being staged. |
| `SCAN_MAX_CONCURRENT` | `2` | Scans identified at the same time; further uploads get HTTP 429 ("still identifying") until one finishes. |
| `SCAN_MATCHER_WAIT_MS` | `30000` | How long a scan waits for the fingerprint matcher to finish loading after a server start; after that the scan goes on without the fingerprint (OCR / Claude only). |
| `CLAUDE_SCAN_MAX_BUDGET_USD` | `0.25` | Spend cap per Claude vision call (`--max-budget-usd`). |
| `CLAUDE_SCAN_TIMEOUT_MS` | `90000` | Timeout for one Claude vision call. |
| `OCR_TIMEOUT_MS` | `20000` | Timeout for one OCR/djpeg run. |
| `OCR_MAX_CONCURRENT` | `2` | OCR runs at once (persistent helpers, or tesseract processes without the helper). |
| `OCR_HELPER` | `/usr/local/bin/mtg-ocr` | Persistent OCR helper on the libtesseract API (built in the image, about 5x faster per read than starting tesseract). `off` starts the tesseract CLI per read instead; a helper that keeps crashing is skipped for a minute the same way. |
| `MTG_OCR_MAX_LANGS` | `4` | OCR language sets each helper keeps loaded (least recently used are dropped). |
| `DEBUG_SESSIONS_DIR` | `<database dir>/debug-sessions` | Where **Record session** stores its diagnostic frames (see [Record session](scanner.md#record-session)). |
| `SCHEDULER_ENABLED` | `true` | Nightly maintenance (see [Index and price refresh](#index-and-price-refresh)). `false` turns it off. |
| `INDEX_REFRESH_HOUR` | `4` | Hour of day (0-23, container local time) of the maintenance window. |
| `INDEX_REFRESH_DAYS` | `7` | Minimum age of the card index before it is refreshed (only when Scryfall has newer bulk data). |
| `PRICE_REFRESH_DAYS` | `1` | Minimum age in days of the last price refresh of owned, deck and wishlist cards (1 = every night). |
| `TZ` | *(UTC)* | Container time zone (IANA name, e.g. `Europe/Berlin`), used for `INDEX_REFRESH_HOUR`. |
| `BACKUP_DIR` | `<database dir>/backups` (`/data/backups`) | Where manual backups and pre-restore safety backups are stored (see [Backups](backups-and-security.md#backups)). |
| `BACKUP_KEEP` | `20` | Manual backups kept; older ones are deleted when a new one is made. Pre-restore safety backups are kept separately (the last 5). |
| `DOWNLOAD_DIR` | `<database dir>/downloads` (`/data/downloads`) | Android app files (`*.apk`) offered under **Settings → Phone app**. Copy an APK there (optional `<name>.apk.json` with `title`, `version`, `notes`); the section is hidden while the folder is empty. Nothing can be uploaded through the app. |
| `SCAN_IMAGE_DIR` | `<database dir>/scans` | Where uploaded scan photos are kept until they are committed (calibration scans keep them). |

These are set in the image and rarely need changing: `PORT=8080`,
`DB_FILE=/data/mtg-planner.db`, `STATIC_DIR=/app/public`,
`CLAUDE_CONFIG_DIR=/claude`,
`SCRYFALL_MCP_ENTRY=/opt/scryfall-mcp/dist/index.js`,
`INDEX_DB_FILE=/data/cardindex.db`, `FP_IMAGE_DIR=/data/images`,
`OMP_THREAD_LIMIT=1` (keeps tesseract to one thread per process) and
`APP_VERSION`, which is set at build time.

## Volumes

| Mount | Contents |
| --- | --- |
| `/data` | SQLite database (WAL mode), the scanner's card index (`cardindex.db`), reference images (`images/`, ~1.2 GB), stored scan photos, backups (`backups/`), recorded scan sessions (`debug-sessions/`), and the CLI's working directory |
| `/claude` | Claude Code config and chat sessions, so conversations can resume after a restart, plus the runtime-installed CLI in `/claude/cli` (about 250 MB) |

## Index and price refresh

A built-in scheduler keeps data fresh without any clicks. It checks every 15
minutes and acts only inside the hour `INDEX_REFRESH_HOUR` (default 4 o'clock,
container local time, so set `TZ`). It runs one job at a time:

- the scanner's **card index** is refreshed when it is older than
  `INDEX_REFRESH_DAYS` (default 7) **and** Scryfall's bulk data is newer than
  the local copy (one small request to Scryfall's bulk-data list), followed by
  the incremental fingerprint job, which skips already-hashed cards;
- the **prices** of owned, deck and wishlist cards are refreshed when the last
  refresh is older than `PRICE_REFRESH_DAYS` (default 1 = every night), within
  Scryfall's rate limits (about 2,300 printings take well under a minute);
- the day's **collection value** is saved for the Market tab
  ([finance.md](finance.md)), also when the price refresh was skipped or failed.

It runs at most once per night: later checks in the same hour, and restarts
inside it, skip once the run is done (a failed price refresh is retried within
the hour). A container started inside that hour checks a minute after start.

The last and next runs are shown in the index panel of the Settings tab and in
`GET /api/index/status`. `SCHEDULER_ENABLED=false` turns it off.

Each ManaBox import also refreshes prices. To refresh card data and prices
without importing, call `POST /api/refresh-prices`. It re-fetches everything
you own or use in a deck.
