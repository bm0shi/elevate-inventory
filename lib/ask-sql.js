// Ask Elevate's database tool: Claude writes a SELECT, this decides whether it
// may run. The real protection is server-side (owner login, a READ ONLY
// transaction, a statement timeout, a row cap); this check refuses the rest
// early with a reason Claude can act on.

const BLOCKED = /\b(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|lo_get|dblink\w*|pg_sleep\w*|set_config|pg_terminate_backend|pg_cancel_backend|copy)\b/i;

function checkSql(sql) {
  let s = String(sql || '').trim();
  if (!s) return { ok: false, error: 'Empty query.' };
  if (/--|\/\*/.test(s)) return { ok: false, error: 'No comments in the query, please.' };
  s = s.replace(/;\s*$/, '');
  // a ; outside a quoted string means a second statement
  const unquoted = s.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  if (unquoted.includes(';')) return { ok: false, error: 'One statement at a time.' };
  if (!/^(select|with)\b/i.test(s)) return { ok: false, error: 'Only SELECT (or WITH … SELECT) queries can run.' };
  if (BLOCKED.test(unquoted)) return { ok: false, error: 'That function is not allowed here.' };
  return { ok: true, sql: s };
}

// Cap the rows without touching the query itself.
const wrapLimit = (sql, n) => `SELECT * FROM (${sql}) AS q LIMIT ${Math.max(1, Math.min(1000, n | 0))}`;

// Rows to compact text for the model: JSON lines, numbers rounded, cut at maxChars.
function rowsText(rows, maxChars = 30000) {
  const out = [];
  let len = 0;
  for (const r of rows) {
    const o = {};
    for (const [k, v] of Object.entries(r)) {
      if (v instanceof Date) o[k] = v.toISOString().slice(0, v.getUTCHours() || v.getUTCMinutes() ? 16 : 10);
      else if (typeof v === 'number' && !Number.isInteger(v)) o[k] = Math.round(v * 100) / 100;
      else if (typeof v === 'string' && /^-?\d+\.\d{3,}$/.test(v)) o[k] = Math.round(Number(v) * 100) / 100;
      else o[k] = v;
    }
    const line = JSON.stringify(o);
    if (len + line.length > maxChars) { out.push(`… ${rows.length - out.length} more rows cut`); break; }
    out.push(line); len += line.length + 1;
  }
  return out.join('\n');
}

module.exports = { checkSql, wrapLimit, rowsText };
