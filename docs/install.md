# Installation guide

From "I have a computer" to "the scanner works on my phone".
Do one part at a time. Each part ends with a check, so you know it worked.

**Contents**

1. [What you need](#1-what-you-need)
2. [Install Docker](#2-install-docker)
3. [Get mtg-planner](#3-get-mtg-planner)
4. [Create the settings file](#4-create-the-settings-file)
5. [Start it](#5-start-it)
6. [Connect Claude (optional)](#6-connect-claude-optional)
7. [Make the phone camera work (HTTPS)](#7-make-the-phone-camera-work-https)
8. [Add it to your home screen](#8-add-it-to-your-home-screen)
9. [Update, stop, back up](#9-update-stop-back-up)
10. [Still stuck? Read the log](#10-still-stuck-read-the-log)

**Words used here**

- **Terminal**: a window where you type commands. Windows: *PowerShell*.
  macOS: *Terminal*. Linux: your usual terminal.
- **Docker**: a program that runs apps in a sealed box (a *container*).
- **HTTPS**: a secure web address that starts with `https://`. Phones only
  allow the camera on those.

---

## 1. What you need

- [ ] **A computer that stays on**: a PC, a home server or a NAS.
- [ ] **An Intel or AMD processor (64-bit, "amd64").**
  Sorry: Raspberry Pi, ARM NAS boxes and Macs with an Apple chip (M1 or
  newer) are ARM computers. They are **not supported yet**. We'd like to add
  them later.
- [ ] **About 3 GB of free disk space** (mostly the scanner's card data).
- [ ] **About 1-2 GB of free memory (RAM).**
- [ ] **Internet** on that computer.
- [ ] **A phone** with iOS Safari 17+ or Android Chrome.
- [ ] **Optional: a Claude Pro or Max plan.** Only for the chat and for help
  with hard-to-scan cards. Everything else works without it.

---

## 2. Install Docker

### Windows or Intel Mac

1. Download **Docker Desktop**: <https://docs.docker.com/get-docker/>
2. Install it. Accept the defaults.
   Windows may ask to turn on **WSL 2**. Say yes and restart.
3. Start Docker Desktop. Wait for **Engine running**.
4. Open **Settings → General**.
5. Turn on **Start Docker Desktop when you sign in**.

Note: Docker Desktop only starts after someone signs in. After a Windows
update restart, sign in once, or the app stays off. (A Linux server or NAS
is better for "always on".)

### Linux

1. Install Docker (Debian, Ubuntu and most others):

   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   ```

   Other systems: <https://docs.docker.com/engine/install/>
2. Let your user run Docker:

   ```bash
   sudo usermod -aG docker $USER
   ```

3. Log out and log back in.

### Check it

Open a new terminal and type:

```bash
docker compose version
```

**You should now see:** something like `Docker Compose version v2.x.x`.

> **If it doesn't work**
> - `command not found` or `not recognized`: close the terminal and open a
>   new one. Still there? Docker isn't installed.
> - `Cannot connect to the Docker daemon`: start Docker Desktop and wait for
>   **Engine running**.
> - Linux `permission denied`: you skipped step 3 (log out and in).

---

## 3. Get mtg-planner

You need the project folder. It holds the start file (`docker-compose.yml`)
and the settings template (`.env.example`).

**With git:**

```bash
git clone https://github.com/klopfer-hello/mtg-planner.git
cd mtg-planner
```

**Without git:**

1. Open <https://github.com/klopfer-hello/mtg-planner>.
2. Click **Code → Download ZIP**.
3. Unpack the ZIP.
4. Open a terminal in that folder.
   Windows: right-click in the folder → **Open in Terminal**.

Check it:

```bash
ls
```

**You should now see:** `docker-compose.yml` in the list.

> **If it doesn't work**
> - No `docker-compose.yml`? ZIPs often unpack into a folder inside a
>   folder. Type `cd mtg-planner-main` and try `ls` again.

---

## 4. Create the settings file

The app reads its settings from a file called `.env`.

1. Copy the template:

   ```bash
   cp .env.example .env
   ```

2. Open it in a text editor.
   Windows: `notepad .env`. macOS: `open -e .env`. Linux: `nano .env`.
3. Find the line `# TZ=Europe/Berlin` (at the very end).
4. Delete the `# ` at the start.
5. Change `Europe/Berlin` to your time zone
   ([list of names](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)).
6. Save and close.

Leave everything else as it is. The Claude token comes in part 6.

**You should now see:** a line `TZ=...` without `#` in `.env`.

> **If it doesn't work**
> - macOS Finder (and many Linux file managers) hide files that start with a
>   dot. That's fine: the commands still work. (Finder: Cmd+Shift+. shows them.)
> - Notepad saved it as `.env.txt`? Rename it: `Rename-Item .env.txt .env`

---

## 5. Start it

1. In the project folder, type:

   ```bash
   docker compose up -d
   ```

   Docker downloads the app (a few hundred MB) and starts it in the
   background.
2. Wait about a minute. Then type:

   ```bash
   docker compose ps
   ```

   **You should now see:** `mtg-planner` with `Up` (later `Up ... (healthy)`).
3. On the same computer, open <http://localhost:8080>.

**You should now see:** the mtg-planner app with tabs at the bottom.

**On the first start** the app builds its card data in the background:

- After a few minutes, cards printed since 2014 can be scanned.
- After about 2 hours, older cards are recognised well too.
- Progress: **Settings → Scanner & data**.

> **If it doesn't work**
> - `port is already allocated`, `address already in use` or
>   `ports are not available`: another program uses port 8080.
>   1. Open `.env`.
>   2. Change `MTG_PLANNER_PORT=8080` to `MTG_PLANNER_PORT=8090`.
>   3. Run `docker compose up -d` again.
>   4. Open <http://localhost:8090> (and use `8090` in part 7 too).
> - `no matching manifest` or `exec format error`: your computer has an ARM
>   chip. Sorry, not supported yet (see part 1).
> - Page doesn't load: wait one more minute. Then see part 10.
> - "Warming up the scanner": the scanner loads its data after each start.
>   Wait a few seconds and scan again.

---

## 6. Connect Claude (optional)

Skip this if you don't want the chat. You need a **Claude Pro or Max** plan.

1. Install **Claude Code** on any computer: <https://claude.com/claude-code>
2. Log in with your Claude account when it asks.
3. In a terminal, type:

   ```bash
   claude setup-token
   ```

4. It prints a long code (a *token*). Copy it.
5. Open `.env` again. Find `CLAUDE_CODE_OAUTH_TOKEN=`.
6. Paste the code right after the `=`. No spaces, no quotes. Save.
7. Restart the app (do this after every `.env` change):

   ```bash
   docker compose up -d
   ```

8. Open the **Planner** tab and ask *"How many cards do I own?"*

**You should now see:** a short answer from Claude.

**Keep the token secret.** Anyone who has it can use your Claude plan.
Never share or upload `.env`.

> **If it doesn't work**
> - "Claude Code CLI is not installed": the app downloads a helper on start
>   and needs internet for that. Then run `docker compose restart`.
> - Open <http://localhost:8080/healthz>. You see one line of text.
>   Find `"claude_configured":true`. It says `false`? The token isn't in
>   `.env`, or you forgot `docker compose up -d`.

---

## 7. Make the phone camera work (HTTPS)

Phones only start the camera on an `https://` address. Plain
`http://192.0.2.10:8080` opens the app, but the camera stays black.

The easiest way is **Tailscale**: a free private network for your own
devices. It gives your computer an HTTPS address that only your devices can
reach, at home and on the go.

### 7a. On the Tailscale website

1. Create a free account: <https://tailscale.com/download>
2. Open <https://login.tailscale.com/admin/dns>.
3. Make sure **MagicDNS** is on.
4. Further down, click **Enable HTTPS**.

### 7b. On the computer running mtg-planner

1. Install Tailscale from <https://tailscale.com/download> and log in.
   (Linux: `sudo tailscale up`.)
2. Share the app over HTTPS (Linux: put `sudo` in front):

   ```bash
   tailscale serve --bg 8080
   ```

   If it prints a link and waits: open the link, enable HTTPS, come back.
   `--bg` keeps sharing on, also after a restart.
3. It prints your address, like `https://my-computer.tail1234.ts.net/`.
   Write it down. (Show it again: `tailscale serve status`.)

### 7c. On your phone

1. Install the **Tailscale** app.
2. Log in with the **same account**.
3. Switch Tailscale **on**.
4. Open your address in Safari (iPhone) or Chrome (Android).
   The first visit can take a few seconds.
5. Open the **Scan** tab and tap **Start camera**. Allow camera access.

**You should now see:** the camera picture. Hold a card still in view and it
shows up in your scan list.

**Already run Caddy or Traefik?** You can put mtg-planner behind it instead,
with a certificate your phone trusts. Details:
[setup.md → Phones and HTTPS](setup.md#phones-and-https).

**Keep it private.** mtg-planner has **no login**. Anyone who can open it can
change your data and use your Claude plan.

- Use it only on your home network or your Tailscale network.
- Never forward the port on your router or open it to the internet.

> **If it doesn't work**
> - `tailscale: command not found`: open a new terminal. On macOS see
>   Tailscale's docs.
> - The command looks different now: check
>   <https://tailscale.com/kb/1242/tailscale-serve>
> - Page doesn't open on the phone: Tailscale must be **on** in the phone's
>   app, with the same account.
> - Camera stays black: allow it. iPhone: **Settings → Safari → Camera →
>   Allow**. Android: tap the icon left of the address → **Permissions →
>   Camera**.
> - Turn sharing off: `tailscale serve reset`

---

## 8. Add it to your home screen

Then it opens like an app. Use your **HTTPS address** from part 7.

**iPhone (Safari):**

1. Open the address in **Safari**.
2. Tap **Share** (square with an arrow).
3. Tap **Add to Home Screen**, then **Add**.

**Android (Chrome):**

1. Open the address in **Chrome**.
2. Tap the **⋮** menu (top right).
3. Tap **Add to home screen** (or **Install app**), then confirm.

**You should now see:** the mtg-planner icon on your home screen.

> **If it doesn't work**
> - No "Add to Home Screen"? Use Safari on iPhone, Chrome on Android.

---

## 9. Update, stop, back up

Run the commands in the project folder.

**Back up first** (one tap, only when you do it):

1. In the app, open **Settings → Backups**.
2. Tap **Create backup**.
3. Tap **Download**. Keep the file on another device too.

**Update:**

1. Installed with git? Run `git pull` first. (ZIP: skip this.)
2. Get the new version and restart:

   ```bash
   docker compose pull
   docker compose up -d
   ```

**You should now see:** `docker compose ps` shows `Up (healthy)` again after
about a minute. Your data stays.

**Stop:**

```bash
docker compose down
```

Your data stays. Start again with `docker compose up -d`.
**Never add `-v`** (`docker compose down -v`). That deletes all your data.

> **If it doesn't work**
> - `pull` says `no matching manifest`: ARM computer, see part 1.
> - App gone after `down`? Run `docker compose up -d` in the project folder.
> - More about backups: [backups-and-security.md](backups-and-security.md#backups)

---

## 10. Still stuck? Read the log

The log usually says what went wrong:

```bash
docker compose logs --tail 100
```

Still stuck? Open an issue and paste the log (remove your token if it shows
up): <https://github.com/klopfer-hello/mtg-planner/issues>

All settings: [setup.md](setup.md). Using the app: [guide.md](guide.md).
