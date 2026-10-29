# flashc

Terminal flashcards for language learning (Thai 🇹🇭), backed by a **Google Sheet** as the data source, with **Anki-style SM-2 scheduling** and **Thai text-to-speech**.

## How it works

- Your Google Sheet holds the *content* (thai, romanization, english, notes — one word/phrase per row).
- SQLite (`~/.local/share/flashc/flashc.db`) holds your *memory*: due dates, intervals, ease factors, lapses.
- Thai audio is generated via Google Translate TTS, cached as mp3 in `~/.local/share/flashc/audio/`, played with `mpv`.
- **Big Thai display**: on sixel-capable terminals (e.g. foot) the Thai word is rendered inline as a ~1.5× larger image (proper Thai shaping via Pango), auto-colored to match your terminal. Adjust with `flashc scale <number>`; other terminals fall back to bold text.
- On every `flashc` / `flashc review` start, the sheet is synced: new rows become new cards, edited rows are updated, deleted rows are deactivated (progress kept).
- **Tabs**: `setup` lists all tabs in your sheet and asks which one to study (pick by number or name). The chosen tab is stored and used for every sync; re-run `setup` to switch tabs.

## Setup

Requirements: Node ≥ 22.5 (uses built-in `node:sqlite`), `mpv` for audio. Share your Google Sheet as **"Anyone with the link – Viewer"**.

```sh
npm install -g .        # or run via `node flashc.js ...` directly
flashc setup            # paste sheet link, map columns interactively
flashc                  # review session (syncs first)
```

## Commands

| Command | Description |
|---|---|
| `flashc setup` | Interactive: paste sheet URL, **pick a tab**, map columns (Thai, Romanization, English, Notes) |
| `flashc sync` | Manually sync the sheet |
| `flashc` / `flashc review` | Review session — syncs automatically, then shows due cards |
| `flashc scale [n]` | Show/set big-text scale (default 1.5 = 50% bigger than your terminal font) |
| `flashc config [key value]` | Show/change session settings (new per session, session size, big-text scale) |
| `flashc stats` | Due counts, retention %, average ease |
| `flashc list` | All cards with scheduling state |
| `flashc serve` | Run the web UI server (port 8814) for phone review |
| `flashc devices` | Two-way sync of progress with a remote host (default henry@nixos) |

## Web UI (phone review)

`flashc serve` runs the same scheduler and SQLite DB behind a tiny HTTP server
on port 8814: a mobile-friendly review page at `http://<host>:8814`, with audio
played in the browser via a cached Google-TTS proxy (no mpv needed). Run it
under a systemd user service for always-on use.

Studying on multiple machines: run `flashc devices` before/after sessions — it
pulls the remote DB, merges card-by-card (higher reps wins the scheduling
state, tie goes to newer `updated_at`; content edits follow `updated_at`),
pushes the merged result back, syncs the audio cache, and restarts the remote
service, so both devices share one history.

## Keys during review

| Key | Action |
|---|---|
| `p` | Play Thai audio (auto-plays on card show) |
| `space` / `enter` | Reveal romanization + English |
| `1` / `2` / `3` / `4` | Again / Hard / Good / Easy (next interval preview shown) |
| `s` | Skip card (pushes to back of queue) |
| `q` / `ctrl+c` | Quit |

## Focused sessions (built for 5–20 minutes)

A session is bounded, not endless: by default **max 20 answers** and **5 new cards** — tune with `flashc config` (`new_per_session`, `session_cards`) or add a time budget with `flashc --minutes 10`.

Within a session the card picker is dynamic:

1. Cards you're actively **learning** (due Again/step intervals — the words you struggle with dominate the session)
2. A **new card** after every 4 review answers (so you genuinely learn a few new words, even with a backlog)
3. Due **reviews**

If the next learning card is due within 3 minutes, the session waits with a countdown instead of dropping it. At the end you get a summary plus what's still due for later.

## Scheduling (SM-2, Anki-style)

- **New cards** go through learning steps: **1 min → 10 min**, then graduate at **1 day** (Easy graduates immediately at 4 days).
- **Again** on a review card resets it to relearning and lowers its ease factor; **Easy** raises it.
- Max 20 answers and 5 new cards per session (see `flashc config`); Again/learning-step cards re-appear within the same session.
- `stats` shows retention (1 − lapses/reviews) and average ease so you can see how well you're learning.

## Suggested sheet layout

Any layout works — `setup` maps your columns. A typical one:

| A (Thai) | B (Romanization) | C (English) | D (Notes) |
|---|---|---|---|
| สวัสดี | sawatdee | hello | also used as goodbye |
