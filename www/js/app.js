/* Fuel Tracker: screens and storage. Calculations live in logic.js (FT), phone features in native.js (Native). */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Typed numbers accept a comma or a dot and Arabic-Indic digits. Kilometers and whole amounts read "45.650" as 45650.
  const WHOLE_FIELDS = new Set(["odoStart", "odoEnd", "sinceKm", "resetKm", "rEvery", "rLast", "tripKm", "budget", "incAmount"]);
  const num = (id) => FT.parseNum($(id).value, { integerish: WHOLE_FIELDS.has(id) });
  const radio = (name) => { const el = document.querySelector(`input[name="${name}"]:checked`); return el ? el.value : null; };
  const today = () => FT.isoDate(new Date());
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const COLORS = ["#d97a06", "#2f6fd0", "#2f8a5a", "#c0392b", "#7d4cc2", "#6b7785"];
  const CODE = /^[A-Z]{3}$/;
  const PRIVACY_URL = "https://aelfqier.github.io/fuel-tracker/privacy.html";
  // Where "Report a problem" sends its email. Until the owner sets an address, it opens the share sheet instead.
  const SUPPORT_EMAIL = "";

  /* ---------- error log: the last 50 errors stay on this phone, for "Report a problem" ---------- */
  const ERR_KEY = "bnzn-errors";
  function logError(where, err) {
    try {
      const e = err || {};
      const msg = String(e.message || e).slice(0, 300);
      const at = String(e.stack || "").split("\n").slice(1, 3).map((s) => s.trim()).join(" | ").slice(0, 300);
      const list = readErrors();
      list.push({ t: new Date().toISOString(), where, msg, at });
      localStorage.setItem(ERR_KEY, JSON.stringify(list.slice(-50)));
    } catch { /* logging must never break the app */ }
  }
  function readErrors() {
    try { const l = JSON.parse(localStorage.getItem(ERR_KEY) || "[]"); return Array.isArray(l) ? l : []; } catch { return []; }
  }
  window.addEventListener("error", (e) => logError("js", e.error || { message: `${e.message} (${String(e.filename || "").split("/").pop()}:${e.lineno})` }));
  window.addEventListener("unhandledrejection", (e) => logError("promise", e.reason));

  let records = [];
  let settings = FT.defaultSettings(guessLang());
  let store = null;
  let editingId = null;
  let editRec = null;
  let editingIncomeId = null;
  let firstLoad = true;
  let pricePrefill = null; // { price, date } that we put in the price field ourselves
  let calcL100 = null; // consumption the form would save, for the warnings before saving
  let currentTab = "home";

  /* ---------- language ---------- */
  function guessLang() {
    const l = (navigator.language || "en").slice(0, 2).toLowerCase();
    return l === "fr" || l === "ar" ? l : "en";
  }
  const LOCALES = { en: "en-US", fr: "fr-FR", ar: "ar-MA" };
  const fmtCache = new Map();
  function fmt(n, d) {
    const key = settings.lang + d;
    if (!fmtCache.has(key)) fmtCache.set(key, new Intl.NumberFormat(LOCALES[settings.lang] || "en-US", { minimumFractionDigits: d, maximumFractionDigits: d, numberingSystem: "latn" }));
    return fmtCache.get(key).format(n);
  }
  function t(key, vars) {
    const dict = I18N[settings.lang] || I18N.en;
    let s = dict[key] != null ? dict[key] : I18N.en[key] != null ? I18N.en[key] : key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ""));
    return s;
  }
  // Any currency works; the ones bnzn knows get a short local symbol, the rest show their code.
  const sym = (cur) => { const k = "sym" + cur; const s = t(k); return s === k ? String(cur) : s; };
  // Isolated so a minus sign stays in front of the number inside Arabic sentences.
  const money = (v, cur, d = 2) => `⁦${fmt(v, d)} ${sym(cur || settings.home)}⁩`;
  const monthName = (m, style = "short") => new Intl.DateTimeFormat(LOCALES[settings.lang], { month: style, timeZone: "UTC" }).format(new Date(Date.UTC(2020, m - 1, 1)));
  const dayLabel = (date) => { const [y, m, d] = date.split("-").map(Number); return `${d} ${monthName(m)} ${y}`; };
  function periodLabel(p) {
    switch (p.kind) {
      case "day": return `${p.d} ${monthName(p.m)} ${p.y}`;
      case "week": return t("weekLabel", { w: p.w, y: p.y });
      case "month": return `${monthName(p.m, "long")} ${p.y}`;
      case "quarter": return t("quarterLabel", { q: p.q, y: p.y });
      case "half": return t("halfLabel", { h: p.h, y: p.y });
      default: return String(p.y);
    }
  }
  function applyLang() {
    const lang = settings.lang;
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    fmtCache.clear(); curNameCache.clear();
    document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    document.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
    document.title = t("appName");
    renderStoreStatus();
    renderCurrencySelects();
    applyUnitLabels(formUnit());
    renderFormTexts();
    const lr = $("lang-" + lang); if (lr) lr.checked = true;
  }

  /* ---------- currencies ---------- */
  const TOP_CURRENCIES = ["MAD", "EUR", "USD", "GBP", "CAD", "CHF", "AED", "SAR", "QAR"];
  const curNameCache = new Map();
  function currencyName(code) {
    if (curNameCache.has(code)) return curNameCache.get(code);
    let name = t("cur" + code);
    if (name === "cur" + code) {
      name = code;
      try { const n = new Intl.DisplayNames([LOCALES[settings.lang] || "en-US"], { type: "currency" }).of(code); if (n && n !== code) name = `${n} (${code})`; } catch { /* old WebView: the code alone */ }
    }
    curNameCache.set(code, name);
    return name;
  }
  function otherCurrencies() {
    let all = [];
    try { all = Intl.supportedValuesOf("currency"); } catch { all = []; }
    return all.filter((c) => CODE.test(c) && !TOP_CURRENCIES.includes(c));
  }
  function renderCurrencySelects() {
    const used = [settings.home, ...Object.keys(settings.rates || {}), ...records.map((r) => r.currency)];
    const extra = [...new Set(used)].filter((c) => CODE.test(c) && !TOP_CURRENCIES.includes(c));
    const rest = otherCurrencies().filter((c) => !extra.includes(c));
    const opt = (c) => `<option value="${c}">${esc(currencyName(c))}</option>`;
    const html = TOP_CURRENCIES.concat(extra).map(opt).join("") + (rest.length ? `<optgroup label="${esc(t("allCurrencies"))}">${rest.map(opt).join("")}</optgroup>` : "");
    for (const id of ["currency", "homeCur", "wCur"]) {
      const sel = $(id); if (!sel) continue;
      const prev = sel.value || settings.home;
      sel.innerHTML = html;
      sel.value = CODE.test(prev) ? prev : settings.home;
    }
  }
  function ensureCurrencyOption(code) {
    if (!CODE.test(code) || [...$("currency").options].some((o) => o.value === code)) return;
    $("currency").insertAdjacentHTML("beforeend", `<option value="${code}">${esc(currencyName(code))}</option>`);
  }

  /* ---------- vehicles and energy ---------- */
  const vehicles = () => settings.vehicles;
  const vehicleById = (id) => vehicles().find((v) => v.id === id) || null;
  const vehName = (id) => { const v = vehicleById(id); return v ? v.name : id; };
  const vehColor = (id) => { const v = vehicleById(id); return (v && v.color) || COLORS[0]; };
  const fills = () => records.filter((r) => r.kind === "fill");
  const sortRecs = (a, b) => (a.date === b.date ? (a.createdAt || 0) - (b.createdAt || 0) : a.date < b.date ? -1 : 1);
  const recUnit = (r) => (r.unit === "kWh" ? "kWh" : "L");
  const unitOfVeh = (id) => FT.primaryUnit(vehicleById(id) || {});
  const fuelKey = (f) => (f === "gasoil" || f === "electric" || f === "hybrid" ? f : "essence");
  // The fuel a record is saved with: charging is "electric", a plug-in hybrid's fuel counts as petrol.
  const recFuel = (v, unit) => (unit === "kWh" ? "electric" : v && v.fuel === "gasoil" ? "gasoil" : "essence");
  // Electric cars charge, plug-in hybrids pick fuel or charge, everything else fills up.
  function formUnit() {
    const v = vehicleById(formVehicle());
    if (!v) return "L";
    if (v.fuel === "electric") return "kWh";
    return v.fuel === "hybrid" && radio("energy") === "kWh" ? "kWh" : "L";
  }
  const isTrip = () => { const v = vehicleById(formVehicle()); return !!(v && v.tripMeter); };
  // A plug-in hybrid keeps one chain per energy, so a charge starts from the last charge, not the last fuel stop.
  function lastFillFor(vehicle, unit) {
    const v = vehicleById(vehicle);
    const opts = { excludeId: editingId };
    if (v && v.fuel === "hybrid") opts.unit = unit;
    return FT.lastFill(records, vehicle, opts);
  }
  // Labels that change with the energy: "Liters filled" becomes "kWh charged", and so on.
  function applyUnitLabels(unit) {
    const k = unit === "kWh";
    document.querySelectorAll("[data-i18n-kwh]").forEach((el) => { el.textContent = t(k ? el.dataset.i18nKwh : el.dataset.i18n); });
    document.querySelectorAll(".eunit").forEach((el) => { el.textContent = k ? "kWh" : "L"; });
  }

  /* ---------- storage: phone storage in the app, a private account store when hosted, this browser otherwise ---------- */
  const REC_KEY = "fuel-tracker-records-v1"; // same key as version 1, records are migrated in place
  const SET_KEY = "fuel-tracker-settings-v1";
  const BAKS = [".bak1", ".bak2", ".bak3"];

  // One saved value with safety copies. A missing value reads as empty, but a value that can't be read is an error,
  // so a bad read is never written back over the history. Before each write the value being replaced goes to .bak1;
  // on the first write of a day the copies shift down first, so .bak2 and .bak3 keep earlier days.
  function guarded(key, readRaw, writeRaw, empty) {
    let current; // raw text known to be stored now; undefined until read
    const day = () => new Date().toISOString().slice(0, 10);
    const unstamp = (s) => { const i = typeof s === "string" ? s.indexOf("|") : -1; return i > 0 ? { at: s.slice(0, i), raw: s.slice(i + 1) } : null; };
    async function read() {
      const raw = await readRaw(key);
      if (raw == null) { current = null; return empty(); }
      let value;
      try { value = JSON.parse(raw); } catch { throw Object.assign(new Error("unreadable " + key), { corrupt: true, raw }); }
      current = raw;
      return value;
    }
    async function write(value, force) {
      // throws if what's stored can't be read; a forced write still keeps a copy of it when it can be fetched at all
      if (current === undefined) { if (force) current = await readRaw(key).catch(() => undefined); else await read(); }
      const raw = JSON.stringify(value);
      if (current != null && current !== raw) {
        const b1 = await readRaw(key + BAKS[0]);
        const old = unstamp(b1);
        if (old && old.at.slice(0, 10) !== day()) {
          const b2 = await readRaw(key + BAKS[1]);
          if (b2) await writeRaw(key + BAKS[2], b2);
          await writeRaw(key + BAKS[1], b1);
        }
        await writeRaw(key + BAKS[0], new Date().toISOString() + "|" + current);
      }
      await writeRaw(key, raw);
      current = raw;
    }
    // Puts back the newest safety copy that can be read. The unreadable value is kept aside, never deleted.
    async function recover(badRaw, accept) {
      let kept = false;
      try { await writeRaw(key + ".unreadable", badRaw); kept = true; } catch { /* keep trying the copies */ }
      for (const b of BAKS) {
        const c = unstamp(await readRaw(key + b).catch(() => null));
        if (!c) continue;
        let value;
        try { value = JSON.parse(c.raw); } catch { continue; }
        if (accept && !accept(value)) continue;
        await writeRaw(key, c.raw);
        current = c.raw;
        return { value, at: c.at };
      }
      // No copy to put back: with the bad value set aside, a new one may be written in its place.
      if (kept) current = null;
      return null;
    }
    return { read, write, recover };
  }

  let restoredAt = null; // set when the records had to be put back from a safety copy
  let storedRecords = []; // every saved entry, also those this version can't show, for "Add to mine"
  function listStore(kind, readRaw, writeRaw) {
    const recs = guarded(REC_KEY, readRaw, writeRaw, () => []);
    const sets = guarded(SET_KEY, readRaw, writeRaw, () => null);
    let cb = () => {};
    let broken = false; // the records couldn't be read: saving stays off so nothing is written over them
    let settingsRead = false; // settings are only written once what is saved could be read
    const read = async () => {
      if (broken) throw new Error("storage unavailable");
      const list = await recs.read();
      if (!Array.isArray(list)) throw Object.assign(new Error("records are not a list"), { corrupt: true, raw: JSON.stringify(list) });
      return list;
    };
    // While broken nothing was shown yet, and a forced restore reloads the page.
    const write = async (list, force) => { await recs.write(list, force); if (!broken) cb(list); };
    // One change at a time: two quick deletes must not both start from the same list, nor shuffle the safety copies.
    let queue = Promise.resolve();
    const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };
    return {
      kind,
      get broken() { return broken; },
      async subscribe(fn, onErr) {
        cb = fn;
        let list;
        for (let attempt = 1; ; attempt++) {
          try { list = await read(); break; } catch (e) {
            logError("records", e);
            if (e.corrupt) {
              const back = await recs.recover(e.raw, Array.isArray).catch(() => null);
              if (back) { list = back.value; restoredAt = back.at; break; }
            } else if (attempt < 3) { await new Promise((r) => setTimeout(r, 400)); continue; }
            broken = true; onErr(e); return;
          }
        }
        await fn(list);
      },
      async getSettings() {
        for (let attempt = 1; ; attempt++) {
          try { const v = await sets.read(); settingsRead = true; return v; } catch (e) {
            logError("settings", e);
            if (!e.corrupt) { if (attempt < 3) { await new Promise((r) => setTimeout(r, 400)); continue; } throw e; }
            const back = await sets.recover(e.raw).catch(() => null);
            settingsRead = true;
            return back ? back.value : null;
          }
        }
      },
      // force: a restored backup file brings its own settings.
      saveSettings: (s, force) => serial(async () => { if (broken || (!settingsRead && !force)) throw new Error("storage unavailable"); await sets.write(s, force); }),
      add: (rec) => serial(async () => { const list = await read(); list.push({ ...rec, id: rec.id || newId() }); await write(list); }),
      update: (id, rec) => serial(async () => {
        const list = await read();
        const i = list.findIndex((r) => r && r.id === id);
        if (i < 0) throw new Error("record not found");
        list[i] = { ...rec, id }; await write(list);
      }),
      remove: (id) => serial(async () => { await write((await read()).filter((r) => !r || r.id !== id)); }),
      // force: restoring a backup file is the way out when the saved records can't be read at all.
      replaceAll: (recs2, force) => serial(async () => {
        if (broken && !force) throw new Error("storage unavailable");
        await write(recs2.map((r) => ({ ...r, id: r.id || newId() })), force);
        broken = false;
      }),
    };
  }
  function localStore() {
    return listStore("local",
      async (k) => localStorage.getItem(k),
      async (k, v) => { try { localStorage.setItem(k, v); } catch { throw new Error("storage"); } });
  }
  function nativeStore(prefs) {
    return listStore("native",
      async (k) => {
        const { value } = await prefs.get({ key: k });
        if (value == null && (k === REC_KEY || k === SET_KEY)) { try { return localStorage.getItem(k); } catch { return null; } } // data from an older web version
        return value == null ? null : value;
      },
      (k, v) => prefs.set({ key: k, value: v }));
  }
  function dbStore(db, uid) {
    const col = db.collection("data/users/" + uid);
    let settingsDoc = null;
    const setDoc = async (id, data) => { const d = col.doc(id); if (d.set) await d.set(data); else { await d.delete(); await col.add(data); } };
    return {
      kind: "db",
      broken: false,
      subscribe(fn, onErr) {
        col.onSnapshot((snap) => {
          const docs = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
          settingsDoc = docs.find((d) => d.kind === "settings") || null;
          fn(docs.filter((r) => r.kind === "fill" || r.kind === "income"));
        }, onErr);
      },
      async getSettings() { return settingsDoc ? settingsDoc.data : null; },
      async saveSettings(s) { if (settingsDoc) await setDoc(settingsDoc.id, { kind: "settings", data: s }); else await col.add({ kind: "settings", data: s }); },
      async add(rec) { await col.add({ ...rec }); },
      async update(id, rec) { const { id: _drop, ...data } = rec; await setDoc(id, data); },
      async remove(id) { await col.doc(id).delete(); },
      async replaceAll(recs) {
        const snap = await new Promise((res) => { const off = col.onSnapshot((s) => { res(s); if (typeof off === "function") off(); }); });
        for (const d of snap.docs) if (d.data().kind !== "settings") await col.doc(d.id).delete();
        for (const r of recs) { const { id: _drop, ...data } = r; await col.add(data); }
      },
    };
  }

  async function initStore() {
    let s = null;
    if (Native.isNative && Native.Preferences) s = nativeStore(Native.Preferences);
    try {
      if (!s && window.claude && typeof window.claude.use === "function") {
        const [db, user] = await Promise.all([window.claude.use("db"), window.claude.use("user")]);
        const uid = user ? await user.id() : null;
        if (db && uid) s = dbStore(db, uid);
      }
    } catch { s = null; }
    if (!s) s = localStore();
    store = s;
    $("storeStatus").dataset.i18n = s.kind === "db" ? "storeDb" : s.kind === "native" ? "storeNative" : "storeLocal";
    renderStoreStatus();
    await s.subscribe(async (list) => {
      const migrated = list.map(FT.migrateRecord);
      storedRecords = migrated.filter((r) => r && typeof r === "object");
      records = migrated.map(FT.sanitizeRecord).filter(Boolean);
      if (firstLoad) {
        let saved = null, settingsOk = true;
        try { saved = await s.getSettings(); } catch { settingsOk = false; }
        settings = FT.migrateSettings(saved, records, guessLang());
        applyLang();
        // Version 1 records get their new fields written back once (every record kept, readable or not).
        if (list.some((r, i) => r && migrated[i] && migrated[i].kind && r.kind !== migrated[i].kind)) { try { await s.replaceAll(migrated.filter((r) => r && typeof r === "object")); } catch {} }
        if (settingsOk) { try { await s.saveSettings(settings); } catch (e) { logError("settings", e); } }
      }
      onData();
    }, async () => {
      $("storeStatus").dataset.i18n = "storeError";
      // The settings may still be readable: the user's language, kept by a restore file that has none.
      try { const saved = await s.getSettings(); if (saved) { settings = FT.migrateSettings(saved, [], guessLang()); applyLang(); } } catch { /* defaults then */ }
      renderStoreStatus(); renderCalc();
    });
  }

  function renderStoreStatus() {
    const el = $("storeStatus"), k = el.dataset.i18n;
    el.innerHTML = (k === "storeDb" || k === "storeNative" ? "<b>●</b> " : "") + esc(t(k));
  }

  async function saveSettings() {
    try { await store.saveSettings(settings); } catch (e) { logError("settings", e); toast(t("errSave")); }
    if (!firstLoad) onData(); // records still loading or unreadable: nothing to redraw, and the widget keeps its numbers
  }

  /* ---------- toast with undo ---------- */
  let toastTimer = null;
  function toast(text, action, fn) {
    $("toastText").textContent = text;
    const b = $("toastBtn");
    b.hidden = !action; b.textContent = action || "";
    b.onclick = () => { $("toast").hidden = true; if (fn) fn(); };
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, action ? 6000 : 3500);
  }
  function ask(title, text, buttons) {
    return new Promise((resolve) => {
      const d = $("askDialog");
      $("askTitle").textContent = title; $("askText").textContent = text;
      $("askBtns").innerHTML = buttons.map((b, i) => `<button type="button" data-i="${i}" class="${b.cls || ""}">${esc(b.label)}</button>`).join("");
      $("askBtns").onclick = (e) => { const x = e.target.closest("button"); if (!x) return; d.onclose = null; d.close(); resolve(buttons[+x.dataset.i].value); };
      d.onclose = () => resolve(null);
      d.showModal();
    });
  }

  /* ---------- tabs and the back button ---------- */
  function switchTab(name) {
    const was = document.querySelector('nav.tabbar button[aria-current="page"]');
    if (was && was.dataset.tab !== name) Native.haptic("tap");
    currentTab = name;
    for (const v of ["home", "history", "tools", "settings"]) $("view-" + v).hidden = v !== name;
    document.querySelectorAll("nav.tabbar button").forEach((b) => b.setAttribute("aria-current", b.dataset.tab === name ? "page" : "false"));
    window.scrollTo(0, 0);
  }
  document.querySelector("nav.tabbar").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) switchTab(b.dataset.tab); });

  // Android back: close an open window first, then go back to the fill-up screen, then leave bnzn running in the
  // background (like the home button), so a half-typed fill-up is still there when the user comes back.
  Native.onBack(() => {
    const open = [...document.querySelectorAll("dialog[open]")].pop();
    if (open) { open.close(); return; }
    if (!$("welcome").hidden && wStep > 0) { readWelcome(); wStep--; renderWelcome(); return; }
    if ($("welcome").hidden && currentTab !== "home") { switchTab("home"); return; }
    saveDraft();
    Native.minimize();
  });

  /* ================= FIRST RUN ================= */
  let wStep = 0;
  const wDraft = { name: "", type: "car", fuel: "essence", home: "MAD" };
  const FUELS = ["essence", "gasoil", "electric", "hybrid"];
  function renderWelcome() {
    const el = $("welcomeInner");
    const steps = `<div class="steps">${[0, 1, 2].map((i) => `<span class="${i <= wStep ? "on" : ""}"></span>`).join("")}</div>`;
    const chev = `<svg class="chev"><use href="#i-chevron"/></svg>`;
    const choice = (attr, badge, label) => `<button type="button" ${attr}><span class="bc-ico">${badge}</span><span>${label}</span>${chev}</button>`;
    if (wStep === 0) {
      el.innerHTML = `<div class="w-hero"><div class="logo"><svg><use href="#i-logo"/></svg></div>
        <h1>${esc(t("appName"))}</h1>
        <p class="lead">${esc(t("welcomeLead"))}</p></div>
        <ul class="promise"><li><svg><use href="#i-check"/></svg>${esc(t("p1"))}</li><li><svg><use href="#i-check"/></svg>${esc(t("p2"))}</li><li><svg><use href="#i-check"/></svg>${esc(t("p3"))}</li></ul>
        ${steps}
        <h2>${esc(t("wLang"))}</h2>
        <div class="bigchoice">
          ${choice('data-lang="fr"', "FR", "Français")}
          ${choice('data-lang="ar"', "ع", "العربية")}
          ${choice('data-lang="en"', "EN", "English")}
        </div>`;
    } else if (wStep === 1) {
      el.innerHTML = `${steps}<div class="w-step"><h2>${esc(t("wVehicle"))}</h2><p class="hint">${esc(t("wVehicleHint"))}</p></div>
        <div class="seg cards"><input type="radio" name="wType" id="wt-car" value="car" ${wDraft.type === "car" ? "checked" : ""}><label for="wt-car"><svg><use href="#i-car"/></svg>${esc(t("car"))}</label><input type="radio" name="wType" id="wt-bike" value="bike" ${wDraft.type === "bike" ? "checked" : ""}><label for="wt-bike"><svg><use href="#i-bike"/></svg>${esc(t("bike"))}</label></div>
        <div class="field"><label for="wName">${esc(t("vName"))}</label><div class="inp"><input id="wName" class="plain" type="text" maxlength="40" placeholder="${esc(t("vNamePh"))}" value="${esc(wDraft.name)}"></div></div>
        <div class="field"><span class="flabel">${esc(t("fuelType"))}</span><div class="seg two">${FUELS.map((f) => `<input type="radio" name="wFuel" id="wf-${f}" value="${f}" ${wDraft.fuel === f ? "checked" : ""}><label for="wf-${f}">${esc(t(f))}</label>`).join("")}</div></div>
        <div class="btnrow"><button type="button" data-w="back">${esc(t("back"))}</button><button type="button" class="primary" data-w="next">${esc(t("next"))}</button></div>`;
    } else {
      el.innerHTML = `${steps}<div class="w-step"><h2>${esc(t("wCurrency"))}</h2><p class="hint">${esc(t("wCurrencyHint"))}</p></div>
        <div class="bigchoice">
          ${choice('data-cur="MAD"', "DH", esc(t("curMAD")))}
          ${choice('data-cur="EUR"', "€", esc(t("curEUR")))}
          ${choice('data-cur="USD"', "$", esc(t("curUSD")))}
        </div>
        <div class="field"><label for="wCur">${esc(t("wOtherCur"))}</label><div class="inp"><select id="wCur"></select></div></div>
        <button type="button" data-w="cur">${esc(t("next"))}</button>
        <div class="btnrow"><button type="button" data-w="back">${esc(t("back"))}</button></div>`;
      renderCurrencySelects();
      $("wCur").value = "GBP";
    }
  }
  $("welcomeInner").addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.lang) { settings.lang = b.dataset.lang; applyLang(); wStep = 1; renderWelcome(); return; }
    if (b.dataset.w === "back") { readWelcome(); wStep--; renderWelcome(); return; }
    if (b.dataset.w === "next") { readWelcome(); wStep = 2; renderWelcome(); return; }
    const cur = b.dataset.cur || (b.dataset.w === "cur" ? $("wCur").value : null);
    if (cur && CODE.test(cur)) {
      readWelcome();
      const id = newId();
      settings.home = cur;
      settings.rates = FT.defaultRates(settings.home);
      settings.vehicles = [{ id, name: wDraft.name.trim() || t(wDraft.type === "bike" ? "bike" : "car"), type: wDraft.type, fuel: wDraft.fuel, tank: null, color: COLORS[0], tripMeter: false }];
      settings.activeVehicle = id;
      settings.onboarded = true;
      $("welcome").hidden = true;
      renderCurrencySelects();
      $("currency").value = settings.home;
      await saveSettings();
      $("odoEnd").focus();
    }
  });
  function readWelcome() {
    if (wStep !== 1) return;
    wDraft.name = $("wName").value; wDraft.type = radio("wType") || "car"; wDraft.fuel = radio("wFuel") || "essence";
  }

  /* ================= HOME: FILL-UP FORM ================= */
  function renderVehChips() {
    const cur = settings.activeVehicle;
    $("vehChips").innerHTML = vehicles().map((v) => `<input type="radio" name="veh" id="veh-${esc(v.id)}" value="${esc(v.id)}" ${v.id === cur ? "checked" : ""}><label for="veh-${esc(v.id)}"><span class="dot" style="--vc:${esc(v.color || COLORS[0])}"></span>${esc(v.name)}</label>`).join("");
    $("vehChips").hidden = vehicles().length < 2;
  }
  const formVehicle = () => radio("veh") || settings.activeVehicle;

  function prefill() {
    if (editingId) return;
    const vid = formVehicle();
    const v = vehicleById(vid);
    const unit = formUnit();
    const last = lastFillFor(vid, unit);
    const first = !last;
    $("unknownWrap").hidden = !first;
    $("odoReset").checked = false; $("resetKm").value = "";
    if (first) {
      if (!$("unknownStart").dataset.touched) $("unknownStart").checked = true;
      $("odoStart").value = "";
      $("odoStartHint").textContent = t(unit === "kWh" ? "hintFirstCharge" : "hintFirst");
    } else {
      $("unknownStart").checked = false;
      $("odoStart").value = last.odo;
      $("odoStartHint").textContent = t(unit === "kWh" ? "hintFromLastCharge" : "hintFromLast", { date: dayLabel(last.date) });
    }
    // Price: the last price paid for this energy, in the currency shown.
    const fuel = recFuel(v, unit);
    const cur = $("currency").value;
    const same = fills().filter((r) => (r.fuel || "essence") === fuel && recUnit(r) === unit && r.currency === cur).sort(sortRecs).pop();
    if (same) { $("price").value = same.price; pricePrefill = { price: same.price, date: same.date }; }
    else { $("price").value = ""; pricePrefill = null; }
    renderStations();
  }

  function renderStations() {
    const names = FT.stationNames(fills());
    const brands = ["Afriquia", "TotalEnergies", "Shell", "Winxo", "Petrom", "Ziz", "OLA Energy"];
    const all = [...names, ...brands.filter((b) => !names.some((n) => n.toLowerCase() === b.toLowerCase()))];
    $("stationList").innerHTML = all.map((n) => `<option value="${esc(n)}"></option>`).join("");
  }

  // Trip-meter vehicles have no odometer: kilometers typed since the last fill are added to a running total.
  function tripBase() {
    if (editingId && editRec) return editRec.prevOdo;
    const last = lastFillFor(formVehicle(), formUnit());
    return last ? last.odo : 0;
  }
  const resetOn = () => !$("resetWrap").hidden && $("odoReset").checked;
  // What the form describes: odoStart/odoEnd are what computeFuel needs, odo/prevOdo what gets saved.
  function readForm() {
    const unknownStart = !$("unknownWrap").hidden && $("unknownStart").checked;
    const base = { price: num("price"), mode: radio("mode"), liters: num("liters"), amount: num("amount"), unknownStart };
    if (isTrip()) {
      const start = tripBase();
      const end = unknownStart ? start : start + num("sinceKm");
      return { ...base, odoStart: start, odoEnd: end, odo: end, prevOdo: unknownStart ? end : start, reset: false };
    }
    const odoEnd = num("odoEnd");
    if (resetOn()) {
      // After a rollover or a new dashboard the reading starts over, so the distance is typed instead.
      const km = num("resetKm");
      return { ...base, unknownStart: false, odoStart: 0, odoEnd: km, odo: odoEnd, prevOdo: odoEnd - km, reset: true };
    }
    const odoStart = num("odoStart");
    return { ...base, odoStart, odoEnd, odo: odoEnd, prevOdo: unknownStart ? odoEnd : odoStart, reset: false };
  }

  function renderRate() {
    const cur = $("currency").value;
    const show = cur !== settings.home;
    $("rateField").hidden = !show;
    document.querySelectorAll(".homecur").forEach((el) => (el.textContent = sym(settings.home)));
    if (show) {
      $("rateLabel").textContent = t("rateLabel", { cur: sym(cur), home: sym(settings.home) });
      if (!$("rate").value || $("rate").dataset.cur !== cur) { $("rate").value = settings.rates[cur] || ""; $("rate").dataset.cur = cur; }
    }
  }

  function renderPriceStale() {
    const el = $("priceStale");
    const date = $("date").value || today();
    const stale = pricePrefill && formUnit() === "L" && $("currency").value === "MAD" && num("price") === pricePrefill.price ? FT.priceMayBeStale(pricePrefill.date, date) : null;
    el.hidden = !stale || !!editingId;
    if (stale) el.textContent = t("priceStale", { change: dayLabel(stale), price: money(pricePrefill.price, "MAD"), date: dayLabel(pricePrefill.date) });
  }

  function renderFormTexts() {
    $("formTitle").textContent = t(editingId ? "editFill" : "addFill");
    $("saveBtn").textContent = t(editingId ? "update" : "saveFill");
  }

  function renderCalc() {
    const mode = radio("mode");
    const cur = $("currency").value;
    const v = vehicleById(formVehicle());
    const unit = formUnit();
    const u = unit === "kWh" ? "kWh" : "L";
    applyUnitLabels(unit);
    $("energySeg").hidden = !(v && v.fuel === "hybrid");
    $("scanBtn").hidden = !scanReady || unit === "kWh";
    document.querySelectorAll(".cur").forEach((el) => (el.textContent = sym(cur)));
    $("litersField").hidden = mode !== "liters";
    $("moneyField").hidden = mode !== "money";

    // Distance: odometer readings, or kilometers typed for trip-meter vehicles, or a reset odometer.
    const trip = isTrip();
    const unknown = !$("unknownWrap").hidden && $("unknownStart").checked;
    $("odoRow").hidden = trip; $("sinceField").hidden = !trip;
    $("sinceKm").disabled = unknown;
    const s = num("odoStart"), en = num("odoEnd");
    const editReset = !!(editingId && editRec && editRec.reset);
    // An edit can't start a new odometer count: the readings saved after it belong to the old one.
    const showReset = !trip && !unknown && (editingId ? editReset : $("odoReset").checked || (s >= 0 && en >= 0 && en < s));
    $("resetWrap").hidden = !showReset;
    $("odoReset").disabled = editReset;
    const resetting = showReset && $("odoReset").checked;
    $("resetKmField").hidden = !resetting;
    if (resetting && !$("resetKm").value && !editingId) { const g = FT.rolloverGuess(s, en); if (g) $("resetKm").value = g; }
    $("odoStart").disabled = unknown || resetting;

    $("r-totlbl").textContent = mode === "money" ? t(unit === "kWh" ? "kwhBought" : "litersBought") : t("totalCost");
    renderRate(); renderPriceStale();
    const f = readForm();
    const r = FT.computeFuel(f);
    const needRate = cur !== settings.home && !(num("rate") > 0);
    let err = r.error || (f.reset && !(f.odo >= 0) ? "errOdoNow" : null) || (needRate ? "errRate" : null);
    if (err === "errOdoOrder" && showReset) err = "errOdoOrderReset";
    if (err === "errOdoNow" && trip) err = "errSinceKm";
    $("calcMsg").hidden = !err; $("calcOut").hidden = !!err;
    $("saveBtn").disabled = !!err || !store || store.broken || !$("date").value || !formVehicle();
    calcL100 = null;
    if (err) { $("calcMsg").textContent = t(err); return; }

    const full = $("full").checked, missed = $("missed").checked;
    let dist = r.distance, lit = r.liters, cost = r.cost, note = "";
    const sameUnit = fills().filter((p) => recUnit(p) === unit);
    const pend = !editingId && full && !missed ? FT.pendingSinceFull(sameUnit, formVehicle()) : [];
    if (pend.length) {
      dist += pend.reduce((a, p) => a + Math.max(0, p.odo - p.prevOdo), 0);
      lit += pend.reduce((a, p) => a + p.liters, 0);
      const pc = pend.filter((p) => p.currency === cur).reduce((a, p) => a + p.cost, 0);
      cost += pc;
      note = t("noteIncludes", { n: pend.length });
    }
    const showCons = full && !missed && dist > 0;
    if (showCons) calcL100 = lit / dist * 100;
    if (!full) note = t(unit === "kWh" ? "notePartialCharge" : "notePartial");
    else if (missed) note = t("noteMissed");
    else if (f.unknownStart) note = t(unit === "kWh" ? "noteFirstCharge" : "noteFirst");
    $("r-l100").innerHTML = showCons ? `${fmt(lit / dist * 100, 2)}<small>${u}/100 km</small>` : "–";
    $("r-note").textContent = note; $("r-note").hidden = !note;
    const dash = (html) => (showCons ? html : "–");
    $("r-l1").innerHTML = dash(`${fmt(lit / dist, 3)}<small>${u}</small>`);
    $("r-kml").innerHTML = dash(`${fmt(dist / lit, 1)}<small>km/${u}</small>`);
    $("r-c100").innerHTML = dash(`${fmt(cost / dist * 100, 2)}<small>${esc(sym(cur))}</small>`);
    $("r-c1").innerHTML = dash(`${fmt(cost / dist, 2)}<small>${esc(sym(cur))}</small>`);
    $("r-dist").innerHTML = `${fmt(r.distance, 0)}<small>km</small>`;
    $("r-tot").innerHTML = mode === "money" ? `${fmt(r.liters, 2)}<small>${u}</small>` : `${fmt(r.cost, 2)}<small>${esc(sym(cur))}</small>`;
  }

  function resetForm(keepOdo) {
    editingId = null; editRec = null;
    renderFormTexts();
    $("cancelEdit").hidden = true;
    for (const id of ["odoEnd", "sinceKm", "resetKm", "liters", "amount", "station"]) $(id).value = "";
    $("full").checked = true; $("missed").checked = false; $("odoReset").checked = false;
    $("date").value = today();
    if (!keepOdo) $("odoStart").value = "";
    clearDraft();
    prefill(); renderCalc();
  }

  function startEdit(rec) {
    if (rec.kind === "income") { startEditIncome(rec); return; }
    editingId = rec.id; editRec = rec;
    switchTab("home");
    renderFormTexts();
    $("cancelEdit").hidden = false;
    const el = $("veh-" + rec.vehicle); if (el) el.checked = true;
    (recUnit(rec) === "kWh" ? $("en-k") : $("en-l")).checked = true;
    ensureCurrencyOption(rec.currency);
    $("date").value = rec.date; $("currency").value = rec.currency;
    $("rate").value = rec.rate || ""; $("rate").dataset.cur = rec.currency;
    const startPoint = rec.prevOdo === rec.odo;
    $("unknownWrap").hidden = !startPoint; $("unknownStart").checked = startPoint;
    $("odoStart").value = rec.reset ? "" : rec.prevOdo; $("odoEnd").value = rec.odo; $("odoStartHint").textContent = "";
    $("sinceKm").value = startPoint ? "" : rec.odo - rec.prevOdo;
    $("odoReset").checked = !!rec.reset; $("resetKm").value = rec.reset ? rec.odo - rec.prevOdo : "";
    $("mode-l").checked = true; $("liters").value = rec.liters; $("price").value = rec.price; pricePrefill = null;
    $("station").value = rec.station || "";
    $("full").checked = rec.full !== false; $("missed").checked = !!rec.missed;
    renderCalc();
    $("form").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  $("form").addEventListener("input", (e) => {
    if (e.target.name === "veh") { settings.activeVehicle = e.target.value; if (!editingId) prefill(); renderInsights(); saveSettingsQuiet(); }
    if (e.target.name === "energy" && !editingId) prefill();
    if (e.target.id === "unknownStart") e.target.dataset.touched = "1";
    if (e.target.id === "currency" && !editingId) prefill();
    $("saveMsg").hidden = true;
    renderCalc();
    saveDraftSoon();
  });
  $("form").addEventListener("change", renderCalc);
  $("cancelEdit").addEventListener("click", () => resetForm());

  // Words for the checks that run before saving unusual numbers.
  function warnText(w, unit) {
    const x = w.vars || {};
    switch (w.key) {
      case "warnDistance": return t("warnDistance", { km: fmt(x.km, 0), usual: fmt(x.usual, 0) });
      case "warnConsumption": return t("warnConsumption", { value: fmt(x.value, 1), unit: x.unit === "kWh" ? "kWh" : "L" });
      case "warnTank": return t("warnTank", { liters: fmt(x.liters, 1), tank: fmt(x.tank, 0) });
      case "warnPrice": return t("warnPrice", { price: money(x.price, x.currency), unit });
      default: return t(w.key);
    }
  }

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!store || store.broken) return;
    const f = readForm(); const r = FT.computeFuel(f);
    if (r.error || (f.reset && !(f.odo >= 0))) return;
    const cur = $("currency").value;
    const vid = formVehicle(); const v = vehicleById(vid); const unit = formUnit();
    const old = editingId ? records.find((x) => x.id === editingId) : null;
    const now = Date.now();
    const rec = {
      kind: "fill", date: $("date").value, vehicle: vid, prevOdo: f.prevOdo, odo: f.odo,
      liters: +r.liters.toFixed(3), cost: +r.cost.toFixed(2), price: f.price, currency: cur,
      full: $("full").checked, missed: $("missed").checked, station: $("station").value.trim(), fuel: recFuel(v, unit),
      createdAt: old ? old.createdAt : now, updatedAt: now,
    };
    if (unit === "kWh") rec.unit = "kWh";
    if (cur !== settings.home) { rec.rate = num("rate"); rec.rateHome = settings.home; settings.rates[cur] = rec.rate; }
    // Which odometer count this reading belongs to; a reset starts the next one.
    const before = FT.lastFill(records, vid, { excludeId: editingId });
    if (old) { if (old.meter) rec.meter = old.meter; if (old.reset) rec.reset = true; }
    else if (f.reset) { rec.meter = ((before && before.meter) || 0) + 1; rec.reset = true; }
    else if (before && before.meter) rec.meter = before.meter;

    const hist = fills().filter((x) => x.vehicle === vid && x.id !== editingId && recUnit(x) === unit);
    const warns = FT.plausibility(rec, { vehicle: v || {}, history: hist, l100: calcL100 });
    if (warns.length) {
      const go = await ask(t("checkTitle"), warns.map((w) => warnText(w, unit)).join("\n\n"), [
        { label: t("checkAgain"), value: false, cls: "primary" }, { label: t("saveAnyway"), value: true },
      ]);
      if (!go) return;
    }

    let settingsChanged = cur !== settings.home;
    // Kilometer reminders follow the odometer reset, so "oil change in 2,000 km" stays true.
    if (!old && rec.reset && before) {
      const shift = rec.prevOdo - before.odo;
      for (const rm of settings.reminders) if (rm.vehicle === vid && rm.everyKm > 0 && typeof rm.lastKm === "number") { rm.lastKm += shift; settingsChanged = true; }
    }
    const btn = $("saveBtn"); btn.disabled = true;
    try {
      if (old) {
        await store.update(editingId, rec);
        // Keep the next fill-up's starting odometer in step when this reading changes.
        if (old.odo !== rec.odo) {
          const chain = fills().filter((x) => x.vehicle === old.vehicle && x.id !== old.id && recUnit(x) === recUnit(old));
          const ov = vehicleById(old.vehicle);
          if (ov && ov.tripMeter) {
            // A trip meter's total runs on: the later fill-ups move with it and keep the kilometers typed for them.
            const shift = rec.odo - old.odo;
            for (const x of chain.filter((x) => x.prevOdo >= old.odo)) await store.update(x.id, { ...x, prevOdo: x.prevOdo + shift, odo: x.odo + shift, updatedAt: now });
          } else {
            const next = chain.filter((x) => x.prevOdo === old.odo)[0];
            if (next) await store.update(next.id, { ...next, prevOdo: rec.odo, updatedAt: now });
          }
        }
        toast(t("updated"));
        resetForm();
      } else {
        await store.add(rec);
        Native.haptic("success");
        $("saveMsg").className = "msg ok"; $("saveMsg").textContent = t("saved"); $("saveMsg").hidden = false;
        resetForm(true);
        maybeAskReview(rec);
      }
      if (settingsChanged) await store.saveSettings(settings);
    } catch (err) {
      logError("save", err);
      $("saveMsg").className = "msg err"; $("saveMsg").textContent = t("errSave"); $("saveMsg").hidden = false;
    }
    btn.disabled = false; renderCalc();
  });

  // Ask for a store rating at a good moment: once after the third full-tank result, then rarely.
  function maybeAskReview(rec) {
    if (!Native.isNative || rec.full === false || rec.missed) return;
    const count = FT.segments(fills(), settings).length;
    if (!FT.shouldAskReview(count, settings.review, today())) return;
    settings.review = { at: today(), count };
    saveSettingsQuiet();
    setTimeout(() => Native.requestReview(), 1500);
  }

  /* ---------- unsaved fill-up: kept when bnzn is closed or sent to the background ---------- */
  const DRAFT_KEY = "bnzn-draft";
  const DRAFT_FIELDS = ["date", "currency", "rate", "odoStart", "odoEnd", "sinceKm", "resetKm", "price", "liters", "amount", "station"];
  const DRAFT_CHECKS = ["unknownStart", "odoReset", "full", "missed"];
  let draftTimer = null;
  function saveDraft() {
    clearTimeout(draftTimer);
    if (firstLoad) return; // the saved draft hasn't been offered back yet: an empty form must not erase it
    try {
      const typed = ["odoEnd", "sinceKm", "liters", "amount", "station"].some((id) => $(id).value.trim());
      if (editingId || !typed) { if (!editingId) localStorage.removeItem(DRAFT_KEY); return; }
      const d = { at: Date.now(), vehicle: formVehicle(), mode: radio("mode"), energy: radio("energy") };
      for (const id of DRAFT_FIELDS) d[id] = $(id).value;
      for (const id of DRAFT_CHECKS) d[id] = $(id).checked;
      localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    } catch { /* a draft is only a convenience */ }
  }
  const saveDraftSoon = () => { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 400); };
  function clearDraft() { clearTimeout(draftTimer); try { localStorage.removeItem(DRAFT_KEY); } catch { /* nothing to clear */ } }
  function restoreDraft() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch { d = null; }
    if (!d || typeof d !== "object") return;
    if (!(Date.now() - d.at < 3 * 864e5) || !vehicleById(d.vehicle)) { clearDraft(); return; }
    const chip = $("veh-" + d.vehicle); if (chip) chip.checked = true;
    settings.activeVehicle = d.vehicle;
    (d.energy === "kWh" ? $("en-k") : $("en-l")).checked = true;
    if (typeof d.currency === "string") ensureCurrencyOption(d.currency);
    prefill();
    for (const id of DRAFT_FIELDS) if (typeof d[id] === "string" && (id !== "currency" || CODE.test(d[id]))) $(id).value = d[id];
    for (const id of DRAFT_CHECKS) if (typeof d[id] === "boolean") $(id).checked = d[id];
    (d.mode === "money" ? $("mode-m") : $("mode-l")).checked = true;
    $("rate").dataset.cur = $("currency").value; // the rate typed with the draft, not the saved one
    if (pricePrefill && num("price") !== pricePrefill.price) pricePrefill = null;
    renderCalc();
    toast(t("draftBack"), t("discard"), () => resetForm());
  }
  Native.onPause(saveDraft);

  /* ---------- pump or receipt scan (on-device text recognition) ---------- */
  let scanReady = false;
  Native.scanAvailable().then((ok) => { scanReady = ok; renderCalc(); });
  $("scanBtn").addEventListener("click", () => $("scanFile").click());
  $("scanFile").addEventListener("change", async () => {
    const file = $("scanFile").files[0]; $("scanFile").value = "";
    if (!file) return;
    const d = $("scanDialog");
    $("scanNums").innerHTML = ""; $("scanMsg").textContent = t("scanReading"); $("scanMsg").className = "msg";
    const url = URL.createObjectURL(file); $("scanImg").src = url;
    $("scanImg").onload = () => URL.revokeObjectURL(url);
    d.showModal();
    try {
      const base64 = await shrinkToBase64(file, 1600);
      const text = await Native.recognize(base64);
      const nums = FT.numbersFromText(text);
      if (!nums.length) { $("scanMsg").textContent = t("scanNone"); return; }
      $("scanNums").innerHTML = nums.slice(0, 16).map((n) => `<button type="button" data-v="${+n.value}" data-alt="${n.alt != null ? +n.alt : ""}">${esc(n.raw)}</button>`).join("");
      // Price × liters must match the amount; numbers that agree with each other are filled in.
      const v = vehicleById(formVehicle());
      const got = FT.scanFields(nums, { currency: $("currency").value, tank: v && v.tank, type: v && v.type });
      if (got.price) $("price").value = got.price;
      if (got.liters && (got.verified || !(num("liters") > 0))) { $("mode-l").checked = true; $("liters").value = got.liters; }
      if (got.amount && !got.liters && !(num("amount") > 0)) { $("mode-m").checked = true; $("amount").value = got.amount; }
      if (got.odo && !$("odoEnd").value) $("odoEnd").value = got.odo;
      if (got.verified) { $("scanMsg").textContent = t("scanVerified"); $("scanMsg").className = "msg ok"; }
      else $("scanMsg").textContent = t(got.price || got.liters || got.amount ? "scanCheck" : "scanPick");
      pricePrefill = null;
      renderCalc(); saveDraftSoon();
    } catch (err) {
      logError("scan", err);
      $("scanMsg").textContent = t(err && err.code === "UNAVAILABLE" && Native.platform === "android" ? "scanDownload" : "scanFail");
    }
  });
  $("scanNums").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]"); if (!b) return;
    const target = radio("scanT");
    // "13.450" can be 13.45 (a price or liters) or 13450 (an amount or odometer): the field decides.
    let v = +b.dataset.v;
    if (b.dataset.alt !== "") { const alt = +b.dataset.alt; v = target === "price" || target === "liters" ? Math.min(v, alt) : Math.max(v, alt); }
    if (target === "amount") $("mode-m").checked = true;
    if (target === "liters") $("mode-l").checked = true;
    $(target).value = v;
    $("scanNums").querySelectorAll("button").forEach((x) => x.classList.toggle("picked", x === b));
    renderCalc(); saveDraftSoon();
  });
  $("scanDone").addEventListener("click", () => $("scanDialog").close());
  function shrinkToBase64(file, max) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL("image/jpeg", 0.9).split(",")[1]);
      };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }

  /* ---------- earnings (driver mode) ---------- */
  function renderIncomeForm() {
    $("incomeForm").hidden = !settings.driverMode;
    if (!settings.driverMode) return;
    const d = $("incDate").value || today();
    const sum = records.filter((r) => r.kind === "income" && r.date === d && r.vehicle === settings.activeVehicle).reduce((a, r) => a + (FT.toHome(r.amount, r, settings) || 0), 0);
    $("todayIncome").textContent = sum ? t("earnedOn", { amount: money(sum), date: dayLabel(d) }) : "";
    $("saveIncome").disabled = !(num("incAmount") > 0) || !$("incDate").value || !store || store.broken;
  }
  function startEditIncome(rec) {
    editingIncomeId = rec.id; switchTab("home");
    $("incomeTitle").textContent = t("editIncome"); $("saveIncome").textContent = t("update"); $("cancelIncome").hidden = false;
    $("incDate").value = rec.date; $("incAmount").value = rec.amount; renderIncomeForm();
    $("incomeForm").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function resetIncome() {
    editingIncomeId = null; $("incomeTitle").textContent = t("addIncome"); $("saveIncome").textContent = t("saveIncome");
    $("cancelIncome").hidden = true; $("incAmount").value = ""; $("incDate").value = today(); renderIncomeForm();
  }
  $("incomeForm").addEventListener("input", renderIncomeForm);
  $("cancelIncome").addEventListener("click", resetIncome);
  $("incomeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const amount = num("incAmount"); if (!(amount > 0)) return;
    const old = editingIncomeId ? records.find((r) => r.id === editingIncomeId) : null;
    const now = Date.now();
    const rec = { kind: "income", date: $("incDate").value, vehicle: old ? old.vehicle : settings.activeVehicle, amount, currency: settings.home, createdAt: old ? old.createdAt : now, updatedAt: now };
    try {
      if (old) await store.update(old.id, rec); else await store.add(rec);
      Native.haptic("success"); toast(t(old ? "updated" : "savedIncome")); resetIncome();
    } catch (err) { logError("save", err); toast(t("errSave")); }
  });

  /* ================= HOME: INSIGHTS AND REMINDERS ================= */
  const icon = (id) => `<span class="ico"><svg><use href="#${id}"/></svg></span>`;
  // Segments of a vehicle's main energy (fuel, or kWh for electric cars).
  const primarySegs = (vid) => FT.segments(fills().filter((r) => r.vehicle === vid), settings).filter((s) => (s.unit || "L") === unitOfVeh(vid));
  const vehIcon = (id) => { const v = vehicleById(id); return v && v.type === "bike" ? "i-bike" : "i-car"; };
  const vava = (id) => `<span class="vava" style="--vc:${esc(vehColor(id))}"><svg><use href="#${vehIcon(id)}"/></svg></span>`;

  // The home screen's instrument cluster: this month's L/100 km on a 240° dial that runs from your best
  // recent tank (green) to your worst (red), with your average marked, then the month's key numbers.
  function gaugeSvg(v, lo, hi, avg) {
    const cx = 120, cy = 112, r = 92, A0 = 150, SWEEP = 240;
    const pt = (a, rr) => [cx + rr * Math.cos(a * Math.PI / 180), cy + rr * Math.sin(a * Math.PI / 180)];
    const frac = (x) => Math.max(0, Math.min(1, (x - lo) / (hi - lo || 1)));
    const [x0, y0] = pt(A0, r), [x1, y1] = pt(A0 + SWEEP, r);
    const arc = `M${x0.toFixed(1)} ${y0.toFixed(1)}A${r} ${r} 0 1 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
    let s = `<svg viewBox="0 0 240 184" aria-hidden="true"><defs><linearGradient id="gGrad" gradientUnits="userSpaceOnUse" x1="28" y1="0" x2="212" y2="0">
      <stop offset="0" stop-color="#3ddc84"/><stop offset=".42" stop-color="#ffc53d"/><stop offset=".72" stop-color="#ff8a1f"/><stop offset="1" stop-color="#ff4d4d"/></linearGradient></defs>`;
    for (let i = 0; i <= 24; i++) {
      const a = A0 + SWEEP * i / 24, major = i % 6 === 0;
      const [ax, ay] = pt(a, r + 13), [bx, by] = pt(a, r + (major ? 21 : 17));
      s += `<line class="g-tick${major ? " major" : ""}" x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}"/>`;
    }
    s += `<path class="g-track" d="${arc}"/>`;
    if (v != null) {
      const f = frac(v);
      s += `<path class="g-fill" d="${arc}" pathLength="100" stroke-dasharray="${(f * 100).toFixed(2)} 100"/>`;
      if (avg != null) {
        const a = A0 + SWEEP * frac(avg), [ax, ay] = pt(a, r - 11), [bx, by] = pt(a, r + 11);
        s += `<line class="g-avg" x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}"/>`;
      }
      const [dx, dy] = pt(A0 + SWEEP * f, r);
      s += `<circle class="g-dot" cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="7.5"/>`;
      s += `<text class="g-end" x="${x0.toFixed(1)}" y="${(y0 + 22).toFixed(1)}" text-anchor="middle">${fmt(lo, 1)}</text><text class="g-end" x="${x1.toFixed(1)}" y="${(y1 + 22).toFixed(1)}" text-anchor="middle">${fmt(hi, 1)}</text>`;
    }
    return s + `</svg>`;
  }

  function renderInsights() {
    const el = $("insights"), listEl = $("insightList");
    const vid = settings.activeVehicle;
    if (!vid || !vehicleById(vid)) { el.hidden = true; listEl.hidden = true; return; }
    const vf = fills().filter((r) => r.vehicle === vid);
    const day = today();
    const ins = FT.insights(records, settings, vid, day);
    const u = (ins.unit || unitOfVeh(vid)) === "kWh" ? "kWh" : "L";
    const segs = primarySegs(vid);
    const lastSeg = segs[segs.length - 1];
    const parts = [];
    const head = ins.monthL100 != null ? { lbl: t("thisMonth"), v: ins.monthL100 } : lastSeg ? { lbl: t(u === "kWh" ? "lastFullCharge" : "lastFullTank"), v: lastSeg.l100 } : null;
    let badge = "";
    if (ins.changePct != null && Math.abs(ins.changePct) >= 3) badge = `<span class="badge ${ins.changePct > 0 ? "up" : "down"}">${ins.changePct > 0 ? "+" : "−"}${fmt(Math.abs(ins.changePct), 0)}%</span>`;
    const [, mNow] = day.split("-").map(Number);
    parts.push(`<div class="c-head"><div class="c-veh">${vava(vid)}<div><div class="c-name">${esc(vehName(vid))}</div><div class="c-sub">${esc(monthName(mNow, "long"))}</div></div></div>${badge}</div>`);
    // Dial scale: the spread of recent tanks, padded so the needle never sits on an end stop.
    const avgRef = ins.avgL100 != null ? ins.avgL100 : FT.vehicleAverage(segs, vid);
    if (head) {
      const vals = ins.trend.map((p) => p.l100).concat(head.v, avgRef != null ? avgRef : []);
      let lo = Math.min(...vals), hi = Math.max(...vals);
      if (hi - lo < head.v * 0.2) { const mid = (hi + lo) / 2; lo = mid - head.v * 0.12; hi = mid + head.v * 0.12; }
      lo = Math.max(0, lo - (hi - lo) * 0.08); hi += (hi - lo) * 0.08;
      parts.push(`<div class="gauge">${gaugeSvg(head.v, lo, hi, avgRef)}<div class="g-read"><span class="g-lbl">${esc(head.lbl)}</span><span class="g-val">${fmt(head.v, 2)}</span><span class="g-unit">${u}/100 km</span>${avgRef != null ? `<span class="g-avgtxt">${esc(t("avgShort", { v: fmt(avgRef, 1) }))}</span>` : ""}</div></div>`);
    } else {
      parts.push(`<div class="gauge">${gaugeSvg(null, 0, 1)}<div class="g-read"><span class="g-lbl">${u}/100 km</span><span class="g-val">–</span></div></div><p class="c-empty">${esc(t(u === "kWh" ? "needTwoFullCharge" : "needTwoFull"))}</p>`);
    }
    const mon = day.slice(0, 7);
    const monthKm = vf.filter((r) => r.date.startsWith(mon) && recUnit(r) === unitOfVeh(vid)).reduce((a, r) => a + Math.max(0, r.odo - r.prevOdo), 0);
    const recent = segs.slice(-5).filter((s) => s.cost != null);
    const recentKm = recent.reduce((a, s) => a + s.distance, 0);
    const c100 = recentKm > 0 ? recent.reduce((a, s) => a + s.cost, 0) / recentKm * 100 : null;
    const homeSym = esc(sym(settings.home));
    if (vf.length) {
      parts.push(`<div class="c-stats">
        <div><span class="c-lbl">${esc(t("spent"))}</span><span class="c-val">${fmt(ins.monthSpent, 0)}<small>${homeSym}</small></span></div>
        <div><span class="c-lbl">${esc(t("distance"))}</span><span class="c-val">${fmt(monthKm, 0)}<small>km</small></span></div>
        <div><span class="c-lbl">${esc(t("per100"))}</span><span class="c-val">${c100 != null ? `${fmt(c100, 0)}<small>${homeSym}</small>` : "–"}</span></div>
      </div>`);
    }
    if (ins.budget) {
      const pct = Math.min(100, ins.budget.pct);
      parts.push(`<div class="c-budget"><span>${esc(t("insBudget", { spent: money(ins.budget.spent, null, 0), budget: money(ins.budget.budget, null, 0) }))}</span><div class="bar ${ins.budget.pct > 100 ? "over" : ""}"><span style="width:${pct.toFixed(1)}%"></span></div></div>`);
    }
    if (ins.trend.length >= 3) parts.push(`<div class="c-trend"><span class="c-lbl">${esc(t(u === "kWh" ? "trendTitleCharge" : "trendTitle", { n: ins.trend.length }))}</span>${trendSvg(ins.trend, ins.trendAvg)}</div>`);
    el.innerHTML = parts.join("");
    el.hidden = false;

    const rows = [];
    if (ins.changePct != null && ins.changePct >= 8) rows.push(`<div class="insight alert">${icon("i-trend")}<p>${esc(t("insMore", { pct: fmt(ins.changePct, 0), m: fmt(ins.monthL100, 1), avg: fmt(ins.avgL100, 1), u }))}<small>${esc(t("insMoreWhy"))}</small></p></div>`);
    else if (ins.changePct != null && ins.changePct <= -8) rows.push(`<div class="insight good">${icon("i-trend")}<p>${esc(t("insLess", { pct: fmt(-ins.changePct, 0), m: fmt(ins.monthL100, 1), avg: fmt(ins.avgL100, 1), u }))}</p></div>`);
    if (ins.spike) rows.push(`<div class="insight alert">${icon("i-alert")}<p>${esc(t(u === "kWh" ? "insSpikeCharge" : "insSpike", { l: fmt(ins.spike.l100, 1), prev: fmt(ins.spike.prev, 1), u }))}<small>${esc(t("insSpikeWhy"))}</small></p></div>`);
    if (ins.monthSpent > 0) {
      const proj = ins.monthProjection ? `<small>${esc(t("insProjection", { amount: money(ins.monthProjection, null, 0) }))}</small>` : "";
      rows.push(`<div class="insight">${icon("i-wallet")}<p>${esc(t("insSpent", { amount: money(ins.monthSpent, null, 0) }))}${proj}</p></div>`);
    }
    if (settings.driverMode) {
      const m = day.slice(0, 7);
      const inc = records.filter((r) => r.kind === "income" && r.vehicle === vid && r.date.startsWith(m)).reduce((a, r) => a + (FT.toHome(r.amount, r, settings) || 0), 0);
      const km = vf.filter((r) => r.date.startsWith(m) && recUnit(r) === unitOfVeh(vid)).reduce((a, r) => a + Math.max(0, r.odo - r.prevOdo), 0);
      if (inc > 0) rows.push(`<div class="insight good">${icon("i-wallet")}<p>${esc(t("insProfit", { profit: money(inc - ins.monthSpent, null, 0), income: money(inc, null, 0), fuel: money(ins.monthSpent, null, 0) }))}${km > 0 ? `<small>${esc(t("insProfitKm", { v: money((inc - ins.monthSpent) / km) }))}</small>` : ""}</p></div>`);
    }
    if (ins.yearProjection) rows.push(`<div class="insight info">${icon("i-chart")}<p>${esc(t("insYear", { amount: money(ins.yearProjection, null, 0) }))}</p></div>`);
    const v = vehicleById(vid);
    const st = (ins.stations[recFuel(v, unitOfVeh(vid))] || []);
    if (st.length >= 2) {
      const best = st[0], worst = st[st.length - 1];
      const diff = worst.avgPrice - best.avgPrice;
      if (diff >= 0.01) rows.push(`<div class="insight good">${icon("i-pin")}<p>${esc(t(u === "kWh" ? "insStationCharge" : "insStation", { name: best.station, diff: money(diff), worst: worst.station }))}</p></div>`);
    }
    listEl.innerHTML = rows.length ? `<h2>${esc(t("insightsTitle"))}</h2><div class="insights">${rows.join("")}</div>` : "";
    listEl.hidden = !rows.length;
  }

  // Smooth line through the points (Catmull-Rom turned into cubic Béziers).
  function smoothPath(pts) {
    if (pts.length < 3) return pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join("");
    let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += `C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return d;
  }

  function trendSvg(points, avg) {
    const W = 520, H = 150, padX = 10, top = 22, bottom = 26;
    const vals = points.map((p) => p.l100).concat(avg);
    const lo = Math.min(...vals) * 0.9, hi = Math.max(...vals) * 1.06;
    const x = (i) => padX + (W - padX * 2) * (points.length === 1 ? 0.5 : i / (points.length - 1));
    const y = (v) => top + (H - top - bottom) * (1 - (v - lo) / (hi - lo || 1));
    const raw = points.map((p, i) => [x(i), y(p.l100)]), line = avg.map((v, i) => [x(i), y(v)]);
    const lastI = points.length - 1;
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t("trendAria"))}"><defs><linearGradient id="gArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff9a2e" stop-opacity=".38"/><stop offset="1" stop-color="#ff9a2e" stop-opacity="0"/></linearGradient></defs>`;
    s += `<path class="area" d="${smoothPath(line)}L${x(lastI).toFixed(1)} ${H - bottom}L${x(0).toFixed(1)} ${H - bottom}Z"/>`;
    s += `<path class="raw" d="${smoothPath(raw)}"/>`;
    s += `<path class="avg" d="${smoothPath(line)}"/>`;
    raw.forEach(([px, py], i) => { if (i < lastI) s += `<circle class="pt" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.6"/>`; });
    s += `<circle class="pt last" cx="${line[lastI][0].toFixed(1)}" cy="${line[lastI][1].toFixed(1)}" r="5"/>`;
    s += `<text class="v" x="${(x(lastI) - 10).toFixed(1)}" y="${(line[lastI][1] - 11).toFixed(1)}" text-anchor="end">${fmt(avg[lastI], 1)}</text>`;
    s += `<text x="${padX}" y="${H - 6}">${esc(dayLabel(points[0].date))}</text><text x="${W - padX}" y="${H - 6}" text-anchor="end">${esc(dayLabel(points[lastI].date))}</text>`;
    return s + `</svg>`;
  }

  const remTitle = (r) => (r.kind === "other" ? r.label || t("rOther") : t({ oil: "rOil", insurance: "rInsurance", inspection: "rInspection", vignette: "rVignette" }[r.kind]));
  const remIcon = (r, st) => `<span class="rico${st && st.overdue ? " late" : ""}"><svg><use href="#${{ oil: "i-wrench", insurance: "i-shield", inspection: "i-check", vignette: "i-file" }[r.kind] || "i-calendar"}"/></svg></span>`;
  function remStatusText(st) {
    if (st.kind === "km") {
      if (st.left == null) return t("remAtKm", { km: fmt(st.dueKm, 0) });
      return st.left < 0 ? t("remKmLate", { km: fmt(-st.left, 0) }) : t("remKmLeft", { km: fmt(st.left, 0) });
    }
    if (st.kind === "date") {
      if (st.left === 0) return t("remToday");
      return st.left < 0 ? t("remDaysLate", { n: -st.left }) : t("remDaysLeft", { n: st.left, date: dayLabel(st.dueDate) });
    }
    return "";
  }
  function renderDueSoon() {
    const el = $("dueSoon");
    const day = today();
    const due = settings.reminders.map((r) => ({ r, st: FT.reminderStatus(r, FT.latestOdo(records, r.vehicle), day) })).filter((x) => x.st.soon || x.st.overdue);
    const items = due.map(({ r, st }) => `<div class="due ${st.overdue ? "over" : ""}"><div class="main">${remIcon(r, st)}<div><div class="name">${esc(remTitle(r))}<span class="chip quiet">${esc(vehName(r.vehicle))}</span></div><div class="sub ${st.overdue ? "late" : "soon"}">${esc(remStatusText(st))}</div></div></div><button type="button" class="small" data-done="${esc(r.id)}">${esc(t("markDone"))}</button></div>`);
    // A gentle nudge to back up once there is history worth keeping.
    const nf = fills().length;
    const ageDays = settings.lastBackup ? FT.daysBetween(settings.lastBackup.slice(0, 10), day) : null;
    if (store && store.kind !== "db" && nf >= 5 && (ageDays == null || ageDays > 30)) {
      items.push(`<div class="due"><div class="main"><span class="rico blue"><svg><use href="#i-download"/></svg></span><div><div class="name">${esc(t("backupNudge"))}</div><div class="sub">${esc(ageDays == null ? t("backupNever") : t("backupAgo", { n: ageDays }))}</div></div></div><button type="button" class="small" data-backup="1">${esc(t("saveBackupShort"))}</button></div>`);
    }
    el.hidden = !items.length;
    el.innerHTML = items.length ? `<h2>${esc(t("needsAttention"))}</h2><div class="list">${items.join("")}</div>` : "";
  }
  $("dueSoon").addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.backup) { exportBackup(); return; }
    const r = settings.reminders.find((x) => x.id === b.dataset.done); if (!r) return;
    const odo = FT.latestOdo(records, r.vehicle);
    r.history = (r.history || []).concat([{ date: today(), odo }]);
    if (r.everyKm > 0) { r.lastKm = odo != null ? odo : r.lastKm; toast(t("remNextKm", { km: fmt(r.lastKm + r.everyKm, 0) })); }
    else if (r.dueDate) { let d = r.dueDate; while (d <= today()) d = FT.nextYear(d); r.dueDate = d; toast(t("remNextDate", { date: dayLabel(d) })); }
    await saveSettings();
  });

  /* ================= HISTORY ================= */
  function renderVehSelects() {
    const opts = vehicles().map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join("");
    for (const [id, all] of [["vf", true], ["tripVeh", false], ["pdfVeh", false], ["rVeh", false]]) {
      const sel = $(id); const prev = sel.value;
      sel.innerHTML = (all ? `<option value="all">${esc(t("allVehicles"))}</option>` : "") + opts;
      if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
      else sel.value = all && vehicles().length > 1 ? "all" : settings.activeVehicle || "";
    }
  }

  function chartSvg(groups, per, key) {
    const data = groups.filter((g) => g[key] != null).slice(0, 12).reverse();
    const W = 520, H = 200, padL = 4, padR = 4, top = 24, bottom = 30;
    const max = Math.max(...data.map((g) => g[key])) * 1.12 || 1;
    const bw = (W - padL - padR) / data.length;
    const y = (v) => top + (H - top - bottom) * (1 - v / max);
    const avg = data.reduce((a, g) => a + g[key], 0) / data.length;
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t("chartAria"))}"><defs><linearGradient id="gCol" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb547"/><stop offset="1" stop-color="#f26b0f"/></linearGradient></defs>`;
    s += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${H - bottom}" y2="${H - bottom}"/>`;
    data.forEach((g, i) => {
      const v = g[key];
      const w = Math.min(44, bw * 0.62), x = padL + i * bw + (bw - w) / 2;
      const last = i === data.length - 1;
      const h = H - bottom - y(v), rr = Math.min(8, w / 2, h);
      // Rounded top, square bottom.
      s += `<path class="col${last ? " last" : ""}" style="animation-delay:${(i * 0.04).toFixed(2)}s" d="M${x.toFixed(1)} ${(H - bottom).toFixed(1)}V${(y(v) + rr).toFixed(1)}q0 ${-rr} ${rr} ${-rr}h${(w - 2 * rr).toFixed(1)}q${rr} 0 ${rr} ${rr}V${(H - bottom).toFixed(1)}Z"/>`;
      s += `<text class="${last ? "v" : ""}" x="${(x + w / 2).toFixed(1)}" y="${(y(v) - 7).toFixed(1)}" text-anchor="middle">${fmt(v, 1)}</text>`;
      const p = g.label;
      const short = per === "day" ? `${p.d}/${p.m}` : per === "week" ? `W${p.w}` : per === "month" ? `${monthName(p.m)} ’${String(p.y).slice(2)}` : per === "quarter" ? `Q${p.q} ’${String(p.y).slice(2)}` : per === "half" ? `H${p.h} ’${String(p.y).slice(2)}` : String(p.y);
      s += `<text x="${(x + w / 2).toFixed(1)}" y="${H - bottom + 18}" text-anchor="middle">${esc(short)}</text>`;
    });
    if (data.length > 1) s += `<line class="avg-line" x1="${padL}" x2="${W - padR}" y1="${y(avg).toFixed(1)}" y2="${y(avg).toFixed(1)}"/>`;
    return s + `</svg>`;
  }

  function renderReport() {
    const per = radio("per"), vf = $("vf").value || "all";
    const groups = FT.aggregate(records, settings, per, vf);
    const el = $("report");
    if (!records.length) { el.innerHTML = `<p class="empty">${esc(t("emptyReport"))}</p>`; return; }
    if (!groups.length) { el.innerHTML = `<p class="empty">${esc(t("emptyVehicle"))}</p>`; return; }
    // Electric cars are measured in kWh; plug-in hybrids and mixed lists show both energies.
    const kwhAny = groups.some((g) => g.kwh > 0);
    const litAny = groups.some((g) => g.liters > 0) || !kwhAny;
    const mainKwh = vf !== "all" ? unitOfVeh(vf) === "kWh" : !litAny;
    const key = mainKwh ? "kwh100" : "l100", mu = mainKwh ? "kWh" : "L";
    const cur = groups[0];
    const tile = (lbl, val) => `<div class="tile"><span class="lbl">${esc(lbl)}</span><span class="val">${val}</span></div>`;
    const m = (v) => `${fmt(v, 2)}<small>${esc(sym(settings.home))}</small>`;
    const tiles = [tile(t("distance"), `${fmt(cur.distance, 0)}<small>km</small>`)];
    if (litAny) tiles.push(tile(t("fuelUsed"), `${fmt(cur.liters, 1)}<small>L</small>`));
    if (kwhAny) tiles.push(tile(t("energyUsed"), `${fmt(cur.kwh || 0, 1)}<small>kWh</small>`));
    tiles.push(tile(t("spent"), cur.spentOk ? m(cur.spent) : "–"), tile(t("cost100"), cur.cost100 != null ? m(cur.cost100) : "–"));
    if (settings.driverMode) { tiles.push(tile(t("earned"), m(cur.income)), tile(t("profit"), m(cur.profit))); if (cur.distance > 0) tiles.push(tile(t("profitKm"), m(cur.profit / cur.distance))); }
    let h = `<div class="result">
      <div class="hero"><span class="lbl">${esc(periodLabel(cur.label))}</span>
      <span class="val">${cur[key] != null ? `${fmt(cur[key], 2)}<small>${mu}/100 km</small>` : "–"}</span>${cur[key] == null ? `<span class="hint">${esc(t(mainKwh ? "needTwoFullCharge" : "needTwoFull"))}</span>` : ""}</div>
      <div class="stats two">${tiles.join("")}${tiles.length % 2 ? `<div class="tile"></div>` : ""}</div>
    </div>`;
    if (groups.filter((g) => g[key] != null).length > 1) h += `<div class="chartbox"><h3><svg><use href="#i-chart"/></svg><span>${esc(t(mainKwh ? "kwhPer100" : "litersPer100"))}</span></h3>${chartSvg(groups, per, key)}</div>`;
    h += `<div class="tablewrap"><table><thead><tr><th>${esc(t("period"))}</th><th>km</th>${litAny ? "<th>L</th><th>L/100</th>" : ""}${kwhAny ? "<th>kWh</th><th>kWh/100</th>" : ""}<th>${esc(t("spent"))}</th><th>${esc(t("per100"))}</th>${settings.driverMode ? `<th>${esc(t("earned"))}</th><th>${esc(t("profit"))}</th>` : ""}</tr></thead><tbody>`;
    for (const g of groups) {
      h += `<tr><td>${esc(periodLabel(g.label))}</td><td>${fmt(g.distance, 0)}</td>`;
      if (litAny) h += `<td>${fmt(g.liters, 1)}</td><td class="strong">${g.l100 != null ? fmt(g.l100, 2) : "–"}</td>`;
      if (kwhAny) h += `<td>${fmt(g.kwh || 0, 1)}</td><td class="strong">${g.kwh100 != null ? fmt(g.kwh100, 2) : "–"}</td>`;
      h += `<td>${g.spentOk ? fmt(g.spent, 2) : "–"}</td><td>${g.cost100 != null ? fmt(g.cost100, 2) : "–"}</td>${settings.driverMode ? `<td>${fmt(g.income, 2)}</td><td>${fmt(g.profit, 2)}</td>` : ""}</tr>`;
    }
    h += `</tbody></table></div><p class="hint">${esc(t("reportHint", { cur: sym(settings.home) }))}</p>`;
    el.innerHTML = h;
  }

  function renderLog() {
    const el = $("log");
    const list = [...records].sort(sortRecs).reverse();
    if (!list.length) { el.innerHTML = `<li><p class="empty">${esc(t("emptyLog"))}</p></li>`; return; }
    const segMap = new Map(FT.segments(fills(), settings).map((s) => [s.endId, s]));
    const multi = vehicles().length > 1;
    el.innerHTML = list.slice(0, 300).map((r) => {
      let ava, top, sub, amt, side = "";
      if (r.kind === "income") {
        ava = `<span class="vava money"><svg><use href="#i-wallet"/></svg></span>`;
        top = `${esc(t("earningsChip"))} · ${esc(dayLabel(r.date))}`;
        sub = esc(vehName(r.vehicle));
        amt = `<span class="e-amt plus">+${esc(money(r.amount, r.currency))}</span>`;
      } else {
        const dist = r.odo - r.prevOdo;
        const seg = segMap.get(r.id);
        const u = recUnit(r);
        const v = vehicleById(r.vehicle);
        const tags = (u === "kWh" && v && v.fuel === "hybrid" ? `<span class="chip quiet">${esc(t("chargeChip"))}</span>` : "") +
          (r.full === false ? `<span class="chip quiet">${esc(t("partialChip"))}</span>` : "") + (r.missed ? `<span class="chip quiet">${esc(t("missedChip"))}</span>` : "") +
          (r.reset ? `<span class="chip quiet">${esc(t("resetChip"))}</span>` : "");
        ava = vava(r.vehicle);
        top = `${esc(dayLabel(r.date))}${tags}`;
        sub = [multi ? vehName(r.vehicle) : "", r.station || "", dist > 0 ? `${fmt(dist, 0)} km` : t("startPoint"), `${fmt(r.liters, 2)} ${u}`,
          `${t(v && v.tripMeter ? "totalKm" : "odometer")} ${fmt(r.odo, 0)}`].filter(Boolean).map(esc).join(" · ");
        amt = `<span class="e-amt">${esc(money(r.cost, r.currency))}</span>`;
        if (seg) side = `<span class="e-l100">${fmt(seg.l100, 2)} ${u}/100</span>`;
      }
      return `<li>${ava}<span class="e-top">${top}</span>${amt}<span class="e-sub">${sub}</span>${side}
        <span class="e-act"><button type="button" class="iconbtn" data-edit="${esc(r.id)}" aria-label="${esc(t("edit"))}" title="${esc(t("edit"))}"><svg><use href="#i-edit"/></svg></button><button type="button" class="iconbtn del" data-del="${esc(r.id)}" aria-label="${esc(t("delete"))}" title="${esc(t("delete"))}"><svg><use href="#i-trash"/></svg></button></span></li>`;
    }).join("");
  }
  $("log").addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.edit) { const r = records.find((x) => x.id === b.dataset.edit); if (r) startEdit(r); return; }
    if (b.dataset.del) {
      const r = records.find((x) => x.id === b.dataset.del); if (!r) return;
      b.disabled = true;
      try {
        await store.remove(r.id);
        Native.haptic("warning");
        if (editingId === r.id) resetForm();
        toast(t(r.kind === "income" ? "deletedIncome" : "deleted"), t("undo"), async () => { try { await store.add({ ...r }); } catch (err) { logError("save", err); toast(t("errSave")); } });
      } catch (err) { logError("delete", err); b.disabled = false; toast(t("errSave")); }
    }
  });
  document.addEventListener("change", (e) => { if (e.target.name === "per" || e.target.id === "vf") renderReport(); });

  /* ================= TOOLS: TRIP COST ================= */
  const ROUTES = [["Casablanca", "Rabat", 87], ["Casablanca", "Marrakech", 240], ["Rabat", "Tanger", 250], ["Casablanca", "Fès", 290], ["Marrakech", "Agadir", 250], ["Casablanca", "Agadir", 470]];
  let tripRoute = null; // the preset route picked, for the shared card
  function renderTripPresets() {
    $("tripPresets").innerHTML = ROUTES.map(([a, b, km], i) => `<button type="button" data-route="${i}"><svg><use href="#i-pin"/></svg>${esc(a)} – ${esc(b)} <b>≈${km} km</b></button>`).join("");
  }
  $("tripPresets").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-route]"); if (!b) return;
    const [a, c, km] = ROUTES[+b.dataset.route];
    tripRoute = `${a} – ${c}`; $("tripKm").value = km; renderTrip();
  });
  $("tripKm").addEventListener("input", () => { tripRoute = null; });
  const tripUnit = () => unitOfVeh($("tripVeh").value);
  function prefillTrip() {
    const vid = $("tripVeh").value; if (!vid) return;
    const unit = tripUnit();
    const avg = FT.vehicleAverage(primarySegs(vid), vid, 5);
    $("tripL100").value = avg ? avg.toFixed(1) : "";
    const v = vehicleById(vid);
    const last = fills().filter((r) => (r.fuel || "essence") === recFuel(v, unit) && recUnit(r) === unit).sort(sortRecs).pop();
    const p = last ? FT.toHome(last.price, last, settings) : null;
    $("tripPrice").value = p ? +p.toFixed(2) : "";
    renderTrip();
  }
  function renderTrip() {
    const k = tripUnit() === "kWh";
    $("tripL100Unit").textContent = k ? "kWh/100" : "L/100";
    $("tripPriceLbl").textContent = t(k ? "pricePerKwh" : "pricePerL");
    const r = FT.tripCost({ km: num("tripKm"), roundTrip: $("tripRound").checked, l100: num("tripL100"), price: num("tripPrice"), people: num("tripPeople") });
    const el = $("tripOut");
    if (!r) { el.innerHTML = `<p class="hint">${esc(num("tripL100") > 0 ? t("tripNeed") : t("tripNoAvg"))}</p>`; return; }
    el.innerHTML = `<div class="result"><div class="hero"><span class="lbl">${esc(t(k ? "tripChargeLbl" : "tripCostLbl", { km: fmt(r.distance, 0) }))}</span><span class="val">${fmt(r.cost, 0)}<small>${esc(sym(settings.home))}</small></span></div>
      <div class="stats two"><div class="tile"><span class="lbl">${esc(t(k ? "energyNeeded" : "fuelNeeded"))}</span><span class="val">${fmt(r.liters, 1)}<small>${k ? "kWh" : "L"}</small></span></div>
      <div class="tile"><span class="lbl">${esc(t("perPerson", { n: r.people }))}</span><span class="val">${fmt(r.perPerson, 0)}<small>${esc(sym(settings.home))}</small></span></div></div></div>
      <button type="button" class="icon wide" id="tripShare"><svg><use href="#i-share"/></svg><span>${esc(t("tripShareBtn"))}</span></button>`;
  }
  let tripTouched = false; // once the user types their own consumption or price, new saves don't overwrite it
  $("tripVeh").addEventListener("change", () => { tripTouched = false; prefillTrip(); });
  for (const id of ["tripL100", "tripPrice"]) $(id).addEventListener("input", () => { tripTouched = true; });
  for (const id of ["tripKm", "tripL100", "tripPrice", "tripPeople", "tripRound"]) $(id).addEventListener("input", renderTrip);

  // A shareable card for the group chat: "Casablanca – Marrakech: 87 MAD each", with the app's name on it.
  $("tripOut").addEventListener("click", async (e) => {
    if (!e.target.closest("#tripShare")) return;
    const r = FT.tripCost({ km: num("tripKm"), roundTrip: $("tripRound").checked, l100: num("tripL100"), price: num("tripPrice"), people: num("tripPeople") });
    if (!r) return;
    const plain = (s) => s.replace(/[⁦-⁩]/g, "");
    const route = tripRoute || `${fmt(num("tripKm"), 0)} km`;
    const total = plain(money(r.cost, null, 0)), each = plain(money(r.perPerson, null, 0));
    const text = r.people > 1 ? t("tripShareEach", { route, total, each, n: r.people }) : t("tripShareOne", { route, total });
    try {
      const png = await tripCard(route, $("tripRound").checked ? t("roundTrip") : t("oneWay"), r, total, each);
      await Native.shareImage(`bnzn-trip-${today()}.png`, png, text, t("tripTitle"));
    } catch (err) {
      logError("share", err);
      try { await Native.shareText(text, t("tripTitle")); } catch { toast(t("errExport")); }
    }
  });
  async function tripCard(route, kind, r, total, each) {
    const W = 1080, H = 1080;
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d");
    const ar = settings.lang === "ar";
    try { await Promise.all(["700 120px 'Barlow Condensed'", "500 40px 'Barlow'"].map((f) => document.fonts.load(f))); } catch { /* system fonts then */ }
    const disp = ar ? "system-ui, sans-serif" : "'Barlow Condensed', system-ui, sans-serif";
    const body = ar ? "system-ui, sans-serif" : "'Barlow', system-ui, sans-serif";
    g.fillStyle = "#16202b"; g.fillRect(0, 0, W, H);
    g.fillStyle = "#d97a06"; g.fillRect(0, 0, W, 28);
    g.direction = ar ? "rtl" : "ltr"; g.textAlign = "start"; g.textBaseline = "alphabetic";
    const x = ar ? W - 96 : 96, maxW = W - 192;
    const line = (txt, font, size, color, y) => {
      let s = size;
      g.font = `${font.replace("{s}", s)}`;
      while (g.measureText(txt).width > maxW && s > 24) { s -= 4; g.font = font.replace("{s}", s); }
      g.fillStyle = color; g.fillText(txt, x, y);
    };
    line(kind, `500 {s}px ${body}`, 44, "#93a1b0", 210);
    line(route, `700 {s}px ${disp}`, 96, "#ffffff", 320);
    line(t("tripCardFuel", { km: fmt(r.distance, 0) }), `500 {s}px ${body}`, 44, "#93a1b0", 470);
    line(total, `700 {s}px ${disp}`, 200, "#f5a33a", 650);
    if (r.people > 1) line(t("tripCardEach", { each, n: r.people }), `600 {s}px ${disp}`, 84, "#ffffff", 780);
    g.fillStyle = "#2a3644"; g.fillRect(96, 900, W - 192, 2);
    line(t("tripCardFoot"), `500 {s}px ${body}`, 38, "#93a1b0", 975);
    return c.toDataURL("image/png").split(",")[1];
  }

  /* ================= TOOLS: REMINDERS ================= */
  let editingRem = null;
  function renderRemList() {
    const day = today();
    const list = settings.reminders;
    $("remList").innerHTML = list.length ? list.map((r) => {
      const st = FT.reminderStatus(r, FT.latestOdo(records, r.vehicle), day);
      return `<div><div class="main">${remIcon(r, st)}<div><div class="name">${esc(remTitle(r))}<span class="chip quiet">${esc(vehName(r.vehicle))}</span></div><div class="sub ${st.overdue ? "late" : st.soon ? "soon" : ""}">${esc(remStatusText(st))}</div></div></div><button type="button" class="iconbtn" data-rem="${esc(r.id)}" aria-label="${esc(t("edit"))}" title="${esc(t("edit"))}"><svg><use href="#i-edit"/></svg></button></div>`;
    }).join("") : `<p class="empty">${esc(t("remEmpty"))}</p>`;
    $("priceAlertsWrap").hidden = !Native.canNotify;
    $("priceAlerts").checked = !!settings.priceAlerts;
  }
  function openRem(r) {
    editingRem = r || null;
    renderVehSelects();
    $("rKind").value = r ? r.kind : "oil";
    $("rVeh").value = r ? r.vehicle : settings.activeVehicle;
    $("rLabel").value = r ? r.label || "" : "";
    $("rEvery").value = r && r.everyKm ? r.everyKm : 10000;
    $("rLast").value = r && r.lastKm != null ? r.lastKm : (FT.latestOdo(records, $("rVeh").value) ?? "");
    $("rDate").value = r && r.dueDate ? r.dueDate : "";
    $("rDelete").hidden = !r; $("rMsg").hidden = true;
    remKindChanged();
    $("remDialog").showModal();
  }
  function remKindChanged() {
    const k = $("rKind").value;
    $("rKmFields").hidden = k !== "oil"; $("rDateField").hidden = k === "oil"; $("rLabelField").hidden = k !== "other";
  }
  $("rKind").addEventListener("change", remKindChanged);
  $("addRem").addEventListener("click", () => openRem(null));
  $("remList").addEventListener("click", (e) => { const b = e.target.closest("button[data-rem]"); if (b) openRem(settings.reminders.find((r) => r.id === b.dataset.rem)); });
  $("rCancel").addEventListener("click", () => $("remDialog").close());
  $("rDelete").addEventListener("click", async () => {
    settings.reminders = settings.reminders.filter((r) => r !== editingRem);
    $("remDialog").close(); await saveSettings();
  });
  $("remForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const k = $("rKind").value;
    const r = { ...(editingRem || { id: newId(), history: [] }), kind: k, vehicle: $("rVeh").value, label: k === "other" ? $("rLabel").value.trim() : "" };
    if (k === "oil") {
      r.everyKm = num("rEvery"); r.lastKm = num("rLast"); delete r.dueDate;
      if (!(r.everyKm > 0) || !(r.lastKm >= 0)) { $("rMsg").textContent = t("errRemKm"); $("rMsg").hidden = false; return; }
    } else {
      r.dueDate = $("rDate").value; delete r.everyKm; delete r.lastKm;
      if (!r.dueDate) { $("rMsg").textContent = t("errRemDate"); $("rMsg").hidden = false; return; }
    }
    if (editingRem) settings.reminders = settings.reminders.map((x) => (x === editingRem ? r : x));
    else settings.reminders.push(r);
    $("remDialog").close();
    await saveSettings();
  });
  // Pump price days: Moroccan prices can change on the 1st and 16th, so an optional heads-up at 10:00.
  $("priceAlerts").addEventListener("change", async () => {
    const on = $("priceAlerts").checked;
    if (on && (await Native.notifPermission(true)) !== "granted") {
      $("priceAlerts").checked = false;
      toast(t("notifBlocked"));
      return;
    }
    settings.priceAlerts = on;
    await saveSettings();
    if (on) toast(t("priceAlertsOn", { date: dayLabel(FT.priceDays(FT.addDays(today(), 1), 1)[0]) }));
  });
  let notifTimer = null;
  function scheduleNotifications() {
    clearTimeout(notifTimer);
    notifTimer = setTimeout(() => {
      const at = (date, h) => { const d = FT.parseDate(date); d.setHours(h, 0, 0, 0); return d; };
      const items = settings.reminders.filter((r) => r.dueDate).map((r) => {
        const title = `${remTitle(r)} · ${vehName(r.vehicle)}`;
        return { id: r.id + r.dueDate, title, times: [["w", at(FT.addDays(r.dueDate, -7), 9), t("notifWeek", { date: dayLabel(r.dueDate) })], ["d", at(r.dueDate, 9), t("notifToday")]] };
      });
      if (settings.priceAlerts) {
        items.push({ id: "price", title: t("notifPriceTitle"), times: FT.priceDays(today(), 12).map((d) => [d, at(d, 10), t("notifPriceBody")]) });
      }
      Native.scheduleReminders(items);
    }, 800);
  }

  /* ================= SETTINGS ================= */
  document.addEventListener("change", async (e) => {
    if (e.target.name === "lang") { settings.lang = e.target.value; applyLang(); await saveSettings(); }
    if (e.target.name === "theme") { settings.theme = e.target.value; applyTheme(); await saveSettings(); }
    if (e.target.matches(".seg input, .chips input, .switch input, .check input")) Native.haptic("select");
  });
  // Light or dark: the phone's choice unless the user picked one. Remembered locally so the next start paints in the right theme.
  function applyTheme() {
    const th = settings.theme === "light" || settings.theme === "dark" ? settings.theme : null;
    if (th) document.documentElement.dataset.theme = th; else delete document.documentElement.dataset.theme;
    try { if (th) localStorage.setItem("bnzn-theme", th); else localStorage.removeItem("bnzn-theme"); } catch { /* private mode */ }
    const r = $("theme-" + (th || "auto")); if (r) r.checked = true;
    Native.setBarStyle(th);
  }
  function renderVehList() {
    $("vehList").innerHTML = vehicles().map((v) => {
      const n = fills().filter((r) => r.vehicle === v.id).length;
      const sub = [t(v.type === "bike" ? "bike" : "car"), t(fuelKey(v.fuel)), v.tank ? `${fmt(v.tank, 0)} ${FT.primaryUnit(v) === "kWh" ? "kWh" : "L"}` : "", v.tripMeter ? t("tripMeterShort") : "", t("nFills", { n })].filter(Boolean).join(" · ");
      return `<div><div class="main">${vava(v.id)}<div><div class="name">${esc(v.name)}</div><div class="sub">${esc(sub)}</div></div></div><button type="button" class="iconbtn" data-veh="${esc(v.id)}" aria-label="${esc(t("edit"))}" title="${esc(t("edit"))}"><svg><use href="#i-edit"/></svg></button></div>`;
    }).join("");
  }
  let editingVeh = null;
  function openVeh(v) {
    editingVeh = v || null;
    $("vName").value = v ? v.name : "";
    (v && v.type === "bike" ? $("vt-bike") : $("vt-car")).checked = true;
    $("vf-" + fuelKey(v && v.fuel)).checked = true;
    $("vTank").value = v && v.tank ? v.tank : "";
    $("vTrip").checked = !!(v && v.tripMeter);
    $("vColor").innerHTML = COLORS.map((c, i) => `<option value="${c}">${esc(t("color" + i))}</option>`).join("");
    $("vColor").value = (v && v.color) || COLORS[vehicles().length % COLORS.length];
    $("vDelete").hidden = !v || vehicles().length < 2; $("vMsg").hidden = true;
    vehFuelChanged();
    $("vehDialog").showModal();
  }
  function vehFuelChanged() {
    $("vTankUnit").textContent = radio("vFuel") === "electric" ? "kWh" : "L";
    $("vTankLbl").textContent = t(radio("vFuel") === "electric" ? "battery" : "tank");
  }
  $("vehForm").addEventListener("change", (e) => { if (e.target.name === "vFuel") vehFuelChanged(); });
  $("addVeh").addEventListener("click", () => openVeh(null));
  $("vehList").addEventListener("click", (e) => { const b = e.target.closest("button[data-veh]"); if (b) openVeh(vehicleById(b.dataset.veh)); });
  $("vCancel").addEventListener("click", () => $("vehDialog").close());
  $("vDelete").addEventListener("click", async () => {
    const v = editingVeh; if (!v) return;
    const n = records.filter((r) => r.vehicle === v.id).length;
    if (n) { $("vMsg").textContent = t("errVehInUse", { n }); $("vMsg").hidden = false; return; }
    settings.vehicles = settings.vehicles.filter((x) => x.id !== v.id);
    settings.reminders = settings.reminders.filter((r) => r.vehicle !== v.id);
    if (settings.activeVehicle === v.id) settings.activeVehicle = settings.vehicles[0].id;
    $("vehDialog").close(); await saveSettings();
  });
  $("vehForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("vName").value.trim();
    if (!name) { $("vMsg").textContent = t("errVehName"); $("vMsg").hidden = false; return; }
    const tank = num("vTank");
    const data = { name, type: radio("vType"), fuel: radio("vFuel"), tank: tank > 0 ? tank : null, color: $("vColor").value, tripMeter: $("vTrip").checked };
    if (editingVeh) Object.assign(editingVeh, data);
    else { const v = { id: newId(), ...data }; settings.vehicles.push(v); settings.activeVehicle = v.id; }
    $("vehDialog").close(); await saveSettings(); prefill(); renderCalc();
  });

  function renderMoney() {
    $("homeCur").value = settings.home;
    // A rate for each currency bnzn knows by default, or that a fill-up or the settings already use.
    const shown = [...new Set([...FT.CURRENCIES, ...Object.keys(settings.rates || {}), ...fills().map((r) => r.currency)])].filter((c) => CODE.test(c) && c !== settings.home);
    $("rateInputs").innerHTML = shown.map((c) => `<div class="field"><label for="rate-${c}">${esc(t("rateLabel", { cur: sym(c), home: sym(settings.home) }))}</label><div class="inp"><input id="rate-${c}" data-rate="${c}" type="text" inputmode="decimal" autocomplete="off" value="${esc(settings.rates[c] > 0 ? String(settings.rates[c]) : "")}"><span class="unit">${esc(sym(settings.home))}</span></div></div>`).join("");
    $("budget").value = settings.budget > 0 ? settings.budget : "";
    $("driverMode").checked = !!settings.driverMode;
  }
  $("homeCur").addEventListener("change", async () => {
    const home = $("homeCur").value; if (!CODE.test(home)) return;
    settings.home = home; settings.rates = FT.defaultRates(settings.home);
    await saveSettings(); renderCurrencySelects(); renderCalc();
  });
  $("rateInputs").addEventListener("change", async (e) => { const c = e.target.dataset.rate; if (!c) return; const v = FT.parseNum(e.target.value); if (v > 0) { settings.rates[c] = v; await saveSettings(); } });
  $("budget").addEventListener("change", async () => { const v = num("budget"); settings.budget = v > 0 ? v : 0; await saveSettings(); });
  $("driverMode").addEventListener("change", async () => { settings.driverMode = $("driverMode").checked; await saveSettings(); });

  /* ---------- backup, CSV, PDF ---------- */
  function renderBackupInfo() {
    const lb = settings.lastBackup;
    $("backupInfo").textContent = store && store.kind === "db" ? t("backupDb") : lb ? t("backupLast", { date: dayLabel(lb.slice(0, 10)) }) : t("backupNeverLong");
    $("backupPhone").hidden = !Native.isNative;
    $("backupPhone").textContent = t(Native.platform === "ios" ? "backupPhoneIos" : "backupPhoneAndroid");
  }
  async function exportBackup() {
    const name = `bnzn-backup-${today()}.json`;
    try {
      const ok = await Native.saveFile(name, JSON.stringify(FT.backupFile(records, settings), null, 1), "application/json", t("saveBackup"));
      if (ok) { settings.lastBackup = new Date().toISOString(); await saveSettings(); toast(t("backupDone")); }
    } catch (err) { logError("backup", err); toast(t("errExport")); }
  }
  $("exportBtn").addEventListener("click", exportBackup);
  $("csvBtn").addEventListener("click", async () => {
    try { await Native.saveFile(`bnzn-${today()}.csv`, FT.toCsv(records, settings), "text/csv", t("exportCsv")); } catch (err) { logError("csv", err); toast(t("errExport")); }
  });
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async () => {
    const file = $("importFile").files[0]; $("importFile").value = "";
    if (!file) return;
    let data;
    try { data = FT.parseBackup(await file.text()); } catch (err) { logError("restore", err); data = { error: "errBackupRead" }; }
    if (data.error) { toast(t(data.error)); return; }
    const skipped = data.skipped > 0 ? " " + t("restoreSkipped", { n: data.skipped }) : "";
    const broken = !!(store && store.broken);
    const choice = await ask(t("restoreTitle"), t("restoreText", { n: data.records.length }) + skipped, broken
      ? [{ label: t("restoreReplace"), value: "replace", cls: "primary" }, { label: t("cancel"), value: null }]
      : [{ label: t("restoreReplace"), value: "replace", cls: "primary" }, { label: t("restoreMerge"), value: "merge" }, { label: t("cancel"), value: null }]);
    if (!choice) return;
    try {
      const fileSettings = data.settings ? FT.migrateSettings(data.settings, data.records, settings.lang) : null;
      if (choice === "replace") {
        await store.replaceAll(data.records, broken);
        if (broken) {
          // The page starts again on the restored records, which also fills in their vehicles.
          if (fileSettings) await store.saveSettings({ ...fileSettings, lang: settings.lang, onboarded: true }, true).catch((e) => logError("restore", e));
          location.reload(); return;
        }
        if (fileSettings) settings = { ...fileSettings, lang: settings.lang, onboarded: true };
        settings = FT.migrateSettings(settings, records, settings.lang);
        await store.saveSettings(settings, !!fileSettings);
        toast(t("restoreDone", { n: data.records.length }));
      } else {
        // Same entry in both: the most recently changed copy wins.
        const merged = FT.mergeRecords(storedRecords, data.records);
        await store.replaceAll(merged.list);
        if (fileSettings) for (const v of fileSettings.vehicles) if (!vehicleById(v.id)) settings.vehicles.push(v);
        settings = FT.migrateSettings(settings, records, settings.lang);
        await store.saveSettings(settings);
        toast(t("restoreMerged", { added: merged.added, updated: merged.updated }));
      }
      renderCurrencySelects(); onData();
    } catch (err) { logError("restore", err); toast(t("errSave")); }
  });

  function reportHtml(vid) {
    const v = vehicleById(vid);
    const vf = fills().filter((r) => r.vehicle === vid).sort(FT.sortFills);
    const mu = FT.primaryUnit(v || {}) === "kWh" ? "kWh" : "L";
    const segs = FT.segments(vf, settings);
    const segMap = new Map(segs.map((s) => [s.endId, s]));
    const main = segs.filter((s) => (s.unit || "L") === mu);
    const mainF = vf.filter((r) => recUnit(r) === mu);
    const km = mainF.reduce((a, r) => a + Math.max(0, r.odo - r.prevOdo), 0);
    const amt = mainF.reduce((a, r) => a + r.liters, 0);
    const spent = vf.reduce((a, r) => a + (FT.toHome(r.cost, r, settings) || 0), 0);
    const avg = FT.vehicleAverage(main, vid);
    const segDist = main.reduce((a, s) => a + s.distance, 0), segCost = main.reduce((a, s) => a + (s.cost || 0), 0);
    const years = FT.aggregate(records, settings, "year", vid);
    const rems = settings.reminders.filter((r) => r.vehicle === vid);
    const done = rems.flatMap((r) => (r.history || []).map((h) => ({ ...h, what: remTitle(r) }))).sort((a, b) => (a.date < b.date ? 1 : -1));
    const row = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
    const dir = settings.lang === "ar" ? "rtl" : "ltr";
    const last = vf[vf.length - 1];
    const byDate = [...vf].sort(sortRecs);
    return `<!doctype html><html lang="${esc(settings.lang)}" dir="${dir}"><head><meta charset="utf-8"><title>${esc(t("reportTitle", { name: v.name }))}</title><style>
      body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Arabic",sans-serif;color:#16202b;margin:28px;font-size:12px;line-height:1.4}
      h1{font-size:22px;margin:0 0 4px} h2{font-size:14px;margin:22px 0 8px;border-bottom:2px solid #d97a06;padding-bottom:4px}
      .sub{color:#5b6876;margin:0 0 14px} table{border-collapse:collapse;width:100%} th,td{padding:5px 6px;border-bottom:1px solid #d5dce3;text-align:start;font-variant-numeric:tabular-nums}
      th{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#5b6876} .kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
      .kpi{border:1px solid #d5dce3;border-radius:8px;padding:8px 10px} .kpi b{display:block;font-size:17px} .foot{margin-top:24px;color:#5b6876;font-size:10px}
      @page{margin:14mm}</style></head><body>
      <h1>${esc(t("reportTitle", { name: v.name }))}</h1>
      <p class="sub">${esc([t(v.type === "bike" ? "bike" : "car"), t(fuelKey(v.fuel)), vf.length ? t("reportRange", { from: dayLabel(byDate[0].date), to: dayLabel(byDate[byDate.length - 1].date) }) : ""].filter(Boolean).join(" · "))}</p>
      <div class="kpis">
        <div class="kpi">${esc(t("avgConsumption"))}<b>${avg ? `${fmt(avg, 2)} ${mu}/100 km` : "–"}</b></div>
        <div class="kpi">${esc(t("distance"))}<b>${fmt(km, 0)} km</b></div>
        <div class="kpi">${esc(t(v.tripMeter ? "totalKm" : "odometer"))}<b>${last ? fmt(last.odo, 0) + " km" : "–"}</b></div>
        <div class="kpi">${esc(t(mu === "kWh" ? "energyUsed" : "fuelUsed"))}<b>${fmt(amt, 0)} ${mu}</b></div>
        <div class="kpi">${esc(t("spent"))}<b>${esc(money(spent, null, 0))}</b></div>
        <div class="kpi">${esc(t("cost100"))}<b>${segDist > 0 ? esc(money(segCost / segDist * 100)) : "–"}</b></div>
      </div>
      <h2>${esc(t("byYear"))}</h2><table><thead><tr><th>${esc(t("period"))}</th><th>km</th><th>${mu}</th><th>${mu}/100 km</th><th>${esc(t("spent"))}</th></tr></thead><tbody>
      ${years.map((g) => row([g.label.y, fmt(g.distance, 0), fmt(mu === "kWh" ? g.kwh || 0 : g.liters, 1), (mu === "kWh" ? g.kwh100 : g.l100) != null ? fmt(mu === "kWh" ? g.kwh100 : g.l100, 2) : "–", esc(money(g.spent, null, 0))])).join("")}</tbody></table>
      ${done.length ? `<h2>${esc(t("maintenance"))}</h2><table><thead><tr><th>${esc(t("date"))}</th><th>${esc(t("rKind"))}</th><th>${esc(t("odometer"))}</th></tr></thead><tbody>${done.map((h) => row([esc(dayLabel(h.date)), esc(h.what), h.odo != null ? fmt(h.odo, 0) + " km" : "–"])).join("")}</tbody></table>` : ""}
      <h2>${esc(t("allFills"))}</h2><table><thead><tr><th>${esc(t("date"))}</th><th>${esc(t(v.tripMeter ? "totalKm" : "odometer"))}</th><th>${esc(t("quantity"))}</th><th>${esc(t("pricePerUnit"))}</th><th>${esc(t("amountPaid"))}</th><th>/100 km</th><th>${esc(t("station"))}</th></tr></thead><tbody>
      ${[...vf].reverse().map((r) => { const s = segMap.get(r.id); const u = recUnit(r); return row([esc(dayLabel(r.date)) + (r.full === false ? " *" : "") + (r.reset ? " ↺" : ""), fmt(r.odo, 0), `${fmt(r.liters, 2)} ${u}`, fmt(r.price, 2), esc(money(r.cost, r.currency)), s ? `${fmt(s.l100, 2)} ${u}` : "", esc(r.station || "")]); }).join("")}</tbody></table>
      <p class="foot">${esc(t("reportFoot", { date: dayLabel(today()) }))}</p></body></html>`;
  }
  $("pdfBtn").addEventListener("click", async () => {
    const vid = $("pdfVeh").value; if (!vid) return;
    try { await Native.printHtml(reportHtml(vid), `bnzn-${vehName(vid).replace(/[^\w-]+/g, "-")}-${today()}`, t("historyReport")); }
    catch (err) { logError("pdf", err); toast(t("errExport")); }
  });

  /* ---------- about: report a problem, licenses ---------- */
  let appVersion = { version: "", build: "" };
  Native.appInfo().then((i) => { appVersion = i; $("aboutVersion").textContent = t("aboutVersion", { v: i.version + (i.build ? ` (${i.build})` : "") }); });
  function problemText() {
    const ua = navigator.userAgent;
    const device = (ua.match(/\(([^)]+)\)/) || [])[1] || ua;
    const errs = readErrors();
    return [
      t("problemAsk"), "", "", "----",
      `bnzn ${appVersion.version}${appVersion.build ? ` (${appVersion.build})` : ""} · ${Native.platform}`,
      device.replace(/; wv/g, ""),
      `${settings.lang} · ${settings.home} · ${store ? store.kind : "-"}${store && store.broken ? " · unreadable" : ""}`,
      `${fills().length} fill-ups · ${vehicles().length} vehicles`,
      "", `Errors (${errs.length}):`,
      ...errs.slice().reverse().map((x) => `${x.t} ${x.where}: ${x.msg}${x.at ? ` @ ${x.at}` : ""}`),
    ].join("\n");
  }
  $("problemBtn").addEventListener("click", () => { $("problemText").value = problemText(); $("problemDialog").showModal(); });
  $("problemClose").addEventListener("click", () => $("problemDialog").close());
  $("problemCopy").addEventListener("click", async () => { toast(t((await Native.copyText($("problemText").value)) ? "copied" : "errExport")); });
  $("problemSend").addEventListener("click", async () => {
    const text = $("problemText").value;
    if (SUPPORT_EMAIL) { location.href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("bnzn: " + t("problemTitle"))}&body=${encodeURIComponent(text.slice(0, 1800))}`; return; }
    try { await Native.shareText(text, t("problemTitle")); } catch (err) { logError("share", err); toast(t("errExport")); }
  });
  $("licBtn").addEventListener("click", async () => {
    $("licText").textContent = "…";
    $("licDialog").showModal();
    try { const res = await fetch("licenses.txt"); if (!res.ok) throw new Error(res.status); $("licText").textContent = await res.text(); }
    catch (err) { logError("licenses", err); $("licText").textContent = t("licFail"); }
  });
  $("licClose").addEventListener("click", () => $("licDialog").close());
  $("privacyLink").href = PRIVACY_URL;

  /* ---------- home-screen widget ---------- */
  let widgetTimer = null;
  function updateWidget() {
    clearTimeout(widgetTimer);
    widgetTimer = setTimeout(() => {
      const vid = settings.activeVehicle; if (!vid) return;
      const segs = primarySegs(vid);
      const last = segs[segs.length - 1];
      const u = unitOfVeh(vid) === "kWh" ? "kWh" : "L";
      const ins = FT.insights(records, settings, vid, today());
      // This month and next, so the widget can switch at midnight on the 1st without opening the app.
      const [y, m] = today().split("-").map(Number);
      const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
      const months = {
        [`${y}-${FT.pad(m)}`]: t("widgetMonth", { month: monthName(m, "long"), amount: money(ins.monthSpent, null, 0) }),
        [`${ny}-${FT.pad(nm)}`]: t("widgetMonth", { month: monthName(nm, "long"), amount: money(0, null, 0) }),
      };
      Native.refreshWidget({ vehicle: vehName(vid), l100: last ? `${fmt(last.l100, 1)} ${u}/100 km` : "–", months, add: t(u === "kWh" ? "widgetAddCharge" : "widgetAdd"), rtl: settings.lang === "ar" });
    }, 400);
  }

  /* ================= RENDER ALL ================= */
  let saveQuietTimer = null;
  function saveSettingsQuiet() { clearTimeout(saveQuietTimer); saveQuietTimer = setTimeout(() => store && store.saveSettings(settings).catch((e) => logError("settings", e)), 500); }

  function onData() {
    applyTheme();
    if (!settings.onboarded) { wStep = 0; renderWelcome(); $("welcome").hidden = false; }
    renderVehChips(); renderVehSelects();
    if (firstLoad) {
      firstLoad = false;
      const last = fills().sort(sortRecs).pop();
      renderCurrencySelects();
      $("currency").value = last ? last.currency : settings.home;
      $("date").value = today(); $("incDate").value = today();
      prefill(); prefillTrip();
      if (settings.onboarded) restoreDraft();
      if (restoredAt) toast(t("restoredCopy", { date: dayLabel(restoredAt.slice(0, 10)) }));
      if (pendingAdd) { pendingAdd = false; setTimeout(openAdd, 0); }
    } else if (!editingId) {
      // Keep the odometer in step with new saves, but don't overwrite what the user is typing.
      if (!$("odoEnd").value && !$("sinceKm").value) prefill();
    }
    if (!tripTouched) prefillTrip();
    renderStations(); renderCalc(); renderIncomeForm();
    renderInsights(); renderDueSoon(); renderReport(); renderLog();
    renderRemList(); renderVehList(); renderMoney(); renderBackupInfo(); renderTrip();
    scheduleNotifications(); updateWidget();
  }

  // The "+ Fill-up" widget button, the app shortcut and the iPhone shortcut open the form ready for the odometer.
  let pendingAdd = false; // opened from the widget before the records finished loading
  function openAdd() {
    if (firstLoad) { pendingAdd = true; return; }
    if (!settings.onboarded) return;
    document.querySelectorAll("dialog[open]").forEach((d) => d.close());
    switchTab("home"); if (editingId) resetForm(true);
    setTimeout(() => $(isTrip() ? "sinceKm" : "odoEnd").focus(), 300);
  }
  Native.onDeepLink((url) => { if (url && /add/.test(url)) openAdd(); });
  Native.onLaunchAction((action) => { if (action === "add") openAdd(); });

  applyLang();
  renderTripPresets();
  $("date").value = today();
  renderCalc();
  initStore().catch((e) => { logError("start", e); $("storeStatus").dataset.i18n = "storeError"; renderStoreStatus(); });
})();
