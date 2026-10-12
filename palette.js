// Search everything (owner's #5): one box, opened with ⌘K / Ctrl+K anywhere,
// "/" when not typing (On Hand's new look keeps "/" for its own search), or
// the Search button in the header. Finds products (name, ASIN, SKU, FNSKU,
// a scanned barcode), FBA shipments, app-made shipment plans, Cosmoprof
// invoices and the app's screens, and jumps straight there.
//
// Its own file like onhand2.js; works in both looks. Results come from
// /api/search (warehouse login, no money). Jumping only navigates: it calls
// the same functions the screens' own buttons call (showTab, showSubTab,
// prodLoad via _prodGoto, nsPlan, loadInvoice), so nothing changes stock.
(function () {
  'use strict';
  const K = { ink: '#0b1f24', ink2: '#45545f', muted: '#7d8b97', line: '#e3e9ee', line2: '#eef2f5', brand: '#0d4450', amz: '#ff9900', sel: '#eef6f8' };
  const E = s => (typeof esc === 'function' ? esc(String(s == null ? '' : s)) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

  const CSS = `
  .pal-back{position:fixed;inset:0;z-index:1000;background:rgba(11,31,36,.42);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);display:flex;justify-content:center;align-items:flex-start;padding:10vh 16px 16px;animation:palf .14s ease-out}
  @keyframes palf{from{opacity:0}to{opacity:1}}
  @keyframes palin{from{opacity:0;transform:translateY(-6px) scale(.985)}to{opacity:1;transform:none}}
  .pal{width:100%;max-width:680px;background:#fff;border-radius:16px;box-shadow:0 30px 80px -20px rgba(11,31,36,.55),0 0 0 1px rgba(11,31,36,.06);overflow:hidden;color:${K.ink};font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;animation:palin .16s ease-out;display:flex;flex-direction:column;max-height:76vh}
  .pal-in{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid ${K.line}}
  .pal-in svg{width:20px;height:20px;color:${K.muted};flex:0 0 auto}
  .pal-in input{all:unset;flex:1;font-size:17px;font-weight:600;color:${K.ink};min-width:0}
  .pal-in input::placeholder{color:#a3afb9;font-weight:500}
  .pal-in .spin{width:16px;height:16px;border:2px solid ${K.line};border-top-color:${K.brand};border-radius:50%;animation:palsp .7s linear infinite;visibility:hidden}
  .pal-in .spin.on{visibility:visible}
  @keyframes palsp{to{transform:rotate(360deg)}}
  .pal kbd{font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:${K.muted};border:1px solid ${K.line};border-bottom-width:2px;border-radius:5px;padding:3px 6px;background:#fff}
  .pal-list{overflow-y:auto;padding:6px 0 8px;overscroll-behavior:contain}
  .pal-sec{font-size:11px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:${K.muted};padding:12px 18px 6px}
  .pal-it{display:flex;align-items:center;gap:12px;padding:9px 18px;cursor:pointer;border-left:3px solid transparent}
  .pal-it.on{background:${K.sel};border-left-color:${K.amz}}
  .pal-ic{width:36px;height:36px;border-radius:10px;background:#f3f6f8;border:1px solid ${K.line2};display:grid;place-items:center;flex:0 0 auto;overflow:hidden;font-size:16px;color:${K.brand}}
  .pal-ic img{width:100%;height:100%;object-fit:contain;background:#fff}
  .pal-ic svg{width:18px;height:18px}
  .pal-tx{min-width:0;flex:1}
  .pal-t{font-size:14px;font-weight:700;line-height:1.3;display:flex;align-items:center;gap:7px;min-width:0}
  .pal-t .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
  .pal-t .sz{flex:0 0 auto;font-size:11px;font-weight:800;color:#fff;background:${K.brand};border-radius:999px;padding:2px 7px}
  .pal-s{font-size:12px;color:${K.ink2};margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pal-s b{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:700;color:${K.ink}}
  .pal-r{flex:0 0 auto;text-align:right;font-size:12px;color:${K.muted};white-space:nowrap}
  .pal-r b{display:block;font-size:15px;font-weight:800;color:${K.ink}}
  .pal-r b.zero{color:#b42d2d}
  .pal-go{flex:0 0 auto;color:${K.muted};font-size:12px;font-weight:700;opacity:0}
  .pal-it.on .pal-go{opacity:1}
  .pal-emp{padding:34px 18px 30px;text-align:center;color:${K.ink2};font-size:14px}
  .pal-emp b{display:block;color:${K.ink};font-size:15px;margin-bottom:4px}
  .pal-foot{display:flex;gap:16px;align-items:center;padding:10px 18px;border-top:1px solid ${K.line};background:#fafcfd;font-size:12px;color:${K.muted};flex-wrap:wrap}
  .pal-foot span{display:inline-flex;align-items:center;gap:5px}
  .pal mark{background:#fff1d6;color:inherit;border-radius:3px;padding:0 1px}
  @media (max-width:640px){.pal-back{padding:0}.pal{max-width:none;border-radius:0;max-height:100vh;height:100%}.pal-foot{display:none}.pal-go{display:none}}
  @media (prefers-reduced-motion:reduce){.pal-back,.pal{animation:none}}
  .pal-btn{display:inline-flex;align-items:center;gap:8px}
  .pal-btn kbd{font:600 10.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid rgba(255,255,255,.25);border-radius:4px;padding:2px 5px;opacity:.85}
  `;
  const ICO = {
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>',
    truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h11v9H3z"/><path d="M14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/></svg>',
    plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6M8 4H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/><path d="M8 12h8M8 16h5"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>',
    screen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  };

  // The app's screens. Admin ones only once Admin is unlocked on this device.
  const SCREENS = [
    ['pendingprep', 'Pending Prep', 'prep jobs work orders crew start'],
    ['prep', 'Prepped & Ready', 'scan fnsku labels staged'],
    ['prod', 'Shipment Production', 'boxes 2d labels pallets new shipment freight'],
    ['ship', 'Ship to FBA', 'pack slip deduct plan tsv'],
    ['onhand', 'On Hand', 'stock inventory shelf available'],
    ['reconcile', 'Order Check-In', 'cosmoprof invoice receive'],
    ['receive', 'Receiving', 'scan upc manual'],
    ['log', 'Activity', 'prep performance history'],
    ['admin', 'Admin', 'owner dashboard'],
  ];
  const adminOpen = () => { try { return sessionStorage.getItem('adminUnlocked') === '1'; } catch (e) { return false; } };
  function adminScreens() {
    if (!adminOpen()) return [];
    return [...document.querySelectorAll('.subtab[data-sub]')].map(b => {
      const label = (b.childNodes[0] && b.childNodes[0].textContent || b.textContent).replace(/\s+/g, ' ').trim();
      return ['admin:' + b.dataset.sub, label, 'admin'];
    }).filter(x => x[1]);
  }

  let root = null, input, list, spin, items = [], cur = 0, timer = null, ctl = null, lastQ = '';

  function ensure() {
    if (root) return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    root = document.createElement('div'); root.className = 'pal-back'; root.style.display = 'none';
    root.innerHTML = '<div class="pal" role="dialog" aria-modal="true" aria-label="Search everything">'
      + '<div class="pal-in">' + ICO.search + '<input id="palQ" type="text" autocomplete="off" spellcheck="false" placeholder="Search products, ASIN, FNSKU, shipments, invoices, screens…" aria-label="Search"><span class="spin"></span><kbd>esc</kbd></div>'
      + '<div class="pal-list" id="palList" role="listbox"></div>'
      + '<div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>enter</kbd> open</span><span><kbd>esc</kbd> close</span><span style="margin-left:auto">Scan a barcode here too</span></div></div>';
    document.body.appendChild(root);
    input = root.querySelector('#palQ'); list = root.querySelector('#palList'); spin = root.querySelector('.spin');
    root.addEventListener('mousedown', e => { if (e.target === root) close(); });
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(query, 140); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); if (input.value.trim() !== lastQ) query().then(() => pick(cur)); else pick(cur); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    list.addEventListener('mousemove', e => { const it = e.target.closest('.pal-it'); if (it) setCur(+it.dataset.i, false); });
    list.addEventListener('click', e => { const it = e.target.closest('.pal-it'); if (it) pick(+it.dataset.i); });
  }

  function open(prefill) {
    ensure();
    root.style.display = 'flex';
    input.value = prefill || ''; lastQ = null;
    // focus now, not on the next tick: keys typed right after ⌘K were lost
    input.focus();
    render(input.value.trim() ? null : home());
    if (input.value.trim()) query();
  }
  function close() { if (root) root.style.display = 'none'; if (ctl) ctl.abort(); }
  const isOpen = () => !!root && root.style.display !== 'none';

  // Empty box: recent picks, then the screens.
  function home() {
    const out = [];
    let rec = []; try { rec = JSON.parse(store.get('palRecent') || '[]'); } catch (e) {}
    if (rec.length) out.push({ sec: 'Recent' }, ...rec.slice(0, 5).map(r => Object.assign({}, r, { recent: true })));
    // the floor's screens; Admin's 25 show up as soon as you type
    out.push({ sec: 'Jump to' }, ...SCREENS.map(screenItem));
    return out;
  }
  const screenItem = s => ({ type: 'screen', id: s[0], title: s[1], sub: s[0].startsWith('admin:') ? 'Admin' : 'Screen' });

  function hl(text, q) {
    const t = String(text || ''); if (!q) return E(t);
    const words = q.split(/\s+/).filter(w => w.length > 1).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!words.length) return E(t);
    const re = new RegExp('(' + words.join('|') + ')', 'ig');
    return t.split(re).map((part, i) => i % 2 ? '<mark>' + E(part) + '</mark>' : E(part)).join('');
  }

  async function query() {
    const q = input.value.trim(); lastQ = q;
    if (!q) { render(home()); return; }
    const ql = q.toLowerCase();
    const scr = SCREENS.concat(adminScreens()).filter(s => (s[1] + ' ' + s[2]).toLowerCase().includes(ql)).slice(0, 5).map(screenItem);
    if (q.length < 2) { render(scr.length ? [{ sec: 'Screens' }, ...scr] : []); return; }
    if (ctl) ctl.abort(); ctl = ('AbortController' in window) ? new AbortController() : null;
    spin.classList.add('on');
    let d;
    try {
      d = await api('/api/search?q=' + encodeURIComponent(q), { signal: ctl ? ctl.signal : undefined });
    } catch (e) { if (e && e.name === 'AbortError') return; d = { ok: false, error: e.message }; }
    finally { if (q === input.value.trim()) spin.classList.remove('on'); }
    if (q !== input.value.trim()) return; // a newer search is on its way
    if (!d || d.ok === false) { render([{ sec: 'Search' }, { type: 'err', title: 'Search failed', sub: (d && d.error) || 'No reply' }]); return; }
    const out = [];
    if (d.products.length) out.push({ sec: 'Products' }, ...d.products.map(p => ({ type: 'product', p })));
    if (d.shipments.length) out.push({ sec: 'Shipments' }, ...d.shipments.map(s => ({ type: 'shipment', s })));
    if (d.plans.length) out.push({ sec: 'Shipment plans' }, ...d.plans.map(p => ({ type: 'plan', p })));
    if (d.invoices.length) out.push({ sec: 'Cosmoprof invoices' }, ...d.invoices.map(v => ({ type: 'invoice', v })));
    if (scr.length) out.push({ sec: 'Screens' }, ...scr);
    render(out, q);
  }

  function row(it, i, q) {
    const go = '<span class="pal-go">Open ↵</span>';
    if (it.type === 'product') {
      const p = it.p, sz = typeof listingSize === 'function' ? listingSize(p.name) : '';
      const img = p.image ? '<img src="' + E(p.image) + '" alt="" loading="lazy" onerror="this.replaceWith(document.createRange().createContextualFragment(window.Palette.box))">' : ICO.box;
      return '<div class="pal-it" role="option" data-i="' + i + '"><div class="pal-ic">' + img + '</div><div class="pal-tx">'
        + '<div class="pal-t"><span class="nm" title="' + E(p.name) + '">' + hl(p.name || p.asin, q) + '</span>' + (sz ? '<span class="sz">' + E(sz) + '</span>' : '') + '</div>'
        + '<div class="pal-s">ASIN <b>' + hl(p.asin, q) + '</b>' + (p.sku ? ' · SKU <b>' + hl(p.sku, q) + '</b>' : '') + (p.fnsku ? ' · FNSKU <b>' + hl(p.fnsku, q) + '</b>' : '') + '</div></div>'
        + '<div class="pal-r"><b class="' + (p.onhand > 0 ? '' : 'zero') + '">' + Number(p.onhand || 0).toLocaleString() + '</b>' + (p.location ? '📍 ' + E(p.location) : 'on the shelf') + '</div>' + go + '</div>';
    }
    if (it.type === 'shipment') {
      const s = it.s;
      return '<div class="pal-it" role="option" data-i="' + i + '"><div class="pal-ic">' + ICO.truck + '</div><div class="pal-tx">'
        + '<div class="pal-t"><span class="nm" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace">' + hl(s.id, q) + '</span></div>'
        + '<div class="pal-s">' + hl(s.name || '', q) + (s.name ? ' · ' : '') + E(String(s.status || '').replace(/_/g, ' ')) + '</div></div>'
        + '<div class="pal-r">' + (s.pack ? 'Shipment Production' : 'On the way') + '</div>' + go + '</div>';
    }
    if (it.type === 'plan') {
      const p = it.p;
      return '<div class="pal-it" role="option" data-i="' + i + '"><div class="pal-ic">' + ICO.plan + '</div><div class="pal-tx">'
        + '<div class="pal-t"><span class="nm">' + hl(p.name || ('Plan ' + p.id), q) + '</span></div><div class="pal-s">New shipment · ' + E(p.status) + '</div></div>' + go + '</div>';
    }
    if (it.type === 'invoice') {
      const v = it.v;
      return '<div class="pal-it" role="option" data-i="' + i + '"><div class="pal-ic">' + ICO.doc + '</div><div class="pal-tx">'
        + '<div class="pal-t"><span class="nm">Invoice #' + hl(v.order_number, q) + '</span></div><div class="pal-s">' + E(v.invoice_date || '') + ' · ' + (v.status === 'pending' ? 'waiting to check in' : 'checked in') + '</div></div>' + go + '</div>';
    }
    if (it.type === 'err') return '<div class="pal-emp"><b>' + E(it.title) + '</b>' + E(it.sub) + '</div>';
    // screen (also used for recent picks)
    return '<div class="pal-it" role="option" data-i="' + i + '"><div class="pal-ic">' + (it.recent ? ICO.clock : ICO.screen) + '</div><div class="pal-tx">'
      + '<div class="pal-t"><span class="nm">' + hl(it.title, q) + '</span></div><div class="pal-s">' + E(it.sub || '') + '</div></div>' + go + '</div>';
  }

  function render(out, q) {
    items = []; let h = '';
    (out || []).forEach(it => {
      if (it.sec) { h += '<div class="pal-sec">' + E(it.sec) + '</div>'; return; }
      if (it.type === 'err') { h += row(it, -1, q); return; }
      h += row(it, items.length, q); items.push(it);
    });
    if (!items.length && !h) h = '<div class="pal-emp"><b>Nothing found for “' + E(input.value.trim()) + '”</b>Try part of the name, the ASIN, SKU or FNSKU, a shipment ID, or a Cosmoprof order #.</div>';
    list.innerHTML = h; cur = 0; setCur(0, true);
  }
  function setCur(i, scroll) {
    cur = Math.max(0, Math.min(items.length - 1, i));
    list.querySelectorAll('.pal-it').forEach(el => el.classList.toggle('on', +el.dataset.i === cur));
    if (scroll) { const el = list.querySelector('.pal-it.on'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); }
  }
  function move(d) { if (items.length) setCur((cur + d + items.length) % items.length, true); }

  function remember(it) {
    let r = { type: 'screen' };
    if (it.type === 'product') r = { type: 'product', p: it.p, title: it.p.name, sub: 'Product · ' + it.p.asin };
    else if (it.type === 'shipment') r = { type: 'shipment', s: it.s, title: it.s.id, sub: 'Shipment' + (it.s.name ? ' · ' + it.s.name : '') };
    else if (it.type === 'plan') r = { type: 'plan', p: it.p, title: it.p.name || ('Plan ' + it.p.id), sub: 'New shipment' };
    else if (it.type === 'invoice') r = { type: 'invoice', v: it.v, title: 'Invoice #' + it.v.order_number, sub: 'Cosmoprof invoice' };
    else r = { type: 'screen', id: it.id, title: it.title, sub: it.sub };
    let rec = []; try { rec = JSON.parse(store.get('palRecent') || '[]'); } catch (e) {}
    const key = x => x.type + ':' + (x.id || (x.p && (x.p.asin || x.p.id)) || (x.s && x.s.id) || (x.v && x.v.order_number));
    rec = [r].concat(rec.filter(x => key(x) !== key(r))).slice(0, 6);
    store.set('palRecent', JSON.stringify(rec));
  }

  // ---- jumping (navigation only) ----
  function tab(id) {
    const b = [...document.querySelectorAll('.tab')].find(x => (x.getAttribute('onclick') || '').includes("'" + id + "'"));
    if (b) b.click();
    window.scrollTo({ top: 0 });
  }
  function pick(i) {
    const it = items[i]; if (!it) return;
    close(); remember(it);
    if (it.type === 'screen') {
      if (it.id.startsWith('admin:')) {
        tab('admin');
        const sub = it.id.slice(6), b = document.querySelector('.subtab[data-sub="' + sub + '"]');
        if (b && document.getElementById('adminContent') && document.getElementById('adminContent').style.display !== 'none') b.click();
      } else tab(it.id);
      return;
    }
    if (it.type === 'product') {
      const p = it.p;
      tab('onhand');
      const f = document.getElementById('filterOnhand'); if (f) f.value = 'all';
      const src = document.getElementById('searchOnhand'); if (src) src.value = p.asin;
      const q = document.getElementById('oh2Q'); if (q) q.value = p.asin;
      if (typeof renderOnhand === 'function') setTimeout(() => renderOnhand(), 0);
      return;
    }
    if (it.type === 'shipment') {
      const s = it.s;
      if (s.pack) { window._prodGoto = { sid: s.id }; tab('prod'); return; }
      if (adminOpen() && document.querySelector('.subtab[data-sub="transit"]')) { tab('admin'); const b = document.querySelector('.subtab[data-sub="transit"]'); if (b) b.click(); return; }
      tab('prod'); setTimeout(() => { const el = document.getElementById('prodSidIn'); if (el) { el.value = s.id; el.focus(); } }, 400);
      return;
    }
    if (it.type === 'plan') { tab('prod'); if (typeof nsPlan === 'function') setTimeout(() => nsPlan(it.p.id), 50); return; }
    if (it.type === 'invoice') {
      const v = it.v; tab('reconcile');
      const sel = document.getElementById('invoicePick');
      const done = () => {
        if (!sel) return;
        sel.value = v.order_number;
        if (sel.value === v.order_number && typeof loadInvoice === 'function') { loadInvoice(); sel.scrollIntoView({ block: 'center' }); }
        else if (typeof toast === 'function') toast('Invoice #' + v.order_number + ' is already checked in');
      };
      if (typeof loadInvoiceList === 'function') Promise.resolve(loadInvoiceList()).then(done, done); else done();
    }
  }

  // ---- keys + header button ----
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      if (!document.getElementById('mainApp') || document.getElementById('mainApp').style.display === 'none') return; // not logged in
      e.preventDefault(); isOpen() ? close() : open(); return;
    }
    if (e.key === '/' && !isOpen()) {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const oh = document.getElementById('onhand');
      if (oh && oh.classList.contains('active') && oh.classList.contains('oh2')) return; // On Hand's own search
      if (!document.getElementById('mainApp') || document.getElementById('mainApp').style.display === 'none') return;
      e.preventDefault(); open();
    }
  });
  function addButton() {
    const sub = document.querySelector('header .sub'); if (!sub || document.getElementById('palBtn')) return;
    const b = document.createElement('button');
    b.id = 'palBtn'; b.type = 'button'; b.className = 'pal-btn';
    b.title = 'Search everything (' + (IS_MAC ? '⌘K' : 'Ctrl+K') + ')';
    b.setAttribute('style', 'margin-left:10px;padding:3px 10px;font-size:11px;border:none;border-radius:10px;background:#0d4450;color:#fff;cursor:pointer;font-weight:700');
    b.innerHTML = '🔍 Search <kbd>' + (IS_MAC ? '⌘K' : 'Ctrl K') + '</kbd>';
    b.addEventListener('click', () => open());
    sub.insertBefore(b, sub.querySelector('button'));
    if (!document.querySelector('style[data-pal]')) { const st = document.createElement('style'); st.setAttribute('data-pal', '1'); st.textContent = '.pal-btn kbd{font:600 10.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid rgba(255,255,255,.25);border-radius:4px;padding:2px 5px;opacity:.85;margin-left:4px}'; document.head.appendChild(st); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addButton); else addButton();

  window.Palette = { open, close, box: ICO.box };
})();
