/* Fuel Tracker: phone features (files, sharing, notifications, scan, widget, print, back button), with browser fallbacks. */
(function (root) {
  "use strict";
  const cap = root.Capacitor;
  const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const platform = isNative && cap.getPlatform ? cap.getPlatform() : "web";
  const has = (name) => isNative && cap.isPluginAvailable && cap.isPluginAvailable(name);
  // The app has no JS bundler, so Capacitor's core (and its registerPlugin) isn't loaded: the Android and iOS
  // bridges put each plugin on Capacitor.Plugins instead. registerPlugin is used when a bundle provides it.
  const plugin = (name) => {
    if (!has(name)) return null;
    return typeof cap.registerPlugin === "function" ? cap.registerPlugin(name) : (cap.Plugins && cap.Plugins[name]) || null;
  };

  const Preferences = plugin("Preferences");
  const Filesystem = plugin("Filesystem");
  const Share = plugin("Share");
  const LocalNotifications = plugin("LocalNotifications");
  const App = plugin("App");
  const FuelNative = plugin("FuelNative"); // our own plugin: text recognition, widget, print, store review

  function download(name, data, mime) {
    const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: mime }));
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const cancelled = (e) => /cancel/i.test(String(e && e.message));

  // Writes a file and opens the share sheet (Drive, WhatsApp, email…). In a browser it downloads instead.
  async function saveFile(name, text, mime, title) {
    if (Filesystem && Share) {
      const { uri } = await Filesystem.writeFile({ path: name, data: text, directory: "CACHE", encoding: "utf8" });
      try { await Share.share({ title, dialogTitle: title, files: [uri] }); }
      catch (e) { if (!cancelled(e)) throw e; return false; }
      return true;
    }
    download(name, text, mime);
    return true;
  }

  // A picture (base64 PNG) with a line of text, for WhatsApp groups and the like.
  async function shareImage(name, base64, text, title) {
    if (Filesystem && Share) {
      const { uri } = await Filesystem.writeFile({ path: name, data: base64, directory: "CACHE" });
      try { await Share.share({ title, dialogTitle: title, text, files: [uri] }); }
      catch (e) { if (!cancelled(e)) throw e; return false; }
      return true;
    }
    // Decoded here rather than fetched as a data: URL, which the page's content security policy blocks.
    const bin = atob(base64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: "image/png" });
    const file = new File([blob], name, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ title, text, files: [file] }); } catch (e) { if (e && e.name !== "AbortError") throw e; return false; }
      return true;
    }
    download(name, blob, "image/png");
    return true;
  }

  async function shareText(text, title) {
    if (Share) {
      try { await Share.share({ title, dialogTitle: title, text }); } catch (e) { if (!cancelled(e)) throw e; return false; }
      return true;
    }
    if (navigator.share) {
      try { await navigator.share({ title, text }); } catch (e) { if (e && e.name !== "AbortError") throw e; return false; }
      return true;
    }
    return copyText(text);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* older WebViews: fall back below */ }
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }

  async function printHtml(html, name, title) {
    if (FuelNative) { await FuelNative.printHtml({ html, name }); return; }
    if (isNative) { await saveFile(name + ".html", html, "text/html", title); return; }
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0";
    document.body.appendChild(frame);
    frame.contentDocument.open(); frame.contentDocument.write(html); frame.contentDocument.close();
    await new Promise((r) => setTimeout(r, 250));
    frame.contentWindow.focus(); frame.contentWindow.print();
    setTimeout(() => frame.remove(), 1000);
  }

  // Android scans with Google Play services' text model, so phones without Play services can't scan.
  async function scanAvailable() {
    if (!FuelNative) return false;
    try { const r = await FuelNative.scanStatus(); return !!(r && r.available); } catch { return false; }
  }
  async function recognize(base64) {
    const res = await FuelNative.recognizeText({ base64 });
    return res && typeof res.text === "string" ? res.text : "";
  }

  let oldWidgetKeyCleared = false;
  async function refreshWidget(summary) {
    if (!FuelNative) return;
    try {
      await FuelNative.refreshWidget({ summary });
      // Older versions kept the widget text in the app's storage; the widget now has its own file.
      if (!oldWidgetKeyCleared && Preferences) { oldWidgetKeyCleared = true; await Preferences.remove({ key: "fuel-tracker-widget" }); }
    } catch { /* the widget is a bonus; never block saving */ }
  }

  // The store's own rating sheet. Google and Apple decide whether it actually shows.
  async function requestReview() {
    if (!FuelNative) return;
    try { await FuelNative.requestReview(); } catch { /* never matters */ }
  }

  /* ---------- notifications ---------- */
  const canNotify = !!LocalNotifications;
  // "granted" | "denied" | "prompt". With ask, shows the system question when it is still allowed to.
  async function notifPermission(ask) {
    if (!LocalNotifications) return "denied";
    try {
      let perm = await LocalNotifications.checkPermissions();
      if (ask && perm.display !== "granted" && perm.display !== "denied") perm = await LocalNotifications.requestPermissions();
      return perm.display === "granted" ? "granted" : perm.display === "denied" ? "denied" : "prompt";
    } catch { return "denied"; }
  }
  // Each item: { id, title, times: [[suffix, Date, body], …] }. Replaces everything bnzn scheduled before.
  // Reminders are inexact on purpose: a few minutes late is fine, and bnzn no longer asks for the exact-alarm permission.
  const notifId = (s) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h) % 2000000000; };
  let scheduling = Promise.resolve();
  function scheduleReminders(items) {
    // Saves can follow each other quickly; schedule one batch at a time so cancels and adds never interleave.
    scheduling = scheduling.then(() => doSchedule(items)).catch(() => {});
    return scheduling;
  }
  async function doSchedule(items) {
    if (!LocalNotifications) return;
    try {
      const pending = await LocalNotifications.getPending();
      const ours = (pending.notifications || []).filter((n) => n.extra && n.extra.ft);
      if (ours.length) await LocalNotifications.cancel({ notifications: ours.map((n) => ({ id: n.id })) });
      if (!items.length) return;
      if ((await notifPermission(true)) !== "granted") return;
      const now = Date.now();
      const list = [];
      for (const it of items) {
        for (const [suffix, when, body] of it.times) {
          if (when.getTime() > now) list.push({ id: notifId(it.id + suffix), title: it.title, body, schedule: { at: when, allowWhileIdle: true }, isExactNotification: false, extra: { ft: 1 } });
        }
      }
      if (list.length) await LocalNotifications.schedule({ notifications: list });
    } catch { /* notifications are optional */ }
  }

  /* ---------- app events ---------- */
  function onDeepLink(fn) {
    if (!App) return;
    try {
      App.addListener("appUrlOpen", (e) => fn(e && e.url));
      App.getLaunchUrl().then((r) => { if (r && r.url) fn(r.url); }).catch(() => {});
    } catch { /* ignore */ }
  }
  // iPhone "Log a fill-up" shortcut (Siri, Shortcuts, Action button).
  function onLaunchAction(fn) {
    if (!FuelNative || platform !== "ios") return;
    try {
      FuelNative.addListener("launchAction", (e) => fn(e && e.action));
      FuelNative.consumeLaunchAction().then((r) => { if (r && r.action) fn(r.action); }).catch(() => {});
    } catch { /* ignore */ }
  }
  // Android back button. Once a listener exists, Capacitor leaves the decision to us.
  function onBack(fn) {
    if (!App || platform !== "android") return;
    try { App.addListener("backButton", fn); } catch { /* ignore */ }
  }
  async function minimize() {
    if (App) { try { await App.minimizeApp(); } catch { /* ignore */ } }
  }
  function onPause(fn) {
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") fn(); });
    if (App) { try { App.addListener("appStateChange", (s) => { if (s && s.isActive === false) fn(); }); } catch { /* ignore */ } }
  }
  async function appInfo() {
    if (App) { try { const i = await App.getInfo(); return { version: i.version, build: i.build }; } catch { /* below */ } }
    return { version: "web", build: "" };
  }

  root.Native = {
    isNative, platform, Preferences, saveFile, shareImage, shareText, copyText, printHtml, scanAvailable, recognize, refreshWidget,
    requestReview, canNotify, notifPermission, scheduleReminders, onDeepLink, onLaunchAction, onBack, minimize, onPause, appInfo,
  };
})(typeof self !== "undefined" ? self : this);
