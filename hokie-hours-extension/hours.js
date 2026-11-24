/*
 * Pure logic for the weekly hours widget. Nothing here touches the DOM,
 * the network, or extension APIs, so it runs unchanged in Node tests.
 *
 * remaining = limit - recorded hours in this Sat-Fri week
 *                  - live time of the open clock-in inside this week
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.VTHours = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const WEEKLY_LIMIT_HOURS = 20;

  const STORAGE_KEY = "weeklyHoursState.v1";
  const MS_PER_SECOND = 1000;
  const MS_PER_MINUTE = 60 * MS_PER_SECOND;
  const MS_PER_HOUR = 60 * MS_PER_MINUTE;
  const MS_PER_CENTI_HOUR = 36 * MS_PER_SECOND;
  const WARN_AT_MS = MS_PER_HOUR;
  const PENDING_CLICK_WINDOW_MS = 2 * MS_PER_MINUTE;
  const PUNCH_MATCH_MS = 2 * MS_PER_MINUTE;
  const CLOSEOUT_GRACE_MS = 15 * MS_PER_MINUTE;
  const CLOSEOUT_LAG_MS = MS_PER_MINUTE;
  const REDRAW_WINDOW_MS = 2 * MS_PER_MINUTE;
  const ARIA_STEP_MS = 15 * MS_PER_MINUTE;
  const MAX_UNCONFIRMED_OPEN_MS = 24 * MS_PER_HOUR;
  const TOTAL_TOLERANCE_CENTI = 5;
  const RETENTION_DAYS = 45;

  const CLOCKED_IN = "clocked-in";
  const CLOCKED_OUT = "clocked-out";
  const UNKNOWN = "unknown";

  /* ---------- Local calendar dates (never parsed through UTC) ---------- */

  const pad2 = (n) => String(n).padStart(2, "0");

  function makeDateKey(year, month, day) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
    if (year < 2000 || year > 2100) return null;
    const probe = new Date(year, month - 1, day, 12);
    if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
      return null;
    }
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  function parseDateKey(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    return makeDateKey(year, month, day) ? { year, month, day } : null;
  }

  function dateKeyFromUs(text) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(text).trim());
    return m ? makeDateKey(Number(m[3]), Number(m[1]), Number(m[2])) : null;
  }

  function dateKeyFromMs(ms) {
    const d = new Date(ms);
    return makeDateKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  function addDays(key, days) {
    const p = parseDateKey(key);
    const d = new Date(p.year, p.month - 1, p.day + days, 12);
    return makeDateKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  function startOfDayMs(key) {
    const p = parseDateKey(key);
    return new Date(p.year, p.month - 1, p.day, 0, 0, 0, 0).getTime();
  }

  function localMs(key, minutesIntoDay) {
    const p = parseDateKey(key);
    return new Date(
      p.year,
      p.month - 1,
      p.day,
      Math.floor(minutesIntoDay / 60),
      minutesIntoDay % 60
    ).getTime();
  }

  /** The Saturday-through-Friday week that contains a date key. */
  function weekForDateKey(key) {
    const p = parseDateKey(key);
    const dayOfWeek = new Date(p.year, p.month - 1, p.day, 12).getDay();
    const startKey = addDays(key, -((dayOfWeek + 1) % 7));
    const keys = [];
    for (let i = 0; i < 7; i++) keys.push(addDays(startKey, i));
    const nextStartKey = addDays(startKey, 7);
    return {
      startKey,
      endKey: keys[6],
      nextStartKey,
      keys,
      startMs: startOfDayMs(startKey),
      endMs: startOfDayMs(nextStartKey),
    };
  }

  const weekForMs = (ms) => weekForDateKey(dateKeyFromMs(ms));

  const overlapMs = (aStart, aEnd, bStart, bEnd) =>
    Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

  const toCenti = (hours) => Math.round(Number(hours) * 100);

  /* ---------- Routes ---------- */

  function parseTimesheetRoute(hash) {
    const m = /\/teApp\/timesheet\/[A-Za-z-]+\/(\d{1,12})(?:\/([A-Za-z]{1,3}))?(?:[/?]|$)/.exec(
      String(hash || "")
    );
    return m ? { jobId: m[1], suffix: m[2] || "P" } : null;
  }

  function previewUrl(origin, jobId, suffix) {
    if (!/^\d{1,12}$/.test(String(jobId))) return null;
    const safeSuffix = /^[A-Za-z]{1,3}$/.test(String(suffix)) ? suffix : "P";
    return `${origin}/EmployeeSelfService/ssb/timeEntry#/teApp/timesheet/preview/${jobId}/${safeSuffix}`;
  }

  const isWidgetPath = (pathname) =>
    /^\/EmployeeSelfService\/ssb\/(?:timeEntry|hrDashboard)(?:\/|$)/.test(String(pathname || ""));

  /** "Clock In" on the button means the user is currently clocked out. */
  function classifyButtonText(text) {
    const t = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (t === "clock in") return CLOCKED_OUT;
    // The clocked-in label is unobserved and may carry a time after the words.
    if (/^clock out\b/.test(t)) return CLOCKED_IN;
    return UNKNOWN;
  }

  /* ---------- Preview text parsing ---------- */

  const PAY_PERIOD =
    /Pay Period:?\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:-|–|to)\s*(\d{1,2}\/\d{1,2}\/\d{4})(?:\s+([\d,]+(?:\.\d+)?)\s*Hours?\b)?/i;
  const VISIBLE_PERIOD_TOTAL =
    /\d{1,2}\/\d{1,2}\/\d{4}\s*(?:-|–|to)\s*\d{1,2}\/\d{1,2}\/\d{4}\s*([\d,]+(?:\.\d+)?)\s*Hours?\b/i;
  const EARN_CELL = /^[A-Z0-9]{1,8}\s*,\s*\S/i;
  const HOURS_CELL = /^(\d+(?:\.\d+)?)\s*Hours?$/i;
  const NUMBER_CELL = /^\d+(?:\.\d+)?$/;
  const TIME_RUN = /^(?:\d{1,2}:\d{2}\s*[AP]\.?M\.?\s*)+$/i;
  const TIME_TOKEN = /\d{1,2}:\d{2}\s*[AP]\.?M\.?/gi;

  function splitCells(text) {
    return String(text == null ? "" : text)
      .replace(/ /g, " ")
      .split(/[\r\n\t]+/)
      .map((cell) => cell.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  function parseClockMinutes(text) {
    const m = /^(\d{1,2}):(\d{2})\s*([AP])\.?M\.?$/i.exec(String(text).trim());
    if (!m) return null;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    return (hour % 12) * 60 + minute + (m[3].toUpperCase() === "P" ? 720 : 0);
  }

  function findHeading(cells, heading, nextCell, from) {
    for (let i = Math.max(0, from); i < cells.length; i++) {
      if (cells[i].toLowerCase() === heading && nextCell.test(cells[i + 1] || "")) return i;
    }
    return -1;
  }

  function rowStarts(cells, from, to) {
    const starts = [];
    for (let i = from; i < to; i++) {
      if (dateKeyFromUs(cells[i]) && EARN_CELL.test(cells[i + 1] || "")) starts.push(i);
    }
    return starts;
  }

  function parsePunchRow(row, dateKey) {
    let i = 2;
    if (/^\d+$/.test(row[i] || "")) i++;
    let hours = null;
    if (NUMBER_CELL.test(row[i] || "")) {
      hours = Number(row[i]);
      i++;
    }
    // A time counts only when the whole cell is a time, so a comment such as
    // "left at 2:00 PM" can never be mistaken for a punch time.
    const tokens = [];
    for (let j = i; j < row.length; j++) {
      if (TIME_RUN.test(row[j])) tokens.push(...row[j].match(TIME_TOKEN));
    }
    const minutes = tokens.map(parseClockMinutes);
    const base = { dateKey, hours, state: "ambiguous", inMs: null, outMs: null };
    if (minutes.some((m) => m === null)) return base;

    const closed = (inMinutes, outMinutes) => {
      const outKey = outMinutes < inMinutes ? addDays(dateKey, 1) : dateKey;
      return {
        ...base,
        state: "closed",
        inMs: localMs(dateKey, inMinutes),
        outMs: localMs(outKey, outMinutes),
      };
    };

    if (tokens.length === 4) return closed(minutes[0], minutes[2]);
    if (tokens.length === 2) {
      // Two times normally mean Time In + System In on an open punch. If they
      // differ by exactly the row's hours they are an In/Out pair instead.
      const diff = (minutes[1] - minutes[0] + 1440) % 1440;
      if (hours > 0 && diff > 0 && Math.abs(diff / 60 - hours) <= 0.006) {
        return closed(minutes[0], minutes[1]);
      }
      return { ...base, state: "open", inMs: localMs(dateKey, minutes[0]) };
    }
    return base;
  }

  /** Daily totals in hundredths with partial hours of live open punches removed. */
  function withoutLivePartials(totals, punches, livePunches) {
    const centiOf = (rows) => rows.reduce((sum, p) => sum + toCenti(p.hours || 0), 0);
    const recorded = { ...totals };
    for (const key of new Set(livePunches.map((p) => p.dateKey))) {
      if (!(key in recorded)) continue;
      const partial = centiOf(livePunches.filter((p) => p.dateKey === key));
      const closedSum = centiOf(punches.filter((p) => p.dateKey === key && p.state === "closed"));
      recorded[key] = Math.max(closedSum, recorded[key] - partial, 0);
    }
    return recorded;
  }

  function centiToHours(map) {
    const out = {};
    for (const key of Object.keys(map).sort()) if (map[key] > 0) out[key] = map[key] / 100;
    return out;
  }

  const firstFound = (values, fallback) => {
    for (const v of values) if (v >= 0) return v;
    return fallback;
  };

  /**
   * Parses the Timesheet Preview text. Returns { ok: false, reason } rather
   * than a partial result, so a half-rendered page can never replace saved data.
   * punchesListed is false when the Time Information section is absent, so the
   * missing rows are never read as proof that a punch ended.
   */
  function parsePreviewText(text) {
    const fail = (reason) => ({ ok: false, reason });
    const cells = splitCells(text);
    if (!cells.length) return fail("empty");

    const header = PAY_PERIOD.exec(cells.join(" "));
    if (!header) return fail("no-pay-period");
    const startKey = dateKeyFromUs(header[1]);
    const endKey = dateKeyFromUs(header[2]);
    if (!startKey || !endKey || startKey > endKey) return fail("bad-pay-period");
    const periodTotal = header[3] !== undefined ? Number(header[3].replace(/,/g, "")) : null;

    const entryAt = findHeading(cells, "time entry detail", /^date$/i, 0);
    const infoAt = findHeading(cells, "time information", /^date$/i, entryAt + 1);
    const lastHeading = Math.max(entryAt, infoAt);
    const summaryAt = findHeading(cells, "summary", /^earn code$/i, lastHeading + 1);
    const routingAt = cells.findIndex(
      (cell, i) => i > lastHeading && cell.toLowerCase() === "routing and status"
    );

    if (entryAt < 0 && periodTotal !== 0) return fail("no-entry-section");

    const totals = {};
    if (entryAt >= 0) {
      const end = firstFound([infoAt, summaryAt, routingAt], cells.length);
      const starts = rowStarts(cells, entryAt + 1, end);
      starts.forEach((start, n) => {
        const key = dateKeyFromUs(cells[start]);
        if (key < startKey || key > endKey) return;
        const stop = n + 1 < starts.length ? starts[n + 1] : end;
        for (let j = start + 2; j < stop; j++) {
          const withUnit = HOURS_CELL.exec(cells[j]);
          if (withUnit) {
            totals[key] = (totals[key] || 0) + toCenti(withUnit[1]);
          } else if (NUMBER_CELL.test(cells[j]) && /^Hours?$/i.test(cells[j + 1] || "")) {
            totals[key] = (totals[key] || 0) + toCenti(cells[j]);
            j++;
          }
        }
      });
    }

    const punches = [];
    if (infoAt >= 0) {
      const end = firstFound([summaryAt, routingAt], cells.length);
      const starts = rowStarts(cells, infoAt + 1, end);
      starts.forEach((start, n) => {
        const key = dateKeyFromUs(cells[start]);
        if (key < startKey || key > endKey) return;
        const stop = n + 1 < starts.length ? starts[n + 1] : end;
        punches.push(parsePunchRow(cells.slice(start, stop), key));
      });
    }

    // Banner may already include part of an open punch in its daily total.
    // Remove it here, because live time is added separately.
    const openPunches = punches.filter((p) => p.state === "open");
    const recorded = withoutLivePartials(totals, punches, openPunches);
    const partialCenti = openPunches.reduce((sum, p) => sum + toCenti(p.hours || 0), 0);

    const sum = Object.values(totals).reduce((a, b) => a + b, 0);
    const isEmpty = Object.keys(totals).length === 0;
    if (periodTotal === null) {
      if (isEmpty) return fail("no-entries");
    } else {
      const target = toCenti(periodTotal);
      const agrees = [sum, sum - partialCenti, sum + partialCenti].some(
        (candidate) => Math.abs(candidate - target) <= TOTAL_TOLERANCE_CENTI
      );
      if (!agrees) return fail("total-mismatch");
    }

    return {
      ok: true,
      period: { startKey, endKey },
      periodTotal,
      dateTotals: centiToHours(totals),
      recordedByDate: centiToHours(recorded),
      punches,
      punchesListed: infoAt >= 0,
      isEmpty,
    };
  }

  const previewSignature = (parsed) =>
    JSON.stringify([
      parsed.period,
      parsed.periodTotal,
      parsed.dateTotals,
      parsed.punches,
      parsed.punchesListed,
    ]);

  /** The total shown on the current page, used only to notice that it changed. */
  function extractVisibleTotal(text) {
    const joined = splitCells(text).join(" ");
    // The calendar prints the range and total with no space: 11/30/202623.30 Hours.
    const header = VISIBLE_PERIOD_TOTAL.exec(joined);
    if (header) return header[1];
    const total = /\bTotal(?: Hours)?\s*:?\s*(\d+\.\d{2})\b/i.exec(joined);
    return total ? total[1] : null;
  }

  /* ---------- Stored state ---------- */

  const emptyState = () => ({
    version: 1,
    lastJobId: null,
    lastSuffix: "P",
    periods: {},
    session: null,
    pendingClick: null,
    closeouts: [],
    endedSession: null,
    clockEventAt: 0,
  });

  const isJobId = (v) => typeof v === "string" && /^\d{1,12}$/.test(v);
  const isMs = (v) => typeof v === "number" && Number.isFinite(v);

  function parseStoredSession(s) {
    if (!s || typeof s !== "object" || !["server", "click", "unknown"].includes(s.source)) return null;
    const startMs = s.source !== "unknown" && isMs(s.startMs) ? s.startMs : null;
    if (s.source !== "unknown" && startMs === null) return null;
    const observedAt = isMs(s.observedAt) ? s.observedAt : 0;
    const session = {
      startMs,
      source: s.source,
      jobId: isJobId(s.jobId) ? s.jobId : null,
      observedAt,
      confirmedAt: isMs(s.confirmedAt) ? s.confirmedAt : observedAt,
    };
    if (isMs(s.conflictAt)) session.conflictAt = s.conflictAt;
    return session;
  }

  function parseStoredCloseout(c) {
    if (!c || !isMs(c.startMs) || !isMs(c.endMs) || c.endMs < c.startMs) return null;
    return {
      startMs: c.startMs,
      endMs: c.endMs,
      jobId: isJobId(c.jobId) ? c.jobId : null,
    };
  }

  function normalizeState(raw) {
    const state = emptyState();
    if (!raw || typeof raw !== "object" || raw.version !== 1) return state;
    if (isJobId(raw.lastJobId)) state.lastJobId = raw.lastJobId;
    if (typeof raw.lastSuffix === "string" && /^[A-Za-z]{1,3}$/.test(raw.lastSuffix)) {
      state.lastSuffix = raw.lastSuffix;
    }
    for (const [id, period] of Object.entries(raw.periods || {})) {
      if (!period || !isJobId(period.jobId)) continue;
      if (!parseDateKey(period.startKey) || !parseDateKey(period.endKey)) continue;
      const byDate = {};
      for (const [key, hours] of Object.entries(period.byDate || {})) {
        if (parseDateKey(key) && typeof hours === "number" && hours >= 0) byDate[key] = hours;
      }
      state.periods[id] = {
        jobId: period.jobId,
        startKey: period.startKey,
        endKey: period.endKey,
        byDate,
        readAt: isMs(period.readAt) ? period.readAt : 0,
      };
    }
    state.session = parseStoredSession(raw.session);
    const p = raw.pendingClick;
    if (p && isMs(p.atMs)) {
      state.pendingClick = { atMs: p.atMs, jobId: isJobId(p.jobId) ? p.jobId : null };
    }
    // Earlier versions stored a single "closeout".
    state.closeouts = [...(Array.isArray(raw.closeouts) ? raw.closeouts : []), raw.closeout]
      .map(parseStoredCloseout)
      .filter(Boolean);
    const ended = parseStoredSession(raw.endedSession);
    if (ended && isMs(raw.endedSession.endedAt)) {
      state.endedSession = { ...ended, endedAt: raw.endedSession.endedAt };
    }
    if (isMs(raw.clockEventAt)) state.clockEventAt = raw.clockEventAt;
    return state;
  }

  const cloneState = (state) => JSON.parse(JSON.stringify(state));

  /** Per-date hours summed across jobs and periods, in hundredths of an hour. */
  function centiByDate(state) {
    const merged = {};
    for (const period of Object.values(state.periods)) {
      for (const [key, hours] of Object.entries(period.byDate)) {
        merged[key] = (merged[key] || 0) + toCenti(hours);
      }
    }
    return merged;
  }

  function recordedMsForKeys(state, keys) {
    const merged = centiByDate(state);
    return keys.reduce((sum, key) => sum + (merged[key] || 0), 0) * MS_PER_CENTI_HOUR;
  }

  /**
   * A past date counts as seen only if a period covering it was read on a later
   * day, because work later that day cannot appear in an earlier read.
   */
  function isDateSeen(key, periods, todayKey) {
    return periods.some((p) => {
      if (key < p.startKey || key > p.endKey) return false;
      if (key === todayKey) return true;
      const readKey = p.readAt > 0 ? dateKeyFromMs(p.readAt) : null;
      return readKey !== null && readKey > key;
    });
  }

  /* ---------- Clock session ---------- */

  /** Stored when the user clicks a button reading "Clock In". */
  function recordClockClick(state, atMs, jobId) {
    const next = cloneState(state);
    next.pendingClick = { atMs, jobId: isJobId(jobId) ? jobId : null };
    return next;
  }

  /** Banner times are whole minutes, and the fall-back hour repeats them. */
  function nearestRepeat(ms, targetMs) {
    const later = ms + MS_PER_HOUR;
    const a = new Date(ms);
    const b = new Date(later);
    const repeats = a.getHours() === b.getHours() && a.getMinutes() === b.getMinutes();
    return repeats && Math.abs(later - targetMs) < Math.abs(ms - targetMs) ? later : ms;
  }

  const nearPunch = (punchMs, ms) => Math.abs(nearestRepeat(punchMs, ms) - ms) <= PUNCH_MATCH_MS;

  /** True when a closed row is this session, not a short punch just before it. */
  function punchClosesStart(p, startMs) {
    if (p.state !== "closed" || !isMs(p.inMs) || !isMs(p.outMs)) return false;
    const inMs = nearestRepeat(p.inMs, startMs);
    if (Math.abs(inMs - startMs) > PUNCH_MATCH_MS) return false;
    const outMs = p.outMs + (inMs - p.inMs);
    return outMs >= startMs || inMs >= startMs - (startMs % MS_PER_MINUTE);
  }

  const punchMatchesCloseout = (p, c) =>
    p.state === "closed" &&
    isMs(p.inMs) &&
    isMs(p.outMs) &&
    nearPunch(p.inMs, c.startMs) &&
    nearPunch(p.outMs, c.endMs);

  function periodContainsMs(period, ms) {
    const key = dateKeyFromMs(ms);
    return key >= period.startKey && key <= period.endKey;
  }

  function isPastConfirmWindow(session, nowMs) {
    const lastSeen = Math.max(
      isMs(session.confirmedAt) ? session.confirmedAt : 0,
      isMs(session.observedAt) ? session.observedAt : 0,
      isMs(session.startMs) ? session.startMs : 0
    );
    return nowMs - lastSeen > MAX_UNCONFIRMED_OPEN_MS;
  }

  /** A session nothing has vouched for recently must not drain the total. */
  const isUnverified = (session, nowMs) =>
    isMs(session.conflictAt) || isPastConfirmWindow(session, nowMs);

  function dropPastCloseouts(closeouts, nowMs) {
    const weekStart = weekForMs(nowMs).startMs;
    return closeouts.filter((c) => c.endMs > weekStart);
  }

  function closeoutMsInWeek(closeouts, week) {
    return closeouts.reduce(
      (sum, c) => sum + overlapMs(c.startMs, c.endMs, week.startMs, week.endMs),
      0
    );
  }

  /** A visible Clock Out vouches for the saved session. */
  function confirmSession(state, nowMs) {
    if (!state.session) return state;
    const next = cloneState(state);
    next.session.confirmedAt = nowMs;
    delete next.session.conflictAt;
    return next;
  }

  /**
   * Applies a settled button reading. observedClockOut is true only when this
   * page saw this job's button go from Clock Out to Clock In, so a stale session
   * found on load is cleared without inventing an end time for it. A reading
   * first seen before the latest clock event is out of date and changes nothing.
   */
  function applyButtonState(state, buttonState, ctx) {
    if (buttonState !== CLOCKED_IN && buttonState !== CLOCKED_OUT) return state;
    const { nowMs, jobId = null, changedAtMs = nowMs, observedClockOut = false } = ctx;
    const next = cloneState(state);
    const pending = next.pendingClick;
    const pendingIsFresh =
      pending && pending.atMs <= nowMs && nowMs - pending.atMs <= PENDING_CLICK_WINDOW_MS;
    const s = next.session;

    const lastEventAt = Math.max(next.clockEventAt, s ? s.observedAt : 0);
    const drawnAfterStart =
      buttonState === CLOCKED_OUT && s && isMs(s.startMs) && s.startMs + MS_PER_MINUTE <= changedAtMs;
    if (changedAtMs < lastEventAt && !(buttonState === CLOCKED_IN && pendingIsFresh) && !drawnAfterStart) {
      return state;
    }

    if (buttonState === CLOCKED_OUT) {
      if (s) {
        const otherJob = s.jobId && jobId && s.jobId !== jobId;
        if (otherJob && !observedClockOut && !isPastConfirmWindow(s, nowMs)) {
          // Job ids change per period, so this may be the same shift or a dead
          // one. Stop counting it, but keep it in case its own page confirms it.
          // Once nothing has confirmed it for a day, this reading ends it.
          if (!isMs(s.conflictAt)) s.conflictAt = nowMs;
        } else {
          if (observedClockOut && isMs(s.startMs) && changedAtMs >= s.startMs) {
            const closeout = { startMs: s.startMs, endMs: changedAtMs, jobId: s.jobId };
            next.closeouts = dropPastCloseouts([...next.closeouts, closeout], nowMs);
          }
          // Kept briefly so a temporary redraw of the button can be undone.
          next.endedSession = { ...s, endedAt: changedAtMs };
          next.session = null;
          next.clockEventAt = Math.max(next.clockEventAt, changedAtMs);
        }
      }
      if (pending && !pendingIsFresh) next.pendingClick = null;
      return next;
    }

    const ended = next.endedSession;
    if (pendingIsFresh && (!s || !isMs(s.startMs) || pending.atMs > s.startMs + PUNCH_MATCH_MS)) {
      // Clicking Clock In proves any older saved session was already over.
      next.session = {
        startMs: pending.atMs,
        source: "click",
        jobId: pending.jobId || jobId,
        observedAt: nowMs,
        confirmedAt: nowMs,
      };
      next.clockEventAt = Math.max(next.clockEventAt, changedAtMs);
    } else if (!s && ended && nowMs - ended.endedAt <= REDRAW_WINDOW_MS) {
      const { endedAt: _endedAt, conflictAt: _conflictAt, ...restored } = ended;
      next.session = { ...restored, confirmedAt: nowMs };
      next.closeouts = next.closeouts.filter((c) => c.startMs !== ended.startMs);
      next.clockEventAt = Math.max(next.clockEventAt, changedAtMs);
    } else if (!s) {
      next.session = { startMs: null, source: "unknown", jobId, observedAt: nowMs, confirmedAt: nowMs };
      next.clockEventAt = Math.max(next.clockEventAt, changedAtMs);
    } else {
      s.confirmedAt = nowMs;
      delete s.conflictAt;
    }
    next.pendingClick = null;
    next.endedSession = null;
    return next;
  }

  /** Decides whether an open row is a running shift that should count as live. */
  function isLiveOpenPunch(p, closeouts, ctx) {
    const { nowMs, buttonState, buttonAtMs, snapshotAt, ended, session } = ctx;
    if (p.state !== "open" || !isMs(p.inMs) || p.inMs > nowMs + MS_PER_MINUTE) return false;
    // A newer shift is running, so this row is the previous shift catching up.
    if (
      session &&
      isMs(session.startMs) &&
      closeouts.some((c) => nearPunch(p.inMs, c.startMs) && session.startMs >= c.endMs)
    ) {
      return false;
    }
    if (buttonState === CLOCKED_IN) return true;
    // The open-punch format is unconfirmed, so a very old "open" row needs the
    // button to agree before it can drain the weekly total.
    if (nowMs - p.inMs > MAX_UNCONFIRMED_OPEN_MS) return false;
    // Banner can keep listing a punch as open after a clock-out seen here.
    const justClosed = closeouts.some(
      (c) =>
        nearPunch(p.inMs, c.startMs) &&
        (buttonState === CLOCKED_OUT || nowMs - c.endMs < CLOSEOUT_GRACE_MS)
    );
    if (justClosed) return false;
    // A button drawn after this punch began and reading Clock In is newer than
    // the row, so the shift is not running. An older reading proves nothing.
    if (buttonState === CLOCKED_OUT && p.inMs + MS_PER_MINUTE <= buttonAtMs) return false;
    if (ended && buttonState === CLOCKED_OUT && snapshotAt - ended.endedAt < CLOSEOUT_LAG_MS) return false;
    return true;
  }

  function reconcileSession(session, open, parsed, ctx) {
    const { jobId, nowMs, buttonState, buttonAtMs } = ctx;
    if (open) {
      const inMs = session && isMs(session.startMs) ? nearestRepeat(open.inMs, session.startMs) : open.inMs;
      return {
        startMs: Math.min(inMs, nowMs),
        source: "server",
        jobId,
        observedAt: session ? session.observedAt : nowMs,
        confirmedAt: nowMs,
      };
    }
    if (!session) return null;

    const sameJob = !session.jobId || session.jobId === jobId;
    const drawnAfterStart = isMs(session.startMs) && session.startMs + MS_PER_MINUTE <= buttonAtMs;
    if (buttonState === CLOCKED_OUT && (session.observedAt <= buttonAtMs || drawnAfterStart)) {
      if (sameJob) return null;
      return isMs(session.conflictAt) ? session : { ...session, conflictAt: nowMs };
    }
    if (isMs(session.startMs) && parsed.punches.some((p) => punchClosesStart(p, session.startMs))) {
      return null;
    }
    // A missing row is not proof that a running shift ended. Only a closed row
    // or a readable Clock In ends it.
    return session;
  }

  /**
   * A finished shift keeps counting until Banner lists that exact shift. Keeping
   * it when Banner is unclear can only show less time left, never more.
   */
  function settleCloseouts(closeouts, open, parsed, ctx) {
    return closeouts.filter((c) => {
      // The button confirms this shift is running again, so live time counts it.
      if (open && ctx.buttonState === CLOCKED_IN && nearPunch(open.inMs, c.startMs)) return false;
      if (parsed.punches.some((p) => punchMatchesCloseout(p, c))) return false;
      if (c.jobId && c.jobId !== ctx.jobId) return true;
      if (!periodContainsMs(parsed.period, c.startMs)) return true;
      return ctx.nowMs - c.endMs < CLOSEOUT_GRACE_MS;
    });
  }

  /**
   * Saves a parsed Preview. The job + period entry is replaced whole, so
   * entries deleted in Banner disappear here too. A snapshot whose load began
   * before the latest clock event updates hours but cannot change the session.
   */
  function applyPreview(state, parsed, ctx) {
    if (!parsed || !parsed.ok || !isJobId(ctx.jobId)) return state;
    const {
      jobId,
      suffix = "P",
      nowMs,
      buttonState = UNKNOWN,
      buttonAtMs = nowMs,
      snapshotAt = nowMs,
    } = ctx;
    const next = cloneState(state);
    const { startKey, endKey } = parsed.period;
    const id = `${jobId}|${startKey}|${endKey}`;
    // Another tab already stored a newer read of this timesheet.
    if (next.periods[id] && next.periods[id].readAt > snapshotAt) return state;
    const outdated = next.clockEventAt > snapshotAt;
    const readCtx = {
      jobId,
      nowMs,
      buttonState,
      buttonAtMs,
      snapshotAt,
      ended: next.endedSession,
      session: next.session,
    };

    const open = outdated
      ? null
      : parsed.punches
          .filter((p) => isLiveOpenPunch(p, next.closeouts, readCtx))
          .sort((a, b) => b.inMs - a.inMs)[0] || null;

    // Partial hours come off only for a punch counted some other way. A rejected
    // open row keeps its hours, so they are never lost.
    const countedElsewhere = parsed.punches.filter(
      (p) =>
        p.state === "open" &&
        (outdated ||
          p === open ||
          (isMs(p.inMs) &&
            next.closeouts.some(
              (c) => nowMs - c.endMs < CLOSEOUT_GRACE_MS && nearPunch(p.inMs, c.startMs)
            )))
    );
    const totals = {};
    for (const [key, hours] of Object.entries(parsed.dateTotals)) totals[key] = toCenti(hours);
    const byDate = centiToHours(withoutLivePartials(totals, parsed.punches, countedElsewhere));

    for (const [otherId, other] of Object.entries(next.periods)) {
      if (otherId === id || other.jobId !== jobId) continue;
      for (const key of Object.keys(other.byDate)) {
        if (key >= startKey && key <= endKey) delete other.byDate[key];
      }
    }
    next.periods[id] = { jobId, startKey, endKey, byDate, readAt: snapshotAt };

    const todayKey = dateKeyFromMs(nowMs);
    if (!next.lastJobId || (todayKey >= startKey && todayKey <= endKey)) {
      next.lastJobId = jobId;
      next.lastSuffix = suffix;
    }

    if (!outdated) {
      const before = next.session;
      next.session = reconcileSession(before, open, parsed, readCtx);
      if (Boolean(before) !== Boolean(next.session)) {
        next.clockEventAt = Math.max(next.clockEventAt, nowMs);
      }
      next.closeouts = settleCloseouts(next.closeouts, open, parsed, readCtx);
      const ended = next.endedSession;
      if (
        next.session ||
        (ended && isMs(ended.startMs) && parsed.punches.some((p) => punchClosesStart(p, ended.startMs)))
      ) {
        next.endedSession = null;
      }
    }
    next.closeouts = dropPastCloseouts(next.closeouts, nowMs);

    const cutoff = addDays(todayKey, -RETENTION_DAYS);
    for (const [otherId, other] of Object.entries(next.periods)) {
      if (other.endKey < cutoff) delete next.periods[otherId];
    }
    return next;
  }

  /* ---------- Status ---------- */

  function computeStatus(state, nowMs, limitHours = WEEKLY_LIMIT_HOURS) {
    const week = weekForMs(nowMs);
    const todayKey = dateKeyFromMs(nowMs);
    const recordedMs = recordedMsForKeys(state, week.keys);

    const session = state.session;
    const unverified = Boolean(session) && isUnverified(session, nowMs);
    const clockedIn = Boolean(session) && !unverified;
    const live = clockedIn && isMs(session.startMs) && session.startMs <= nowMs;
    const liveMs = live ? overlapMs(session.startMs, nowMs, week.startMs, week.endMs) : 0;
    const closeoutMs = closeoutMsInWeek(state.closeouts || [], week);

    const usedMs = recordedMs + liveMs + closeoutMs;
    const limitMs = limitHours * MS_PER_HOUR;
    const remainingMs = limitMs - usedMs;

    const periods = Object.values(state.periods);
    const pastKeys = week.keys.filter((key) => key <= todayKey);
    const missingDates = pastKeys.filter((key) => !isDateSeen(key, periods, todayKey));

    return {
      limitHours,
      weekStartKey: week.startKey,
      weekEndKey: week.endKey,
      todayKey,
      recordedHours: recordedMs / MS_PER_HOUR,
      usedHours: usedMs / MS_PER_HOUR,
      remainingHours: remainingMs / MS_PER_HOUR,
      recordedMs,
      liveMs,
      closeoutMs,
      usedMs,
      remainingMs,
      progress: Math.min(1, Math.max(0, usedMs / limitMs)),
      over: remainingMs < 0,
      level: remainingMs < 0 ? "over" : remainingMs <= WARN_AT_MS ? "warn" : "normal",
      clockedIn,
      live,
      startUnknown: clockedIn && !live,
      unverified,
      hasJob: Boolean(state.lastJobId),
      // A live shift is real data even when the new week has no saved period yet.
      hasWeekData: live || missingDates.length < pastKeys.length,
      todaySeen: isDateSeen(todayKey, periods, todayKey),
      missingDates,
    };
  }

  /* ---------- Display text ---------- */

  function formatHoursMinutes(ms, round = Math.floor) {
    const minutes = round(Math.max(0, ms) / MS_PER_MINUTE);
    return `${Math.floor(minutes / 60)}h ${pad2(minutes % 60)}m`;
  }

  function formatClock(ms, round = Math.floor) {
    const seconds = round(Math.max(0, ms) / MS_PER_SECOND);
    const h = Math.floor(seconds / 3600);
    return `${h}:${pad2(Math.floor(seconds / 60) % 60)}:${pad2(seconds % 60)}`;
  }

  function formatDateRanges(keys) {
    const short = (key) => {
      const p = parseDateKey(key);
      return `${pad2(p.month)}/${pad2(p.day)}`;
    };
    const parts = [];
    let i = 0;
    while (i < keys.length) {
      let j = i;
      while (j + 1 < keys.length && addDays(keys[j], 1) === keys[j + 1]) j++;
      parts.push(i === j ? short(keys[i]) : `${short(keys[i])}-${short(keys[j])}`);
      i = j + 1;
    }
    return parts.join(", ");
  }

  function spokenDuration(ms) {
    const minutes = Math.floor(Math.max(0, ms) / MS_PER_MINUTE);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h} ${h === 1 ? "hour" : "hours"} ${m} ${m === 1 ? "minute" : "minutes"}`;
  }

  function toViewModel(status, flags = {}) {
    let main;
    if (!status.hasWeekData) main = "-- left";
    else if (status.over) {
      const overMs = -status.remainingMs;
      main = status.live
        ? `Over by ${formatClock(overMs, Math.ceil)}`
        : `Over by ${formatHoursMinutes(overMs, Math.ceil)}`;
    } else if (status.live) main = `${formatClock(status.remainingMs)} left`;
    else main = `${formatHoursMinutes(status.remainingMs)} left`;

    const notices = [];
    let secondary;
    if (!status.hasWeekData) {
      if (flags.loading) secondary = "Loading hours…";
      else if (!status.hasJob) secondary = "Open your timesheet once";
      else secondary = "Open the current timesheet";
    } else {
      if (status.unverified) notices.push("clock status unclear");
      if (status.startUnknown) notices.push("start time unknown");
      if (!status.todaySeen) notices.push("open the current timesheet");
      else if (status.missingDates.length) {
        notices.push(`${formatDateRanges(status.missingDates)} may be missing`);
      }
      if (!notices.length && flags.refreshFailed) notices.push("showing saved hours");
      const usedHours = status.usedHours.toFixed(2);
      // With two warnings the shorter form keeps both readable in the pill.
      const used = notices.length > 1 ? `${usedHours} h` : `${usedHours} of ${status.limitHours} h`;
      secondary = notices.length ? `${used} · ${notices.join(" · ")}` : `${used} this week`;
    }

    // Live values are spoken in coarse steps, rounded toward less time left.
    const spokenRemainingMs = status.live
      ? Math.floor(status.remainingMs / ARIA_STEP_MS) * ARIA_STEP_MS
      : status.remainingMs;
    const about = status.live ? "about " : "";
    const clockWord = status.clockedIn ? " Clocked in." : "";
    let ariaText;
    if (!status.hasWeekData) ariaText = `Weekly hours: ${secondary}.${clockWord}`;
    else if (status.over) {
      ariaText = `Over the ${status.limitHours} hour weekly limit by ${about}${spokenDuration(-spokenRemainingMs)}.${clockWord}`;
    } else {
      const left = `${about}${spokenDuration(spokenRemainingMs)} left of ${status.limitHours} this week.`;
      ariaText = `${left[0].toUpperCase()}${left.slice(1)}${clockWord}`;
    }
    for (const notice of notices) ariaText += ` ${notice[0].toUpperCase()}${notice.slice(1)}.`;

    return {
      main,
      secondary,
      level: status.hasWeekData ? status.level : "normal",
      clockedIn: status.clockedIn,
      progress: status.hasWeekData ? status.progress : 0,
      ariaText,
      // The screen reader text is refreshed only when this key changes.
      ariaKey: [
        status.hasWeekData,
        status.level,
        status.clockedIn,
        status.startUnknown,
        status.hasWeekData ? notices.join("|") : secondary,
        status.hasWeekData ? Math.floor(spokenRemainingMs / MS_PER_MINUTE) : "",
      ].join("|"),
    };
  }

  return {
    WEEKLY_LIMIT_HOURS,
    STORAGE_KEY,
    CLOCKED_IN,
    CLOCKED_OUT,
    UNKNOWN,
    makeDateKey,
    parseDateKey,
    dateKeyFromUs,
    dateKeyFromMs,
    addDays,
    startOfDayMs,
    localMs,
    weekForDateKey,
    weekForMs,
    overlapMs,
    parseTimesheetRoute,
    previewUrl,
    isWidgetPath,
    classifyButtonText,
    splitCells,
    parseClockMinutes,
    parsePreviewText,
    previewSignature,
    extractVisibleTotal,
    emptyState,
    normalizeState,
    recordClockClick,
    confirmSession,
    applyButtonState,
    applyPreview,
    computeStatus,
    formatHoursMinutes,
    formatClock,
    formatDateRanges,
    toViewModel,
  };
});
