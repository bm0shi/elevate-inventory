// Homebase timesheet CSV parsing. Pure.
// Moved out of server.js unchanged so it can be tested on its own
// (test/homebase.test.js).

// Minimal RFC4180-ish CSV line splitter (handles quoted fields with commas).
function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out.map(x => x.trim());
}

const HB_MONTHS = {january:0,february:1,march:2,april:3,may:4,june:5,july:6,
                   august:7,september:8,october:9,november:10,december:11,
                   jan:0,feb:1,mar:2,apr:3,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11};

// "August 31 2026" | "8/31/2026" | "2026-08-31"
function hbDate(str) {
  const t = String(str || '').trim();
  if (!t || t === '-') return null;
  let m = t.match(/^([A-Za-z]+)\s+(\d{1,2})\s*,?\s*(\d{4})$/);
  if (m && HB_MONTHS[m[1].toLowerCase()] != null) return { y:+m[3], mo:HB_MONTHS[m[1].toLowerCase()], d:+m[2] };
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return { y:+m[3], mo:+m[1]-1, d:+m[2] };
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { y:+m[1], mo:+m[2]-1, d:+m[3] };
  return null;
}

// "8:07am" | "8:07 AM" | "16:12"
function hbMinutes(str) {
  const t = String(str || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!t || t === '-') return null;
  let m = t.match(/^(\d{1,2}):(\d{2})(am|pm)$/);
  if (m) {
    let h = +m[1];
    if (m[3] === 'pm' && h !== 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    return h * 60 + (+m[2]);
  }
  m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return (+m[1]) * 60 + (+m[2]);
  return null;
}

function mkTs(dt, mins) {
  // Local wall-clock time as recorded by the time clock.
  const d = new Date(dt.y, dt.mo, dt.d, Math.floor(mins/60), mins % 60, 0);
  return d;
}

// Parse the Homebase CSV export into shift rows.
function parseHomebaseCsv(text) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [], warnings = [];
  let cols = null;

  const idx = (name) => {
    if (!cols) return -1;
    const want = name.toLowerCase();
    return cols.findIndex(c => c.toLowerCase() === want);
  };

  for (const raw of lines) {
    if (!raw || !raw.trim()) continue;
    const f = splitCsvLine(raw);
    const first = (f[0] || '').trim();

    // repeated header block before each employee
    if (/^name$/i.test(first) && f.some(x => /clock in/i.test(x))) { cols = f; continue; }
    if (!cols) continue;
    if (!first || first === '-' || /^totals/i.test(first) || /^payroll period/i.test(first)) continue;

    const ciD = hbDate(f[idx('Clock in date')]);
    const ciT = hbMinutes(f[idx('Clock in time')]);
    const coD = hbDate(f[idx('Clock out date')]);
    const coT = hbMinutes(f[idx('Clock out time')]);
    // employee heading rows have a name but no punch — skip quietly
    if (!ciD || ciT == null || !coD || coT == null) continue;

    const inTs = mkTs(ciD, ciT);
    let outTs = mkTs(coD, coT);
    if (outTs <= inTs) { outTs = new Date(outTs.getTime() + 24*3600*1000); } // crossed midnight

    const num = (v) => { const n = parseFloat(String(v || '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
    const brk = num(f[idx('Break length')]) || 0;

    rows.push({
      homebase_name: first,
      work_date: `${ciD.y}-${String(ciD.mo+1).padStart(2,'0')}-${String(ciD.d).padStart(2,'0')}`,
      clock_in: inTs, clock_out: outTs,
      break_minutes: Math.round(brk > 12 ? brk : brk * 60), // minutes or decimal hours
      wage: num(f[idx('Wage rate')]),
      actual_hours: num(f[idx('Actual hours')]),
      paid_hours: num(f[idx('Total paid hours')]),
      ot_hours: num(f[idx('OT hours')])
    });
  }
  if (!cols) warnings.push('No Homebase header row found — is this the timesheets CSV export?');
  return { rows, warnings };
}

module.exports = { splitCsvLine, HB_MONTHS, hbDate, hbMinutes, mkTs, parseHomebaseCsv };
