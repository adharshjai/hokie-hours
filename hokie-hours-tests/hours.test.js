"use strict";
process.env.TZ = "America/New_York";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const H = require("../hokie-hours-extension/hours.js");

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "preview-main.txt"), "utf8");
const JOB = "123456";
const HOUR = 3600000;
const MIN = 60000;
const at = (y, mo, d, h = 12, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const SUNDAY = at(2026, 11, 22, 18);

function previewText({ start, end, total, entries = [], punches = [] }) {
  const lines = [
    "Timesheet Detail Summary",
    "Student job, Rate: $0.000000",
    `Pay Period: ${start} - ${end} ${total} Hours In Progress`,
    "Time Entry Detail", "Date", "Earn Code", "Shift", "Total",
  ];
  for (const [date, hours, earn = "REG, Regular Pay"] of entries) {
    lines.push(date, earn, "1", `${hours} Hours`);
  }
  lines.push("Time Information", "Date", "Earn Code", "Shift", "Hours/Units", "Time In",
    "System In", "Comment In", "Time Out", "System Out", "Comment Out");
  for (const row of punches) lines.push(...row);
  lines.push("Summary", "Earn Code", "Shift", "Week 1", "Total", "Routing and Status");
  return lines.join("\n");
}

function stateFrom(text, nowMs, jobId = JOB, base = H.emptyState(), buttonState) {
  const parsed = H.parsePreviewText(text);
  assert.equal(parsed.ok, true, parsed.reason);
  return H.applyPreview(base, parsed, { jobId, nowMs, buttonState });
}

test("timezone for this file is US Eastern", () => {
  assert.equal(new Date(2026, 10, 22).getTimezoneOffset(), 300);
});

test("parses the observed Preview fixture", () => {
  const p = H.parsePreviewText(FIXTURE);
  assert.equal(p.ok, true);
  assert.deepEqual(p.period, { startKey: "2026-11-16", endKey: "2026-11-30" });
  assert.equal(p.periodTotal, 23.28);
  assert.deepEqual(p.dateTotals, {
    "2026-11-16": 2.8, "2026-11-17": 3.68, "2026-11-18": 4.92,
    "2026-11-20": 6.98, "2026-11-21": 1.57, "2026-11-22": 3.33,
  });
  assert.equal(p.punches.length, 3);
  assert.ok(p.punches.every((x) => x.state === "closed"));
  assert.equal(p.punches[2].inMs, at(2026, 11, 22, 13, 17));
  assert.equal(p.punches[2].outMs, at(2026, 11, 22, 16, 37));
});

test("parser tolerates tabs between cells", () => {
  const p = H.parsePreviewText(FIXTURE.replace(/\n(?=REG|1\n|\d+\.\d+ Hours)/g, "\t"));
  assert.equal(p.ok, true);
  assert.equal(p.dateTotals["2026-11-22"], 3.33);
});

test("core formula: 15.10 left on the fixture Sunday, 14.10 after one live hour", () => {
  const state = stateFrom(FIXTURE, SUNDAY);
  const out = H.computeStatus(state, SUNDAY);
  assert.equal(out.weekStartKey, "2026-11-21");
  assert.equal(out.weekEndKey, "2026-11-27");
  assert.equal(out.recordedHours, 4.9);
  assert.equal(out.remainingHours, 15.1);
  const view = H.toViewModel(out);
  assert.equal(view.main, "15h 06m left");
  assert.equal(view.secondary, "4.90 of 20 h this week");

  const clocked = { ...state, session: { startMs: SUNDAY, source: "click", jobId: JOB, observedAt: SUNDAY } };
  const live = H.computeStatus(clocked, SUNDAY + HOUR);
  assert.ok(Math.abs(live.remainingHours - 14.1) < 1e-9);
  const liveView = H.toViewModel(live);
  assert.equal(liveView.main, "14:06:00 left");
  assert.equal(liveView.secondary, "5.90 of 20 h this week");
  assert.equal(liveView.clockedIn, true);
});

test("sums multiple earn-code rows on one date", () => {
  const text = previewText({
    start: "11/16/2026", end: "11/30/2026", total: "3.50",
    entries: [["11/22/2026", "2.00"], ["11/22/2026", "1.50", "OVT, Other Pay"]],
  });
  assert.equal(H.parsePreviewText(text).dateTotals["2026-11-22"], 3.5);
});

test("a time inside a comment is not a punch time", () => {
  const text = previewText({
    start: "11/16/2026", end: "11/30/2026", total: "1.00",
    entries: [["11/22/2026", "1.00"]],
    punches: [["11/22/2026", "REG, Regular Pay", "1", "1.00", "01:00 PM", "01:00 PM",
      "left early at 1:30 PM", "02:00 PM", "02:00 PM"]],
  });
  assert.equal(H.parsePreviewText(text).punches[0].state, "closed");
});

test("a comment that is exactly a time makes the row ambiguous, never open", () => {
  const text = previewText({
    start: "11/16/2026", end: "11/30/2026", total: "1.00",
    entries: [["11/22/2026", "1.00"]],
    punches: [["11/22/2026", "REG, Regular Pay", "1", "1.00", "01:00 PM", "01:00 PM",
      "1:30 PM", "02:00 PM", "02:00 PM"]],
  });
  const p = H.parsePreviewText(text);
  assert.equal(p.punches[0].state, "ambiguous");
  assert.equal(stateFrom(text, SUNDAY).session, null);
});

test("two time tokens are open, unless they are an In/Out pair matching the hours", () => {
  const open = previewText({
    start: "11/16/2026", end: "11/30/2026", total: "0.00",
    punches: [["11/22/2026", "REG, Regular Pay", "1", "05:00 PM", "05:00 PM"]],
  });
  const openPunch = H.parsePreviewText(open).punches[0];
  assert.equal(openPunch.state, "open");
  assert.equal(openPunch.inMs, at(2026, 11, 22, 17));

  const manual = previewText({
    start: "11/16/2026", end: "11/30/2026", total: "1.50",
    entries: [["11/22/2026", "1.50"]],
    punches: [["11/22/2026", "REG, Regular Pay", "1", "1.50", "01:00 PM", "02:30 PM"]],
  });
  assert.equal(H.parsePreviewText(manual).punches[0].state, "closed");
});

test("partial hours on an open punch are not counted twice", () => {
  const text = previewText({
    start: "11/16/2026", end: "11/30/2026", total: "3.50",
    entries: [["11/22/2026", "3.50"]],
    punches: [
      ["11/22/2026", "REG, Regular Pay", "1", "3.00", "09:00 AM", "09:00 AM", "12:00 PM", "12:00 PM"],
      ["11/22/2026", "REG, Regular Pay", "1", "0.50", "05:00 PM", "05:00 PM"],
    ],
  });
  const now = at(2026, 11, 22, 17, 30);
  const state = stateFrom(text, now);
  assert.equal(state.session.source, "server");
  const s = H.computeStatus(state, now);
  assert.equal(s.recordedHours, 3);
  assert.equal(s.liveMs, 30 * MIN);
  assert.equal(s.usedHours, 3.5);
});

test("partial open hours absent from the daily total are not subtracted", () => {
  const text = previewText({
    start: "11/16/2026", end: "11/30/2026", total: "3.00",
    entries: [["11/22/2026", "3.00"]],
    punches: [
      ["11/22/2026", "REG, Regular Pay", "1", "3.00", "09:00 AM", "09:00 AM", "12:00 PM", "12:00 PM"],
      ["11/22/2026", "REG, Regular Pay", "1", "0.50", "05:00 PM", "05:00 PM"],
    ],
  });
  assert.equal(H.parsePreviewText(text).recordedByDate["2026-11-22"], 3);
});

test("rejects half-rendered or inconsistent Preview text", () => {
  assert.equal(H.parsePreviewText("").ok, false);
  assert.equal(H.parsePreviewText("Loading").ok, false);
  assert.equal(H.parsePreviewText("Pay Period: 11/16/2026 - 11/30/2026 23.28 Hours").ok, false);
  const missingRow = FIXTURE.replace("11/22/2026\nREG, Regular Pay\n1\n3.33 Hours\n", "");
  assert.equal(H.parsePreviewText(missingRow).reason, "total-mismatch");
  const before = stateFrom(FIXTURE, SUNDAY);
  assert.deepEqual(H.applyPreview(before, H.parsePreviewText("Loading"), { jobId: JOB, nowMs: SUNDAY }), before);
});

test("dates are local and never shift through UTC", () => {
  assert.equal(H.dateKeyFromMs(at(2026, 11, 22, 23, 59)), "2026-11-22");
  assert.equal(H.dateKeyFromMs(at(2026, 11, 22, 0, 1)), "2026-11-22");
  assert.equal(H.startOfDayMs("2026-11-22"), at(2026, 11, 22, 0));
  assert.equal(H.dateKeyFromUs("02/30/2026"), null);
  for (const TZ of ["Pacific/Honolulu", "Asia/Tokyo", "Pacific/Auckland", "UTC"]) {
    const script = `const H=require(${JSON.stringify(path.join(__dirname, "..", "hokie-hours-extension", "hours.js"))});
      const w=H.weekForDateKey("2026-11-22");
      const d=new Date(H.startOfDayMs("2026-11-22"));
      process.stdout.write([w.startKey,w.endKey,d.getDate(),H.dateKeyFromMs(H.startOfDayMs("2026-11-22"))].join(","));`;
    const r = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, TZ }, encoding: "utf8" });
    assert.equal(r.stdout, "2026-11-21,2026-11-27,22,2026-11-22", TZ);
  }
});

test("weeks run Saturday through Friday", () => {
  assert.equal(H.weekForDateKey("2026-11-21").startKey, "2026-11-21");
  assert.equal(H.weekForDateKey("2026-11-27").startKey, "2026-11-21");
  assert.equal(H.weekForDateKey("2026-11-28").startKey, "2026-11-28");
  assert.equal(H.weekForDateKey("2027-01-01").startKey, "2026-12-26");
});

test("DST: elapsed time uses real timestamps", () => {
  const session = (startMs) => ({ ...H.emptyState(), session: { startMs, source: "click", jobId: JOB, observedAt: startMs } });
  const fallStart = at(2026, 10, 31, 23);
  const fallNow = at(2026, 11, 1, 3);
  assert.equal(H.computeStatus(session(fallStart), fallNow).liveMs, 5 * HOUR);
  const springStart = at(2027, 3, 13, 23);
  const springNow = at(2027, 3, 14, 4);
  assert.equal(H.computeStatus(session(springStart), springNow).liveMs, 4 * HOUR);
});

test("an open punch across midnight inside one week counts fully", () => {
  const start = at(2026, 11, 22, 23);
  const s = H.computeStatus({ ...H.emptyState(), session: { startMs: start, source: "click", jobId: JOB, observedAt: start } }, at(2026, 11, 23, 1));
  assert.equal(s.liveMs, 2 * HOUR);
});

test("Friday to Saturday: only the new-week portion counts and the countdown rolls", () => {
  const state = stateFrom(FIXTURE, SUNDAY);
  const start = at(2026, 11, 27, 23);
  const clocked = { ...state, session: { startMs: start, source: "click", jobId: JOB, observedAt: start } };
  const friday = H.computeStatus(clocked, at(2026, 11, 27, 23, 59, 59));
  assert.equal(friday.weekStartKey, "2026-11-21");
  assert.equal(friday.liveMs, 59 * MIN + 59000);
  assert.equal(friday.recordedHours, 4.9);
  const saturday = H.computeStatus(clocked, at(2026, 11, 28, 1));
  assert.equal(saturday.weekStartKey, "2026-11-28");
  assert.equal(saturday.liveMs, HOUR);
  assert.equal(saturday.recordedHours, 0);
  assert.equal(saturday.remainingHours, 19);
});

test("a week straddling two pay periods sums by date", () => {
  const now = at(2026, 12, 2, 12);
  const a = previewText({ start: "11/16/2026", end: "11/30/2026", total: "7.00",
    entries: [["11/27/2026", "2.00"], ["11/28/2026", "2.00"], ["11/30/2026", "3.00"]] });
  const b = previewText({ start: "12/01/2026", end: "12/15/2026", total: "4.00",
    entries: [["12/01/2026", "4.00"]] });
  let state = stateFrom(a, now);
  state = stateFrom(b, now, JOB, state);
  const s = H.computeStatus(state, now);
  assert.equal(s.weekStartKey, "2026-11-28");
  assert.equal(s.recordedHours, 9);
  assert.deepEqual(s.missingDates, []);
});

test("re-reading a period replaces it, removing deleted entries", () => {
  let state = stateFrom(FIXTURE, SUNDAY);
  const edited = previewText({ start: "11/16/2026", end: "11/30/2026", total: "1.57",
    entries: [["11/21/2026", "1.57"]] });
  state = stateFrom(edited, SUNDAY, JOB, state);
  assert.equal(Object.keys(state.periods).length, 1);
  assert.equal(H.computeStatus(state, SUNDAY).recordedHours, 1.57);
});

test("multiple jobs on one date are summed", () => {
  const a = previewText({ start: "11/16/2026", end: "11/30/2026", total: "2.00", entries: [["11/22/2026", "2.00"]] });
  const b = previewText({ start: "11/16/2026", end: "11/30/2026", total: "1.25", entries: [["11/22/2026", "1.25"]] });
  let state = stateFrom(a, SUNDAY, "111");
  state = stateFrom(b, SUNDAY, "222", state);
  assert.equal(H.computeStatus(state, SUNDAY).recordedHours, 3.25);
});

test("warns about past week dates outside every seen period, but not future dates", () => {
  const next = previewText({ start: "12/01/2026", end: "12/15/2026", total: "1.00", entries: [["12/01/2026", "1.00"]] });
  const now = at(2026, 12, 2, 12);
  const s = H.computeStatus(stateFrom(next, now), now);
  assert.deepEqual(s.missingDates, ["2026-11-28", "2026-11-29", "2026-11-30"]);
  assert.equal(H.toViewModel(s).secondary, "1.00 of 20 h · 11/28-11/30 may be missing");

  const sunday = H.computeStatus(stateFrom(FIXTURE, at(2026, 11, 29, 12)), at(2026, 11, 29, 12));
  assert.deepEqual(sunday.missingDates, []);
});

test("a Preview that does not contain today keeps data and asks for the current timesheet", () => {
  const today = at(2026, 12, 2, 12);
  const current = previewText({ start: "12/01/2026", end: "12/15/2026", total: "1.00", entries: [["12/01/2026", "1.00"]] });
  let state = stateFrom(current, today, "777");
  state = stateFrom(FIXTURE, today, "555", state);
  assert.equal(state.lastJobId, "777", "an old period does not take over the job id");

  const stale = stateFrom(FIXTURE, today);
  const view = H.toViewModel(H.computeStatus(stale, today));
  assert.ok(view.secondary.includes("open the current timesheet"));
});

test("no job id and no data ask the user to open the timesheet once", () => {
  const view = H.toViewModel(H.computeStatus(H.emptyState(), SUNDAY));
  assert.equal(view.main, "-- left");
  assert.equal(view.secondary, "Open your timesheet once");
});

test("clock-in priority: server punch beats click time", () => {
  const click = at(2026, 11, 22, 17, 0, 40);
  let state = H.recordClockClick(stateFrom(FIXTURE, click - 1000), click, JOB);
  state = H.applyButtonState(state, H.CLOCKED_IN, { nowMs: click + 3000, jobId: JOB });
  assert.equal(state.session.source, "click");
  assert.equal(state.session.startMs, click);
  assert.equal(state.pendingClick, null);

  const text = FIXTURE.replace("Summary\nEarn Code", "11/22/2026\nREG, Regular Pay\n1\n05:00 PM\n05:00 PM\nSummary\nEarn Code");
  state = stateFrom(text, click + 60000, JOB, state, H.CLOCKED_IN);
  assert.equal(state.session.source, "server");
  assert.equal(state.session.startMs, at(2026, 11, 22, 17));
});

test("clocked in with no start time shows recorded remaining and never invents one", () => {
  const state = H.applyButtonState(stateFrom(FIXTURE, SUNDAY), H.CLOCKED_IN, { nowMs: SUNDAY, jobId: JOB });
  assert.equal(state.session.source, "unknown");
  assert.equal(state.session.startMs, null);
  const s = H.computeStatus(state, SUNDAY + 2 * HOUR);
  assert.equal(s.startUnknown, true);
  assert.equal(s.liveMs, 0);
  assert.equal(s.remainingHours, 15.1);
  const view = H.toViewModel(s);
  assert.equal(view.main, "15h 06m left");
  assert.ok(view.secondary.includes("start time unknown"));
});

test("an old click does not become a start time", () => {
  let state = H.recordClockClick(H.emptyState(), SUNDAY, JOB);
  state = H.applyButtonState(state, H.CLOCKED_IN, { nowMs: SUNDAY + 3 * MIN, jobId: JOB });
  assert.equal(state.session.source, "unknown");
});

test("unrecognized button text changes nothing", () => {
  assert.equal(H.classifyButtonText("End Shift"), H.UNKNOWN);
  assert.equal(H.classifyButtonText("  Clock\n In "), H.CLOCKED_OUT);
  assert.equal(H.classifyButtonText("Clock Out"), H.CLOCKED_IN);
  const state = stateFrom(FIXTURE, SUNDAY);
  assert.equal(H.applyButtonState(state, H.UNKNOWN, { nowMs: SUNDAY }), state);
});

test("button reading Clock In clears the session", () => {
  const start = SUNDAY - HOUR;
  const state = { ...stateFrom(FIXTURE, SUNDAY), session: { startMs: start, source: "click", jobId: JOB, observedAt: start } };
  const cleared = H.applyButtonState(state, H.CLOCKED_OUT, { nowMs: SUNDAY, jobId: JOB });
  assert.equal(cleared.session, null);
  assert.deepEqual(cleared.closeouts, [], "a stale session found on load gets no invented end time");
});

test("Preview showing the punch closed clears the session", () => {
  const start = at(2026, 11, 22, 13, 17, 20);
  const base = { ...H.emptyState(), session: { startMs: start, source: "click", jobId: JOB, observedAt: start } };
  assert.equal(stateFrom(FIXTURE, SUNDAY, JOB, base).session, null);
});

test("a click session survives a Preview that simply does not list it", () => {
  const start = SUNDAY - 5 * MIN;
  const base = { ...H.emptyState(), session: { startMs: start, source: "click", jobId: JOB, observedAt: start } };
  assert.equal(stateFrom(FIXTURE, SUNDAY, JOB, base, H.CLOCKED_IN).session.startMs, start);
});

test("clock-out holds the total steady until Preview catches up, with no double count", () => {
  const start = at(2026, 11, 22, 17);
  const end = start + HOUR;
  const base = { ...stateFrom(FIXTURE, start), session: { startMs: start, source: "click", jobId: JOB, observedAt: start } };
  const before = H.computeStatus(base, end);

  const out = H.applyButtonState(base, H.CLOCKED_OUT, { nowMs: end + 2000, changedAtMs: end, jobId: JOB, observedClockOut: true });
  assert.equal(out.session, null);
  const during = H.computeStatus(out, end + 2000);
  assert.equal(during.usedMs, before.usedMs, "no jump during the refresh");

  const lagging = stateFrom(FIXTURE, end + 3000, JOB, out, H.CLOCKED_OUT);
  assert.equal(lagging.closeouts.length, 1, "kept while Banner has not recorded the punch");

  const updated = FIXTURE
    .replace("23.28 Hours In", "24.28 Hours In")
    .replace("11/22/2026\nREG, Regular Pay\n1\n3.33 Hours", "11/22/2026\nREG, Regular Pay\n1\n4.33 Hours")
    .replace("Summary\nEarn Code", "11/22/2026\nREG, Regular Pay\n1\n1.00\n05:00 PM\n05:00 PM\n06:00 PM\n06:00 PM\nSummary\nEarn Code");
  const done = stateFrom(updated, end + 5000, JOB, lagging, H.CLOCKED_OUT);
  assert.deepEqual(done.closeouts, []);
  const after = H.computeStatus(done, end + 5000);
  assert.equal(after.usedHours, 5.9);
  assert.equal(after.usedMs, before.usedMs);
});

test("over the limit displays the amount over", () => {
  const text = previewText({ start: "11/16/2026", end: "11/30/2026", total: "21.50", entries: [["11/22/2026", "21.50"]] });
  const s = H.computeStatus(stateFrom(text, SUNDAY), SUNDAY);
  assert.equal(s.level, "over");
  assert.equal(H.toViewModel(s).main, "Over by 1h 30m");
  const start = SUNDAY - 1000;
  const live = H.computeStatus({ ...stateFrom(text, SUNDAY), session: { startMs: start, source: "click", jobId: JOB, observedAt: start } }, SUNDAY);
  assert.equal(H.toViewModel(live).main, "Over by 1:30:01");
});

test("levels: amber at one hour or less, red only when over", () => {
  const level = (h) => {
    const t = previewText({ start: "11/16/2026", end: "11/30/2026", total: h, entries: [["11/22/2026", h]] });
    return H.computeStatus(stateFrom(t, SUNDAY), SUNDAY).level;
  };
  assert.equal(level("18.99"), "normal");
  assert.equal(level("19.00"), "warn");
  assert.equal(level("20.00"), "warn");
  assert.equal(level("20.01"), "over");
});

test("screen reader text changes only on meaningful changes, not each tick", () => {
  const start = SUNDAY;
  const state = { ...stateFrom(FIXTURE, SUNDAY), session: { startMs: start, source: "click", jobId: JOB, observedAt: start } };
  const a = H.toViewModel(H.computeStatus(state, start + 1000));
  const b = H.toViewModel(H.computeStatus(state, start + 2000));
  assert.notEqual(a.main, b.main);
  assert.equal(a.ariaKey, b.ariaKey);
});

test("screen reader key holds within a 15-minute step and moves across steps", () => {
  const state = { ...stateFrom(FIXTURE, SUNDAY), session: { startMs: SUNDAY, source: "click", jobId: JOB, observedAt: SUNDAY } };
  const a = H.toViewModel(H.computeStatus(state, SUNDAY + MIN));
  const b = H.toViewModel(H.computeStatus(state, SUNDAY + 5 * MIN));
  const c = H.toViewModel(H.computeStatus(state, SUNDAY + 30 * MIN));
  assert.notEqual(a.secondary, b.secondary);
  assert.equal(a.ariaKey, b.ariaKey);
  assert.notEqual(a.ariaKey, c.ariaKey);
});

test("another job's Clock In button does not end this job's session", () => {
  const session = { startMs: SUNDAY - HOUR, source: "click", jobId: "111", observedAt: SUNDAY - HOUR };
  const state = { ...stateFrom(FIXTURE, SUNDAY, "222"), session };
  const afterButton = H.applyButtonState(state, H.CLOCKED_OUT, { nowMs: SUNDAY, jobId: "222" });
  assert.equal(afterButton.session.startMs, session.startMs);
  assert.equal(afterButton.session.jobId, "111");
  assert.equal(stateFrom(FIXTURE, SUNDAY, "222", state, H.CLOCKED_OUT).session.startMs, session.startMs);
});

test("a days-old open row needs the button to confirm it", () => {
  const text = previewText({
    start: "11/16/2026", end: "11/30/2026", total: "0.00",
    punches: [["11/17/2026", "REG, Regular Pay", "1", "05:00 PM", "05:00 PM"]],
  });
  assert.equal(stateFrom(text, SUNDAY).session, null);
  const confirmed = stateFrom(text, SUNDAY, JOB, H.emptyState(), H.CLOCKED_IN);
  assert.equal(confirmed.session.source, "server");
  assert.equal(H.computeStatus(confirmed, SUNDAY).liveMs, SUNDAY - new Date(2026, 10, 21).getTime());
});

test("an empty new pay period is accepted and clears nothing else", () => {
  const empty = "Pay Period: 12/01/2026 - 12/15/2026 0.00 Hours Not Started";
  const p = H.parsePreviewText(empty);
  assert.equal(p.ok, true);
  assert.equal(p.isEmpty, true);
  const now = new Date(2026, 11, 2, 12).getTime();
  const state = stateFrom(empty, now, JOB, stateFrom(FIXTURE, now));
  assert.equal(Object.keys(state.periods).length, 2);
});

test("routes: job id is read from the hash", () => {
  assert.deepEqual(H.parseTimesheetRoute("#/teApp/timesheet/calendar/987654/P"), { jobId: "987654", suffix: "P" });
  assert.deepEqual(H.parseTimesheetRoute("#/teApp/timesheet/preview/42/P"), { jobId: "42", suffix: "P" });
  assert.equal(H.parseTimesheetRoute("#/teApp/other"), null);
  assert.equal(H.previewUrl("https://x.test", "42", "P"), "https://x.test/EmployeeSelfService/ssb/timeEntry#/teApp/timesheet/preview/42/P");
  assert.equal(H.previewUrl("https://x.test", "../evil", "P"), null);
  assert.equal(H.isWidgetPath("/EmployeeSelfService/ssb/hrDashboard"), true);
  assert.equal(H.isWidgetPath("/EmployeeSelfService/ssb/timeEntry"), true);
  assert.equal(H.isWidgetPath("/EmployeeSelfService/ssb/other"), false);
});

test("normalizeState discards malformed stored data", () => {
  assert.deepEqual(H.normalizeState(null), H.emptyState());
  assert.deepEqual(H.normalizeState({ version: 99 }), H.emptyState());
  const s = H.normalizeState({
    version: 1, lastJobId: "<b>", periods: { x: { jobId: "1", startKey: "bad", endKey: "bad", byDate: {} } },
    session: { source: "click", startMs: "soon" },
  });
  assert.equal(s.lastJobId, null);
  assert.deepEqual(s.periods, {});
  assert.equal(s.session, null);
});

test("weekly limit is one constant", () => {
  assert.equal(H.WEEKLY_LIMIT_HOURS, 20);
});
