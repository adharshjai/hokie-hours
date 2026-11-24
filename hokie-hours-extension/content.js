/*
 * Page side of the weekly hours widget. It is read-only toward Banner: it reads
 * text, renders its own Shadow DOM pill, and never operates any Banner control.
 */
(function () {
  "use strict";

  if (window.top !== window.self) return;
  const H = globalThis.VTHours;
  if (!H || !H.isWidgetPath(location.pathname)) return;
  if (globalThis.__weeklyHoursActive) return;
  globalThis.__weeklyHoursActive = true;

  const BUTTON_SELECTOR = "button.clock-in-out-button";
  const TICK_MS = 1000;
  const BUTTON_SETTLE_MS = 2000;
  const FIRST_CLOCKED_OUT_SETTLE_MS = 8000;
  const TOTAL_CHECK_MS = 2000;
  const REFRESH_TIMEOUT_MS = 20000;
  const REFRESH_POLL_MS = 400;
  const STABLE_MS = 800;
  const EMPTY_STABLE_MS = 4000;
  const STALE_AFTER_MS = 5 * 60 * 1000;
  const CONFIRM_EVERY_MS = 60 * 60 * 1000;
  // Waits between the capped re-reads after a Save, reaching about 30 seconds.
  const SAVE_READ_GAPS_MS = [1500, 3500, 5000, 8000, 12000];
  const TRUSTED_ACTION_WINDOW_MS = 30000;

  const CSS = `
    :host {
      all: initial;
      position: fixed !important;
      top: 6px !important;
      left: 50% !important;
      transform: translateX(-50%) !important;
      z-index: 2147483000 !important;
      display: block !important;
      max-width: min(46vw, 340px) !important;
      pointer-events: none !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .pill {
      --bg: #5f1530;
      --fg: #ffffff;
      --sub: #f6e7ec;
      --track: rgba(255, 255, 255, 0.3);
      --fill: #ffffff;
      --dot: #8ff0b4;
      position: relative;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 7px;
      height: 38px;
      padding: 1px 22px 8px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.6);
      border-radius: 19px;
      background: var(--bg);
      color: var(--fg);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
      pointer-events: auto;
      cursor: pointer;
    }
    .pill[data-editing] { cursor: default; }
    .pill:focus-visible { outline: 2px solid #ffb81c; outline-offset: 2px; }
    .pill[data-level="warn"] {
      --bg: #ffb81c;
      --fg: #2a1700;
      --sub: #3a2400;
      --track: rgba(42, 23, 0, 0.25);
      --fill: #2a1700;
      --dot: #14532d;
      border-color: #2a1700;
    }
    .pill[data-level="over"] {
      --bg: #b71c1c;
      --fg: #ffffff;
      --sub: #ffffff;
      --track: rgba(255, 255, 255, 0.35);
      --fill: #ffffff;
      --dot: #ffffff;
      border-color: #ffffff;
    }
    .dot {
      flex: none;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--dot);
    }
    .dot[hidden], .text[hidden], .editor[hidden] { display: none; }
    .text, .editor {
      display: flex;
      flex-direction: column;
      align-items: center;
      min-width: 0;
      text-align: center;
    }
    .edit-row {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 12px;
      font-weight: 700;
      line-height: 15px;
    }
    .edit-input {
      box-sizing: border-box;
      width: 4.2em;
      height: 15px;
      margin: 0;
      padding: 0 4px;
      border: 1px solid var(--fg);
      border-radius: 4px;
      background: transparent;
      color: var(--fg);
      font: inherit;
      text-align: center;
      outline: none;
      cursor: text;
    }
    .edit-input[aria-invalid="true"] { border-width: 2px; border-style: dashed; }
    .main {
      font-size: 13px;
      font-weight: 700;
      line-height: 15px;
    }
    .sub, .hint {
      overflow: hidden;
      color: var(--sub);
      font-size: 10px;
      line-height: 12px;
      text-overflow: ellipsis;
    }
    .bar {
      position: absolute;
      left: 20px;
      right: 20px;
      bottom: 3px;
      height: 3px;
      background: var(--track);
    }
    .fill {
      width: 100%;
      height: 100%;
      background: var(--fill);
      transform: scaleX(var(--progress, 0));
      transform-origin: left center;
    }
    .sr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    @media (prefers-reduced-motion: no-preference) {
      .fill { transition: transform 300ms ease-out; }
    }
    @media (max-width: 760px) {
      :host { top: 10px !important; max-width: 40vw !important; }
      .pill { height: 29px; padding: 1px 14px 6px; gap: 5px; border-radius: 15px; }
      .bar { left: 13px; right: 13px; bottom: 3px; }
      .sub, .hint { display: none; }
      .main, .edit-row { font-size: 12px; line-height: 14px; }
    }
    @media (max-width: 400px) {
      .pill { padding: 1px 11px 6px; gap: 4px; }
      .bar { left: 11px; right: 11px; }
      .main, .edit-row { font-size: 11px; }
    }
  `;

  const REOPEN_GUARD_MS = 400;
  const EDIT_HINT = "Enter to save · Esc to cancel";
  const EDIT_ERROR = `Use a number like 19.8 (up to ${H.MAX_LIMIT_HOURS})`;

  let state = H.emptyState();
  let limitHours = H.WEEKLY_LIMIT_HOURS;
  let editing = false;
  let editorClosedAt = 0;
  let openedByKey = false;
  let ui = null;
  let tickTimer = null;
  let observer = null;
  let stopped = false;
  let writeQueue = Promise.resolve();

  let refreshing = false;
  let refreshQueued = false;
  let refreshOwed = false;
  let refreshFailed = false;
  let lastRefreshAt = 0;
  let abortFrame = null;

  // { value, jobId, atMs }: a settled reading belongs to the job it was read on.
  let committedButton = null;
  let buttonCandidate = null;
  let unreadableSince = null;
  let firstReadingPending = true;
  let clockClickSeen = false;
  let lastConfirmAt = 0;

  let domDirty = false;
  let lastTotalCheck = 0;
  let lastVisibleTotal = null;
  let lastUserActionAt = null;
  let totalRefreshArmed = false;
  let clockOutClickSeen = false;

  // Per timesheet: { jobId, suffix, reads, nextAt }.
  const pendingSaves = new Map();

  /* ---------- Storage ---------- */

  async function readStored() {
    const result = await chrome.storage.local.get(H.STORAGE_KEY);
    return H.normalizeState(result[H.STORAGE_KEY]);
  }

  async function readLimit() {
    const result = await chrome.storage.local.get(H.LIMIT_KEY);
    return H.normalizeLimit(result[H.LIMIT_KEY]);
  }

  /** False once the extension was reloaded, disabled, or removed. */
  function contextAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function handleStorageError() {
    // After an extension reload this old script can no longer reach storage.
    if (!contextAlive()) stop();
  }

  /** Each change re-reads storage first so that open tabs do not overwrite each other. */
  function mutate(change) {
    writeQueue = writeQueue
      .then(async () => {
        const current = await readStored();
        const next = change(current);
        if (next !== current) await chrome.storage.local.set({ [H.STORAGE_KEY]: next });
        state = next;
        render();
      })
      .catch(handleStorageError);
    return writeQueue;
  }

  /* ---------- Widget ---------- */

  function make(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function applyStyles(root) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (_) {
      const style = make("style");
      style.textContent = CSS;
      root.appendChild(style);
    }
  }

  function buildWidget() {
    const host = make("div");
    host.id = "weekly-hours-widget";
    const root = host.attachShadow({ mode: "closed" });
    applyStyles(root);

    // The pill is the only part that takes clicks; it opens the limit editor.
    const pill = make("div", "pill");

    const dot = make("span", "dot");
    dot.setAttribute("aria-hidden", "true");
    dot.hidden = true;

    const text = make("div", "text");
    text.setAttribute("aria-hidden", "true");
    const main = make("span", "main");
    const sub = make("span", "sub");
    text.appendChild(main);
    text.appendChild(sub);

    const bar = make("div", "bar");
    bar.setAttribute("aria-hidden", "true");
    const fill = make("div", "fill");
    bar.appendChild(fill);

    const editor = make("div", "editor");
    editor.hidden = true;
    const editRow = make("label", "edit-row");
    const editLabel = make("span", "edit-label");
    editLabel.textContent = "Weekly limit";
    const input = make("input", "edit-input");
    input.type = "text";
    input.setAttribute("inputmode", "decimal");
    input.setAttribute("maxlength", "6");
    input.setAttribute("aria-label", "Weekly hour limit");
    const unit = make("span", "edit-unit");
    unit.textContent = "h";
    const hint = make("span", "hint");
    hint.setAttribute("aria-live", "polite");
    editRow.appendChild(editLabel);
    editRow.appendChild(input);
    editRow.appendChild(unit);
    editor.appendChild(editRow);
    editor.appendChild(hint);

    // The live region sits outside the pill, which acts as a button.
    const sr = make("span", "sr");
    sr.setAttribute("role", "status");
    sr.setAttribute("aria-live", "polite");
    sr.setAttribute("aria-atomic", "true");

    pill.appendChild(dot);
    pill.appendChild(text);
    pill.appendChild(editor);
    pill.appendChild(bar);
    root.appendChild(pill);
    root.appendChild(sr);
    document.documentElement.appendChild(host);
    ui = { host, pill, dot, text, main, sub, editor, input, hint, fill, sr, ariaKey: null };
    setPillMode(false);

    pill.addEventListener("click", onPillClick);
    pill.addEventListener("keydown", onPillKey);
    input.addEventListener("keydown", onEditorKey);
    input.addEventListener("blur", onEditorBlur);
  }

  /* ---------- Limit editor ---------- */

  function setPillMode(isEditing) {
    if (editing && !isEditing) editorClosedAt = Date.now();
    editing = isEditing;
    ui.text.hidden = isEditing;
    ui.editor.hidden = !isEditing;
    if (isEditing) {
      ui.pill.setAttribute("data-editing", "");
      ui.pill.setAttribute("role", "group");
      ui.pill.setAttribute("aria-label", "Change weekly limit");
      ui.pill.removeAttribute("tabindex");
      ui.pill.title = "";
    } else {
      ui.pill.removeAttribute("data-editing");
      ui.pill.setAttribute("role", "button");
      ui.pill.setAttribute("aria-label", `Weekly hours. Change the ${limitHours} hour limit`);
      ui.pill.setAttribute("tabindex", "0");
      ui.pill.title = "Click to change your weekly limit";
    }
  }

  function openEditor(byKey) {
    openedByKey = byKey;
    setPillMode(true);
    ui.input.value = String(limitHours);
    ui.input.removeAttribute("aria-invalid");
    setText(ui.hint, EDIT_HINT);
    ui.input.focus();
    ui.input.select();
  }

  /** Focus goes back to the pill only for keyboard users, so a mouse user sees no focus ring. */
  function closeEditor(returnFocus) {
    setPillMode(false);
    if (returnFocus && openedByKey) ui.pill.focus();
  }

  /** Saves a typed limit. A bad value stays open after Enter and is dropped on click-away. */
  function commitLimit(fromKey) {
    const value = H.parseLimitInput(ui.input.value);
    if (value === null) {
      if (!fromKey) {
        closeEditor(false);
        return;
      }
      ui.input.setAttribute("aria-invalid", "true");
      setText(ui.hint, EDIT_ERROR);
      return;
    }
    const changed = value !== limitHours;
    limitHours = value;
    closeEditor(fromKey);
    render();
    if (!changed) return;
    try {
      chrome.storage.local.set({ [H.LIMIT_KEY]: value }).catch(handleStorageError);
    } catch (_) {
      handleStorageError();
    }
  }

  function onPillClick(event) {
    // Clicking the pill's edge while editing first blurs the box, which closes it; stay closed.
    const justClosed = Date.now() - editorClosedAt < REOPEN_GUARD_MS;
    if (event.isTrusted && !editing && !stopped && !justClosed) openEditor(false);
  }

  function onPillKey(event) {
    // Keys typed in the editor bubble up here; only a key on the pill itself opens it.
    if (event.isTrusted && !editing && !stopped && event.target === ui.pill && event.key === "Enter") {
      openEditor(true);
    }
  }

  function onEditorKey(event) {
    if (!event.isTrusted || !editing) return;
    if (event.key === "Enter") commitLimit(true);
    else if (event.key === "Escape") closeEditor(true);
  }

  function onEditorBlur() {
    if (editing) commitLimit(false);
  }

  function setText(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }

  function render() {
    if (!ui || stopped) return;
    const view = H.toViewModel(H.computeStatus(state, Date.now(), limitHours), {
      loading: refreshing,
      refreshFailed,
    });
    setText(ui.main, view.main);
    setText(ui.sub, view.secondary);
    if (ui.pill.getAttribute("data-level") !== view.level) {
      ui.pill.setAttribute("data-level", view.level);
    }
    if (ui.dot.hidden === view.clockedIn) ui.dot.hidden = !view.clockedIn;
    ui.fill.style.setProperty("--progress", view.progress.toFixed(4));
    if (ui.ariaKey !== view.ariaKey) {
      ui.ariaKey = view.ariaKey;
      setText(ui.sr, view.ariaText);
    }
  }

  /* ---------- Reading the page ---------- */

  function visibleButton() {
    for (const button of document.querySelectorAll(BUTTON_SELECTOR)) {
      if (button.getClientRects().length > 0) return button;
    }
    return null;
  }

  function readButtonState() {
    const button = visibleButton();
    return button ? H.classifyButtonText(button.textContent) : H.UNKNOWN;
  }

  const currentJobId = () => {
    const route = H.parseTimesheetRoute(location.hash);
    return route ? route.jobId : state.lastJobId;
  };

  /** The settled reading, only if it is for this job and still on screen. */
  function buttonReadingFor(jobId) {
    if (
      !committedButton ||
      committedButton.jobId !== jobId ||
      readButtonState() !== committedButton.value
    ) {
      return { value: H.UNKNOWN, atMs: undefined };
    }
    return committedButton;
  }

  /** A label this script cannot read may mean the clock state changed. */
  function noteUnreadableButton(now) {
    buttonCandidate = null;
    if (!committedButton || committedButton.lost || !visibleButton()) {
      unreadableSince = null;
      return;
    }
    if (unreadableSince === null) unreadableSince = now;
    if (now - unreadableSince < BUTTON_SETTLE_MS) return;
    committedButton.lost = true;
    unreadableSince = null;
    refreshAfterPageChange();
  }

  function observeButton(now) {
    const seen = readButtonState();
    if (seen === H.UNKNOWN) {
      noteUnreadableButton(now);
      return;
    }
    unreadableSince = null;
    if (committedButton && seen === committedButton.value) {
      committedButton.lost = false;
      buttonCandidate = null;
      if (seen === H.CLOCKED_IN && now - lastConfirmAt >= CONFIRM_EVERY_MS) {
        lastConfirmAt = now;
        mutate((current) => H.confirmSession(current, now));
      }
      return;
    }
    if (!buttonCandidate || buttonCandidate.value !== seen) {
      buttonCandidate = { value: seen, atMs: now };
    }
    // Angular may briefly draw its default "Clock In" while the page loads.
    const settleMs =
      seen === H.CLOCKED_OUT && firstReadingPending ? FIRST_CLOCKED_OUT_SETTLE_MS : BUTTON_SETTLE_MS;
    if (now - buttonCandidate.atMs < settleMs) return;

    const previous = committedButton ? committedButton.value : null;
    const changedAtMs = buttonCandidate.atMs;
    const jobId = currentJobId();
    committedButton = { value: seen, jobId, atMs: changedAtMs };
    lastConfirmAt = now;
    firstReadingPending = false;
    buttonCandidate = null;

    const observedClockOut =
      (previous === H.CLOCKED_IN || clockOutClickSeen) && seen === H.CLOCKED_OUT;
    mutate((current) =>
      H.applyButtonState(current, seen, { nowMs: now, changedAtMs, jobId, observedClockOut })
    );
    if (previous !== null || clockClickSeen) refreshAfterPageChange();
    clockClickSeen = false;
    clockOutClickSeen = false;
  }

  function checkVisibleTotal(now) {
    if (!domDirty || now - lastTotalCheck < TOTAL_CHECK_MS) return;
    domDirty = false;
    lastTotalCheck = now;
    if (!H.parseTimesheetRoute(location.hash) || !document.body) return;
    const total = H.extractVisibleTotal(document.body.innerText);
    if (total === null) return;
    const changed = lastVisibleTotal !== null && total !== lastVisibleTotal;
    lastVisibleTotal = total;
    // One load per recent real action, so a self-updating total on an idle page
    // can never keep the login alive.
    if (changed && totalRefreshArmed && hadRecentUserAction(now)) {
      totalRefreshArmed = false;
      requestRefresh();
    }
  }

  const hadRecentUserAction = (now) =>
    lastUserActionAt !== null && now - lastUserActionAt <= TRUSTED_ACTION_WINDOW_MS;

  /** Page changes load hours only after real input. Otherwise the load waits for it. */
  function refreshAfterPageChange() {
    if (hadRecentUserAction(Date.now())) requestRefresh();
    else refreshOwed = true;
  }

  function noteUserAction() {
    lastUserActionAt = Date.now();
    totalRefreshArmed = true;
    if (refreshOwed) requestRefresh();
  }

  /** Remembers which timesheet was saved, since the user may leave it right away. */
  function noteSave() {
    const route = H.parseTimesheetRoute(location.hash);
    if (!route) return;
    // The capped schedule below owns this click's reads.
    totalRefreshArmed = false;
    pendingSaves.set(`${route.jobId}|${route.suffix}`, {
      jobId: route.jobId,
      suffix: route.suffix,
      reads: 0,
      nextAt: Date.now() + SAVE_READ_GAPS_MS[0],
    });
  }

  /** Re-reads a saved timesheet a fixed number of times over about 30 seconds. */
  async function readSavedHours(key, pending) {
    pending.reads += 1;
    pending.nextAt = Infinity;
    await refresh({ jobId: pending.jobId, suffix: pending.suffix });
    if (pendingSaves.get(key) !== pending) return;
    if (pending.reads >= SAVE_READ_GAPS_MS.length) pendingSaves.delete(key);
    else pending.nextAt = Date.now() + SAVE_READ_GAPS_MS[pending.reads];
  }

  function checkSaves(now) {
    if (refreshing || document.visibilityState !== "visible") return;
    for (const [key, pending] of pendingSaves) {
      if (now < pending.nextAt) continue;
      readSavedHours(key, pending);
      return;
    }
  }

  function onPassiveKey(event) {
    if (event.isTrusted) noteUserAction();
  }

  function onPassiveClick(event) {
    if (!event.isTrusted) return;
    noteUserAction();
    const target = event.target;
    const clicked = target && target.closest ? target.closest("button") : null;
    if (clicked && !clicked.disabled && /^save$/i.test(clicked.textContent.trim())) {
      noteSave();
    }
    const button = target && target.closest ? target.closest(BUTTON_SELECTOR) : null;
    if (!button) return;
    const label = H.classifyButtonText(button.textContent);
    if (label === H.CLOCKED_IN) clockOutClickSeen = true;
    if (label !== H.CLOCKED_OUT) return;
    const atMs = Date.now();
    const jobId = currentJobId();
    clockClickSeen = true;
    mutate((current) => H.recordClockClick(current, atMs, jobId));
  }

  /* ---------- Preview refresh (one hidden frame at a time) ---------- */

  function parseFrame(frame) {
    try {
      const body = frame.contentDocument && frame.contentDocument.body;
      if (!body) return null;
      const parsed = H.parsePreviewText(body.innerText);
      return parsed.ok ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function readPreview(url) {
    return new Promise((resolve) => {
      const frame = make("iframe");
      // No allow-forms, allow-popups, or allow-top-navigation: the frame cannot
      // submit anything or navigate the page the user is on.
      frame.setAttribute("sandbox", "allow-same-origin allow-scripts");
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("inert", "");
      frame.setAttribute("tabindex", "-1");
      frame.title = "Weekly hours data";
      frame.style.cssText =
        "position:fixed;left:-10000px;top:0;width:1280px;height:900px;border:0;pointer-events:none;";

      let finished = false;
      let pollTimer = null;
      let lastSignature = null;
      let signatureSince = 0;

      const finish = (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(pollTimer);
        clearTimeout(deadline);
        frame.remove();
        abortFrame = null;
        resolve(result);
      };

      const poll = () => {
        if (finished) return;
        const now = Date.now();
        const parsed = parseFrame(frame);
        if (parsed) {
          const signature = H.previewSignature(parsed);
          if (signature !== lastSignature) {
            lastSignature = signature;
            signatureSince = now;
          } else if (
            now - signatureSince >=
            (parsed.isEmpty || !parsed.punchesListed ? EMPTY_STABLE_MS : STABLE_MS)
          ) {
            finish(parsed);
            return;
          }
        } else {
          lastSignature = null;
        }
        pollTimer = setTimeout(poll, REFRESH_POLL_MS);
      };

      const deadline = setTimeout(() => finish(null), REFRESH_TIMEOUT_MS);
      abortFrame = () => finish(null);
      frame.src = url;
      document.documentElement.appendChild(frame);
      pollTimer = setTimeout(poll, REFRESH_POLL_MS);
    });
  }

  /** Refreshes run only for page events, and hidden tabs wait until they are visible. */
  function requestRefresh() {
    if (stopped) return;
    if (!contextAlive()) {
      stop();
      return;
    }
    if (document.visibilityState !== "visible") {
      refreshOwed = true;
      return;
    }
    refreshOwed = false;
    refresh();
  }

  /** Reads the current timesheet, or a specific saved one. */
  async function refresh(target = null) {
    if (refreshing) {
      refreshQueued = true;
      return;
    }
    const route = H.parseTimesheetRoute(location.hash);
    const jobId = target ? target.jobId : route ? route.jobId : state.lastJobId;
    const suffix = target ? target.suffix : route ? route.suffix : state.lastSuffix;
    const url = jobId ? H.previewUrl(location.origin, jobId, suffix) : null;
    if (!url) {
      render();
      return;
    }

    refreshing = true;
    const snapshotAt = Date.now();
    lastRefreshAt = snapshotAt;
    render();
    try {
      const parsed = await readPreview(url);
      refreshFailed = !parsed;
      if (parsed && !stopped) {
        await mutate((current) => {
          const reading = buttonReadingFor(jobId);
          return H.applyPreview(current, parsed, {
            jobId,
            suffix,
            nowMs: Date.now(),
            buttonState: reading.value,
            buttonAtMs: reading.atMs,
            snapshotAt,
          });
        });
      }
    } finally {
      refreshing = false;
      render();
      if (refreshQueued) {
        refreshQueued = false;
        requestRefresh();
      }
    }
  }

  /* ---------- Lifecycle ---------- */

  function tick() {
    if (stopped) return;
    if (!contextAlive()) {
      stop();
      return;
    }
    const now = Date.now();
    if (ui && !ui.host.isConnected) document.documentElement.appendChild(ui.host);
    observeButton(now);
    checkVisibleTotal(now);
    checkSaves(now);
    render();
  }

  function onHashChange() {
    firstReadingPending = true;
    buttonCandidate = null;
    unreadableSince = null;
    // A reading from another job's page says nothing about this job.
    if (committedButton && committedButton.jobId !== currentJobId()) committedButton = null;
    lastVisibleTotal = null;
    domDirty = true;
    refreshAfterPageChange();
  }

  function onVisibilityChange() {
    if (document.visibilityState !== "visible") return;
    render();
    if (refreshOwed || Date.now() - lastRefreshAt > STALE_AFTER_MS) requestRefresh();
  }

  function onStorageChanged(changes, area) {
    if (area !== "local") return;
    const stateChange = changes[H.STORAGE_KEY];
    const limitChange = changes[H.LIMIT_KEY];
    if (!stateChange && !limitChange) return;
    if (stateChange) state = H.normalizeState(stateChange.newValue);
    if (limitChange) {
      limitHours = H.normalizeLimit(limitChange.newValue);
      if (!editing) setPillMode(false);
    }
    render();
  }

  function onPageHide() {
    if (abortFrame) abortFrame();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    pendingSaves.clear();
    clearInterval(tickTimer);
    if (observer) observer.disconnect();
    if (abortFrame) abortFrame();
    document.removeEventListener("click", onPassiveClick, true);
    document.removeEventListener("keydown", onPassiveKey, true);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("hashchange", onHashChange);
    window.removeEventListener("pagehide", onPageHide);
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch (_) {
      // The extension context is already gone.
    }
    if (ui) ui.host.remove();
  }

  async function start() {
    try {
      state = await readStored();
      limitHours = await readLimit();
    } catch (_) {
      return;
    }
    buildWidget();
    render();

    document.addEventListener("click", onPassiveClick, { capture: true, passive: true });
    document.addEventListener("keydown", onPassiveKey, { capture: true, passive: true });
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("pagehide", onPageHide);
    chrome.storage.onChanged.addListener(onStorageChanged);

    if (document.body) {
      observer = new MutationObserver(() => {
        domDirty = true;
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      domDirty = true;
    }

    // This timer only redraws the pill and reads the page. It makes no requests.
    tickTimer = setInterval(tick, TICK_MS);
    requestRefresh();
  }

  start();
})();
