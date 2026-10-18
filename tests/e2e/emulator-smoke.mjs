// Installs the built APK on a running Android emulator and drives the real app through its WebView:
// first run, two fill-ups, every tab, dark mode kept across a restart, no crashes and no script errors.
// It speaks the DevTools protocol straight to the WebView's page over adb (Android WebView doesn't support
// the browser-level commands Playwright and Puppeteer need), so only adb and Node 22 are required.
// Run: node tests/e2e/emulator-smoke.mjs bnzn.apk   (needs adb and a booted emulator)
// Screenshots, and logcat when something fails, go to e2e-shots/.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const PKG = "io.github.aelfqier.fueltracker";
const APP_URL = process.env.APP_URL || "https://localhost";
const apk = process.argv[2] || "bnzn.apk";
const SHOTS = "e2e-shots";
const LOCAL_PORT = process.env.CDP_PORT; // set to test against a desktop Chrome instead of the emulator
mkdirSync(SHOTS, { recursive: true });

const adb = (...args) => execFileSync("adb", args, { encoding: "utf8", timeout: 120000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(ok, msg) { if (!ok) throw new Error(msg); }
const within = (ms, what, p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`timed out: ${what}`)), ms))]);

// ---------- a minimal DevTools client for one page ----------
async function connect(port) {
  let target;
  for (let i = 0; i < 30 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === "page" && t.url.startsWith(APP_URL));
    } catch { /* not ready yet */ }
    if (!target) await sleep(1000);
  }
  assert(target, "no app page in the WebView");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await within(20000, "opening the DevTools connection", new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error("DevTools connection failed")); }));
  let id = 0;
  const waiting = new Map(), handlers = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, no } = waiting.get(msg.id); waiting.delete(msg.id);
      msg.error ? no(new Error(msg.error.message)) : ok(msg.result);
    } else if (msg.method) handlers.forEach((h) => h(msg));
  };
  const send = (method, params = {}) => within(30000, method, new Promise((ok, no) => {
    const n = ++id; waiting.set(n, { ok, no }); ws.send(JSON.stringify({ id: n, method, params }));
  }));
  return { send, on: (h) => handlers.push(h), close: () => ws.close() };
}

let cdp;
const errors = [];
async function ev(fn, ...args) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(fn, what, ms = 20000, ...args) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ev(fn, ...args)) return; await sleep(250); }
  throw new Error(`timed out waiting for ${what}`);
}
const visible = (sel) => ev((s) => { const e = document.querySelector(s); return !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length); }, sel);
async function click(sel) {
  await waitFor((s) => { const e = document.querySelector(s); return !!e && !!(e.offsetWidth || e.getClientRects().length); }, sel, 15000, sel);
  await ev((s) => { const e = document.querySelector(s); e.scrollIntoView({ block: "center" }); e.click(); }, sel);
  await sleep(250);
}
async function fill(sel, value) {
  await ev((s, v) => {
    const e = document.querySelector(s); e.focus(); e.value = v;
    e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true }));
  }, sel, value);
}
const text = (sel) => ev((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel);
const count = (sel) => ev((s) => document.querySelectorAll(s).length, sel);

async function shot(name) {
  if (LOCAL_PORT) {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(data, "base64"));
  } else writeFileSync(`${SHOTS}/${name}.png`, execFileSync("adb", ["exec-out", "screencap", "-p"], { timeout: 60000 }));
}

async function launch() {
  if (cdp) cdp.close();
  let port = LOCAL_PORT;
  if (!port) {
    adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1");
    // Wait for the app's WebView to open its DevTools socket (debug builds only), then forward it.
    // pidof exits non-zero until the process exists, and a cold start can take a while.
    const pidNow = () => { try { return adb("shell", "pidof", PKG).trim(); } catch { return ""; } };
    let sock = "";
    for (let i = 0; i < 120 && !sock; i++) {
      await sleep(500);
      const pid = pidNow();
      if (pid && adb("shell", "cat", "/proc/net/unix").includes(`webview_devtools_remote_${pid}`)) sock = `webview_devtools_remote_${pid}`;
    }
    assert(sock, "the app's WebView never opened (no DevTools socket)");
    port = "9333";
    adb("forward", `tcp:${port}`, `localabstract:${sock}`);
  }
  cdp = await connect(port);
  cdp.on((m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value || a.description).join(" "));
  });
  await cdp.send("Runtime.enable");
  if (LOCAL_PORT) await cdp.send("Page.reload");
  await waitFor(() => document.readyState === "complete" && !!window.FT && !!document.querySelector("nav.tabbar"), "the app to load", 30000);
}

let failed = 0;
async function step(name, fn) {
  try { await within(120000, name, fn()); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e && e.message).split("\n")[0]}`); }
}

try {
  if (!LOCAL_PORT) {
    adb("wait-for-device");
    console.log(`bnzn on ${adb("shell", "getprop", "ro.product.model").trim()}, Android ${adb("shell", "getprop", "ro.build.version.release").trim()} (emulator)`);
    adb("install", "-r", apk);
    adb("shell", "pm", "clear", PKG);
    adb("logcat", "-c");
  }
  await step("the app starts", () => launch());
  if (failed) throw new Error("stopping: the app never started");

  await step("first run: language, vehicle and currency", async () => {
    await sleep(800); await shot("01-welcome");
    await click('#welcomeInner button[data-lang="en"]');
    await fill("#wName", "Logan");
    await click('label[for="wf-essence"]');
    await click('#welcomeInner button[data-w="next"]');
    await click('#welcomeInner button[data-cur="MAD"]');
    await waitFor(() => { const w = document.querySelector("#welcome"); return !w || w.hidden || getComputedStyle(w).display === "none"; }, "the first-run screen to close");
  });

  await step("the accent colour is electric blue", async () => {
    const accent = await ev(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase());
    assert(["#1f6fff", "#3d8bff"].includes(accent), `accent is ${accent}`);
  });

  await step("two fill-ups save and the gauge shows the consumption", async () => {
    const answerAsk = async () => { await sleep(700); if (await visible("#askBtns button")) await click('#askBtns button[data-i="1"]'); };
    if (await visible("#unknownStart") && !(await ev(() => document.querySelector("#unknownStart").checked))) await click("#unknownStart");
    await fill("#odoEnd", "45200"); await fill("#price", "14.5"); await fill("#liters", "30");
    await click("#saveBtn"); await answerAsk();
    await fill("#odoEnd", "45650"); await fill("#price", "14.2"); await fill("#liters", "32");
    await sleep(500); await shot("02-form");
    await click("#saveBtn"); await answerAsk();
    await waitFor(() => !!document.querySelector("#insights .g-val"), "the gauge");
    const v = (await text("#insights .g-val")).trim();
    assert(/^7[.,]1/.test(v), `gauge shows ${v}, expected 7.11`);
    await ev(() => window.scrollTo(0, 0)); await sleep(1500); await shot("03-home");
  });

  await step("every tab opens", async () => {
    for (const tab of ["history", "tools", "settings"]) {
      await click(`nav button[data-tab="${tab}"]`);
      assert(await visible(`#view-${tab}`), `${tab} not shown`);
      await sleep(1200); await shot(`04-${tab}`);
    }
    assert((await count("#log li")) >= 2, "history log is missing fill-ups");
  });

  await step("dark mode is kept after the app is closed and reopened", async () => {
    await click('label[for="theme-dark"]'); await sleep(800);
    if (!LOCAL_PORT) { adb("shell", "am", "force-stop", PKG); await sleep(1500); }
    await launch();
    const theme = await ev(() => document.documentElement.dataset.theme);
    assert(theme === "dark", `theme after restart: ${theme}`);
    assert((await count("#log li")) >= 2, "fill-ups lost after restart");
    await sleep(1500); await shot("05-home-dark");
  });

  await step("no crash and no script errors", async () => {
    if (!LOCAL_PORT) {
      const log = adb("logcat", "-d", "-b", "crash");
      assert(!log.includes(PKG), "crash in logcat:\n" + log.slice(0, 500));
      let pid = ""; try { pid = adb("shell", "pidof", PKG).trim(); } catch { /* not running */ }
      assert(pid, "app is not running");
    }
    assert(cdp && (await ev(() => !!window.FT)), "the app page is not connected");
    assert(!errors.length, "script errors: " + errors.slice(0, 3).join(" | "));
  });
} catch (e) {
  failed++; console.log(`  FAIL ${String(e && e.message).split("\n")[0]}`);
} finally {
  if (cdp) cdp.close();
  if (failed && !LOCAL_PORT) { try { writeFileSync(`${SHOTS}/logcat.txt`, adb("logcat", "-d")); } catch { /* the emulator may be gone */ } }
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
