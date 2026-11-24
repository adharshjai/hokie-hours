"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const EXT = path.join(__dirname, "..", "hokie-hours-extension");
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
const content = fs.readFileSync(path.join(EXT, "content.js"), "utf8");
const hours = fs.readFileSync(path.join(EXT, "hours.js"), "utf8");

test("manifest is MV3 with only the storage permission", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.background, undefined);
  assert.equal(manifest.action, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.externally_connectable, undefined);
});

test("content script matches only Banner Employee Self-Service, top frame only", () => {
  assert.equal(manifest.content_scripts.length, 1);
  const script = manifest.content_scripts[0];
  assert.deepEqual(script.matches, ["https://selfservice.banner.vt.edu/EmployeeSelfService/*"]);
  assert.deepEqual(script.js, ["hours.js", "content.js"]);
  assert.equal(script.all_frames, false);
  assert.match(content, /window\.top !== window\.self/);
});

test("every file named by the manifest exists", () => {
  for (const file of [...manifest.content_scripts[0].js, ...Object.values(manifest.icons)]) {
    assert.ok(fs.existsSync(path.join(EXT, file)), file);
  }
});

test("shipped code contains no forbidden APIs", () => {
  const forbidden = [
    /innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /DOMParser/,
    /\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/,
    /synchronizerToken/i, /document\.cookie/, /chrome\.cookies/,
    /preventDefault/, /stopPropagation/, /stopImmediatePropagation/,
    /dispatchEvent/, /new\s+(?:Mouse|Keyboard|Pointer|Custom)?Event\s*\(/,
    /\.click\s*\(/, /\.focus\s*\(/, /\.blur\s*\(/, /\.submit\s*\(/, /requestSubmit/,
    /\beval\s*\(/, /new\s+Function/, /importScripts/, /import\s*\(/,
    /https?:\/\/(?!selfservice)/, /analytics/i,
  ];
  for (const [name, source] of [["content.js", content], ["hours.js", hours]]) {
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${name}: ${pattern}`);
  }
});

test("no hardcoded job id in shipped code", () => {
  for (const source of [content, hours, JSON.stringify(manifest)]) {
    assert.doesNotMatch(source, /304462/);
  }
});

test("hours.js has no DOM or extension access", () => {
  assert.doesNotMatch(hours, /\bdocument\.|\bchrome\.|\bwindow\.|\blocation\./);
});

test("the click listener is passive", () => {
  assert.match(content, /addEventListener\("click", onPassiveClick, \{ capture: true, passive: true \}\)/);
});

test("the widget uses Shadow DOM and textContent", () => {
  assert.match(content, /attachShadow\(\{ mode: "closed" \}\)/);
  assert.match(content, /textContent = value/);
});

test("the only repeating timer is the display tick", () => {
  assert.equal((content.match(/setInterval\(/g) || []).length, 1);
  assert.match(content, /setInterval\(tick, TICK_MS\)/);
  const tickBody = content.slice(content.indexOf("function tick()"), content.indexOf("function onHashChange"));
  assert.doesNotMatch(tickBody, /refresh/i);
});

test("the hidden frame cannot submit forms or navigate the top page", () => {
  const values = [...content.matchAll(/setAttribute\("sandbox", "([^"]*)"\)/g)].map((m) => m[1]);
  assert.deepEqual(values, ["allow-same-origin allow-scripts"]);
});

test("fixtures and shipped files contain no real job id", () => {
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "preview-main.txt"), "utf8");
  assert.doesNotMatch(fixture, /304462/);
  assert.match(fixture, /^Student job, Rate: \$0\.000000$/m);
});
