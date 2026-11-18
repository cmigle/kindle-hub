// Builds test/host/fixtures/payload.json with the real Code.gs, so the firmware
// renderer is tested against exactly what the backend produces.
// Usage: node test/apps_script/make-fixture.mjs
import fs from "node:fs";
import { loadScript, event, plain, TZ } from "./harness.mjs";

const now = new Date("2026-11-18T09:41"); // a Wednesday: chores and the bin warning show

// Deterministic pseudo-random history (mulberry32)
let seed = 7;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const calendars = {
  Work: [
    event("Sprint planning", "2026-11-18T10:30", { location: "Room 4B" }),
    event("1:1 with Sam", "2026-11-18T15:00"),
    event("Design review", "2026-11-19T11:00"),
    event("Team lunch", "2026-11-20T12:30", { location: "Bistro 18" }),
    event("Release", "2026-11-23T09:00")
  ],
  Personal: [
    event("Gym", "2026-11-18T18:30"),
    event("Dentist", "2026-11-19T08:15"),
    event("Cinema", "2026-11-21T19:45"),
    event("Market", "2026-11-22T10:00"),
    event("Call grandma", "2026-11-24T17:00")
  ],
  Countdowns: [event("Lisbon", "2026-12-04T00:00", { allDay: true })],
  Birthdays: [event("Excluded birthday", "2026-11-19T00:00", { allDay: true })]
};

const tasks = {
  Work: [
    { id: "t-report", title: "Send quarterly report", due: "2026-11-19T00:00:00.000Z" },
    { id: "t-review", title: "Review pull request #42", due: "2026-11-21T00:00:00.000Z" },
    { id: "t-slides", title: "Draft workshop slides" }
  ],
  Home: [
    { id: "t-insurance", title: "Renew car insurance", due: "2026-11-25T00:00:00.000Z" },
    { id: "t-plants", title: "Repot the plants" }
  ]
};

const weather = {
  current: { temperature_2m: 2.6, weather_code: 3 },
  daily: {
    time: ["2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21"],
    weather_code: [3, 61, 71, 1],
    temperature_2m_max: [4.1, 5.3, 1.2, 0.4],
    temperature_2m_min: [-0.8, 1.9, -2.6, -4.2],
    sunrise: ["2026-11-18T07:54", "2026-11-19T07:56", "2026-11-20T07:58", "2026-11-21T08:00"],
    sunset: ["2026-11-18T16:07", "2026-11-19T16:06", "2026-11-20T16:05", "2026-11-21T16:03"]
  }
};

const { gs, props } = loadScript({ now, calendars, tasks, weather });

// Two months of habit ticks (index 0 = today) and half a year of daily totals
const day = gs.logicalDay_(TZ);
const hist = {}, score = {};
for (const h of gs.CFG.HABITS) {
  const rate = 0.45 + random() * 0.45;
  hist[h.id] = Array.from({ length: gs.CFG.HIST_DAYS }, (_, i) => (i === 0 ? random() < 0.5 : random() < rate) ? "1" : "0").join("");
}
for (let i = 0; i < gs.CFG.SCORE_DAYS; i++) {
  const ticks = i < gs.CFG.HIST_DAYS ? Object.values(hist).filter(s => s[i] === "1").length : Math.floor(random() * 9);
  const total = ticks + Math.floor(random() * 3);
  if (total > 0 && random() > 0.08) score[gs.shiftDay_(day, -i, TZ)] = total;
}
props.setProperty("habits", JSON.stringify({ day, hist, score }));

const payload = plain(gs.buildPayload_());
delete payload.ms; // build time varies between runs

const out = new URL("../host/fixtures/payload.json", import.meta.url);
fs.writeFileSync(out, JSON.stringify(payload, null, 2) + "\n");
console.log(`wrote ${out.pathname}: ${payload.merged.length} rows, ${payload.habits.length} habits, ${payload.week.length} days`);
