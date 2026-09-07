# The Home Hub

A minimalist e-ink desk dashboard for a **non-jailbroken Kindle**. An ESP32
pulls Google Calendar, Google Tasks and weather through a private Apps Script
web app, then serves table-based black-and-white HTML on your LAN.

Data path: **Google ↔ your ESP32 ↔ your Kindle.** Nothing else.

Interaction is **tap-only** — every task, chore and habit has a 40×40px box.
There is no text input anywhere; add things from your phone, tick them here.

```
home_hub/
├── apps_script/Code.gs          paste into script.google.com
├── esp32_home_hub/
│   ├── esp32_home_hub.ino       WiFi, sync, HTTP handlers
│   ├── config.h                 ← the only file you edit
│   └── page.h                   every byte of HTML/CSS the Kindle sees
└── README.md
```

## The three views

| View | Contents |
|---|---|
| **FOCUS** | Next-up countdown in 64px Georgia, alert strip, merged task + chore list |
| **PLAN** | 7-day calendar grid, today inverted, plus a 3-day forecast strip |
| **HABITS** | GitHub-style contribution graph + stats, then every habit with a 7-day mini-grid and its grace streak |

### How the pieces behave

**All your calendars are read**, not just the default one. Each calendar costs
one query over the whole window and results are bucketed locally — querying
per-day-per-calendar would be seven times the API calls. Run `listCalendars()`
in the Apps Script editor to print every calendar name, then put the noisy ones
(holiday feeds, birthdays, subscribed fixtures) into `CFG.EXCLUDE_CALENDARS`.

**Taps are write-behind.** A tap updates the screen and returns immediately; the
HTTPS call to Google is queued and drained ~2.5 s later, once the browser has
finished reloading. Doing it inline cost 2–5 s per tap. Completed rows vanish
instantly from a local overlay, which is dropped once a sync confirms Google's
own state. The header shows `saving N` while writes are outstanding — if power
is cut in that window, those writes are lost.

**Next Up** finds the very next event however far away — Apps Script searches in
widening windows (2 → 14 → 90 → 365 days) so the common case costs one small
query instead of pulling a year of every calendar on every sync. It sends the
event's raw epoch, and **the ESP32 computes the countdown at render time**, so
it's accurate on every page load rather than only at the moment of the sync.

**The contribution graph** is 7 rows (Mon–Sun) × 26 week columns, one cell per
day, darker the more you completed that day — habits, tasks and chores all
count. Levels are 0 / 1–2 / 3–4 / 5–7 / 8+. Apps Script sends each row as a
string of level digits (`'-'` = future), so the ESP32 renders it as a straight
character-to-class mapping with no arithmetic. Underneath in small print: total
actions, day streak, today's count, active-day percentage, daily average, best
day, and longest habit streak.

> **On greys and e-ink.** Earlier versions of this README said "no greys" flatly.
> That's right for *text and hairlines* — they dither into mush — but **solid
> grey fills are fine**; the panel has 16 levels. That's what makes the five
> graph levels legible. Empty days get a black outline rather than a grey one.

**The merged list** flattens *every* Google Tasks list, tags each row with its
source, and sorts by deadline (undated last). On **Wednesdays and Fridays** the
household chores are spliced in at the top — they're the thing that must not be
scrolled past. Friday also carries that week-of-month's deep-clean job. Ticked
chores disappear for the rest of the day.

**Grace streaks.** A streak only breaks after **two consecutive misses**, so one
bad day costs you nothing. Today counts as neutral until ticked — an untouched
morning never shows a broken streak. The streak is *recomputed from history*
every time rather than incremented, so un-ticking, a missed sync or a clock
change can't corrupt it.

**The 04:00 rollover.** The logical day rolls at 4am, not midnight — a 02:00
finish still counts as yesterday. It's decided in Apps Script
(`CFG.RESET_HOUR`), so it stays correct even if the ESP32's clock drifts.

**History storage.** Each habit's history is one 60-character bit-string,
index 0 = today. Script Properties caps a single value at 9KB; 11 habits × 60
*dates* would blow that, but 11 × 60 *chars* is under a kilobyte, and the daily
rollover is one string concat.

---

## 1. Google Apps Script

### 1a. Paste the script
1. **https://script.google.com** → **New project**, rename it `Home Hub`.
2. Delete the stub, paste all of [apps_script/Code.gs](apps_script/Code.gs).
3. Check `CFG` at the top — see the config table below.

### 1b. Enable the Tasks API
Left sidebar → **Services** → **+** → **Tasks API** → **Add**.
The identifier must stay `Tasks`.

### 1c. Authorise
Function dropdown → `testRun` → **Run** → *Review permissions* → *Advanced* →
*Go to Home Hub (unsafe)* → **Allow**. Check **Execution log** for your JSON.

> Re-authorise whenever you add a feature that needs a new scope — weather uses
> `UrlFetchApp` (`script.external_request`). Without fresh consent the *whole*
> script throws, not just the new part.

### 1d. Deploy
**Deploy → New deployment → ⚙ → Web app**
- **Execute as:** `Me`
- **Who has access:** **`Anyone`**

Copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`).

> **Why "Anyone":** it means *no login required to call this URL* — it does
> **not** publish your code. `Code.gs` lives in your Drive and is never readable
> by anyone. Google neither lists nor indexes the URL, and `doGet` rejects every
> request without the right `TOKEN`. An ESP32 cannot complete a Google OAuth
> consent screen, so the account-restricted setting would only ever hand it a
> login page.

### 1e. ⚠️ Re-deploying after edits
Editing `Code.gs` does **nothing** to the live web app. Every time:
**Deploy → Manage deployments → ✏️ → Version: `New version` → Deploy.**
The URL stays the same.

### 1f. Verify before touching the ESP32
```
https://script.google.com/macros/s/YOUR_ID/exec?token=YOUR_LONG_RANDOM_TOKEN
```
You want JSON with `nextUp`, `merged`, `week`, `habits`, `weather`. A login page
means 1d is wrong. Don't continue until this passes.

### Configuration

All of it lives in `CFG` at the top of `Code.gs` — **not** on the ESP32.

| Setting | What it does |
|---|---|
| `RESET_HOUR` | Daily rollover hour. `4` = 04:00. |
| `EXCLUDE_CALENDARS` | Exact calendar names to skip. Run `listCalendars()` to see them all. |
| `GRAPH_WEEKS` / `SCORE_DAYS` | Width of the contribution graph and how much daily history is kept. |
| `HABITS` | The daily checklist. Ships with 11; keep it near that or every streak breaks in week two. |
| `CHORES` | `weekday`: 0=Sun … 6=Sat. Currently Wed (3) and Fri (5). `who: 0/1` indexes `PEOPLE`, and **the pair swaps every week** so neither of you always gets the bathroom. |
| `DEEP_CLEAN` | One job per `week: 1-4` of the month, added to the Friday set. |
| `PEOPLE` | `['Me', 'Partner']` — names shown against each chore. |
| `BINS` | Warns the evening before and again on the day. |
| `COUNTDOWN_CALENDAR` | Name of a Google Calendar (default `Countdowns`). All-day events in it become "Trip — 12 days". Skipped silently if it doesn't exist. |
| `WEATHER.lat/lon` | **Currently Vilnius — change this.** |
| `MAX_MERGED` | Rows on the FOCUS list. |

`resetHabits()` and `resetChores()` in the editor wipe state clean.

### Endpoints

| Action | Effect |
|---|---|
| `?token=X` | Full payload |
| `&action=toggleHabit&id=H` | Tick / untick a habit for the logical day |
| `&action=completeTask&list=L&id=I` | Complete a Google Task |
| `&action=completeChore&id=C` | Tick a chore for today |
| `&action=ping` | Health check |

---

## 2. ESP32

### 2a. Board support
**File → Preferences → Additional board manager URLs:**
```
https://espressif.github.io/arduino-esp32/package_esp32_index.json
```
Then **Tools → Board → Boards Manager** → install **esp32 by Espressif Systems**.

### 2b. Libraries
`WiFi.h`, `WebServer.h`, `HTTPClient.h`, `WiFiClientSecure.h` ship with the
board package — nothing to install.

**ArduinoJson v7** by Benoît Blanchon — **Sketch → Include Library → Manage
Libraries**.

> **On the 12KB buffer requirement:** v7's `JsonDocument` grows on the heap as
> it parses, so there is no fixed buffer to size — it comfortably exceeds the
> ~12KB a full week needs, limited only by free heap (~200KB here). The sync log
> prints free heap each cycle so you can watch it. **On v6 the sketch will not
> compile** — change `JsonDocument lastDoc;` and `JsonDocument fresh;` to
> `DynamicJsonDocument …(16384);`.

### 2c. Configure
Everything is in [config.h](esp32_home_hub/config.h) — WiFi, `GAS_URL`,
`HUB_TOKEN`, timezone, rotation, refresh intervals. Already filled in with your
values. Sync runs every 15 minutes.

### 2d. Flash
**ESP32 Dev Module** → your COM port → Upload (hold **BOOT** if it stalls on
`Connecting....`). Serial Monitor at **115200**:

```
Connected! IP: 192.168.1.57
[GAS] ok - 7 rows, 11 habits, 7 days (heap 214880)
[HTTP] server started on port 80
```

If the counts are `0`, the Apps Script wasn't re-deployed (1e).

### 2e. Fix the IP
Reserve the ESP32's MAC in your router's DHCP settings, or the Kindle bookmark
breaks on the next reboot.

---

## 3. Rotation — running the Kindle on its side

The Kindle browser won't rotate, so the **page** rotates instead. Stand the
Kindle on its side and the dashboard reads the right way up in landscape, which
is what the layouts are designed for.

- `ROTATE_UI 1` in `config.h` (default on).
- `SCREEN_W` / `SCREEN_H` are fallback dimensions in *portrait* — 600×800 for a
  Paperwhite, Oasis or basic 6". One guarded line of JS measures the real
  viewport and corrects them; with JS off, the fallback stands.
- **`http://<ip>/?rot=0`** disables rotation for one page load — your first
  diagnostic, and how you preview the layout on a desktop browser.

If the rotated page looks wrong: try `?rot=0` to prove the content is fine, then
set `SCREEN_W`/`SCREEN_H` to your model's real values, then `ROTATE_UI 0`. If
your Kindle's WebKit is too old for CSS transforms, portrait is the only option.

---

## 4. The Kindle

1. **⚙ All Settings → Wi-Fi** → same network as the ESP32 (not a guest network).
2. **⋮ → Web Browser** → `http://192.168.1.57` — **including `http://`**, or the
   Kindle hands it to a search engine.
3. **Bookmark this page.**
4. **Menu → Settings → Article Mode OFF.** Article Mode flattens the tables into
   one reading blob.

### Kindle quirks, and how this build handles them

| Quirk | Handling |
|---|---|
| Every reload is a full e-ink flash | Auto-refresh 15 min; HABITS uses 30 min so a refresh never lands mid-tap. `↻` forces one. |
| A JS clock would flash every second | No frontend JS but the one-shot rotation fixup. Views and actions are URL parameters. |
| Flexbox/Grid destabilise the browser | Everything is `<table>`. Never introduce them. |
| E-ink dithers greys into mush | Pure `#000` on `#fff`. Emphasis is inverted blocks and borders, never shading. |
| Aggressive caching serves stale pages | `Cache-Control: no-store` + `Pragma: no-cache` on every response. |
| Imprecise touch layer | 40×40px bordered tap boxes. |
| Reload re-submitting an action | Every action answers `303` back to its view. |
| Screen sleeps | Unavoidable without jailbreaking. Tap to wake. Keep it on the charger. |

Fonts: Georgia (bundled on every Kindle) for headings and the countdown,
Helvetica falling back to Arial for data.

---

## 5. Troubleshooting

| Symptom | Cause |
|---|---|
| `[GAS] parse error` + HTML in the log | Not deployed as **Anyone** (1d). |
| `[GAS] rejected: unauthorized` | `HUB_TOKEN` ≠ `CFG.TOKEN`. Check for a trailing space. |
| `[GAS] failed -1` | DNS/TLS. **The ESP32 cannot see 5 GHz WiFi** — it must be on 2.4 GHz. |
| `SYNC FAILED HTTP -11` / `script too slow` | Read timeout: the connection worked but Apps Script didn't finish in `GAS_TIMEOUT_MS` (30 s). Run `testRun()` and read the **BUILD TIME** it logs. Over ~10 s means too many calendars — run `listCalendars()` and add the noisy ones to `CFG.EXCLUDE_CALENDARS`. |
| Empty views, `0 rows / 0 habits` | Apps Script not re-deployed as a **new version** (1e). |
| Everything throws after adding weather | Re-authorise — `UrlFetchApp` needs a new scope (1c). |
| Countdown shows `--` | NTP hasn't landed. Wait ~15s; if it persists, check `TZ_INFO`. |
| Tasks missing | Tasks API service not added (1b). |
| Chores don't appear | It isn't Wednesday or Friday, or they're already ticked. |
| Chores show the wrong person | They alternate by week on purpose. Set both `who` values the same to stop it. |
| Countdowns never appear | You need a calendar literally named `Countdowns` with all-day events. |
| Streak looks too high | That's the grace rule — one missed day doesn't break it. Two consecutive do. |
| Blank/mangled screen on Kindle | See section 3. |
| Layout is one long column | Article Mode is on. |
| **Taps do nothing / views never switch on the Kindle** | Almost certainly the rotation transform. Old WebKit sometimes applies a CSS transform *visually* but hit-tests at the **untransformed** position, so your tap lands somewhere else entirely. Diagnose it as below. |
| A text box / "search bar" on the page | You're running old firmware or a cached page. There is no `<input>` anywhere in the current build. If you mean the bar at the top of the Kindle browser, that's browser chrome — no web page can remove it. |
| Only one calendar's events show | Old `Code.gs`. Re-deploy as a new version. |

### Diagnosing broken taps on the Kindle

1. Open `http://<ip>/?rot=0`. If tabs and boxes work here, the page is fine and
   the transform is the problem.
2. Back on the rotated page, try tapping where a tab would be **if the page were
   not rotated** — i.e. the strip along the physical top edge in portrait terms.
   If that works, it's confirmed: the browser is hit-testing untransformed.
3. There is no CSS fix for that. Set `ROTATE_UI 0` in `config.h` and run the
   Kindle upright, or keep rotation and accept that it's display-only.

**Tuning the CSS:** open `http://<ip>/?rot=0` in a desktop browser — that's the
live page, so there's no mockup file to drift out of sync. All styles are in the
`appendHead()` string in [page.h](esp32_home_hub/page.h).
