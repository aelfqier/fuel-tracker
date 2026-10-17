/* Fuel Tracker: screens and storage. Calculations live in logic.js (FT), phone features in native.js (Native). */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (id) => parseFloat(($(id).value || "").replace(",", "."));
  const radio = (name) => { const el = document.querySelector(`input[name="${name}"]:checked`); return el ? el.value : null; };
  const today = () => FT.isoDate(new Date());
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const COLORS = ["#d97a06", "#2f6fd0", "#2f8a5a", "#c0392b", "#7d4cc2", "#6b7785"];

  let records = [];
  let settings = FT.defaultSettings(guessLang());
  let store = null;
  let editingId = null;
  let editingIncomeId = null;
  let firstLoad = true;
  let pricePrefill = null; // { price, date } that we put in the price field ourselves

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
  const sym = (cur) => t("sym" + cur);
  // Isolated so a minus sign stays in front of the number inside Arabic sentences.
  const money = (v, cur, d = 2) => `\u2066${fmt(v, d)} ${sym(cur || settings.home)}\u2069`;
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
    fmtCache.clear();
    document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    document.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
    document.title = t("appName");
    renderStoreStatus();
    const lr = $("lang-" + lang); if (lr) lr.checked = true;
  }

  /* ---------- vehicles ---------- */
  const vehicles = () => settings.vehicles;
  const vehicleById = (id) => vehicles().find((v) => v.id === id) || null;
  const vehName = (id) => { const v = vehicleById(id); return v ? v.name : id; };
  const vehColor = (id) => { const v = vehicleById(id); return (v && v.color) || COLORS[0]; };
  const fills = () => records.filter((r) => r.kind === "fill");
  const sortRecs = (a, b) => (a.date === b.date ? (a.createdAt || 0) - (b.createdAt || 0) : a.date < b.date ? -1 : 1);
  function lastFillFor(vehicle) {
    return fills().filter((r) => r.vehicle === vehicle && r.id !== editingId).sort((a, b) => (a.odo - b.odo) || sortRecs(a, b)).pop() || null;
  }

  /* ---------- storage: phone storage in the app, a private account store when hosted, this browser otherwise ---------- */
  const REC_KEY = "fuel-tracker-records-v1"; // same key as version 1, records are migrated in place
  const SET_KEY = "fuel-tracker-settings-v1";

  function listStore(kind, readRaw, writeRaw) {
    let cb = () => {};
    const read = async () => { try { return JSON.parse((await readRaw(REC_KEY)) || "[]"); } catch { return []; } };
    const write = async (list) => { await writeRaw(REC_KEY, JSON.stringify(list)); cb(list); };
    return {
      kind,
      async subscribe(fn) { cb = fn; fn(await read()); },
      async getSettings() { try { return JSON.parse((await readRaw(SET_KEY)) || "null"); } catch { return null; } },
      async saveSettings(s) { await writeRaw(SET_KEY, JSON.stringify(s)); },
      async add(rec) { const list = await read(); list.push({ ...rec, id: rec.id || newId() }); await write(list); },
      async update(id, rec) { const list = await read(); const i = list.findIndex((r) => r.id === id); if (i >= 0) list[i] = { ...rec, id }; await write(list); },
      async remove(id) { await write((await read()).filter((r) => r.id !== id)); },
      async replaceAll(recs) { await write(recs.map((r) => ({ ...r, id: r.id || newId() }))); },
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
        if (value == null) { try { return localStorage.getItem(k); } catch { return null; } } // data from an older web version
        return value;
      },
      (k, v) => prefs.set({ key: k, value: v }));
  }
  function dbStore(db, uid) {
    const col = db.collection("data/users/" + uid);
    let settingsDoc = null;
    const setDoc = async (id, data) => { const d = col.doc(id); if (d.set) await d.set(data); else { await d.delete(); await col.add(data); } };
    return {
      kind: "db",
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
      const raw = list.map(FT.migrateRecord);
      records = raw.filter(FT.validRecord);
      if (firstLoad) {
        settings = FT.migrateSettings(await s.getSettings(), records, guessLang());
        applyLang();
        // Version 1 records get their new fields written back once.
        if (list.some((r, i) => r && raw[i] && raw[i].kind && r.kind !== raw[i].kind)) { try { await s.replaceAll(records); } catch {} }
        await s.saveSettings(settings);
      }
      onData();
    }, () => { $("storeStatus").dataset.i18n = "storeError"; renderStoreStatus(); });
  }

  function renderStoreStatus() {
    const el = $("storeStatus"), k = el.dataset.i18n;
    el.innerHTML = (k === "storeDb" || k === "storeNative" ? "<b>●</b> " : "") + esc(t(k));
  }

  async function saveSettings() {
    try { await store.saveSettings(settings); } catch { toast(t("errSave")); }
    onData();
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
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, action ? 6000 : 3000);
  }
  function ask(title, text, buttons) {
    return new Promise((resolve) => {
      const d = $("askDialog");
      $("askTitle").textContent = title; $("askText").textContent = text;
      $("askBtns").innerHTML = buttons.map((b, i) => `<button type="button" data-i="${i}" class="${b.cls || ""}">${esc(b.label)}</button>`).join("");
      $("askBtns").onclick = (e) => { const x = e.target.closest("button"); if (!x) return; d.close(); resolve(buttons[+x.dataset.i].value); };
      d.onclose = () => resolve(null);
      d.showModal();
    });
  }

  /* ---------- tabs ---------- */
  function switchTab(name) {
    const was = document.querySelector('nav.tabbar button[aria-current="page"]');
    if (was && was.dataset.tab !== name) Native.haptic("tap");
    for (const v of ["home", "history", "tools", "settings"]) $("view-" + v).hidden = v !== name;
    document.querySelectorAll("nav.tabbar button").forEach((b) => b.setAttribute("aria-current", b.dataset.tab === name ? "page" : "false"));
    window.scrollTo(0, 0);
  }
  document.querySelector("nav.tabbar").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) switchTab(b.dataset.tab); });

  /* ================= FIRST RUN ================= */
  let wStep = 0;
  const wDraft = { name: "", type: "car", fuel: "essence", home: "MAD" };
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
        <div class="field"><span class="flabel">${esc(t("fuelType"))}</span><div class="seg"><input type="radio" name="wFuel" id="wf-e" value="essence" ${wDraft.fuel === "essence" ? "checked" : ""}><label for="wf-e">${esc(t("essence"))}</label><input type="radio" name="wFuel" id="wf-g" value="gasoil" ${wDraft.fuel === "gasoil" ? "checked" : ""}><label for="wf-g">${esc(t("gasoil"))}</label></div></div>
        <div class="btnrow"><button type="button" data-w="back">${esc(t("back"))}</button><button type="button" class="primary" data-w="next">${esc(t("next"))}</button></div>`;
    } else {
      el.innerHTML = `${steps}<div class="w-step"><h2>${esc(t("wCurrency"))}</h2><p class="hint">${esc(t("wCurrencyHint"))}</p></div>
        <div class="bigchoice">
          ${choice('data-cur="MAD"', "DH", esc(t("curMAD")))}
          ${choice('data-cur="EUR"', "€", esc(t("curEUR")))}
          ${choice('data-cur="USD"', "$", esc(t("curUSD")))}
        </div>
        <div class="btnrow"><button type="button" data-w="back">${esc(t("back"))}</button></div>`;
    }
  }
  $("welcomeInner").addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.lang) { settings.lang = b.dataset.lang; applyLang(); wStep = 1; renderWelcome(); return; }
    if (b.dataset.w === "back") { readWelcome(); wStep--; renderWelcome(); return; }
    if (b.dataset.w === "next") { readWelcome(); wStep = 2; renderWelcome(); return; }
    if (b.dataset.cur) {
      readWelcome();
      const id = newId();
      settings.home = b.dataset.cur;
      settings.rates = FT.defaultRates(settings.home);
      settings.vehicles = [{ id, name: wDraft.name.trim() || t(wDraft.type === "bike" ? "bike" : "car"), type: wDraft.type, fuel: wDraft.fuel, tank: null, color: COLORS[0] }];
      settings.activeVehicle = id;
      settings.onboarded = true;
      $("welcome").hidden = true;
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
    const last = lastFillFor(vid);
    const first = !last;
    $("unknownWrap").hidden = !first;
    if (first) {
      if (!$("unknownStart").dataset.touched) $("unknownStart").checked = true;
      $("odoStart").value = "";
      $("odoStartHint").textContent = t("hintFirst");
    } else {
      $("unknownStart").checked = false;
      $("odoStart").value = last.odo;
      $("odoStartHint").textContent = t("hintFromLast", { date: dayLabel(last.date) });
    }
    $("odoStart").disabled = $("unknownStart").checked;
    // Price: the last price paid for this fuel, in the currency shown.
    const fuel = v ? v.fuel : "essence";
    const cur = $("currency").value;
    const same = fills().filter((r) => (r.fuel || "essence") === fuel && r.currency === cur).sort(sortRecs).pop();
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

  function readForm() {
    return {
      odoStart: num("odoStart"), odoEnd: num("odoEnd"), price: num("price"),
      mode: radio("mode"), liters: num("liters"), amount: num("amount"),
      unknownStart: !$("unknownWrap").hidden && $("unknownStart").checked,
    };
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
    const stale = pricePrefill && $("currency").value === "MAD" && num("price") === pricePrefill.price ? FT.priceMayBeStale(pricePrefill.date, date) : null;
    el.hidden = !stale || !!editingId;
    if (stale) el.textContent = t("priceStale", { change: dayLabel(stale), price: money(pricePrefill.price, "MAD"), date: dayLabel(pricePrefill.date) });
  }

  function renderCalc() {
    const mode = radio("mode");
    const cur = $("currency").value;
    document.querySelectorAll(".cur").forEach((el) => (el.textContent = sym(cur)));
    $("litersField").hidden = mode !== "liters";
    $("moneyField").hidden = mode !== "money";
    $("odoStart").disabled = !$("unknownWrap").hidden && $("unknownStart").checked;
    $("r-totlbl").textContent = mode === "money" ? t("litersBought") : t("totalCost");
    renderRate(); renderPriceStale();
    const f = readForm();
    const r = FT.computeFuel(f);
    const needRate = cur !== settings.home && !(num("rate") > 0);
    const err = r.error || (needRate ? "errRate" : null);
    $("calcMsg").hidden = !err; $("calcOut").hidden = !!err;
    $("saveBtn").disabled = !!err || !store || !$("date").value || !formVehicle();
    if (err) { $("calcMsg").textContent = t(err); return; }

    const full = $("full").checked, missed = $("missed").checked;
    let dist = r.distance, lit = r.liters, cost = r.cost, note = "";
    const pend = !editingId && full && !missed ? FT.pendingSinceFull(fills(), formVehicle()) : [];
    if (pend.length) {
      dist += pend.reduce((a, p) => a + Math.max(0, p.odo - p.prevOdo), 0);
      lit += pend.reduce((a, p) => a + p.liters, 0);
      const pc = pend.filter((p) => p.currency === cur).reduce((a, p) => a + p.cost, 0);
      cost += pc;
      note = t("noteIncludes", { n: pend.length });
    }
    const showCons = full && !missed && dist > 0;
    if (!full) note = t("notePartial");
    else if (missed) note = t("noteMissed");
    else if (f.unknownStart) note = t("noteFirst");
    $("r-l100").innerHTML = showCons ? `${fmt(lit / dist * 100, 2)}<small>L/100 km</small>` : "–";
    $("r-note").textContent = note; $("r-note").hidden = !note;
    const dash = (v, html) => (showCons ? html : "–");
    $("r-l1").innerHTML = dash(0, `${fmt(lit / dist, 3)}<small>L</small>`);
    $("r-kml").innerHTML = dash(0, `${fmt(dist / lit, 1)}<small>km/L</small>`);
    $("r-c100").innerHTML = dash(0, `${fmt(cost / dist * 100, 2)}<small>${esc(sym(cur))}</small>`);
    $("r-c1").innerHTML = dash(0, `${fmt(cost / dist, 2)}<small>${esc(sym(cur))}</small>`);
    $("r-dist").innerHTML = `${fmt(r.distance, 0)}<small>km</small>`;
    $("r-tot").innerHTML = mode === "money" ? `${fmt(r.liters, 2)}<small>L</small>` : `${fmt(r.cost, 2)}<small>${esc(sym(cur))}</small>`;
  }

  function resetForm(keepOdo) {
    editingId = null;
    $("formTitle").textContent = t("addFill");
    $("saveBtn").textContent = t("saveFill");
    $("cancelEdit").hidden = true;
    $("odoEnd").value = ""; $("liters").value = ""; $("amount").value = ""; $("station").value = "";
    $("full").checked = true; $("missed").checked = false;
    $("date").value = today();
    if (!keepOdo) $("odoStart").value = "";
    prefill(); renderCalc();
  }

  function startEdit(rec) {
    if (rec.kind === "income") { startEditIncome(rec); return; }
    editingId = rec.id;
    switchTab("home");
    $("formTitle").textContent = t("editFill");
    $("saveBtn").textContent = t("update");
    $("cancelEdit").hidden = false;
    const el = $("veh-" + rec.vehicle); if (el) el.checked = true;
    $("date").value = rec.date; $("currency").value = rec.currency;
    $("rate").value = rec.rate || ""; $("rate").dataset.cur = rec.currency;
    $("unknownWrap").hidden = rec.prevOdo !== rec.odo; $("unknownStart").checked = rec.prevOdo === rec.odo;
    $("odoStart").value = rec.prevOdo; $("odoEnd").value = rec.odo; $("odoStartHint").textContent = "";
    $("mode-l").checked = true; $("liters").value = rec.liters; $("price").value = rec.price; pricePrefill = null;
    $("station").value = rec.station || "";
    $("full").checked = rec.full !== false; $("missed").checked = !!rec.missed;
    renderCalc();
    $("form").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  $("form").addEventListener("input", (e) => {
    if (e.target.name === "veh") { settings.activeVehicle = e.target.value; if (!editingId) prefill(); renderInsights(); saveSettingsQuiet(); }
    if (e.target.id === "unknownStart") e.target.dataset.touched = "1";
    if (e.target.id === "currency" && !editingId) prefill();
    $("saveMsg").hidden = true;
    renderCalc();
  });
  $("form").addEventListener("change", renderCalc);
  $("cancelEdit").addEventListener("click", () => resetForm());

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = readForm(); const r = FT.computeFuel(f);
    const cur = $("currency").value;
    if (r.error || !store) return;
    const vid = formVehicle(); const v = vehicleById(vid);
    const rec = {
      kind: "fill", date: $("date").value, vehicle: vid, prevOdo: f.unknownStart ? f.odoEnd : f.odoStart, odo: f.odoEnd,
      liters: +r.liters.toFixed(3), cost: +r.cost.toFixed(2), price: f.price, currency: cur,
      full: $("full").checked, missed: $("missed").checked, station: $("station").value.trim(), fuel: v ? v.fuel : "essence",
      createdAt: Date.now(),
    };
    if (cur !== settings.home) { rec.rate = num("rate"); rec.rateHome = settings.home; settings.rates[cur] = rec.rate; }
    const btn = $("saveBtn"); btn.disabled = true;
    try {
      if (editingId) {
        const old = records.find((x) => x.id === editingId);
        rec.createdAt = old ? old.createdAt : rec.createdAt;
        await store.update(editingId, rec);
        // Keep the next fill-up's starting odometer in step when this reading changes.
        if (old && old.odo !== rec.odo) {
          const next = fills().filter((x) => x.vehicle === old.vehicle && x.id !== old.id && x.prevOdo === old.odo)[0];
          if (next) await store.update(next.id, { ...next, prevOdo: rec.odo });
        }
        toast(t("updated"));
        resetForm();
      } else {
        await store.add(rec);
        Native.haptic("success");
        $("saveMsg").className = "msg ok"; $("saveMsg").textContent = t("saved"); $("saveMsg").hidden = false;
        resetForm(true);
      }
      if (cur !== settings.home) await store.saveSettings(settings);
    } catch (err) {
      $("saveMsg").className = "msg err"; $("saveMsg").textContent = t("errSave"); $("saveMsg").hidden = false;
    }
    btn.disabled = false; renderCalc();
  });

  /* ---------- pump or receipt scan (Android, on-device text recognition) ---------- */
  $("scanBtn").hidden = !Native.canScan;
  $("scanBtn").addEventListener("click", () => $("scanFile").click());
  $("scanFile").addEventListener("change", async () => {
    const file = $("scanFile").files[0]; $("scanFile").value = "";
    if (!file) return;
    const d = $("scanDialog");
    $("scanNums").innerHTML = ""; $("scanMsg").textContent = t("scanReading");
    const url = URL.createObjectURL(file); $("scanImg").src = url;
    d.showModal();
    try {
      const base64 = await shrinkToBase64(file, 1600);
      const text = await Native.recognize(base64);
      const nums = FT.numbersFromText(text);
      if (!nums.length) { $("scanMsg").textContent = t("scanNone"); return; }
      $("scanMsg").textContent = t("scanPick");
      $("scanNums").innerHTML = nums.slice(0, 16).map((n, i) => `<button type="button" data-v="${n.value}" data-hint="${n.hint || ""}">${esc(n.raw)}</button>`).join("");
      // Pre-fill what the labels tell us (MONTANT, LITRES, PRIX…).
      for (const n of nums) {
        if (n.hint === "amount" && !(num("amount") > 0)) { $("mode-m").checked = true; $("amount").value = n.value; }
        else if (n.hint === "liters" && !(num("liters") > 0)) $("liters").value = n.value;
        else if (n.hint === "price" && n.value < 100) $("price").value = n.value;
        else if (n.hint === "odo" && n.value > 100) $("odoEnd").value = n.value;
      }
      renderCalc();
    } catch {
      $("scanMsg").textContent = t("scanFail");
    }
  });
  $("scanNums").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]"); if (!b) return;
    const target = radio("scanT");
    if (target === "amount") $("mode-m").checked = true;
    if (target === "liters") $("mode-l").checked = true;
    $(target).value = b.dataset.v;
    $("scanNums").querySelectorAll("button").forEach((x) => x.classList.toggle("picked", x === b));
    renderCalc();
  });
  $("scanDone").addEventListener("click", () => $("scanDialog").close());
  function shrinkToBase64(file, max) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.9).split(",")[1]);
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  /* ---------- earnings (driver mode) ---------- */
  function renderIncomeForm() {
    $("incomeForm").hidden = !settings.driverMode;
    if (!settings.driverMode) return;
    const d = $("incDate").value || today();
    const sum = records.filter((r) => r.kind === "income" && r.date === d && r.vehicle === settings.activeVehicle).reduce((a, r) => a + (FT.toHome(r.amount, r, settings) || 0), 0);
    $("todayIncome").textContent = sum ? t("earnedOn", { amount: money(sum), date: dayLabel(d) }) : "";
    $("saveIncome").disabled = !(num("incAmount") > 0) || !$("incDate").value;
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
    const rec = { kind: "income", date: $("incDate").value, vehicle: old ? old.vehicle : settings.activeVehicle, amount, currency: settings.home, createdAt: old ? old.createdAt : Date.now() };
    try {
      if (old) await store.update(old.id, rec); else await store.add(rec);
      Native.haptic("success"); toast(t(old ? "updated" : "savedIncome")); resetIncome();
    } catch { toast(t("errSave")); }
  });

  /* ================= HOME: INSIGHTS AND REMINDERS ================= */
  const icon = (id) => `<span class="ico"><svg><use href="#${id}"/></svg></span>`;
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
    const segs = FT.segments(vf, settings);
    const lastSeg = segs[segs.length - 1];
    const parts = [];
    const head = ins.monthL100 != null ? { lbl: t("thisMonth"), v: ins.monthL100 } : lastSeg ? { lbl: t("lastFullTank"), v: lastSeg.l100 } : null;
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
      parts.push(`<div class="gauge">${gaugeSvg(head.v, lo, hi, avgRef)}<div class="g-read"><span class="g-lbl">${esc(head.lbl)}</span><span class="g-val">${fmt(head.v, 2)}</span><span class="g-unit">L/100 km</span>${avgRef != null ? `<span class="g-avgtxt">${esc(t("avgShort", { v: fmt(avgRef, 1) }))}</span>` : ""}</div></div>`);
    } else {
      parts.push(`<div class="gauge">${gaugeSvg(null, 0, 1)}<div class="g-read"><span class="g-lbl">L/100 km</span><span class="g-val">–</span></div></div><p class="c-empty">${esc(t("needTwoFull"))}</p>`);
    }
    const mon = day.slice(0, 7);
    const monthKm = vf.filter((r) => r.date.startsWith(mon)).reduce((a, r) => a + Math.max(0, r.odo - r.prevOdo), 0);
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
    if (ins.trend.length >= 3) parts.push(`<div class="c-trend"><span class="c-lbl">${esc(t("trendTitle", { n: ins.trend.length }))}</span>${trendSvg(ins.trend, ins.trendAvg)}</div>`);
    el.innerHTML = parts.join("");
    el.hidden = false;

    const rows = [];
    if (ins.changePct != null && ins.changePct >= 8) rows.push(`<div class="insight alert">${icon("i-trend")}<p>${esc(t("insMore", { pct: fmt(ins.changePct, 0), m: fmt(ins.monthL100, 1), avg: fmt(ins.avgL100, 1) }))}<small>${esc(t("insMoreWhy"))}</small></p></div>`);
    else if (ins.changePct != null && ins.changePct <= -8) rows.push(`<div class="insight good">${icon("i-trend")}<p>${esc(t("insLess", { pct: fmt(-ins.changePct, 0), m: fmt(ins.monthL100, 1), avg: fmt(ins.avgL100, 1) }))}</p></div>`);
    if (ins.spike) rows.push(`<div class="insight alert">${icon("i-alert")}<p>${esc(t("insSpike", { l: fmt(ins.spike.l100, 1), prev: fmt(ins.spike.prev, 1) }))}<small>${esc(t("insSpikeWhy"))}</small></p></div>`);
    if (ins.monthSpent > 0) {
      const proj = ins.monthProjection ? `<small>${esc(t("insProjection", { amount: money(ins.monthProjection, null, 0) }))}</small>` : "";
      rows.push(`<div class="insight">${icon("i-wallet")}<p>${esc(t("insSpent", { amount: money(ins.monthSpent, null, 0) }))}${proj}</p></div>`);
    }
    if (settings.driverMode) {
      const m = day.slice(0, 7);
      const inc = records.filter((r) => r.kind === "income" && r.vehicle === vid && r.date.startsWith(m)).reduce((a, r) => a + (FT.toHome(r.amount, r, settings) || 0), 0);
      const km = vf.filter((r) => r.date.startsWith(m)).reduce((a, r) => a + Math.max(0, r.odo - r.prevOdo), 0);
      if (inc > 0) rows.push(`<div class="insight good">${icon("i-wallet")}<p>${esc(t("insProfit", { profit: money(inc - ins.monthSpent, null, 0), income: money(inc, null, 0), fuel: money(ins.monthSpent, null, 0) }))}${km > 0 ? `<small>${esc(t("insProfitKm", { v: money((inc - ins.monthSpent) / km) }))}</small>` : ""}</p></div>`);
    }
    if (ins.yearProjection) rows.push(`<div class="insight info">${icon("i-chart")}<p>${esc(t("insYear", { amount: money(ins.yearProjection, null, 0) }))}</p></div>`);
    const v = vehicleById(vid);
    const st = (ins.stations[(v && v.fuel) || "essence"] || []);
    if (st.length >= 2) {
      const best = st[0], worst = st[st.length - 1];
      const diff = worst.avgPrice - best.avgPrice;
      if (diff >= 0.01) rows.push(`<div class="insight good">${icon("i-pin")}<p>${esc(t("insStation", { name: best.station, diff: money(diff), worst: worst.station }))}</p></div>`);
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

  function chartSvg(groups, per) {
    const data = groups.filter((g) => g.l100 != null).slice(0, 12).reverse();
    const W = 520, H = 200, padL = 4, padR = 4, top = 24, bottom = 30;
    const max = Math.max(...data.map((g) => g.l100)) * 1.12 || 1;
    const bw = (W - padL - padR) / data.length;
    const y = (v) => top + (H - top - bottom) * (1 - v / max);
    const avg = data.reduce((a, g) => a + g.l100, 0) / data.length;
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t("chartAria"))}"><defs><linearGradient id="gCol" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb547"/><stop offset="1" stop-color="#f26b0f"/></linearGradient></defs>`;
    s += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${H - bottom}" y2="${H - bottom}"/>`;
    data.forEach((g, i) => {
      const v = g.l100;
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
    const cur = groups[0];
    const tile = (lbl, val) => `<div class="tile"><span class="lbl">${esc(lbl)}</span><span class="val">${val}</span></div>`;
    const m = (v) => `${fmt(v, 2)}<small>${esc(sym(settings.home))}</small>`;
    const tiles = [
      tile(t("distance"), `${fmt(cur.distance, 0)}<small>km</small>`),
      tile(t("fuelUsed"), `${fmt(cur.liters, 1)}<small>L</small>`),
      tile(t("spent"), cur.spentOk ? m(cur.spent) : "–"),
      tile(t("cost100"), cur.cost100 != null ? m(cur.cost100) : "–"),
    ];
    if (settings.driverMode) { tiles.push(tile(t("earned"), m(cur.income)), tile(t("profit"), m(cur.profit))); if (cur.distance > 0) tiles.push(tile(t("profitKm"), m(cur.profit / cur.distance))); }
    let h = `<div class="result">
      <div class="hero"><span class="lbl">${esc(periodLabel(cur.label))}</span>
      <span class="val">${cur.l100 != null ? `${fmt(cur.l100, 2)}<small>L/100 km</small>` : "–"}</span>${cur.l100 == null ? `<span class="hint">${esc(t("needTwoFull"))}</span>` : ""}</div>
      <div class="stats two">${tiles.join("")}${tiles.length % 2 ? `<div class="tile"></div>` : ""}</div>
    </div>`;
    if (groups.filter((g) => g.l100 != null).length > 1) h += `<div class="chartbox"><h3><svg><use href="#i-chart"/></svg><span>${esc(t("litersPer100"))}</span></h3>${chartSvg(groups, per)}</div>`;
    h += `<div class="tablewrap"><table><thead><tr><th>${esc(t("period"))}</th><th>km</th><th>L</th><th>L/100</th><th>${esc(t("spent"))}</th><th>${esc(t("per100"))}</th>${settings.driverMode ? `<th>${esc(t("earned"))}</th><th>${esc(t("profit"))}</th>` : ""}</tr></thead><tbody>`;
    for (const g of groups) {
      h += `<tr><td>${esc(periodLabel(g.label))}</td><td>${fmt(g.distance, 0)}</td><td>${fmt(g.liters, 1)}</td>
        <td class="strong">${g.l100 != null ? fmt(g.l100, 2) : "–"}</td><td>${g.spentOk ? fmt(g.spent, 2) : "–"}</td>
        <td>${g.cost100 != null ? fmt(g.cost100, 2) : "–"}</td>${settings.driverMode ? `<td>${fmt(g.income, 2)}</td><td>${fmt(g.profit, 2)}</td>` : ""}</tr>`;
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
        amt = `<span class="e-amt plus">+${money(r.amount, r.currency)}</span>`;
      } else {
        const dist = r.odo - r.prevOdo;
        const seg = segMap.get(r.id);
        const tags = (r.full === false ? `<span class="chip quiet">${esc(t("partialChip"))}</span>` : "") + (r.missed ? `<span class="chip quiet">${esc(t("missedChip"))}</span>` : "");
        ava = vava(r.vehicle);
        top = `${esc(dayLabel(r.date))}${tags}`;
        sub = [multi ? esc(vehName(r.vehicle)) : "", r.station ? esc(r.station) : "", dist > 0 ? `${fmt(dist, 0)} km` : esc(t("startPoint")), `${fmt(r.liters, 2)} L`, `${esc(t("odometer"))} ${fmt(r.odo, 0)}`].filter(Boolean).join(" · ");
        amt = `<span class="e-amt">${money(r.cost, r.currency)}</span>`;
        if (seg) side = `<span class="e-l100">${fmt(seg.l100, 2)} L/100</span>`;
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
        toast(t(r.kind === "income" ? "deletedIncome" : "deleted"), t("undo"), async () => { try { await store.add({ ...r }); } catch { toast(t("errSave")); } });
      } catch { b.disabled = false; toast(t("errSave")); }
    }
  });
  document.addEventListener("change", (e) => { if (e.target.name === "per" || e.target.id === "vf") renderReport(); });

  /* ================= TOOLS: TRIP COST ================= */
  const ROUTES = [["Casablanca", "Rabat", 87], ["Casablanca", "Marrakech", 240], ["Rabat", "Tanger", 250], ["Casablanca", "Fès", 290], ["Marrakech", "Agadir", 250], ["Casablanca", "Agadir", 470]];
  function renderTripPresets() {
    $("tripPresets").innerHTML = ROUTES.map(([a, b, km]) => `<button type="button" data-km="${km}"><svg><use href="#i-pin"/></svg>${esc(a)} – ${esc(b)} <b>${km} km</b></button>`).join("");
  }
  $("tripPresets").addEventListener("click", (e) => { const b = e.target.closest("button[data-km]"); if (!b) return; $("tripKm").value = b.dataset.km; renderTrip(); });
  function prefillTrip() {
    const vid = $("tripVeh").value; if (!vid) return;
    const segs = FT.segments(fills().filter((r) => r.vehicle === vid), settings);
    const avg = FT.vehicleAverage(segs, vid, 5);
    $("tripL100").value = avg ? avg.toFixed(1) : "";
    const v = vehicleById(vid);
    const last = fills().filter((r) => (r.fuel || "essence") === ((v && v.fuel) || "essence")).sort(sortRecs).pop();
    const p = last ? FT.toHome(last.price, last, settings) : null;
    $("tripPrice").value = p ? +p.toFixed(2) : "";
    renderTrip();
  }
  function renderTrip() {
    const r = FT.tripCost({ km: num("tripKm"), roundTrip: $("tripRound").checked, l100: num("tripL100"), price: num("tripPrice"), people: num("tripPeople") });
    const el = $("tripOut");
    if (!r) { el.innerHTML = `<p class="hint">${esc(num("tripL100") > 0 ? t("tripNeed") : t("tripNoAvg"))}</p>`; return; }
    el.innerHTML = `<div class="result"><div class="hero"><span class="lbl">${esc(t("tripCostLbl", { km: fmt(r.distance, 0) }))}</span><span class="val">${fmt(r.cost, 0)}<small>${esc(sym(settings.home))}</small></span></div>
      <div class="stats two"><div class="tile"><span class="lbl">${esc(t("fuelNeeded"))}</span><span class="val">${fmt(r.liters, 1)}<small>L</small></span></div>
      <div class="tile"><span class="lbl">${esc(t("perPerson", { n: r.people }))}</span><span class="val">${fmt(r.perPerson, 0)}<small>${esc(sym(settings.home))}</small></span></div></div></div>`;
  }
  let tripTouched = false; // once the user types their own consumption or price, new saves don't overwrite it
  $("tripVeh").addEventListener("change", () => { tripTouched = false; prefillTrip(); });
  for (const id of ["tripL100", "tripPrice"]) $(id).addEventListener("input", () => { tripTouched = true; });
  for (const id of ["tripKm", "tripL100", "tripPrice", "tripPeople", "tripRound"]) $(id).addEventListener("input", renderTrip);

  /* ================= TOOLS: REMINDERS ================= */
  let editingRem = null;
  function renderRemList() {
    const day = today();
    const list = settings.reminders;
    $("remList").innerHTML = list.length ? list.map((r) => {
      const st = FT.reminderStatus(r, FT.latestOdo(records, r.vehicle), day);
      return `<div><div class="main">${remIcon(r, st)}<div><div class="name">${esc(remTitle(r))}<span class="chip quiet">${esc(vehName(r.vehicle))}</span></div><div class="sub ${st.overdue ? "late" : st.soon ? "soon" : ""}">${esc(remStatusText(st))}</div></div></div><button type="button" class="iconbtn" data-rem="${esc(r.id)}" aria-label="${esc(t("edit"))}" title="${esc(t("edit"))}"><svg><use href="#i-edit"/></svg></button></div>`;
    }).join("") : `<p class="empty">${esc(t("remEmpty"))}</p>`;
  }
  function openRem(r) {
    editingRem = r || null;
    renderVehSelects();
    $("rKind").value = r ? r.kind : "oil";
    $("rVeh").value = r ? r.vehicle : settings.activeVehicle;
    $("rLabel").value = r ? r.label || "" : "";
    $("rEvery").value = r && r.everyKm ? r.everyKm : 10000;
    $("rLast").value = r && r.lastKm != null ? r.lastKm : (FT.latestOdo(records, $("rVeh").value) || "");
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
  function scheduleNotifications() {
    const items = settings.reminders.filter((r) => r.dueDate).map((r) => {
      const at = (date) => { const d = FT.parseDate(date); d.setHours(9, 0, 0, 0); return d; };
      const title = `${remTitle(r)} · ${vehName(r.vehicle)}`;
      return { id: r.id + r.dueDate, title, times: [["w", at(FT.addDays(r.dueDate, -7)), t("notifWeek", { date: dayLabel(r.dueDate) })], ["d", at(r.dueDate), t("notifToday")]] };
    });
    Native.scheduleReminders(items);
  }

  /* ================= SETTINGS ================= */
  document.addEventListener("change", async (e) => {
    if (e.target.name === "lang") { settings.lang = e.target.value; applyLang(); await saveSettings(); resetForm(true); }
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
      const sub = [t(v.type === "bike" ? "bike" : "car"), t(v.fuel === "gasoil" ? "gasoil" : "essence"), v.tank ? `${fmt(v.tank, 0)} L` : "", t("nFills", { n })].filter(Boolean).join(" · ");
      return `<div><div class="main">${vava(v.id)}<div><div class="name">${esc(v.name)}</div><div class="sub">${esc(sub)}</div></div></div><button type="button" class="iconbtn" data-veh="${esc(v.id)}" aria-label="${esc(t("edit"))}" title="${esc(t("edit"))}"><svg><use href="#i-edit"/></svg></button></div>`;
    }).join("");
  }
  let editingVeh = null;
  function openVeh(v) {
    editingVeh = v || null;
    $("vName").value = v ? v.name : "";
    (v && v.type === "bike" ? $("vt-bike") : $("vt-car")).checked = true;
    (v && v.fuel === "gasoil" ? $("vf-gasoil") : $("vf-essence")).checked = true;
    $("vTank").value = v && v.tank ? v.tank : "";
    $("vColor").innerHTML = COLORS.map((c, i) => `<option value="${c}">${esc(t("color" + i))}</option>`).join("");
    $("vColor").value = (v && v.color) || COLORS[vehicles().length % COLORS.length];
    $("vDelete").hidden = !v || vehicles().length < 2; $("vMsg").hidden = true;
    $("vehDialog").showModal();
  }
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
    const data = { name, type: radio("vType"), fuel: radio("vFuel"), tank: tank > 0 ? tank : null, color: $("vColor").value };
    if (editingVeh) Object.assign(editingVeh, data);
    else { const v = { id: newId(), ...data }; settings.vehicles.push(v); settings.activeVehicle = v.id; }
    $("vehDialog").close(); await saveSettings(); prefill();
  });

  function renderMoney() {
    $("homeCur").value = settings.home;
    $("rateInputs").innerHTML = FT.CURRENCIES.filter((c) => c !== settings.home).map((c) => `<div class="field"><label for="rate-${c}">${esc(t("rateLabel", { cur: sym(c), home: sym(settings.home) }))}</label><div class="inp"><input id="rate-${c}" data-rate="${c}" type="number" inputmode="decimal" min="0" step="any" value="${settings.rates[c] || ""}"><span class="unit">${esc(sym(settings.home))}</span></div></div>`).join("");
    $("budget").value = settings.budget > 0 ? settings.budget : "";
    $("driverMode").checked = !!settings.driverMode;
  }
  $("homeCur").addEventListener("change", async () => {
    settings.home = $("homeCur").value; settings.rates = FT.defaultRates(settings.home);
    await saveSettings(); renderCalc();
  });
  $("rateInputs").addEventListener("change", async (e) => { const c = e.target.dataset.rate; if (!c) return; const v = parseFloat(e.target.value.replace(",", ".")); if (v > 0) { settings.rates[c] = v; await saveSettings(); } });
  $("budget").addEventListener("change", async () => { const v = num("budget"); settings.budget = v > 0 ? v : 0; await saveSettings(); });
  $("driverMode").addEventListener("change", async () => { settings.driverMode = $("driverMode").checked; await saveSettings(); });

  /* ---------- backup, CSV, PDF ---------- */
  function renderBackupInfo() {
    const lb = settings.lastBackup;
    $("backupInfo").textContent = store && store.kind === "db" ? t("backupDb") : lb ? t("backupLast", { date: dayLabel(lb.slice(0, 10)) }) : t("backupNeverLong");
  }
  async function exportBackup() {
    const name = `bnzn-backup-${today()}.json`;
    try {
      const ok = await Native.saveFile(name, JSON.stringify(FT.backupFile(records, settings), null, 1), "application/json", t("saveBackup"));
      if (ok) { settings.lastBackup = new Date().toISOString(); await saveSettings(); toast(t("backupDone")); }
    } catch { toast(t("errExport")); }
  }
  $("exportBtn").addEventListener("click", exportBackup);
  $("csvBtn").addEventListener("click", async () => {
    try { await Native.saveFile(`bnzn-${today()}.csv`, FT.toCsv(records, settings), "text/csv", t("exportCsv")); } catch { toast(t("errExport")); }
  });
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async () => {
    const file = $("importFile").files[0]; $("importFile").value = "";
    if (!file) return;
    const data = FT.parseBackup(await file.text());
    if (data.error) { toast(t(data.error)); return; }
    const choice = await ask(t("restoreTitle"), t("restoreText", { n: data.records.length }), [
      { label: t("restoreReplace"), value: "replace", cls: "primary" }, { label: t("restoreMerge"), value: "merge" }, { label: t("cancel"), value: null },
    ]);
    if (!choice) return;
    try {
      const fileSettings = data.settings ? FT.migrateSettings(data.settings, data.records, settings.lang) : null;
      if (choice === "replace") {
        await store.replaceAll(data.records);
        if (fileSettings) settings = { ...fileSettings, lang: settings.lang, onboarded: true };
      } else {
        const ids = new Set(records.map((r) => r.id));
        await store.replaceAll(records.concat(data.records.filter((r) => !ids.has(r.id))));
        if (fileSettings) for (const v of fileSettings.vehicles) if (!vehicleById(v.id)) settings.vehicles.push(v);
      }
      settings = FT.migrateSettings(settings, records, settings.lang);
      await saveSettings();
      toast(t("restoreDone", { n: data.records.length }));
    } catch { toast(t("errSave")); }
  });

  function reportHtml(vid) {
    const v = vehicleById(vid);
    const vf = fills().filter((r) => r.vehicle === vid).sort((a, b) => (a.odo - b.odo) || sortRecs(a, b));
    const segs = FT.segments(vf, settings);
    const segMap = new Map(segs.map((s) => [s.endId, s]));
    const km = vf.reduce((a, r) => a + Math.max(0, r.odo - r.prevOdo), 0);
    const lit = vf.reduce((a, r) => a + r.liters, 0);
    const spent = vf.reduce((a, r) => a + (FT.toHome(r.cost, r, settings) || 0), 0);
    const avg = FT.vehicleAverage(segs, vid);
    const segDist = segs.reduce((a, s) => a + s.distance, 0), segCost = segs.reduce((a, s) => a + (s.cost || 0), 0);
    const years = FT.aggregate(records, settings, "year", vid);
    const rems = settings.reminders.filter((r) => r.vehicle === vid);
    const done = rems.flatMap((r) => (r.history || []).map((h) => ({ ...h, what: remTitle(r) }))).sort((a, b) => (a.date < b.date ? 1 : -1));
    const row = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
    const dir = settings.lang === "ar" ? "rtl" : "ltr";
    return `<!doctype html><html lang="${settings.lang}" dir="${dir}"><head><meta charset="utf-8"><title>${esc(t("reportTitle", { name: v.name }))}</title><style>
      body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Arabic",sans-serif;color:#16202b;margin:28px;font-size:12px;line-height:1.4}
      h1{font-size:22px;margin:0 0 4px} h2{font-size:14px;margin:22px 0 8px;border-bottom:2px solid #d97a06;padding-bottom:4px}
      .sub{color:#5b6876;margin:0 0 14px} table{border-collapse:collapse;width:100%} th,td{padding:5px 6px;border-bottom:1px solid #d5dce3;text-align:start;font-variant-numeric:tabular-nums}
      th{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#5b6876} .kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
      .kpi{border:1px solid #d5dce3;border-radius:8px;padding:8px 10px} .kpi b{display:block;font-size:17px} .foot{margin-top:24px;color:#5b6876;font-size:10px}
      @page{margin:14mm}</style></head><body>
      <h1>${esc(t("reportTitle", { name: v.name }))}</h1>
      <p class="sub">${esc([t(v.type === "bike" ? "bike" : "car"), t(v.fuel === "gasoil" ? "gasoil" : "essence"), vf.length ? t("reportRange", { from: dayLabel(vf[0].date), to: dayLabel(vf[vf.length - 1].date) }) : ""].filter(Boolean).join(" · "))}</p>
      <div class="kpis">
        <div class="kpi">${esc(t("avgConsumption"))}<b>${avg ? fmt(avg, 2) + " L/100 km" : "–"}</b></div>
        <div class="kpi">${esc(t("distance"))}<b>${fmt(km, 0)} km</b></div>
        <div class="kpi">${esc(t("odometer"))}<b>${vf.length ? fmt(vf[vf.length - 1].odo, 0) + " km" : "–"}</b></div>
        <div class="kpi">${esc(t("fuelUsed"))}<b>${fmt(lit, 0)} L</b></div>
        <div class="kpi">${esc(t("spent"))}<b>${esc(money(spent, null, 0))}</b></div>
        <div class="kpi">${esc(t("cost100"))}<b>${segDist > 0 ? esc(money(segCost / segDist * 100)) : "–"}</b></div>
      </div>
      <h2>${esc(t("byYear"))}</h2><table><thead><tr><th>${esc(t("period"))}</th><th>km</th><th>L</th><th>L/100 km</th><th>${esc(t("spent"))}</th></tr></thead><tbody>
      ${years.map((g) => row([g.label.y, fmt(g.distance, 0), fmt(g.liters, 1), g.l100 != null ? fmt(g.l100, 2) : "–", esc(money(g.spent, null, 0))])).join("")}</tbody></table>
      ${done.length ? `<h2>${esc(t("maintenance"))}</h2><table><thead><tr><th>${esc(t("date"))}</th><th>${esc(t("rKind"))}</th><th>${esc(t("odometer"))}</th></tr></thead><tbody>${done.map((h) => row([esc(dayLabel(h.date)), esc(h.what), h.odo != null ? fmt(h.odo, 0) + " km" : "–"])).join("")}</tbody></table>` : ""}
      <h2>${esc(t("allFills"))}</h2><table><thead><tr><th>${esc(t("date"))}</th><th>${esc(t("odometer"))}</th><th>L</th><th>${esc(t("pricePerL"))}</th><th>${esc(t("amountPaid"))}</th><th>L/100 km</th><th>${esc(t("station"))}</th></tr></thead><tbody>
      ${[...vf].reverse().map((r) => row([esc(dayLabel(r.date)) + (r.full === false ? " *" : ""), fmt(r.odo, 0), fmt(r.liters, 2), fmt(r.price, 2), esc(money(r.cost, r.currency)), segMap.get(r.id) ? fmt(segMap.get(r.id).l100, 2) : "", esc(r.station || "")])).join("")}</tbody></table>
      <p class="foot">${esc(t("reportFoot", { date: dayLabel(today()) }))}</p></body></html>`;
  }
  $("pdfBtn").addEventListener("click", async () => {
    const vid = $("pdfVeh").value; if (!vid) return;
    try { await Native.printHtml(reportHtml(vid), `bnzn-${vehName(vid).replace(/[^\w-]+/g, "-")}-${today()}`, t("historyReport")); }
    catch { toast(t("errExport")); }
  });

  /* ---------- home-screen widget ---------- */
  let widgetTimer = null;
  function updateWidget() {
    clearTimeout(widgetTimer);
    widgetTimer = setTimeout(() => {
      const vid = settings.activeVehicle; if (!vid) return;
      const segs = FT.segments(fills().filter((r) => r.vehicle === vid), settings);
      const last = segs[segs.length - 1];
      const ins = FT.insights(records, settings, vid, today());
      const [y, m] = today().split("-").map(Number);
      Native.refreshWidget({
        vehicle: vehName(vid),
        l100: last ? `${fmt(last.l100, 1)} L/100 km` : "–",
        month: t("widgetMonth", { month: monthName(m, "long"), amount: money(ins.monthSpent, null, 0) }),
        add: t("widgetAdd"),
        rtl: settings.lang === "ar",
        y,
      });
    }, 400);
  }

  /* ================= RENDER ALL ================= */
  let saveQuietTimer = null;
  function saveSettingsQuiet() { clearTimeout(saveQuietTimer); saveQuietTimer = setTimeout(() => store && store.saveSettings(settings).catch(() => {}), 500); }

  function onData() {
    applyTheme();
    if (!settings.onboarded) { wStep = 0; renderWelcome(); $("welcome").hidden = false; }
    renderVehChips(); renderVehSelects();
    if (firstLoad) {
      firstLoad = false;
      const last = fills().sort(sortRecs).pop();
      $("currency").value = last ? last.currency : settings.home;
      $("date").value = today(); $("incDate").value = today();
      prefill(); prefillTrip();
    } else if (!editingId) {
      // Keep the odometer in step with new saves, but don't overwrite what the user is typing.
      if (!$("odoEnd").value) prefill();
    }
    if (!tripTouched) prefillTrip();
    renderStations(); renderCalc(); renderIncomeForm();
    renderInsights(); renderDueSoon(); renderReport(); renderLog();
    renderRemList(); renderVehList(); renderMoney(); renderBackupInfo(); renderTrip();
    scheduleNotifications(); updateWidget();
  }

  // Widget button and app shortcut: fueltracker://add opens the form ready for the odometer.
  Native.onDeepLink((url) => {
    if (!url || !/add/.test(url)) return;
    switchTab("home"); if (editingId) resetForm(true);
    setTimeout(() => $("odoEnd").focus(), 300);
  });

  applyLang();
  renderTripPresets();
  $("date").value = today();
  renderCalc();
  initStore();
})();
