// Renders the consolidated position into the broker rundown. Deterministic on
// purpose: the model extracts, this prints. Nothing can appear here that did not
// come out of a parsed message.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const money = (n) => (typeof n === "number" ? `$${n.toFixed(2)}` : null);

function rateText(r) {
  if (typeof r.rate !== "number") return null;
  const lo = money(r.rate);
  return typeof r.rate_high === "number" ? `${lo}-${money(r.rate_high).replace("$", "")}` : lo;
}

// "asking $38", "bid $36.75", "idea $37.88" -- the spec wants firm offers and
// indications distinguished, so the verb is always carried with the number.
function pricePhrase(r) {
  const txt = rateText(r);
  if (!txt) return null;
  const verb = { bid: "bid", offer: "offer", asking: "asking", holds: "holds", idea: "idea", fixed: "fixed", reported: "reported" }[r.indication];
  return verb ? `${verb} ${txt}` : txt;
}

function vesselLabel(t) {
  const size = t.size && t.year ? ` ${t.size}/${t.year}` : "";
  return `${String(t.vessel || "TBN").toUpperCase()}${size}`;
}

function flagBits(t) {
  const bits = [];
  if (t.flags?.scrubber) bits.push("scrubber");
  if (t.flags?.nuke || /nuke/i.test(t.vessel || "")) bits.push("nuke");
  if (t.flags?.bs) bits.push("B/S");
  if (/NSF/i.test(t.raw || "")) bits.push("NSF");
  return bits;
}

function dateWindowLabel(win) {
  if (!win) return "";
  const f = (d) => `${d.day} ${MONTHS[d.month - 1]}`;
  return win.from.month === win.to.month ? `${win.from.day}-${win.to.day} ${MONTHS[win.to.month - 1]}` : `${f(win.from)}-${f(win.to)}`;
}

function section(title, lines) {
  return lines.length ? `*${title}*\n${lines.join("\n")}` : null;
}

function render(state, { date, window: win, routes = ["C3", "WAFR", "PDM/RDAM"] } = {}) {
  const out = [];
  const label = dateWindowLabel(win);
  out.push(`*C3 / WAFR — ${label || date}*`);

  // ---- LAST FIXTURES (newest first) ----
  const fx = state.fixtures.map((f) => {
    const bits = [
      f.date ? shortDate(f.date) : null,
      f.charterer || null,
      f.vessel ? vesselLabel(f) : "TBN",
      f.route_detail || f.route,
      rateText(f),
    ].filter(Boolean);
    const tag = f.disputed ? " — reported" : f.status === "subjects" ? " — subs" : f.status === "failed" ? " — failed" : "";
    return `• ${bits.join(" — ")}${tag}`;
  });
  const fixtureBlock = section("LAST FIXTURES", fx);
  if (fixtureBlock) out.push(fixtureBlock);

  // ---- CARGO, split by route, earliest laycan first ----
  const cargoLines = [];
  for (const route of routes) {
    const rows = state.cargo.filter((c) => c.route === route);
    if (!rows.length) continue;
    if (routes.filter((r) => state.cargo.some((c) => c.route === r)).length > 1) {
      cargoLines.push(`_${route === "PDM/RDAM" ? "PDM/Rdam" : route}_`);
    }
    for (const c of rows) {
      const bits = [
        `*${String(c.charterer).toUpperCase()}*`,
        c.route_detail || (c.wafr_option ? "C3 + WAF opt" : null),
        c.qty,
        c.laycan,
        pricePhrase(c) || c.status || null,
      ].filter(Boolean);
      let line = `• ${bits.join(" — ")}`;
      if (pricePhrase(c) && c.status) line += ` — ${c.status}`;
      const extra = (c.restrictions || []).slice(0, 3).join(", ");
      if (extra) line += `\n  ${extra}`;
      cargoLines.push(line);
    }
  }
  const cargoBlock = section("CARGO", cargoLines);
  if (cargoBlock) out.push(cargoBlock);

  // ---- TONNAGE, strictly by ETA ----
  const tonLines = state.tonnage
    .filter((t) => t.route !== "OTHER")
    .map((t) => {
      const bits = [
        `*${vesselLabel(t)}*`,
        t.owner || null,
        t.eta ? `ETA ${t.eta_region === "WAF" ? "WAF" : "Tub"} ${t.eta}` : null,
        pricePhrase(t) || "idea TBC",
      ].filter(Boolean);
      const flags = flagBits(t);
      return `• ${bits.join(" — ")}${flags.length ? ` (${flags.join(", ")})` : ""}`;
    });
  const tonBlock = section("TONNAGE", tonLines);
  if (tonBlock) out.push(tonBlock);

  // ---- MARKET ----
  out.push(`*MARKET*\n${marketLine(state)}`);

  return out.filter(Boolean).join("\n\n");
}

// Last / Bid / Offers are computed from the C3 records only -- PDM/Rdam prices
// are a different route and must never be averaged in.
function marketLine(state) {
  const c3 = (r) => r.route === "C3" || r.route === "WAFR";

  const last = state.fixtures.filter((f) => typeof f.rate === "number" && c3(f))[0];
  const bids = state.cargo.filter((c) => c3(c) && typeof c.rate === "number" && ["bid", "holds"].includes(c.indication)).map((c) => c.rate);
  // Firm offers set the market. Soft "ideas" are shown per vessel but must not
  // widen the quoted spread -- a stray low idea made the gap look closed.
  const firm = state.tonnage
    .filter((t) => c3(t) && typeof t.rate === "number" && ["offer", "asking", "holds"].includes(t.indication))
    .map((t) => t.rate);
  const offers = firm.length ? firm : state.tonnage.filter((t) => c3(t) && typeof t.rate === "number").map((t) => t.rate);

  const parts = [];
  parts.push(`Last: ${last ? money(last.rate) : "n/a"}`);
  parts.push(`Bid: ${bids.length ? money(Math.max(...bids)) : "n/a"}`);
  parts.push(
    `Offers: ${
      offers.length
        ? offers.length > 1 && Math.min(...offers) !== Math.max(...offers)
          ? `${money(Math.min(...offers))}-${money(Math.max(...offers)).replace("$", "")}`
          : money(Math.min(...offers))
        : "n/a"
    }`
  );

  let read = "";
  if (bids.length && offers.length) {
    const gap = Math.min(...offers) - Math.max(...bids);
    const supply = state.tonnage.filter((t) => c3(t)).length;
    const demand = state.cargo.filter((c) => c3(c)).length;
    if (gap <= 0.25) read = "Gap narrow, trade close.";
    else if (supply > demand * 2) read = "Ample tonnage, charterers resisting.";
    else if (demand >= supply) read = "Cargo building, owners firming.";
    else read = `Gap ${money(gap).replace("$", "$")}, neither side moving.`;
  }

  return `${parts.join(" | ")}${read ? `\n${read}` : ""}`;
}

function shortDate(iso) {
  const [, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

module.exports = { render, dateWindowLabel };
