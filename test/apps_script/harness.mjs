// Loads apps_script/Code.gs into a fresh V8 context with in-memory stand-ins for
// the Google services it touches, so the backend logic can be tested with plain Node.
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";

export const TZ = "Europe/Vilnius";
process.env.TZ = TZ; // Apps Script evaluates new Date(y, m, d) in the script time zone

const source = fs.readFileSync(new URL("../../apps_script/Code.gs", import.meta.url), "utf8");

const NAMES = {
  EEEE: { weekday: "long" }, EEE: { weekday: "short" },
  MMMM: { month: "long" }, MMM: { month: "short" }
};

// Subset of java.text.SimpleDateFormat used by Code.gs
export function formatDate(date, tz, pattern) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date).map(p => [p.type, p.value]));
  const name = opts => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).format(date);
  return pattern.replace(/yyyy|MMMM|MMM|MM|dd|d|HH|mm|EEEE|EEE/g, t => ({
    yyyy: parts.year, MM: parts.month, dd: parts.day, d: String(+parts.day),
    HH: parts.hour, mm: parts.minute
  })[t] ?? name(NAMES[t]));
}

function store() {
  const m = new Map();
  return {
    map: m,
    getProperty: k => (m.has(k) ? m.get(k) : null),
    setProperty: (k, v) => { m.set(k, String(v)); },
    deleteProperty: k => { m.delete(k); },
    get: k => (m.has(k) ? m.get(k) : null),
    put: (k, v) => { m.set(k, String(v)); },
    remove: k => { m.delete(k); }
  };
}

// A calendar event as CalendarApp returns it
export function event(title, start, { allDay = false, location = "" } = {}) {
  return {
    getTitle: () => title,
    getStartTime: () => new Date(start),
    isAllDayEvent: () => allDay,
    getLocation: () => location
  };
}

/**
 * @param {object} opts
 * @param {Date}   [opts.now]        frozen "current" time inside the script
 * @param {object} [opts.calendars]  { name: [event, ...] }
 * @param {object} [opts.tasks]      { listTitle: [{ id, title, due? }] }
 */
export function loadScript({ now, calendars = {}, tasks = {} } = {}) {
  const props = store();
  const cache = store();
  const logs = [];
  const patched = [];

  const RealDate = Date;
  const FrozenDate = now === undefined ? RealDate : class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
    static now() { return now.getTime(); }
  };

  const calendarObjects = Object.entries(calendars).map(([name, events]) => ({
    getName: () => name,
    getEvents: (start, end) => events.filter(e => {
      const t = e.getStartTime().getTime();
      return t >= start.getTime() && t < end.getTime();
    })
  }));

  const taskLists = Object.entries(tasks).map(([title], i) => ({ id: `list${i}`, title }));

  const context = {
    Date: FrozenDate,
    Math, JSON, String, Object, Array, Number,
    Utilities: { formatDate, getUuid: () => crypto.randomUUID() },
    Session: { getScriptTimeZone: () => TZ },
    PropertiesService: { getScriptProperties: () => props },
    CacheService: { getScriptCache: () => cache },
    Logger: { log: s => logs.push(String(s)) },
    ContentService: {
      MimeType: { JSON: "json" },
      createTextOutput: text => ({ text, setMimeType() { return this; } })
    },
    CalendarApp: {
      getAllCalendars: () => calendarObjects,
      getCalendarsByName: n => calendarObjects.filter(c => c.getName() === n)
    },
    Tasks: {
      Tasklists: { list: () => ({ items: taskLists }) },
      Tasks: {
        list: listId => {
          const list = taskLists.find(l => l.id === listId);
          return { items: tasks[list.title].map(t => ({ status: "needsAction", ...t })) };
        },
        patch: (body, listId, taskId) => patched.push({ body, listId, taskId })
      }
    },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 503, getContentText: () => "" }) }
  };

  vm.createContext(context);
  vm.runInContext(source, context, { filename: "Code.gs" });
  return { gs: context, props, cache, logs, patched };
}

/** Objects created inside the script context have its prototypes; compare plain copies. */
export const plain = value => JSON.parse(JSON.stringify(value));

/** Calls the web app like the ESP32 does and returns the parsed JSON body. */
export function call(gs, parameter) {
  return JSON.parse(gs.doGet({ parameter }).text);
}
