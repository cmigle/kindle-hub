/* Host build of esp32_home_hub/page.h.
   Renders every view from test/host/fixtures/payload.json (produced by the real
   Code.gs) and checks the HTML the Kindle would receive.

   Usage: page_test <payload.json> [--preview <dir>]
   --preview also writes focus.html, plan.html and habits.html for a desktop browser. */
#include <ArduinoJson.h>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include "Arduino.h"
#include "WebServer.h"

/* ---- what esp32_home_hub.ino normally provides ---- */
JsonDocument lastDoc;
bool   lastSyncOk    = true;
String lastSyncClock = "09:30";
String lastError     = "";
int    pendingCount  = 0;

String getClock() { return "09:41"; }
String getDate()  { return "Wednesday, 18 November"; }

static std::set<std::string> hidden;
static std::map<std::string, bool> overlay;

bool isHidden(const char *id) { return id && hidden.count(id); }
int habitOverlay(const char *id) {
  auto it = id ? overlay.find(id) : overlay.end();
  return it == overlay.end() ? -1 : (it->second ? 1 : 0);
}

#include "page.h"

/* ---- tiny test runner ---- */
static int failures = 0, checks = 0;

#define CHECK(cond) do { checks++; if (!(cond)) { failures++; \
  std::cerr << __FILE__ << ":" << __LINE__ << ": CHECK failed: " #cond "\n"; } } while (0)

static bool contains(const std::string &s, const std::string &part) { return s.find(part) != std::string::npos; }

static size_t count(const std::string &s, const std::string &part) {
  size_t n = 0;
  for (size_t at = s.find(part); at != std::string::npos; at = s.find(part, at + part.size())) n++;
  return n;
}

static std::string fixture;

static void reset() {
  lastDoc.clear();
  deserializeJson(lastDoc, fixture);
  lastSyncOk = true;
  lastError = "";
  pendingCount = 0;
  hidden.clear();
  overlay.clear();
}

static WebServer render(const char *view, bool rotate = false) {
  WebServer server;
  sendPage(server, view, rotate);
  return server;
}

/* ---- helpers ---- */

static void testHelpers() {
  CHECK(countdownStr(0) == "NOW");
  CHECK(countdownStr(59) == "0m");
  CHECK(countdownStr(5 * 60) == "5m");
  CHECK(countdownStr(2 * 3600 + 37 * 60) == "2h 37m");
  CHECK(countdownStr(3 * 86400 + 4 * 3600 + 59) == "3d 4h");

  CHECK(enc("task-id_1.~") == "task-id_1.~");
  CHECK(enc("a b/c?=&") == "a%20b%2Fc%3F%3D%26");

  CHECK(esc("<b>Tom & \"Jerry's\"</b>") == "&lt;b&gt;Tom &amp; &quot;Jerry&#39;s&quot;&lt;/b&gt;");
  CHECK(esc((const char *)nullptr) == "");
}

/* ---- the Kindle rules from the top of page.h ---- */

static void testKindleRules() {
  for (const char *view : {"focus", "plan", "habits"}) {
    reset();
    WebServer s = render(view, true);
    CHECK(s.code == 200);
    CHECK(s.contentType == "text/html; charset=utf-8");
    CHECK(s.headers["Cache-Control"] == "no-store, no-cache, must-revalidate");
    CHECK(s.headers["Pragma"] == "no-cache");
    CHECK(!contains(s.body, "display:flex"));
    CHECK(!contains(s.body, "display:grid"));
    CHECK(!contains(s.body, "<input"));
    CHECK(count(s.body, "<script") == 1);           // only the rotation fix-up
    CHECK(contains(s.body, "rotate(90deg)"));
  }

  reset();
  WebServer flat = render("focus", false);
  CHECK(!contains(flat.body, "<script"));
  CHECK(contains(flat.body, "href='/?view=plan&rot=0'"));   // navigation keeps ?rot=0

  CHECK(contains(render("focus").body, "content='900'"));    // PAGE_REFRESH_SEC
  CHECK(contains(render("habits").body, "content='1800'"));  // quiet interval while tapping
}

/* ---- views ---- */

static void testFocus() {
  reset();
  lastDoc["nextUp"]["epoch"] = (long)time(nullptr) + 2 * 3600 + 37 * 60 + 30;
  std::string html = render("focus").body;

  CHECK(contains(html, "<td class='on'><a href='/?view=focus"));
  CHECK(contains(html, "<div class='cd'>2h 37m</div>"));
  CHECK(contains(html, "Sprint planning"));
  CHECK(contains(html, "Today &middot; 10:30 &middot; Room 4B &middot; Work"));
  CHECK(contains(html, "General waste today"));
  CHECK(contains(html, "Lisbon 16 days"));
  CHECK(contains(html, "3° Overcast"));

  CHECK(count(html, "class='box'") == 9);
  CHECK(contains(html, "href='/chore?id=w1'"));
  CHECK(contains(html, "href='/done?list=list0&id=t-report'"));
  CHECK(contains(html, "<span class='ti chore'>Sweep + mop kitchen &amp; hallway</span>"));
  CHECK(contains(html, "DUE 19 Nov &middot; Work"));
}

static void testOptimisticOverlay() {
  reset();
  hidden.insert("w1");
  hidden.insert("t-report");
  pendingCount = 2;
  std::string focus = render("focus").body;
  CHECK(count(focus, "class='box'") == 7);
  CHECK(!contains(focus, "Sweep + mop"));
  CHECK(contains(focus, "saving 2"));

  reset();
  overlay["water"] = true;    // tapped on, Google not told yet
  overlay["bed"] = false;     // tapped off
  std::string habits = render("habits").body;
  CHECK(contains(habits, "<a class='box f' href='/toggle?id=water'>&#10003;</a>"));
  CHECK(contains(habits, "<a class='box' href='/toggle?id=bed'>&nbsp;</a>"));
}

static void testPlan() {
  reset();
  std::string html = render("plan").body;
  CHECK(count(html, "<td style='height:390px'>") == 7);
  CHECK(contains(html, "<div class='wkh wkt'>Wed 18</div>"));
  CHECK(contains(html, "<b>10:30</b><br>Sprint planning"));
  CHECK(!contains(html, "Excluded birthday"));
  CHECK(count(html, "<table class='fc'>") == 1);
  CHECK(contains(html, "<b>Thu</b> &middot; Rain<br>5° / 2°"));
}

static void testHabits() {
  reset();
  std::string html = render("habits").body;
  int weeks = lastDoc["graph"]["rows"][0].as<std::string>().size();
  CHECK(weeks == 26);
  CHECK(count(html, "<td class='l") == 7u * weeks);
  CHECK(count(html, "<td class='mo'>") == (size_t)weeks);
  CHECK(contains(html, "<b>1081</b> actions in 178 days"));
  CHECK(contains(html, "longest habit streak 55d"));
  CHECK(count(html, "href='/toggle?id=") == 11);
  CHECK(contains(html, "<span class='ti'>Wash face / skincare</span><br><span class='stk'>55d</span>"));
}

static void testFailuresAndEmptyData() {
  reset();
  lastSyncOk = false;
  lastError = "HTTP -11";
  CHECK(contains(render("focus").body, "SYNC FAILED HTTP -11"));

  lastDoc.clear();
  CHECK(contains(render("focus").body, "Nothing scheduled"));
  CHECK(contains(render("focus").body, "Nothing outstanding. Enjoy it."));
  CHECK(contains(render("plan").body, "No week data."));
  CHECK(contains(render("habits").body, "No habits."));

  reset();
  lastDoc["merged"][0]["title"] = "<script>alert(1)</script>";
  std::string html = render("focus").body;
  CHECK(contains(html, "&lt;script&gt;alert(1)&lt;/script&gt;"));
  CHECK(count(html, "<script") == 0);
}

static void writePreview(const std::string &dir) {
  for (const char *view : {"focus", "plan", "habits"}) {
    reset();
    lastDoc["nextUp"]["epoch"] = (long)time(nullptr) + 49 * 60;
    std::ofstream(dir + "/" + view + ".html") << render(view).body;
  }
  std::cout << "previews written to " << dir << "\n";
}

int main(int argc, char **argv) {
  if (argc < 2) { std::cerr << "usage: page_test <payload.json> [--preview <dir>]\n"; return 2; }
  std::ifstream in(argv[1]);
  std::stringstream text;
  text << in.rdbuf();
  fixture = text.str();
  if (deserializeJson(lastDoc, fixture)) { std::cerr << "cannot parse " << argv[1] << "\n"; return 2; }

  testHelpers();
  testKindleRules();
  testFocus();
  testOptimisticOverlay();
  testPlan();
  testHabits();
  testFailuresAndEmptyData();

  std::cout << (checks - failures) << "/" << checks << " checks passed\n";
  if (argc == 4 && std::string(argv[2]) == "--preview") writePreview(argv[3]);
  return failures ? 1 : 0;
}
