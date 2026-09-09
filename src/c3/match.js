// Cargo <-> vessel matching for C3/WAFR.
//
// The rundown prompt defines a reporting format, not a matching rule, so this
// is a purpose-built algorithm. Every component is additive and carries its own
// explanation, so a score can always be read back as "why".
//
//   timing      55   ETA against the laycan, +/- 2 days (the owner's buffer)
//   compliance  20   age limit, nuke/std, basin restrictions
//   commercial  25   how far apart the bid and the offer are
//
// Stem size is deliberately NOT scored. the owner: "no need to factor stem size at
// this stage at all" -- most Capes can lift most Cape stems, and the quantities
// in chat are too loosely written to filter on safely.
//
// A hard blocker (wrong basin, too small, over-age, misses the window) zeroes
// the match rather than quietly scoring it low.

const YEAR_NOW = 2026;

const WEIGHTS = { timing: 55, compliance: 20, commercial: 25 };

// the owner: "+/- 2 days buffer should be fine".
const LAYCAN_BUFFER_DAYS = 2;

function sortToDate(sort) {
  if (!sort || !isFinite(sort)) return null;
  return new Date(Date.UTC(Math.floor(sort / 10000), Math.floor((sort % 10000) / 100) - 1, sort % 100));
}

function daysBetween(a, b) {
  const da = sortToDate(a);
  const db = sortToDate(b);
  if (!da || !db) return null;
  return Math.round((db - da) / 86400000);
}

// "170-190/10" -> {low:170, high:190, tol:10}   "190/10" -> {low:190, high:190, tol:10}
function parseQty(qty) {
  if (!qty) return null;
  const m = String(qty).match(/(\d{2,3})\s*(?:-\s*(\d{2,3}))?\s*\/\s*(\d{1,2})/);
  if (!m) return null;
  const low = Number(m[1]);
  if (low < 50 || low > 400) return null; // guards against typos like "1801/0"
  return { low, high: m[2] ? Number(m[2]) : low, tol: Number(m[3]) };
}

function vesselAge(year) {
  if (!year) return null;
  const yy = Number(year);
  if (Number.isNaN(yy)) return null;
  const full = yy <= (YEAR_NOW % 100) + 1 ? 2000 + yy : 1900 + yy;
  return YEAR_NOW - full;
}

function maxAgeFrom(restrictions = [], raw = "") {
  const text = `${restrictions.join(" ")} ${raw}`;
  const m = text.match(/max\s*(\d{2})\s*(?:y|yr|yrs|years)/i);
  return m ? Number(m[1]) : null;
}

function nukePolicy(cargo) {
  const text = `${(cargo.restrictions || []).join(" ")} ${cargo.raw || ""}`;
  if (/\b(no|non|def\s+no)[\s-]*nuke\b/i.test(text)) return "excluded";
  if (/\bnuke\s+only\b/i.test(text)) return "required";
  if (/\b(cape\s+or\s+nuke|std\s*\/?\s*nuke|nuke)\b/i.test(text)) return "allowed";
  return "unstated";
}

function isNuke(vessel) {
  return Boolean(vessel.flags?.nuke) || /nuke/i.test(String(vessel.vessel || "")) || Number(vessel.size) >= 200;
}

function scoreMatch(cargo, vessel) {
  const reasons = [];
  const blockers = [];
  let score = 0;

  // ---- basin ----------------------------------------------------------------
  // Atlantic ballasters serve both C3 and WAFR; only a Continent run is distinct.
  const cargoBasin = cargo.route;
  if (cargoBasin === "PDM/RDAM" || cargoBasin === "OTHER") {
    blockers.push(`${cargoBasin === "OTHER" ? "Non-C3 route" : "PDM/Rdam"} — not comparable to a C3 ballaster`);
  } else {
    reasons.push(`${cargoBasin} cargo, Atlantic ballaster`);
  }

  // ---- timing ---------------------------------------------------------------
  const eta = vessel.etaSort;
  const lay0 = cargo.laycanSort;
  const lay1 = cargo.laycanEndSort === Infinity ? null : cargo.laycanEndSort;

  if (!eta || !isFinite(eta) || !lay0 || !isFinite(lay0)) {
    reasons.push("Timing unknown — no ETA or laycan given");
    score += WEIGHTS.timing * 0.3;
  } else {
    const early = daysBetween(eta, lay0); // >0 means ship arrives before laycan opens
    const late = lay1 ? daysBetween(lay1, eta) : -1; // >0 means ship arrives after laycan closes

    if (late > LAYCAN_BUFFER_DAYS) {
      blockers.push(`ETA ${vessel.eta} misses laycan ${cargo.laycan} by ${late} days`);
    } else if (late > 0) {
      score += WEIGHTS.timing * 0.85;
      reasons.push(`ETA ${vessel.eta} is ${late}d past laycan end, inside the ${LAYCAN_BUFFER_DAYS}d buffer`);
    } else if (early > 12) {
      score += WEIGHTS.timing * 0.35;
      reasons.push(`Early — ${early}d of waiting before ${cargo.laycan}`);
    } else if (early > LAYCAN_BUFFER_DAYS + 2) {
      score += WEIGHTS.timing * 0.75;
      reasons.push(`Arrives ${early}d before laycan opens`);
    } else {
      score += WEIGHTS.timing;
      reasons.push(`ETA ${vessel.eta} sits inside laycan ${cargo.laycan}`);
    }
  }

  // ---- compliance -----------------------------------------------------------
  let compliance = WEIGHTS.compliance;
  const maxAge = maxAgeFrom(cargo.restrictions, cargo.raw);
  const age = vesselAge(vessel.year);
  if (maxAge && age !== null) {
    if (age > maxAge) blockers.push(`${age}y old, over the max ${maxAge}y`);
    else reasons.push(`${age}y old, inside max ${maxAge}y`);
  } else if (maxAge) {
    compliance *= 0.7;
    reasons.push(`Age unknown against max ${maxAge}y`);
  }

  const policy = nukePolicy(cargo);
  const nuke = isNuke(vessel);
  if (policy === "excluded" && nuke) blockers.push("Nuke excluded on this cargo");
  else if (policy === "required" && !nuke) blockers.push("Cargo wants a nuke");
  else if (policy === "allowed" && nuke) reasons.push("Nuke acceptable here");
  score += compliance;

  // ---- commercial -----------------------------------------------------------
  const bid = typeof cargo.rate === "number" ? cargo.rate : null;
  const offer = typeof vessel.rate === "number" ? vessel.rate : null;
  let gap = null;
  if (bid !== null && offer !== null) {
    gap = Number((offer - bid).toFixed(2));
    if (gap <= 0) {
      score += WEIGHTS.commercial;
      reasons.push(`Offer $${offer.toFixed(2)} at or under bid $${bid.toFixed(2)} — tradeable now`);
    } else if (gap <= 0.5) {
      score += WEIGHTS.commercial * 0.85;
      reasons.push(`Gap $${gap.toFixed(2)} — close`);
    } else if (gap <= 1.25) {
      score += WEIGHTS.commercial * 0.5;
      reasons.push(`Gap $${gap.toFixed(2)} — workable`);
    } else {
      score += WEIGHTS.commercial * 0.15;
      reasons.push(`Gap $${gap.toFixed(2)} — wide`);
    }
  } else {
    score += WEIGHTS.commercial * 0.4;
    reasons.push(offer === null ? "No rate idea from owners yet" : "No bid from charterers yet");
  }

  if (blockers.length) score = 0;

  return {
    score: Math.round(score),
    reasons,
    blockers,
    gap,
    bid,
    offer,
  };
}

// Best vessels for every cargo, plus the reverse view for the tonnage side.
function matchAll(state, { minScore = 40, perCargo = 4 } = {}) {
  const matches = [];

  for (const cargo of state.cargo) {
    const scored = state.tonnage
      .map((vessel) => ({ vessel, ...scoreMatch(cargo, vessel) }))
      .sort((a, b) => b.score - a.score);

    matches.push({
      cargo,
      candidates: scored.filter((s) => s.score >= minScore).slice(0, perCargo),
      rejected: scored.filter((s) => s.score === 0 && s.blockers.length).length,
    });
  }

  return matches.sort((a, b) => (b.candidates[0]?.score || 0) - (a.candidates[0]?.score || 0));
}

module.exports = { scoreMatch, matchAll, parseQty, vesselAge, maxAgeFrom, nukePolicy };
