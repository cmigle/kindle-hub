import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScript, event, plain, TZ } from "./harness.mjs";

// Local Vilnius time; 2026-11-18 is a Wednesday
const at = iso => new Date(iso);

test("grace streak survives one missed day but not two", () => {
  const { gs } = loadScript();
  assert.equal(gs.streakGrace_("1110000"), 3);
  assert.equal(gs.streakGrace_("1101100"), 4);
  assert.equal(gs.streakGrace_("1001111"), 1);
});

test("an unticked today is neutral for the streak", () => {
  const { gs } = loadScript();
  assert.equal(gs.streakGrace_("0111000"), 3);
  assert.equal(gs.streakGrace_("0000000"), 0);
});

test("contribution levels follow 0 / 1-2 / 3-4 / 5-7 / 8+", () => {
  const { gs } = loadScript();
  assert.deepEqual([0, 1, 2, 3, 4, 5, 7, 8, 20].map(n => gs.level_(n)), ["0", "1", "1", "2", "2", "3", "3", "4", "4"]);
});

test("the logical day rolls over at 04:00, not midnight", () => {
  assert.equal(loadScript({ now: at("2026-11-18T03:59") }).gs.logicalDay_(TZ), "2026-11-17");
  assert.equal(loadScript({ now: at("2026-11-18T04:00") }).gs.logicalDay_(TZ), "2026-11-18");
});

test("chore pairs swap every week and stay put within a week", () => {
  const { gs } = loadScript();
  assert.equal(gs.weekParity_(at("2026-11-16T09:00")), gs.weekParity_(at("2026-11-22T21:00")));
  assert.notEqual(gs.weekParity_(at("2026-11-16T09:00")), gs.weekParity_(at("2026-11-23T09:00")));
});

test("bins warn the evening before and on the day", () => {
  const { gs } = loadScript();
  assert.deepEqual(plain(gs.getBins_(at("2026-11-17T18:00"))), [{ label: "General waste", when: "out tonight" }]);
  assert.deepEqual(plain(gs.getBins_(at("2026-11-18T08:00"))), [{ label: "General waste", when: "today" }]);
  assert.deepEqual(plain(gs.getBins_(at("2026-11-19T18:00"))), [{ label: "Recycling", when: "out tonight" }]);
});

test("habit history shifts by the days missed and old scores are dropped", () => {
  const { gs, props } = loadScript({ now: at("2026-11-18T12:00") });
  props.setProperty("habits", JSON.stringify({
    day: "2026-11-16",
    hist: { bed: "1" + "0".repeat(59) },
    score: { "2026-11-16": 3, "2026-01-01": 5 }
  }));

  const st = gs.habitState_(TZ, "2026-11-18");

  assert.equal(st.hist.bed.slice(0, 4), "0010");
  assert.equal(st.hist.bed.length, gs.CFG.HIST_DAYS);
  assert.equal(st.score["2026-11-16"], 3);
  assert.ok(!("2026-01-01" in st.score), "scores older than SCORE_DAYS are pruned");
  assert.equal(Object.keys(st.hist).length, gs.CFG.HABITS.length);
});

test("toggling a habit flips today's bit and the day's score", () => {
  const { gs, props, cache } = loadScript({ now: at("2026-11-18T12:00") });
  const state = () => JSON.parse(props.getProperty("habits"));
  gs.buildPayload_();
  assert.ok(cache.get("payload"), "payload is cached");

  assert.deepEqual(plain(gs.toggleHabit_("bed")), { ok: true, id: "bed", done: true });
  assert.equal(state().hist.bed[0], "1");
  assert.equal(state().score["2026-11-18"], 1);
  assert.equal(cache.get("payload"), null, "a write drops the cached payload");

  gs.toggleHabit_("bed");
  assert.equal(state().hist.bed[0], "0");
  assert.equal(state().score["2026-11-18"], 0);
  assert.equal(gs.toggleHabit_("unknown").ok, false);
});

test("contribution graph is 7 x GRAPH_WEEKS with future days blank", () => {
  const { gs } = loadScript({ now: at("2026-11-18T12:00") });
  const st = gs.habitState_(TZ, "2026-11-18");
  st.score["2026-11-16"] = 2;
  st.score["2026-11-18"] = 9;

  const g = gs.buildGraph_(TZ, "2026-11-18", st);

  assert.equal(g.rows.length, 7);
  for (const row of g.rows) assert.equal(row.length, gs.CFG.GRAPH_WEEKS);
  assert.equal(g.rows[0].at(-1), "1");  // Monday 16th
  assert.equal(g.rows[2].at(-1), "4");  // Wednesday 18th, today
  assert.equal(g.rows[3].at(-1), "-");  // Thursday 19th, future
  assert.equal(g.months.length, gs.CFG.GRAPH_WEEKS);
  assert.deepEqual(
    { total: g.stats.total, today: g.stats.today, best: g.stats.best, bestDay: g.stats.bestDay, dayStreak: g.stats.dayStreak },
    { total: 11, today: 9, best: 9, bestDay: "18 Nov", dayStreak: 1 });
});

test("Wednesday chores go first, tasks follow by deadline, undated last", () => {
  const now = at("2026-11-18T12:00");
  const { gs } = loadScript({
    now,
    tasks: {
      Work: [{ id: "a", title: "Report", due: "2026-11-25T00:00:00.000Z" }, { id: "b", title: "Undated" }],
      Home: [{ id: "c", title: "Call plumber", due: "2026-11-19T00:00:00.000Z" }, { id: "d", title: "   " }]
    }
  });

  const merged = gs.getMerged_(TZ, now, "2026-11-18");

  assert.deepEqual(plain(merged.map(r => r.kind)), ["chore", "chore", "chore", "chore", "task", "task", "task"]);
  assert.deepEqual(plain(merged.filter(r => r.kind === "task").map(r => `${r.title}|${r.due}|${r.src}`)),
    ["Call plumber|19 Nov|Home", "Report|25 Nov|Work", "Undated||Work"]);
});

test("a ticked chore disappears for the rest of the day", () => {
  const now = at("2026-11-18T12:00");
  const { gs } = loadScript({ now });
  gs.completeChore_("w1");
  assert.ok(!gs.getMerged_(TZ, now, "2026-11-18").some(r => r.id === "w1"));
});

test("the same chore goes to the other person next week", () => {
  const firstChoreOwner = iso => {
    const now = at(iso);
    return loadScript({ now }).gs.getMerged_(TZ, now, iso.slice(0, 10))[0].src;
  };
  assert.notEqual(firstChoreOwner("2026-11-18T12:00"), firstChoreOwner("2026-11-25T12:00"));
});

test("Friday adds that week's deep-clean job", () => {
  const now = at("2026-11-20T12:00"); // third Friday-week of the month
  const merged = loadScript({ now }).gs.getMerged_(TZ, now, "2026-11-20");
  assert.ok(merged.some(r => r.title === "Washing machine drawer + filter"));
});

test("next up skips running events and excluded calendars; the week is bucketed per day", () => {
  const now = at("2026-11-18T12:00");
  const { gs } = loadScript({
    now,
    calendars: {
      Work: [event("Standup", "2026-11-18T09:00"), event("Review", "2026-11-18T15:30", { location: "Room 4" })],
      Family: [event("Dinner", "2026-11-20T19:00"), event("Trip", "2026-11-22T00:00", { allDay: true })],
      Birthdays: [event("A birthday", "2026-11-18T00:00", { allDay: true })]
    }
  });

  const p = gs.buildPayload_();

  assert.deepEqual(plain(p.nextUp), {
    title: "Review", cal: "Work", day: "Today", time: "15:30", loc: "Room 4",
    epoch: Math.floor(at("2026-11-18T15:30").getTime() / 1000)
  });
  assert.equal(p.date, "Wednesday, 18 November");
  assert.equal(p.week.length, 7);
  assert.equal(p.week[0].today, true);
  assert.deepEqual(plain(p.week[0].events.map(e => e.n)), ["Standup", "Review"]);
  assert.deepEqual(plain(p.week[2].events.map(e => `${e.t} ${e.n}`)), ["19:00 Dinner"]);
  assert.deepEqual(plain(p.week[4].events[0]), { t: "", n: "Trip" });
});

test("next up searches further out when the fortnight is empty", () => {
  const now = at("2026-11-18T12:00");
  const { gs } = loadScript({ now, calendars: { Personal: [event("Dentist", "2026-12-28T10:00")] } });
  const next = gs.buildPayload_().nextUp;
  assert.equal(next.title, "Dentist");
  assert.equal(next.day, "Mon 28 Dec");
});
