// Runs the whole Home Hub on one computer, with no ESP32, Kindle or Google account:
//   backend  - the real apps_script/Code.gs, with in-memory Calendar/Tasks/Properties and demo data
//   renderer - the real esp32_home_hub/page.h, compiled for the desktop (sim/render.cpp)
//   ESP32    - the request handling of esp32_home_hub.ino: 303 after every tap, a write-behind
//              queue drained once the browser is quiet, a local overlay, periodic sync
//
// Usage: npm run simulate    then open http://localhost:5182
//   PORT=5182  SYNC_SECONDS=60 (the device syncs every 15 min)  ROTATE=1 (rotate like on the Kindle)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadScript, call, TZ } from "../test/apps_script/harness.mjs";
import { demoData, demoHabits } from "./demo-data.mjs";

const PORT = Number(process.env.PORT || 5182);
const SYNC_INTERVAL_MS = Number(process.env.SYNC_SECONDS || 60) * 1000;
const ROTATE_UI = process.env.ROTATE === "1";
const QUIET_MS = 2500;
const MAX_PENDING = 10;
const ARDUINOJSON = "7.2.1";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const log = (...args) => console.log(...args);

/* -------------------- renderer: the real page.h -------------------- */

async function buildRenderer() {
  const deps = path.join(root, "test/host/.deps");
  const header = path.join(deps, "ArduinoJson.h");
  if (!fs.existsSync(header)) {
    fs.mkdirSync(deps, { recursive: true });
    const url = `https://github.com/bblanchon/ArduinoJson/releases/download/v${ARDUINOJSON}/ArduinoJson-v${ARDUINOJSON}.h`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`cannot download ArduinoJson: HTTP ${res.status}`);
    fs.writeFileSync(header, Buffer.from(await res.arrayBuffer()));
  }

  const exe = path.join(root, "sim/build", process.platform === "win32" ? "render.exe" : "render");
  const sources = ["sim/render.cpp", "esp32_home_hub/page.h", "esp32_home_hub/config.example.h", "test/host/shims/Arduino.h"]
    .map(f => path.join(root, f));
  const stale = !fs.existsSync(exe) || sources.some(f => fs.statSync(f).mtimeMs > fs.statSync(exe).mtimeMs);
  if (stale) {
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    log("[build] compiling page.h for the desktop...");
    const cc = spawnSync(process.env.CXX || "g++", [
      "-std=c++17", "-O1", "-Wall", "-Wextra",
      "-I", path.join(root, "test/host/shims"), "-I", path.join(root, "test/host"),
      "-I", deps, "-I", path.join(root, "esp32_home_hub"),
      path.join(root, "sim/render.cpp"), "-o", exe
    ], { stdio: "inherit" });
    if (cc.status !== 0) throw new Error("renderer build failed");
  }
  return exe;
}

const renderer = await buildRenderer();

/* --------------- backend: the real Code.gs, demo data -------------- */

const { gs, props } = loadScript(demoData(new Date()));
props.setProperty("habits", JSON.stringify(demoHabits(gs)));
gs.createToken();
const token = props.getProperty("HUB_TOKEN");
const gas = params => call(gs, { token, ...params });

/* ------------------ ESP32 state (esp32_home_hub.ino) ---------------- */

let lastDoc = {};
let lastSyncOk = false;
let lastSyncClock = "--:--";
let lastError = "";
let lastClientMs = 0;
let nextSync = 0;
const pending = [];          // write-behind queue of Apps Script actions
const hidden = new Set();    // rows ticked but not yet confirmed by a sync
const overlay = new Map();   // habit id -> done, shown before Google has it

const fmt = options => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...options });
const getClock = () => fmt({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
const getDate = () => {
  const p = Object.fromEntries(fmt({ weekday: "long", day: "2-digit", month: "long" }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.weekday}, ${p.day} ${p.month}`;   // strftime "%A, %d %B"
};

function syncHub() {
  const t0 = Date.now();
  const res = gas({});
  if (!res.ok) {
    lastSyncOk = false;
    lastError = res.error || "rejected";
    log(`[GAS] rejected: ${lastError}`);
    return false;
  }
  lastDoc = res;
  lastSyncOk = true;
  lastSyncClock = getClock();
  lastError = "";
  log(`[GAS] ok - ${res.merged.length} rows, ${res.habits.length} habits, ${res.week.length} days (${Date.now() - t0} ms)`);
  return true;
}

const scheduleNextSync = () => { nextSync = Date.now() + SYNC_INTERVAL_MS; };
const clearOverlays = () => { hidden.clear(); overlay.clear(); };

function queueAction(params) {
  if (pending.length >= MAX_PENDING) { log("[queue] full, dropping oldest"); pending.shift(); }
  pending.push(params);
}

// Only once the browser has been quiet: the 303 is followed straight away by a GET for the page
function drainQueue() {
  if (!pending.length || Date.now() - lastClientMs < QUIET_MS) return;
  const action = pending.shift();
  log(`[queue] sending ${action.action} ${action.id} (${pending.length} left)`);
  const res = gas(action);
  if (!res.ok) log(`[GAS] action failed: ${res.error}`);
  if (!pending.length) {
    if (syncHub()) clearOverlays();
    scheduleNextSync();
  }
}

function periodicSync() {
  if (pending.length || Date.now() < nextSync) return;   // never sync while writes are queued
  if (syncHub()) clearOverlays();
  scheduleNextSync();
}

/* ----------------------------- handlers ---------------------------- */

function sendPage(res, view, rotate) {
  const input = JSON.stringify({
    payload: lastDoc, view, rotate, hidden: [...hidden], overlay: Object.fromEntries(overlay),
    pending: pending.length, syncOk: lastSyncOk, syncClock: lastSyncClock, error: lastError,
    clock: getClock(), date: getDate()
  });
  const out = spawnSync(renderer, { input, maxBuffer: 4 * 1024 * 1024 });
  if (out.status !== 0) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`renderer failed: ${out.stderr}`);
    return;
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate",
    pragma: "no-cache",
    expires: "0"
  });
  res.end(out.stdout);
}

function redirectTo(res, view, rotate) {
  res.writeHead(303, { location: `/?view=${view}${rotate ? "" : "&rot=0"}`, "cache-control": "no-store" });
  res.end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const arg = name => url.searchParams.get(name) ?? "";
  const rotate = ROTATE_UI && arg("rot") !== "0";
  const view = ["plan", "habits"].includes(arg("view")) ? arg("view") : "focus";
  lastClientMs = Date.now();

  switch (url.pathname) {
    case "/":
      return sendPage(res, view, rotate);

    case "/done":       // complete a Google Task: hide it now, tell Google in a moment
      if (arg("id") && arg("list")) {
        hidden.add(arg("id"));
        queueAction({ action: "completeTask", list: arg("list"), id: arg("id") });
      }
      return redirectTo(res, "focus", rotate);

    case "/chore":
      if (arg("id")) {
        hidden.add(arg("id"));
        queueAction({ action: "completeChore", id: arg("id") });
      }
      return redirectTo(res, "focus", rotate);

    case "/toggle": {   // the box flips instantly; streak and graph catch up on the next sync
      const id = arg("id");
      if (id) {
        const done = overlay.has(id) ? overlay.get(id) : (lastDoc.habits ?? []).find(h => h.id === id)?.done ?? false;
        overlay.set(id, !done);
        queueAction({ action: "toggleHabit", id });
      }
      return redirectTo(res, "habits", rotate);
    }

    case "/refresh":    // explicit request: worth the wait
      syncHub();
      scheduleNextSync();
      if (!pending.length && lastSyncOk) clearOverlays();
      return redirectTo(res, view, rotate);

    default:
      return redirectTo(res, "focus", rotate);
  }
});

syncHub();
scheduleNextSync();
setInterval(() => { drainQueue(); periodicSync(); }, 250);

server.listen(PORT, "127.0.0.1", () => {
  log(`[HTTP] Home Hub simulator on http://localhost:${PORT}`);
  log(`       real Code.gs + real page.h, demo Google data, sync every ${SYNC_INTERVAL_MS / 1000} s, rotation ${ROTATE_UI ? "on" : "off"}`);
});
