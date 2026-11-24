"use strict";
// A small fake browser that runs the real content.js with controllable time.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT = path.join(__dirname, "..", "hokie-hours-extension");
const HOURS_SRC = fs.readFileSync(path.join(EXT, "hours.js"), "utf8");
const CONTENT_SRC = fs.readFileSync(path.join(EXT, "content.js"), "utf8");

class FakeElement {
  constructor(tag, env) {
    this.tagName = tag.toUpperCase();
    this.env = env;
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.id = "";
    this.title = "";
    this.src = "";
    this.styleProps = {};
    const self = this;
    this.style = { cssText: "", setProperty(k, v) { self.styleProps[k] = v; } };
  }
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  get isConnected() {
    let node = this;
    while (node.parent) node = node.parent;
    return node === this.env.document.documentElement;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  attachShadow(init) {
    this.shadowInit = init;
    this.shadow = new FakeElement("shadow-root", this.env);
    return this.shadow;
  }
  find(className) {
    for (const c of this.children) {
      if (c.className === className) return c;
      const hit = c.find(className);
      if (hit) return hit;
    }
    return null;
  }
}

class FakeButton extends FakeElement {
  constructor(env, text) {
    super("button", env);
    this.textContent = text;
    this.visible = true;
    this.operated = [];
    for (const method of ["click", "focus", "blur", "dispatchEvent", "submit"]) {
      this[method] = () => this.operated.push(method);
    }
  }
  getClientRects() { return this.visible ? [{}] : []; }
  closest() { return this; }
}

class FakeClock {
  constructor(now) {
    this.now = now;
    this.nextId = 1;
    this.timers = new Map();
  }
  setTimer(fn, ms, every) {
    const id = this.nextId++;
    this.timers.set(id, { fn, at: this.now + Math.max(0, ms || 0), every });
    return id;
  }
  clear(id) { this.timers.delete(id); }
  async flush() {
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  }
  async advance(ms) {
    const target = this.now + ms;
    await this.flush();
    for (;;) {
      let nextId = null;
      let next = null;
      for (const [id, t] of this.timers) {
        if (t.at <= target && (!next || t.at < next.at)) {
          nextId = id;
          next = t;
        }
      }
      if (!next) break;
      this.now = next.at;
      if (next.every) next.at += next.every;
      else this.timers.delete(nextId);
      next.fn();
      await this.flush();
    }
    this.now = target;
    await this.flush();
  }
}

function boot(options = {}) {
  const {
    now,
    pathname = "/EmployeeSelfService/ssb/timeEntry",
    hash = "",
    buttonText = "Clock In",
    previewText = "",
    stored,
    storage = {},
    isTopFrame = true,
    visibilityState = "visible",
  } = options;

  const clock = new FakeClock(now);
  const env = { clock, frames: [], previewText, storage, listeners: {}, windowListeners: {} };
  if (stored) storage["weeklyHoursState.v1"] = JSON.parse(JSON.stringify(stored));

  const documentElement = new FakeElement("html", env);
  const body = new FakeElement("body", env);
  documentElement.appendChild(body);
  body.innerText = "";

  env.button = buttonText === null ? null : new FakeButton(env, buttonText);

  env.document = {
    documentElement,
    body,
    visibilityState,
    createElement(tag) {
      const el = new FakeElement(tag, env);
      if (tag === "iframe") {
        env.frames.push(el);
        Object.defineProperty(el, "contentDocument", {
          get: () => (env.frameBlocked ? null : { body: { innerText: env.previewText } }),
        });
      }
      return el;
    },
    querySelectorAll: () => (env.button ? [env.button] : []),
    addEventListener(type, fn, opts) { (env.listeners[type] ||= []).push({ fn, opts }); },
    removeEventListener(type, fn) {
      env.listeners[type] = (env.listeners[type] || []).filter((l) => l.fn !== fn);
    },
  };

  const storageChanged = [];
  env.chrome = {
    runtime: { id: "test-extension" },
    storage: {
      local: {
        async get(key) {
          return key in storage ? { [key]: JSON.parse(JSON.stringify(storage[key])) } : {};
        },
        async set(values) {
          for (const [k, v] of Object.entries(values)) {
            storage[k] = JSON.parse(JSON.stringify(v));
            for (const fn of storageChanged) fn({ [k]: { newValue: storage[k] } }, "local");
          }
        },
      },
      onChanged: { addListener: (fn) => storageChanged.push(fn) },
    },
  };

  const sandbox = {
    document: env.document,
    location: { pathname, hash, origin: "https://selfservice.banner.vt.edu" },
    chrome: env.chrome,
    console,
    setTimeout: (fn, ms) => clock.setTimer(fn, ms),
    clearTimeout: (id) => clock.clear(id),
    setInterval: (fn, ms) => clock.setTimer(fn, ms, ms),
    clearInterval: (id) => clock.clear(id),
    MutationObserver: class {
      constructor(cb) { env.mutate = cb; }
      observe() {}
      disconnect() {}
    },
    CSSStyleSheet: class { replaceSync() {} },
    __now: () => clock.now,
    addEventListener(type, fn) { (env.windowListeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      env.windowListeners[type] = (env.windowListeners[type] || []).filter((f) => f !== fn);
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = isTopFrame ? sandbox : {};
  env.sandbox = sandbox;

  vm.createContext(sandbox);
  vm.runInContext("Date.now = () => __now();", sandbox);
  vm.runInContext(HOURS_SRC, sandbox, { filename: "hours.js" });
  vm.runInContext(CONTENT_SRC, sandbox, { filename: "content.js" });

  env.host = () => documentElement.children.find((c) => c.id === "weekly-hours-widget") || null;
  env.text = (className) => {
    const host = env.host();
    const node = host && host.shadow.find(className);
    return node ? node.textContent : null;
  };
  env.node = (className) => env.host().shadow.find(className);
  env.activeFrames = () => documentElement.children.filter((c) => c.tagName === "IFRAME");
  env.state = () => storage["weeklyHoursState.v1"];
  env.userClick = () => {
    for (const { fn } of env.listeners.click || []) {
      fn({ isTrusted: true, target: env.button });
    }
  };
  env.userInput = () => {
    for (const { fn } of env.listeners.keydown || []) fn({ isTrusted: true });
  };
  // Real route changes follow user input. Pass idle to model one that does not.
  env.setHash = (next, { idle = false } = {}) => {
    if (!idle) env.userInput();
    sandbox.location.hash = next;
    for (const fn of env.windowListeners.hashchange || []) fn({});
  };
  env.setVisibility = (value) => {
    env.document.visibilityState = value;
    for (const { fn } of env.listeners.visibilitychange || []) fn({});
  };
  return env;
}

module.exports = { boot };
