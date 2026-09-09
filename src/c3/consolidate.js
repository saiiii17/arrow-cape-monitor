const { parseEta } = require("./ballasters");
const { classifyRoute, rateIsPlausible } = require("./routes");

// "Consolidate repeated updates into the latest position only" -- every rule in
// the rundown spec that is about ordering, de-duplication or precedence is
// enforced here in code, never left to the model.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Chronological key across days. `minutes` alone is minutes-within-day, so
// sorting on it puts yesterday's 18:41 after today's 10:23 and a stale bid wins.
function stamp(r) {
  return `${r.date || ""} ${String(r.minutes ?? 0).padStart(4, "0")}`;
}

function norm(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

function vesselKey(r) {
  if (r.vessel) return `v:${norm(r.vessel)}`;
  return `t:${norm(r.owner)}|${norm(r.eta)}`;
}

function cargoKey(r) {
  return `${norm(r.charterer)}|${r.route}`;
}

// First day of a laycan/ETA string, for sorting. "20-26 Sep" -> Sep 20.
function firstDate(text, year) {
  if (!text) return null;
  const m = String(text).match(/(\d{1,2})(?:\s*[-\/]\s*\d{1,2})?\s*([A-Za-z]{3})/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    return year * 10000 + MONTHS[m[2].toLowerCase()] * 100 + Number(m[1]);
  }
  const m2 = String(text).match(/([A-Za-z]{3})\w*\s*(\d{1,2})/);
  if (m2 && MONTHS[m2[1].toLowerCase()]) {
    return year * 10000 + MONTHS[m2[1].toLowerCase()] * 100 + Number(m2[2]);
  }
  return null;
}

// Later record wins field by field, but a null must never erase a known value.
function merge(base, next) {
  const out = { ...base };
  for (const [k, v] of Object.entries(next)) {
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  // rate and rate_high are one quotation. A fresh rate without a high must not
  // inherit the previous quote's high, or $16 becomes "$16.00-15.00".
  if (typeof next.rate === "number") {
    out.rate = next.rate;
    out.rate_high = typeof next.rate_high === "number" ? next.rate_high : null;
    out.indication = next.indication || out.indication;
  }
  if (typeof out.rate === "number" && typeof out.rate_high === "number" && out.rate_high < out.rate) {
    [out.rate, out.rate_high] = [out.rate_high, out.rate];
  }
  out.history = [...(base.history || []), { time: next.time, rate: next.rate, indication: next.indication, note: next.note }];
  return out;
}

// the owner: the buy/sell wording mostly holds, "but ETA only shows up in case of
// ships". A record carrying an ETA and none of the cargo hallmarks (laycan,
// stem size, load/discharge ports) is tonnage, whatever the model called it.
// This is what mis-filed "Koch open as follows / Newc ETA 27 Sept / 38.50 C3
// offer" as a cargo bid.
function correctSide(r) {
  if (r.kind !== "cargo") return r;
  const hasCargoMarkers = Boolean(r.laycan || r.qty || r.route_detail);
  const sellWords = /\b(open|offer|offering|asking|sell|ballaster|ex our c\/p|relet)\b/i.test(r.raw || "");
  if (r.eta && !hasCargoMarkers) {
    return { ...r, kind: "tonnage", owner: r.owner || r.charterer, charterer: null, sideCorrected: "eta" };
  }
  if (r.eta && sellWords && !r.laycan && !r.qty) {
    return { ...r, kind: "tonnage", owner: r.owner || r.charterer, charterer: null, sideCorrected: "eta+wording" };
  }
  return r;
}

function consolidate(records, { date, ballasters }) {
  const year = Number(date.slice(0, 4));
  const sorted = [...records]
    .map(correctSide)
    .map((r) => {
      const route = classifyRoute(r);
      let rate = rateIsPlausible(route, r.rate) ? r.rate : null;
      let high = rate !== null && rateIsPlausible(route, r.rate_high) ? r.rate_high : null;
      // A quote written high-first ("38 vs 36") must still read low-to-high.
      if (rate !== null && high !== null && high < rate) [rate, high] = [high, rate];
      return {
        ...r,
        route,
        rate,
        rate_high: high,
        indication: rate === null && r.indication !== "none" ? "none" : r.indication,
      };
    })
    .sort((a, b) => stamp(a).localeCompare(stamp(b)));

  const cargo = new Map();
  const tonnage = new Map();
  const fixtures = [];

  for (const r of sorted) {
    if (r.kind === "fixture") {
      fixtures.push(r);
      continue;
    }
    if (r.kind === "cargo") {
      if (!r.charterer) continue;
      const k = cargoKey(r);
      cargo.set(k, cargo.has(k) ? merge(cargo.get(k), r) : { ...r, history: [] });
      continue;
    }
    if (r.kind === "tonnage") {
      const k = vesselKey(r);
      tonnage.set(k, tonnage.has(k) ? merge(tonnage.get(k), r) : { ...r, history: [] });
    }
  }

  // Layer chat-sourced rates onto the ballaster list spine. The list supplies
  // identity and ETA; the chat supplies the money.
  if (ballasters) {
    for (const v of ballasters.vessels) {
      const k = `v:${norm(v.vessel)}`;
      const existing = tonnage.get(k);
      const spine = {
        kind: "tonnage",
        vessel: v.vessel,
        owner: v.owner,
        size: v.size,
        year: v.year,
        route: "C3",
        eta: v.eta.display,
        eta_region: v.eta.region,
        etaSort: v.eta.sort,
        flags: v.flags,
        fromList: true,
        rate: null,
        indication: "none",
        restrictions: [],
        history: [],
      };
      // The list is authoritative for identity. Chat supplies the money, but a
      // chat-extracted owner must not overwrite the list's -- brokers post each
      // other's ships and the model attributes them to whoever spoke.
      tonnage.set(
        k,
        existing
          ? { ...spine, ...stripNulls(existing), owner: v.owner, size: v.size, year: v.year, flags: v.flags, fromList: true }
          : spine
      );
    }
  }

  // A TBN that shares an owner and dimensions with a named ship is that ship.
  for (const [k, t] of [...tonnage]) {
    // An unnamed position renders as "TBN"; vessel is simply null on the record.
    if (t.vessel && !/TBN/i.test(String(t.vessel))) continue;
    const twin = [...tonnage.values()].find(
      (o) =>
        o !== t &&
        o.vessel &&
        !/TBN/i.test(String(o.vessel)) &&
        norm(o.owner) === norm(t.owner) &&
        // Brokers round dwt differently ("187" vs the list's "188"), so allow
        // a couple of thousand tonnes of slack when the year matches.
        (o.size === t.size || (t.size && o.size && Math.abs(Number(o.size) - Number(t.size)) <= 2)) &&
        (o.year === t.year || !t.year)
    );
    if (twin) {
      Object.assign(twin, merge(twin, stripNulls({ rate: t.rate, rate_high: t.rate_high, indication: t.indication, note: t.note })));
      tonnage.delete(k);
    }
  }

  // "BOCIMAR 210/24" names an owner, not a ship -- show it as that owner's TBN.
  const owners = new Set([...tonnage.values()].map((t) => norm(t.owner)).filter(Boolean));
  for (const t of tonnage.values()) {
    if (!t.vessel || !owners.has(norm(t.vessel))) continue;
    if (!t.owner || norm(t.vessel) === norm(t.owner)) {
      t.owner = t.owner || t.vessel;
      t.vessel = null;
    }
  }

  // Nothing identifiable and no arrival: not a tonnage position.
  for (const [k, t] of [...tonnage]) {
    if (!t.vessel && !t.owner && !t.eta) tonnage.delete(k);
  }

  // A fixture rarely restates its route; inherit it from the ship named.
  for (const f of fixtures) {
    if (f.route !== "OTHER" || !f.vessel) continue;
    const ship = [...tonnage.values()].find((t) => norm(t.vessel) === norm(f.vessel));
    if (ship && ship.route !== "OTHER") f.route = ship.route;
  }

  // "Opral ARROW SG" posting a ship does not make Opral the owner.
  for (const t of tonnage.values()) {
    if (t.owner && t.sender && norm(t.owner) === norm(String(t.sender).replace(/\s+ARROW.*$/i, ""))) {
      t.owner = null;
    }
    if (typeof t.rate === "number" && (!t.indication || t.indication === "none")) t.indication = "idea";
  }

  const tonnageList = [...tonnage.values()]
    .map((t) => ({ ...t, etaSort: t.etaSort ?? firstDate(t.eta, year) ?? Infinity }))
    .sort((a, b) => a.etaSort - b.etaSort || String(a.vessel).localeCompare(String(b.vessel)));

  const cargoList = [...cargo.values()]
    .map((c) => ({ ...c, laycanSort: firstDate(c.laycan, year) ?? Infinity, laycanEndSort: lastDate(c.laycan, year) ?? firstDate(c.laycan, year) ?? Infinity }))
    .sort((a, b) => a.laycanSort - b.laycanSort || String(a.charterer).localeCompare(String(b.charterer)));

  return {
    cargo: cargoList,
    tonnage: tonnageList,
    fixtures: dedupeFixtures(fixtures),
  };
}

function stripNulls(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ""));
}

function dedupeFixtures(fixtures) {
  const seen = new Map();
  for (const f of fixtures) {
    const k = `${norm(f.charterer)}|${norm(f.vessel)}|${f.rate ?? ""}`;
    if (!seen.has(k)) seen.set(k, f);
    else if (f.disputed === false && seen.get(k).disputed) seen.set(k, f);
  }
  return [...seen.values()].sort((a, b) => stamp(b).localeCompare(stamp(a)));
}

// Last day of a laycan. "20-26 Sep" -> Sep 26; "25 Sep onwards" -> open-ended.
function lastDate(text, year) {
  if (!text) return null;
  if (/onward|onws|onw\b|\+|any\b/i.test(text)) return Infinity;
  const m = String(text).match(/(\d{1,2})\s*[-\/]\s*(\d{1,2})\s*([A-Za-z]{3})/);
  if (m && MONTHS[m[3].toLowerCase()]) {
    return year * 10000 + MONTHS[m[3].toLowerCase()] * 100 + Number(m[2]);
  }
  return firstDate(text, year);
}

module.exports = { consolidate, firstDate, lastDate };
