// The model is unreliable at route bucketing -- it put a "Braz/WAF" ballaster in
// OTHER and a Nouadhibou cargo in C3. Basins are decided by load port, which is
// a lookup, so it is done deterministically here and overrides the model.

const WAFR_LOAD = /\b(nouad(?:hibou)?|snim|kamsar|boffa|morebaya|conakry|simfer|dapilon|guinea|w\s?afr(?:ica)?|wafr|waf)\b/i;
const BRAZIL_LOAD = /\b(tubarao|tubarão|tub|sudeste|ponta\s+da\s+madeira|pdm|itaguai|guaiba|acu|brazil|braz|bzl)\b/i;
const CONTINENT_DISCH = /\b(rdam|rotterdam|continent|europe|amsterdam|dunkirk|taranto|gijon|hamburg)\b/i;
const CHINA_DISCH = /\b(qingdao|q'?dao|huanghua|caofeidian|rizhao|lanshan|bayuquan|jingtang|china|far\s?east|india)\b/i;
const OTHER_SIGNS = /\b(misurata|point\s+lisas|rbay|richards\s+bay|maputo|abidjan|c7\b|transatlantic|\bta\b|backhaul|b\/h|bhaul|newcastle|ubu)\b/i;

// C3 and WAFR trade in the $20s-$70s; PDM/Rdam is a short fronthaul in the teens.
// A rate outside its basin's band is a mis-extraction, not a market move.
const BANDS = {
  C3: [20, 80],
  WAFR: [15, 80],
  "PDM/RDAM": [5, 28],
  OTHER: [0, 1e6],
};

function classifyRoute(rec) {
  // An explicit "Tubarao/Qingdao" settles the basin. Falling back to the whole
  // message lets an unrelated "WAF opt" elsewhere in the post hijack the route.
  if (rec.route_detail) {
    const decided = fromPorts(rec.route_detail);
    if (decided) return decided;
  }
  const text = `${rec.route_detail || ""} ${rec.raw || ""}`;

  // Tonnage is a ballaster position: an ETA at Tubarao or Brazil/WAF serves the
  // C3 book regardless of which cargo it eventually takes.
  if (rec.kind === "tonnage") {
    const region = (rec.eta_region || "").toUpperCase();
    if (["TUB", "BRAZ", "WAF"].includes(region)) return "C3";
    if (WAFR_LOAD.test(text) && !BRAZIL_LOAD.test(text)) return "WAFR";
    if (BRAZIL_LOAD.test(text)) return "C3";
    if (OTHER_SIGNS.test(text)) return "OTHER";
    return rec.route === "PDM/RDAM" ? "OTHER" : rec.route || "C3";
  }

  // "buy c3 /waf" is a C3 cargo carrying a West Africa option, not a WAFR cargo.
  if (rec.wafr_option && !WAFR_LOAD.test(rec.route_detail || "")) return "C3";

  // Cargo and fixtures are decided by load port first, discharge second.
  if (WAFR_LOAD.test(text)) return "WAFR";
  if (BRAZIL_LOAD.test(text)) return CONTINENT_DISCH.test(text) ? "PDM/RDAM" : "C3";
  if (CONTINENT_DISCH.test(text)) return "PDM/RDAM";
  if (OTHER_SIGNS.test(text)) return "OTHER";
  if (CHINA_DISCH.test(text)) return "C3";
  return rec.route || "OTHER";
}

// Load port decides the basin; discharge separates C3 from the Continent run.
function fromPorts(text) {
  if (WAFR_LOAD.test(text)) return "WAFR";
  if (BRAZIL_LOAD.test(text)) return CONTINENT_DISCH.test(text) ? "PDM/RDAM" : "C3";
  if (CONTINENT_DISCH.test(text)) return "PDM/RDAM";
  return null;
}

// Drop a rate that cannot belong to its basin rather than printing a wrong number.
function rateIsPlausible(route, rate) {
  if (typeof rate !== "number") return false;
  const [lo, hi] = BANDS[route] || BANDS.OTHER;
  return rate >= lo && rate <= hi;
}

module.exports = { classifyRoute, rateIsPlausible, BANDS };
