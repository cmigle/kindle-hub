import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScript, call, plain } from "./harness.mjs";

const now = new Date("2026-11-18T12:00");

test("every request is rejected until a token is created", () => {
  const { gs } = loadScript({ now });
  assert.deepEqual(call(gs, {}), { ok: false, error: "unauthorized" });
  assert.deepEqual(call(gs, { token: "" }), { ok: false, error: "unauthorized" });
});

test("createToken stores a random 64-character token and logs it once", () => {
  const { gs, props, logs } = loadScript({ now });
  gs.createToken();
  const token = props.getProperty("HUB_TOKEN");
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.ok(logs.some(l => l.includes(token)));

  gs.createToken();
  assert.notEqual(props.getProperty("HUB_TOKEN"), token, "running it again rotates the token");
});

test("only the matching token is accepted", () => {
  const { gs, props } = loadScript({ now });
  props.setProperty("HUB_TOKEN", "secret");
  assert.deepEqual(call(gs, { token: "wrong", action: "ping" }), { ok: false, error: "unauthorized" });
  assert.deepEqual(call(gs, { token: "secret", action: "ping" }), { ok: true, pong: true });
});

test("the full payload has everything the ESP32 renders", () => {
  const { gs, props } = loadScript({ now });
  props.setProperty("HUB_TOKEN", "secret");
  const p = call(gs, { token: "secret" });
  for (const key of ["ok", "clock", "date", "nextUp", "merged", "week", "habits", "graph", "bins", "countdowns", "weather", "ms"])
    assert.ok(key in p, `payload has ${key}`);
  assert.equal(p.habits.length, gs.CFG.HABITS.length);
  assert.equal(p.weather, null, "weather failures degrade to null instead of failing the payload");
});

test("actions are routed and validated", () => {
  const { gs, props, patched } = loadScript({ now });
  props.setProperty("HUB_TOKEN", "secret");
  const send = params => call(gs, { token: "secret", ...params });

  assert.deepEqual(send({ action: "toggleHabit", id: "read" }), { ok: true, id: "read", done: true });
  assert.deepEqual(send({ action: "completeChore", id: "w2" }), { ok: true, id: "w2" });
  assert.deepEqual(send({ action: "completeTask", id: "t1" }), { ok: false, error: "missing id" });
  assert.deepEqual(send({ action: "completeTask", list: "l1", id: "t1" }), { ok: true, done: "t1" });
  assert.deepEqual(plain(patched), [{ body: { status: "completed" }, listId: "l1", taskId: "t1" }]);

  const score = JSON.parse(props.getProperty("habits")).score["2026-11-18"];
  assert.equal(score, 3, "habit, chore and task all count towards the graph");
});

test("a completed task and a ticked chore leave the next payload", () => {
  const { gs, props } = loadScript({ now, tasks: { Work: [{ id: "t1", title: "Report" }, { id: "t2", title: "Slides" }] } });
  props.setProperty("HUB_TOKEN", "secret");
  const send = params => call(gs, { token: "secret", ...params });
  const ids = () => send({}).merged.map(r => r.id);

  assert.deepEqual(ids(), ["w1", "w2", "w3", "w4", "t1", "t2"]);
  send({ action: "completeTask", list: "list0", id: "t1" });
  send({ action: "completeChore", id: "w3" });
  assert.deepEqual(ids(), ["w1", "w2", "w4", "t2"], "writes drop the cached payload");
});
