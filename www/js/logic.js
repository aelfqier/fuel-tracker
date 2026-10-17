/* Fuel Tracker: pure calculation logic. No DOM access, so it runs in the app and in Node tests. */
(function (root) {
  "use strict";

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDate = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 864e5);
  const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return isoDate(d); };
  const isNum = (n) => typeof n === "number" && isFinite(n);
  // A real calendar date written YYYY-MM-DD ("2026-02-30" rolls over in Date, so it fails the round trip).
  const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && isoDate(parseDate(s)) === s;

  /* ---------- numbers typed by people in English, French or Arabic ---------- */
  // Arabic-Indic digits and the Arabic decimal and thousands marks, as plain ASCII.
  function normDigits(s) {
    return String(s)
      .replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 0x660)
      .replace(/[۰-۹]/g, (c) => c.charCodeAt(0) - 0x6f0)
      .replace(/٫/g, ".").replace(/٬/g, "");
  }

  // "13,45", "1.234,56", "1,234.56", "١٣٫٤٥". Odometer fields (integerish) read "45.650" as 45650.
  function parseNum(str, opts) {
    if (typeof str === "number") return isNum(str) ? str : NaN;
    let s = normDigits(str == null ? "" : str).trim().replace(/[\s  ]/g, "");
    const neg = s[0] === "-";
    if (neg) s = s.slice(1);
    if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return NaN;
    const commas = (s.match(/,/g) || []).length, dots = (s.match(/\./g) || []).length;
    // Thousands come in groups of 3, so a doubled mark ("13,,45") is a typo, not 1345.
    if (commas && dots) {
      const last = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
      if (!/^\d{1,3}([.,]\d{3})*$/.test(s.slice(0, last))) return NaN;
      s = s.slice(0, last).replace(/[.,]/g, "") + "." + s.slice(last + 1);
    } else if (commas > 1 || dots > 1) {
      if (!/^\d{1,3}([.,]\d{3})+$/.test(s)) return NaN;
      s = s.replace(/[.,]/g, "");
    } else if (commas || dots) {
      const at = s.search(/[.,]/);
      const thousands = opts && opts.integerish && at > 0 && s.length - at - 1 === 3;
      s = thousands ? s.replace(/[.,]/, "") : s.replace(",", ".");
    }
    const v = Number(s);
    return isNum(v) ? (neg ? -v : v) : NaN;
  }

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
    if (!MAD_PER[home]) return out; // another home currency: the user types each rate once
    for (const c of Object.keys(MAD_PER)) if (c !== home) out[c] = +(MAD_PER[c] / MAD_PER[home]).toPrecision(4);
    return out;
  }

  /* ---------- energy units: fuel in liters, electricity in kWh (kept in the liters field) ---------- */
  const unitOf = (r) => (r && r.unit === "kWh" ? "kWh" : "L");
  function primaryUnit(vehicle) { return vehicle && vehicle.fuel === "electric" ? "kWh" : "L"; }
  // The unit whose fills carry a vehicle's kilometers; vehicles missing from settings count as fuel.
  const vehUnit = (settings, id) => primaryUnit(((settings && settings.vehicles) || []).find((v) => v && v.id === id));

  // After an odometer reset the readings start low again, so the meter number comes first.
  const sortFills = (a, b) => ((a.meter || 0) - (b.meter || 0)) || (a.odo - b.odo) ||
    (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0));

  /*
   * Full-tank to full-tank consumption, per vehicle and energy unit.
   * Each fill-up covers the distance from its own prevOdo to its odo. Partial fills add their liters and
   * distance to the next full tank. A fill marked "missed" means fuel went in that was never logged, so the
   * full-to-full stretch it belongs to is thrown away instead of producing a wrong number.
   */
  function segments(fills, settings) {
    const chains = new Map();
    for (const f of fills) {
      const key = unitOf(f) + ":" + f.vehicle;
      if (!chains.has(key)) chains.set(key, []);
      chains.get(key).push(f);
    }
    const out = [];
    const fresh = () => ({ distance: 0, liters: 0, cost: 0, costOk: true, broken: false, count: 0 });
    for (const list of chains.values()) {
      list.sort(sortFills);
      const vehicle = list[0].vehicle, unit = unitOf(list[0]);
      let acc = fresh(), started = false;
      for (const f of list) {
        const d = f.odo - f.prevOdo;
        // Before the first full tank nobody knows how much was already in it: those partial fills only set the start.
        if (f.missed || (!started && f.full === false)) acc.broken = true;
        acc.distance += d > 0 ? d : 0;
        acc.liters += f.liters;
        const c = settings ? toHome(f.cost, f, settings) : f.cost;
        if (c == null) acc.costOk = false; else acc.cost += c;
        acc.count++;
        if (f.full !== false) {
          if (!acc.broken && acc.distance > 0 && acc.liters > 0) {
            out.push({
              vehicle, unit, date: f.date, endId: f.id, distance: acc.distance, liters: acc.liters,
              cost: acc.costOk ? acc.cost : null, fills: acc.count,
              l100: acc.liters / acc.distance * 100,
            });
          }
          acc = fresh();
          started = true;
        }
      }
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  /* Partial fills since the last full tank for one vehicle (they wait for the next full tank). */
  function pendingSinceFull(fills, vehicle, excludeId) {
    const list = fills.filter((f) => f.vehicle === vehicle && (excludeId == null || f.id !== excludeId)).sort(sortFills);
    const pend = [];
    let started = false;
    // Partial fills before the first full tank never count, so they wait for nothing.
    for (const f of list) {
      if (f.full !== false) { started = true; pend.length = 0; } else if (started) pend.push(f);
    }
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
      if (!groups.has(key)) {
        groups.set(key, {
          key, label, distance: 0, liters: 0, kwh: 0, spent: 0, spentOk: true, count: 0,
          segDist: 0, segLiters: 0, segKwhDist: 0, segKwh: 0, segMainDist: 0, segCost: 0, segCostOk: true,
          income: 0, incomeOk: true,
        });
      }
      return groups.get(key);
    };
    for (const f of fills) {
      const x = g(f.date), unit = unitOf(f);
      const d = f.odo - f.prevOdo;
      // A plug-in hybrid logs the same kilometers on fuel and on charging: only its primary unit counts them.
      if (unit === vehUnit(settings, f.vehicle)) x.distance += d > 0 ? d : 0;
      if (unit === "kWh") x.kwh += f.liters; else x.liters += f.liters;
      x.count++;
      const c = toHome(f.cost, f, settings);
      if (c == null) x.spentOk = false; else x.spent += c;
    }
    for (const s of segs) {
      const x = g(s.date);
      if (s.unit === "kWh") { x.segKwhDist += s.distance; x.segKwh += s.liters; } else { x.segDist += s.distance; x.segLiters += s.liters; }
      if (s.unit !== vehUnit(settings, s.vehicle)) continue;
      x.segMainDist += s.distance;
      if (s.cost == null) x.segCostOk = false; else x.segCost += s.cost;
    }
    for (const i of incomes) {
      const x = g(i.date);
      const a = toHome(i.amount, i, settings);
      if (a == null) x.incomeOk = false; else x.income += a;
    }
    for (const x of groups.values()) {
      x.l100 = x.segDist > 0 ? x.segLiters / x.segDist * 100 : null;
      x.kwh100 = x.segKwhDist > 0 ? x.segKwh / x.segKwhDist * 100 : null;
      x.cost100 = x.segMainDist > 0 && x.segCostOk ? x.segCost / x.segMainDist * 100 : null;
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
  // The next n price-change days, today included when it is one.
  function priceDays(today, n) {
    let [y, m, d] = today.split("-").map(Number);
    if (d > 16) { d = 1; m++; } else if (d > 1 && d < 16) d = 16;
    const out = [];
    while (out.length < n) {
      if (m > 12) { m = 1; y++; }
      out.push(`${y}-${pad(m)}-${pad(d)}`);
      if (d === 1) d = 16; else { d = 1; m++; }
    }
    return out;
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

  // One vehicle: its primary unit. All vehicles: kWh only when every vehicle is electric.
  function insightUnit(settings, vehicle) {
    if (vehicle !== "all") return vehUnit(settings, vehicle);
    const list = (settings && settings.vehicles) || [];
    return list.length && list.every((v) => primaryUnit(v) === "kWh") ? "kWh" : "L";
  }

  function insights(records, settings, vehicle, today) {
    const fills = records.filter((r) => r.kind === "fill" && (vehicle === "all" || r.vehicle === vehicle));
    const unit = insightUnit(settings, vehicle);
    const segs = segments(fills, settings).filter((s) => s.unit === unit && vehUnit(settings, s.vehicle) === unit);
    const out = { unit };
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
      // A plug-in hybrid's charging stops are priced per kWh, so they rank with the other chargers.
      const fuel = unitOf(f) === "kWh" ? "electric" : f.fuel || "essence";
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

  /* ---------- odometer: latest reading, last fill-up, resets ---------- */
  // Highest reading on the vehicle's latest meter (readings from before a reset are higher but older).
  function latestOdo(records, vehicle) {
    let meter = -1, best = null;
    for (const r of records) {
      if (r.kind !== "fill" || r.vehicle !== vehicle) continue;
      const m = r.meter || 0;
      if (m > meter) { meter = m; best = r.odo; } else if (m === meter && r.odo > best) best = r.odo;
    }
    return best;
  }

  function lastFill(records, vehicle, opts) {
    const o = opts || {};
    const list = records.filter((r) => r.kind === "fill" && r.vehicle === vehicle &&
      (o.excludeId == null || r.id !== o.excludeId) && (!o.unit || unitOf(r) === o.unit)).sort(sortFills);
    return list.length ? list[list.length - 1] : null;
  }

  // A reading lower than the last one: a 5-digit counter going 99,850 -> 120 drove 270 km.
  function rolloverGuess(prevOdo, odo) {
    if (!isNum(prevOdo) || !isNum(odo) || !(prevOdo > 0) || !(odo >= 0) || !(odo < prevOdo)) return null;
    const km = Math.pow(10, String(Math.floor(prevOdo)).length) - prevOdo + odo;
    return km > 0 && km <= 2000 ? km : null;
  }

  function nextYear(date) {
    const [y, m, d] = date.split("-").map(Number);
    const last = new Date(y + 1, m, 0).getDate();
    return `${y + 1}-${pad(m)}-${pad(Math.min(d, last))}`;
  }

  /* ---------- plausible values, to check a scan or a fill-up before it is saved ---------- */
  const PRICE_L = { MAD: [4, 40], EUR: [0.5, 4], USD: [0.5, 4] };
  const PRICE_KWH = { MAD: [0.5, 10], EUR: [0.05, 1.5], USD: [0.05, 1.5] };
  const inRange = (x, r) => x >= r[0] && x <= r[1];
  // Other currencies have no known range, so any positive price passes.
  const priceOk = (p, currency, unit) => { const r = (unit === "kWh" ? PRICE_KWH : PRICE_L)[currency]; return r ? inRange(p, r) : p > 0; };
  const litersOk = (l, o) => l > 0 && l <= (o.tank ? o.tank * 1.15 : o.type === "bike" ? 40 : 250);
  // How far a price is from the middle of its currency's usual range, on a log scale (0 when there's no range).
  const typical = (p, currency) => { const r = PRICE_L[currency]; return r ? Math.abs(Math.log(p / Math.sqrt(r[0] * r[1]))) : 0; };
  const readings = (n) => (n.alt != null ? [n.value, n.alt] : [n.value]);
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  /*
   * Price, liters and amount from scanned numbers. A price times liters that matches an amount within 1%
   * is trusted (verified); otherwise each field takes the first plausible number next to its label.
   */
  function scanFields(nums, opts) {
    const o = opts || {}, all = nums || [];
    const list = all.slice(0, 60); // keeps the three-way search quick on a long receipt
    const fit = (n, role) => (n.hint === role ? 2 : n.hint ? -1 : 0);
    let best = null;
    for (let i = 0; i < list.length; i++) for (let j = 0; j < list.length; j++) for (let k = 0; k < list.length; k++) {
      if (i === j || j === k || i === k) continue;
      const score = fit(list[i], "price") + fit(list[j], "liters") + fit(list[k], "amount");
      for (const p of readings(list[i])) if (priceOk(p, o.currency)) for (const l of readings(list[j])) if (litersOk(l, o)) {
        for (const a of readings(list[k])) {
          const err = a > 0 ? Math.abs(p * l - a) / a : Infinity;
          if (err > 0.01) continue;
          const off = typical(p, o.currency);
          // Equal labels and fit: price and liters can swap (13.45 × 30.25), so the more usual price wins.
          const better = !best || score > best.score || (score === best.score && (err < best.err - 1e-9 || (Math.abs(err - best.err) <= 1e-9 && off < best.off)));
          if (better) best = { price: p, liters: l, amount: a, score, err, off };
        }
      }
    }
    let odo = null;
    for (const n of all) {
      const km = Math.max(...readings(n));
      if (n.hint === "odo" && km > 100) { odo = Math.round(km); break; }
    }
    if (best) return { price: best.price, liters: best.liters, amount: best.amount, odo, verified: true };
    const first = (role, ok) => { for (const n of all) if (n.hint === role) for (const x of readings(n)) if (ok(x)) return x; return null; };
    return {
      price: first("price", (p) => priceOk(p, o.currency)), liters: first("liters", (l) => litersOk(l, o)),
      amount: first("amount", (a) => a > 0), odo, verified: false,
    };
  }

  /* Things worth a second look before a fill-up is saved, as message keys with their values. */
  function plausibility(rec, ctx) {
    const c = ctx || {}, v = c.vehicle || {}, unit = unitOf(rec), out = [];
    const km = rec.odo - rec.prevOdo;
    const past = (c.history || []).filter((f) => unitOf(f) === unit).sort(sortFills)
      .map((f) => f.odo - f.prevOdo).filter((d) => d > 0).slice(-10);
    if (past.length >= 3) {
      const usual = median(past);
      if (km > 300 && km > usual * 3) out.push({ key: "warnDistance", vars: { km, usual } });
    }
    if (c.l100 != null) {
      const r = unit === "kWh" ? [5, 40] : v.type === "bike" ? [1, 12] : [2, 25];
      // A plug-in hybrid's fuel and charging chains share the kilometers, so either can read very low.
      if (!inRange(c.l100, v.fuel === "hybrid" ? [0, r[1]] : r)) out.push({ key: "warnConsumption", vars: { value: c.l100, unit } });
    }
    if (unit === "L" && v.tank > 0 && rec.liters > v.tank * 1.1) out.push({ key: "warnTank", vars: { liters: rec.liters, tank: v.tank } });
    const pr = (unit === "kWh" ? PRICE_KWH : PRICE_L)[rec.currency];
    if (pr && !inRange(rec.price, pr)) out.push({ key: "warnPrice", vars: { price: rec.price, currency: rec.currency } });
    return out;
  }

  /* ---------- data: validation, migration from version 1, backup files, CSV ---------- */
  const CURRENCIES = ["MAD", "EUR", "USD"]; // the default pickers; any ISO 4217 code is accepted
  const FUELS = ["essence", "gasoil", "electric", "hybrid"];
  const LANGS = ["en", "fr", "ar"];
  const REMINDER_KINDS = ["oil", "insurance", "inspection", "vignette", "other"];
  const BACKUP_FORMAT = 3;
  const isCur = (c) => typeof c === "string" && /^[A-Z]{3}$/.test(c);
  const isStr = (s, max) => typeof s === "string" && s.length >= 1 && s.length <= max;
  const isObj = (o) => !!o && typeof o === "object" && !Array.isArray(o);
  const isPrimitive = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // Optional record fields: each returns the cleaned value, or undefined to drop it.
  const bool = (v) => (typeof v === "boolean" ? v : undefined);
  const stamp = (v) => (isNum(v) ? v : undefined);
  const RECORD_FIELDS = {
    station: (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 60) : undefined),
    note: (v) => (typeof v === "string" ? v.slice(0, 200) : undefined),
    full: bool, missed: bool, reset: bool,
    meter: (v) => (Number.isInteger(v) && v >= 0 ? v : undefined),
    unit: (v) => (v === "L" || v === "kWh" ? v : undefined),
    rate: (v) => (isNum(v) && v > 0 ? v : undefined),
    rateHome: (v) => (isCur(v) ? v : undefined),
    fuel: (v) => (FUELS.includes(v) ? v : undefined),
    createdAt: stamp, updatedAt: stamp,
    id: (v) => (isStr(v, 64) ? v : undefined),
  };

  // Unknown plain values are kept so data written by a newer version survives a round trip.
  function sanitizeRecord(r) {
    if (!isObj(r) || (r.kind !== "fill" && r.kind !== "income")) return null;
    if (!isDay(r.date) || !isStr(r.vehicle, 64) || !isCur(r.currency)) return null;
    if (r.kind === "fill" && !([r.odo, r.prevOdo, r.liters, r.cost, r.price].every(isNum) && r.liters > 0 && r.price > 0 && r.cost >= 0)) return null;
    if (r.kind === "income" && !(isNum(r.amount) && r.amount > 0)) return null;
    const out = {};
    for (const k of Object.keys(r)) {
      if (has(RECORD_FIELDS, k)) { const v = RECORD_FIELDS[k](r[k]); if (v !== undefined) out[k] = v; }
      else if (isPrimitive(r[k]) && !(k in Object.prototype)) out[k] = r[k]; // no "__proto__" or "hasOwnProperty"
    }
    return out;
  }
  const validRecord = (r) => sanitizeRecord(r) !== null;

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
    return {
      version: 2, lang: lang || "en", home: "MAD", rates: defaultRates("MAD"), vehicles: [], budget: 0, driverMode: false,
      reminders: [], onboarded: false, lastBackup: null, activeVehicle: null, priceAlerts: false, review: null, theme: "auto",
    };
  }

  function cleanVehicle(v) {
    if (!isObj(v) || !isStr(v.id, 64) || !/^[\w.-]+$/.test(v.id)) return null;
    const name = typeof v.name === "string" ? v.name.trim().slice(0, 40) : "";
    return {
      id: v.id, name: name || "Car", type: v.type === "bike" ? "bike" : "car",
      fuel: FUELS.includes(v.fuel) ? v.fuel : "essence",
      tank: isNum(v.tank) && v.tank > 0 ? v.tank : null,
      color: typeof v.color === "string" && /^#[0-9a-fA-F]{6}$/.test(v.color) ? v.color : "#d97a06",
      tripMeter: v.tripMeter === true,
    };
  }

  function cleanReminder(r) {
    if (!isObj(r) || !isStr(r.id, 64) || !REMINDER_KINDS.includes(r.kind) || !isStr(r.vehicle, 64)) return null;
    const out = { id: r.id, kind: r.kind, vehicle: r.vehicle, label: typeof r.label === "string" ? r.label.slice(0, 40) : "" };
    if (isNum(r.everyKm) && r.everyKm > 0) out.everyKm = r.everyKm;
    if (isNum(r.lastKm)) out.lastKm = r.lastKm;
    if (isDay(r.dueDate)) out.dueDate = r.dueDate;
    const hist = Array.isArray(r.history) ? r.history : [];
    out.history = hist.filter((h) => isObj(h) && isDay(h.date) && (h.odo == null || isNum(h.odo)))
      .slice(-200).map((h) => ({ date: h.date, odo: isNum(h.odo) ? h.odo : null }));
    return out;
  }

  function cleanReview(r) {
    if (!isObj(r) || !Number.isInteger(r.count) || r.count < 0) return null;
    return { at: isDay(r.at) ? r.at : null, count: r.count };
  }

  // Settings from a file or storage, with only known keys of the right type (they end up in the page).
  function sanitizeSettings(raw, lang) {
    const s = isObj(raw) ? raw : {};
    const out = defaultSettings(LANGS.includes(lang) ? lang : "en");
    const flag = (k) => { if (typeof s[k] === "boolean") out[k] = s[k]; };
    if (Number.isInteger(s.version) && s.version > 0) out.version = s.version;
    if (LANGS.includes(s.lang)) out.lang = s.lang;
    if (isCur(s.home)) out.home = s.home;
    out.rates = defaultRates(out.home);
    if (isObj(s.rates)) {
      const rates = Object.entries(s.rates).filter(([c, v]) => isCur(c) && isNum(v) && v > 0).slice(0, 200);
      out.rates = Object.fromEntries(rates);
    }
    const seen = new Set();
    out.vehicles = [];
    for (const v of (Array.isArray(s.vehicles) ? s.vehicles : []).map(cleanVehicle)) {
      if (v && !seen.has(v.id) && out.vehicles.length < 50) { seen.add(v.id); out.vehicles.push(v); }
    }
    if (isNum(s.budget) && s.budget >= 0) out.budget = s.budget;
    out.reminders = (Array.isArray(s.reminders) ? s.reminders : []).map(cleanReminder).filter(Boolean).slice(0, 100);
    flag("driverMode"); flag("onboarded"); flag("priceAlerts");
    if (typeof s.lastBackup === "string" && !isNaN(Date.parse(s.lastBackup))) out.lastBackup = s.lastBackup;
    if (typeof s.activeVehicle === "string") out.activeVehicle = s.activeVehicle;
    if (["auto", "light", "dark"].includes(s.theme)) out.theme = s.theme;
    out.review = cleanReview(s.review);
    return out;
  }

  function migrateSettings(settings, records, lang) {
    const s = sanitizeSettings(settings, lang);
    s.rates = { ...defaultRates(s.home), ...s.rates };
    // Vehicles used by old records but missing from settings (version 1 had a fixed car and motorbike).
    for (const r of records || []) {
      if (r && typeof r.vehicle === "string" && !s.vehicles.some((v) => v.id === r.vehicle)) {
        s.vehicles.push({ id: r.vehicle, name: r.vehicle === "bike" ? "Motorbike" : r.vehicle === "car" ? "Car" : r.vehicle, type: r.vehicle === "bike" ? "bike" : "car", fuel: "essence", tank: null, color: "#d97a06", tripMeter: false });
      }
    }
    if ((records || []).length && s.vehicles.length) s.onboarded = true;
    if (!s.activeVehicle || !s.vehicles.some((v) => v.id === s.activeVehicle)) s.activeVehicle = s.vehicles.length ? s.vehicles[0].id : null;
    return s;
  }

  function backupFile(records, settings, now) {
    return { app: "fuel-tracker", format: BACKUP_FORMAT, exportedAt: now || new Date().toISOString(), settings: { ...settings, lastBackup: undefined }, records };
  }

  function parseBackup(text) {
    let data;
    try { data = JSON.parse(text); } catch { return { error: "errBackupRead" }; }
    // Accept a bare list of records too (version 1 data copied by hand).
    if (Array.isArray(data)) data = { app: "fuel-tracker", records: data };
    if (!data || data.app !== "fuel-tracker") return { error: "errBackupRead" };
    // A file from a newer version may hold data this one would drop, so say so instead of half-restoring it.
    if (typeof data.format === "number" && data.format > BACKUP_FORMAT) return { error: "errBackupNewer" };
    if (!Array.isArray(data.records)) return { error: "errBackupRead" };
    const records = data.records.map(migrateRecord).map(sanitizeRecord).filter(Boolean);
    return { records, settings: isObj(data.settings) ? sanitizeSettings(data.settings) : null, skipped: data.records.length - records.length };
  }

  /* "Add to mine" restore: by id, the most recently changed copy wins; nothing is lost from either side. */
  function mergeRecords(local, incoming) {
    const list = [...(local || [])];
    const at = new Map();
    list.forEach((r, i) => { if (r && r.id != null) at.set(r.id, i); });
    const changed = (r) => r.updatedAt || r.createdAt || 0;
    let added = 0, updated = 0;
    for (const r of incoming || []) {
      if (r.id == null || !at.has(r.id)) {
        if (r.id != null) at.set(r.id, list.length);
        list.push(r); added++;
      } else if (changed(r) > changed(list[at.get(r.id)])) {
        list[at.get(r.id)] = r; updated++;
      }
    }
    return { list, added, updated };
  }

  /* Ask for a store review after 3 full-tank results, and again at most every 120 days with 3 more. */
  function shouldAskReview(count, review, today) {
    if (!review) return count >= 3;
    return isDay(review.at) && daysBetween(review.at, today) >= 120 && count >= (review.count || 0) + 3;
  }

  function csvCell(v) {
    // A typed station or note starting with = + @ would run as a formula in a spreadsheet.
    const s = v == null ? "" : typeof v === "string" && /^[=+@\t\r]/.test(v) ? "'" + v : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function toCsv(records, settings) {
    const name = (id) => (settings.vehicles.find((v) => v.id === id) || {}).name || id;
    const head = ["date", "type", "vehicle", "odometer_km", "previous_odometer_km", "liters", "price_per_liter", "amount", "currency", "rate_to_" + settings.home, "full_tank", "missed_before", "station", "note", "unit"];
    const rows = [...records].sort((a, b) => (a.date < b.date ? -1 : 1)).map((r) => r.kind === "income"
      ? [r.date, "earning", name(r.vehicle), "", "", "", "", r.amount, r.currency, r.rate || "", "", "", "", r.note || "", ""]
      : [r.date, "fill", name(r.vehicle), r.odo, r.prevOdo, r.liters, r.price, r.cost, r.currency, r.rate || "", r.full === false ? "no" : "yes", r.missed ? "yes" : "no", r.station || "", r.note || "", unitOf(r)]);
    return [head, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
  }

  // One scanned number. "13.450" is ambiguous: a price or liters reads 13.45, an amount or odometer 13450.
  function readNumber(raw, hint) {
    const s = raw.replace(/\s/g, "");
    const last = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
    if ((s.match(/[.,]/g) || []).length === 1 && s.length - last - 1 === 3) {
      const dec = parseFloat(s.replace(/[.,]/, ".")), thou = parseFloat(s.replace(/[.,]/, ""));
      return hint === "amount" || hint === "odo" ? { value: thou, alt: dec } : { value: dec, alt: thou };
    }
    // "1.234,56" or "1,234.56": the last separator is the decimal one.
    return { value: parseFloat(last < 0 ? s : s.slice(0, last).replace(/[.,]/g, "") + "." + s.slice(last + 1)) };
  }

  /* Numbers found in OCR text, with the label they appear next to (pump display, receipt, dashboard). */
  function numbersFromText(text) {
    const out = [];
    const lines = normDigits(text || "").split(/\n+/);
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
      const lab = label(line), hint = lab || prevLabel;
      // A space groups thousands only on its own: "13.450 406.86" is two numbers, "123 456" is one.
      const nums = line.match(/\d+(?:(?:[.,]\d{3})+|(?:\s\d{3})+)?(?:[.,]\d+)?/g) || [];
      for (const raw of nums) {
        const n = readNumber(raw, hint);
        if (!(isFinite(n.value) && n.value > 0)) continue;
        const x = { value: n.value, raw, hint };
        if (n.alt != null) x.alt = n.alt;
        out.push(x);
      }
      if (lab && !nums.length) prevLabel = lab; else prevLabel = null;
    }
    return out;
  }

  const api = {
    MONTHS, pad, isoDate, parseDate, daysBetween, addDays, parseNum,
    computeFuel, toHome, defaultRates, primaryUnit, sortFills, segments, pendingSinceFull, isoWeek, periodOf, aggregate,
    lastPriceChange, priceMayBeStale, priceDays, vehicleAverage, movingAverage, insights, stationStats, stationNames,
    tripCost, reminderStatus, latestOdo, lastFill, rolloverGuess, nextYear, scanFields, plausibility,
    CURRENCIES, BACKUP_FORMAT, sanitizeRecord, validRecord, migrateRecord, defaultSettings, sanitizeSettings, migrateSettings,
    backupFile, parseBackup, mergeRecords, shouldAskReview, toCsv, numbersFromText,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FT = api;
})(typeof self !== "undefined" ? self : this);
