"use strict";
// The timer must follow hours the user deletes, edits, or adds and then saves.
process.env.TZ = "America/New_York";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const H = require("../hokie-hours-extension/hours.js");
const { boot } = require("./harness.js");

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "preview-main.txt"), "utf8");
const HASH = "#/teApp/timesheet/calendar/123456/P";
const SUNDAY = new Date(2026, 10, 22, 18).getTime();
const SEC = 1000;
const MIN = 60 * SEC;

const DELETED = FIXTURE
  .replace("11/22/2026\nREG, Regular Pay\n1\n3.33 Hours\n", "")
  .replace("11/22/2026\nREG, Regular Pay\n1\n3.33\n01:17 PM\n01:17 PM\n04:37 PM\n04:37 PM\n", "")
  .replace("23.28 Hours In Progress", "19.95 Hours In Progress");
const ADDED = FIXTURE
  .replace("11/22/2026\nREG, Regular Pay\n1\n3.33 Hours", "11/22/2026\nREG, Regular Pay\n1\n5.33 Hours")
  .replace("23.28 Hours In Progress", "25.28 Hours In Progress");

// Written the way the real calendar prints it, with no space before the total.
const calendar = (periodTotal, dayTotal) =>
  `11/16/2026 - 11/30/2026${periodTotal} Hours\nIn Progress\nAdd Earn Code\n` +
  (dayTotal ? `Regular Pay\n${dayTotal}\nHours\nTotal: ${dayTotal}\nHours\n` : "") +
  "Exit Page\nCancel Save Preview";

const saveButton = () => ({
  textContent: "Save",
  disabled: false,
  isConnected: true,
  getClientRects: () => [{}],
  closest() { return this; },
});
const click = (env, target, isTrusted = true) => {
  for (const { fn } of env.listeners.click) fn({ isTrusted, target });
};
const pageClick = (env) => click(env, { closest: () => null });
const setPage = (env, text) => {
  env.document.body.innerText = text;
  env.mutate();
};

async function start() {
  const env = boot({ now: SUNDAY, hash: HASH, previewText: FIXTURE });
  env.document.body.innerText = calendar("23.28", "3.33");
  await env.clock.advance(12 * SEC);
  assert.equal(env.text("main"), "15h 06m left");
  return env;
}

test("reads the calendar's pay period total, not the selected day", () => {
  assert.equal(H.extractVisibleTotal("11/16/2026 - 11/30/202623.30 Hours\nTotal: 0.02\nHours"), "23.30");
  assert.equal(H.extractVisibleTotal("Pay Period: 11/16/2026 - 11/30/2026 23.28 Hours"), "23.28");
});

test("deleting a day's only entry updates after Save", async () => {
  const env = await start();
  pageClick(env);
  setPage(env, calendar("19.95", null));
  await env.clock.advance(4 * SEC);
  const save = saveButton();
  click(env, save);
  env.previewText = DELETED;
  save.disabled = true;
  await env.clock.advance(5 * SEC);
  assert.equal(env.text("main"), "18h 25m left");
});

test("a total that changes before Save still updates after Save", async () => {
  const env = await start();
  pageClick(env);
  setPage(env, calendar("19.95", "1.00"));
  await env.clock.advance(5 * SEC);
  assert.equal(env.text("main"), "15h 06m left", "nothing is stored until Save");
  const save = saveButton();
  click(env, save);
  env.previewText = DELETED;
  save.disabled = true;
  await env.clock.advance(5 * SEC);
  assert.equal(env.text("main"), "18h 25m left");
});

test("added hours reduce the time left after Save", async () => {
  const env = await start();
  const save = saveButton();
  click(env, save);
  env.previewText = ADDED;
  save.disabled = true;
  await env.clock.advance(5 * SEC);
  assert.equal(env.text("main"), "13h 06m left");
});

test("catches a Save that takes 25 seconds", async () => {
  const env = await start();
  const save = saveButton();
  click(env, save);
  await env.clock.advance(25 * SEC);
  assert.equal(env.text("main"), "15h 06m left");
  env.previewText = DELETED;
  save.disabled = true;
  await env.clock.advance(20 * SEC);
  assert.equal(env.text("main"), "18h 25m left");
});

test("catches a commit that lands after the page already shows the new total", async () => {
  const env = await start();
  pageClick(env);
  setPage(env, calendar("25.28", "5.33"));
  await env.clock.advance(3 * SEC);
  const save = saveButton();
  click(env, save);
  save.disabled = true;
  await env.clock.advance(7 * SEC);
  env.previewText = ADDED;
  await env.clock.advance(30 * SEC);
  assert.equal(env.text("main"), "13h 06m left");
});

test("a dialog Save does not cut short a footer Save that is still running", async () => {
  const env = await start();
  const footer = saveButton();
  click(env, footer);
  await env.clock.advance(2 * SEC);
  const dialog = saveButton();
  click(env, dialog);
  dialog.disabled = true;
  await env.clock.advance(12 * SEC);
  env.previewText = DELETED;
  footer.disabled = true;
  await env.clock.advance(30 * SEC);
  assert.equal(env.text("main"), "18h 25m left");
});

test("leaving right after Save still re-reads the saved timesheet", async () => {
  const env = await start();
  const before = env.frames.length;
  const save = saveButton();
  click(env, save);
  env.previewText = DELETED;
  save.disabled = true;
  await env.clock.advance(500);
  env.previewText = DELETED;
  env.setHash("#/teApp/timesheet/calendar/777777/P");
  await env.clock.advance(40 * SEC);
  const loaded = env.frames.slice(before).map((f) => f.src);
  assert.ok(loaded.some((src) => src.includes("/preview/123456/")), loaded.join(" "));
});

test("rereads if Banner stores the change just after Save finishes", async () => {
  const env = await start();
  const save = saveButton();
  click(env, save);
  save.disabled = true;
  await env.clock.advance(2 * SEC);
  assert.equal(env.text("main"), "15h 06m left");
  env.previewText = DELETED;
  await env.clock.advance(6 * SEC);
  assert.equal(env.text("main"), "18h 25m left");
});

test("a commit after other Banner changes is still caught", async () => {
  const env = await start();
  // Banner changed after the last read, so early reads already differ from it.
  env.previewText = FIXTURE
    .replace("11/21/2026\nREG, Regular Pay\n1\n1.57 Hours", "11/21/2026\nREG, Regular Pay\n1\n1.67 Hours")
    .replace("23.28 Hours In Progress", "23.38 Hours In Progress");
  const save = saveButton();
  click(env, save);
  save.disabled = true;
  await env.clock.advance(20 * SEC);
  env.previewText = ADDED;
  await env.clock.advance(30 * SEC);
  assert.equal(env.text("main"), "13h 06m left");
});

test("clocking out right after the page loads keeps the shift counted", async () => {
  const startMs = SUNDAY - 2 * 60 * MIN;
  const env = boot({
    now: SUNDAY,
    hash: HASH,
    buttonText: "Clock Out",
    previewText: FIXTURE,
    stored: {
      ...H.emptyState(),
      session: { startMs, source: "click", jobId: "123456", observedAt: startMs, confirmedAt: startMs },
    },
  });
  await env.clock.advance(SEC);
  env.userClick();
  env.button.textContent = "Clock In";
  await env.clock.advance(12 * SEC);
  assert.equal(env.state().session, null);
  assert.equal(env.state().closeouts.length, 1);
  assert.equal(env.text("main"), "13h 05m left");
});

test("the previous shift's lagging open row cannot replace a newer shift", () => {
  const first = { startMs: new Date(2026, 10, 22, 17).getTime(), endMs: new Date(2026, 10, 22, 18).getTime(), jobId: "123456" };
  const newer = new Date(2026, 10, 22, 18, 5).getTime();
  const now = new Date(2026, 10, 22, 18, 6).getTime();
  const text = FIXTURE.replace("Summary\nEarn Code", "11/22/2026\nREG, Regular Pay\n1\n05:00 PM\n05:00 PM\nSummary\nEarn Code");
  const state = {
    ...H.emptyState(),
    closeouts: [first],
    session: { startMs: newer, source: "click", jobId: "123456", observedAt: newer, confirmedAt: newer },
  };
  const after = H.applyPreview(state, H.parsePreviewText(text), { jobId: "123456", nowMs: now, buttonState: H.CLOCKED_IN, buttonAtMs: newer });
  assert.equal(after.session.startMs, newer);
  assert.equal(after.closeouts.length, 1);
});

test("an idle page cannot start loads by redrawing the button or route", async () => {
  const env = await start();
  await env.clock.advance(MIN);
  const before = env.frames.length;
  for (let i = 0; i < 20; i++) {
    env.button.textContent = i % 2 ? "Clock In" : "Clock Out";
    await env.clock.advance(4 * SEC);
    env.setHash(i % 2 ? HASH : "#/teApp/timesheet/preview/123456/P", { idle: true });
    await env.clock.advance(56 * SEC);
  }
  assert.equal(env.frames.length, before);
  env.userInput();
  await env.clock.advance(3 * SEC);
  assert.equal(env.frames.length, before + 1, "the owed read runs on the next real input");
});

test("a Save always gets its five capped reads, then the page is quiet", async () => {
  const env = await start();
  const before = env.frames.length;
  const save = saveButton();
  click(env, save);
  save.disabled = true;
  await env.clock.advance(30 * MIN);
  assert.equal(env.frames.length, before + 5);
});

test("a disabled Save button does not end the re-reads before the commit lands", async () => {
  const env = await start();
  const save = saveButton();
  click(env, save);
  save.disabled = true;
  await env.clock.advance(20 * SEC);
  env.previewText = ADDED;
  await env.clock.advance(30 * SEC);
  assert.equal(env.text("main"), "13h 06m left");
});

test("a lagging open row cannot erase a finished shift", async () => {
  const env = await start();
  env.userClick();
  env.button.textContent = "Clock Out";
  await env.clock.advance(60 * MIN);
  env.button.textContent = "Clock In";
  await env.clock.advance(6 * SEC);
  assert.equal(env.text("main"), "14h 05m left");
  env.previewText = FIXTURE.replace(
    "Summary\nEarn Code",
    "11/22/2026\nREG, Regular Pay\n1\n06:00 PM\n06:00 PM\nSummary\nEarn Code"
  );
  env.button.visible = false;
  await env.clock.advance(76 * SEC);
  env.setHash("#/teApp/timesheet/preview/123456/P");
  await env.clock.advance(4 * SEC);
  env.button.visible = true;
  env.setHash(HASH);
  await env.clock.advance(12 * SEC);
  assert.equal(env.state().closeouts.length, 1);
  assert.equal(env.text("main"), "14h 05m left");
});

test("two unposted shifts stay counted when only one is listed", () => {
  const first = { startMs: new Date(2026, 10, 22, 12).getTime(), endMs: new Date(2026, 10, 22, 12, 36).getTime(), jobId: "123456" };
  const second = { startMs: new Date(2026, 10, 22, 12, 40).getTime(), endMs: new Date(2026, 10, 22, 12, 46).getTime(), jobId: "123456" };
  const text = [
    "Pay Period: 11/16/2026 - 11/30/2026 0.10 Hours In Progress",
    "Time Entry Detail", "Date", "Earn Code", "Shift", "Total",
    "11/22/2026", "REG, Regular Pay", "1", "0.10 Hours",
    "Time Information", "Date", "Earn Code", "Shift", "Hours/Units", "Time In", "System In", "Comment In", "Time Out", "System Out", "Comment Out",
    "11/22/2026", "REG, Regular Pay", "1", "0.10", "12:40 PM", "12:40 PM", "12:46 PM", "12:46 PM",
    "Summary", "Earn Code", "Shift", "Week 1", "Total", "Routing and Status",
  ].join("\n");
  const now = new Date(2026, 10, 22, 12, 47).getTime();
  const state = { ...H.emptyState(), closeouts: [first, second] };
  const after = H.applyPreview(state, H.parsePreviewText(text), { jobId: "123456", nowMs: now });
  assert.deepEqual(after.closeouts.map((c) => c.startMs), [first.startMs]);
  assert.ok(Math.abs(H.computeStatus(after, now).usedHours - 0.7) < 0.001);
});

test("a missing row does not end a running shift on a page with no clock button", async () => {
  const start17 = new Date(2026, 10, 22, 17).getTime();
  const env = boot({
    now: SUNDAY,
    hash: "#/teApp/timesheet/preview/123456/P",
    buttonText: null,
    previewText: FIXTURE,
    stored: {
      ...H.emptyState(),
      session: { startMs: start17, source: "server", jobId: "123456", observedAt: start17, confirmedAt: SUNDAY },
    },
  });
  await env.clock.advance(5 * SEC);
  assert.equal(env.state().session.startMs, start17);
  assert.match(env.text("main"), /^14:05:\d{2} left$/);
});

test("a Save that never finishes stops waiting and does not loop", async () => {
  const env = await start();
  const before = env.frames.length;
  click(env, saveButton());
  await env.clock.advance(30 * MIN);
  assert.equal(env.frames.length, before + 5);
});

test("a page total changing with no recent user action loads nothing", async () => {
  const env = await start();
  const before = env.frames.length;
  await env.clock.advance(6 * 60 * MIN);
  setPage(env, calendar("23.29", "3.33"));
  await env.clock.advance(5 * SEC);
  assert.equal(env.frames.length, before);
  pageClick(env);
  await env.clock.advance(31 * SEC);
  setPage(env, calendar("23.30", "3.33"));
  await env.clock.advance(5 * SEC);
  assert.equal(env.frames.length, before, "that click was too long ago");
});

test("an older read from another tab cannot overwrite a newer one", () => {
  const newerAt = SUNDAY + 10 * SEC;
  const parse = (text) => H.parsePreviewText(text);
  const newer = H.applyPreview(H.emptyState(), parse(ADDED), { jobId: "123456", nowMs: newerAt, snapshotAt: newerAt });
  const after = H.applyPreview(newer, parse(FIXTURE), { jobId: "123456", nowMs: newerAt + SEC, snapshotAt: SUNDAY });
  assert.equal(H.computeStatus(after, newerAt + SEC).recordedHours, 6.9);
});

test("a scripted click on Save is ignored", async () => {
  const env = await start();
  const before = env.frames.length;
  const save = saveButton();
  click(env, save, false);
  save.disabled = true;
  await env.clock.advance(MIN);
  assert.equal(env.frames.length, before);
});

test("selecting another day does not reload hours", async () => {
  const env = await start();
  const before = env.frames.length;
  pageClick(env);
  setPage(env, calendar("23.28", "1.57"));
  await env.clock.advance(5 * SEC);
  pageClick(env);
  setPage(env, calendar("23.28", null));
  await env.clock.advance(5 * SEC);
  assert.equal(env.frames.length, before);
});

test("a Save never makes a just-finished shift disappear", async () => {
  const env = await start();
  env.userClick();
  env.button.textContent = "Clock Out";
  await env.clock.advance(60 * MIN);
  env.button.textContent = "Clock In";
  await env.clock.advance(6 * SEC);
  assert.equal(env.text("main"), "14h 05m left");
  const save = saveButton();
  click(env, save);
  save.disabled = true;
  await env.clock.advance(40 * SEC);
  assert.equal(env.state().closeouts.length, 1);
  assert.equal(env.text("main"), "14h 05m left", "unclear data shows less time, never more");

  // Once the 15-minute wait is over, the next read trusts Banner.
  await env.clock.advance(16 * MIN);
  env.setHash("#/teApp/timesheet/preview/123456/P");
  await env.clock.advance(6 * SEC);
  assert.equal(env.text("main"), "15h 06m left");
});

test("hours saved on another day do not stand in for an unposted shift", async () => {
  const env = await start();
  env.userClick();
  env.button.textContent = "Clock Out";
  await env.clock.advance(60 * MIN);
  env.button.textContent = "Clock In";
  await env.clock.advance(6 * SEC);
  const save = saveButton();
  click(env, save);
  env.previewText = FIXTURE
    .replace("11/21/2026\nREG, Regular Pay\n1\n1.57 Hours", "11/21/2026\nREG, Regular Pay\n1\n3.57 Hours")
    .replace("23.28 Hours In Progress", "25.28 Hours In Progress");
  save.disabled = true;
  await env.clock.advance(40 * SEC);
  assert.equal(env.state().closeouts.length, 1);
  assert.equal(env.text("main"), "12h 05m left");
});

test("clocking out keeps the shift counted when no Save happened", async () => {
  const env = await start();
  env.userClick();
  env.button.textContent = "Clock Out";
  await env.clock.advance(60 * MIN);
  env.button.textContent = "Clock In";
  await env.clock.advance(10 * SEC);
  assert.equal(env.state().closeouts.length, 1);
  assert.equal(env.text("main"), "14h 05m left");
});

test("the extension never operates Banner's Save button", async () => {
  const env = await start();
  const calls = [];
  const save = saveButton();
  for (const method of ["click", "focus", "blur", "dispatchEvent", "submit"]) {
    save[method] = () => calls.push(method);
  }
  click(env, save);
  save.disabled = true;
  await env.clock.advance(MIN);
  assert.deepEqual(calls, []);
});
