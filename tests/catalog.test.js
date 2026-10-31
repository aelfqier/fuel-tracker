const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Catalog = require("../www/js/catalog.js");

const FILE = path.join(__dirname, "../www/data/vehicles.json");
const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
const cat = Catalog.parse(raw);

// Manufacturers' own sites and document servers. A figure from anywhere else doesn't belong in the file.
const OFFICIAL = [
  "dacia.fr", "dacia.ro", "dacia.ma", "renault.fr", "renault.ma", "peugeot.fr", "peugeot.ma", "citroen.fr", "citroen.ma",
  "hyundai.com", "kia.com", "kia.ma", "toyota.co.uk", "volkswagen.fr", "skoda-storyboard.com", "fiat.ma", "suzuki.fr",
  "suzuki.co.uk", "mgmotor.eu", "nissan.co.uk", "bmw.co.uk", "mercedes-benz.co.uk",
  "honda.co.uk", "yamaha-motor.eu", "yamaha-motor.com.au", "suzukimotorcycles.com.au", "kymco.co.uk", "piaggio.com",
  "vespa.com", "peugeot-motocycles.fr", "ktmindia.com", "kawasaki.co.uk", "bmw-motorrad.co.uk",
];
const official = (url) => { const h = new URL(url).hostname; return OFFICIAL.some((d) => h === d || h.endsWith("." + d)); };

const entry = (o) => ({ id: "x-y", brand: "X", model: "Y", type: "car", variant: "", tank: 40, source: "https://www.x.com/spec", checked: "2026-10-31", ...o });

test("every entry in the shipped file is complete and nothing is dropped", () => {
  assert.equal(raw.format, 1);
  assert.ok(cat.vehicles.length >= 100, `only ${cat.vehicles.length} vehicles`);
  assert.equal(cat.vehicles.length, raw.vehicles.length, "an entry failed validation");
  assert.equal(new Set(cat.vehicles.map((v) => v.id)).size, cat.vehicles.length);
  assert.ok(cat.vehicles.some((v) => v.type === "car") && cat.vehicles.some((v) => v.type === "bike"));
});

test("every figure comes from a manufacturer's site, with the date it was read", () => {
  for (const v of cat.vehicles) {
    assert.ok(official(v.source), `${v.id}: ${v.source} is not an official manufacturer site`);
    assert.match(v.checked, /^\d{4}-\d{2}-\d{2}$/, v.id);
  }
});

test("tank sizes are in a believable range for cars and motorbikes", () => {
  for (const v of cat.vehicles) {
    const [lo, hi] = v.type === "bike" ? [3, 30] : [20, 120];
    assert.ok(v.tank >= lo && v.tank <= hi, `${v.id}: ${v.tank} L`);
  }
});

test("gaps say why a brand or model has no figure", () => {
  assert.ok(cat.gaps.length > 0);
  for (const g of cat.gaps) assert.ok(g.brand && g.reason);
});

test("brands are listed once per vehicle type, in order", () => {
  const cars = Catalog.brands(cat, "car"), bikes = Catalog.brands(cat, "bike");
  assert.ok(cars.includes("Dacia") && !cars.includes("Yamaha"));
  assert.ok(bikes.includes("Yamaha") && !bikes.includes("Dacia"));
  assert.equal(new Set(cars).size, cars.length);
  assert.deepEqual(cars, [...cars].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true })));
});

test("models of a brand are sorted and found again by id", () => {
  const m = Catalog.models(cat, "car", "Peugeot");
  assert.ok(m.length >= 5);
  assert.ok(m.every((v) => v.brand === "Peugeot" && v.type === "car"));
  assert.deepEqual(m.map((v) => v.model), [...m.map((v) => v.model)].sort((a, b) => a.localeCompare(b, "en", { numeric: true })));
  assert.equal(Catalog.byId(cat, m[0].id), m[0]);
  assert.equal(Catalog.byId(cat, "no-such-id"), null);
  assert.deepEqual(Catalog.models(cat, "bike", "Peugeot"), []);
});

test("a known model gives its official tank size", () => {
  const sandero = Catalog.models(cat, "car", "Dacia").find((v) => v.model === "Sandero");
  assert.equal(sandero.tank, 50);
  assert.equal(Catalog.site(sandero), "dacia.fr");
  assert.equal(Catalog.fullName(sandero), "Dacia Sandero");
  const pcx = Catalog.models(cat, "bike", "Honda").find((v) => v.model === "PCX125");
  assert.equal(pcx.tank, 8.1);
  assert.equal(Catalog.label(pcx), "PCX125 · 2025");
});

test("labels join the model, variant and years that are known", () => {
  assert.equal(Catalog.label(entry({ model: "Tucson", variant: "1.6T Hybrid" })), "Tucson · 1.6T Hybrid");
  assert.equal(Catalog.label(entry({ model: "NC750X", years: "2025–2027" })), "NC750X · 2025–2027");
  assert.equal(Catalog.label(entry({ model: "Logan" })), "Logan");
});

test("entries without an official figure are left out", () => {
  const d = (vehicles) => Catalog.parse({ format: 1, vehicles }).vehicles.length;
  assert.equal(d([entry()]), 1);
  assert.equal(d([entry({ tank: null })]), 0);
  assert.equal(d([entry({ tank: 0 })]), 0);
  assert.equal(d([entry({ tank: "50" })]), 0);
  assert.equal(d([entry({ source: "http://www.x.com/spec" })]), 0);
  assert.equal(d([entry({ source: "not a url" })]), 0);
  assert.equal(d([entry({ checked: "yesterday" })]), 0);
  assert.equal(d([entry({ brand: "" })]), 0);
  assert.equal(d([entry({ type: "truck" })]), 0);
  assert.equal(d([entry({ id: "Bad Id" })]), 0);
  assert.equal(d([entry(), entry()]), 1, "a repeated id is kept once");
});

test("a damaged or unknown file gives an empty catalogue instead of an error", () => {
  for (const bad of ["{", "null", "[]", JSON.stringify({ format: 2, vehicles: [entry()] }), null, 42]) {
    const c = Catalog.parse(bad);
    assert.deepEqual(c.vehicles, []);
    assert.deepEqual(Catalog.brands(c, "car"), []);
  }
  assert.deepEqual(Catalog.brands(null, "car"), []);
  assert.deepEqual(Catalog.models(null, "car", "Dacia"), []);
  assert.equal(Catalog.parse(JSON.stringify({ format: 1, vehicles: [entry()] })).vehicles.length, 1);
});

test("an unknown fuel is dropped but the entry is kept", () => {
  const [v] = Catalog.parse({ format: 1, vehicles: [entry({ fuel: "lpg" })] }).vehicles;
  assert.equal(v.fuel, null);
  assert.equal(Catalog.parse({ format: 1, vehicles: [entry({ fuel: "gasoil" })] }).vehicles[0].fuel, "gasoil");
});
