/* Fuel Tracker: pure calculation logic. No DOM access, so it runs in the app and in Node tests. */
(function (root) {
  "use strict";

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDate = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 864e5);
  const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return isoDate(d); };

  /* ---------- one fill-up, as typed in the form ---------- */
  function computeFuel({ odoStart, odoEnd, price, mode, liters, amount, unknownStart }) {
    if (!(odoEnd >= 0) || isNaN(odoEnd)) return { error: "errOdoNow" };
    if (unknownStart) odoStart = odoEnd;
    if (!(odoStart >= 0) || isNaN(odoStart)) return { error: "errOdoLast" };
    const distance = odoEnd - odoStart;
    if (!unknownStart && !(distance > 0)) return { error: "errOdoOrder" };
    if (!(price > 0)) return { error: "errPrice" };
    let L, cost;
    if (mode === "money") {
      if (!(amount > 0)) return { error: "errAmount" };
      cost = amount; L = amount / price;
    } else {
      if (!(liters > 0)) return { error: "errLiters" };
      L = liters; cost = liters * price;
    }
    const r = { distance, liters: L, cost, odoStart };
    if (distance > 0) {
      Object.assign(r, {
        litersPerKm: L / distance, litersPer100: L / distance * 100, kmPerLiter: distance / L,
        costPerKm: cost / distance, costPer100: cost / distance * 100,
      });
    }
    return r;
  }

  /* ---------- currency: every record keeps the rate to the home currency it was saved with ---------- */
  // rec.rate converts to rec.rateHome (the home currency when it was saved). If the home currency changed
  // since, the saved rate is chained through today's rate for that old home currency.
  function toHome(amount, rec, settings) {
    if (rec.currency === settings.home) return amount;
    const rates = settings.rates || {};
    let rate = null;
    if (rec.rate > 0) {
      if (!rec.rateHome || rec.rateHome === settings.home) rate = rec.rate;
      else if (rates[rec.rateHome] > 0) rate = rec.rate * rates[rec.rateHome];
    }
    if (rate == null) rate = rates[rec.currency];
    return rate > 0 ? amount * rate : null;
  }

  // Rough starting rates, in MAD. The user confirms the real rate on each fill-up abroad.
  const MAD_PER = { MAD: 1, EUR: 10.8, USD: 9.3 };
  function defaultRates(home) {
    const out = {};
    for (const c of Object.keys(MAD_PER)) if (c !== home) out[c] = +(MAD_PER[c] / MAD_PER[home]).toPrecision(4);
    return out;
  }

  const sortFills = (a, b) => (a.odo - b.odo) || (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0));

  /*
   * Full-tank to full-tank consumption, per vehicle.
   * Each fill-up covers the distance from its own prevOdo to its odo. Partial fills add their liters and
   * distance to the next full tank. A fill marked "missed" means fuel went in that was never logged, so the
   * full-to-full stretch it belongs to is thrown away instead of producing a wrong number.
   */
  function segments(fills, settings) {
    const byVeh = new Map();
    for (const f of fills) {
      if (!byVeh.has(f.vehicle)) byVeh.set(f.vehicle, []);
      byVeh.get(f.vehicle).push(f);
    }
    const out = [];
    for (const [vehicle, list] of byVeh) {
      list.sort(sortFills);
      let acc = { distance: 0, liters: 0, cost: 0, costOk: true, broken: false, count: 0 };
      for (const f of list) {
        const d = f.odo - f.prevOdo;
        if (f.missed) acc.broken = true;
        acc.distance += d > 0 ? d : 0;
        acc.liters += f.liters;
        const c = settings ? toHome(f.cost, f, settings) : f.cost;
        if (c == null) acc.costOk = false; else acc.cost += c;
        acc.count++;
        if (f.full !== false) {
          if (!acc.broken && acc.distance > 0 && acc.liters > 0) {
            out.push({
              vehicle, date: f.date, endId: f.id, distance: acc.distance, liters: acc.liters,
              cost: acc.costOk ? acc.cost : null, fills: acc.count,
              l100: acc.liters / acc.distance * 100,
            });
          }
          acc = { distance: 0, liters: 0, cost: 0, costOk: true, broken: false, count: 0 };
        }
      }
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  /* Partial fills since the last full tank for one vehicle (they wait for the next full tank). */
  function pendingSinceFull(fills, vehicle, excludeId) {
    const list = fills.filter((f) => f.vehicle === vehicle && f.id !== excludeId).sort(sortFills);
    const pend = [];
    for (const f of list) { if (f.full === false) pend.push(f); else pend.length = 0; }
    return pend;
  }

  /* ---------- periods ---------- */
  function isoWeek(y, m, d) {
    const t = new Date(Date.UTC(y, m - 1, d));
    t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
    const wy = t.getUTCFullYear();
    const jan4 = new Date(Date.UTC(wy, 0, 4));
    const wk = 1 + Math.round(((t - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
    return [wy, wk];
  }
  // Returns [sortable key, label parts] for a YYYY-MM-DD date. Labels are finished by the UI (language).
  function periodOf(date, per) {
    const [y, m, d] = date.split("-").map(Number);
    switch (per) {
      case "day": return [date, { kind: "day", y, m, d }];
      case "week": { const [wy, wk] = isoWeek(y, m, d); return [`${wy}-W${pad(wk)}`, { kind: "week", y: wy, w: wk }]; }
      case "month": return [`${y}-${pad(m)}`, { kind: "month", y, m }];
      case "quarter": { const q = Math.ceil(m / 3); return [`${y}-Q${q}`, { kind: "quarter", y, q }]; }
      case "half": { const h = m <= 6 ? 1 : 2; return [`${y}-H${h}`, { kind: "half", y, h }]; }
      default: return [`${y}`, { kind: "year", y }];
    }
  }

  function aggregate(records, settings, per, vehicle) {
    const fills = records.filter((r) => r.kind === "fill" && (vehicle === "all" || r.vehicle === vehicle));
    const incomes = records.filter((r) => r.kind === "income" && (vehicle === "all" || r.vehicle === vehicle));
    const segs = segments(fills, settings);
    const groups = new Map();
    const g = (date) => {
      const [key, label] = periodOf(date, per);
      if (!groups.has(key)) groups.set(key, { key, label, distance: 0, liters: 0, spent: 0, spentOk: true, count: 0, segDist: 0, segLiters: 0, segCost: 0, segCostOk: true, income: 0, incomeOk: true });
      return groups.get(key);
    };
    for (const f of fills) {
      const x = g(f.date);
      const d = f.odo - f.prevOdo;
      x.distance += d > 0 ? d : 0; x.liters += f.liters; x.count++;
      const c = toHome(f.cost, f, settings);
      if (c == null) x.spentOk = false; else x.spent += c;
    }
    for (const s of segs) {
      const x = g(s.date);
      x.segDist += s.distance; x.segLiters += s.liters;
      if (s.cost == null) x.segCostOk = false; else x.segCost += s.cost;
    }
    for (const i of incomes) {
      const x = g(i.date);
      const a = toHome(i.amount, i, settings);
      if (a == null) x.incomeOk = false; else x.income += a;
    }
    for (const x of groups.values()) {
      x.l100 = x.segDist > 0 ? x.segLiters / x.segDist * 100 : null;
      x.cost100 = x.segDist > 0 && x.segCostOk ? x.segCost / x.segDist * 100 : null;
      x.profit = x.income - x.spent;
    }
    return [...groups.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
  }

  /* ---------- Morocco: pump prices change on the 1st and 16th of each month ---------- */
  function lastPriceChange(today) {
    const [y, m, d] = today.split("-").map(Number);
    return d >= 16 ? `${y}-${pad(m)}-16` : `${y}-${pad(m)}-01`;
  }
  function priceMayBeStale(lastPriceDate, today) {
    if (!lastPriceDate) return null;
    const change = lastPriceChange(today);
    return lastPriceDate < change ? change : null;
  }

  /* ---------- averages and insights ---------- */
  function vehicleAverage(segs, vehicle, n) {
    const list = segs.filter((s) => s.vehicle === vehicle);
    const use = n ? list.slice(-n) : list;
    const dist = use.reduce((a, s) => a + s.distance, 0);
    const lit = use.reduce((a, s) => a + s.liters, 0);
    return dist > 0 ? lit / dist * 100 : null;
  }

  function movingAverage(values, n) {
    return values.map((_, i) => {
      const from = Math.max(0, i - n + 1);
      const part = values.slice(from, i + 1);
      return part.reduce((a, v) => a + v, 0) / part.length;
    });
  }

  function insights(records, settings, vehicle, today) {
    const fills = records.filter((r) => r.kind === "fill" && (vehicle === "all" || r.vehicle === vehicle));
    const segs = segments(fills, settings);
    const out = {};
    const month = today.slice(0, 7), year = today.slice(0, 4);
    const monthSegs = segs.filter((s) => s.date.slice(0, 7) === month);
    const olderSegs = segs.filter((s) => s.date.slice(0, 7) < month);
    const l100 = (list) => { const d = list.reduce((a, s) => a + s.distance, 0); return d > 0 ? list.reduce((a, s) => a + s.liters, 0) / d * 100 : null; };
    out.monthL100 = l100(monthSegs);
    out.avgL100 = l100(olderSegs);
    if (out.monthL100 != null && out.avgL100 != null && olderSegs.length >= 2) out.changePct = (out.monthL100 / out.avgL100 - 1) * 100;

    // A single tank far above the recent average deserves a heads-up.
    if (segs.length >= 4) {
      const last = segs[segs.length - 1];
      const prev = l100(segs.slice(-6, -1));
      if (prev && last.l100 > prev * 1.25) out.spike = { l100: last.l100, prev, date: last.date };
    }

    const spentIn = (prefix) => fills.filter((f) => f.date.startsWith(prefix)).reduce((a, f) => a + (toHome(f.cost, f, settings) || 0), 0);
    out.monthSpent = spentIn(month);
    out.yearSpent = spentIn(year);
    const [y, m, d] = today.split("-").map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    out.monthProjection = d >= 3 ? out.monthSpent / d * daysInMonth : null;
    const dayOfYear = daysBetween(`${y}-01-01`, today) + 1;
    const daysInYear = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
    out.yearProjection = dayOfYear >= 30 && out.yearSpent > 0 ? out.yearSpent / dayOfYear * daysInYear : null;
    if (settings.budget > 0) out.budget = { budget: settings.budget, spent: out.monthSpent, pct: out.monthSpent / settings.budget * 100 };

    out.trend = segs.slice(-20).map((s) => ({ date: s.date, l100: s.l100 }));
    out.trendAvg = movingAverage(out.trend.map((t) => t.l100), 3);
    out.stations = stationStats(fills, settings, today);
    return out;
  }

  /* Average price paid per station over the last 120 days, in the home currency, per fuel type. */
  function stationStats(fills, settings, today, vehicles) {
    const since = addDays(today, -120);
    const map = new Map();
    for (const f of fills) {
      if (!f.station || f.date < since) continue;
      const p = toHome(f.price, f, settings);
      if (p == null) continue;
      const fuel = f.fuel || "essence";
      const key = fuel + "|" + f.station.trim().toLowerCase();
      if (!map.has(key)) map.set(key, { station: f.station.trim(), fuel, total: 0, liters: 0, count: 0, last: f.date });
      const s = map.get(key);
      s.total += p * f.liters; s.liters += f.liters; s.count++;
      if (f.date > s.last) s.last = f.date;
    }
    const list = [...map.values()].map((s) => ({ ...s, avgPrice: s.total / s.liters }));
    const byFuel = {};
    for (const s of list) (byFuel[s.fuel] = byFuel[s.fuel] || []).push(s);
    for (const k in byFuel) byFuel[k].sort((a, b) => a.avgPrice - b.avgPrice);
    return byFuel;
  }

  function stationNames(fills) {
    const seen = new Map();
    for (const f of [...fills].sort((a, b) => (a.date < b.date ? 1 : -1))) {
      if (!f.station) continue;
      const k = f.station.trim().toLowerCase();
      if (!seen.has(k)) seen.set(k, f.station.trim());
    }
    return [...seen.values()];
  }

  /* ---------- trip cost ---------- */
  function tripCost({ km, roundTrip, l100, price, people }) {
    if (!(km > 0) || !(l100 > 0) || !(price > 0)) return null;
    const distance = roundTrip ? km * 2 : km;
    const liters = distance * l100 / 100;
    const cost = liters * price;
    const n = Math.max(1, Math.floor(people || 1));
    return { distance, liters, cost, perPerson: cost / n, people: n };
  }

  /* ---------- reminders (oil change by km, paperwork by date) ---------- */
  function reminderStatus(rem, currentOdo, today) {
    if (rem.everyKm > 0) {
      const dueKm = (rem.lastKm || 0) + rem.everyKm;
      const left = currentOdo != null ? dueKm - currentOdo : null;
      const soon = left != null && left <= Math.min(1000, rem.everyKm * 0.15);
      return { kind: "km", dueKm, left, soon, overdue: left != null && left < 0 };
    }
    if (rem.dueDate) {
      const left = daysBetween(today, rem.dueDate);
      return { kind: "date", dueDate: rem.dueDate, left, soon: left <= 30, overdue: left < 0 };
    }
    return { kind: "none", soon: false, overdue: false };
  }

  function latestOdo(records, vehicle) {
    let best = null;
    for (const r of records) if (r.kind === "fill" && r.vehicle === vehicle && (best == null || r.odo > best)) best = r.odo;
    return best;
  }

  function nextYear(date) {
    const [y, m, d] = date.split("-").map(Number);
    const last = new Date(y + 1, m, 0).getDate();
    return `${y + 1}-${pad(m)}-${pad(Math.min(d, last))}`;
  }

  /* ---------- data: validation, migration from version 1, backup files, CSV ---------- */
  const CURRENCIES = ["MAD", "EUR", "USD"];
  const isNum = (n) => typeof n === "number" && isFinite(n);

  function validRecord(r) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || typeof r.vehicle !== "string" || !CURRENCIES.includes(r.currency)) return false;
    if (r.kind === "income") return isNum(r.amount);
    return r.kind === "fill" && [r.odo, r.prevOdo, r.liters, r.cost, r.price].every(isNum);
  }

  // Version 1 saved fill-ups with vehicle "car" or "bike", no kind, always a full tank.
  function migrateRecord(r) {
    if (!r || typeof r !== "object") return r;
    const out = { ...r };
    if (!out.kind) out.kind = "fill";
    if (out.kind === "fill") {
      if (out.full === undefined) out.full = true;
      if (out.missed === undefined) out.missed = false;
    }
    return out;
  }

  function defaultSettings(lang) {
    return { version: 2, lang: lang || "en", home: "MAD", rates: defaultRates("MAD"), vehicles: [], budget: 0, driverMode: false, reminders: [], onboarded: false, lastBackup: null, activeVehicle: null };
  }

  function migrateSettings(settings, records, lang) {
    const s = { ...defaultSettings(lang), ...(settings || {}) };
    s.rates = { ...defaultRates(s.home), ...(s.rates || {}) };
    if (!Array.isArray(s.vehicles)) s.vehicles = [];
    if (!Array.isArray(s.reminders)) s.reminders = [];
    // Vehicles used by old records but missing from settings (version 1 had a fixed car and motorbike).
    for (const r of records || []) {
      if (r && typeof r.vehicle === "string" && !s.vehicles.some((v) => v.id === r.vehicle)) {
        s.vehicles.push({ id: r.vehicle, name: r.vehicle === "bike" ? "Motorbike" : r.vehicle === "car" ? "Car" : r.vehicle, type: r.vehicle === "bike" ? "bike" : "car", fuel: "essence", tank: null });
      }
    }
    if ((records || []).length && s.vehicles.length) s.onboarded = true;
    if (!s.activeVehicle || !s.vehicles.some((v) => v.id === s.activeVehicle)) s.activeVehicle = s.vehicles.length ? s.vehicles[0].id : null;
    return s;
  }

  function backupFile(records, settings, now) {
    return { app: "fuel-tracker", format: 2, exportedAt: now || new Date().toISOString(), settings: { ...settings, lastBackup: undefined }, records };
  }

  function parseBackup(text) {
    let data;
    try { data = JSON.parse(text); } catch { return { error: "errBackupRead" }; }
    // Accept a bare list of records too (version 1 data copied by hand).
    if (Array.isArray(data)) data = { app: "fuel-tracker", records: data };
    if (!data || data.app !== "fuel-tracker" || !Array.isArray(data.records)) return { error: "errBackupRead" };
    const records = data.records.map(migrateRecord).filter(validRecord);
    return { records, settings: data.settings || null, skipped: data.records.length - records.length };
  }

  function csvCell(v) {
    const s = v == null ? "" : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function toCsv(records, settings) {
    const name = (id) => (settings.vehicles.find((v) => v.id === id) || {}).name || id;
    const head = ["date", "type", "vehicle", "odometer_km", "previous_odometer_km", "liters", "price_per_liter", "amount", "currency", "rate_to_" + settings.home, "full_tank", "missed_before", "station", "note"];
    const rows = [...records].sort((a, b) => (a.date < b.date ? -1 : 1)).map((r) => r.kind === "income"
      ? [r.date, "earning", name(r.vehicle), "", "", "", "", r.amount, r.currency, r.rate || "", "", "", "", r.note || ""]
      : [r.date, "fill", name(r.vehicle), r.odo, r.prevOdo, r.liters, r.price, r.cost, r.currency, r.rate || "", r.full === false ? "no" : "yes", r.missed ? "yes" : "no", r.station || "", r.note || ""]);
    return [head, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
  }

  /* Numbers found in OCR text, with the label they appear next to (pump display, receipt, dashboard). */
  function numbersFromText(text) {
    const out = [];
    const lines = String(text || "").split(/\n+/);
    const label = (l) => {
      const s = l.toLowerCase();
      if (/(prix|price|p\.u|\/l|سعر|thaman|ثمن)/.test(s)) return "price";
      if (/(litre|liter|lit\b|\bl\b|لتر|vol)/.test(s)) return "liters";
      if (/(montant|total|amount|dh|mad|درهم|مبلغ|à payer|a payer)/.test(s)) return "amount";
      if (/(km|odo|kilom)/.test(s)) return "odo";
      return null;
    };
    let prevLabel = null;
    for (const line of lines) {
      const lab = label(line);
      const nums = line.match(/\d+(?:[.,\s]\d{3})*(?:[.,]\d+)?/g) || [];
      for (const raw of nums) {
        let s = raw.replace(/\s/g, "");
        // "1.234,56" or "1,234.56": the last separator is the decimal one.
        const lastSep = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
        if (lastSep >= 0) {
          const decimals = s.length - lastSep - 1;
          if (decimals === 3 && (s.match(/[.,]/g) || []).length === 1 && s.length > 5) s = s.replace(/[.,]/g, "");
          else s = s.slice(0, lastSep).replace(/[.,]/g, "") + "." + s.slice(lastSep + 1);
        }
        const value = parseFloat(s);
        if (isFinite(value) && value > 0) out.push({ value, raw, hint: lab || prevLabel });
      }
      if (lab && !nums.length) prevLabel = lab; else prevLabel = null;
    }
    return out;
  }

  const api = {
    MONTHS, pad, isoDate, parseDate, daysBetween, addDays,
    computeFuel, toHome, defaultRates, segments, pendingSinceFull, isoWeek, periodOf, aggregate,
    lastPriceChange, priceMayBeStale, vehicleAverage, movingAverage, insights, stationStats, stationNames,
    tripCost, reminderStatus, latestOdo, nextYear,
    CURRENCIES, validRecord, migrateRecord, defaultSettings, migrateSettings, backupFile, parseBackup, toCsv, numbersFromText,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FT = api;
})(typeof self !== "undefined" ? self : this);
