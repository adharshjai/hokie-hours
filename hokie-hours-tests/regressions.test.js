"use strict";
// One regression test per confirmed review defect.
process.env.TZ = "America/New_York";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const H = require("../hokie-hours-extension/hours.js");
const { boot } = require("./harness.js");

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "preview-main.txt"), "utf8");
const JOB = "123456";
const HASH = `#/teApp/timesheet/calendar/${JOB}/P`;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const at = (y, mo, d, h = 12, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const SUNDAY = at(2026, 11, 22, 18);
const EMPTY_PERIOD = "Pay Period: 11/16/2026 - 11/30/2026 0.00 Hours Not Started";
const withOpenPunch = (time) =>
  FIXTURE.replace("Summary\nEarn Code", `11/22/2026\nREG, Regular Pay\n1\n${time}\n${time}\nSummary\nEarn Code`);

function previewText({ start, end, total, entries = [], punches = [], noPunchSection = false }) {
  const lines = [
    "Timesheet Detail Summary",
    "Student job, Rate: $0.000000",
    `Pay Period: ${start} - ${end} ${total} Hours In Progress`,
    "Time Entry Detail", "Date", "Earn Code", "Shift", "Total",
  ];
  for (const [date, hours] of entries) lines.push(date, "REG, Regular Pay", "1", `${hours} Hours`);
  if (!noPunchSection) {
    lines.push("Time Information", "Date", "Earn Code", "Shift", "Hours/Units", "Time In",
      "System In", "Comment In", "Time Out", "System Out", "Comment Out");
    for (const row of punches) lines.push(...row);
    lines.push("Summary", "Earn Code", "Shift", "Week 1", "Total", "Routing and Status");
  }
  return lines.join("\n");
}

const closedRow = (date, hours, a, b) => [date, "REG, Regular Pay", "1", hours, a, a, b, b];
const parse = (text) => {
  const parsed = H.parsePreviewText(text);
  assert.equal(parsed.ok, true, parsed.reason);
  return parsed;
};
const apply = (state, text, nowMs, jobId = JOB, buttonState, extra = {}) =>
  H.applyPreview(state, parse(text), { jobId, nowMs, buttonState, ...extra });
const session = (startMs, source = "click", jobId = JOB, observedAt = startMs) => ({
  startMs, source, jobId, observedAt, confirmedAt: observedAt,
});
const empty = (over = {}) => ({ ...H.emptyState(), ...over });

async function loaded(options = {}) {
  const env = boot({ now: SUNDAY, hash: HASH, previewText: FIXTURE, ...options });
  await env.clock.advance(3 * SEC);
  return env;
}

async function clockedIn(options = {}) {
  const env = await loaded(options);
  await env.clock.advance(10 * SEC);
  env.userClick();
  env.button.textContent = "Clock Out";
  await env.clock.advance(4 * SEC);
  return env;
}

test("1: a Clock In on a new job id stops an old-id session from draining the week", async () => {
  const first = await clockedIn();
  const env = boot({
    now: first.clock.now + 5 * HOUR,
    hash: "#/teApp/timesheet/calendar/999999/P",
    previewText: EMPTY_PERIOD,
    storage: first.storage,
  });
  await env.clock.advance(12 * SEC);
  assert.equal(env.text("main"), "15h 06m left");
  assert.ok(env.text("sub").includes("clock status unclear"));
  assert.equal(env.node("dot").hidden, true);
  await env.clock.advance(10 * HOUR);
  assert.equal(env.text("main"), "15h 06m left");
});

test("1: a real Clock Out to Clock In change ends a session from an older job id", () => {
  const start = at(2026, 11, 22, 12);
  const end = at(2026, 11, 22, 13);
  const state = empty({ session: session(start, "click", "111") });
  const out = H.applyButtonState(state, H.CLOCKED_OUT, {
    nowMs: end + 2 * SEC, changedAtMs: end, jobId: "222", observedClockOut: true,
  });
  assert.equal(out.session, null);
  assert.equal(H.computeStatus(out, end + 8 * HOUR).usedHours, 1);
});

test("1: a Clock In on a new job id ends an old-id session nothing confirmed for a day", () => {
  const start = SUNDAY - 25 * HOUR;
  const state = empty({ session: session(start, "click", "111") });
  const after = H.applyButtonState(state, H.CLOCKED_OUT, { nowMs: SUNDAY, jobId: "222" });
  assert.equal(after.session, null);
  assert.deepEqual(after.closeouts, [], "no end time is invented");
});

test("2: a clocked-in label with extra text still counts as clocked in", async () => {
  assert.equal(H.classifyButtonText("Clock Out 06:00 PM"), H.CLOCKED_IN);
  assert.equal(H.classifyButtonText("Clock Outside"), H.UNKNOWN);
  const env = await loaded();
  await env.clock.advance(10 * SEC);
  env.userClick();
  env.button.textContent = "Clock Out 06:00 PM";
  await env.clock.advance(4 * SEC);
  assert.equal(env.state().session.source, "click");
  assert.equal(env.node("dot").hidden, false);
});

test("2: an unreadable label refreshes once and lets the server's open punch through", async () => {
  const env = await loaded();
  await env.clock.advance(10 * SEC);
  const framesBefore = env.frames.length;
  env.previewText = withOpenPunch("06:00 PM");
  env.userInput();
  env.button.textContent = "End Shift";
  await env.clock.advance(6 * SEC);
  assert.equal(env.frames.length, framesBefore + 1);
  assert.equal(env.state().session.source, "server");
  await env.clock.advance(30 * SEC);
  assert.equal(env.frames.length, framesBefore + 1, "no repeated loads for the same label");
});

test("3: a server open punch outranks a stale Clock In reading", async () => {
  const env = await loaded();
  await env.clock.advance(3 * MIN);
  env.previewText = withOpenPunch("06:02 PM");
  env.setHash("#/teApp/timesheet/preview/123456/P");
  await env.clock.advance(3 * SEC);
  assert.equal(env.state().session.source, "server");
  assert.equal(env.state().session.startMs, at(2026, 11, 22, 18, 2));
  assert.match(env.text("main"), /^\d+:\d{2}:\d{2} left$/);
});

test("a Clock In button drawn after an open row began means no shift is running", async () => {
  const env = await loaded({ previewText: withOpenPunch("05:00 PM") });
  await env.clock.advance(10 * SEC);
  env.setHash("#/teApp/timesheet/preview/123456/P");
  await env.clock.advance(3 * SEC);
  env.setHash(HASH);
  await env.clock.advance(3 * MIN);
  assert.equal(env.state().session, null);
  assert.equal(env.text("main"), "15h 06m left");
  assert.equal(env.node("dot").hidden, true);
});

test("unclear daily hours are kept, which can only show less time left", () => {
  const now = at(2026, 11, 22, 15);
  const row = (time) => ["11/22/2026", "REG, Regular Pay", "1", time, time];
  const text = (time) => previewText({
    start: "11/16/2026", end: "11/30/2026", total: "2.00",
    entries: [["11/22/2026", "2.00"]], punches: [row(time)],
  });
  const matched = H.computeStatus(apply(empty(), text("01:00 PM"), now, JOB, H.UNKNOWN), now);
  assert.ok(Math.abs(matched.usedHours - 4) < 0.001, `used ${matched.usedHours}`);
  const unrelated = H.computeStatus(apply(empty(), text("02:30 PM"), now, JOB, H.UNKNOWN), now);
  assert.ok(Math.abs(unrelated.usedHours - 2.5) < 0.001, `used ${unrelated.usedHours}`);
});

test("3: a server open punch still wins when the button is no longer visible", async () => {
  const env = await loaded();
  await env.clock.advance(10 * SEC);
  env.button.visible = false;
  env.previewText = withOpenPunch("05:00 PM");
  env.setHash("#/teApp/timesheet/preview/123456/P");
  await env.clock.advance(3 * SEC);
  assert.equal(env.state().session.source, "server");
});

test("4: a Preview for another period cannot end a running server session", () => {
  const start = at(2026, 11, 30, 23);
  const next = previewText({ start: "12/01/2026", end: "12/15/2026", total: "0.00" });
  assert.equal(apply(empty({ session: session(start, "server") }), next, at(2026, 12, 1, 0, 30)).session.startMs, start);

  const nov22 = at(2026, 11, 22, 9);
  const older = previewText({ start: "11/01/2026", end: "11/15/2026", total: "0.00" });
  assert.equal(apply(empty({ session: session(nov22, "server") }), older, at(2026, 11, 22, 10)).session.startMs, nov22);

  const same = previewText({ start: "11/16/2026", end: "11/30/2026", total: "0.00" });
  assert.equal(
    apply(empty({ session: session(nov22, "server") }), same, at(2026, 11, 22, 10)).session.startMs,
    nov22,
    "a missing row does not end a running shift"
  );
});

test("5: an unsettled closeout survives a Preview of a period that cannot contain it", () => {
  const base = apply(empty(), previewText({
    start: "11/16/2026", end: "11/30/2026", total: "2.00", entries: [["11/28/2026", "2.00"]],
  }), at(2026, 11, 30, 17));
  const start = at(2026, 11, 30, 18);
  const end = at(2026, 11, 30, 23);
  const out = H.applyButtonState({ ...base, session: session(start) }, H.CLOCKED_OUT, {
    nowMs: end, changedAtMs: end, jobId: JOB, observedClockOut: true,
  });
  const now = at(2026, 12, 1, 9);
  const after = apply(out, previewText({ start: "12/01/2026", end: "12/15/2026", total: "0.00" }), now);
  assert.equal(after.closeouts.length, 1);
  assert.equal(H.computeStatus(after, now).usedHours, 7);
});

test("6: a day worked after the last read of its period is flagged", () => {
  const a = previewText({ start: "11/16/2026", end: "11/30/2026", total: "2.00", entries: [["11/28/2026", "2.00"]] });
  const b = previewText({ start: "12/01/2026", end: "12/15/2026", total: "0.00" });
  let state = apply(empty(), a, at(2026, 11, 29, 12));
  const now = at(2026, 12, 1, 12);
  state = apply(state, b, now);
  const status = H.computeStatus(state, now);
  assert.deepEqual(status.missingDates, ["2026-11-29", "2026-11-30"]);
  assert.ok(H.toViewModel(status).secondary.includes("11/29-11/30 may be missing"));
});

test("7: a closeout under an old job id settles from the same punch under a new id", () => {
  const start = at(2026, 12, 1, 9);
  const end = at(2026, 12, 1, 11);
  const state = empty({ closeouts: [{ startMs: start, endMs: end, baselineMs: 0, jobId: "111" }] });
  const text = previewText({
    start: "12/01/2026", end: "12/15/2026", total: "2.00", entries: [["12/01/2026", "2.00"]],
    punches: [closedRow("12/01/2026", "2.00", "09:00 AM", "11:00 AM")],
  });
  const now = at(2026, 12, 1, 12);
  const after = apply(state, text, now, "222");
  assert.deepEqual(after.closeouts, []);
  assert.equal(H.computeStatus(after, now).usedHours, 2);
});

test("8: a fresh Clock In click replaces a stale saved session", async () => {
  const stale = SUNDAY - 7 * HOUR;
  const env = boot({
    now: SUNDAY, hash: HASH, previewText: FIXTURE,
    stored: empty({ session: session(stale) }),
  });
  await env.clock.advance(2 * SEC);
  const clickAt = env.clock.now;
  env.userClick();
  env.button.textContent = "Clock Out";
  await env.clock.advance(4 * SEC);
  assert.equal(env.state().session.startMs, clickAt);
  assert.equal(env.state().pendingClick, null);
  assert.match(env.text("main"), /^15:0\d:\d{2} left$/);
});

test("9: a stale Clock Out reading never writes a phantom session", () => {
  const start = at(2026, 11, 22, 13, 17);
  const closed = apply(empty({ session: session(start) }), FIXTURE, SUNDAY, JOB, H.CLOCKED_IN);
  assert.equal(closed.session, null, "Preview shows the punch closed");
  assert.equal(apply(empty(), FIXTURE, SUNDAY, JOB, H.CLOCKED_IN).session, null);
});

test("9: a tab that shows Clock In can clear an unknown session", () => {
  const unknown = { startMs: null, source: "unknown", jobId: JOB, observedAt: SUNDAY - HOUR, confirmedAt: SUNDAY - HOUR };
  const cleared = H.applyButtonState(empty({ session: unknown }), H.CLOCKED_OUT, { nowMs: SUNDAY, jobId: JOB });
  assert.equal(cleared.session, null);
});

test("10: a long default Clock In on reload does not lose the click start", async () => {
  const first = await clockedIn();
  const clickAt = first.state().session.startMs;
  const env = boot({
    now: clickAt + HOUR, hash: HASH, previewText: FIXTURE, buttonText: "Clock In", storage: first.storage,
  });
  await env.clock.advance(9 * SEC);
  assert.equal(env.state().session, null);
  env.button.textContent = "Clock Out";
  await env.clock.advance(4 * SEC);
  assert.equal(env.state().session.startMs, clickAt);
  assert.match(env.text("main"), /^14:05:\d{2} left$/);
});

test("10: a brief redraw to Clock In mid-shift leaves no false closeout", async () => {
  const env = await loaded({ previewText: withOpenPunch("05:00 PM") });
  await env.clock.advance(15 * SEC);
  env.button.textContent = "Clock Out";
  await env.clock.advance(6 * SEC);
  assert.equal(env.state().session.source, "server");
  const usedBefore = H.computeStatus(H.normalizeState(env.state()), env.clock.now).usedMs;
  env.button.textContent = "Clock In";
  await env.clock.advance(3 * SEC);
  env.button.textContent = "Clock Out";
  await env.clock.advance(6 * SEC);
  assert.deepEqual(env.state().closeouts, []);
  assert.equal(env.state().session.startMs, at(2026, 11, 22, 17));
  const usedAfter = H.computeStatus(H.normalizeState(env.state()), env.clock.now).usedMs;
  assert.ok(Math.abs(usedAfter - usedBefore - 9 * SEC) <= SEC);
});

test("11: a Clock In committed on another job's route cannot end this job's session", async () => {
  const env = await clockedIn();
  const startMs = env.state().session.startMs;
  env.button.textContent = "Clock In";
  env.previewText = EMPTY_PERIOD;
  env.setHash("#/teApp/timesheet/calendar/777777/P");
  await env.clock.advance(10 * SEC);
  assert.equal(env.state().session.startMs, startMs);

  env.button.textContent = "Clock Out";
  env.previewText = FIXTURE;
  env.setHash(HASH);
  await env.clock.advance(1500);
  assert.equal(env.state().session.startMs, startMs, "Preview landed before the button settled");
  await env.clock.advance(4 * SEC);
  assert.equal(env.state().session.source, "click");
  assert.equal(env.state().session.conflictAt, undefined);
  await env.clock.advance(HOUR);
  assert.match(env.text("main"), /^14:05:\d{2} left$/);
});

test("12: a short earlier punch is not mistaken for the current session", () => {
  const start = at(2026, 11, 22, 17, 1, 30);
  const text = previewText({
    start: "11/16/2026", end: "11/30/2026", total: "0.02", entries: [["11/22/2026", "0.02"]],
    punches: [closedRow("11/22/2026", "0.02", "05:00 PM", "05:01 PM")],
  });
  const now = at(2026, 11, 22, 17, 30);
  for (const button of [H.CLOCKED_IN, H.UNKNOWN]) {
    const after = apply(empty({ session: session(start) }), text, now, JOB, button);
    assert.equal(after.session.startMs, start);
    assert.equal(after.session.source, "click");
  }
});

test("12: a short earlier punch does not settle the following closeout", () => {
  const start = at(2026, 11, 22, 17, 1, 30);
  const end = at(2026, 11, 22, 18);
  const text = previewText({
    start: "11/16/2026", end: "11/30/2026", total: "0.02", entries: [["11/22/2026", "0.02"]],
    punches: [closedRow("11/22/2026", "0.02", "05:00 PM", "05:01 PM")],
  });
  const state = empty({ closeouts: [{ startMs: start, endMs: end, baselineMs: 0, jobId: JOB }] });
  const after = apply(state, text, end + MIN);
  assert.equal(after.closeouts.length, 1);
  assert.ok(H.computeStatus(after, end + MIN).usedHours > 0.99);
});

test("13: an old unconfirmed session does not render as a live over-limit countdown", async () => {
  const stale = SUNDAY - 70 * HOUR;
  const stored = empty({ session: session(stale) });
  const env = boot({
    now: SUNDAY, pathname: "/EmployeeSelfService/ssb/hrDashboard", buttonText: null,
    previewText: FIXTURE, stored: { ...stored, lastJobId: JOB },
  });
  await env.clock.advance(3 * SEC);
  assert.equal(env.text("main"), "15h 06m left");
  assert.ok(env.text("sub").includes("clock status unclear"));
  assert.notEqual(env.node("pill").getAttribute("data-level"), "over");
  await env.clock.advance(HOUR);
  assert.equal(env.text("main"), "15h 06m left");
});

test("13: a visible Clock Out vouches for a long shift", () => {
  const start = SUNDAY - 30 * HOUR;
  const state = H.applyButtonState(empty({ session: session(start) }), H.CLOCKED_IN, { nowMs: SUNDAY, jobId: JOB });
  assert.equal(H.computeStatus(state, SUNDAY).live, true);
  const later = H.confirmSession(state, SUNDAY + 20 * HOUR);
  assert.equal(H.computeStatus(later, SUNDAY + 30 * HOUR).live, true);
});

test("14: hours on a rejected open row stay counted", () => {
  const text = previewText({
    start: "11/16/2026", end: "11/30/2026", total: "2.00", entries: [["11/21/2026", "2.00"]],
    punches: [["11/21/2026", "REG, Regular Pay", "1", "2.00", "05:00 PM", "05:00 PM"]],
  });
  const now = at(2026, 11, 21, 20);
  const withButton = apply(empty(), text, now, JOB, H.CLOCKED_OUT);
  assert.equal(withButton.session, null);
  assert.equal(H.computeStatus(withButton, now).usedHours, 2);

  const later = at(2026, 11, 22, 18);
  const aged = apply(empty(), text, later);
  assert.equal(aged.session, null);
  assert.equal(H.computeStatus(aged, later).usedHours, 2);
});

test("15: a Clock In first seen before a newer session cannot erase it", () => {
  const seenAt = SUNDAY;
  const clickAt = seenAt + 2 * SEC;
  const state = empty({ session: session(clickAt, "click", JOB, clickAt + 2 * SEC) });
  const after = H.applyButtonState(state, H.CLOCKED_OUT, { nowMs: seenAt + 8 * SEC, changedAtMs: seenAt, jobId: JOB });
  assert.equal(after.session.startMs, clickAt);
});

test("16: a Preview loaded before a clock-out cannot recreate the session", () => {
  const start = at(2026, 11, 22, 17);
  const end = start + HOUR;
  const base = { ...apply(empty(), FIXTURE, start), session: session(start, "server") };
  const out = H.applyButtonState(base, H.CLOCKED_OUT, {
    nowMs: end + 2 * SEC, changedAtMs: end, jobId: JOB, observedClockOut: true,
  });
  const after = apply(out, withOpenPunch("05:00 PM"), end + 4 * SEC, JOB, H.UNKNOWN, { snapshotAt: end - SEC });
  assert.equal(after.session, null);
  assert.equal(after.closeouts.length, 1);
  assert.ok(Math.abs(H.computeStatus(after, end + 4 * SEC).usedHours - 5.9) < 1e-9);
});

test("17: a self-updating total on an idle page cannot keep loading frames", async () => {
  const env = boot({ now: SUNDAY, hash: HASH, previewText: FIXTURE });
  env.document.body.innerText = "Pay Period: 11/16/2026 - 11/30/2026 23.28 Hours";
  await env.clock.advance(4 * SEC);
  const base = env.frames.length;
  for (let i = 1; i <= 60; i++) {
    env.document.body.innerText = `Pay Period: 11/16/2026 - 11/30/2026 ${(23.28 + i / 100).toFixed(2)} Hours`;
    env.mutate();
    await env.clock.advance(36 * SEC);
  }
  assert.equal(env.frames.length, base, "no real user action, so no loads");

  for (const { fn } of env.listeners.keydown) fn({ isTrusted: true });
  env.document.body.innerText = "Pay Period: 11/16/2026 - 11/30/2026 30.00 Hours";
  env.mutate();
  await env.clock.advance(5 * SEC);
  assert.equal(env.frames.length, base + 1);
});

test("18: screen reader text follows data changes while clocked out", async () => {
  const env = await loaded();
  assert.match(env.text("sr"), /^15 hours 6 minutes left/);
  env.previewText = FIXTURE
    .replace("23.28 Hours In", "27.28 Hours In")
    .replace("11/22/2026\nREG, Regular Pay\n1\n3.33 Hours", "11/22/2026\nREG, Regular Pay\n1\n7.33 Hours");
  env.setHash(HASH);
  await env.clock.advance(3 * SEC);
  assert.equal(env.text("main"), "11h 06m left");
  assert.match(env.text("sr"), /^11 hours 6 minutes left/);
});

test("19: a Preview without Time Information cannot end a server session", () => {
  const truncated = FIXTURE.slice(0, FIXTURE.indexOf("Time Information"));
  const parsed = parse(truncated);
  assert.equal(parsed.punchesListed, false);
  const start = SUNDAY - HOUR;
  const after = H.applyPreview(empty({ session: session(start, "server") }), parsed, { jobId: JOB, nowMs: SUNDAY });
  assert.equal(after.session.startMs, start);
});

test("20: an open punch in the repeated fall-back hour keeps the real click time", () => {
  const firstPass = at(2026, 11, 1, 1, 30);
  const secondPass = firstPass + HOUR;
  assert.equal(new Date(secondPass).getHours(), 1);
  const text = previewText({
    start: "11/01/2026", end: "11/15/2026", total: "0.00",
    punches: [["11/01/2026", "REG, Regular Pay", "1", "01:30 AM", "01:30 AM"]],
  });
  const now = secondPass + 30 * MIN;
  const after = apply(empty({ session: session(secondPass) }), text, now, JOB, H.CLOCKED_IN);
  assert.equal(after.session.source, "server");
  assert.equal(after.session.startMs, secondPass);
  assert.equal(H.computeStatus(after, now).liveMs, 30 * MIN);
});

test("21: a second clock-out keeps an unsettled first closeout", () => {
  const base = apply(empty(), FIXTURE, at(2026, 11, 22, 16, 40));
  const out = (state, startMs, endMs) => H.applyButtonState({ ...state, session: session(startMs) }, H.CLOCKED_OUT, {
    nowMs: endMs, changedAtMs: endMs, jobId: JOB, observedClockOut: true,
  });
  const a = at(2026, 11, 22, 17);
  const first = out(base, a, a + HOUR);
  const second = out(first, a + 2 * HOUR, a + 2 * HOUR + 10 * MIN);
  assert.equal(second.closeouts.length, 2);
  const used = H.computeStatus(second, a + 2 * HOUR + 11 * MIN).usedHours;
  assert.ok(Math.abs(used - (4.9 + 1 + 10 / 60)) < 1e-9);

  const reread = H.normalizeState(JSON.parse(JSON.stringify(second)));
  assert.equal(reread.closeouts.length, 2);
});

test("21: a closeout stored by the earlier version is kept", () => {
  const state = H.normalizeState({
    version: 1, closeout: { startMs: SUNDAY - HOUR, endMs: SUNDAY, baselineMs: 0, jobId: JOB },
  });
  assert.equal(state.closeouts.length, 1);
  assert.equal(H.computeStatus(state, SUNDAY).usedHours, 1);
});

test("22: a live shift rolls into an unread new week instead of showing dashes", () => {
  const text = previewText({
    start: "07/16/2026", end: "07/31/2026", total: "1.00", entries: [["07/30/2026", "1.00"]],
  });
  const start = at(2026, 7, 31, 23);
  const state = { ...apply(empty(), text, start), session: session(start) };
  const now = at(2026, 8, 1, 0, 30);
  const status = H.computeStatus(state, now);
  const view = H.toViewModel(status);
  assert.equal(view.main, "19:30:00 left");
  assert.ok(view.secondary.includes("open the current timesheet"));
  assert.ok(view.ariaText.includes("Clocked in."));
});

test("23: start time unknown does not hide the missing-dates warning", () => {
  const text = previewText({ start: "12/01/2026", end: "12/15/2026", total: "2.00", entries: [["12/01/2026", "2.00"]] });
  const now = at(2026, 12, 2, 12);
  const unknown = { startMs: null, source: "unknown", jobId: JOB, observedAt: now, confirmedAt: now };
  const view = H.toViewModel(H.computeStatus({ ...apply(empty(), text, now), session: unknown }, now));
  assert.ok(view.secondary.includes("start time unknown"));
  assert.ok(view.secondary.includes("11/28-11/30 may be missing"));
  assert.ok(view.ariaText.includes("11/28-11/30 may be missing"));
});

test("24: the progress bar sits clear of the pill's rounded corners", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "hokie-hours-extension", "content.js"), "utf8");
  const bar = /\.bar \{([^}]*)\}/.exec(source)[1];
  const inset = Number(/left: (\d+)px/.exec(bar)[1]);
  const bottom = Number(/bottom: (\d+)px/.exec(bar)[1]);
  assert.equal(Number(/right: (\d+)px/.exec(bar)[1]), inset);
  const radius = 18;
  const clipped = radius - Math.sqrt(radius ** 2 - (radius - bottom) ** 2);
  assert.ok(inset >= clipped, `inset ${inset} must clear ${clipped.toFixed(2)}px`);
});

test("25: an orphaned content script removes itself and starts no frames", async () => {
  const env = await loaded();
  const framesBefore = env.frames.length;
  env.chrome.runtime.id = undefined;
  await env.clock.advance(2 * SEC);
  assert.equal(env.host(), null);
  env.setHash("#/teApp/timesheet/preview/123456/P");
  await env.clock.advance(5 * SEC);
  assert.equal(env.frames.length, framesBefore);
});
