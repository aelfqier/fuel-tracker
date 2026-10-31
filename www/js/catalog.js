/* Fuel Tracker: the vehicle catalogue in data/vehicles.json, official fuel tank sizes by brand and model.
   No DOM access, so it runs in the app and in Node tests. */
(function (root) {
  "use strict";

  const TYPES = ["car", "bike"];
  const FUELS = ["essence", "gasoil", "electric", "hybrid"];
  const isObj = (o) => !!o && typeof o === "object" && !Array.isArray(o);
  const isStr = (s, max) => typeof s === "string" && s.trim().length >= 1 && s.length <= max;
  const optStr = (s, max) => (typeof s === "string" && s.trim() && s.length <= max ? s.trim() : null);
  const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
  function isHttps(u) {
    if (typeof u !== "string" || u.length > 500) return false;
    try { return new URL(u).protocol === "https:"; } catch { return false; }
  }

  // One catalogue entry, or null when it isn't a complete official figure (the file is data, so it is checked like a backup).
  function cleanEntry(e) {
    if (!isObj(e) || !isStr(e.id, 100) || !/^[a-z0-9-]+$/.test(e.id)) return null;
    if (!isStr(e.brand, 40) || !isStr(e.model, 60) || !TYPES.includes(e.type)) return null;
    if (typeof e.tank !== "number" || !isFinite(e.tank) || e.tank <= 0 || e.tank > 200) return null;
    if (!isHttps(e.source) || !isDay(e.checked)) return null;
    return {
      id: e.id, brand: e.brand.trim(), model: e.model.trim(), type: e.type,
      variant: optStr(e.variant, 80) || "", years: optStr(e.years, 20),
      fuel: FUELS.includes(e.fuel) ? e.fuel : null, tank: e.tank,
      source: e.source, checked: e.checked, doc: optStr(e.doc, 80), note: optStr(e.note, 160),
    };
  }

  // The parsed file: usable entries only, each id once.
  function parse(raw) {
    let d = raw;
    if (typeof raw === "string") { try { d = JSON.parse(raw); } catch { d = null; } }
    const out = { checked: null, vehicles: [], gaps: [] };
    if (!isObj(d) || d.format !== 1) return out;
    if (isDay(d.checked)) out.checked = d.checked;
    const seen = new Set();
    for (const e of Array.isArray(d.vehicles) ? d.vehicles : []) {
      const v = cleanEntry(e);
      if (v && !seen.has(v.id)) { seen.add(v.id); out.vehicles.push(v); }
    }
    out.gaps = (Array.isArray(d.gaps) ? d.gaps : [])
      .filter((g) => isObj(g) && isStr(g.brand, 60) && isStr(g.reason, 300))
      .map((g) => ({ brand: g.brand, models: optStr(g.models, 120) || "", reason: g.reason }));
    return out;
  }

  const byName = (a, b) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true });

  function brands(cat, type) {
    const list = ((cat && cat.vehicles) || []).filter((v) => !type || v.type === type).map((v) => v.brand);
    return [...new Set(list)].sort(byName);
  }

  function models(cat, type, brand) {
    return ((cat && cat.vehicles) || [])
      .filter((v) => (!type || v.type === type) && v.brand === brand)
      .sort((a, b) => byName(a.model, b.model) || byName(a.variant, b.variant) || byName(a.years || "", b.years || ""));
  }

  const byId = (cat, id) => ((cat && cat.vehicles) || []).find((v) => v.id === id) || null;

  // "Tucson · 1.6T Hybrid 239PS", "PCX125 · 2025".
  const label = (v) => [v.model, v.variant, v.years].filter(Boolean).join(" · ");
  const fullName = (v) => `${v.brand} ${v.model}`.slice(0, 40);

  function site(v) {
    try { return new URL(v.source).hostname.replace(/^www\./, ""); } catch { return ""; }
  }

  const api = { TYPES, cleanEntry, parse, brands, models, byId, label, fullName, site };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Catalog = api;
})(typeof self !== "undefined" ? self : this);
