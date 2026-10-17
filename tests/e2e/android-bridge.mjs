// Runs bnzn in Chromium behind Capacitor's real Android bridge (native-bridge.js from @capacitor/android, plus the
// plugin code the Android side generates), with the native plugins played by this script. It checks what a browser
// test can't: the app starting the way the phone starts it, under the page's content security policy, in both ways
// Capacitor injects its code, and the phone-only paths (saved data, back button, scan, notifications, widget).
//
// Run: node tests/e2e/android-bridge.mjs   (needs Playwright with Chromium; not part of npm test)
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("/opt/node-tools/node_modules/playwright")); }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WWW = join(ROOT, "www");
const BRIDGE = readFileSync(join(ROOT, "node_modules/@capacitor/android/capacitor/src/main/assets/native-bridge.js"), "utf8");
const ORIGIN = "https://localhost";

// The plugin methods each Android plugin exposes (what JSExport turns into Capacitor.Plugins).
const PLUGINS = {
  Preferences: ["configure", "get", "set", "remove", "keys", "clear", "migrate", "removeOld"],
  Filesystem: ["readFile", "writeFile", "appendFile", "deleteFile", "mkdir", "rmdir", "readdir", "getUri", "stat", "rename", "copy", "checkPermissions", "requestPermissions"],
  Share: ["canShare", "share"],
  LocalNotifications: ["schedule", "getPending", "registerActionTypes", "cancel", "areEnabled", "getDeliveredNotifications", "removeDeliveredNotifications", "removeAllDeliveredNotifications", "createChannel", "deleteChannel", "listChannels", "checkPermissions", "requestPermissions", "changeExactNotificationSetting", "checkExactNotificationSetting", "removeAllListeners"],
  App: ["exitApp", "getInfo", "getLaunchUrl", "getState", "minimizeApp", "toggleBackButtonHandler", "getAppLanguage", "removeAllListeners"],
  SystemBars: ["setStyle", "show", "hide", "setAnimation"],
  Haptics: ["vibrate", "impact", "notification", "selectionStart", "selectionChanged", "selectionEnd"],
  FuelNative: ["scanStatus", "recognizeText", "refreshWidget", "printHtml", "requestReview", "consumeLaunchAction", "removeAllListeners"],
};
// The same text JSExport.getPluginJS writes.
function pluginJS() {
  const lines = ["// Begin: Capacitor Plugin JS"];
  const headers = [];
  for (const [id, methods] of Object.entries(PLUGINS)) {
    lines.push(`(function(w) {\nvar a = (w.Capacitor = w.Capacitor || {});\nvar p = (a.Plugins = a.Plugins || {});\nvar t = (p['${id}'] = {});\nt.addListener = function(eventName, callback) {\n  return w.Capacitor.addListener('${id}', eventName, callback);\n}`);
    for (const m of methods) lines.push(`t['${m}'] = function(_options) {\nreturn w.Capacitor.nativePromise('${id}', '${m}', _options)\n}`);
    lines.push("})(window);\n");
    headers.push({ name: id, methods: methods.map((name) => ({ name, rtype: "promise" })) });
  }
  return lines.join("\n") + "\nwindow.Capacitor.PluginHeaders = " + JSON.stringify(headers) + ";";
}
// Bridge.getJSInjector: global, server URL, bridge, plugins.
const INJECTED = `window.Capacitor = { DEBUG: true, isLoggingEnabled: true, Plugins: {} };\n\nwindow.WEBVIEW_SERVER_URL = '${ORIGIN}';${BRIDGE}\n\n${pluginJS()}`;

// The page side of androidBridge (addWebMessageListener puts it there before any script runs) and a CSP watcher.
const PAGE_SETUP = `
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
  window.androidBridge = { postMessage(s) { window.__native(s).then((out) => { for (const r of out) window.Capacitor.fromNative(r); }); } };
`;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".txt": "text/plain", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };

class Phone {
  constructor() {
    this.prefs = new Map();
    this.cfg = { scan: true, ocr: "", ocrError: null, notif: "prompt", notifAnswer: "granted", launchUrl: null, failGet: new Set() };
    this.calls = [];
    this.listeners = [];
    this.pending = [];
    this.widget = null;
    this.storage = undefined;
  }
  reset() { this.calls = []; this.listeners = []; }
  async handle(raw) {
    const m = JSON.parse(raw);
    if (!m.pluginId || m.callbackId == null) return [];
    if (m.pluginId === "Console") return [];
    this.calls.push(m);
    const ok = (data) => [{ callbackId: m.callbackId, pluginId: m.pluginId, methodName: m.methodName, success: true, data: data || {} }];
    const fail = (message, code) => [{ callbackId: m.callbackId, pluginId: m.pluginId, methodName: m.methodName, success: false, error: { message, code } }];
    const o = m.options || {};
    if (m.methodName === "addListener") { this.listeners.push({ plugin: m.pluginId, event: o.eventName, id: m.callbackId }); return []; }
    switch (`${m.pluginId}.${m.methodName}`) {
      case "Preferences.get": if (this.cfg.failGet.has(o.key)) return fail("SharedPreferences busy");
        return ok({ value: this.prefs.has(o.key) ? this.prefs.get(o.key) : null });
      case "Preferences.set": this.prefs.set(o.key, String(o.value)); return ok();
      case "Preferences.remove": this.prefs.delete(o.key); return ok();
      case "Preferences.keys": return ok({ keys: [...this.prefs.keys()] });
      case "Filesystem.writeFile": return ok({ uri: "file:///data/cache/" + o.path });
      case "Share.share": return ok({ activityType: "test" });
      case "LocalNotifications.checkPermissions": return ok({ display: this.cfg.notif });
      case "LocalNotifications.requestPermissions": this.cfg.notif = this.cfg.notifAnswer; return ok({ display: this.cfg.notif });
      case "LocalNotifications.getPending": return ok({ notifications: this.pending });
      case "LocalNotifications.cancel": { const ids = new Set(o.notifications.map((n) => n.id)); this.pending = this.pending.filter((n) => !ids.has(n.id)); return ok(); }
      case "LocalNotifications.schedule": this.pending.push(...o.notifications); return ok({ notifications: o.notifications.map((n) => ({ id: n.id })) });
      case "App.getInfo": return ok({ name: "bnzn", id: "io.github.aelfqier.fueltracker", version: "2.1.0", build: "21" });
      case "App.getLaunchUrl": return ok(this.cfg.launchUrl ? { url: this.cfg.launchUrl } : {});
      case "App.minimizeApp": return ok();
      case "FuelNative.scanStatus": return ok({ available: this.cfg.scan });
      case "FuelNative.recognizeText": return this.cfg.ocrError ? fail("not ready", this.cfg.ocrError) : ok({ text: this.cfg.ocr });
      case "FuelNative.refreshWidget": this.widget = o.summary; return ok();
      case "FuelNative.printHtml": return ok();
      case "FuelNative.requestReview": return ok();
      case "FuelNative.consumeLaunchAction": return ok({ action: null });
      default: return ok();
    }
  }
  count(id) { return this.calls.filter((c) => `${c.pluginId}.${c.methodName}` === id).length; }
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push([name, true]); console.log("  ok  " + name); }
  catch (e) { results.push([name, false, e]); console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n       ")); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg || "assertion failed"); };

const browser = await chromium.launch();

// One phone session: mode "start" = addDocumentStartJavaScript, "inline" = script spliced into <head> (old WebViews).
async function open(phone, mode = "start", lang = "en-US") {
  // phone.storage carries the WebView's own storage (localStorage) from one app start to the next.
  const ctx = await browser.newContext({ locale: lang, viewport: { width: 400, height: 860 }, storageState: phone.storage });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.errors.push(m.text()); });
  await page.exposeFunction("__native", (s) => phone.handle(s));
  await page.addInitScript(PAGE_SETUP);
  if (mode === "start") await page.addInitScript(INJECTED);
  page.phone = phone;
  page.sendEvent = async (plugin, event, data) => {
    for (const l of phone.listeners.filter((x) => x.plugin === plugin && x.event === event)) {
      await page.evaluate(([id, p, d]) => window.Capacitor.fromNative({ callbackId: id, pluginId: p, methodName: "addListener", success: true, data: d, save: true }), [l.id, plugin, data]);
    }
  };
  await ctx.route(ORIGIN + "/**", async (route) => {
    let path = new URL(route.request().url()).pathname;
    if (path === "/") path = "/index.html";
    const file = join(WWW, decodeURIComponent(path));
    if (!file.startsWith(WWW) || !existsSync(file)) return route.fulfill({ status: 404, body: "" });
    let body = readFileSync(file);
    if (path === "/index.html" && mode === "inline") body = Buffer.from(body.toString("utf8").replace("<head>", `<head><script type="text/javascript">${INJECTED}</script>`));
    return route.fulfill({ status: 200, contentType: MIME[extname(file)] || "application/octet-stream", body });
  });
  await page.goto(ORIGIN + "/");
  await page.waitForFunction(() => document.getElementById("storeStatus").dataset.i18n !== "loading", null, { timeout: 8000 });
  await page.waitForTimeout(300);
  return page;
}
async function close(page) {
  const csp = await page.evaluate(() => window.__csp).catch(() => []);
  page.phone.storage = await page.context().storageState(); await page.context().close();
  assert(!csp.length, "CSP violations: " + csp.join(", "));
}

async function onboard(page, { fuel = "essence", cur = "MAD" } = {}) {
  await page.click('#welcomeInner button[data-lang="en"]');
  await page.fill("#wName", "Logan");
  await page.click(`label[for="wf-${fuel}"]`);
  await page.click('#welcomeInner button[data-w="next"]');
  await page.click(`#welcomeInner button[data-cur="${cur}"]`);
  await page.waitForTimeout(300);
}
const records = (phone) => JSON.parse(phone.prefs.get("fuel-tracker-records-v1") || "[]");
const settingsOf = (phone) => JSON.parse(phone.prefs.get("fuel-tracker-settings-v1") || "null");
async function addFill(page, { start, end, price, liters, unknown, full = true }) {
  if (unknown != null) { const box = page.locator("#unknownStart"); if ((await box.isChecked()) !== unknown) await box.click(); }
  if (start != null) await page.fill("#odoStart", String(start));
  await page.fill("#odoEnd", String(end));
  await page.fill("#price", String(price));
  await page.fill("#liters", String(liters));
  if ((await page.isChecked("#full")) !== full) await page.click("#full");
  await page.click("#saveBtn");
  await page.waitForTimeout(300);
}

console.log("bnzn on Capacitor's Android bridge");

for (const mode of ["start", "inline"]) {
  await check(`[${mode}] starts on the bridge under the CSP, first run saves to phone storage`, async () => {
    const phone = new Phone();
    const page = await open(phone, mode);
    assert(await page.evaluate(() => window.Capacitor.isNativePlatform() && window.Capacitor.getPlatform() === "android"), "not android");
    assert(await page.evaluate(() => window.Native.isNative && window.Native.platform === "android"), "Native not on the bridge");
    assert((await page.textContent("#storeStatus")).includes("Saved on this phone"), "store status: " + (await page.textContent("#storeStatus")));
    assert(await page.isVisible("#welcome"), "welcome hidden");
    await onboard(page);
    const s = settingsOf(phone);
    assert(s && s.onboarded && s.home === "MAD" && s.vehicles[0].name === "Logan", "settings not saved: " + JSON.stringify(s));
    const csp = await page.evaluate(() => window.__csp);
    assert(!csp.length, "CSP violations: " + csp.join(", "));
    assert(!page.errors.length, "page errors: " + page.errors.join(" | "));
    await close(page);
  });
}

await check("fill-ups save, comma decimals work, consumption shows after two full tanks", async () => {
  const phone = new Phone();
  let page = await open(phone);
  await onboard(page);
  await addFill(page, { end: "45000", price: "14,50", liters: "30", unknown: true });
  await addFill(page, { start: null, end: "45500", price: "14,50", liters: "35" });
  const recs = records(phone);
  assert(recs.length === 2, "records: " + recs.length);
  assert(recs[1].prevOdo === 45000 && recs[1].odo === 45500 && recs[1].price === 14.5, "second record: " + JSON.stringify(recs[1]));
  assert(phone.prefs.has("fuel-tracker-records-v1.bak1"), "no safety copy written");
  await page.click('nav button[data-tab="history"]');
  await page.waitForTimeout(600); // the widget refresh is debounced
  const rep = await page.textContent("#report");
  assert(rep.includes("7.00"), "report lacks 7.00 L/100: " + rep.slice(0, 200));
  assert(phone.widget && phone.widget.vehicle === "Logan" && Object.keys(phone.widget.months).length === 2, "widget: " + JSON.stringify(phone.widget));
  assert(!page.errors.length, "page errors: " + page.errors.join(" | "));
  await close(page);
});

await check("unusual numbers ask before saving; Check again keeps the form, Save anyway saves", async () => {
  const phone = new Phone();
  const page = await open(phone);
  await onboard(page);
  await addFill(page, { end: "45000", price: "14.5", liters: "30", unknown: true });
  await addFill(page, { end: "45400", price: "14.5", liters: "30" });
  await addFill(page, { end: "45800", price: "14.5", liters: "30" });
  await page.fill("#odoEnd", "48800");
  await page.fill("#price", "14.5"); await page.fill("#liters", "30");
  await page.click("#saveBtn");
  await page.waitForSelector("#askDialog[open]");
  await page.click('#askBtns button[data-i="0"]');
  await page.waitForTimeout(200);
  assert(records(phone).length === 3, "saved after Check again");
  assert((await page.inputValue("#odoEnd")) === "48800", "form lost");
  await page.click("#saveBtn");
  await page.waitForSelector("#askDialog[open]");
  await page.click('#askBtns button[data-i="1"]');
  await page.waitForTimeout(300);
  assert(records(phone).length === 4, "not saved after Save anyway");
  await close(page);
});

await check("back button closes a window, then goes to the fill-up tab, then minimizes with the draft kept", async () => {
  const phone = new Phone();
  let page = await open(phone);
  await onboard(page);
  assert(phone.listeners.some((l) => l.plugin === "App" && l.event === "backButton"), "no backButton listener");
  await page.click('nav button[data-tab="settings"]');
  await page.click("#addVeh");
  assert(await page.isVisible("#vehDialog"), "dialog not open");
  await page.sendEvent("App", "backButton", { canGoBack: false });
  await page.waitForTimeout(100);
  assert(!(await page.isVisible("#vehDialog")), "dialog still open");
  assert(await page.isVisible("#view-settings"), "left settings too early");
  await page.sendEvent("App", "backButton", { canGoBack: false });
  await page.waitForTimeout(100);
  assert(await page.isVisible("#view-home"), "not back on home");
  await page.fill("#odoEnd", "51234");
  await page.sendEvent("App", "backButton", { canGoBack: false });
  await page.waitForTimeout(200);
  assert(phone.count("App.minimizeApp") === 1, "minimizeApp calls: " + phone.count("App.minimizeApp"));
  await close(page);
  phone.reset();
  page = await open(phone);
  assert((await page.inputValue("#odoEnd")) === "51234", "draft not restored after the app was closed");
  await close(page);
});

await check("draft survives the app being backgrounded and reopened in the same WebView", async () => {
  const phone = new Phone();
  const page = await open(phone);
  await onboard(page);
  await page.fill("#odoEnd", "60000");
  await page.fill("#liters", "20");
  await page.sendEvent("App", "appStateChange", { isActive: false });
  await page.waitForTimeout(100);
  phone.reset();
  await page.reload();
  await page.waitForFunction(() => document.getElementById("storeStatus").dataset.i18n !== "loading");
  await page.waitForTimeout(400);
  assert((await page.inputValue("#odoEnd")) === "60000" && (await page.inputValue("#liters")) === "20", "draft not restored");
  assert((await page.textContent("#toastText")).includes("unsaved"), "no draft toast");
  await close(page);
});

await check("unreadable saved records: the newest readable safety copy is put back and the bad data kept", async () => {
  const phone = new Phone();
  let page = await open(phone);
  await onboard(page);
  await addFill(page, { end: "45000", price: "14.5", liters: "30", unknown: true });
  await addFill(page, { end: "45500", price: "14.5", liters: "35" });
  await close(page);
  phone.prefs.set("fuel-tracker-records-v1", '[{"kind":"fill",'); // cut off mid-write
  phone.reset();
  page = await open(phone);
  const recs = records(phone);
  assert(recs.length === 1, "restored records: " + recs.length + " (bak1 holds the list before the last save)");
  assert(phone.prefs.get("fuel-tracker-records-v1.unreadable") === '[{"kind":"fill",', "bad data not kept aside");
  assert((await page.textContent("#toastText")).includes("safety copy"), "no restore toast");
  await close(page);
});

await check("unreadable records with no safety copy: saving is blocked and nothing is overwritten", async () => {
  const phone = new Phone();
  let page = await open(phone);
  await onboard(page);
  await close(page);
  phone.prefs.set("fuel-tracker-records-v1", "{broken");
  phone.reset();
  page = await open(phone);
  assert((await page.textContent("#storeStatus")).includes("could not be read"), "status: " + (await page.textContent("#storeStatus")));
  await page.fill("#odoEnd", "1000"); await page.fill("#price", "10"); await page.fill("#liters", "10");
  assert(await page.isDisabled("#saveBtn"), "save allowed on broken storage");
  await page.sendEvent("App", "appStateChange", { isActive: false });
  assert(phone.prefs.get("fuel-tracker-records-v1") === "{broken", "records overwritten");
  const s = settingsOf(phone);
  assert(s && s.onboarded, "settings damaged");
  await close(page);
});

await check("scan: numbers that agree fill the form; a missing text model says so", async () => {
  const phone = new Phone();
  phone.cfg.ocr = "AFRIQUIA\nPRIX/L 14.25\nVOLUME 30.00 L\nMONTANT 427.50 DH";
  const page = await open(phone);
  await onboard(page);
  assert(await page.isVisible("#scanBtn"), "scan button hidden");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await page.setInputFiles("#scanFile", { name: "pump.png", mimeType: "image/png", buffer: png });
  await page.waitForFunction(() => document.getElementById("scanMsg").textContent && !/Reading/.test(document.getElementById("scanMsg").textContent), null, { timeout: 5000 });
  const msg = await page.textContent("#scanMsg");
  assert(/match/.test(msg), "scan message: " + msg);
  assert((await page.inputValue("#price")) === "14.25" && (await page.inputValue("#liters")) === "30", `fields: ${await page.inputValue("#price")} ${await page.inputValue("#liters")}`);
  await page.click("#scanDone");
  phone.cfg.ocrError = "UNAVAILABLE";
  await page.setInputFiles("#scanFile", { name: "pump.png", mimeType: "image/png", buffer: png });
  await page.waitForFunction(() => /getting ready/.test(document.getElementById("scanMsg").textContent), null, { timeout: 5000 });
  await close(page);
});

await check("scan button stays hidden on phones without the text model", async () => {
  const phone = new Phone();
  phone.cfg.scan = false;
  const page = await open(phone);
  await onboard(page);
  assert(!(await page.isVisible("#scanBtn")), "scan button visible");
  await close(page);
});

await check("reminders schedule notifications; refused permission turns price alerts back off", async () => {
  const phone = new Phone();
  const page = await open(phone);
  await onboard(page);
  await page.click('nav button[data-tab="tools"]');
  await page.click("#addRem");
  await page.selectOption("#rKind", "insurance");
  const d = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  await page.fill("#rDate", d);
  await page.click('#remForm button[type="submit"]');
  await page.waitForTimeout(1500);
  assert(phone.pending.length === 2 && phone.pending.every((n) => n.extra && n.extra.ft), "pending: " + JSON.stringify(phone.pending));
  phone.cfg.notif = "denied";
  await page.click("#priceAlerts");
  await page.waitForTimeout(300);
  assert(!(await page.isChecked("#priceAlerts")), "price alerts stayed on");
  assert((await page.textContent("#toastText")).includes("Notifications are off"), "no blocked toast");
  phone.cfg.notif = "granted";
  await page.click("#priceAlerts");
  await page.waitForTimeout(1500);
  assert(phone.pending.length === 14, "pending after price alerts: " + phone.pending.length);
  await close(page);
});

await check("widget link opens the form ready for the odometer, even on a cold start", async () => {
  const phone = new Phone();
  let page = await open(phone);
  await onboard(page);
  await page.click('nav button[data-tab="settings"]');
  await close(page);
  phone.cfg.launchUrl = "fueltracker://add";
  phone.reset();
  page = await open(phone);
  await page.waitForTimeout(500);
  assert(await page.isVisible("#view-home"), "not on home");
  assert(await page.evaluate(() => document.activeElement && document.activeElement.id === "odoEnd"), "odometer not focused: " + (await page.evaluate(() => document.activeElement && document.activeElement.id)));
  await close(page);
});

await check("electric car: labels switch to kWh and a charge saves with its unit", async () => {
  const phone = new Phone();
  const page = await open(phone);
  await onboard(page, { fuel: "electric" });
  assert((await page.textContent('label[for="liters"]')).includes("kWh"), "label: " + (await page.textContent('label[for="liters"]')));
  assert(!(await page.isVisible("#scanBtn")), "scan offered for a charge");
  await addFill(page, { end: "10000", price: "1.8", liters: "40", unknown: true });
  await addFill(page, { end: "10250", price: "1.8", liters: "40" });
  const recs = records(phone);
  assert(recs.length === 2 && recs.every((r) => r.unit === "kWh" && r.fuel === "electric"), "records: " + JSON.stringify(recs));
  const ins = await page.textContent("#insights");
  assert(ins.includes("kWh/100") && !ins.includes("L/100"), "insights not in kWh: " + ins);
  await close(page);
});

await check("dark theme sets the status bar, buzzes on save and paints dark on the next start", async () => {
  const phone = new Phone();
  let page = await open(phone);
  await onboard(page);
  await addFill(page, { end: "45000", price: "14.5", liters: "30", unknown: true });
  assert(phone.calls.some((c) => c.pluginId === "Haptics" && c.methodName === "notification"), "no haptic on save");
  await page.click('nav button[data-tab="settings"]');
  await page.click('label[for="theme-dark"]');
  await page.waitForTimeout(200);
  const bar = phone.calls.filter((c) => c.pluginId === "SystemBars" && c.methodName === "setStyle").pop();
  assert(bar && bar.options.style === "DARK", "status bar: " + JSON.stringify(bar));
  assert(settingsOf(phone).theme === "dark", "theme not saved");
  await close(page);
  page = await open(phone);
  assert((await page.evaluate(() => document.documentElement.dataset.theme)) === "dark", "not dark after restart");
  await close(page);
});

await check("odometer reset: a lower reading offers the reset, saves the distance typed and moves km reminders", async () => {
  const phone = new Phone();
  const page = await open(phone);
  await onboard(page);
  await addFill(page, { end: "99800", price: "14", liters: "30", unknown: true });
  await page.click('nav button[data-tab="tools"]');
  await page.click("#addRem");
  await page.fill("#rEvery", "10000"); await page.fill("#rLast", "95000");
  await page.click('#remForm button[type="submit"]');
  await page.click('nav button[data-tab="home"]');
  await page.fill("#odoEnd", "300");
  assert(await page.isVisible("#resetWrap"), "reset choice not offered");
  await page.click("#odoReset");
  await page.fill("#resetKm", "500");
  await page.fill("#price", "14"); await page.fill("#liters", "35");
  await page.click("#saveBtn");
  await page.waitForTimeout(300);
  if (await page.isVisible("#askDialog")) { await page.click('#askBtns button[data-i="1"]'); await page.waitForTimeout(300); }
  const r = records(phone)[1];
  assert(r && r.reset && r.meter === 1 && r.odo === 300 && r.prevOdo === -200, "record: " + JSON.stringify(r));
  const rem = settingsOf(phone).reminders[0];
  assert(rem.lastKm === 95000 + (-200 - 99800), "reminder lastKm " + rem.lastKm);
  await close(page);
});

await check("Arabic: right-to-left and no untranslated keys on any screen", async () => {
  const phone = new Phone();
  const page = await open(phone, "start", "ar-MA");
  await page.click('#welcomeInner button[data-lang="ar"]');
  await page.click('#welcomeInner button[data-w="next"]');
  await page.click('#welcomeInner button[data-cur="MAD"]');
  await page.waitForTimeout(300);
  assert(await page.evaluate(() => document.documentElement.dir === "rtl"), "not rtl");
  const raw = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.children.length === 0 && /^[a-z]+[A-Z][A-Za-z]+$/.test(e.textContent.trim())).map((e) => e.textContent.trim()));
  assert(!raw.length, "untranslated: " + raw.join(", "));
  await close(page);
});

await check("report a problem includes the version and recent errors, and licenses open", async () => {
  const phone = new Phone();
  const page = await open(phone);
  await onboard(page);
  await page.click('nav button[data-tab="settings"]');
  assert((await page.textContent("#aboutVersion")).includes("2.1.0"), "version: " + (await page.textContent("#aboutVersion")));
  await page.evaluate(() => setTimeout(() => { throw new Error("boom test"); }, 0));
  await page.waitForTimeout(100);
  await page.click("#problemBtn");
  const txt = await page.inputValue("#problemText");
  assert(txt.includes("bnzn 2.1.0 (21)") && txt.includes("boom test"), "report: " + txt);
  await page.click("#problemClose");
  await page.click("#licBtn");
  await page.waitForTimeout(300);
  const lic = await page.textContent("#licText");
  assert(lic.length > 200, "licenses: " + lic.slice(0, 80));
  await close(page);
});


const backupFile = (records, settings) => ({ name: "bnzn-backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ app: "fuel-tracker", format: 3, settings, records })) });
const fill = (id, prevOdo, odo, extra) => ({ kind: "fill", id, date: "2026-09-01", vehicle: "v1", prevOdo, odo, liters: 30, cost: 435, price: 14.5, currency: "MAD", full: true, missed: false, createdAt: 1, updatedAt: 1, ...extra });

await check("unreadable settings with no safety copy: new settings can be saved and the bad text is kept", async () => {
  const phone = new Phone();
  phone.prefs.set("fuel-tracker-settings-v1", "{cut off");
  const page = await open(phone);
  assert(await page.isVisible("#welcome"), "welcome hidden");
  await onboard(page);
  const s = settingsOf(phone);
  assert(s && s.onboarded && s.vehicles[0].name === "Logan", "settings not saved: " + phone.prefs.get("fuel-tracker-settings-v1"));
  assert(phone.prefs.get("fuel-tracker-settings-v1.unreadable") === "{cut off", "bad settings not kept aside");
  assert(!(await page.textContent("#toastText")).includes("not saved"), "save error shown");
  await close(page);
});

await check("settings that fail to load are never written over", async () => {
  const phone = new Phone();
  let page = await open(phone);
  await onboard(page);
  await addFill(page, { end: "45000", price: "14.5", liters: "30", unknown: true });
  await close(page);
  const before = phone.prefs.get("fuel-tracker-settings-v1");
  phone.cfg.failGet.add("fuel-tracker-settings-v1");
  phone.reset();
  page = await open(phone);
  await page.waitForTimeout(1200);
  phone.cfg.failGet.clear(); // the phone's storage answers again
  await page.click('nav button[data-tab="settings"]');
  await page.click('label[for="lang-fr"]');
  await page.click("#driverMode");
  await page.waitForTimeout(800);
  assert(phone.prefs.get("fuel-tracker-settings-v1") === before, "settings overwritten: " + phone.prefs.get("fuel-tracker-settings-v1"));
  await close(page);
});

await check("restoring a backup while records are unreadable keeps the file's settings, or the phone's own", async () => {
  const phone = new Phone();
  let page = await open(phone);
  await onboard(page);
  await close(page);
  phone.prefs.set("fuel-tracker-records-v1", "{broken");
  phone.reset();
  page = await open(phone);
  await page.click('nav button[data-tab="settings"]');
  const settings = { lang: "en", home: "EUR", vehicles: [{ id: "v1", name: "Restored", type: "car", fuel: "gasoil" }], onboarded: true, activeVehicle: "v1" };
  await page.setInputFiles("#importFile", backupFile([fill("a", 1000, 1000), fill("b", 1000, 1500)], settings));
  await page.waitForSelector("#askDialog[open]");
  await Promise.all([page.waitForEvent("load"), page.click('#askBtns button[data-i="0"]')]);
  await page.waitForTimeout(800);
  let s = settingsOf(phone);
  assert(records(phone).length === 2, "records: " + phone.prefs.get("fuel-tracker-records-v1"));
  assert(s.home === "EUR" && s.vehicles.length === 1 && s.vehicles[0].name === "Restored", "file settings lost: " + JSON.stringify(s));
  assert(phone.prefs.get("fuel-tracker-records-v1.unreadable") === "{broken", "bad records not kept aside");
  await close(page);
  // A bare list of records (version 1 data) has no settings: the phone keeps its own.
  phone.prefs.set("fuel-tracker-records-v1", "{broken again");
  phone.reset();
  page = await open(phone);
  assert((await page.textContent("#storeStatus")).includes("could not be read"), "not broken");
  await page.click('nav button[data-tab="settings"]');
  await page.setInputFiles("#importFile", { name: "old.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify([fill("c", 2000, 2000)])) });
  await page.waitForSelector("#askDialog[open]");
  await Promise.all([page.waitForEvent("load"), page.click('#askBtns button[data-i="0"]')]);
  await page.waitForTimeout(800);
  s = settingsOf(phone);
  assert(records(phone).length === 1, "records: " + phone.prefs.get("fuel-tracker-records-v1"));
  assert(s.home === "EUR" && s.vehicles[0].name === "Restored", "phone settings replaced: " + JSON.stringify(s));
  await close(page);
});

await check("adding a backup to mine keeps saved entries this version can't show", async () => {
  const phone = new Phone();
  let page = await open(phone);
  await onboard(page);
  await close(page);
  const vid = settingsOf(phone).activeVehicle;
  const future = { kind: "service", id: "s1", date: "2026-09-02", vehicle: vid, what: "tyres" };
  phone.prefs.set("fuel-tracker-records-v1", JSON.stringify([fill("a", 1000, 1000, { vehicle: vid }), future]));
  phone.reset();
  page = await open(phone);
  await page.click('nav button[data-tab="settings"]');
  await page.setInputFiles("#importFile", backupFile([fill("b", 1000, 1500, { vehicle: vid })], null));
  await page.waitForSelector("#askDialog[open]");
  await page.click('#askBtns button[data-i="1"]');
  await page.waitForTimeout(500);
  const recs = records(phone);
  assert(recs.length === 3 && recs.some((r) => r.id === "s1"), "records: " + JSON.stringify(recs));
  await close(page);
});

await check("a draft keeps the exchange rate that was typed for it", async () => {
  const phone = new Phone();
  const page = await open(phone);
  await onboard(page);
  await page.selectOption("#currency", "EUR");
  await page.fill("#rate", "11.2");
  await page.fill("#odoEnd", "45000");
  await page.sendEvent("App", "appStateChange", { isActive: false });
  await page.waitForTimeout(100);
  phone.reset();
  await page.reload();
  await page.waitForFunction(() => document.getElementById("storeStatus").dataset.i18n !== "loading");
  await page.waitForTimeout(400);
  assert((await page.inputValue("#currency")) === "EUR" && (await page.inputValue("#rate")) === "11.2", "rate: " + (await page.inputValue("#rate")));
  await close(page);
});

await check("editing a fill-up never turns it into an odometer reset", async () => {
  const phone = new Phone();
  const page = await open(phone);
  await onboard(page);
  await addFill(page, { end: "45000", price: "14.5", liters: "30", unknown: true });
  await addFill(page, { end: "45500", price: "14.5", liters: "30" });
  await page.click('nav button[data-tab="history"]');
  await page.click("#log li:first-child button[data-edit]");
  await page.fill("#odoEnd", "400");
  assert(!(await page.isVisible("#resetWrap")), "reset offered while editing");
  assert(await page.isDisabled("#saveBtn"), "lower reading can be saved");
  await close(page);
});

await check("trip meter: correcting one fill-up's kilometers keeps the kilometers typed for the later ones", async () => {
  const phone = new Phone();
  const page = await open(phone);
  await onboard(page);
  await page.click('nav button[data-tab="settings"]');
  await page.click("#vehList button[data-veh]");
  await page.click("#vTrip");
  await page.click("#vSave");
  await page.click('nav button[data-tab="home"]');
  const add = async (km) => {
    if (km != null) await page.fill("#sinceKm", String(km));
    await page.fill("#price", "14.5"); await page.fill("#liters", "30");
    await page.click("#saveBtn"); await page.waitForTimeout(300);
    if (await page.isVisible("#askDialog")) { await page.click('#askBtns button[data-i="1"]'); await page.waitForTimeout(300); }
  };
  await add(null);
  await add(300);
  await add(400);
  let recs = records(phone);
  assert(recs.length === 3 && recs[2].prevOdo === 300 && recs[2].odo === 700, "records: " + JSON.stringify(recs.map((r) => [r.prevOdo, r.odo])));
  await page.click('nav button[data-tab="history"]');
  await page.click("#log li:nth-child(2) button[data-edit]");
  assert((await page.inputValue("#sinceKm")) === "300", "edit shows " + (await page.inputValue("#sinceKm")));
  await page.fill("#sinceKm", "350");
  await page.click("#saveBtn"); await page.waitForTimeout(500);
  if (await page.isVisible("#askDialog")) { await page.click('#askBtns button[data-i="1"]'); await page.waitForTimeout(500); }
  recs = records(phone);
  const km = recs.map((r) => r.odo - r.prevOdo);
  assert(recs[1].odo === 350 && km.join() === "0,350,400" && recs[2].odo === 750, "after edit: " + JSON.stringify(recs.map((r) => [r.prevOdo, r.odo])));
  await close(page);
});

await check("a draft waits while the records can't be read, and comes back once they can", async () => {
  const phone = new Phone();
  let page = await open(phone);
  await onboard(page);
  await page.fill("#odoEnd", "70000");
  await page.sendEvent("App", "appStateChange", { isActive: false });
  await close(page);
  const good = phone.prefs.get("fuel-tracker-records-v1");
  phone.prefs.set("fuel-tracker-records-v1", "{broken");
  phone.reset();
  page = await open(phone);
  await page.sendEvent("App", "appStateChange", { isActive: false });
  await page.sendEvent("App", "backButton", { canGoBack: false });
  await close(page);
  phone.prefs.set("fuel-tracker-records-v1", good);
  phone.reset();
  page = await open(phone);
  assert((await page.inputValue("#odoEnd")) === "70000", "draft lost: " + (await page.inputValue("#odoEnd")));
  await close(page);
});

await check("two quick deletes both stick", async () => {
  const phone = new Phone();
  const page = await open(phone);
  await onboard(page);
  await addFill(page, { end: "45000", price: "14.5", liters: "30", unknown: true });
  await addFill(page, { end: "45500", price: "14.5", liters: "30" });
  await addFill(page, { end: "46000", price: "14.5", liters: "30" });
  await page.click('nav button[data-tab="history"]');
  await page.evaluate(() => { const b = document.querySelectorAll("#log button[data-del]"); b[0].click(); b[1].click(); });
  await page.waitForTimeout(600);
  const recs = records(phone);
  assert(recs.length === 1 && recs[0].odo === 45000, "left: " + JSON.stringify(recs.map((r) => r.odo)));
  await close(page);
});

await check("with unreadable records, changing a setting leaves the widget and the first-run screen alone", async () => {
  const phone = new Phone();
  let page = await open(phone);
  await onboard(page);
  await addFill(page, { end: "45000", price: "14.5", liters: "30", unknown: true });
  await close(page);
  phone.prefs.set("fuel-tracker-records-v1", "{broken");
  phone.widget = null;
  phone.reset();
  page = await open(phone);
  await page.click('nav button[data-tab="settings"]');
  await page.click("#driverMode");
  await page.waitForTimeout(700);
  assert(phone.count("FuelNative.refreshWidget") === 0, "widget redrawn with no records: " + JSON.stringify(phone.widget));
  assert(!(await page.isVisible("#welcome")), "first-run screen shown");
  assert(phone.prefs.get("fuel-tracker-records-v1") === "{broken", "records overwritten");
  await close(page);
});

await browser.close();
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
