# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OLTC-v3 ("Opleiding tot AI-chatbot") is an interactive physical installation combining a Node.js/Express backend, a vanilla-JS single-page frontend, and ESP32 firmware for hardware control. Three interactive modules guide participants through AI/chatbot concepts using physical inputs (rotary dial, buttons, sensors) and multimedia output (video, audio).

## Running the Project

**Quick start (macOS):**
```bash
open "Start installatie.command"   # kills any previous server, starts fresh, opens both UIs
```
The script opens admin in regular Chrome and opens the player view in a kiosk Chrome instance on a second screen (`--window-position=-1280,0`, isolated `--user-data-dir=/tmp/oltc-kiosk`).

**Manual start:**
```bash
cd server
npm install       # first time only
npm start         # or: node server.js — serves on http://localhost:3000
```

- Main game UI: `http://localhost:3000/`
- Admin panel: `http://localhost:3000/admin.html`

**ESP32 firmware (requires PlatformIO CLI):**
```bash
cd esp32_oltc
pio run -t upload        # build and flash to connected ESP32
pio device monitor       # watch serial output at 115200 baud
```

**Optional FFmpeg** (for video conversion):
```bash
brew install ffmpeg
```

There are no test or lint scripts configured.

## Module Descriptions

| Module | Physical input | Game mechanic |
|---|---|---|
| **1 — Quiz** | Rotary dial (selects answer), lever switch (INPUT DATA / TEST MODEL modes) | Player feeds trainable sentences by filling blanks with a dial; then tests the "AI model" on unseen sentences. LED bar tracks mastery. |
| **2 — Bias** | Left/right buttons | Player hears an audio story and presses the button matching the correct person. Wrong guesses restart the streak. A sequence of correct answers unlocks the next module. |
| **3 — Pump** | Water level sensors (HOOG/LAAG), LCD display | Player pumps water to complete a word-recognition task. A configurable number of correct pump cycles wins; a 4-digit participant code is displayed and read aloud. |

## Architecture

### Backend (`server/`)

`server.js` — Express app on port 3000 that serves static files from the project root and exposes a REST API. `db.js` auto-creates and seeds a SQLite database (`server/database.sqlite`) on first run.

REST API surface (all prefixed `/api/`):
| Prefix | Domain |
|---|---|
| `/sentences`, `/sentences/round` | Quiz sentences and multiple-choice options |
| `/game/progress`, `/game/state`, `/game/reset` | Live game state and reset signalling |
| `/bias/stories`, `/bias/config`, `/bias/progress`, `/bias/state` | Module 2 bias-recognition stories |
| `/pump/words`, `/pump/config` | Module 3 word recognition |
| `/audio`, `/videos` | Media file management + FFmpeg conversion jobs |
| `/settings` | Global key-value configuration store (persisted in SQLite) |
| `/io/state`, `/io/update` | Hardware I/O status mirroring |
| `/modules/:id/complete`, `/modules/counts` | Participant completion codes |

Key backend patterns:
- **Settings as KV store** — configuration (active video, reset tokens, audio filenames) lives in the `settings` table rather than env vars; read/write via `GET /api/settings` and `PUT /api/settings/:key`. Known keys: `active_video`, `reset_token`, `bias_reset_token`, `bias_*_audio`, `bias_sensor_min/max`, `pump_required`, `pump_word_duration`, `module1/2/3_count`, `digit_0`–`digit_9_audio` (pump code readout).
- **In-memory vs persisted state** — `gameProgress`, `biasProgress`, and `ioState` objects in `server.js` are in-memory and reset on server restart. Reset tokens are persisted in `settings`.
- **Atomic DB operations** — use `db.transaction()` for multi-statement writes (e.g. sentence + options together).
- **In-memory job map** — FFmpeg conversion jobs are tracked in a `Map` and cleaned up after 5 minutes; there is no persistent job queue.
- **Reset tokens** — game/bias reset is signalled by incrementing an integer in `settings`; the frontend polls for changes instead of using WebSockets.

### Database schema (`server/db.js`)

| Table | Purpose |
|---|---|
| `sentences` | Quiz sentences; `type` ∈ `('trainable','nonsense')` |
| `options` | Multiple-choice options per sentence; cascades on delete |
| `settings` | Key-value config store |
| `bias_stories` | Bias module audio stories; `correct_button` ∈ `('left','right')` |
| `pump_words` | Words for pump game; `is_correct` flag |

### Frontend (`index.html`, `admin.html`)

Both files are self-contained: HTML, all CSS, and all JavaScript are inline (no build step). `index.html` is the ~2000-line game interface; `admin.html` is the ~1700-line admin/CRUD panel.

`index.html` connects to the physical ESP32 over the **Web Serial API** and communicates via a simple text protocol:

| Direction | Example | Meaning |
|---|---|---|
| ESP32 → browser | `R:<diff>` | Rotary encoder delta |
| ESP32 → browser | `S:QUIZ` / `S:VIDEO` | Lever switch state |
| ESP32 → browser | `B:LEFT` / `B:RIGHT` | Button press |
| ESP32 → browser | `D:<0-4095>` | Distance sensor reading |
| ESP32 → browser | `C:HIGH` / `C:LOW` | Liquid level sensor |
| browser → ESP32 | `LCD:<row>,<text>` | Write text to LCD row (16 chars) |
| browser → ESP32 | `PUMP:<ms>` | Activate pump relay |
| browser → ESP32 | `LED:<20-char state string>` | Set 20 LED states (chars `0`–`6`); firmware scales to 18 physical LEDs |

### ESP32 Firmware (`esp32_oltc/src/esp32_oltc.ino`)

Arduino C++ on `esp32dev`. Reads inputs, writes `Serial.println()` messages (above protocol), and listens for incoming commands. Debounce threshold is 30 ms. I2C bus (GPIO 21/22) is shared by the LCD and rotary encoder; both are auto-detected by address scan at boot.

The rotary encoder driver supports two hardware types detected automatically:
- **Qwiic Twist** (I2C addr `0x3E`/`0x3F`) — reads absolute count via register `0x05`/`0x06`
- **Adafruit Seesaw** (I2C addr `0x36`–`0x3D`) — reads signed delta via module `0x11`, register `0x40`

LED strip: SK6812 RGBW, 18 LEDs wired in a non-sequential physical order; the firmware maps software LED indices 0–19 to hardware positions via `PHYSICAL_ORDER[]`.

### Media Assets

- `audio/` — `.m4a` files; served statically; managed via admin panel.
- `video/` — `.webm` preferred (VP8/Vorbis); `.mp4`/`.mov` can be uploaded and converted server-side via FFmpeg to WebM.
