const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Loads www/js/native.js the way the phone does: no @capacitor/core bundle, so Capacitor has Plugins but no registerPlugin.
function load(capacitor) {
  const sandbox = { Capacitor: capacitor, document: {}, setTimeout, URL, Blob };
  sandbox.self = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../www/js/native.js"), "utf8"), sandbox);
  return sandbox.Native;
}

test("plugins come from Capacitor.Plugins when registerPlugin is missing", () => {
  const prefs = {};
  const Native = load({
    isNativePlatform: () => true,
    getPlatform: () => "android",
    isPluginAvailable: (n) => n === "Preferences",
    Plugins: { Preferences: prefs },
  });
  assert.strictEqual(Native.isNative, true);
  assert.strictEqual(Native.Preferences, prefs);
});

test("registerPlugin is used when a bundle provides it", () => {
  const Native = load({
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    isPluginAvailable: () => true,
    registerPlugin: (n) => ({ name: n }),
    Plugins: {},
  });
  assert.deepStrictEqual({ ...Native.Preferences }, { name: "Preferences" });
});

test("in a browser Native loads with no plugins", () => {
  const Native = load(undefined);
  assert.strictEqual(Native.isNative, false);
  assert.strictEqual(Native.Preferences, null);
});
