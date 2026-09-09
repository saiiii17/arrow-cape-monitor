// The desk posts an "ARROW CAPE BALLASTER LIST" most days: an authoritative,
// structured tonnage position. Parsing it deterministically gives the TONNAGE
// section a spine that no model can hallucinate onto -- the chat only has to
// supply the rate ideas layered over these vessels.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// *BRAVOS* (GLENCORE FREIGHT) 180/ 10/ 18.22 M /SCRUBBER - _ETA TUB SEP 19-20_ - *B/S*
const NAMED = /^\*?([A-Z0-9][A-Z0-9 .'&-]{2,40}?)\*?\s*\(([^)]+)\)\s*(\d{3})\s*\/\s*(\d{2})\s*\/?\s*([\d.]+)?\s*M?/i;
// NUKE TBN *OLDENDORFF* _ETA TUB OCT 1-5   |   STD TBN *NYK* _ETA TUB OCT 15
const TBN = /^(NUKE|STD|BABY)?\s*TBN\s*\*?([A-Z0-9 .'&-]{2,40}?)\*?\s*_?ETA/i;
const ETA = /ETA\s+(TUB|WAF|WAFR|BRAZ[A-Z\/]*|GIB)?\s*([A-Z]{3})?\s*(\d{1,2})(?:\s*[-\/]\s*(\d{1,2}))?/i;

function stripMarks(line) {
  return line.replace(/[*_~]/g, "").trim();
}

// Turn "SEP 19-20" into a sortable key plus the display form the rundown wants.
function parseEta(raw, listYear) {
  const m = raw.match(ETA);
  if (!m) return null;
  const [, region, mon, d1, d2] = m;
  const month = mon ? MONTHS[mon.toLowerCase()] : null;
  if (!month) return null;
  const year = listYear;
  return {
    region: (region || "TUB").toUpperCase().replace(/^BRAZ.*/, "BRAZ"),
    month,
    day: Number(d1),
    dayEnd: d2 ? Number(d2) : null,
    sort: year * 10000 + month * 100 + Number(d1),
    display: d2
      ? `${d1}-${d2} ${mon[0].toUpperCase()}${mon.slice(1, 3).toLowerCase()}`
      : `${d1} ${mon[0].toUpperCase()}${mon.slice(1, 3).toLowerCase()}`,
  };
}

function parseList(body, date) {
  const year = Number(date.slice(0, 4));
  const lines = body.split("\n").map(stripMarks).filter(Boolean);
  const header = lines.find((l) => /BALLASTER LIST/i.test(l)) || "";
  const indexDates = (header.match(/Index\s*dates?:\s*(.+)$/i) || [])[1] || null;

  const vessels = [];
  for (const line of lines) {
    if (/BALLASTER LIST|^=+$|^\d{2}\/\d{2}\/\d{2}/.test(line)) continue;
    if (!/ETA/i.test(line)) continue;

    const eta = parseEta(line, year);
    if (!eta) continue;

    const flags = {
      scrubber: /SCRUBBER/i.test(line),
      nuke: /\bNUKE\b/i.test(line),
      bs: /\bB\/S\b/i.test(line),
      exOurCp: /EX OUR C\/P/i.test(line),
    };

    const named = line.match(NAMED);
    if (named) {
      vessels.push({
        vessel: named[1].trim().toUpperCase(),
        owner: named[2].trim(),
        size: named[3],
        year: named[4],
        draft: named[5] || null,
        tbn: false,
        eta,
        flags,
        raw: line,
      });
      continue;
    }

    const tbn = line.match(TBN);
    if (tbn) {
      vessels.push({
        vessel: `${tbn[1] ? tbn[1].toUpperCase() + " " : ""}TBN`,
        owner: tbn[2].trim(),
        size: null,
        year: null,
        draft: null,
        tbn: true,
        eta,
        flags,
        raw: line,
      });
    }
  }

  return { date, indexDates, vessels };
}

// Most recent list on or before `date`.
function latestList(messages, date) {
  const lists = messages
    .filter((m) => /BALLASTER LIST/i.test(m.body) && m.date <= date)
    .sort((a, b) => (a.date === b.date ? a.minutes - b.minutes : a.date < b.date ? -1 : 1));
  const last = lists[lists.length - 1];
  return last ? parseList(last.body, last.date) : null;
}

module.exports = { parseList, latestList, parseEta };
