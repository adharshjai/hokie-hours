"use strict";
process.env.TZ = "America/New_York";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { boot } = require("./harness.js");
const H = require("../hokie-hours-extension/hours.js");

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "preview-main.txt"), "utf8");
const HASH = "#/teApp/timesheet/calendar/123456/P";
const SUNDAY = new Date(2026, 10, 22, 18).getTime();
const SEC = 1000;
const MIN = 60 * SEC;

async function loaded(options = {}) {
  const env = boot({ now: SUNDAY, hash: HASH, previewText: FIXTURE, ...options });
  await env.clock.advance(3 * SEC);
  return env;
}

const editorOpen = (env) => !env.node("editor").hidden && env.node("text").hidden;

async function typeLimit(env, value, key = "Enter") {
  env.node("edit-input").value = value;
  env.fire("edit-input", "keydown", { key });
  await env.clock.flush();
}

test("typed limits are read as hours, and bad ones are refused", () => {
  assert.equal(H.parseLimitInput("19.8"), 19.8);
  assert.equal(H.parseLimitInput(" 20 "), 20);
  assert.equal(H.parseLimitInput("19,8"), 19.8);
  assert.equal(H.parseLimitInput(".5"), 0.5);
  assert.equal(H.parseLimitInput("19.833"), 19.83);
  for (const bad of ["", "0", "0.001", "-1", "abc", "19.8h", "1e2", "169", "19.8.1", null]) {
    assert.equal(H.parseLimitInput(bad), null, String(bad));
  }
});

test("a missing or broken saved limit falls back to 20", () => {
  assert.equal(H.normalizeLimit(19.8), 19.8);
  assert.equal(H.normalizeLimit(168), 168);
  for (const bad of [undefined, null, "19.8", 0, -5, 169, NaN, Infinity]) {
    assert.equal(H.normalizeLimit(bad), 20, String(bad));
  }
});

test("19.8 hours leaves exactly 12 fewer minutes than 20", () => {
  const ms = H.computeStatus(H.emptyState(), SUNDAY, 19.8).remainingMs;
  assert.equal(ms, 19.8 * 60 * MIN);
  assert.equal(H.formatHoursMinutes(ms), "19h 48m");
});

test("the default limit is still 20", async () => {
  const env = await loaded();
  assert.equal(env.text("main"), "15h 06m left");
  assert.equal(env.text("sub"), "4.90 of 20 h this week");
});

test("a saved 19.8 limit is used on load", async () => {
  const env = await loaded({ storage: { weeklyLimitHours: 19.8 } });
  assert.equal(env.text("main"), "14h 54m left");
  assert.equal(env.text("sub"), "4.90 of 19.8 h this week");
  assert.match(env.text("sr"), /^14 hours 54 minutes left of 19\.8 this week\./);
});

test("clicking the countdown opens the limit box with the current limit", async () => {
  const env = await loaded();
  assert.equal(editorOpen(env), false);
  assert.equal(env.node("pill").attrs.role, "button");
  env.fire("pill", "click");
  assert.equal(editorOpen(env), true);
  assert.equal(env.node("edit-input").value, "20");
  assert.equal(env.focused, env.node("edit-input"));
  assert.equal(env.text("hint"), "Enter to save · Esc to cancel");
});

test("typing 19.8 and pressing Enter saves it and updates the pill", async () => {
  const env = await loaded();
  env.fire("pill", "click");
  await typeLimit(env, "19.8");
  assert.equal(editorOpen(env), false, "Enter must not reopen the box as it bubbles to the pill");
  assert.equal(env.storage.weeklyLimitHours, 19.8);
  assert.equal(env.text("main"), "14h 54m left");
  assert.equal(env.text("sub"), "4.90 of 19.8 h this week");
  assert.notEqual(env.focused, env.node("pill"), "a mouse user gets no focus ring");
});

test("a keyboard user gets focus back on the pill after saving", async () => {
  const env = await loaded();
  env.fire("pill", "keydown", { key: "Enter" });
  await typeLimit(env, "19.8");
  assert.equal(env.storage.weeklyLimitHours, 19.8);
  assert.equal(env.focused, env.node("pill"));
});

test("the new limit is kept after the page reloads", async () => {
  const first = await loaded();
  first.fire("pill", "click");
  await typeLimit(first, "19.8");
  const env = await loaded({ storage: first.storage });
  assert.equal(env.text("sub"), "4.90 of 19.8 h this week");
});

test("a bad value keeps the box open with a hint, and Esc cancels", async () => {
  const env = await loaded();
  env.fire("pill", "click");
  await typeLimit(env, "abc");
  assert.equal(editorOpen(env), true);
  assert.equal(env.node("edit-input").attrs["aria-invalid"], "true");
  assert.match(env.text("hint"), /^Use a number like 19\.8/);
  assert.equal(env.storage.weeklyLimitHours, undefined);
  await typeLimit(env, "abc", "Escape");
  assert.equal(editorOpen(env), false);
  assert.equal(env.text("sub"), "4.90 of 20 h this week");
});

test("Esc throws away what was typed", async () => {
  const env = await loaded();
  env.fire("pill", "click");
  await typeLimit(env, "10", "Escape");
  assert.equal(env.storage.weeklyLimitHours, undefined);
  assert.equal(env.text("main"), "15h 06m left");
});

test("clicking away saves a good value and drops a bad one", async () => {
  const env = await loaded();
  env.fire("pill", "click");
  env.node("edit-input").value = "18";
  env.fire("edit-input", "blur");
  await env.clock.flush();
  assert.equal(editorOpen(env), false);
  assert.equal(env.storage.weeklyLimitHours, 18);

  await env.clock.advance(1 * SEC);
  env.fire("pill", "click");
  env.node("edit-input").value = "";
  env.fire("edit-input", "blur");
  await env.clock.flush();
  assert.equal(editorOpen(env), false);
  assert.equal(env.storage.weeklyLimitHours, 18);
});

test("a click right after the box closes does not reopen it", async () => {
  const env = await loaded();
  env.fire("pill", "click");
  env.fire("edit-input", "blur");
  env.fire("pill", "click");
  assert.equal(editorOpen(env), false);
  await env.clock.advance(1 * SEC);
  env.fire("pill", "click");
  assert.equal(editorOpen(env), true);
});

test("Enter on the focused pill opens the box; other keys and fake clicks do not", async () => {
  const env = await loaded();
  env.fire("pill", "keydown", { key: "a" });
  assert.equal(editorOpen(env), false);
  env.fire("pill", "click", { isTrusted: false });
  assert.equal(editorOpen(env), false);
  env.fire("pill", "keydown", { key: "Enter" });
  assert.equal(editorOpen(env), true);
});

test("a limit changed in another tab shows up here", async () => {
  const env = await loaded();
  await env.chrome.storage.local.set({ weeklyLimitHours: 19.8 });
  await env.clock.flush();
  assert.equal(env.text("sub"), "4.90 of 19.8 h this week");
  assert.match(env.node("pill").attrs["aria-label"], /19\.8 hour limit/);
});

test("only the pill takes clicks; the space around it stays click-through", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "hokie-hours-extension", "content.js"), "utf8");
  assert.match(source, /:host \{[\s\S]*?pointer-events: none !important;/);
  assert.match(source, /\.pill \{[\s\S]*?pointer-events: auto;/);
});
