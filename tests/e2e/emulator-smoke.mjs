// Installs the built APK on a running Android emulator and drives the real app through its WebView:
// first run, two fill-ups, every tab, dark mode kept across a restart, no crashes and no script errors.
// Run: node tests/e2e/emulator-smoke.mjs bnzn.apk   (needs adb, a booted emulator and the playwright package)
// Screenshots go to e2e-shots/.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const { _android } = require("playwright");
const PKG = "io.github.aelfqier.fueltracker";
const apk = process.argv[2] || "bnzn.apk";
const SHOTS = "e2e-shots";
mkdirSync(SHOTS, { recursive: true });

const adb = (...args) => execFileSync("adb", args, { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
async function step(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e && e.message).split("\n")[0]}`); }
}
function assert(ok, msg) { if (!ok) throw new Error(msg); }

const [device] = await _android.devices();
assert(device, "no Android device found");
console.log(`bnzn on ${device.model()} (Android emulator)`);

adb("install", "-r", apk);
adb("shell", "pm", "clear", PKG);
adb("logcat", "-c");

const errors = [];
async function launch() {
  adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1");
  const webview = await device.webView({ pkg: PKG }, { timeout: 60000 });
  const page = await webview.page();
  page.on("pageerror", (e) => errors.push(String(e && e.message)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.waitForSelector("#welcome, #view-home", { timeout: 30000 });
  return page;
}
const shot = (name) => device.screenshot({ path: `${SHOTS}/${name}.png` });

let page = await launch();

await step("first run: language, vehicle and currency", async () => {
  await page.waitForSelector('#welcomeInner button[data-lang="en"]', { timeout: 20000 });
  await sleep(800); await shot("01-welcome");
  await page.click('#welcomeInner button[data-lang="en"]');
  await page.fill("#wName", "Logan");
  await page.click('label[for="wf-essence"]');
  await page.click('#welcomeInner button[data-w="next"]');
  await page.click('#welcomeInner button[data-cur="MAD"]');
  await page.waitForSelector("#welcome", { state: "hidden" });
});

await step("the accent colour is electric blue", async () => {
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase());
  assert(["#1f6fff", "#3d8bff"].includes(accent), `accent is ${accent}`);
});

await step("two fill-ups save and the gauge shows the consumption", async () => {
  const unknown = page.locator("#unknownStart");
  if (await unknown.isVisible()) await unknown.check();
  await page.fill("#odoEnd", "45200"); await page.fill("#price", "14.5"); await page.fill("#liters", "30");
  await page.click("#saveBtn"); await sleep(800);
  if (await page.isVisible("#askBtns")) await page.click('#askBtns button[data-i="1"]');
  await page.fill("#odoEnd", "45650"); await page.fill("#price", "14.2"); await page.fill("#liters", "32");
  await sleep(500); await shot("02-form");
  await page.click("#saveBtn"); await sleep(800);
  if (await page.isVisible("#askBtns")) await page.click('#askBtns button[data-i="1"]');
  await page.waitForSelector("#insights .g-val");
  const v = (await page.textContent("#insights .g-val")).trim();
  assert(/^7[.,]1/.test(v), `gauge shows ${v}, expected 7.11`);
  await page.evaluate(() => window.scrollTo(0, 0)); await sleep(1500); await shot("03-home");
});

await step("every tab opens", async () => {
  for (const tab of ["history", "tools", "settings"]) {
    await page.click(`nav button[data-tab="${tab}"]`);
    assert(await page.isVisible(`#view-${tab}`), `${tab} not shown`);
    await sleep(1200); await shot(`04-${tab}`);
  }
  assert((await page.locator("#log li").count()) >= 2, "history log is missing fill-ups");
});

await step("dark mode is kept after the app is closed and reopened", async () => {
  await page.click('label[for="theme-dark"]'); await sleep(600);
  adb("shell", "am", "force-stop", PKG);
  await sleep(1500);
  page = await launch();
  await page.waitForSelector("#view-home");
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  assert(theme === "dark", `theme after restart: ${theme}`);
  assert((await page.locator("#log li").count()) >= 2, "fill-ups lost after restart");
  await sleep(1500); await shot("05-home-dark");
});

await step("no crash and no script errors", async () => {
  const log = adb("logcat", "-d", "-b", "crash");
  assert(!log.includes(PKG), "crash in logcat:\n" + log.slice(0, 500));
  assert(adb("shell", "pidof", PKG).trim(), "app is not running");
  assert(!errors.length, "script errors: " + errors.slice(0, 3).join(" | "));
});

await device.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
