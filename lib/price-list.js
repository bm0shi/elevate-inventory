// Price List Check (owner 11/20: an Ardell volume price list, "are you able to
// use our brand finder to find some opportunity for us here after amazon
// fees"). A distributor's price list (Excel or CSV) → its rows with a UPC and
// every cost column → once the server has matched each UPC to its Amazon
// listing (Catalog Items search by UPC) and read the listing from Keepa, the
// profit per unit after Amazon's fees for each cost column, so switching
// between dealer / salon / volume pricing needs no new run.
// No database or network here.
'use strict';
const zlib = require('zlib');

// ---------- a small .xlsx reader (zip + the first worksheet's XML) ----------
// The app has no spreadsheet library; an .xlsx is a zip of XML files, and a
// price list only needs the first sheet's cell values.
function unzip(buf) {
  const files = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not an Excel (.xlsx) file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen, data = buf.slice(start, start + csize);
    if (method === 0) files[name] = data;
    else if (method === 8) files[name] = zlib.inflateRawSync(data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
const unxml = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d)).replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16))).replace(/&amp;/g, '&');
const colIndex = ref => { const m = /^([A-Z]+)/.exec(ref || ''); if (!m) return null; let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
function readXlsx(buf) {
  const f = unzip(buf);
  const shared = [];
  const ss = f['xl/sharedStrings.xml'];
  if (ss) for (const si of ss.toString('utf8').match(/<si>[\s\S]*?<\/si>/g) || []) shared.push(unxml((si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join('')));
  // the first sheet in the workbook's order (its relationship target), else sheet1
  let sheetPath = 'xl/worksheets/sheet1.xml';
  try {
    const wb = f['xl/workbook.xml'].toString('utf8'), rid = (/<sheet\b[^>]*r:id="([^"]+)"/.exec(wb) || [])[1];
    const rels = f['xl/_rels/workbook.xml.rels'].toString('utf8');
    const t = rid && (new RegExp('<Relationship\\b[^>]*Id="' + rid + '"[^>]*Target="([^"]+)"').exec(rels) || new RegExp('<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="' + rid + '"').exec(rels) || [])[1];
    if (t) sheetPath = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
  } catch (e) { /* keep sheet1 */ }
  const sheet = f[sheetPath] || Object.entries(f).find(([k]) => /^xl\/worksheets\/[^/]+\.xml$/.test(k))?.[1];
  if (!sheet) throw new Error('No worksheet found in the file.');
  const rows = [];
  for (const rm of sheet.toString('utf8').match(/<row\b[\s\S]*?<\/row>/g) || []) {
    const row = [];
    for (const cm of rm.match(/<c\b[^>]*\/>|<c\b[\s\S]*?<\/c>/g) || []) {
      const attrs = /<c\b([^>]*)/.exec(cm)[1];
      const ref = (/\br="([A-Z]+\d+)"/.exec(attrs) || [])[1], t = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
      const ci = colIndex(ref) != null ? colIndex(ref) : row.length;
      let v = null;
      if (t === 'inlineStr') v = unxml((cm.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map(x => x.replace(/<[^>]+>/g, '')).join(''));
      else {
        const raw = (/<v>([\s\S]*?)<\/v>/.exec(cm) || [])[1];
        if (raw != null) v = t === 's' ? shared[+raw] : t === 'str' || t === 'e' ? unxml(raw) : t === 'b' ? raw === '1' : (isFinite(+raw) ? +raw : unxml(raw));
      }
      row[ci] = v;
    }
    rows.push(row);
  }
  return rows;
}

// ---------- CSV / pasted text (Excel copy is tab-separated) ----------
function readDelimited(text) {
  const s = String(text || '').replace(/\r\n?/g, '\n');
  const first = s.split('\n').find(l => l.trim()) || '';
  const sep = first.includes('\t') ? '\t' : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"' && cell === '') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---------- the price list's columns and rows ----------
const clean = v => String(v == null ? '' : v).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
// UPC / EAN digits; a 12-digit UPC, a 13-digit EAN (a UPC with a leading 0 is
// the same code), 8 or 14 digits. "0-7476438369-3" → 074764383693.
function normUpc(v) {
  let d = clean(v).replace(/[^0-9]/g, '');
  if (d.length === 13 && d[0] === '0') d = d.slice(1);
  if (d.length === 14 && d.startsWith('00')) d = d.slice(2);
  return [8, 12, 13, 14].includes(d.length) ? d : null;
}
const money = v => { if (v == null || v === '') return null; const n = typeof v === 'number' ? v : Number(clean(v).replace(/[$,]/g, '')); return isFinite(n) && n > 0 ? n : null; };
// Finds the header row (the one naming a UPC / EAN / barcode column) and reads
// every row under it that has a valid code. Cost columns: any header that
// reads like a price (cost, price, net, wholesale, dealer, salon, volume…)
// and isn't retail / MSRP / SRP (those are what the customer pays).
function parseTable(rows) {
  let h = -1;
  for (let i = 0; i < Math.min(rows.length, 60); i++) if ((rows[i] || []).some(c => /\b(upc|ean|gtin|barcode)\b/i.test(clean(c)))) { h = i; break; }
  if (h < 0) throw new Error('No UPC column found. The price list needs a column headed UPC (or EAN / barcode).');
  const head = (rows[h] || []).map(clean);
  const find = re => head.findIndex(x => re.test(x));
  const upcCol = find(/\b(upc|ean|gtin|barcode)\b/i);
  const nameCol = find(/descr|product|item name|^name$|title/i);
  const itemCol = find(/^\s*(item|sku|style|part)\s*(#|no\.?|number|code)?\s*$/i);
  const caseCol = find(/case\s*pack|case\s*qty|^case$/i);
  const innerCol = find(/inner|min\.?\s*&|min(imum)?\s*qty/i);
  const costCols = [];
  head.forEach((x, i) => { if (i !== upcCol && /cost|price|net\b|wholesale|dealer|salon|volume|distributor|each/i.test(x) && !/retail|msrp|srp|suggested|\bmap\b/i.test(x)) costCols.push({ i, name: x }); });
  if (!costCols.length) throw new Error('No cost column found (a column headed cost, price, dealer, salon, volume…).');
  const out = [];
  let section = '';
  for (let r = h + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const upc = normUpc(row[upcCol]);
    if (!upc) { const t = row.map(clean).filter(Boolean); if (t.length === 1 && t[0].length < 80) section = t[0]; continue; }
    const costs = {};
    for (const c of costCols) { const m = money(row[c.i]); if (m != null) costs[c.name] = m; }
    out.push({ upc, name: nameCol >= 0 ? clean(row[nameCol]) : '', item: itemCol >= 0 ? clean(row[itemCol]) : '', section,
      casePack: caseCol >= 0 ? (parseInt(clean(row[caseCol]), 10) || null) : null, inner: innerCol >= 0 ? (parseInt(clean(row[innerCol]), 10) || null) : null, costs });
  }
  // a UPC listed twice keeps its first row
  const seen = new Set();
  return { costCols: costCols.map(c => c.name), rows: out.filter(r => !seen.has(r.upc) && seen.add(r.upc)) };
}
function readPriceList(buf, filename) {
  const isZip = buf && buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (isZip) return parseTable(readXlsx(buf));
  if (/\.xls$/i.test(filename || '')) throw new Error('Old .xls files can\'t be read: save it as .xlsx or .csv first.');
  return parseTable(readDelimited(buf.toString('utf8')));
}

// ---------- profit after Amazon's fees ----------
// price: what a buyer pays now — the lowest FBA offer, else the Buy Box, the
// lowest new offer or Amazon's own. Referral = the listing's % (15% if Keepa
// has none; at least $0.30, Amazon's minimum). FBA = Keepa's pick & pack fee;
// with none, profit isn't worked out (said, never guessed). other = the
// owner's own per-unit add-on (prep, labels, shipping in), 0 by default.
// Sales: Amazon's "bought in past month" (a floor), else 30-day rank drops (≈).
// Our share: an even split with the sellers already there plus us.
function listingPrice(k) { return k.newFbaPrice || k.buyBoxPrice || k.newPrice || k.amazonPrice || null; }
function fees(k, price) {
  if (!price) return null;
  const pct = k.referralPct > 0 ? k.referralPct : 15;
  const referral = Math.max(0.30, price * pct / 100);
  return { pct, referral, fba: k.pickPackFee != null ? k.pickPackFee : null, estPct: !(k.referralPct > 0) };
}
function profitFor(cost, k, other = 0) {
  const price = listingPrice(k), f = fees(k, price);
  if (!price || !f) return { price: null };
  const base = { price, referral: f.referral, referralPct: f.pct, refEst: f.estPct, fba: f.fba };
  if (f.fba == null || cost == null) return base;
  const amazon = f.referral + f.fba, profit = price - amazon - cost - (other || 0);
  return Object.assign(base, { amazon, profit, margin: profit / price, roi: profit / (cost + (other || 0)) });
}
function demandOf(k) {
  const perMo = k.monthlySold != null ? k.monthlySold : k.rankDrops30 != null ? k.rankDrops30 : null;
  const sellers = k.offerCount != null ? k.offerCount : null;
  return { perMo, perMoEst: k.monthlySold == null && k.rankDrops30 != null, sellers, ourMo: perMo != null ? perMo / ((sellers || 0) + 1) : null };
}
// A listing that's a multipack of the bottle on the price list (the cost would
// be per pack, not per unit): flagged from its title, never adjusted silently.
function packOf(title) {
  const m = /\b(?:pack|set|bundle|lot) of (\d{1,2})\b|\b(\d{1,2})[ -]?(?:pack|pk|count|ct)\b/i.exec(String(title || ''));
  const n = m ? +(m[1] || m[2]) : 1;
  return n > 1 && n <= 48 ? n : 1;
}
// One price-list row against its Amazon listing(s): the best seller of them
// (most a month, then best rank) is the one shown; the others are counted.
function scoreRow(row, listings, other) {
  const ok = (listings || []).filter(l => l && l.k);
  if (!ok.length) return { found: false };
  const best = ok.slice().sort((a, b) => ((demandOf(b.k).perMo || 0) - (demandOf(a.k).perMo || 0)) || ((a.k.salesRank || 1e9) - (b.k.salesRank || 1e9)))[0];
  const k = best.k, d = demandOf(k), byCost = {};
  for (const [col, cost] of Object.entries(row.costs || {})) {
    const p = profitFor(cost, k, other);
    byCost[col] = p.profit != null ? { profit: p.profit, margin: p.margin, roi: p.roi, profitMo: d.ourMo != null ? p.profit * d.ourMo : null } : null;
  }
  const p0 = profitFor(null, k, other);
  return { found: true, asin: best.asin, title: k.title || best.title || '', brand: k.brand || best.brand || '', image: k.image || null,
    others: ok.length - 1, otherAsins: ok.filter(l => l !== best).map(l => l.asin),
    price: p0.price, referral: p0.referral, referralPct: p0.referralPct, refEst: p0.refEst, fba: p0.fba,
    perMo: d.perMo, perMoEst: d.perMoEst, sellers: d.sellers, ourMo: d.ourMo,
    amazonSelling: !!k.amazonSelling, rank: k.salesRank, pack: packOf(k.title || best.title), byCost };
}

module.exports = { readXlsx, readDelimited, parseTable, readPriceList, normUpc, listingPrice, fees, profitFor, demandOf, packOf, scoreRow };
