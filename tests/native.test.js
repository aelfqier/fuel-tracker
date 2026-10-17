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

function phone(plugins, platform = "android") {
  return load({ isNativePlatform: () => true, getPlatform: () => platform, isPluginAvailable: (n) => n in plugins, Plugins: plugins });
}

test("reminders replace only what bnzn scheduled, one batch at a time", async () => {
  const log = [];
  let pending = [{ id: 1, extra: { ft: 1 } }, { id: 2, extra: { other: 1 } }];
  const LocalNotifications = {
    checkPermissions: async () => ({ display: "granted" }),
    getPending: async () => { log.push("get"); await new Promise((r) => setTimeout(r, 5)); return { notifications: pending }; },
    cancel: async ({ notifications }) => { log.push("cancel " + notifications.map((n) => n.id).join(",")); pending = pending.filter((p) => !notifications.some((n) => n.id === p.id)); },
    schedule: async ({ notifications }) => { log.push("schedule " + notifications.length); pending = pending.concat(notifications); },
  };
  const Native = phone({ LocalNotifications });
  const soon = new Date(Date.now() + 864e5), past = new Date(Date.now() - 864e5);
  Native.scheduleReminders([{ id: "a", title: "A", times: [["d", soon, "x"], ["w", past, "y"]] }]);
  await Native.scheduleReminders([{ id: "b", title: "B", times: [["d", soon, "x"]] }]);
  // The second batch waits for the first: it cancels what the first scheduled, never interleaving with it.
  assert.deepStrictEqual(log.map((l) => l.replace(/cancel \d{3,}/, "cancel A")), ["get", "cancel 1", "schedule 1", "get", "cancel A", "schedule 1"]);
  assert.strictEqual(pending.filter((p) => p.extra && p.extra.ft).length, 1);
  assert.strictEqual(pending.filter((p) => p.extra && p.extra.other).length, 1, "another app's notification was cancelled");
});

test("no permission means nothing is scheduled and nothing throws", async () => {
  let scheduled = 0;
  const Native = phone({ LocalNotifications: {
    checkPermissions: async () => ({ display: "denied" }), requestPermissions: async () => ({ display: "denied" }),
    getPending: async () => ({ notifications: [] }), cancel: async () => {}, schedule: async () => { scheduled++; },
  } });
  await Native.scheduleReminders([{ id: "a", title: "A", times: [["d", new Date(Date.now() + 864e5), "x"]] }]);
  assert.strictEqual(scheduled, 0);
  assert.strictEqual(await Native.notifPermission(true), "denied");
});

test("scan is offered only when the phone's text model says it is available", async () => {
  assert.strictEqual(await phone({}).scanAvailable(), false);
  assert.strictEqual(await phone({ FuelNative: { scanStatus: async () => ({ available: false }) } }).scanAvailable(), false);
  assert.strictEqual(await phone({ FuelNative: { scanStatus: async () => { throw new Error("old app"); } } }).scanAvailable(), false);
  assert.strictEqual(await phone({ FuelNative: { scanStatus: async () => ({ available: true }) } }).scanAvailable(), true);
});

test("the widget gets its summary and the old copy in app storage is removed once", async () => {
  const sent = [], removed = [];
  const Native = phone({ FuelNative: { refreshWidget: async (o) => { sent.push(o); } }, Preferences: { remove: async (o) => { removed.push(o.key); } } });
  await Native.refreshWidget({ vehicle: "Logan" });
  await Native.refreshWidget({ vehicle: "Logan" });
  assert.strictEqual(JSON.stringify(sent), JSON.stringify([{ summary: { vehicle: "Logan" } }, { summary: { vehicle: "Logan" } }]));
  assert.strictEqual(removed.join(), "fuel-tracker-widget");
});

test("the back button listener is Android only", () => {
  const added = [];
  const App = { addListener: (e) => { added.push(e); } };
  phone({ App }, "ios").onBack(() => {});
  phone({ App }, "android").onBack(() => {});
  assert.deepStrictEqual(added, ["backButton"]);
});
