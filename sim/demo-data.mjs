// Demo Google data for the simulator, laid out relative to the moment it starts
// so the countdown, the week grid and the forecast always look current.
import { event, TZ } from "../test/apps_script/harness.mjs";

const at = (now, days, hours, minutes) => {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(hours, minutes, 0, 0);
  return d;
};
const iso = d => d.toISOString().slice(0, 10);
const due = (now, days) => `${iso(at(now, days, 12, 0))}T00:00:00.000Z`;

export function demoData(now) {
  const soon = new Date(now.getTime() + 49 * 60 * 1000); // Next Up is always 49 minutes away
  const calendars = {
    Work: [
      event("Sprint planning", soon, { location: "Room 4B" }),
      event("1:1 with Sam", at(now, 0, 15, 0)),
      event("Design review", at(now, 1, 11, 0)),
      event("Team lunch", at(now, 2, 12, 30), { location: "Bistro 18" }),
      event("Release", at(now, 5, 9, 0))
    ],
    Personal: [
      event("Gym", at(now, 0, 18, 30)),
      event("Dentist", at(now, 1, 8, 15)),
      event("Cinema", at(now, 3, 19, 45)),
      event("Market", at(now, 4, 10, 0)),
      event("Call grandma", at(now, 6, 17, 0))
    ],
    Countdowns: [event("Lisbon", at(now, 16, 0, 0), { allDay: true })]
  };

  const tasks = {
    Work: [
      { id: "t-report", title: "Send quarterly report", due: due(now, 1) },
      { id: "t-review", title: "Review pull request #42", due: due(now, 3) },
      { id: "t-slides", title: "Draft workshop slides" }
    ],
    Home: [
      { id: "t-insurance", title: "Renew car insurance", due: due(now, 7) },
      { id: "t-plants", title: "Repot the plants" }
    ]
  };

  const days = [0, 1, 2, 3].map(d => at(now, d, 12, 0));
  const weather = {
    current: { temperature_2m: 2.6, weather_code: 3 },
    daily: {
      time: days.map(iso),
      weather_code: [3, 61, 71, 1],
      temperature_2m_max: [4.1, 5.3, 1.2, 0.4],
      temperature_2m_min: [-0.8, 1.9, -2.6, -4.2],
      sunrise: days.map(d => `${iso(d)}T07:54`),
      sunset: days.map(d => `${iso(d)}T16:07`)
    }
  };

  return { calendars, tasks, weather };
}

/** Two months of habit ticks and half a year of daily totals, so streaks and the graph have something to show. */
export function demoHabits(gs) {
  let seed = 7;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const day = gs.logicalDay_(TZ);
  const hist = {}, score = {};
  for (const h of gs.CFG.HABITS) {
    const rate = 0.45 + random() * 0.45;
    // Today starts unticked, so every box on HABITS is there to try
    hist[h.id] = Array.from({ length: gs.CFG.HIST_DAYS }, (_, i) => (i > 0 && random() < rate ? "1" : "0")).join("");
  }
  for (let i = 1; i < gs.CFG.SCORE_DAYS; i++) {
    const ticks = i < gs.CFG.HIST_DAYS ? Object.values(hist).filter(s => s[i] === "1").length : Math.floor(random() * 9);
    if (random() > 0.08) score[gs.shiftDay_(day, -i, TZ)] = ticks + Math.floor(random() * 3);
  }
  return { day, hist, score };
}
