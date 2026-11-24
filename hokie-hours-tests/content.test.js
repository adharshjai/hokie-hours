"use strict";
process.env.TZ = "America/New_York";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { boot } = require("./harness.js");

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "preview-main.txt"), "utf8");
const HASH = "#/teApp/timesheet/calendar/123456/P";
const SUNDAY = new Date(2026, 10, 22, 18).getTime();
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

async function loaded(options = {}) {
  const env = boot({ now: SUNDAY, hash: HASH, previewText: FIXTURE, ...options });
  await env.clock.advance(3 * SEC);
  return env;
}

test("does nothing inside a frame", async () => {
  const env = boot({ now: SUNDAY, hash: HASH, previewText: FIXTURE, isTopFrame: false });
  await env.clock.advance(5 * SEC);
  assert.equal(env.host(), null);
  assert.equal(env.frames.length, 0);
});

test("does nothing on other Employee Self-Service pages", async () => {
  const env = boot({ now: SUNDAY, pathname: "/EmployeeSelfService/ssb/other", previewText: FIXTURE });
  await env.clock.advance(5 * SEC);
  assert.equal(env.host(), null);
});

test("loads Preview in one sandboxed hidden frame, then removes it and shows hours", async () => {
  const env = await loaded();
  assert.equal(env.frames.length, 1);
  const frame = env.frames[0];
  assert.equal(frame.src, "https://selfservice.banner.vt.edu/EmployeeSelfService/ssb/timeEntry#/teApp/timesheet/preview/123456/P");
  assert.equal(frame.attrs.sandbox, "allow-same-origin allow-scripts");
  assert.equal(frame.attrs["aria-hidden"], "true");
  assert.ok("inert" in frame.attrs);
  assert.equal(env.activeFrames().length, 0);
  assert.equal(env.text("main"), "15h 06m left");
  assert.equal(env.text("sub"), "4.90 of 20 h this week");
  assert.equal(env.state().lastJobId, "123456");
  assert.equal(env.host().shadowInit.mode, "closed");
});

test("a frame that never loads is removed at 20 seconds and saved data stays", async () => {
  const first = await loaded();
  const saved = first.state();
  const env = boot({ now: SUNDAY, hash: HASH, previewText: "Loading", stored: saved });
  await env.clock.advance(19 * SEC);
  assert.equal(env.activeFrames().length, 1);
  await env.clock.advance(1 * SEC + 1);
  assert.equal(env.activeFrames().length, 0);
  assert.equal(env.text("main"), "15h 06m left");
  assert.ok(env.text("sub").includes("showing saved hours"));
});

test("a blocked frame (for example an expired login) is handled safely", async () => {
  const env = boot({ now: SUNDAY, hash: HASH, previewText: FIXTURE });
  env.frameBlocked = true;
  await env.clock.advance(21 * SEC);
  assert.equal(env.activeFrames().length, 0);
  assert.deepEqual(env.state().periods, {});
});

test("a clock-in during the first seconds after load still triggers a refresh", async () => {
  const env = boot({ now: SUNDAY, hash: HASH, previewText: FIXTURE });
  await env.clock.advance(2 * SEC);
  env.userClick();
  env.button.textContent = "Clock Out";
  await env.clock.advance(5 * SEC);
  assert.equal(env.state().session.source, "click");
  assert.equal(env.frames.length, 2);
});

test("never refreshes on a timer: one hour idle creates no new frames", async () => {
  const env = await loaded();
  await env.clock.advance(HOUR);
  assert.equal(env.frames.length, 1);
});

test("only one frame exists at a time; a queued refresh runs afterward", async () => {
  const env = boot({ now: SUNDAY, hash: HASH, previewText: FIXTURE });
  await env.clock.advance(100);
  env.setHash("#/teApp/timesheet/preview/123456/P");
  env.setHash("#/teApp/timesheet/calendar/123456/P");
  await env.clock.advance(100);
  assert.equal(env.activeFrames().length, 1);
  await env.clock.advance(5 * SEC);
  assert.equal(env.frames.length, 2);
  assert.equal(env.activeFrames().length, 0);
});

test("refreshes when the tab returns after more than five minutes, not sooner", async () => {
  const env = await loaded();
  env.setVisibility("hidden");
  await env.clock.advance(2 * MIN);
  env.setVisibility("visible");
  await env.clock.advance(3 * SEC);
  assert.equal(env.frames.length, 1);

  env.setVisibility("hidden");
  await env.clock.advance(6 * MIN);
  assert.equal(env.frames.length, 1, "no request while hidden");
  env.setVisibility("visible");
  await env.clock.advance(3 * SEC);
  assert.equal(env.frames.length, 2);
});

test("a tab opened in the background waits until it is visible", async () => {
  const env = boot({ now: SUNDAY, hash: HASH, previewText: FIXTURE, visibilityState: "hidden" });
  await env.clock.advance(30 * SEC);
  assert.equal(env.frames.length, 0);
  env.setVisibility("visible");
  await env.clock.advance(3 * SEC);
  assert.equal(env.frames.length, 1);
});

test("refreshes when the visible timesheet total changes", async () => {
  const env = boot({ now: SUNDAY, hash: HASH, previewText: FIXTURE });
  env.document.body.innerText = "Pay Period: 11/16/2026 - 11/30/2026 23.28 Hours";
  await env.clock.advance(4 * SEC);
  assert.equal(env.frames.length, 1);
  for (const { fn } of env.listeners.keydown) fn({ isTrusted: true });
  env.document.body.innerText = "Pay Period: 11/16/2026 - 11/30/2026 24.28 Hours";
  env.mutate();
  await env.clock.advance(5 * SEC);
  assert.equal(env.frames.length, 2);
});

test("clock in: passive click time drives a live countdown from recorded hours", async () => {
  const env = await loaded();
  await env.clock.advance(10 * SEC);
  const clickAt = env.clock.now;
  env.userClick();
  await env.clock.advance(SEC);
  env.button.textContent = "Clock Out";
  await env.clock.advance(4 * SEC);
  assert.equal(env.state().session.source, "click");
  assert.equal(env.state().session.startMs, clickAt);

  await env.clock.advance(HOUR - 5 * SEC);
  assert.equal(env.text("main"), "14:06:00 left");
  assert.equal(env.text("sub"), "5.90 of 20 h this week");
  assert.equal(env.node("dot").hidden, false);
  assert.deepEqual(env.button.operated, [], "the Banner button is never operated");
});

test("the click listener is passive and ignores untrusted events", async () => {
  const env = await loaded();
  const listener = env.listeners.click[0];
  assert.equal(listener.opts.passive, true);
  assert.equal(listener.opts.capture, true);
  listener.fn({ isTrusted: false, target: env.button });
  await env.clock.advance(SEC);
  assert.equal(env.state().pendingClick, null);
});

test("survives a reload while clocked in", async () => {
  const env = await loaded();
  await env.clock.advance(10 * SEC);
  const clickAt = env.clock.now;
  env.userClick();
  env.button.textContent = "Clock Out";
  await env.clock.advance(4 * SEC);

  const reloaded = boot({
    now: clickAt + HOUR, hash: HASH, previewText: FIXTURE, buttonText: "Clock Out", storage: env.storage,
  });
  await reloaded.clock.advance(4 * SEC);
  assert.equal(reloaded.state().session.startMs, clickAt);
  assert.match(reloaded.text("main"), /^14:05:5\d left$/);
});

test("a brief default Clock In during page load does not end a saved session", async () => {
  const first = await loaded();
  await first.clock.advance(10 * SEC);
  const clickAt = first.clock.now;
  first.userClick();
  first.button.textContent = "Clock Out";
  await first.clock.advance(4 * SEC);

  const env = boot({ now: clickAt + HOUR, hash: HASH, previewText: FIXTURE, buttonText: "Clock In", storage: first.storage });
  await env.clock.advance(4 * SEC);
  env.button.textContent = "Clock Out";
  await env.clock.advance(4 * SEC);
  assert.equal(env.state().session.startMs, clickAt);
});

test("a persistent Clock In after load clears a stale session without counting it", async () => {
  const first = await loaded();
  await first.clock.advance(10 * SEC);
  first.userClick();
  first.button.textContent = "Clock Out";
  await first.clock.advance(4 * SEC);

  const env = boot({ now: first.clock.now + 7 * HOUR, hash: HASH, previewText: FIXTURE, buttonText: "Clock In", storage: first.storage });
  await env.clock.advance(12 * SEC);
  assert.equal(env.state().session, null);
  assert.deepEqual(env.state().closeouts, []);
  assert.equal(env.text("main"), "15h 06m left");
});

test("clock out: no visible jump or double count during the refresh", async () => {
  const env = await loaded();
  await env.clock.advance(10 * SEC);
  env.userClick();
  env.button.textContent = "Clock Out";
  await env.clock.advance(4 * SEC);
  await env.clock.advance(HOUR);

  env.previewText = "Loading";
  const framesBefore = env.frames.length;
  env.userClick();
  env.button.textContent = "Clock In";
  await env.clock.advance(4 * SEC);
  assert.equal(env.state().session, null);
  assert.equal(env.state().closeouts.length, 1);
  assert.equal(env.frames.length, framesBefore + 1, "clock change triggers one refresh");
  assert.equal(env.text("main"), "14h 05m left");
  assert.equal(env.text("sub").startsWith("5.9"), true);

  env.previewText = FIXTURE
    .replace("23.28 Hours In", "24.28 Hours In")
    .replace("11/22/2026\nREG, Regular Pay\n1\n3.33 Hours", "11/22/2026\nREG, Regular Pay\n1\n4.33 Hours")
    .replace(
      "Summary\nEarn Code",
      "11/22/2026\nREG, Regular Pay\n1\n1.00\n06:00 PM\n06:00 PM\n07:00 PM\n07:00 PM\nSummary\nEarn Code"
    );
  await env.clock.advance(25 * SEC);
  env.setHash(HASH);
  await env.clock.advance(3 * SEC);
  assert.deepEqual(env.state().closeouts, []);
  assert.equal(env.text("main"), "14h 06m left");
  assert.equal(env.text("sub"), "5.90 of 20 h this week");
});

test("unexpected button text leaves the state alone", async () => {
  const env = await loaded({ buttonText: "Punch" });
  await env.clock.advance(30 * SEC);
  assert.equal(env.state().session, null);
  assert.equal(env.text("main"), "15h 06m left");
});

test("a missing clock button leaves the state alone", async () => {
  const env = await loaded({ buttonText: null });
  await env.clock.advance(30 * SEC);
  assert.equal(env.state().session, null);
});

test("Dashboard uses the last stored job id", async () => {
  const first = await loaded();
  const env = boot({
    now: SUNDAY + HOUR, pathname: "/EmployeeSelfService/ssb/hrDashboard", previewText: FIXTURE,
    buttonText: null, storage: first.storage,
  });
  await env.clock.advance(3 * SEC);
  assert.ok(env.frames[0].src.endsWith("/teApp/timesheet/preview/123456/P"));
  assert.equal(env.text("main"), "15h 06m left");
});

test("Dashboard with no job id asks to open the timesheet and makes no frame", async () => {
  const env = boot({ now: SUNDAY, pathname: "/EmployeeSelfService/ssb/hrDashboard", buttonText: null });
  await env.clock.advance(5 * SEC);
  assert.equal(env.frames.length, 0);
  assert.equal(env.text("sub"), "Open your timesheet once");
});

test("the screen reader region does not change on every tick but stays current", async () => {
  const env = await loaded();
  await env.clock.advance(10 * SEC);
  env.userClick();
  env.button.textContent = "Clock Out";
  await env.clock.advance(4 * SEC);
  const before = env.text("sr");
  const mainBefore = env.text("main");
  await env.clock.advance(30 * SEC);
  assert.notEqual(env.text("main"), mainBefore);
  assert.equal(env.text("sr"), before);
  await env.clock.advance(3 * HOUR);
  assert.equal(env.text("main").startsWith("12:0"), true);
  assert.match(env.text("sr"), /^About 12 hours 0 minutes left of 20 this week\. Clocked in\./);
});

test("the widget does not block clicks on the page", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "hokie-hours-extension", "content.js"), "utf8");
  assert.match(source, /:host \{[\s\S]*?pointer-events: none !important;/);
  assert.match(source, /position: fixed !important;\s*top: 6px !important;\s*left: 50% !important;\s*transform: translateX\(-50%\) !important;/);
  assert.match(source, /prefers-reduced-motion/);
});
