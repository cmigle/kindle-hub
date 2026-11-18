/* Renders one Home Hub page with the real esp32_home_hub/page.h, for the simulator.
   stdin:  {"payload":{...}, "view":"focus", "rotate":false, "hidden":["id"],
            "overlay":{"habitId":true}, "pending":0, "syncOk":true,
            "syncClock":"09:30", "error":"", "clock":"09:41", "date":"Wednesday, 18 November"}
   stdout: the HTML the ESP32 would send. */
#include <ArduinoJson.h>
#include <iostream>
#include <iterator>
#include <map>
#include <set>
#include <string>
#include "Arduino.h"
#include "WebServer.h"

JsonDocument lastDoc;
bool   lastSyncOk = false;
String lastSyncClock;
String lastError;
int    pendingCount = 0;

static String clockText, dateText;
String getClock() { return clockText; }
String getDate()  { return dateText; }

static std::set<std::string> hidden;
static std::map<std::string, bool> overlay;

bool isHidden(const char *id) { return id && hidden.count(id); }
int habitOverlay(const char *id) {
  auto it = id ? overlay.find(id) : overlay.end();
  return it == overlay.end() ? -1 : (it->second ? 1 : 0);
}

#include "page.h"

int main() {
  std::string input((std::istreambuf_iterator<char>(std::cin)), std::istreambuf_iterator<char>());
  JsonDocument req;
  if (deserializeJson(req, input)) { std::cerr << "render: invalid JSON on stdin\n"; return 2; }

  lastDoc.set(req["payload"]);
  lastSyncOk    = req["syncOk"] | false;
  lastSyncClock = req["syncClock"] | "--:--";
  lastError     = req["error"] | "";
  pendingCount  = req["pending"] | 0;
  clockText     = req["clock"] | "--:--";
  dateText      = req["date"] | "";
  for (JsonVariantConst id : req["hidden"].as<JsonArrayConst>()) hidden.insert(id.as<std::string>());
  for (JsonPairConst kv : req["overlay"].as<JsonObjectConst>()) overlay[kv.key().c_str()] = kv.value().as<bool>();

  WebServer server;
  sendPage(server, req["view"] | "focus", req["rotate"] | false);
  std::cout << server.body;
  return 0;
}
