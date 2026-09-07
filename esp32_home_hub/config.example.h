#pragma once
/* =====================================================================
   HOME HUB - user settings. This is the only file you MUST edit.
   ===================================================================== */

/* ---- WiFi ---------------------------------------------------------- */
#define WIFI_SSID   "YOUR_WIFI_SSID"
#define WIFI_PASS   "YOUR_WIFI_PASSWORD"

/* ---- Google Apps Script -------------------------------------------- */
// Paste the /exec URL from the web app deployment. No trailing slash,
// no query string - the sketch appends ?token=... itself.
#define GAS_URL     "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec"

// Must match CFG.TOKEN in Code.gs, character for character.
#define HUB_TOKEN   "YOUR_LONG_RANDOM_TOKEN"

// How long to wait for Apps Script to answer (milliseconds). The response
// only begins once the script has finished reading every calendar, so this
// must exceed the "BUILD TIME" that testRun() logs. HTTP -11 in the serial
// log means this was too short - or, more likely, the script is too slow.
#define GAS_TIMEOUT_MS  30000

/* ---- Clock --------------------------------------------------------- */
// POSIX TZ string - handles daylight saving automatically.
//   Lithuania / Latvia / Finland : "EET-2EEST,M3.5.0/3,M10.5.0/4"
//   Central Europe (DE/FR/PL)    : "CET-1CEST,M3.5.0,M10.5.0/3"
//   UK                           : "GMT0BST,M3.5.0/1,M10.5.0"
//   US Eastern                   : "EST5EDT,M3.2.0,M11.1.0"
#define TZ_INFO     "EET-2EEST,M3.5.0/3,M10.5.0/4"
#define NTP_SERVER  "pool.ntp.org"

/* ---- Screen rotation ----------------------------------------------- */
// The Kindle browser will not rotate, so we rotate the PAGE instead:
// stand the Kindle on its side and the dashboard reads the right way up.
//   1 = rotate 90 deg clockwise (landscape)   0 = normal portrait
// Append ?rot=0 to any URL to disable it for one page load - handy when
// checking the layout on a desktop browser.
#define ROTATE_UI   1

// Fallback CSS pixel size of the Kindle screen in its NORMAL portrait
// orientation. A one-shot script corrects these at load time if the
// browser allows it, so approximate values are good enough.
//   Paperwhite / Oasis / basic 6" : 600 x 800
//   Scribe                        : 800 x 1070
#define SCREEN_W    600
#define SCREEN_H    800

/* ---- Timing -------------------------------------------------------- */
// How often the ESP32 pulls fresh data from Google (milliseconds).
// Apps Script has a daily quota, don't go below ~60s.
#define SYNC_INTERVAL_MS   (15UL * 60UL * 1000UL)

// How often the KINDLE reloads the page (seconds, <meta refresh>).
// Every reload is a full e-ink flash, so keep this long. 900 = 15 min.
// HABITS uses the quiet interval - a refresh landing mid-tap loses the
// tap, and habits never change on their own.
#define PAGE_REFRESH_SEC         900
#define PAGE_REFRESH_SEC_QUIET  1800

/* The daily 04:00 rollover is decided by the Apps Script (CFG.RESET_HOUR),
   not here, so it stays correct even if the ESP32's clock drifts. */
