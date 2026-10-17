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
