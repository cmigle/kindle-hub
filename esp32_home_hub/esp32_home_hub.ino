/* =====================================================================
   THE HOME HUB - ESP32 bridge between Google and a non-jailbroken Kindle
   ---------------------------------------------------------------------
   Libraries: WiFi.h, WebServer.h, HTTPClient.h, WiFiClientSecure.h
              (bundled with the esp32 board package)
              + ArduinoJson v7 by Benoit Blanchon   <-- install this one

   Views:  FOCUS   next-up countdown + merged task/chore list
           PLAN    7-day grid across ALL calendars + 3-day forecast
           HABITS  contribution graph, stats, habits with 7-day minis

   WRITE-BEHIND: a tap updates the screen immediately and returns. The
   HTTPS call to Google is queued and drained a couple of seconds later,
   once the browser has finished reloading. Doing the call inline made
   every tap cost a 2-5s round trip, which is what made view switching
   feel broken.

   Interaction is tap-only. There is no text input anywhere.
   ===================================================================== */

#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <time.h>

#include "config.h"

/* ---------------------- globals (page.h reads these) --------------- */

WebServer    server(80);

/* ArduinoJson v7's JsonDocument grows on the heap as it parses, so there
   is no fixed buffer to size - it comfortably exceeds the ~12KB a full
   week of every calendar needs, limited only by free heap (~200KB).
   On v6 you must write DynamicJsonDocument lastDoc(24576); and the same
   for `fresh` in syncHub(). */
JsonDocument lastDoc;

bool   lastSyncOk    = false;
String lastSyncClock = "--:--";
String lastError     = "";

static uint32_t nextSync      = 0;
static uint32_t lastClientMs  = 0;   // last time a browser asked for anything

/* ------------------ write-behind queue + overlay ------------------- */

#define MAX_PENDING  10
#define MAX_HIDDEN   16
#define MAX_OVERLAY  16

static String   pendingAction[MAX_PENDING];
int             pendingCount = 0;          // page.h shows this as "saving N"

static String   hiddenId[MAX_HIDDEN];      // rows ticked but not yet confirmed
static int      hiddenCount = 0;

struct HabitOverlay { String id; bool done; };
static HabitOverlay overlay[MAX_OVERLAY];
static int          overlayCount = 0;

static void queueAction(const String &params) {
  if (pendingCount >= MAX_PENDING) {
    Serial.println(F("[queue] full, dropping oldest"));
    for (int i = 1; i < pendingCount; i++) pendingAction[i - 1] = pendingAction[i];
    pendingCount--;
  }
  pendingAction[pendingCount++] = params;
}

static void hideRow(const String &id) {
  for (int i = 0; i < hiddenCount; i++) if (hiddenId[i] == id) return;
  if (hiddenCount < MAX_HIDDEN) hiddenId[hiddenCount++] = id;
}

static void setOverlay(const String &id, bool done) {
  for (int i = 0; i < overlayCount; i++) {
    if (overlay[i].id == id) { overlay[i].done = done; return; }
  }
  if (overlayCount < MAX_OVERLAY) {
    overlay[overlayCount].id = id;
    overlay[overlayCount].done = done;
    overlayCount++;
  }
}

static void clearOverlays() { hiddenCount = 0; overlayCount = 0; }

/* Called from page.h during rendering. */
bool isHidden(const char *id) {
  if (!id) return false;
  for (int i = 0; i < hiddenCount; i++) if (hiddenId[i] == id) return true;
  return false;
}

int habitOverlay(const char *id) {
  if (!id) return -1;
  for (int i = 0; i < overlayCount; i++) {
    if (overlay[i].id == id) return overlay[i].done ? 1 : 0;
  }
  return -1;
}

#include "page.h"                 // needs the globals above

/* ---------------------------- clock -------------------------------- */

String getClock() {
  struct tm t;
  if (!getLocalTime(&t, 50)) return "--:--";
  char b[10]; strftime(b, sizeof(b), "%H:%M", &t);
  return String(b);
}

String getDate() {
  struct tm t;
  if (!getLocalTime(&t, 50)) return "";
  char b[40]; strftime(b, sizeof(b), "%A, %d %B", &t);
  return String(b);
}

/* ------------------------- Apps Script ----------------------------- */

/* URL encoding lives in page.h as enc() - one copy, used by both. */

/** One GET to the web app. `params` is appended after ?token=... */
static String gasRequest(const String &params) {
  if (WiFi.status() != WL_CONNECTED) { lastError = F("wifi down"); return String(); }

  WiFiClientSecure client;
  client.setInsecure();     // no CA bundle here; the token in the URL is
                            // the auth. Note: do NOT call setTimeout on
                            // the client - the ESP32 core takes SECONDS
                            // there and milliseconds on HTTPClient, and
                            // mixing them up silently breaks reads.

  HTTPClient http;
  String url = String(GAS_URL) + "?token=" + enc(HUB_TOKEN) + params;

  if (!http.begin(client, url)) { lastError = F("begin failed"); return String(); }

  // Apps Script always 302s /exec to script.googleusercontent.com.
  // STRICT keeps the method as GET across the hop.
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.setConnectTimeout(15000);
  // Generous: the response only starts once Apps Script has finished
  // building the payload, which means reading every calendar.
  http.setTimeout(GAS_TIMEOUT_MS);

  uint32_t t0 = millis();
  int code = http.GET();
  String res;

  if (code == HTTP_CODE_OK) {
    res = http.getString();
    Serial.printf("[GAS] %u ms\n", (unsigned)(millis() - t0));
  } else if (code == HTTPC_ERROR_READ_TIMEOUT) {
    // The script is too slow, not unreachable. Usually too many
    // calendars - run listCalendars() and fill in EXCLUDE_CALENDARS.
    lastError = F("script too slow");
    Serial.printf("[GAS] read timeout after %u ms - Apps Script did not "
                  "finish in time. Trim CFG.EXCLUDE_CALENDARS.\n",
                  (unsigned)(millis() - t0));
  } else {
    lastError = String(F("HTTP ")) + code;
    Serial.printf("[GAS] failed %d (%s) after %u ms\n", code,
                  http.errorToString(code).c_str(),
                  (unsigned)(millis() - t0));
  }
  http.end();
  return res;
}

/** Pull the full payload. Keeps the last good data on failure. */
static bool syncHub() {
  Serial.printf("[GAS] syncing... (heap %u)\n", (unsigned)ESP.getFreeHeap());
  String body = gasRequest("");

  if (body.isEmpty()) { lastSyncOk = false; return false; }

  JsonDocument fresh;
  DeserializationError err = deserializeJson(fresh, body);

  if (err) {
    lastSyncOk = false;
    lastError  = String(F("json ")) + err.c_str();
    Serial.printf("[GAS] parse error: %s\n", err.c_str());
    // Usual cause: the web app is not deployed as "Anyone", so Google
    // returned an HTML login page instead of JSON.
    Serial.println(body.substring(0, 200));
    return false;
  }

  if (!(fresh["ok"] | false)) {
    lastSyncOk = false;
    lastError  = fresh["error"] | "rejected";
    Serial.printf("[GAS] rejected: %s\n", lastError.c_str());
    return false;
  }

  // Swap in the new payload only once it has parsed and passed, so a bad
  // response can never blank a working dashboard.
  lastDoc = fresh;
  lastSyncOk    = true;
  lastSyncClock = getClock();
  lastError     = "";

  Serial.printf("[GAS] ok - %u rows, %u habits, %u days "
                "(script %ld ms, heap %u)\n",
                (unsigned)lastDoc["merged"].as<JsonArrayConst>().size(),
                (unsigned)lastDoc["habits"].as<JsonArrayConst>().size(),
                (unsigned)lastDoc["week"].as<JsonArrayConst>().size(),
                (long)(lastDoc["ms"] | 0L),
                (unsigned)ESP.getFreeHeap());
  return true;
}

static void scheduleNextSync() { nextSync = millis() + SYNC_INTERVAL_MS; }

/* --------------------------- handlers ------------------------------ */

/** Rotation is on unless config disables it or the URL says ?rot=0. */
static bool wantRotate() {
#if ROTATE_UI
  return server.arg("rot") != "0";
#else
  return false;
#endif
}

static String currentView() {
  String v = server.arg("view");
  if (v != "plan" && v != "habits") v = "focus";
  return v;
}

/** Bounce back to a view. 303 so a reload never repeats the action. */
static void redirectTo(const String &view, bool rotate) {
  String loc = "/?view=" + view;
  if (!rotate) loc += "&rot=0";

  server.sendHeader(F("Location"), loc);
  server.sendHeader(F("Cache-Control"), F("no-store"));
  server.send(303, "text/plain", "");
}

static void handleRoot() {
  lastClientMs = millis();
  sendPage(server, currentView(), wantRotate());
}

/** Complete a Google Task: hide it now, tell Google in a moment. */
static void handleDone() {
  lastClientMs = millis();
  String list = server.arg("list");
  String id   = server.arg("id");

  if (!id.isEmpty() && !list.isEmpty()) {
    hideRow(id);
    queueAction("&action=completeTask&list=" + enc(list) + "&id=" + enc(id));
  }
  redirectTo("focus", wantRotate());
}

static void handleChore() {
  lastClientMs = millis();
  String id = server.arg("id");

  if (!id.isEmpty()) {
    hideRow(id);
    queueAction("&action=completeChore&id=" + enc(id));
  }
  redirectTo("focus", wantRotate());
}

/** Toggle a habit. The box flips instantly; the streak number and the
    contribution graph catch up on the next sync. */
static void handleToggle() {
  lastClientMs = millis();
  String id = server.arg("id");

  if (!id.isEmpty()) {
    bool now = true;
    int ov = habitOverlay(id.c_str());
    if (ov >= 0) now = (ov == 0);            // flip the overlay we already hold
    else {
      for (JsonObjectConst hb : lastDoc["habits"].as<JsonArrayConst>()) {
        const char *hid = hb["id"].as<const char *>();
        if (hid && id == hid) { now = !(hb["done"] | false); break; }
      }
    }
    setOverlay(id, now);
    queueAction("&action=toggleHabit&id=" + enc(id));
  }
  redirectTo("habits", wantRotate());
}

static void handleRefresh() {
  lastClientMs = millis();
  syncHub();                       // explicit request: worth the wait
  scheduleNextSync();
  if (pendingCount == 0 && lastSyncOk) clearOverlays();
  redirectTo(currentView(), wantRotate());
}

static void handleNotFound() {
  lastClientMs = millis();
  redirectTo("focus", wantRotate());
}

/* --------------------- write-behind drain -------------------------- */

/*
 * Only runs once the browser has been quiet for a moment. Draining
 * immediately would be pointless: the 303 is followed straight away by
 * a GET for the page, and a 2s HTTPS call in between would block it -
 * exactly the stall this design exists to remove.
 */
static void drainQueue() {
  if (pendingCount == 0) return;
  if (millis() - lastClientMs < 2500) return;
  if (WiFi.status() != WL_CONNECTED) return;

  String action = pendingAction[0];
  for (int i = 1; i < pendingCount; i++) pendingAction[i - 1] = pendingAction[i];
  pendingCount--;

  Serial.printf("[queue] sending (%d left)\n", pendingCount);
  gasRequest(action);

  // Once everything is written, re-sync and drop the local overlay so
  // the screen goes back to showing Google's truth.
  if (pendingCount == 0) {
    if (syncHub()) clearOverlays();
    scheduleNextSync();
  }
}

/* --------------------------- boot / loop --------------------------- */

static void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);              // keeps the web server responsive
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.print(F("Connecting to WiFi"));
  uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print('.');
    // A dead AP should not strand the hub forever.
    if (millis() - started > 30000) {
      Serial.println(F("\n[WiFi] timeout, retrying"));
      WiFi.disconnect(true);
      delay(500);
      WiFi.begin(WIFI_SSID, WIFI_PASS);
      started = millis();
    }
  }
  Serial.println("\nConnected! IP: " + WiFi.localIP().toString());
  Serial.println(F(">>> Point the Kindle browser at http://<that IP> <<<"));
}

void setup() {
  Serial.begin(115200);
  delay(300);

  connectWiFi();
  configTzTime(TZ_INFO, NTP_SERVER, "time.google.com");

  syncHub();
  scheduleNextSync();

  server.on("/",        HTTP_GET, handleRoot);
  server.on("/done",    HTTP_GET, handleDone);
  server.on("/chore",   HTTP_GET, handleChore);
  server.on("/toggle",  HTTP_GET, handleToggle);
  server.on("/refresh", HTTP_GET, handleRefresh);
  server.onNotFound(handleNotFound);
  server.begin();

  Serial.println(F("[HTTP] server started on port 80"));
}

void loop() {
  server.handleClient();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(F("[WiFi] lost, reconnecting"));
    WiFi.reconnect();
    delay(2000);
    return;
  }

  drainQueue();

  // Signed compare survives the millis() rollover at ~49 days. Never
  // sync while writes are still queued - it would show stale state.
  if (pendingCount == 0 && (int32_t)(millis() - nextSync) >= 0) {
    if (syncHub()) clearOverlays();
    scheduleNextSync();
  }
}
