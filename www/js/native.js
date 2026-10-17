/* Fuel Tracker: phone features (files, sharing, notifications, scan, widget, print), with browser fallbacks. */
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
  const FuelNative = plugin("FuelNative"); // our own Android plugin: text recognition, widget, print

  function download(name, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // Writes a file and opens the share sheet (Drive, WhatsApp, email…). In a browser it downloads instead.
  async function saveFile(name, text, mime, title) {
    if (Filesystem && Share) {
      const { uri } = await Filesystem.writeFile({ path: name, data: text, directory: "CACHE", encoding: "utf8" });
      try { await Share.share({ title, dialogTitle: title, files: [uri] }); }
      catch (e) { if (!/cancel/i.test(String(e && e.message))) throw e; return false; }
      return true;
    }
    download(name, text, mime);
    return true;
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

  const canScan = !!FuelNative;
  async function recognize(base64) {
    const res = await FuelNative.recognizeText({ base64 });
    return res && typeof res.text === "string" ? res.text : "";
  }

  async function refreshWidget(summary) {
    if (!Preferences || !FuelNative) return;
    try {
      await Preferences.set({ key: "fuel-tracker-widget", value: JSON.stringify(summary) });
      await FuelNative.refreshWidget();
    } catch { /* the widget is a bonus; never block saving */ }
  }

  // Date reminders: one notification a week before and one on the day, at 9:00.
  const notifId = (s) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h) % 2000000000; };
  async function scheduleReminders(items) {
    if (!LocalNotifications) return;
    try {
      const pending = await LocalNotifications.getPending();
      const ours = (pending.notifications || []).filter((n) => n.extra && n.extra.ft);
      if (ours.length) await LocalNotifications.cancel({ notifications: ours.map((n) => ({ id: n.id })) });
      if (!items.length) return;
      let perm = await LocalNotifications.checkPermissions();
      if (perm.display !== "granted") perm = await LocalNotifications.requestPermissions();
      if (perm.display !== "granted") return;
      const now = Date.now();
      const list = [];
      for (const it of items) {
        for (const [suffix, when, body] of it.times) {
          if (when.getTime() > now) list.push({ id: notifId(it.id + suffix), title: it.title, body, schedule: { at: when, allowWhileIdle: true }, extra: { ft: 1 } });
        }
      }
      if (list.length) await LocalNotifications.schedule({ notifications: list });
    } catch { /* notifications are optional */ }
  }

  function onDeepLink(fn) {
    if (!App) return;
    try {
      App.addListener("appUrlOpen", (e) => fn(e && e.url));
      App.getLaunchUrl().then((r) => { if (r && r.url) fn(r.url); }).catch(() => {});
    } catch { /* ignore */ }
  }

  root.Native = { isNative, platform, Preferences, saveFile, printHtml, canScan, recognize, refreshWidget, scheduleReminders, onDeepLink };
})(typeof self !== "undefined" ? self : this);
