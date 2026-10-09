// On Hand — the new look (owner: "premium, polished, production ready";
// Classic stays one click away). Its own file, like dash2.js: the classic
// screen in index.html is untouched, and renderOnhand still does all the
// filtering and sorting; this only draws. Every action calls the same
// function as before (requestPrep, ohAdjust, editLocation, setCaseQty,
// copyText, amazonCheck, syncFba, pullImages, addProduct), so nothing about
// how stock moves changes.
//
// Design system (scoped under .oh2):
//   ink #0b1f24 / ink-2 #45545f / muted #7d8b97 on surface #fff, page #f4f7f9,
//   sunken #f6f9fb; hairlines #e3e9ee / #eef2f5. Brand teal #0d4450 for
//   chrome and secondary buttons; Amazon orange #ff9900 (dark text, 9:1) for
//   the one primary action per card (Prep). Status only for status: good
//   #0b7a0b, warn #a86b00, critical #b42d2d, each on its own tint, always with
//   an icon or word. Stock colors match the dashboard: shelf blue, pending
//   orange, prepped aqua, transit yellow, Amazon magenta.
//   Type: system sans; 11px caps labels, 12.5 meta, 14 body, 15.5 names,
//   30 the Available number. Radius 14 cards / 10 controls / 999 pills.
(function () {
  'use strict';
  const K = { ink: '#0b1f24', ink2: '#45545f', muted: '#7d8b97', line: '#e3e9ee', line2: '#eef2f5', brand: '#0d4450', amz: '#ff9900',
              good: '#0b7a0b', goodBg: '#e8f6ea', warn: '#a86b00', warnBg: '#fff4dc', crit: '#b42d2d', critBg: '#fdecec', info: '#1f5fae', infoBg: '#e8f1fc',
              shelf: '#2a78d6', pend: '#eb6834', prep: '#1baf7a', way: '#eda100', fba: '#e87ba4' };
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  const E = s => (typeof esc === 'function' ? esc(String(s == null ? '' : s)) : String(s == null ? '' : s));
  const n0 = v => Math.round(v || 0).toLocaleString();
  const q1 = s => String(s).replace(/'/g, "\\'");

  const CSS = `
  .oh2{color:${K.ink}}
  .oh2 *{box-sizing:border-box}
  .oh2-head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin:2px 2px 14px}
  .oh2-head h2{margin:0;font-size:24px;font-weight:800;letter-spacing:-.3px}
  .oh2-head p{margin:3px 0 0;color:${K.ink2};font-size:13px}
  .oh2-acts{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .oh-btn{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;font-size:13px;font-weight:750;border-radius:10px;padding:9px 14px;line-height:1.1;white-space:nowrap;transition:transform .15s,box-shadow .2s,background .2s,border-color .2s}
  .oh-btn:focus-visible{outline:2px solid ${K.brand};outline-offset:2px}
  .oh-btn.primary{background:${K.amz};color:#131921;box-shadow:0 4px 14px -6px rgba(255,153,0,.8)}
  .oh-btn.primary:hover{background:#ffad33;transform:translateY(-1px)}
  .oh-btn.secondary{background:${K.brand};color:#fff;box-shadow:0 4px 14px -6px rgba(13,68,80,.7)}
  .oh-btn.secondary:hover{background:#145c6c;transform:translateY(-1px)}
  .oh-btn.ghost{background:#fff;color:${K.brand};border:1px solid ${K.line}}
  .oh-btn.ghost:hover{border-color:#c6d4dc;background:#fbfdfe}
  .oh-btn.quiet{color:${K.ink2};padding:7px 10px;font-weight:700}
  .oh-btn.quiet:hover{background:#f1f5f8;color:${K.ink}}
  .oh-btn.sm{font-size:12px;padding:7px 11px;border-radius:9px}
  .oh-btn[disabled]{opacity:.55;pointer-events:none}
  .oh2-pill{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:700;border-radius:999px;padding:7px 12px;background:#fff;border:1px solid ${K.line};color:${K.ink2};cursor:pointer}
  .oh2-pill i{width:8px;height:8px;border-radius:50%;background:${K.good}}
  .oh2-pill.warn{border-color:#f1d9a6;background:${K.warnBg};color:${K.warn}}.oh2-pill.warn i{background:${K.warn}}
  .oh2-pill.run i{background:${K.info};animation:ohp 1.2s infinite}
  @keyframes ohp{0%,100%{opacity:1}50%{opacity:.3}}
  .oh2-syncbox{display:none;margin:-6px 0 14px;background:#fff;border:1px solid ${K.line};border-radius:12px;padding:12px 14px;font-size:12.5px;color:${K.ink2}}
  .oh2-syncbox.on{display:block}
  .oh2-tiles{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:12px;margin-bottom:14px}
  .oh2-tile{all:unset;box-sizing:border-box;cursor:pointer;background:#fff;border:1px solid ${K.line};border-radius:14px;padding:13px 15px;box-shadow:0 1px 2px rgba(16,24,40,.04);transition:transform .2s,box-shadow .2s,border-color .2s;min-width:0;position:relative;overflow:hidden}
  .oh2-tile::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--c,${K.line})}
  .oh2-tile:hover{transform:translateY(-1px);border-color:#c6d4dc;box-shadow:0 14px 28px -20px rgba(16,24,40,.35)}
  .oh2-tile.on{border-color:${K.brand};box-shadow:0 0 0 3px rgba(13,68,80,.08)}
  .oh2-tile .l{font-size:11.5px;font-weight:750;color:${K.ink2};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .oh2-tile .v{font-size:24px;font-weight:850;letter-spacing:-.5px;margin-top:4px;font-variant-numeric:normal}
  .oh2-tile .s{font-size:11px;color:${K.muted};margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .oh2-bar{position:sticky;top:var(--ohtop,0px);z-index:5;display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:rgba(244,247,249,.92);backdrop-filter:saturate(1.4) blur(8px);-webkit-backdrop-filter:saturate(1.4) blur(8px);padding:10px 0;margin-bottom:12px;border-bottom:1px solid transparent}
  .oh2-bar.stuck{border-bottom-color:${K.line}}
  .oh2-search{position:relative;flex:1 1 260px;min-width:200px}
  .oh2-search input{width:100%;font:inherit;font-size:14px;padding:11px 36px 11px 38px;border:1px solid ${K.line};border-radius:10px;background:#fff;color:${K.ink};outline:none;transition:border-color .2s,box-shadow .2s}
  .oh2-search input:focus{border-color:${K.brand};box-shadow:0 0 0 3px rgba(13,68,80,.1)}
  .oh2-search svg{position:absolute;left:12px;top:50%;width:16px;height:16px;transform:translateY(-50%);color:${K.muted}}
  .oh2-search kbd{position:absolute;right:10px;top:50%;transform:translateY(-50%);font:600 11px/1 ui-monospace,monospace;color:${K.muted};border:1px solid ${K.line};border-bottom-width:2px;border-radius:5px;padding:3px 6px;background:#fff}
  .oh2-chips{display:flex;gap:6px;flex-wrap:wrap}
  .oh2-chip{all:unset;cursor:pointer;font-size:12.5px;font-weight:700;color:${K.ink2};background:#fff;border:1px solid ${K.line};border-radius:999px;padding:7px 12px;white-space:nowrap;transition:all .15s}
  .oh2-chip:hover{border-color:#c6d4dc;color:${K.ink}}
  .oh2-chip.on{background:${K.brand};border-color:${K.brand};color:#fff}
  .oh2-sel{font:inherit;font-size:13px;font-weight:650;color:${K.ink};padding:10px 12px;border:1px solid ${K.line};border-radius:10px;background:#fff;max-width:240px}
  .oh2-seg{display:inline-flex;background:#e9eff3;border-radius:10px;padding:3px}
  .oh2-seg button{all:unset;cursor:pointer;font-size:12.5px;font-weight:750;color:${K.ink2};padding:7px 12px;border-radius:8px}
  .oh2-seg button.on{background:#fff;color:${K.ink};box-shadow:0 1px 2px rgba(16,24,40,.12)}
  .oh2-count{font-size:12px;color:${K.muted};margin:0 2px 10px}
  .oh2-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
  .oh2-card{background:#fff;border:1px solid ${K.line};border-radius:14px;box-shadow:0 1px 2px rgba(16,24,40,.04);padding:16px 16px 12px;min-width:0;display:flex;flex-direction:column;gap:12px;transition:box-shadow .2s,border-color .2s;animation:ohin .45s cubic-bezier(.2,.7,.2,1) both;animation-delay:var(--d,0ms)}
  .oh2-grid.still .oh2-card{animation:none}
  .oh2-card:hover{border-color:#d3dde4;box-shadow:0 16px 32px -22px rgba(16,24,40,.35)}
  @keyframes ohin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  .oh2-top{display:grid;grid-template-columns:64px minmax(0,1fr) auto;gap:14px;align-items:start}
  .oh2-img{width:64px;height:64px;border-radius:12px;background:#f3f6f8;display:grid;place-items:center;overflow:hidden;border:1px solid ${K.line2}}
  .oh2-img img{width:100%;height:100%;object-fit:contain;background:#fff;cursor:zoom-in}
  .oh2-img span{font-size:24px;opacity:.55}
  .oh2-name{font-size:15.5px;font-weight:750;line-height:1.35}
  .oh2-name a{color:${K.ink}!important;border-bottom:0!important;font-weight:750!important}
  .oh2-name a:hover{color:${K.brand}!important}
  .oh2-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
  .oh2-tag{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700;border-radius:8px;padding:4px 8px;background:#f3f6f8;color:${K.ink2};border:1px solid ${K.line2};cursor:pointer;white-space:nowrap}
  .oh2-tag:hover{border-color:#c6d4dc;color:${K.ink}}
  .oh2-tag b{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:750;color:${K.ink};letter-spacing:.2px}
  .oh2-tag.loc b{font-family:inherit}
  .oh2-tag.loc.none{background:${K.critBg};border-color:#f5cccc;color:${K.crit}}
  .oh2-tag.duo{background:#fff1f6;border-color:#f6d3e1;color:#a3305d;cursor:default}
  .oh2-av{text-align:right;min-width:92px}
  .oh2-av .n{font-size:30px;font-weight:850;letter-spacing:-.8px;line-height:1}
  .oh2-av .n.zero{color:${K.crit}}
  .oh2-av .l{font-size:10.5px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${K.muted};margin-top:4px}
  .oh2-av .c{display:inline-block;margin-top:6px;font-size:12px;font-weight:750;color:${K.brand};cursor:pointer;white-space:nowrap}
  .oh2-av .c small{display:block;font-size:10.5px;font-weight:600;color:${K.muted}}
  .oh2-stock{display:flex;height:8px;border-radius:999px;overflow:hidden;gap:2px;background:#fff}
  .oh2-stock i{display:block;height:100%}
  .oh2-stock.empty{background:#eef2f5}
  .oh2-stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));border:1px solid ${K.line2};border-radius:12px;background:#f8fafb;overflow:hidden}
  .oh2-st{padding:9px 6px 8px;text-align:center;border-left:1px solid ${K.line2};min-width:0}
  .oh2-st:first-child{border-left:0}
  .oh2-st .k{display:flex;align-items:center;justify-content:center;gap:5px;font-size:10.5px;font-weight:750;color:${K.muted};white-space:nowrap}
  .oh2-st .k i{width:7px;height:7px;border-radius:2px}
  .oh2-st .v{font-size:15px;font-weight:800;margin-top:3px;white-space:nowrap}
  .oh2-st .v.dim{color:#a8b4be;font-weight:700}
  .oh2-st .x{font-size:10px;color:${K.muted};margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .oh2-badge{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:800;border-radius:999px;padding:2px 8px}
  .oh2-badge.good{background:${K.goodBg};color:${K.good}}.oh2-badge.warn{background:${K.warnBg};color:${K.warn}}.oh2-badge.crit{background:${K.critBg};color:${K.crit}}
  .oh2-alert{display:flex;gap:10px;align-items:flex-start;font-size:12.5px;border-radius:10px;padding:9px 11px;line-height:1.45}
  .oh2-alert.crit{background:${K.critBg};color:${K.crit}}.oh2-alert.warn{background:${K.warnBg};color:${K.warn}}
  .oh2-alert > div{min-width:0}
  .oh2-alert .shr{display:contents}
  .oh2-alert .shr > div{border:0!important;background:none!important;padding:0!important;margin:0!important;color:inherit!important}
  .oh2-more{border-top:1px solid ${K.line2};padding-top:2px}
  .oh2-more summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:750;color:${K.ink2};padding:8px 2px}
  .oh2-more summary::-webkit-details-marker{display:none}
  .oh2-more summary::before{content:"";width:7px;height:7px;border-right:2px solid ${K.muted};border-bottom:2px solid ${K.muted};transform:rotate(-45deg);transition:transform .2s;margin:0 3px 0 2px}
  .oh2-more[open] summary::before{transform:rotate(45deg)}
  .oh2-more summary .cnt{font-weight:650;color:${K.muted}}
  .oh2-duo{width:100%;border-collapse:collapse;font-size:12.5px;margin:2px 0 6px}
  .oh2-duo th{font-size:10.5px;font-weight:750;color:${K.muted};text-align:center;padding:4px 6px;white-space:nowrap}
  .oh2-duo th:first-child{text-align:left}
  .oh2-duo td{padding:7px 6px;border-top:1px solid ${K.line2};text-align:center;vertical-align:middle}
  .oh2-duo td:first-child{text-align:left}
  .oh2-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;font-weight:700;color:${K.info};cursor:pointer}
  .oh2-amz{margin:2px 0 6px}
  .oh2-amz > div{background:#f8fafb!important;border:1px solid ${K.line2};border-radius:12px!important;padding:8px 4px!important;margin:0!important}
  .oh2-foot{display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-top:1px solid ${K.line2};padding-top:10px;margin-top:-2px}
  .oh2-foot .sp{flex:1}
  .oh2-foot .meta{font-size:11.5px;color:${K.muted}}
  .oh2-tblwrap{background:#fff;border:1px solid ${K.line};border-radius:14px;overflow:auto;box-shadow:0 1px 2px rgba(16,24,40,.04);max-height:calc(100vh - 160px)}
  .oh2-tbl{width:100%;border-collapse:separate;border-spacing:0;font-size:13px;table-layout:fixed;min-width:1080px}
  .oh2-tbl th{position:sticky;top:0;z-index:1;background:#f6f9fb;font-size:11px;font-weight:800;letter-spacing:.3px;color:${K.ink2};text-align:center;padding:10px 8px;border-bottom:1px solid ${K.line};white-space:nowrap}
  .oh2-tbl th:first-child{text-align:left;padding-left:16px}
  .oh2-tbl td{padding:10px 8px;border-bottom:1px solid ${K.line2};text-align:center;font-variant-numeric:tabular-nums;vertical-align:middle}
  .oh2-tbl td:first-child{text-align:left;padding-left:16px}
  .oh2-tbl tr:hover td{background:#fafcfd}
  .oh2-tbl .big{font-size:16px;font-weight:850}
  .oh2-tbl .nm{display:flex;gap:10px;align-items:center;min-width:0}
  .oh2-tbl .nm img,.oh2-tbl .nm .ph{width:36px;height:36px;border-radius:8px;object-fit:contain;background:#f3f6f8;border:1px solid ${K.line2};flex:0 0 36px}
  .oh2-tbl .nm .t{min-width:0}
  .oh2-tbl .nm a{color:${K.ink}!important;border-bottom:0!important;font-weight:700!important}
  .oh2-empty{grid-column:1/-1;display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:48px 16px;background:#fff;border:1px dashed #d5e0e6;border-radius:14px}
  .oh2-empty .ill{width:60px;height:60px;border-radius:18px;background:linear-gradient(135deg,#f1f6f8,#e6eff3);display:grid;place-items:center;font-size:26px}
  .oh2-empty b{font-size:15px}.oh2-empty span{font-size:13px;color:${K.ink2};max-width:380px}
  .oh2-sk{background:linear-gradient(90deg,#eef2f5 25%,#f8fafb 37%,#eef2f5 63%);background-size:400% 100%;animation:ohsh 1.4s ease infinite;border-radius:8px}
  @keyframes ohsh{0%{background-position:100% 50%}100%{background-position:0 50%}}
  .oh2-classic-link{font-size:12px;font-weight:700;color:${K.muted};cursor:pointer;text-decoration:underline;text-underline-offset:3px}
  @media (max-width:1280px){.oh2-tiles{grid-template-columns:repeat(4,minmax(0,1fr))}}
  @media (max-width:1100px){.oh2-grid{grid-template-columns:1fr}}
  @media (max-width:760px){
    .oh2-tiles{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
    .oh2-tile .v{font-size:20px}
    .oh2-top{grid-template-columns:48px minmax(0,1fr)}
    .oh2-img{width:48px;height:48px;border-radius:10px}
    .oh2-av{grid-column:1/-1;display:flex;align-items:baseline;gap:10px;text-align:left}
    .oh2-av .l{margin:0}.oh2-av .c{margin:0 0 0 auto;text-align:right}
    .oh2-stats{grid-template-columns:repeat(3,minmax(0,1fr))}
    .oh2-st:nth-child(4){border-left:0}.oh2-st:nth-child(n+4){border-top:1px solid ${K.line2}}
    .oh2-bar{position:static}
    .oh2-search kbd{display:none}
    .oh2-chips{flex-wrap:nowrap;overflow-x:auto;width:100%;padding-bottom:2px;scrollbar-width:none}
    .oh2-chips::-webkit-scrollbar{display:none}
    .oh2-sel{flex:1;max-width:none}
  }
  @media (prefers-reduced-motion:reduce){.oh2 *{animation:none!important;transition:none!important}}
  `;
  function injectCss() { if (document.getElementById('oh2css')) return; const s = document.createElement('style'); s.id = 'oh2css'; s.textContent = CSS; document.head.appendChild(s); }

  const FILTERS = [['all', 'All'], ['instock', 'In stock'], ['lowstock', 'Low (1–20)'], ['outstock', 'Out of stock'], ['duoonly', 'Duo items'], ['duobuildable', 'Duos I can build'], ['sspicks', '⭐ Smart Scout picks']];
  const searchIco = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';

  // ---------- chrome: header, tiles, sticky toolbar ----------
  function chrome() {
    const top = document.getElementById('ohTop'); if (!top) return;
    if (top.dataset.built === '1') return;
    top.dataset.built = '1';
    const sortSrc = document.getElementById('sortOnhand');
    const sortOpts = sortSrc ? [...sortSrc.options].map(o => '<option value="' + E(o.value) + '">' + E(o.text) + '</option>').join('') : '';
    top.innerHTML =
      '<div class="oh2-head"><div><h2>On hand</h2><p>Every product on the shelf, in prep, on the way and at Amazon</p></div>' +
      '<div class="oh2-acts"><span class="oh2-pill" id="oh2Sync" title="Amazon sync — click for details"><i></i><span>Checking sync…</span></span>' +
      '<button class="oh-btn ghost sm" id="oh2Add">＋ Add product</button>' +
      '<button class="oh-btn ghost sm" id="oh2Img">Pull images</button>' +
      '<button class="oh-btn secondary sm" id="oh2SyncBtn">↻ Sync with Amazon</button>' +
      '<span class="oh2-classic-link" id="oh2Classic" title="Back to the classic On Hand screen">Classic view</span></div></div>' +
      '<div class="oh2-syncbox" id="oh2SyncBox"></div>' +
      '<div id="oh2AddWrap"></div>' +
      '<div class="oh2-tiles" id="oh2Tiles">' + [0, 1, 2, 3, 4, 5, 6].map(() => '<div class="oh2-tile" style="cursor:default">' + '<div class="oh2-sk" style="height:11px;width:60%"></div><div class="oh2-sk" style="height:22px;width:45%;margin-top:8px"></div></div>').join('') + '</div>' +
      '<div class="oh2-bar" id="oh2Bar"><div class="oh2-search">' + searchIco + '<input id="oh2Q" type="search" placeholder="Search name or ASIN" autocomplete="off"><kbd>/</kbd></div>' +
      '<div class="oh2-chips" id="oh2Chips">' + FILTERS.map(f => '<button class="oh2-chip" data-f="' + f[0] + '">' + f[1] + '</button>').join('') + '</div>' +
      '<select class="oh2-sel" id="oh2Sort" title="Sort">' + sortOpts + '</select>' +
      '<span class="oh2-seg" id="oh2Lay"><button data-lay="cards">Cards</button><button data-lay="table">Table</button></span></div>' +
      '<div class="oh2-count" id="oh2Count"></div>';
    // the classic "add product" box moves up here while the new look is on
    const box = document.getElementById('addProductBox'); if (box) document.getElementById('oh2AddWrap').appendChild(box);
    wire(top);
    syncPill();
    const ss = document.getElementById('syncStatus');
    if (ss && 'MutationObserver' in window) new MutationObserver(syncPill).observe(ss, { childList: true, subtree: true, characterData: true });
  }
  function wire(top) {
    const q = document.getElementById('oh2Q'), src = document.getElementById('searchOnhand');
    q.value = src ? src.value : '';
    q.addEventListener('input', () => { if (src) src.value = q.value; renderOnhand(); });
    document.addEventListener('keydown', e => {
      if (e.key !== '/' || !document.getElementById('onhand').classList.contains('active') || !document.getElementById('onhand').classList.contains('oh2')) return;
      const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      e.preventDefault(); q.focus(); q.select();
    });
    document.getElementById('oh2Chips').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (b) setFilter(b.dataset.f); });
    const sort = document.getElementById('oh2Sort'), sortSrc = document.getElementById('sortOnhand');
    if (sortSrc) sort.value = sortSrc.value;
    sort.addEventListener('change', () => { if (sortSrc) sortSrc.value = sort.value; renderOnhand(); });
    document.getElementById('oh2Lay').addEventListener('click', e => { const b = e.target.closest('[data-lay]'); if (!b) return; store.set('ohLayout', b.dataset.lay); renderOnhand(); });
    document.getElementById('oh2Tiles').addEventListener('click', e => { const t = e.target.closest('[data-go]'); if (t) tileGo(t.dataset.go); });
    document.getElementById('oh2Add').addEventListener('click', () => { if (typeof toggleAddProduct === 'function') toggleAddProduct(); });
    document.getElementById('oh2Img').addEventListener('click', () => { if (typeof pullImages === 'function') pullImages(); });
    document.getElementById('oh2SyncBtn').addEventListener('click', () => { if (typeof syncFba === 'function') syncFba(); });
    document.getElementById('oh2Sync').addEventListener('click', () => document.getElementById('oh2SyncBox').classList.toggle('on'));
    document.getElementById('oh2Classic').addEventListener('click', () => window.OH2.setOn(false));
    // the toolbar sticks under the app header; a hairline appears once it does
    const hd = document.querySelector('header');
    const bar = document.getElementById('oh2Bar');
    const topPx = (hd && getComputedStyle(hd).position === 'sticky') ? hd.offsetHeight : 0;
    bar.style.setProperty('--ohtop', topPx + 'px');
    window.addEventListener('scroll', () => { const r = bar.getBoundingClientRect(); bar.classList.toggle('stuck', r.top <= topPx + 1); }, { passive: true });
  }
  function setFilter(f) {
    const src = document.getElementById('filterOnhand'); if (src) src.value = f;
    renderOnhand();
  }
  function tileGo(go) {
    if (go === 'pendingprep' || go === 'prep') {
      const b = [...document.querySelectorAll('.tab')].find(t => (t.getAttribute('onclick') || '').indexOf("showTab('" + go + "'") >= 0);
      if (b && typeof showTab === 'function') { showTab(go, { currentTarget: b, target: b }); window.scrollTo({ top: 0, behavior: 'smooth' }); }
      return;
    }
    if (go === 'transit') { const s = document.getElementById('sortOnhand'); if (s) s.value = 'transit_desc'; const f = document.getElementById('filterOnhand'); if (f) f.value = 'all'; renderOnhand(); return; }
    setFilter(go);
  }
  // Sync status as a pill (the classic red wall of text, folded away).
  function syncPill() {
    const pill = document.getElementById('oh2Sync'), box = document.getElementById('oh2SyncBox'), ss = document.getElementById('syncStatus');
    if (!pill || !ss) return;
    const txt = ss.textContent || '';
    const running = /syncing|reading|step|…/i.test(txt) && !/last synced/i.test(txt);
    const bad = /ECONN|error|failed|refused|denied|timed out/i.test(txt);
    const ago = (txt.match(/\(([^)]*ago)\)/) || [])[1];
    pill.className = 'oh2-pill' + (running ? ' run' : bad ? ' warn' : '');
    pill.querySelector('span').textContent = running ? 'Syncing with Amazon…' : (bad ? 'Synced with problems' + (ago ? ' · ' + ago : '') : (ago ? 'Synced ' + ago : (txt.trim() ? 'Amazon sync' : 'Not synced yet')));
    box.innerHTML = ss.innerHTML || '<span>No sync has run yet.</span>';
  }

  // ---------- tiles ----------
  function paintTiles(filter) {
    const box = document.getElementById('oh2Tiles'); if (!box) return;
    let on = 0, pend = 0, prep = 0, way = 0, low = 0, out = 0, skus = 0;
    for (const x of (products || [])) {
      skus++;
      const o = x.onhand || 0;
      if (o > 0 && o <= 20) low++; if (o <= 0) out++;
      if (x.is_bundle) continue;   // components carry a duo's bottles already
      on += o; pend += x.pending_prep || 0; prep += x.prepped || 0; way += x.transit || 0;
    }
    const avail = Math.max(0, on - pend - prep);
    const T = [
      ['all', 'Products', n0(skus), 'tracked in the catalog', K.brand],
      ['instock', 'Available', n0(avail), 'of ' + n0(on) + ' on the shelf', K.shelf],
      ['pendingprep', 'Pending prep', n0(pend), 'open Pending Prep →', K.pend],
      ['prep', 'Prepped', n0(prep), 'open Prepped & Ready →', K.prep],
      ['transit', 'On the way', n0(way), 'sort by on the way', K.way],
      ['lowstock', 'Low stock', n0(low), '1–20 on the shelf', K.warn],
      ['outstock', 'Out of stock', n0(out), 'none on the shelf', K.crit]
    ];
    box.innerHTML = T.map(t => '<button class="oh2-tile' + (t[0] === filter && ['all', 'instock', 'lowstock', 'outstock'].includes(filter) ? ' on' : '') + '" data-go="' + t[0] + '" style="--c:' + t[4] + '"><div class="l">' + t[1] + '</div><div class="v">' + t[2] + '</div><div class="s">' + t[3] + '</div></button>').join('');
  }

  // ---------- one product ----------
  function stockBar(p, available) {
    const lt = typeof listingTotals === 'function' ? listingTotals(p) : { at: p.fba_total || 0, way: 0 };
    const seg = [[available, K.shelf, 'On the shelf, available'], [p.pending_prep || 0, K.pend, 'Pending prep'], [p.prepped || 0, K.prep, 'Prepped'], [p.transit || 0, K.way, 'On the way to Amazon'], [lt.at || 0, K.fba, 'At Amazon (bottles)']];
    const tot = seg.reduce((t, s) => t + s[0], 0);
    if (!tot) return '<div class="oh2-stock empty" title="Nothing anywhere"></div>';
    return '<div class="oh2-stock">' + seg.filter(s => s[0] > 0).map(s => '<i title="' + E(s[2] + ': ' + n0(s[0])) + '" style="flex:' + s[0] + ';background:' + s[1] + '"></i>').join('') + '</div>';
  }
  function coverBadge(days) {
    if (days == null) return '<span class="v dim">—</span>';
    const d = Math.round(days), cls = d < 21 ? 'crit' : d < 45 ? 'warn' : 'good';
    return '<span class="oh2-badge ' + cls + '">' + (cls === 'crit' ? '▼ ' : '') + d + 'd</span>';
  }
  function stats(p, t) {
    const lt = typeof listingTotals === 'function' ? listingTotals(p) : { at: 0, way: 0, rate: 0 };
    const cover = lt.rate > 0 ? (lt.at + lt.way) / (lt.rate / 30) : null;
    const av = ssAvg && ssAvg.avg && ssAvg.avg[p.asin];
    const split = (s, d) => (typeof sdSplit === 'function' && d != null) ? sdSplit(s, d) : '';
    const x = p.transit_split;
    const waySub = x ? [x.single ? x.single + ' single' : '', x.duo ? x.duo + ' in duos' : '', x.other ? x.other + ' other' : ''].filter(Boolean).join(' · ') : '';
    const cell = (k, c, v, sub, title) => '<div class="oh2-st"' + (title ? ' title="' + E(title) + '"' : '') + '><div class="k">' + (c ? '<i style="background:' + c + '"></i>' : '') + k + '</div><div class="v' + (v === 0 || v === '0' ? ' dim' : '') + '">' + v + '</div>' + (sub ? '<div class="x">' + E(sub) + '</div>' : '') + '</div>';
    return '<div class="oh2-stats">' +
      cell('Pending', K.pend, n0(p.pending_prep), split(p.pending_single, p.pending_duo)) +
      cell('Prepped', K.prep, n0(p.prepped), split(p.prepped_single, p.prepped_duo)) +
      cell('On the way', K.way, n0(t), waySub, 'Left the warehouse, not checked in at Amazon yet') +
      cell('At Amazon', K.fba, n0(lt.at), lt.way ? lt.way + ' inbound' : '', 'Bottles at Amazon across this product’s listings (single + duos)') +
      '<div class="oh2-st" title="Days the stock at Amazon plus on the way lasts at the best-estimate sales rate"><div class="k">FBA cover</div><div class="v">' + coverBadge(cover) + '</div></div>' +
      cell('3P avg / mo', null, av && av.avg != null ? '~' + n0(av.avg) : '—', av ? av.n + ' seller' + (av.n === 1 ? '' : 's') : '', 'Other sellers’ average monthly sales on this listing (SmartScout)') +
      '</div>';
  }
  function duoTable(p) {
    if (!p.is_component || !(p.partners && p.partners.length)) return '';
    const byAsin = a => (products || []).find(x => x.asin === a) || {};
    const rows = p.partners.map(pt => {
      const d = byAsin(pt.bundle_asin), av = ssAvg && ssAvg.avg && ssAvg.avg[pt.bundle_asin];
      const partner = byAsin(pt.asin);
      return '<tr><td>' + (typeof amzLinkSized === 'function' ? amzLinkSized(pt.asin, partner.name || pt.name) : E(pt.asin)) +
        '<div style="margin-top:2px"><span class="oh2-mono" onclick="copyText(\'' + q1(pt.asin) + '\',this)" title="Copy partner ASIN">' + E(pt.asin) + '</span></div></td>' +
        '<td><b style="color:' + (pt.onhand > 0 ? K.good : K.crit) + '">' + n0(pt.onhand) + '</b></td>' +
        '<td><a href="https://www.amazon.com/dp/' + encodeURIComponent(pt.bundle_asin) + '" target="_blank" rel="noopener" class="oh2-mono" style="text-decoration:none">' + E(pt.bundle_asin) + '</a></td>' +
        '<td>' + (d.fnsku ? '<span class="oh2-mono" style="color:' + K.ink + '" onclick="copyText(\'' + q1(d.fnsku) + '\',this)" title="Copy FNSKU">' + E(d.fnsku) + '</span>' : '<span style="color:#a8b4be">—</span>') + '</td>' +
        '<td>' + (d.monthlySold != null ? '~' + n0(d.monthlySold) : '—') + '</td>' +
        '<td>' + (av && av.avg != null ? '~' + n0(av.avg) : '—') + '</td></tr>';
    }).join('');
    return '<details class="oh2-more" data-k="duo-' + E(p.asin) + '"><summary>Pairs into duos <span class="cnt">· ' + p.partners.length + ' duo' + (p.partners.length === 1 ? '' : 's') + '</span></summary>' +
      '<table class="oh2-duo"><thead><tr><th>Partner bottle</th><th>Partner on hand</th><th>Duo ASIN</th><th>Duo FNSKU</th><th>Sold / mo</th><th>3P avg / mo</th></tr></thead><tbody>' + rows + '</tbody></table></details>';
  }
  function card(p, i) {
    const o = p.onhand || 0, t = p.transit || 0, pend = p.pending_prep || 0, prep = p.prepped || 0;
    const available = Math.max(0, o - pend - prep);
    const img = p.image ? '<img src="' + E(p.image) + '" alt="" loading="lazy" onerror="this.parentNode.innerHTML=\'<span>📦</span>\'" onmouseenter="picZoom(this,420)" onmouseleave="picZoomOff()">' : '<span>📦</span>';
    const name = typeof amzLinkSized === 'function' ? amzLinkSized(p.asin, p.name) : E(p.name || p.asin);
    const tag = (cls, label, val, onclick, title) => '<span class="oh2-tag ' + cls + '" onclick="' + onclick + '" title="' + E(title) + '">' + label + ' <b>' + E(val) + '</b></span>';
    const cases = p.is_bundle ? '' : '<span class="c" onclick="setCaseQty(\'' + q1(p.asin) + '\')" title="Tap to change the case size">' + E(typeof casesText === 'function' ? casesText(available, caseQtyOf(p)) : '') + '<small>' + caseQtyOf(p) + ' per case ✎</small></span>';
    const shr = typeof shrinkNote === 'function' ? shrinkNote(p) : '';
    const alerts = (shr ? '<div class="oh2-alert crit"><b>⚠</b><div class="shr">' + shr + '</div></div>' : '') +
      (p.fba_amazon_asin ? '<div class="oh2-alert warn"><b>ⓘ</b><div>Amazon files this SKU under ASIN <b>' + E(p.fba_amazon_asin) + '</b>, not ' + E(p.asin) + ' — matched by SKU.</div></div>' : '');
    const amz = typeof amazonSplit === 'function' ? amazonSplit(p) : '';
    return '<article class="oh2-card" style="--d:' + Math.min(i, 12) * 30 + 'ms">' +
      '<div class="oh2-top"><div class="oh2-img">' + img + '</div>' +
      '<div style="min-width:0"><div class="oh2-name">' + name + '</div><div class="oh2-tags">' +
        '<span class="oh2-tag loc' + (p.location ? '' : ' none') + '" onclick="editLocation(\'' + q1(p.asin) + '\')" title="Pallet location — tap to change">📍 <b>' + E(p.location || 'Set location') + '</b></span>' +
        tag('', 'ASIN', p.asin, 'copyText(\'' + q1(p.asin) + '\',this)', 'Tap to copy') +
        (p.sku ? tag('', 'SKU', p.sku, 'copyText(\'' + q1(p.sku) + '\',this)', 'Tap to copy') : '') +
        (p.fnsku ? tag('', 'FNSKU', p.fnsku, 'copyText(\'' + q1(p.fnsku) + '\',this)', 'Tap to copy') : '') +
        (p.is_bundle ? '<span class="oh2-tag duo">This is a duo</span>' : '') +
      '</div></div>' +
      '<div class="oh2-av"><div class="n' + (available <= 0 ? ' zero' : '') + '">' + n0(available) + '</div><div class="l">Available</div>' + cases + '</div></div>' +
      stockBar(p, available) + stats(p, t) + alerts + duoTable(p) +
      (amz ? '<details class="oh2-more" data-k="amz-' + E(p.asin) + '"><summary>At Amazon by listing</summary><div class="oh2-amz">' + amz + '</div></details>' : '') +
      '<div class="oh2-foot"><button class="oh-btn primary sm" onclick="requestPrep(\'' + q1(p.asin) + '\',' + (p.is_component || p.is_bundle ? 'true' : 'false') + ')">Prep</button>' +
      '<button class="oh-btn ghost sm" onclick="ohAdjust(\'' + q1(p.asin) + '\')" title="Units missing on the floor (or found again): corrects On Hand and keeps a log on this card">Fix count</button>' +
      (p.fba_as_of ? '<button class="oh-btn quiet sm" onclick="amazonCheck(\'' + q1(p.asin) + '\')">Check with Amazon</button>' : '') +
      '<span class="sp"></span><span class="meta">' + n0(o) + ' in the warehouse</span></div>' +
      '</article>';
  }
  function row(p) {
    const o = p.onhand || 0, pend = p.pending_prep || 0, prep = p.prepped || 0, available = Math.max(0, o - pend - prep);
    const lt = typeof listingTotals === 'function' ? listingTotals(p) : { at: 0, way: 0, rate: 0 };
    const cover = lt.rate > 0 ? (lt.at + lt.way) / (lt.rate / 30) : null;
    const av = ssAvg && ssAvg.avg && ssAvg.avg[p.asin];
    const img = p.image ? '<img src="' + E(p.image) + '" alt="" loading="lazy" onerror="this.style.visibility=\'hidden\'">' : '<span class="ph"></span>';
    return '<tr><td><div class="nm">' + img + '<div class="t">' + (typeof amzLinkSized === 'function' ? amzLinkSized(p.asin, p.name) : E(p.name)) +
      '<div style="font-size:11.5px;color:' + K.muted + ';margin-top:2px">📍 ' + E(p.location || '—') + ' · <span class="oh2-mono" onclick="copyText(\'' + q1(p.asin) + '\',this)">' + E(p.asin) + '</span></div></div></div></td>' +
      '<td class="big" style="color:' + (available <= 0 ? K.crit : K.ink) + '">' + n0(available) + '</td>' +
      '<td>' + (p.is_bundle ? '—' : E(typeof casesText === 'function' ? casesText(available, caseQtyOf(p)) : '')) + '</td>' +
      '<td>' + n0(pend) + '</td><td>' + n0(prep) + '</td><td>' + n0(p.transit) + '</td><td>' + n0(lt.at) + '</td>' +
      '<td>' + coverBadge(cover) + '</td><td>' + (av && av.avg != null ? '~' + n0(av.avg) : '—') + '</td>' +
      '<td><div style="display:flex;gap:6px;justify-content:center"><button class="oh-btn primary sm" onclick="requestPrep(\'' + q1(p.asin) + '\',' + (p.is_component || p.is_bundle ? 'true' : 'false') + ')">Prep</button><button class="oh-btn ghost sm" onclick="ohAdjust(\'' + q1(p.asin) + '\')">Fix</button></div></td></tr>';
  }
  function emptyState(filter, q) {
    const M = {
      lowstock: ['✓', 'Nothing low on stock', 'Every product has more than 20 on the shelf.'],
      outstock: ['✓', 'Nothing out of stock', 'Every product has at least one unit on the shelf.'],
      sspicks: ['⭐', 'No Smart Scout picks yet', 'Tick products on Admin → Smart Scout Orders and they line up here.'],
      duoonly: ['🧴', 'No duo items', 'Products that pair into duos show here.']
    };
    const m = q ? ['🔍', 'No match for “' + q + '”', 'Try part of the name, or the ASIN.'] : (M[filter] || ['📦', 'No products yet', 'Add a product to the catalog, or sync with Amazon.']);
    return '<div class="oh2-empty"><div class="ill">' + m[0] + '</div><b>' + E(m[1]) + '</b><span>' + E(m[2]) + '</span></div>';
  }
  function skeleton() {
    const c = '<div class="oh2-card" style="animation:none"><div class="oh2-top"><div class="oh2-sk" style="width:64px;height:64px;border-radius:12px"></div><div><div class="oh2-sk" style="height:14px;width:70%"></div><div class="oh2-sk" style="height:12px;width:45%;margin-top:10px"></div><div class="oh2-sk" style="height:22px;width:80%;margin-top:10px"></div></div><div class="oh2-sk" style="width:80px;height:34px"></div></div><div class="oh2-sk" style="height:8px"></div><div class="oh2-sk" style="height:52px;border-radius:12px"></div><div class="oh2-sk" style="height:30px;width:40%"></div></div>';
    return '<div class="oh2-grid">' + c.repeat(6) + '</div>';
  }

  // ---------- render (called by renderOnhand with its filtered, sorted list) ----------
  function render(body, list, ctx) {
    injectCss();
    const panel = document.getElementById('onhand'); panel.classList.add('oh2');
    const cl = document.getElementById('ohClassic'); if (cl) cl.style.display = 'none';
    chrome();
    const filter = ctx.filter || 'all', q = ctx.q || '';
    paintTiles(filter);
    document.querySelectorAll('#oh2Chips .oh2-chip').forEach(b => b.classList.toggle('on', b.dataset.f === filter));
    const s = document.getElementById('oh2Sort'), ss = document.getElementById('sortOnhand'); if (s && ss && s.value !== ss.value) s.value = ss.value;
    const lay = store.get('ohLayout') === 'table' ? 'table' : 'cards';
    document.querySelectorAll('#oh2Lay button').forEach(b => b.classList.toggle('on', b.dataset.lay === lay));
    const cnt = document.getElementById('oh2Count');
    if (ctx.custom) { if (cnt) cnt.textContent = ''; return; }   // a screen that draws itself (Duos I can build)
    if (!(products || []).length) { body.innerHTML = skeleton(); if (cnt) cnt.textContent = 'Loading products…'; return; }
    if (cnt) cnt.textContent = 'Showing ' + n0(list.length) + ' of ' + n0((products || []).length) + ' products';
    const pre = ctx.pickBar || '';
    if (!list.length) { body.innerHTML = pre + '<div class="oh2-grid">' + emptyState(filter, q) + '</div>'; return; }
    if (lay === 'table') {
      body.innerHTML = pre + '<div class="oh2-tblwrap"><table class="oh2-tbl"><colgroup><col style="width:30%"><col style="width:8%"><col style="width:11%"><col style="width:7%"><col style="width:7%"><col style="width:8%"><col style="width:8%"><col style="width:7%"><col style="width:7%"><col style="width:7%"></colgroup>' +
        '<thead><tr><th>Product</th><th>Available</th><th>Cases</th><th>Pending</th><th>Prepped</th><th>On the way</th><th>At Amazon</th><th>FBA cover</th><th>3P avg / mo</th><th></th></tr></thead><tbody>' +
        list.map(row).join('') + '</tbody></table></div>';
      return;
    }
    // A live refresh (every 30 s) redraws the cards: keep what was open, and
    // don't replay the entrance.
    const open = new Set([...body.querySelectorAll('details.oh2-more[open]')].map(d => d.dataset.k));
    const again = !!body.querySelector('.oh2-grid');
    body.innerHTML = pre + '<div class="oh2-grid' + (again ? ' still' : '') + '">' + list.map(card).join('') + '</div>';
    if (open.size) body.querySelectorAll('details.oh2-more').forEach(d => { if (open.has(d.dataset.k)) d.open = true; });
  }
  // Leave the new look: hand the page back to the classic screen untouched.
  function teardown() {
    const panel = document.getElementById('onhand'); if (panel) panel.classList.remove('oh2');
    const cl = document.getElementById('ohClassic'); if (cl) cl.style.display = '';
    const top = document.getElementById('ohTop'); if (top) { const box = document.getElementById('addProductBox'), home = document.getElementById('addProdHome'); if (box && home) home.appendChild(box); top.innerHTML = ''; top.dataset.built = ''; }
  }

  window.OH2 = {
    render, teardown,
    isOn() { return store.get('ohView') !== 'classic'; },
    setOn(on) { store.set('ohView', on ? 'new' : 'classic'); if (!on) teardown(); if (typeof renderOnhand === 'function') renderOnhand(); }
  };
})();
