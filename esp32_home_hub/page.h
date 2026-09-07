#pragma once
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include <time.h>
#include "config.h"

/* =====================================================================
   THE HOME HUB - every byte of HTML/CSS the Kindle receives.

   Professional Minimalist: Georgia for headings and the countdown,
   Helvetica for data.

   Kindle rules obeyed here (constraints, not preferences):
     * <table> for all layout. Flexbox and Grid destabilise the
       Experimental Browser - never introduce them.
     * No grey TEXT and no grey hairlines - e-ink dithers them into
       mush. Solid grey FILLS are fine: the panel has 16 levels, which
       is what makes the contribution graph legible.
     * No frontend JavaScript. Views and actions are URL parameters.
       The single exception is one guarded line that measures the
       viewport for the rotation transform; it has a no-JS fallback.
     * 40x40px tap targets - the touch layer is imprecise.
     * <meta refresh> is the only auto-update, deliberately slow.
   ===================================================================== */

extern JsonDocument lastDoc;
extern bool     lastSyncOk;
extern String   lastSyncClock;
extern String   lastError;
extern int      pendingCount;

String getClock();
String getDate();

/* Optimistic overlay: a tap updates the screen immediately and the
   write to Google happens a couple of seconds later, in the background.
   These let the renderer show the tapped state before Google confirms. */
bool isHidden(const char *id);
int  habitOverlay(const char *id);     // -1 none, 0 forced off, 1 forced on

/* ---------------------------- utils ------------------------------- */

static String esc(const char *s) {
  String o;
  if (!s) return o;
  for (const char *p = s; *p; p++) {
    switch (*p) {
      case '&': o += F("&amp;");  break;
      case '<': o += F("&lt;");   break;
      case '>': o += F("&gt;");   break;
      case '"': o += F("&quot;"); break;
      case '\'': o += F("&#39;"); break;
      default:  o += *p;
    }
  }
  return o;
}

static String esc(JsonVariantConst v) { return esc(v.as<const char *>()); }

static bool has(JsonVariantConst v) {
  const char *s = v.as<const char *>();
  return s && *s;
}

static const char *cstr(JsonVariantConst v) {
  const char *s = v.as<const char *>();
  return s ? s : "";
}

/** URL-encodes ids so Google task ids survive the query string. */
static String enc(const String &s) {
  static const char *hexd = "0123456789ABCDEF";
  String o;
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (isalnum((unsigned char)c) || c=='-' || c=='_' || c=='.' || c=='~') o += c;
    else { o += '%'; o += hexd[(c >> 4) & 15]; o += hexd[c & 15]; }
  }
  return o;
}

/* Countdown is computed HERE, not in Apps Script, so it is right on
   every page load rather than only at the moment of the 15-min sync. */
static String countdownStr(long secs) {
  if (secs <= 0)  return F("NOW");
  long m = secs / 60;
  if (m < 60)     return String(m) + "m";
  long h = m / 60; m %= 60;
  if (h < 24)     return String(h) + "h " + String(m) + "m";
  long d = h / 24; h %= 24;
  return String(d) + "d " + String(h) + "h";
}

/* ----------------------------- CSS -------------------------------- */

static void appendHead(String &h, const String &view, bool rotate) {
  // Tap-heavy views get the slow interval: a refresh landing mid-tap
  // loses the tap and flashes the screen for nothing.
  bool quiet = (view == "habits");
  h += F("<!DOCTYPE html><html><head><meta charset='UTF-8'>"
         "<meta name='viewport' content='width=device-width,initial-scale=1'>"
         "<meta http-equiv='refresh' content='");
  h += String(quiet ? PAGE_REFRESH_SEC_QUIET : PAGE_REFRESH_SEC);
  h += F("'><title>Home Hub</title><style>"
    "*{box-sizing:border-box;}"
    "html,body{margin:0;padding:0;background:#fff;color:#000;"
      "font-family:Helvetica,Arial,sans-serif;}");

  if (rotate) {
    // Rotate 90deg clockwise about the top-left, then push right by one
    // screen width so the box lands back on screen. The wrapper's own
    // width/height are the screen's dimensions swapped.
    h += F("body{overflow:hidden;}#rot{position:absolute;top:0;left:0;");
    h += "width:"  + String(SCREEN_H) + "px;";
    h += "height:" + String(SCREEN_W) + "px;";
    h += F("-webkit-transform-origin:0 0;transform-origin:0 0;");
    h += "-webkit-transform:translateX(" + String(SCREEN_W) + "px) rotate(90deg);";
    h += "transform:translateX("         + String(SCREEN_W) + "px) rotate(90deg);";
    h += F("}");
  } else {
    h += F("#rot{width:100%;}");
  }

  h += F(
    ".sf,h1,h2,.cd,.clock{font-family:Georgia,'Times New Roman',serif;}"

    ".nav{width:100%;background:#000;border-collapse:collapse;}"
    ".nav td{text-align:center;padding:12px 0;}"
    ".nav a{color:#fff;text-decoration:none;font-weight:bold;font-size:16px;"
      "letter-spacing:3px;display:block;}"
    ".on{background:#fff;}.on a{color:#000;}"

    ".pad{padding:8px 14px;}"

    ".hdr{width:100%;border-collapse:collapse;}"
    ".clock{font-size:38px;font-weight:bold;line-height:1;}"
    ".date{font-size:16px;}"
    ".meta{font-size:11px;text-align:right;letter-spacing:1px;line-height:1.5;}"

    ".nu{width:100%;border:4px solid #000;border-collapse:collapse;margin:6px 0;}"
    ".nu td{padding:8px 12px;vertical-align:middle;}"
    ".cd{font-size:64px;font-weight:bold;line-height:1;white-space:nowrap;}"
    ".nut{font-size:22px;font-weight:bold;}"
    ".nus{font-size:13px;letter-spacing:1px;}"
    ".lbl{font-size:11px;letter-spacing:3px;}"

    ".alert{background:#000;color:#fff;padding:5px 8px;margin-bottom:6px;"
      "font-size:12px;font-weight:bold;letter-spacing:1px;}"

    "h2{font-size:13px;margin:0 0 4px 0;padding:3px 0;letter-spacing:3px;"
      "border-bottom:3px solid #000;text-transform:uppercase;}"
    ".lst{width:100%;border-collapse:collapse;}"
    ".lst td{border-bottom:1px solid #000;padding:4px 6px;vertical-align:middle;}"
    ".ti{font-size:17px;}"
    ".sub{font-size:11px;letter-spacing:1px;}"
    ".chore{font-weight:bold;}"
    ".none{padding:14px 0;font-size:14px;}"

    "a.box{display:block;width:40px;height:40px;line-height:34px;"
      "text-align:center;border:3px solid #000;color:#000;"
      "text-decoration:none;font-size:20px;font-weight:bold;}"
    "a.box.f{background:#000;color:#fff;}"

    /* contribution graph - solid fills, which e-ink renders cleanly */
    ".cg{border-collapse:collapse;}"
    ".cg td{width:12px;height:12px;padding:0;border:1px solid #fff;}"
    /* empty days get a black outline, not a grey one - a grey hairline
       dithers on e-ink, while a solid grey FILL does not */
    ".l0{background:#fff;border:1px solid #000;}"
    ".l1{background:#d9d9d9;}"
    ".l2{background:#a6a6a6;}"
    ".l3{background:#6b6b6b;}"
    ".l4{background:#000;}"
    ".lx{background:#fff;}"
    ".mo{font-size:9px;letter-spacing:0;height:12px;padding:0;"
      "text-align:left;border:0;}"
    ".stats{font-size:11px;line-height:1.7;letter-spacing:1px;}"
    ".stats b{font-size:13px;}"
    ".key{font-size:10px;letter-spacing:1px;}"

    ".hm{border-collapse:collapse;}"
    ".hm td{width:14px;height:14px;border:1px solid #000;padding:0;}"
    ".hm td.f{background:#000;}"
    ".stk{font-size:12px;font-weight:bold;letter-spacing:1px;}"

    ".wk{width:100%;border-collapse:collapse;font-size:11px;}"
    ".wk td{border:1px solid #000;vertical-align:top;padding:0;width:14.2%;}"
    ".wkh{text-align:center;font-weight:bold;padding:4px 0;font-size:12px;}"
    ".wkt{background:#000;color:#fff;}"
    ".wke{padding:4px;border-top:1px solid #000;}"

    ".fc{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px;}"
    ".fc td{border:2px solid #000;padding:6px;text-align:center;width:33%;}"
    "</style></head><body><div id='rot'>");
}

/* ----------------------------- nav -------------------------------- */

static void appendNav(String &h, const String &view, bool rotate) {
  String q = rotate ? "" : "&rot=0";
  const char *ids[3]    = { "focus", "plan", "habits" };
  const char *labels[3] = { "FOCUS", "PLAN", "HABITS" };

  h += F("<table class='nav'><tr>");
  for (int i = 0; i < 3; i++) {
    h += (view == ids[i]) ? F("<td class='on'>") : F("<td>");
    h += "<a href='/?view=" + String(ids[i]) + q + "'>" + labels[i] + "</a></td>";
  }
  h += "<td style='width:60px'><a href='/refresh?view=" + view + q + "'>&#8635;</a></td>";
  h += F("</tr></table>");
}

/* ---------------------------- header ------------------------------ */

static void appendHeader(String &h) {
  JsonVariantConst wx = lastDoc["weather"].as<JsonVariantConst>();

  h += F("<table class='hdr'><tr><td><span class='clock'>");
  h += getClock();
  h += F("</span> &nbsp;<span class='date sf'>");
  h += getDate();
  h += F("</span></td><td class='meta'>");

  if (!wx.isNull()) {
    h += esc(wx["now"]) + " " + esc(wx["desc"]) + " &middot; ";
    h += esc(wx["hi"]) + "/" + esc(wx["lo"]);
    h += F("<br>");
    h += esc(wx["sunrise"]) + " - " + esc(wx["sunset"]) + " &middot; ";
  } else {
    h += F("<br>");
  }

  if (lastSyncOk) { h += F("sync "); h += lastSyncClock; }
  else            { h += F("SYNC FAILED "); h += esc(lastError.c_str()); }

  // Honest about the write-behind: a tap is on screen before Google has it.
  if (pendingCount > 0) { h += F(" &middot; saving "); h += String(pendingCount); }

  h += F("</td></tr></table>");
}

/* --------------------------- alerts ------------------------------- */

static void appendAlerts(String &h) {
  String parts;
  const char *sep = " &nbsp;&#9670;&nbsp; ";

  for (JsonObjectConst b : lastDoc["bins"].as<JsonArrayConst>()) {
    if (parts.length()) parts += sep;
    parts += esc(b["label"]) + " " + esc(b["when"]);
  }
  for (JsonObjectConst c : lastDoc["countdowns"].as<JsonArrayConst>()) {
    if (parts.length()) parts += sep;
    parts += esc(c["title"]) + " " + esc(c["label"]);
  }

  if (!parts.length()) return;
  h += F("<div class='alert'>");
  h += parts;
  h += F("</div>");
}

/* -------------------------- FOCUS view ---------------------------- */

static void appendNextUp(String &h) {
  JsonVariantConst nu = lastDoc["nextUp"].as<JsonVariantConst>();

  h += F("<table class='nu'><tr><td style='width:36%'>"
         "<div class='lbl'>NEXT UP</div><div class='cd'>");

  if (nu.isNull()) {
    h += F("&mdash;</div></td><td><div class='nut'>Nothing scheduled</div></td>");
  } else {
    long epoch = nu["epoch"] | 0L;
    time_t now = time(nullptr);
    // Before NTP lands, time() is near zero - show "--" rather than a
    // nonsense multi-decade countdown.
    bool clockReady = (now > 1600000000L);

    h += clockReady ? countdownStr((long)(epoch - now)) : String(F("--"));
    h += F("</div></td><td><div class='nut'>");
    h += esc(nu["title"]);
    h += F("</div><div class='nus'>");
    h += esc(nu["day"]) + " &middot; " + esc(nu["time"]);
    if (has(nu["loc"])) { h += F(" &middot; "); h += esc(nu["loc"]); }
    if (has(nu["cal"])) { h += F(" &middot; "); h += esc(nu["cal"]); }
    h += F("</div></td>");
  }
  h += F("</tr></table>");
}

static void appendMerged(String &h) {
  JsonArrayConst rows = lastDoc["merged"].as<JsonArrayConst>();

  h += F("<h2>Today</h2><table class='lst'>");
  int shown = 0;

  for (JsonObjectConst r : rows) {
    const char *id = cstr(r["id"]);
    if (isHidden(id)) continue;            // ticked this session: gone now
    shown++;

    bool isChore = strcmp(cstr(r["kind"]), "chore") == 0;

    // Chores and tasks hit different Google endpoints.
    String href = isChore
      ? "/chore?id=" + enc(String(id))
      : "/done?list=" + enc(String(cstr(r["list"]))) + "&id=" + enc(String(id));

    h += F("<tr><td style='width:46px'><a class='box' href='");
    h += href;
    h += F("'>&#10003;</a></td><td>");

    h += isChore ? F("<span class='ti chore'>") : F("<span class='ti'>");
    h += esc(r["title"]);
    h += F("</span>");

    if (has(r["due"]) || has(r["src"])) {
      h += F("<div class='sub'>");
      if (has(r["due"])) { h += F("DUE "); h += esc(r["due"]); }
      if (has(r["due"]) && has(r["src"])) h += F(" &middot; ");
      if (has(r["src"])) h += esc(r["src"]);
      h += F("</div>");
    }
    h += F("</td></tr>");
  }
  h += F("</table>");

  if (shown == 0) h += F("<div class='none'>Nothing outstanding. Enjoy it.</div>");
}

static void appendFocusView(String &h) {
  appendNextUp(h);
  appendAlerts(h);
  appendMerged(h);
}

/* --------------------------- PLAN view ---------------------------- */

static void appendPlanView(String &h) {
  JsonArrayConst wk = lastDoc["week"].as<JsonArrayConst>();

  if (wk.size() == 0) {
    h += F("<div class='none'>No week data. Re-deploy the Apps Script "
           "(Deploy &gt; Manage deployments &gt; New version).</div>");
    return;
  }

  h += F("<table class='wk'><tr>");
  for (JsonObjectConst d : wk) {
    h += F("<td style='height:390px'>");

    h += (d["today"] | false) ? F("<div class='wkh wkt'>") : F("<div class='wkh'>");
    h += esc(d["day"]);
    h += F(" ");
    h += esc(d["num"]);
    h += F("</div>");

    JsonArrayConst evs = d["events"].as<JsonArrayConst>();
    if (evs.size() == 0) {
      h += F("<div class='wke' style='text-align:center'>&middot;</div>");
    } else {
      for (JsonObjectConst e : evs) {
        h += F("<div class='wke'>");
        if (has(e["t"])) { h += F("<b>"); h += esc(e["t"]); h += F("</b><br>"); }
        h += esc(e["n"]);
        h += F("</div>");
      }
    }
    h += F("</td>");
  }
  h += F("</tr></table>");

  JsonArrayConst fc = lastDoc["weather"]["days"].as<JsonArrayConst>();
  if (fc.size()) {
    h += F("<table class='fc'><tr>");
    for (JsonObjectConst d : fc) {
      h += F("<td><b>");
      h += esc(d["day"]);
      h += F("</b> &middot; ");
      h += esc(d["desc"]);
      h += F("<br>");
      h += esc(d["hi"]) + " / " + esc(d["lo"]);
      h += F("</td>");
    }
    h += F("</tr></table>");
  }
}

/* ---------------------- contribution graph ------------------------ */
/*
 * 7 rows (Mon..Sun) x 26 week columns. Apps Script sends each row as a
 * string of level digits '0'-'4', or '-' for a day in the future, so
 * rendering is a straight character-to-class mapping with no arithmetic.
 */

static void appendGraph(String &h) {
  JsonObjectConst g = lastDoc["graph"].as<JsonObjectConst>();
  JsonArrayConst rows = g["rows"].as<JsonArrayConst>();
  if (rows.size() == 0) return;

  h += F("<table style='width:100%;border-collapse:collapse'>"
         "<tr><td style='vertical-align:top'><table class='cg'>");

  /* month labels above the columns */
  JsonArrayConst months = g["months"].as<JsonArrayConst>();
  if (months.size()) {
    h += F("<tr>");
    for (JsonVariantConst m : months) {
      h += F("<td class='mo'>");
      h += esc(m);
      h += F("</td>");
    }
    h += F("</tr>");
  }

  for (JsonVariantConst rv : rows) {
    const char *line = cstr(rv);
    h += F("<tr>");
    for (const char *p = line; *p; p++) {
      switch (*p) {
        case '-': h += F("<td class='lx'></td>"); break;
        case '0': h += F("<td class='l0'></td>"); break;
        case '1': h += F("<td class='l1'></td>"); break;
        case '2': h += F("<td class='l2'></td>"); break;
        case '3': h += F("<td class='l3'></td>"); break;
        default:  h += F("<td class='l4'></td>"); break;
      }
    }
    h += F("</tr>");
  }
  h += F("</table>"
         "<div class='key'>LESS "
         "<span style='display:inline-block;width:11px;height:11px;"
           "background:#fff;border:1px solid #000'></span> "
         "<span style='display:inline-block;width:11px;height:11px;background:#d9d9d9'></span> "
         "<span style='display:inline-block;width:11px;height:11px;background:#a6a6a6'></span> "
         "<span style='display:inline-block;width:11px;height:11px;background:#6b6b6b'></span> "
         "<span style='display:inline-block;width:11px;height:11px;background:#000'></span>"
         " MORE</div></td>");

  /* --- small print --- */
  JsonObjectConst s = g["stats"].as<JsonObjectConst>();
  h += F("<td class='stats' style='padding-left:16px;vertical-align:top'>");

  h += F("<b>");
  h += String(s["total"] | 0);
  h += F("</b> actions in ");
  h += String(s["elapsed"] | 0);
  h += F(" days<br>");

  h += F("<b>");
  h += String(s["dayStreak"] | 0);
  h += F("</b> day streak &middot; <b>");
  h += String(s["today"] | 0);
  h += F("</b> today<br>");

  h += F("active ");
  h += String(s["activeDays"] | 0);
  h += F(" days (");
  h += String(s["pct"] | 0);
  h += F("%) &middot; avg ");
  h += esc(s["avg"]);
  h += F("/day<br>");

  h += F("best ");
  h += String(s["best"] | 0);
  if (has(s["bestDay"])) { h += F(" on "); h += esc(s["bestDay"]); }
  h += F("<br>longest habit streak ");
  h += String(s["bestHabit"] | 0);
  h += F("d");

  h += F("</td></tr></table>");
}

/* -------------------------- HABITS view --------------------------- */

/* "1011010" -> seven cells, oldest on the left, today on the right. */
static void appendMini(String &h, const char *bits) {
  size_t n = bits ? strlen(bits) : 0;   // never index past a short string
  h += F("<table class='hm'><tr>");
  for (size_t i = 0; i < 7; i++) {
    bool on = (i < n) && bits[i] == '1';
    h += on ? F("<td class='f'></td>") : F("<td></td>");
  }
  h += F("</tr></table>");
}

static void appendHabitsView(String &h) {
  appendGraph(h);

  JsonArrayConst habits = lastDoc["habits"].as<JsonArrayConst>();
  if (habits.size() == 0) {
    h += F("<div class='none'>No habits. Add them to CFG.HABITS in Code.gs, "
           "then re-deploy the Apps Script.</div>");
    return;
  }

  h += F("<div style='height:6px'></div>");

  // Two columns so eleven rows fit without scrolling.
  int total = habits.size();
  int half = (total + 1) / 2;

  h += F("<table style='width:100%;border-collapse:collapse'><tr>");
  for (int col = 0; col < 2; col++) {
    h += F("<td style='width:50%;vertical-align:top;padding:0 8px'>"
           "<table class='lst'>");

    int i = 0;
    for (JsonObjectConst hb : habits) {
      bool inCol = (col == 0) ? (i < half) : (i >= half);
      i++;
      if (!inCol) continue;

      const char *id = cstr(hb["id"]);
      bool done = hb["done"] | false;
      int ov = habitOverlay(id);
      if (ov >= 0) done = (ov == 1);        // show the tap before Google has it

      h += F("<tr><td style='width:46px'><a class='box");
      h += done ? F(" f'") : F("'");
      h += " href='/toggle?id=" + enc(String(id)) + "'>";
      h += done ? F("&#10003;") : F("&nbsp;");
      h += F("</a></td><td><span class='ti'>");
      h += esc(hb["label"]);
      h += F("</span><br><span class='stk'>");
      h += String(hb["streak"] | 0);
      h += F("d</span></td><td style='width:110px;text-align:right'>");

      appendMini(h, cstr(hb["grid"]));
      h += F("</td></tr>");
    }
    h += F("</table></td>");
  }
  h += F("</tr></table>");
}

/* --------------------------- assemble ----------------------------- */

static void sendPage(WebServer &server, const String &view, bool rotate) {
  String h;
  h.reserve(20000);

  appendHead(h, view, rotate);
  appendNav(h, view, rotate);
  h += F("<div class='pad'>");
  appendHeader(h);

  if      (view == "plan")   appendPlanView(h);
  else if (view == "habits") appendHabitsView(h);
  else                       appendFocusView(h);

  h += F("</div></div>");

  if (rotate) {
    // Corrects the hard-coded screen size to the real viewport. Runs
    // once, never on a timer. If JS is off the SCREEN_W/H fallback stands.
    h += F("<script>(function(){try{"
           "var d=document.documentElement,"
           "w=d.clientWidth||window.innerWidth,"
           "h=d.clientHeight||window.innerHeight,"
           "r=document.getElementById('rot');"
           "if(!w||!h||!r)return;"
           "r.style.width=h+'px';r.style.height=w+'px';"
           "var t='translateX('+w+'px) rotate(90deg)';"
           "r.style.webkitTransform=t;r.style.transform=t;"
           "}catch(e){}})();</script>");
  }

  h += F("</body></html>");

  // The Kindle browser caches hard; without this you get a stale page.
  server.sendHeader(F("Cache-Control"), F("no-store, no-cache, must-revalidate"));
  server.sendHeader(F("Pragma"), F("no-cache"));
  server.sendHeader(F("Expires"), F("0"));
  server.send(200, "text/html; charset=utf-8", h);
}
