const test = require("node:test");
const assert = require("node:assert/strict");
const FT = require("../www/js/logic.js");

const S = { home: "MAD", rates: { EUR: 10, USD: 9 }, vehicles: [{ id: "car" }], budget: 0 };
let n = 0;
const fill = (o) => ({ id: "f" + ++n, kind: "fill", vehicle: "car", currency: "MAD", full: true, missed: false, createdAt: n, ...o });
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("computeFuel works from liters or from the amount paid", () => {
  const a = FT.computeFuel({ odoStart: 1000, odoEnd: 1500, price: 12.5, mode: "liters", liters: 35 });
  close(a.litersPer100, 7); close(a.cost, 437.5); close(a.costPer100, 87.5); close(a.litersPerKm, 0.07);
  const b = FT.computeFuel({ odoStart: 1000, odoEnd: 1400, price: 12.5, mode: "money", amount: 400 });
  close(b.liters, 32); close(b.litersPer100, 8);
  assert.equal(FT.computeFuel({ odoStart: 1500, odoEnd: 1400, price: 12, mode: "liters", liters: 3 }).error, "errOdoOrder");
  assert.equal(FT.computeFuel({ odoStart: 1, odoEnd: 2, price: 0, mode: "liters", liters: 3 }).error, "errPrice");
});

test("a first fill-up with an unknown start only sets the starting point", () => {
  const r = FT.computeFuel({ odoStart: NaN, odoEnd: 5000, price: 12, mode: "liters", liters: 30, unknownStart: true });
  assert.equal(r.error, undefined); assert.equal(r.distance, 0); assert.equal(r.litersPer100, undefined);
});

test("partial fill-ups are added to the next full tank", () => {
  const fills = [
    fill({ date: "2026-01-01", prevOdo: 0, odo: 1000, liters: 40, cost: 400, price: 10 }),
    fill({ date: "2026-01-05", prevOdo: 1000, odo: 1200, liters: 10, cost: 100, price: 10, full: false }),
    fill({ date: "2026-01-09", prevOdo: 1200, odo: 1500, liters: 25, cost: 250, price: 10 }),
  ];
  const segs = FT.segments(fills, S);
  assert.equal(segs.length, 2);
  close(segs[1].distance, 500); close(segs[1].liters, 35); close(segs[1].l100, 7); assert.equal(segs[1].fills, 2);
});

test("a missed fill-up drops only the stretch it belongs to", () => {
  const fills = [
    fill({ date: "2026-01-01", prevOdo: 0, odo: 500, liters: 35, cost: 350, price: 10 }),
    fill({ date: "2026-01-10", prevOdo: 500, odo: 1400, liters: 30, cost: 300, price: 10, missed: true }),
    fill({ date: "2026-01-20", prevOdo: 1400, odo: 1900, liters: 40, cost: 400, price: 10 }),
  ];
  const segs = FT.segments(fills, S);
  assert.deepEqual(segs.map((s) => s.endId), [fills[0].id, fills[2].id]);
  close(segs[1].l100, 8);
});

test("pending partial fills are listed until the next full tank", () => {
  const fills = [
    fill({ date: "2026-02-01", prevOdo: 0, odo: 100, liters: 5, cost: 50, price: 10 }),
    fill({ date: "2026-02-02", prevOdo: 100, odo: 200, liters: 5, cost: 50, price: 10, full: false }),
  ];
  assert.equal(FT.pendingSinceFull(fills, "car").length, 1);
  assert.equal(FT.pendingSinceFull(fills, "car", fills[1].id).length, 0);
});

test("other currencies are converted with the rate saved on the record", () => {
  assert.equal(FT.toHome(100, { currency: "MAD" }, S), 100);
  assert.equal(FT.toHome(10, { currency: "EUR", rate: 10.9 }, S), 109);
  assert.equal(FT.toHome(10, { currency: "USD" }, S), 90);
  assert.equal(FT.toHome(10, { currency: "USD" }, { home: "MAD", rates: {} }), null);
  // Saved while home was MAD, viewed with home EUR: 10 USD = 93 MAD = 8.6 EUR.
  close(FT.toHome(10, { currency: "USD", rate: 9.3, rateHome: "MAD" }, { home: "EUR", rates: { MAD: 0.0925 } }), 93 * 0.0925);
  assert.deepEqual(FT.defaultRates("MAD"), { EUR: 10.8, USD: 9.3 });
  // A home currency bnzn has no rough rate for starts empty instead of with broken numbers.
  assert.deepEqual(FT.defaultRates("GBP"), {});
});

test("aggregate counts money by fill date and consumption by full tank", () => {
  const records = [
    fill({ date: "2026-03-01", prevOdo: 0, odo: 600, liters: 42, cost: 504, price: 12 }),
    fill({ date: "2026-03-20", prevOdo: 600, odo: 1100, liters: 35, cost: 35, price: 1, currency: "EUR", rate: 12 }),
    { id: "i1", kind: "income", vehicle: "car", date: "2026-03-21", amount: 2000, currency: "MAD" },
  ];
  const [m] = FT.aggregate(records, S, "month", "all");
  close(m.distance, 1100); close(m.spent, 504 + 420); close(m.l100, 7); close(m.income, 2000); close(m.profit, 2000 - 924);
});

test("pump prices change on the 1st and the 16th", () => {
  assert.equal(FT.lastPriceChange("2026-10-17"), "2026-10-16");
  assert.equal(FT.lastPriceChange("2026-10-15"), "2026-10-01");
  assert.equal(FT.priceMayBeStale("2026-10-12", "2026-10-17"), "2026-10-16");
  assert.equal(FT.priceMayBeStale("2026-10-16", "2026-10-17"), null);
});

test("trip cost splits between passengers and doubles for a round trip", () => {
  const t = FT.tripCost({ km: 240, roundTrip: true, l100: 6.5, price: 12, people: 3 });
  close(t.distance, 480); close(t.liters, 31.2); close(t.cost, 374.4); close(t.perPerson, 124.8);
  assert.equal(FT.tripCost({ km: 0, l100: 6, price: 12 }), null);
});

test("reminders by km and by date", () => {
  const oil = FT.reminderStatus({ everyKm: 10000, lastKm: 40000 }, 49500, "2026-10-17");
  assert.equal(oil.left, 500); assert.equal(oil.soon, true);
  const ins = FT.reminderStatus({ dueDate: "2026-12-31" }, null, "2026-10-17");
  assert.equal(ins.left, 75); assert.equal(ins.soon, false);
  assert.equal(FT.nextYear("2028-02-29"), "2029-02-28");
});

test("version 1 data migrates to named vehicles and full tanks", () => {
  const old = [{ date: "2026-01-01", vehicle: "bike", prevOdo: 0, odo: 100, liters: 3, cost: 36, price: 12, currency: "MAD" }];
  const recs = old.map(FT.migrateRecord);
  assert.equal(recs[0].kind, "fill"); assert.equal(recs[0].full, true); assert.ok(FT.validRecord(recs[0]));
  const s = FT.migrateSettings(null, recs, "fr");
  assert.equal(s.vehicles[0].id, "bike"); assert.equal(s.vehicles[0].type, "bike"); assert.equal(s.onboarded, true); assert.equal(s.lang, "fr");
});

test("backup files round-trip and reject other files", () => {
  const rec = fill({ date: "2026-01-01", prevOdo: 0, odo: 100, liters: 3, cost: 36, price: 12 });
  const file = JSON.stringify(FT.backupFile([rec, { junk: true }], S, "2026-10-17T00:00:00Z"));
  const back = FT.parseBackup(file);
  assert.equal(back.records.length, 1); assert.equal(back.skipped, 1); assert.equal(back.settings.home, "MAD");
  assert.equal(FT.parseBackup("{}").error, "errBackupRead");
  assert.equal(FT.parseBackup("not json").error, "errBackupRead");
});

test("CSV quotes cells that need it", () => {
  const csv = FT.toCsv([fill({ date: "2026-01-01", prevOdo: 0, odo: 100, liters: 3, cost: 36, price: 12, station: 'Shell, "Maarif"' })], { home: "MAD", vehicles: [{ id: "car", name: "Logan" }] });
  assert.match(csv, /"Shell, ""Maarif"""/); assert.match(csv, /Logan/);
  assert.match(csv.split("\n")[0], /,unit$/); assert.match(csv.split("\n")[1], /,L$/);
  const ev = FT.toCsv([fill({ date: "2026-01-01", prevOdo: 0, odo: 100, liters: 15, cost: 27, price: 1.8, unit: "kWh" })], { home: "MAD", vehicles: [] });
  assert.match(ev.split("\n")[1], /,kWh$/);
});

test("insights compare this month with the average and flag a spike", () => {
  const recs = [];
  let odo = 0;
  const add = (date, km, l) => { recs.push(fill({ date, prevOdo: odo, odo: odo + km, liters: l, cost: l * 12, price: 12 })); odo += km; };
  add("2026-06-01", 500, 35); add("2026-07-01", 500, 35); add("2026-08-01", 500, 35); add("2026-09-01", 500, 35); add("2026-10-05", 500, 50);
  const i = FT.insights(recs, S, "all", "2026-10-17");
  close(i.monthL100, 10); close(i.avgL100, 7); close(i.changePct, 100 * (10 / 7 - 1)); assert.ok(i.spike);
  close(i.monthSpent, 600);
});

test("station stats rank the cheapest station per fuel", () => {
  const recs = [
    fill({ date: "2026-10-01", prevOdo: 0, odo: 100, liters: 10, cost: 150, price: 15, station: "Afriquia" }),
    fill({ date: "2026-10-05", prevOdo: 100, odo: 200, liters: 10, cost: 148, price: 14.8, station: "winxo " }),
    fill({ date: "2026-10-06", prevOdo: 200, odo: 300, liters: 10, cost: 148, price: 14.8, station: "Winxo" }),
  ];
  const st = FT.stationStats(recs, S, "2026-10-17").essence;
  assert.equal(st.length, 2); assert.equal(st[0].station.toLowerCase().trim(), "winxo"); assert.equal(st[0].count, 2);
});

test("numbers are read from pump display text with their labels", () => {
  const nums = FT.numbersFromText("MONTANT DH\n300,00\nLITRES 20,07\nPRIX/L 14.95");
  assert.deepEqual(nums.map((x) => [x.value, x.hint]), [[300, "amount"], [20.07, "liters"], [14.95, "price"]]);
  assert.equal(FT.numbersFromText("ODO 123 456 km")[0].value, 123456);
});

test("typed numbers accept English, French and Arabic writing", () => {
  assert.equal(FT.parseNum("13,45"), 13.45);
  assert.equal(FT.parseNum(" 13.45 "), 13.45);
  assert.equal(FT.parseNum("١٣٫٤٥"), 13.45);
  assert.equal(FT.parseNum("۱۲۳"), 123);
  assert.equal(FT.parseNum("١٢٬٣٤٥"), 12345);
  assert.equal(FT.parseNum("1.234,56"), 1234.56);
  assert.equal(FT.parseNum("1,234.56"), 1234.56);
  assert.equal(FT.parseNum("1,234,567"), 1234567);
  assert.equal(FT.parseNum("12 345"), 12345);
  assert.equal(FT.parseNum("12 345,5"), 12345.5);
  assert.equal(FT.parseNum("12 345"), 12345);
  assert.equal(FT.parseNum("-4,5"), -4.5);
  // Kilometer fields: a dot or comma followed by exactly 3 digits groups thousands.
  assert.equal(FT.parseNum("45.650", { integerish: true }), 45650);
  assert.equal(FT.parseNum("45.65", { integerish: true }), 45.65);
  assert.equal(FT.parseNum("45.650"), 45.65);
  for (const bad of ["", "   ", "abc", "12a", "1-2", "-", ".", null, undefined]) assert.ok(Number.isNaN(FT.parseNum(bad)), String(bad));
  // A doubled or stray mark is a typo, not a thousands group that makes 13.45 into 1345.
  for (const typo of ["13,,45", "13..45", "1,5,", "1.2.3", "1,2.5", "1234.567,5"]) assert.ok(Number.isNaN(FT.parseNum(typo)), typo);
  assert.equal(FT.parseNum("12,345,678.9"), 12345678.9);
});

test("an ambiguous scanned number reads by the label next to it", () => {
  const [p] = FT.numbersFromText("PRIX 13.450");
  assert.equal(p.value, 13.45); assert.equal(p.alt, 13450); assert.equal(p.hint, "price");
  const [l] = FT.numbersFromText("LITRES\n45.230");
  assert.equal(l.value, 45.23); assert.equal(l.alt, 45230); assert.equal(l.hint, "liters");
  const [a] = FT.numbersFromText("MONTANT 13.450");
  assert.equal(a.value, 13450); assert.equal(a.alt, 13.45);
  const [o] = FT.numbersFromText("ODO 45,230");
  assert.equal(o.value, 45230); assert.equal(o.alt, 45.23);
  const [n] = FT.numbersFromText("13.450");
  assert.equal(n.value, 13.45); assert.equal(n.alt, 13450);
  // Unambiguous numbers carry no alternative.
  const plain = FT.numbersFromText("TOTAL 1.234,56\nPRIX 14.95");
  assert.deepEqual(plain.map((x) => [x.value, "alt" in x]), [[1234.56, false], [14.95, false]]);
  assert.equal(FT.numbersFromText("سعر ١٣٫٤٥")[0].value, 13.45);
  // Numbers side by side on one receipt line stay apart; a space still groups thousands on its own.
  assert.deepEqual(FT.numbersFromText("Gasoil 30.25 13.450 406.86").map((x) => x.raw), ["30.25", "13.450", "406.86"]);
  assert.deepEqual(FT.numbersFromText("TOTAL 1 234,56").map((x) => x.value), [1234.56]);
});

test("scanned numbers that multiply up are trusted as price, liters and amount", () => {
  const nums = FT.numbersFromText("PRIX 13.450\nLITRES 30.25\nMONTANT 406.86\nKM 45.230");
  const f = FT.scanFields(nums, { currency: "MAD", tank: 50, type: "car" });
  assert.deepEqual(f, { price: 13.45, liters: 30.25, amount: 406.86, odo: 45230, verified: true });
  // Unlabelled numbers still check out from the arithmetic alone.
  const bare = FT.scanFields(FT.numbersFromText("406.86\n30.25\n13.450"), { currency: "MAD" });
  assert.equal(bare.verified, true); assert.equal(bare.price, 13.45); assert.equal(bare.liters, 30.25); assert.equal(bare.amount, 406.86);
  const line = FT.scanFields(FT.numbersFromText("Gasoil 30.25 13.450 406.86"), { currency: "MAD" });
  assert.deepEqual([line.price, line.liters, line.amount, line.verified], [13.45, 30.25, 406.86, true]);
});

test("scanned numbers fall back to their labels when nothing multiplies up", () => {
  const nums = FT.numbersFromText("PRIX 99\nPRIX 14.20\nLITRES 300\nLITRES 20\nMONTANT 500");
  const f = FT.scanFields(nums, { currency: "MAD", type: "car", tank: 45 });
  assert.deepEqual(f, { price: 14.2, liters: 20, amount: 500, odo: null, verified: false });
  // A euro price is checked against euro ranges, and a bike tank is small.
  const e = FT.scanFields(FT.numbersFromText("PRIX 1.89\nLITRES 55"), { currency: "EUR", type: "bike" });
  assert.equal(e.price, 1.89); assert.equal(e.liters, null);
  // Any other currency only needs a positive price.
  assert.equal(FT.scanFields(FT.numbersFromText("PRICE 1350"), { currency: "XOF" }).price, 1350);
  assert.equal(FT.scanFields(FT.numbersFromText("ODO 85"), {}).odo, null);
  assert.deepEqual(FT.scanFields([], {}), { price: null, liters: null, amount: null, odo: null, verified: false });
});

test("plausibility flags odd fill-ups before they are saved", () => {
  const car = { type: "car", fuel: "essence", tank: 45 };
  const hist = [400, 420, 380, 410].map((km, i) => fill({ date: `2026-0${i + 1}-01`, prevOdo: i * 500, odo: i * 500 + km, liters: 30, cost: 360, price: 12 }));
  const ok = { odo: 10400, prevOdo: 10000, liters: 30, price: 12, currency: "MAD", full: true };
  assert.deepEqual(FT.plausibility(ok, { vehicle: car, history: hist, l100: 7.5 }), []);
  const odd = { odo: 14000, prevOdo: 10000, liters: 60, price: 125, currency: "MAD", full: true };
  const w = FT.plausibility(odd, { vehicle: car, history: hist, l100: 1.5 });
  assert.deepEqual(w.map((x) => x.key), ["warnDistance", "warnConsumption", "warnTank", "warnPrice"]);
  assert.deepEqual(w[0].vars, { km: 4000, usual: 405 });
  assert.deepEqual(w[1].vars, { value: 1.5, unit: "L" });
  assert.deepEqual(w[2].vars, { liters: 60, tank: 45 });
  assert.deepEqual(w[3].vars, { price: 125, currency: "MAD" });
  // Fewer than 3 earlier distances: no basis for a distance warning.
  assert.deepEqual(FT.plausibility(odd, { vehicle: {}, history: hist.slice(0, 2), l100: null }).map((x) => x.key), ["warnPrice"]);
  // Bikes, charging and other currencies have their own ranges.
  assert.equal(FT.plausibility({ ...ok, liters: 5 }, { vehicle: { type: "bike" }, l100: 14 })[0].key, "warnConsumption");
  const kwh = { odo: 300, prevOdo: 100, liters: 30, price: 2.5, currency: "MAD", unit: "kWh" };
  assert.deepEqual(FT.plausibility(kwh, { vehicle: { type: "car", fuel: "electric", tank: 20 }, l100: 15 }), []);
  assert.deepEqual(FT.plausibility({ ...kwh, price: 12 }, { vehicle: {}, l100: 50 }).map((x) => x.key), ["warnConsumption", "warnPrice"]);
  assert.deepEqual(FT.plausibility({ ...ok, price: 900, currency: "XOF" }, { vehicle: car, l100: 7 }), []);
  // A plug-in hybrid can read very low on fuel and on charging (shared kilometers), but not too high.
  const phev = { type: "car", fuel: "hybrid", tank: 40 };
  assert.deepEqual(FT.plausibility({ ...ok, liters: 10 }, { vehicle: phev, l100: 1.6 }), []);
  assert.deepEqual(FT.plausibility({ ...kwh, price: 2.5 }, { vehicle: phev, l100: 4 }), []);
  assert.equal(FT.plausibility({ ...ok, liters: 10 }, { vehicle: phev, l100: 30 })[0].key, "warnConsumption");
});

test("partial fills before the first full tank only set the starting point", () => {
  const fills = [
    fill({ date: "2026-04-01", prevOdo: 5000, odo: 5000, liters: 10, cost: 120, price: 12, full: false }),
    fill({ date: "2026-04-08", prevOdo: 5000, odo: 5300, liters: 25, cost: 300, price: 12 }),
  ];
  assert.deepEqual(FT.segments(fills, S), []);
  assert.deepEqual(FT.pendingSinceFull(fills.slice(0, 1), "car"), []);
  // The first full tank becomes the start: the next one gives a result.
  fills.push(fill({ date: "2026-04-15", prevOdo: 5300, odo: 5700, liters: 28, cost: 336, price: 12 }));
  const segs = FT.segments(fills, S);
  assert.equal(segs.length, 1); close(segs[0].l100, 7); assert.equal(segs[0].unit, "L");
  // A first full tank with a known start keeps producing a result.
  const known = [fill({ date: "2026-04-01", prevOdo: 0, odo: 500, liters: 35, cost: 420, price: 12 })];
  close(FT.segments(known, S)[0].l100, 7);
});

test("fills are ordered by odometer count, then reading, then date", () => {
  const a = fill({ date: "2026-05-01", odo: 99800, prevOdo: 99400, liters: 30, cost: 360, price: 12 });
  const b = fill({ date: "2026-05-10", odo: 150, prevOdo: -120, liters: 20, cost: 240, price: 12, meter: 1, reset: true });
  const c = fill({ date: "2026-05-20", odo: 550, prevOdo: 150, liters: 28, cost: 336, price: 12, meter: 1 });
  assert.deepEqual([c, b, a].sort(FT.sortFills).map((f) => f.id), [a.id, b.id, c.id]);
  assert.equal(FT.latestOdo([a, b, c], "car"), 550);
  assert.equal(FT.latestOdo([a], "car"), 99800);
  assert.equal(FT.latestOdo([], "car"), null);
  // The reset fill's own distance carries the chain across the reset.
  const segs = FT.segments([c, a, b], S);
  assert.deepEqual(segs.map((s) => s.distance), [400, 270, 400]);
  assert.equal(FT.lastFill([a, c, b], "car").id, c.id);
  assert.equal(FT.lastFill([a, c, b], "car", { excludeId: c.id }).id, b.id);
  assert.equal(FT.lastFill([a, b, c], "bike"), null);
});

test("lastFill can keep to one energy unit", () => {
  const f1 = fill({ vehicle: "phev", date: "2026-05-01", odo: 1000, prevOdo: 600, liters: 30, cost: 360, price: 12 });
  const k1 = fill({ vehicle: "phev", date: "2026-05-02", odo: 1100, prevOdo: 900, liters: 10, cost: 20, price: 2, unit: "kWh" });
  const inc = { id: "i9", kind: "income", vehicle: "phev", date: "2026-05-03", amount: 100, currency: "MAD" };
  assert.equal(FT.lastFill([f1, k1, inc], "phev").id, k1.id);
  assert.equal(FT.lastFill([f1, k1, inc], "phev", { unit: "L" }).id, f1.id);
  assert.equal(FT.lastFill([f1, k1, inc], "phev", { unit: "kWh" }).id, k1.id);
});

test("an odometer rollover is guessed from the number of digits", () => {
  assert.equal(FT.rolloverGuess(99850, 120), 270);
  assert.equal(FT.rolloverGuess(999900, 50), 150);
  assert.equal(FT.rolloverGuess(45000, 120), null); // 55,120 km: a replaced meter, not a rollover
  assert.equal(FT.rolloverGuess(500, 600), null);
  assert.equal(FT.rolloverGuess(NaN, 10), null);
});

test("vehicles have a primary energy unit", () => {
  assert.equal(FT.primaryUnit({ fuel: "electric" }), "kWh");
  assert.equal(FT.primaryUnit({ fuel: "hybrid" }), "L");
  assert.equal(FT.primaryUnit({ fuel: "gasoil" }), "L");
  assert.equal(FT.primaryUnit(undefined), "L");
});

test("a plug-in hybrid gets L/100 and kWh/100 without counting kilometers twice", () => {
  const settings = { home: "MAD", rates: {}, vehicles: [{ id: "phev", fuel: "hybrid" }], budget: 0 };
  const v = (o) => fill({ vehicle: "phev", ...o });
  const recs = [
    v({ date: "2026-05-01", prevOdo: 10000, odo: 10000, liters: 30, cost: 360, price: 12 }),
    v({ date: "2026-05-03", prevOdo: 10100, odo: 10100, liters: 8, cost: 16, price: 2, unit: "kWh" }),
    v({ date: "2026-05-06", prevOdo: 10100, odo: 10300, liters: 8, cost: 16, price: 2, unit: "kWh" }),
    v({ date: "2026-05-10", prevOdo: 10000, odo: 10600, liters: 24, cost: 288, price: 12 }),
    v({ date: "2026-05-12", prevOdo: 10300, odo: 10700, liters: 16, cost: 32, price: 2, unit: "kWh" }),
  ];
  const segs = FT.segments(recs, settings);
  assert.deepEqual(segs.map((s) => [s.unit, s.distance]), [["kWh", 200], ["L", 600], ["kWh", 400]]);
  const [m] = FT.aggregate(recs, settings, "month", "phev");
  close(m.distance, 600); close(m.liters, 54); close(m.kwh, 32);
  close(m.l100, 4); close(m.kwh100, 4); close(m.cost100, 48);
  close(m.spent, 360 + 16 + 16 + 288 + 32);
  const i = FT.insights(recs, settings, "phev", "2026-05-20");
  assert.equal(i.unit, "L"); close(i.monthL100, 4); assert.deepEqual(i.trend.map((t) => t.l100), [4]);
  // Charging stations rank with the other chargers.
  const st = FT.stationStats([{ ...recs[2], station: "Borne" }, { ...recs[3], station: "Afriquia", fuel: "hybrid" }], settings, "2026-05-20");
  assert.deepEqual(Object.keys(st).sort(), ["electric", "hybrid"]);
});

test("an electric car reports kWh/100 from its charging chain", () => {
  const settings = { home: "MAD", rates: {}, vehicles: [{ id: "ev", fuel: "electric" }], budget: 0 };
  const recs = [
    fill({ vehicle: "ev", date: "2026-06-01", prevOdo: 0, odo: 0, liters: 40, cost: 80, price: 2, unit: "kWh" }),
    fill({ vehicle: "ev", date: "2026-06-10", prevOdo: 0, odo: 300, liters: 45, cost: 90, price: 2, unit: "kWh" }),
  ];
  const [m] = FT.aggregate(recs, settings, "month", "all");
  close(m.distance, 300); assert.equal(m.liters, 0); close(m.kwh, 85);
  assert.equal(m.l100, null); close(m.kwh100, 15); close(m.cost100, 30);
  const i = FT.insights(recs, settings, "all", "2026-06-20");
  assert.equal(i.unit, "kWh"); close(i.monthL100, 15);
});

test("records keep any ISO 4217 currency", () => {
  const base = fill({ date: "2026-01-01", prevOdo: 0, odo: 100, liters: 3, cost: 3600, price: 1200 });
  assert.ok(FT.validRecord({ ...base, currency: "XOF" }));
  assert.ok(!FT.validRecord({ ...base, currency: "eur" }));
  assert.ok(!FT.validRecord({ ...base, currency: "EURO" }));
  assert.deepEqual(FT.CURRENCIES, ["MAD", "EUR", "USD"]);
});

test("sanitizeRecord checks required fields and cleans optional ones", () => {
  const good = fill({ date: "2026-01-31", prevOdo: 0, odo: 100, liters: 3, cost: 36, price: 12 });
  assert.deepEqual(FT.sanitizeRecord(good), good);
  for (const bad of [
    { ...good, date: "2026-02-30" }, { ...good, date: "2026-1-01" }, { ...good, kind: "other" }, { ...good, vehicle: "" },
    { ...good, vehicle: "x".repeat(65) }, { ...good, liters: 0 }, { ...good, price: -1 }, { ...good, cost: -1 },
    { ...good, odo: "100" }, null, "fill", [good],
  ]) assert.equal(FT.sanitizeRecord(bad), null, JSON.stringify(bad));
  assert.ok(FT.validRecord({ id: "i1", kind: "income", vehicle: "car", date: "2024-02-29", amount: 50, currency: "MAD" }));
  assert.ok(!FT.validRecord({ id: "i1", kind: "income", vehicle: "car", date: "2026-03-01", amount: 0, currency: "MAD" }));
  const r = FT.sanitizeRecord({
    ...good, station: "  Shell Maarif ", note: "n".repeat(250), full: "yes", meter: 1.5, unit: "gallon", rate: -2,
    rateHome: "mad", fuel: "kerosene", reset: true, updatedAt: 5, id: "x".repeat(70),
    future: "kept", score: 3, flag: false, none: null, nested: { a: 1 }, list: [1],
  });
  assert.equal(r.station, "Shell Maarif"); assert.equal(r.note.length, 200); assert.equal(r.reset, true); assert.equal(r.updatedAt, 5);
  for (const k of ["full", "meter", "unit", "rate", "rateHome", "fuel", "id", "nested", "list"]) assert.ok(!(k in r), k);
  assert.equal(r.future, "kept"); assert.equal(r.score, 3); assert.equal(r.flag, false); assert.equal(r.none, null);
  assert.deepEqual(FT.sanitizeRecord({ ...good, unit: "kWh", meter: 2, fuel: "electric" }).unit, "kWh");
  // Keys that would shadow Object methods are not copied from a file.
  const trap = FT.sanitizeRecord(JSON.parse(JSON.stringify(good).replace("{", '{"__proto__":{"x":1},"hasOwnProperty":1,"toString":"x","constructor":2,')));
  for (const k of ["__proto__", "hasOwnProperty", "toString", "constructor"]) assert.ok(!Object.prototype.hasOwnProperty.call(trap, k), k);
  assert.equal(String(trap), "[object Object]"); assert.equal(trap.x, undefined);
});

test("booby-trapped settings come out clean", () => {
  const raw = {
    home: "<script>", lang: "xx", budget: "1e9", driverMode: "yes", version: 2, extra: "<b>",
    rates: { EUR: "<img src=x onerror=alert(1)>", USD: 9.1, "<b>": 3, XOF: -1, GBP: 12 },
    vehicles: [
      { id: "car", name: "  Logan  ", type: "truck", fuel: "jet", tank: "50", color: "red;background:url(x)", tripMeter: "1", hack: "<i>" },
      { id: "a b" }, { id: "car", name: "dup" }, "nope", { id: "bike-1", name: "", type: "bike", fuel: "electric", tank: 12, color: "#2F6FD0", tripMeter: true },
    ],
    reminders: [
      { id: "r1", kind: "oil", vehicle: "car", label: 5, everyKm: 10000, lastKm: 40000, dueDate: "soon", history: [{ date: "2026-01-01", odo: 40000 }, { date: "bad" }, { date: "2026-02-01" }], x: 1 },
      { id: "r2", kind: "<script>", vehicle: "car" }, { kind: "oil", vehicle: "car" },
    ],
    lastBackup: "javascript:alert(1)", activeVehicle: 7, priceAlerts: true, review: { at: "2026-01-01", count: 3 }, onboarded: true,
  };
  const s = FT.sanitizeSettings(raw);
  assert.deepEqual(Object.keys(s).sort(), Object.keys(FT.defaultSettings()).sort());
  assert.equal(s.home, "MAD"); assert.equal(s.lang, "en"); assert.equal(s.budget, 0); assert.equal(s.driverMode, false);
  assert.deepEqual(s.rates, { USD: 9.1, GBP: 12 });
  assert.deepEqual(s.vehicles, [
    { id: "car", name: "Logan", type: "car", fuel: "essence", tank: null, color: "#d97a06", tripMeter: false },
    { id: "bike-1", name: "Car", type: "bike", fuel: "electric", tank: 12, color: "#2F6FD0", tripMeter: true },
  ]);
  assert.deepEqual(s.reminders, [{ id: "r1", kind: "oil", vehicle: "car", label: "", everyKm: 10000, lastKm: 40000, history: [{ date: "2026-01-01", odo: 40000 }, { date: "2026-02-01", odo: null }] }]);
  assert.equal(s.lastBackup, null); assert.equal(s.activeVehicle, null); assert.equal(s.priceAlerts, true); assert.equal(s.onboarded, true);
  assert.deepEqual(s.review, { at: "2026-01-01", count: 3 });
  assert.equal(FT.sanitizeSettings({ review: { at: "x", count: -1 } }).review, null);
  assert.equal(FT.sanitizeSettings({ lastBackup: "2026-10-17T08:00:00.000Z" }).lastBackup, "2026-10-17T08:00:00.000Z");
  // migrateSettings cleans first, then fills in rates and the active vehicle.
  const m = FT.migrateSettings(raw, [], "fr");
  assert.equal(m.rates.EUR, 10.8); assert.equal(m.lang, "fr"); assert.equal(m.activeVehicle, "car"); assert.ok(!("extra" in m));
  assert.equal(FT.sanitizeSettings(null, "ar").lang, "ar");
  assert.equal(FT.sanitizeSettings({ vehicles: Array.from({ length: 60 }, (_, i) => ({ id: "v" + i })) }).vehicles.length, 50);
});

test("backups from a newer version are refused instead of half-restored", () => {
  const rec = fill({ date: "2026-01-01", prevOdo: 0, odo: 100, liters: 3, cost: 36, price: 12 });
  assert.equal(FT.backupFile([rec], S, "x").format, FT.BACKUP_FORMAT);
  assert.equal(FT.BACKUP_FORMAT, 3);
  const newer = JSON.stringify({ app: "fuel-tracker", format: 4, records: [rec] });
  assert.deepEqual(FT.parseBackup(newer), { error: "errBackupNewer" });
  const older = FT.parseBackup(JSON.stringify({ app: "fuel-tracker", format: 2, records: [rec, { ...rec, date: "2026-13-01" }], settings: { home: "EUR", rates: { MAD: "x" } } }));
  assert.equal(older.records.length, 1); assert.equal(older.skipped, 1);
  assert.equal(older.settings.home, "EUR"); assert.deepEqual(older.settings.rates, {});
  assert.equal(FT.parseBackup(JSON.stringify({ app: "fuel-tracker", records: [] })).settings, null);
});

test("restoring into existing data keeps the newest copy of each record", () => {
  const local = [{ id: "a", v: 1, createdAt: 10 }, { id: "b", v: 1, createdAt: 10, updatedAt: 50 }, { id: "c", v: 1, createdAt: 10 }];
  const incoming = [{ id: "a", v: 2, createdAt: 10, updatedAt: 20 }, { id: "b", v: 2, createdAt: 10, updatedAt: 30 }, { id: "d", v: 2 }, { v: 3 }];
  const m = FT.mergeRecords(local, incoming);
  assert.deepEqual(m.list.map((r) => [r.id, r.v]), [["a", 2], ["b", 1], ["c", 1], ["d", 2], [undefined, 3]]);
  assert.equal(m.added, 2); assert.equal(m.updated, 1);
  assert.equal(local[0].v, 1); // the local list is not changed in place
});

test("price reminders fall on the 1st and the 16th", () => {
  assert.deepEqual(FT.priceDays("2026-10-17", 3), ["2026-11-01", "2026-11-16", "2026-12-01"]);
  assert.deepEqual(FT.priceDays("2026-12-16", 3), ["2026-12-16", "2027-01-01", "2027-01-16"]);
  assert.deepEqual(FT.priceDays("2026-10-01", 2), ["2026-10-01", "2026-10-16"]);
  assert.deepEqual(FT.priceDays("2026-12-20", 1), ["2027-01-01"]);
  assert.deepEqual(FT.priceDays("2026-10-02", 1), ["2026-10-16"]);
});

test("a store review is asked after 3 results, then rarely", () => {
  assert.equal(FT.shouldAskReview(2, null, "2026-10-17"), false);
  assert.equal(FT.shouldAskReview(3, null, "2026-10-17"), true);
  assert.equal(FT.shouldAskReview(6, { at: "2026-08-01", count: 3 }, "2026-10-17"), false); // too soon
  assert.equal(FT.shouldAskReview(5, { at: "2026-01-01", count: 3 }, "2026-10-17"), false); // not enough new results
  assert.equal(FT.shouldAskReview(6, { at: "2026-06-19", count: 3 }, "2026-10-17"), true); // exactly 120 days
});
