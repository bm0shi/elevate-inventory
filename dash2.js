// Premium dashboard — Admin → Dashboard → "New look" (owner's trial).
// Lives in its own file so the classic dashboard stays untouched: switching
// back is one click, and dropping the trial is deleting this file + its hook.
//
// Every card loads on its own: a skeleton first, then the data, or an empty
// state that says what's missing and where to fix it — never a blank box.
// Charts are plain SVG drawn here (no outside library), sized to their card
// and redrawn on resize; colors are the validated categorical order (blue,
// orange, aqua, yellow, magenta) and text never wears a series color.
// Uses the page's globals: api, ownerApi, esc, products, fbaNormalize,
// fbaRowValues, showSubTab.
(function () {
  'use strict';
  const C = { blue: '#2a78d6', orange: '#eb6834', aqua: '#1baf7a', yellow: '#eda100', magenta: '#e87ba4',
              ink: '#0b1f24', ink2: '#4a5a66', muted: '#8a97a6', grid: '#e9eef2', base: '#cfd8df',
              good: '#0ca30c', warn: '#fab219', serious: '#ec835a', crit: '#d03b3b', brand: '#0d4450' };
  const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
                  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

  // ---------- formatting ----------
  const n0 = v => Math.round(v || 0).toLocaleString();
  const compact = (v, money) => {
    const a = Math.abs(v || 0), sign = v < 0 ? '−' : '', p = money ? '$' : '';
    if (a >= 1e6) return sign + p + (a / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
    if (a >= 1e4) return sign + p + (a / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return sign + p + Math.round(a).toLocaleString();
  };
  const money = v => compact(v, true);
  const dShort = s => { const d = new Date(s + (String(s).length === 10 ? 'T12:00:00' : '')); return isNaN(d) ? String(s) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
  const mShort = s => { const [y, m] = String(s).split('-'); const d = new Date(+y, +m - 1, 1); return isNaN(d) ? s : d.toLocaleDateString('en-US', { month: 'short' }); };
  const E = s => (typeof esc === 'function' ? esc(String(s == null ? '' : s)) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

  // ---------- styles (scoped under .d2) ----------
  const CSS = `
  .d2{--side:232px;display:grid;grid-template-columns:var(--side) minmax(0,1fr);gap:20px;align-items:start;color:${C.ink};font-feature-settings:"ss01";transition:grid-template-columns .45s cubic-bezier(.2,.7,.2,1)}
  .d2.collapsed{--side:68px}
  .d2 *{box-sizing:border-box}
  .d2-side{position:sticky;top:var(--d2top,12px);background:linear-gradient(180deg,#0b3540 0%,#0d4450 100%);border-radius:18px;padding:14px 10px;color:#d6e6ea;box-shadow:0 10px 30px -12px rgba(13,68,80,.55);overflow:hidden;min-height:420px;display:flex;flex-direction:column}
  .d2-brand{display:flex;align-items:center;gap:10px;padding:4px 8px 14px;border-bottom:1px solid rgba(255,255,255,.08);margin-bottom:10px;white-space:nowrap}
  .d2-logo{width:32px;height:32px;flex:0 0 32px;border-radius:10px;background:linear-gradient(135deg,#ff9900,#ffb84d);display:grid;place-items:center;color:#0b3540;font-weight:900;font-size:15px;box-shadow:0 4px 12px rgba(255,153,0,.35)}
  .d2-brand b{font-size:14px;letter-spacing:.2px;color:#fff}.d2-brand span{display:block;font-size:11px;color:#8fb3bd;font-weight:600}
  .d2-nav{display:flex;flex-direction:column;gap:3px;flex:1}
  .d2-nav button{all:unset;cursor:pointer;display:flex;align-items:center;gap:12px;padding:10px 11px;border-radius:11px;color:#b9d0d6;font-size:13.5px;font-weight:650;white-space:nowrap;position:relative;transition:background .25s,color .25s}
  .d2-nav button:hover{background:rgba(255,255,255,.07);color:#fff}
  .d2-nav button.on{background:rgba(255,255,255,.12);color:#fff}
  .d2-nav button.on::before{content:"";position:absolute;left:-10px;top:9px;bottom:9px;width:3px;border-radius:0 3px 3px 0;background:#ff9900}
  .d2-nav svg,.d2-foot svg{width:18px;height:18px;flex:0 0 18px}
  .d2-lbl{transition:opacity .25s ease,transform .35s ease}
  .d2.collapsed .d2-lbl{opacity:0;transform:translateX(-6px);pointer-events:none}
  .d2-foot{border-top:1px solid rgba(255,255,255,.08);padding-top:10px;display:flex;flex-direction:column;gap:3px}
  .d2-foot button{all:unset;cursor:pointer;display:flex;align-items:center;gap:12px;padding:9px 11px;border-radius:11px;color:#8fb3bd;font-size:12.5px;font-weight:650;white-space:nowrap}
  .d2-foot button:hover{background:rgba(255,255,255,.07);color:#fff}
  .d2-chev{transition:transform .45s cubic-bezier(.2,.7,.2,1)}.d2.collapsed .d2-chev{transform:rotate(180deg)}
  .d2-main{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:18px;min-width:0}
  .d2-head{grid-column:1/-1;display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:2px 2px 0}
  .d2-head h2{margin:0;font-size:24px;font-weight:800;letter-spacing:-.3px}
  .d2-head p{margin:3px 0 0;color:${C.ink2};font-size:13px}
  .d2-live{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:${C.ink2};font-weight:650;background:#fff;border:1px solid #e3e9ee;border-radius:999px;padding:6px 12px}
  .d2-dot{width:8px;height:8px;border-radius:50%;background:${C.good};box-shadow:0 0 0 0 rgba(12,163,12,.5);animation:d2pulse 2s infinite}
  .d2-btn{all:unset;cursor:pointer;font-size:12.5px;font-weight:750;color:#fff;background:${C.brand};border-radius:999px;padding:8px 15px;box-shadow:0 4px 14px -4px rgba(13,68,80,.6);transition:transform .2s,box-shadow .2s}
  .d2-btn:hover{transform:translateY(-1px);box-shadow:0 8px 18px -6px rgba(13,68,80,.6)}
  .d2-btn.ghost{background:#fff;color:${C.brand};border:1px solid #d5e0e6;box-shadow:none}
  .d2-card{position:relative;background:#fff;border:1px solid #e6ecf0;border-radius:18px;padding:18px 20px;box-shadow:0 1px 2px rgba(16,24,40,.04),0 12px 32px -18px rgba(16,24,40,.18);min-width:0;opacity:0;transform:translateY(14px);animation:d2in .7s cubic-bezier(.2,.7,.2,1) forwards;animation-delay:var(--d,0ms);scroll-margin-top:calc(var(--d2top,12px) + 4px)}
  .d2-card h3{margin:0;font-size:14.5px;font-weight:800;letter-spacing:-.1px}
  .d2-card .d2-sub{font-size:12px;color:${C.muted};margin-top:2px}
  .d2-ch{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:12px}
  .d2-meta{font-size:11.5px;color:${C.muted};white-space:nowrap}
  .s12{grid-column:span 12}.s8{grid-column:span 8}.s7{grid-column:span 7}.s6{grid-column:span 6}.s5{grid-column:span 5}.s4{grid-column:span 4}.s3{grid-column:span 3}
  .d2-hero{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:28px;align-items:center;background:radial-gradient(120% 140% at 0% 0%,#f3fbfb 0%,#fff 55%)}
  .d2-hval{font-size:52px;font-weight:850;letter-spacing:-1.5px;line-height:1;margin:10px 0 8px}
  .d2-eyebrow{font-size:11px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:${C.muted}}
  .d2-hsub{font-size:13px;color:${C.ink2}}
  .d2-pipe{display:flex;height:16px;border-radius:999px;overflow:hidden;gap:2px;background:#fff;margin:6px 0 16px}
  .d2-pipe i{display:block;height:100%;transform-origin:left;transform:scaleX(0);animation:d2grow 1.1s cubic-bezier(.2,.7,.2,1) forwards;animation-delay:var(--d,0ms)}
  .d2-pipe i:first-child{border-radius:999px 0 0 999px}.d2-pipe i:last-child{border-radius:0 999px 999px 0}
  .d2-legend{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}
  .d2-lg{min-width:0}.d2-lg .k{display:flex;align-items:center;gap:6px;font-size:11.5px;color:${C.ink2};font-weight:700;white-space:nowrap}
  .d2-lg .k i{width:9px;height:9px;border-radius:3px;flex:0 0 9px}
  .d2-lg .v{font-size:19px;font-weight:800;margin-top:4px}.d2-lg .m{font-size:11.5px;color:${C.muted};margin-top:1px}
  .d2-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;grid-column:1/-1}
  .d2-tile{padding:16px 18px}
  .d2-tile .t{display:flex;align-items:center;justify-content:space-between;font-size:12.5px;color:${C.ink2};font-weight:700}
  .d2-tile .v{font-size:30px;font-weight:850;letter-spacing:-.6px;margin-top:8px}
  .d2-tile .f{font-size:11.5px;color:${C.muted};margin-top:2px}
  .d2-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:800;border-radius:999px;padding:3px 8px}
  .d2-ico{width:34px;height:34px;border-radius:10px;display:grid;place-items:center}
  .d2-ico svg{width:18px;height:18px}
  .d2-chart{position:relative;width:100%}
  .d2-chart svg{display:block;overflow:visible}
  .d2-tip{position:absolute;pointer-events:none;background:#0b1f24;color:#fff;border-radius:10px;padding:8px 10px;font-size:12px;line-height:1.45;box-shadow:0 10px 24px -8px rgba(0,0,0,.4);opacity:0;transform:translateY(4px);transition:opacity .15s,transform .15s;white-space:nowrap;z-index:5}
  .d2-tip.on{opacity:1;transform:none}
  .d2-tip .r{display:flex;align-items:center;gap:7px}.d2-tip .r i{width:8px;height:8px;border-radius:2px}
  .d2-tip b{font-weight:800}
  .d2-keys{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:${C.ink2};font-weight:650}
  .d2-keys span{display:inline-flex;align-items:center;gap:6px}.d2-keys i{width:10px;height:3px;border-radius:2px;display:inline-block}
  .d2-keys i.sq{height:10px;width:10px;border-radius:3px}
  .d2-line{fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  .d2-draw{stroke-dasharray:var(--len);stroke-dashoffset:var(--len);animation:d2draw 1.4s cubic-bezier(.3,.6,.2,1) forwards;animation-delay:var(--d,150ms)}
  .d2-area{opacity:0;animation:d2fade 1s ease forwards;animation-delay:.5s}
  .d2-bar{transform-box:fill-box;transform-origin:50% 100%;transform:scaleY(0);animation:d2rise .9s cubic-bezier(.2,.7,.2,1) forwards;animation-delay:var(--d,0ms)}
  .d2-bar.neg{transform-origin:50% 0%}
  .d2-hb{transform-box:fill-box;transform-origin:0 50%;transform:scaleX(0);animation:d2growx .9s cubic-bezier(.2,.7,.2,1) forwards;animation-delay:var(--d,0ms)}
  .d2-rows{display:flex;flex-direction:column}
  .d2-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 2px;border-top:1px solid #f0f3f6;font-size:13px}
  .d2-row:first-child{border-top:0}
  .d2-row a,.d2-ev a,.d2-top a{color:${C.ink}!important;text-decoration:none!important;border-bottom:0!important;font-weight:650}.d2-row a:hover{color:${C.brand};text-decoration:underline}
  .d2-row .n{font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap}
  .d2-tl{position:relative;padding-left:18px}
  .d2-tl::before{content:"";position:absolute;left:5px;top:6px;bottom:6px;width:2px;background:#eef2f5;border-radius:2px}
  .d2-ev{position:relative;padding:7px 0;font-size:12.5px;display:flex;justify-content:space-between;gap:10px}
  .d2-ev::before{content:"";position:absolute;left:-17px;top:11px;width:10px;height:10px;border-radius:50%;background:var(--c);box-shadow:0 0 0 3px #fff}
  .d2-ev .w{color:${C.muted};white-space:nowrap;font-size:11.5px}
  .d2-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:26px 14px;min-height:190px;gap:8px}
  .d2-empty .ill{width:64px;height:64px;border-radius:20px;background:linear-gradient(135deg,#f1f6f8,#e6eff3);display:grid;place-items:center;margin-bottom:4px}
  .d2-empty .ill svg{width:30px;height:30px;color:#7d97a3}
  .d2-empty b{font-size:14px}.d2-empty span{font-size:12.5px;color:${C.ink2};max-width:340px}
  .d2-empty button{margin-top:6px}
  .d2-periods{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin:4px 0 14px}
  .d2-per .l{overflow:hidden;text-overflow:ellipsis}.d2-per .l span{font-weight:600;color:${C.muted}}
  .d2-per .dl{display:flex;align-items:center;gap:7px;margin-top:6px}.d2-per .dl .d2-delta{margin-top:0}
  .d2-per .dl b{font-size:11.5px;font-weight:800}.d2-per .dl b.pos{color:#006300}.d2-per .dl b.neg{color:#b42d2d}
  .d2-per.custom{background:repeating-linear-gradient(135deg,#fff,#fff 10px,#fafcfd 10px,#fafcfd 20px)}
  .d2-per.custom.on{background:linear-gradient(180deg,#f2f9fa,#fff)}
  .d2-metrics{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:0;margin:0 0 16px;border:1px solid #e6ecf0;border-radius:14px;overflow:hidden;background:#fbfcfd}
  .d2-met{all:unset;box-sizing:border-box;cursor:pointer;padding:11px 12px 12px;border-left:1px solid #e9eef2;min-width:0;transition:background .2s;position:relative}
  .d2-met:first-child{border-left:0}
  .d2-met:hover{background:#f3f7f9}
  .d2-met.on{background:#fff;box-shadow:inset 0 -3px 0 ${C.brand}}
  .d2-met .l{font-size:11px;font-weight:750;color:${C.ink2};white-space:nowrap;text-transform:none}
  .d2-met .v{font-size:17px;font-weight:850;letter-spacing:-.3px;margin:4px 0 5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .d2-met .d2-delta{margin-top:0}
  .d2-met .p{font-size:10.5px;color:${C.muted};margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .d2-note input[type=date]{font:inherit;font-size:12.5px;padding:6px 8px;border:1px solid #d5e0e6;border-radius:8px;background:#fff;color:${C.ink}}
  .d2-per{all:unset;box-sizing:border-box;cursor:pointer;display:block;border:1px solid #e6ecf0;border-radius:14px;padding:12px 14px;background:#fff;transition:border-color .2s,box-shadow .2s,transform .2s;min-width:0}
  .d2-per:hover{border-color:#c6d4dc;transform:translateY(-1px)}
  .d2-per.on{border-color:${C.brand};background:linear-gradient(180deg,#f2f9fa,#fff);box-shadow:0 8px 20px -14px rgba(13,68,80,.6)}
  .d2-per .l{font-size:12px;font-weight:750;color:${C.ink2};white-space:nowrap}
  .d2-per .v{font-size:24px;font-weight:850;letter-spacing:-.5px;margin-top:4px;white-space:nowrap}
  .d2-per .p{font-size:11px;color:${C.muted};margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .d2-delta{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:800;border-radius:999px;padding:2px 8px;margin-top:6px;white-space:nowrap}
  .d2-delta.up{background:#e9f7ec;color:#006300}.d2-delta.down{background:#fdecec;color:#b42d2d}.d2-delta.flat{background:#f0f3f6;color:${C.ink2}}
  .d2-note{font-size:12px;color:${C.ink2};background:#f6f9fb;border:1px dashed #d5e0e6;border-radius:12px;padding:9px 12px;margin:-4px 0 14px;display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
  .d2-tile[data-goto]{cursor:pointer;transition:transform .2s,box-shadow .2s,border-color .2s}
  .d2-tile[data-goto]:hover{transform:translateY(-2px);border-color:#c6d4dc;box-shadow:0 1px 2px rgba(16,24,40,.04),0 18px 36px -18px rgba(16,24,40,.28)}
  .d2-tile .go{font-size:11.5px;font-weight:750;color:${C.brand};margin-top:8px;opacity:.0;transform:translateX(-4px);transition:opacity .2s,transform .2s}
  .d2-tile[data-goto]:hover .go{opacity:1;transform:none}
  .d2-sk{background:linear-gradient(90deg,#eef2f5 25%,#f8fafb 37%,#eef2f5 63%);background-size:400% 100%;animation:d2sh 1.4s ease infinite;border-radius:10px}
  @keyframes d2sh{0%{background-position:100% 50%}100%{background-position:0 50%}}
  @keyframes d2in{to{opacity:1;transform:none}}
  @keyframes d2grow{to{transform:scaleX(1)}}
  @keyframes d2growx{to{transform:scaleX(1)}}
  @keyframes d2rise{to{transform:scaleY(1)}}
  @keyframes d2draw{to{stroke-dashoffset:0}}
  @keyframes d2fade{to{opacity:1}}
  @keyframes d2pulse{0%{box-shadow:0 0 0 0 rgba(12,163,12,.45)}70%{box-shadow:0 0 0 8px rgba(12,163,12,0)}100%{box-shadow:0 0 0 0 rgba(12,163,12,0)}}
  @media (max-width:1180px){.s8,.s7{grid-column:span 12}.s4,.s5{grid-column:span 12}.d2-hero{grid-template-columns:1fr}.d2-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media (max-width:1180px) and (min-width:760px){.s6{grid-column:span 6}}
  @media (max-width:900px){
    .d2,.d2.collapsed{grid-template-columns:1fr;--side:auto}
    .d2-side{position:sticky;top:var(--d2top,0px);z-index:6;min-height:0;flex-direction:row;align-items:center;padding:8px;border-radius:14px;overflow-x:auto}
    .d2-brand,.d2-foot .d2-collapse{display:none}
    .d2-nav{flex-direction:row;flex:0 0 auto}.d2-nav button{padding:8px 12px}.d2-nav button.on::before{display:none}
    .d2.collapsed .d2-lbl{opacity:1;transform:none}
    .d2-foot{border:0;padding:0;flex-direction:row}
  }
  @media (max-width:1180px){.d2-periods{grid-template-columns:repeat(3,minmax(0,1fr))}.d2-metrics{grid-template-columns:repeat(4,minmax(0,1fr))}.d2-met:nth-child(5){border-left:0}.d2-met:nth-child(n+5){border-top:1px solid #e9eef2}}
  @media (max-width:760px){.d2-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.d2-met:nth-child(odd){border-left:0}.d2-met:nth-child(n+3){border-top:1px solid #e9eef2}.d2-periods{grid-template-columns:repeat(2,minmax(0,1fr))}.s6,.s3{grid-column:span 12}.d2-legend{grid-template-columns:repeat(2,minmax(0,1fr))}.d2-hval{font-size:42px}.d2-tiles{grid-template-columns:1fr 1fr;gap:12px}}
  @media (prefers-reduced-motion:reduce){.d2 *,.d2 *::before{animation-duration:1ms!important;animation-delay:0ms!important;transition:none!important}}
  `;
  function injectCss() { if (document.getElementById('d2css')) return; const s = document.createElement('style'); s.id = 'd2css'; s.textContent = CSS; document.head.appendChild(s); }

  // ---------- icons (stroke, 24 grid) ----------
  const I = {
    overview: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
    box: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
    chart: '<path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 15l4-4 3 3 5-6"/>',
    ops: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    chev: '<path d="M15 18l-6-6 6-6"/>',
    back: '<path d="M3 12h18M3 6h18M3 18h18"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
    truck: '<path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
    alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    off: '<circle cx="12" cy="12" r="10"/><path d="M4.9 4.9l14.2 14.2"/>',
    dollar: '<path d="M12 1v22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'
  };
  const svg = (k, extra) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' + (extra || '') + '>' + I[k] + '</svg>';

  // ---------- small pieces ----------
  const sk = (h, w, mt) => '<div class="d2-sk" style="height:' + h + 'px;width:' + (w || '100%') + ';margin-top:' + (mt || 0) + 'px"></div>';
  const skChart = h => '<div style="display:flex;align-items:flex-end;gap:10px;height:' + h + 'px;padding-top:10px">' +
    [55, 72, 40, 86, 64, 92, 70, 58, 80, 66].map(p => '<div class="d2-sk" style="flex:1;height:' + p + '%"></div>').join('') + '</div>';
  function empty(icon, title, text, action) {
    return '<div class="d2-empty"><div class="ill">' + svg(icon) + '</div><b>' + E(title) + '</b><span>' + E(text) + '</span>' +
      (action ? '<button class="d2-btn ghost" data-go="' + E(action.go) + '">' + E(action.label) + '</button>' : '') + '</div>';
  }
  function countUp(el, to, fmt) {
    if (!el) return;
    if (REDUCED || !isFinite(to)) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = 1100;
    const step = t => { const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3); el.textContent = fmt(to * e); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  function niceTicks(max, n) {
    if (!(max > 0)) return [0, 1];
    const raw = max / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
    const out = []; for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
    if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
    return out;
  }
  function tipAt(card, html, x, y) {
    let t = card.querySelector('.d2-tip'); if (!t) { t = document.createElement('div'); t.className = 'd2-tip'; card.appendChild(t); }
    t.innerHTML = html; t.classList.add('on');
    const cw = card.clientWidth, tw = t.offsetWidth;
    t.style.left = Math.max(8, Math.min(cw - tw - 8, x - tw / 2)) + 'px'; t.style.top = Math.max(8, y - t.offsetHeight - 14) + 'px';
  }
  function tipOff(card) { const t = card.querySelector('.d2-tip'); if (t) t.classList.remove('on'); }
  const tipRow = (color, label, val) => '<div class="r"><i style="background:' + color + '"></i>' + E(label) + '&nbsp; <b>' + E(val) + '</b></div>';

  // ---------- charts ----------
  // Line/area: one axis, 2px lines, end dots ringed in the surface, area wash
  // on the first series only, crosshair + tooltip.
  function lineChart(box, o) {
    const W = Math.max(260, box.clientWidth), H = o.h || 230, L = 44, R = 16, T = 10, B = 26;
    const n = o.labels.length, all = o.series.flatMap(s => s.values).filter(v => v != null), max = Math.max(1, ...all);
    const ticks = niceTicks(max, 4), top = ticks[ticks.length - 1];
    const x = i => L + (n <= 1 ? (W - L - R) / 2 : i * (W - L - R) / (n - 1)), y = v => T + (H - T - B) * (1 - v / top);
    let g = '';
    ticks.forEach(t => { g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(t) + '" y2="' + y(t) + '" stroke="' + (t === 0 ? C.base : C.grid) + '" stroke-width="1"/><text x="' + (L - 8) + '" y="' + (y(t) + 4) + '" text-anchor="end" font-size="11" fill="' + C.muted + '" style="font-variant-numeric:tabular-nums">' + E(o.fmtAxis ? o.fmtAxis(t) : compact(t)) + '</text>'; });
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - L - R) / 70))));
    o.labels.forEach((lb, i) => { if ((i % every === 0 && n - 1 - i >= every * 0.75) || i === n - 1) g += '<text x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="' + (i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle') + '" font-size="11" fill="' + C.muted + '">' + E(o.fmtLabel ? o.fmtLabel(lb) : lb) + '</text>'; });
    let paths = '';
    o.series.forEach((s, si) => {
      const pts = s.values.map((v, i) => v == null ? null : [x(i), y(v)]).filter(Boolean);
      const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
      if (si === 0 && o.area !== false && pts.length > 1) paths += '<path class="d2-area" d="' + d + ' L' + pts[pts.length - 1][0] + ' ' + y(0) + ' L' + pts[0][0] + ' ' + y(0) + 'Z" fill="' + s.color + '" fill-opacity=".10"/>';
      paths += '<path class="d2-line ' + (REDUCED ? '' : 'd2-draw') + '" data-s="' + si + '" d="' + d + '" stroke="' + s.color + '" style="--d:' + (150 + si * 180) + 'ms' + (s.width ? ';stroke-width:' + s.width : '') + '"/>';
      const last = pts[pts.length - 1];
      if (last) paths += '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="4.5" fill="' + s.color + '" stroke="#fff" stroke-width="2" class="d2-area"/>';
    });
    box.innerHTML = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + E(o.aria || '') + '">' + g + paths +
      '<line class="xh" x1="0" x2="0" y1="' + T + '" y2="' + (H - B) + '" stroke="' + C.base + '" stroke-width="1" opacity="0"/>' +
      o.series.map((s, si) => '<circle class="hd' + si + '" r="4.5" fill="' + s.color + '" stroke="#fff" stroke-width="2" opacity="0"/>').join('') +
      '<rect x="' + L + '" y="0" width="' + (W - L - R) + '" height="' + H + '" fill="transparent" class="hit"/></svg>';
    box.querySelectorAll('.d2-draw').forEach(p => { try { p.style.setProperty('--len', Math.ceil(p.getTotalLength()) + 1); } catch (e) {} });
    const sv = box.querySelector('svg'), hit = box.querySelector('.hit'), xh = box.querySelector('.xh'), card = box.closest('.d2-card');
    const move = ev => {
      const r = sv.getBoundingClientRect(), mx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
      const i = Math.max(0, Math.min(n - 1, Math.round((mx - L) / ((W - L - R) / Math.max(1, n - 1)))));
      xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('opacity', 1);
      o.series.forEach((s, si) => { const c = sv.querySelector('.hd' + si), v = s.values[i]; if (v == null) { c.setAttribute('opacity', 0); return; } c.setAttribute('cx', x(i)); c.setAttribute('cy', y(v)); c.setAttribute('opacity', 1); });
      const cr = card.getBoundingClientRect(), ys = o.series.map(s => s.values[i]).filter(v => v != null).map(y);
      tipAt(card, '<div style="color:#9fb3bd;font-size:11px;margin-bottom:3px">' + E(o.fmtLabel ? o.fmtLabel(o.labels[i]) : o.labels[i]) + '</div>' + o.series.map(s => tipRow(s.color, s.name, s.values[i] == null ? '—' : (o.fmt || n0)(s.values[i]))).join('') + (o.tipExtra ? o.tipExtra(i) : ''), r.left - cr.left + x(i), r.top - cr.top + (ys.length ? Math.min(...ys) : H / 2));
    };
    const out = () => { xh.setAttribute('opacity', 0); o.series.forEach((s, si) => sv.querySelector('.hd' + si).setAttribute('opacity', 0)); tipOff(card); };
    hit.addEventListener('mousemove', move); hit.addEventListener('touchstart', move, { passive: true }); hit.addEventListener('mouseleave', out);
  }
  // Columns (grouped when several series): ≤24px, 4px rounded data end,
  // square at the baseline, 2px surface gap between neighbours; negatives
  // hang below the baseline.
  function columnChart(box, o) {
    const W = Math.max(260, box.clientWidth), H = o.h || 230, L = 48, R = 10, T = 12, B = 26;
    const n = o.labels.length, k = o.series.length, all = o.series.flatMap(s => s.values);
    const maxV = Math.max(0, ...all), minV = Math.min(0, ...all);
    const ticks = niceTicks(Math.max(maxV, -minV) || 1, 4), top = maxV > 0 ? ticks[ticks.length - 1] : 0;
    const bot = minV < 0 ? -niceTicks(-minV, 2).slice(-1)[0] : 0, span = (top - bot) || 1;
    const y = v => T + (H - T - B) * (top - v) / span;
    const band = (W - L - R) / Math.max(1, n), bw = Math.min(24, Math.max(2, (band * 0.62 - (k - 1) * 2) / k)), groupW = k * bw + (k - 1) * 2;
    let g = '';
    const tickVals = [...new Set([...ticks.filter(t => t <= top), ...(bot < 0 ? [bot, bot / 2] : [])])].sort((a, b) => a - b);
    tickVals.forEach(t => { g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(t) + '" y2="' + y(t) + '" stroke="' + (t === 0 ? C.base : C.grid) + '"/><text x="' + (L - 8) + '" y="' + (y(t) + 4) + '" text-anchor="end" font-size="11" fill="' + C.muted + '" style="font-variant-numeric:tabular-nums">' + E((o.fmtAxis || compact)(t)) + '</text>'; });
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - L - R) / 56))));
    let bars = '';
    o.labels.forEach((lb, i) => {
      const gx = L + i * band + (band - groupW) / 2;
      if ((i % every === 0 && n - 1 - i >= every * 0.75) || i === n - 1) g += '<text x="' + (L + i * band + band / 2) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="11" fill="' + C.muted + '">' + E(o.fmtLabel ? o.fmtLabel(lb) : lb) + '</text>';
      o.series.forEach((s, si) => {
        const v = s.values[i] || 0, bx = gx + si * (bw + 2), y0 = y(0), y1 = y(v), h = Math.abs(y1 - y0);
        if (h < 0.5) return;
        const r = Math.min(4, h, bw / 2), neg = v < 0;
        const d = neg
          ? 'M' + bx + ' ' + y0 + 'H' + (bx + bw) + 'V' + (y1 - r) + 'Q' + (bx + bw) + ' ' + y1 + ' ' + (bx + bw - r) + ' ' + y1 + 'H' + (bx + r) + 'Q' + bx + ' ' + y1 + ' ' + bx + ' ' + (y1 - r) + 'Z'
          : 'M' + bx + ' ' + y0 + 'V' + (y1 + r) + 'Q' + bx + ' ' + y1 + ' ' + (bx + r) + ' ' + y1 + 'H' + (bx + bw - r) + 'Q' + (bx + bw) + ' ' + y1 + ' ' + (bx + bw) + ' ' + (y1 + r) + 'V' + y0 + 'Z';
        bars += '<path class="d2-bar' + (neg ? ' neg' : '') + '" d="' + d + '" fill="' + s.color + '" style="--d:' + (i * 45 + si * 70) + 'ms"/>';
      });
      bars += '<rect class="hb" data-i="' + i + '" x="' + (L + i * band) + '" y="' + T + '" width="' + band + '" height="' + (H - T - B) + '" fill="transparent"/>';
    });
    box.innerHTML = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + E(o.aria || '') + '">' + g + bars + '</svg>';
    const sv = box.querySelector('svg'), card = box.closest('.d2-card');
    sv.querySelectorAll('.hb').forEach(rc => {
      rc.addEventListener('mousemove', () => {
        const i = +rc.dataset.i, r = sv.getBoundingClientRect(), cr = card.getBoundingClientRect();
        sv.querySelectorAll('.hb').forEach(z => z.setAttribute('fill', 'transparent')); rc.setAttribute('fill', 'rgba(13,68,80,.04)');
        tipAt(card, '<div style="color:#9fb3bd;font-size:11px;margin-bottom:3px">' + E(o.fmtLabel ? o.fmtLabel(o.labels[i]) : o.labels[i]) + '</div>' + o.series.map(s => tipRow(s.color, s.name, s.values[i] == null ? '—' : (o.fmt || n0)(s.values[i]))).join('') + (o.tipExtra ? o.tipExtra(i) : ''),
          r.left - cr.left + L + i * band + band / 2, r.top - cr.top + Math.min(...o.series.map(s => y(Math.max(0, s.values[i] || 0)))));
      });
      rc.addEventListener('mouseleave', () => { rc.setAttribute('fill', 'transparent'); tipOff(card); });
    });
  }
  // Horizontal bars, one series (slot 1), value at the tip.
  function hBars(box, items, o) {
    const max = Math.max(1, ...items.map(i => i.value));
    box.innerHTML = '<div style="display:flex;flex-direction:column;gap:11px">' + items.map((it, i) =>
      '<div><div style="display:flex;justify-content:space-between;gap:10px;font-size:12.5px;margin-bottom:5px"><span style="min-width:0;font-weight:650;line-height:1.5' + (it.html ? '' : ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap') + '" title="' + E(it.title || it.label) + '">' + (it.html || E(it.label)) + '</span><b style="font-variant-numeric:tabular-nums">' + E((o.fmt || n0)(it.value)) + '</b></div>' +
      '<svg width="100%" height="8" preserveAspectRatio="none" viewBox="0 0 100 8"><rect x="0" y="0" width="100" height="8" rx="4" fill="#eef3f6"/><rect class="d2-hb" x="0" y="0" width="' + (100 * it.value / max).toFixed(2) + '" height="8" rx="4" fill="' + C.blue + '" style="--d:' + (i * 70) + 'ms"/></svg></div>').join('') + '</div>';
  }
  function sparkline(box, values, color) {
    const W = Math.max(120, box.clientWidth), H = 46, n = values.length, max = Math.max(1, ...values), min = Math.min(...values);
    const x = i => 2 + i * (W - 8) / Math.max(1, n - 1), y = v => 4 + (H - 10) * (1 - (v - min) / Math.max(1, max - min));
    const d = values.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
    box.innerHTML = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '"><path class="d2-area" d="' + d + ' L' + x(n - 1) + ' ' + H + ' L' + x(0) + ' ' + H + 'Z" fill="' + color + '" fill-opacity=".10"/><path class="d2-line ' + (REDUCED ? '' : 'd2-draw') + '" d="' + d + '" stroke="' + color + '"/><circle cx="' + x(n - 1) + '" cy="' + y(values[n - 1]) + '" r="4" fill="' + color + '" stroke="#fff" stroke-width="2" class="d2-area"/></svg>';
    box.querySelectorAll('.d2-draw').forEach(p => { try { p.style.setProperty('--len', Math.ceil(p.getTotalLength()) + 1); } catch (e) {} });
  }

  // ---------- data ----------
  async function inventory() {
    const [prods, fc, iv] = await Promise.all([
      api('/api/products').catch(() => null),
      window._fbaData ? Promise.resolve(null) : api('/api/cache/fba_inventory').catch(() => null),
      window._fbaPrices ? Promise.resolve(null) : ownerApi('/api/cache/inventory_value').catch(() => null)
    ]);
    if (Array.isArray(prods)) products = prods;   // the page's live product list (fresh counts)
    if (fc && fc.cached && fc.data) {
      window._fbaData = Array.isArray(fc.data) ? fc.data : (fc.data.items || []);
      window._fbaSort = window._fbaSort || { col: 'grand_total', dir: -1 };
      window._fbaLoadedAt = new Date(fc.updated_at);
    }
    if (iv) { const m = {}; for (const v of ((iv.cached && Array.isArray(iv.data)) ? iv.data : [])) if (v.amazon_price) m[v.asin] = parseFloat(v.amazon_price); window._fbaPrices = m; }
    if (!window._fbaData) return null;
    fbaNormalize();
    const rows = window._fbaData, V = fbaRowValues(rows);
    const t = { w: 0, pp: 0, pr: 0, t: 0, f: 0, g: 0 };
    rows.forEach(x => { t.w += x.warehouse || 0; t.pp += x.pending_prep || 0; t.pr += x.prepped || 0; t.t += x.transit || 0; t.f += x.fba_total || 0; t.g += x.grand_total || 0; });
    return { t, V, at: window._fbaLoadedAt };
  }

  // ---------- render ----------
  let state = null, ro = null;
  const SECTIONS = [['overview', 'Overview', 'overview'], ['inventory', 'Inventory', 'box'], ['sales', 'Sales & money', 'chart'], ['ops', 'Operations', 'ops'], ['alerts', 'Alerts', 'bell']];

  function shell() {
    const collapsed = store.get('d2Side') === '1';
    const now = new Date(), hr = now.getHours(), hello = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
    return '<div class="d2' + (collapsed ? ' collapsed' : '') + '" id="d2root">' +
      '<aside class="d2-side"><div class="d2-brand"><div class="d2-logo">E</div><div class="d2-lbl"><b>Elevate</b><span>Business overview</span></div></div>' +
      '<nav class="d2-nav">' + SECTIONS.map((s, i) => '<button data-sec="' + s[0] + '" class="' + (i ? '' : 'on') + '" title="' + s[1] + '">' + svg(s[2]) + '<span class="d2-lbl">' + s[1] + '</span></button>').join('') + '</nav>' +
      '<div class="d2-foot"><button data-act="classic" title="Back to the classic dashboard">' + svg('back') + '<span class="d2-lbl">Classic view</span></button>' +
      '<button class="d2-collapse" data-act="collapse" title="Collapse / expand">' + svg('chev', ' class="d2-chev"') + '<span class="d2-lbl">Collapse</span></button></div></aside>' +
      '<main class="d2-main">' +
      '<div class="d2-head"><div><h2>' + hello + '</h2><p>' + E(now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })) + ' · everything from the warehouse floor to Amazon, in one place</p></div>' +
      '<div style="display:flex;gap:8px;align-items:center"><span class="d2-live"><span class="d2-dot"></span><span id="d2upd">Live</span></span><button class="d2-btn" data-act="refresh">' + svg('refresh', ' style="width:14px;height:14px;vertical-align:-2px;margin-right:6px"') + 'Refresh</button></div></div>' +
      // gross sales first (owner), then what the inventory is worth
      // gross sales
      '<section id="d2-overview" class="d2-card s12" style="--d:40ms"><div class="d2-ch"><div><h3>Gross sales</h3><div class="d2-sub">Ordered product sales, like Amazon’s app · Pacific time · pending orders included · history refreshes itself every morning</div></div>' +
      '<div style="display:flex;gap:10px;align-items:center"><span class="d2-meta" id="d2sasof"></span><button class="d2-btn ghost" data-act="sales-quick" id="d2squick">' + svg('refresh', ' style="width:13px;height:13px;vertical-align:-2px;margin-right:5px"') + 'Update today</button></div></div>' +
      '<div id="d2periods" class="d2-periods">' + [0, 1, 2, 3, 4, 5].map(() => '<div class="d2-per" style="cursor:default">' + sk(12, '60%') + sk(24, '75%', 8) + sk(16, '55%', 8) + '</div>').join('') + '</div>' +
      '<div id="d2snote"></div><div id="d2metrics" class="d2-metrics"></div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:10px;flex-wrap:wrap"><div class="d2-sub" id="d2stitle"></div><div class="d2-keys" id="d2skeys"></div></div><div class="d2-chart" id="d2sales">' + skChart(240) + '</div></section>' +
      // overview: hero
      '<section id="d2-value" class="d2-card d2-hero s12" style="--d:90ms"><div><div class="d2-eyebrow">Total retail value</div><div class="d2-hval" id="d2hv">' + sk(52, '70%') + '</div><div class="d2-hsub" id="d2hs">' + sk(14, '60%') + '</div><div id="d2spark" style="margin-top:14px;height:46px">' + sk(46) + '</div></div>' +
      '<div><div style="display:flex;justify-content:space-between;align-items:baseline"><div class="d2-eyebrow">Where every unit is</div><div class="d2-meta" id="d2pipeat"></div></div><div id="d2pipe">' + sk(16, '100%', 10) + '<div class="d2-legend" style="margin-top:18px">' + [1, 2, 3, 4, 5].map(() => '<div>' + sk(12, '70%') + sk(22, '80%', 8) + sk(11, '60%', 6) + '</div>').join('') + '</div></div></div></section>' +
      // tiles
      '<div class="d2-tiles" id="d2tiles">' + [0, 1, 2, 3].map(i => '<div class="d2-card d2-tile" style="--d:' + (120 + i * 60) + 'ms">' + sk(14, '55%') + sk(30, '40%', 12) + sk(11, '70%', 8) + '</div>').join('') + '</div>' +
      // inventory
      '<section id="d2-inventory" class="d2-card s8" style="--d:220ms"><div class="d2-ch"><div><h3>Units at Amazon</h3><div class="d2-sub">Daily snapshot from each FBA Inventory pull · last 90 days</div></div><div class="d2-keys" id="d2fbakeys"></div></div><div class="d2-chart" id="d2fba">' + skChart(230) + '</div></section>' +
      '<section class="d2-card s4" style="--d:280ms"><div class="d2-ch"><div><h3>Top sellers</h3><div class="d2-sub" id="d2topsub">Units sold</div></div></div><div id="d2top" class="d2-top">' + [0, 1, 2, 3, 4, 5].map(() => sk(12, '70%', 6) + sk(8, '100%', 7)).join('') + '</div></section>' +
      // sales
      '<section id="d2-sales" class="d2-card s6" style="--d:320ms"><div class="d2-ch"><div><h3>Units sold per week</h3><div class="d2-sub">From Amazon settlements · last 12 weeks</div></div><div class="d2-meta" id="d2wkmeta"></div></div><div class="d2-chart" id="d2wk">' + skChart(220) + '</div></section>' +
      '<section class="d2-card s6" style="--d:360ms"><div class="d2-ch"><div><h3>Monthly P&amp;L</h3><div class="d2-sub">Net sales vs. net profit · last 6 months</div></div><div class="d2-keys" id="d2pnlkeys"></div></div><div class="d2-chart" id="d2pnl">' + skChart(220) + '</div></section>' +
      // ops
      '<section id="d2-ops" class="d2-card s8" style="--d:400ms"><div class="d2-ch"><div><h3>Warehouse flow</h3><div class="d2-sub">Units received, prepped and shipped per day · last 30 days</div></div><div class="d2-keys" id="d2flowkeys"></div></div><div class="d2-chart" id="d2flow">' + skChart(230) + '</div></section>' +
      '<section class="d2-card s4" style="--d:440ms"><div class="d2-ch"><div><h3>Amazon deposits</h3><div class="d2-sub">Last settlements paid out</div></div><div class="d2-meta" id="d2depmeta"></div></div><div class="d2-chart" id="d2dep">' + skChart(230) + '</div></section>' +
      // alerts
      '<section id="d2-alerts" class="d2-card s6" style="--d:480ms"><div class="d2-ch"><div><h3>Needs attention</h3><div class="d2-sub">Low stock on the shelf and top sellers running thin</div></div></div><div id="d2alerts">' + [0, 1, 2, 3, 4].map(() => sk(14, '100%', 14)).join('') + '</div></section>' +
      '<section class="d2-card s6" style="--d:520ms"><div class="d2-ch"><div><h3>Recent activity</h3><div class="d2-sub" id="d2actsub">What moved in the warehouse</div></div></div><div id="d2act">' + [0, 1, 2, 3, 4].map(() => sk(14, '100%', 14)).join('') + '</div></section>' +
      '</main></div>';
  }

  function paintInventory(inv) {
    const hv = document.getElementById('d2hv'), hs = document.getElementById('d2hs'), pipe = document.getElementById('d2pipe');
    if (!hv) return;
    if (!inv) {
      hv.textContent = '—'; hs.textContent = 'No FBA Inventory pull yet';
      pipe.innerHTML = empty('box', 'No inventory snapshot yet', 'Pull FBA Inventory once and this shows every unit — shelf, prep, on the way and at Amazon — with its retail value.', { go: 'fbainv', label: 'Open FBA Inventory' });
      return;
    }
    const { t, V } = inv, hasV = V && V.havePrices;
    hv.textContent = '$0'; countUp(hv, hasV ? V.grandTotal : t.g, v => hasV ? '$' + n0(v) : n0(v));
    hs.innerHTML = '<b>' + n0(t.g) + '</b> units across the shelf, prep, transit and Amazon' + (hasV ? '' : ' · <span style="color:' + C.serious + '">no prices yet — values hidden</span>');
    const segs = [['Available', t.w, V.availValue, C.blue], ['Pending prep', t.pp, V.pendingValue, C.orange], ['Prepped', t.pr, V.preppedValue, C.aqua], ['In transit', t.t, V.transitValue, C.yellow], ['At FBA', t.f, V.fbaValue, C.magenta]];
    const tot = Math.max(1, t.g);
    document.getElementById('d2pipeat').textContent = inv.at ? 'Amazon counts ' + dShort(inv.at.toISOString().slice(0, 10)) : '';
    pipe.innerHTML = '<div class="d2-pipe">' + segs.filter(s => s[1] > 0).map((s, i) => '<i title="' + E(s[0] + ': ' + n0(s[1]) + ' units') + '" style="flex:' + s[1] / tot + ';background:' + s[3] + ';--d:' + (200 + i * 120) + 'ms"></i>').join('') + '</div>' +
      '<div class="d2-legend">' + segs.map(s => '<div class="d2-lg"><div class="k"><i style="background:' + s[3] + '"></i>' + s[0] + '</div><div class="v" data-c="' + s[1] + '">0</div><div class="m">' + (hasV ? money(s[2]) + ' retail' : Math.round(100 * s[1] / tot) + '% of units') + '</div></div>').join('') + '</div>';
    pipe.querySelectorAll('.v[data-c]').forEach(el => countUp(el, +el.dataset.c, n0));
  }
  function paintTiles(d) {
    const box = document.getElementById('d2tiles'); if (!box) return;
    const GO = ['checkin', 'transit', 'onhand-low', 'onhand-out'], GOTXT = ['Open Order Check-In →', 'Open In Transit →', 'Show low stock in On Hand →', 'Show out of stock in On Hand →'];
    const tile = (i, label, icon, tone, value, foot) => '<div class="d2-card d2-tile" role="button" tabindex="0" data-goto="' + GO[i] + '" style="--d:' + (120 + i * 60) + 'ms"><div class="t">' + label + '<span class="d2-ico" style="background:' + tone[0] + ';color:' + tone[1] + '">' + svg(icon) + '</span></div><div class="v" data-c="' + value + '">0</div><div class="f">' + foot + '</div><div class="go">' + GOTXT[i] + '</div></div>';
    if (!d) { box.innerHTML = '<div class="d2-card s12" style="grid-column:1/-1">' + empty('alert', 'Counts didn’t load', 'The warehouse summary couldn’t be reached. Refresh to try again.', null) + '</div>'; return; }
    const okT = ['#e9f7ec', '#0b7a0b'], warnT = ['#fff5e0', '#a86b00'], badT = ['#fdecec', '#b42d2d'], infoT = ['#e8f1fc', '#1f5fae'];
    box.innerHTML =
      tile(0, 'Invoices to check in', 'inbox', d.pendingInvoices ? infoT : okT, d.pendingInvoices || 0, d.pendingUnits ? n0(d.pendingUnits) + ' units on the way from Cosmoprof' : 'Nothing waiting — all caught up') +
      tile(1, 'Open FBA shipments', 'truck', infoT, d.openShipments || 0, 'Shipped, waiting for Amazon to receive') +
      tile(2, 'Low stock', 'alert', d.lowStock ? warnT : okT, d.lowStock || 0, d.lowStock ? '20 units or fewer on the shelf' : 'Every product above 20 units') +
      tile(3, 'Out of stock', 'off', d.outStock ? badT : okT, d.outStock || 0, (d.skus ? n0(d.skus) + ' SKUs tracked' : 'Products with none on the shelf'));
    box.querySelectorAll('.v[data-c]').forEach(el => countUp(el, +el.dataset.c, n0));
  }
  function paintFbaTrend(x) {
    const box = document.getElementById('d2fba'); if (!box) return;
    const rows = (x && x.fbaDaily) || [];
    if (rows.length < 2) {
      box.innerHTML = empty('chart', rows.length ? 'One day recorded — the line starts tomorrow' : 'Your history starts with the next pull', 'Every FBA Inventory pull saves a daily snapshot. After two days you’ll see units at Amazon and on the way, over time.', { go: 'fbainv', label: 'Open FBA Inventory' });
      document.getElementById('d2spark').innerHTML = '<div class="d2-sub" style="padding-top:14px">Trend appears after two FBA pulls</div>';
      return;
    }
    const keys = document.getElementById('d2fbakeys');
    keys.innerHTML = '<span><i style="background:' + C.blue + '"></i>At Amazon</span><span><i style="background:' + C.orange + '"></i>Inbound</span>';
    const draw = () => lineChart(box, { labels: rows.map(r => r.day), fmtLabel: dShort, aria: 'Units at Amazon and inbound by day',
      series: [{ name: 'At Amazon', color: C.blue, values: rows.map(r => r.onhand) }, { name: 'Inbound', color: C.orange, values: rows.map(r => r.inbound) }] });
    draw(); box._draw = draw;
    const sp = document.getElementById('d2spark'); sparkline(sp, rows.map(r => r.onhand + r.inbound), C.blue);
  }
  function paintTop(x) {
    const box = document.getElementById('d2top'); if (!box) return;
    const items = (x && x.topSellers) || [];
    if (!items.length) { box.innerHTML = empty('chart', 'No sales pulled yet', 'Load Velocity once and your best sellers line up here, by units sold.', { go: 'velocity', label: 'Open Velocity' }); return; }
    document.getElementById('d2topsub').textContent = 'Units sold' + (x.topSellersDays ? ' · last ' + x.topSellersDays + ' days' : '');
    hBars(box, items.map(i => ({ label: shortName(i.name || i.asin), html: sized(i.asin, i.name), title: i.name, value: i.sold })), {});
  }
  function paintWeekly(x) {
    const box = document.getElementById('d2wk'); if (!box) return;
    const rows = (x && x.salesWeekly) || [];
    if (!rows.length) { box.innerHTML = empty('dollar', 'No settlements imported yet', 'Import Amazon settlements in Data Sources and weekly units sold chart themselves here.', { go: 'fsrc', label: 'Open Data Sources' }); return; }
    const units = rows.reduce((t, r) => t + r.units, 0), sales = rows.reduce((t, r) => t + r.sales, 0);
    document.getElementById('d2wkmeta').textContent = n0(units) + ' units · ' + money(sales);
    const draw = () => columnChart(box, { labels: rows.map(r => r.week), fmtLabel: dShort, aria: 'Units sold per week', series: [{ name: 'Units sold', color: C.blue, values: rows.map(r => r.units) }] });
    draw(); box._draw = draw;
  }
  function paintPnl(p) {
    const box = document.getElementById('d2pnl'); if (!box) return;
    const months = ((p && p.months) || []).filter(m => m.hasData);
    if (!months.length) { box.innerHTML = empty('dollar', 'No P&L months yet', 'Once settlements are in, each month’s net sales and net profit show here side by side.', { go: 'fpnl', label: 'Open P&L' }); return; }
    document.getElementById('d2pnlkeys').innerHTML = '<span><i class="sq" style="background:' + C.blue + '"></i>Net sales</span><span><i class="sq" style="background:' + C.orange + '"></i>Net profit</span>';
    const draw = () => columnChart(box, { labels: months.map(m => m.month), fmtLabel: mShort, fmt: money, fmtAxis: money, aria: 'Net sales and net profit by month',
      series: [{ name: 'Net sales', color: C.blue, values: months.map(m => m.netSales || 0) }, { name: 'Net profit', color: C.orange, values: months.map(m => m.net || 0) }] });
    draw(); box._draw = draw;
  }
  function paintFlow(x) {
    const box = document.getElementById('d2flow'); if (!box) return;
    const rows = (x && x.flow) || [];
    if (!rows.some(r => r.received || r.prepped || r.shipped)) { box.innerHTML = empty('box', 'A quiet 30 days', 'Nothing was received, prepped or shipped in the last 30 days. Activity charts itself as soon as the floor gets moving.', null); return; }
    document.getElementById('d2flowkeys').innerHTML = '<span><i style="background:' + C.blue + '"></i>Received</span><span><i style="background:' + C.orange + '"></i>Prepped</span><span><i style="background:' + C.aqua + '"></i>Shipped</span>';
    const draw = () => lineChart(box, { labels: rows.map(r => r.day), fmtLabel: dShort, area: false, aria: 'Units received, prepped and shipped by day',
      series: [{ name: 'Received', color: C.blue, values: rows.map(r => r.received) }, { name: 'Prepped', color: C.orange, values: rows.map(r => r.prepped) }, { name: 'Shipped', color: C.aqua, values: rows.map(r => r.shipped) }] });
    draw(); box._draw = draw;
  }
  function paintDeposits(x) {
    const box = document.getElementById('d2dep'); if (!box) return;
    const rows = (x && x.deposits) || [];
    if (!rows.length) { box.innerHTML = empty('dollar', 'No deposits on file', 'Amazon deposits appear here once settlement reports are imported.', { go: 'fsrc', label: 'Open Data Sources' }); return; }
    document.getElementById('d2depmeta').textContent = money(rows.reduce((t, r) => t + r.amount, 0)) + ' total';
    const draw = () => columnChart(box, { labels: rows.map(r => r.date), fmtLabel: dShort, fmt: money, fmtAxis: money, aria: 'Amazon deposits', series: [{ name: 'Deposit', color: C.blue, values: rows.map(r => r.amount) }] });
    draw(); box._draw = draw;
  }
  // Short name + size tag (the page's amzLinkSized): most products come in
  // 4-5 sizes, so the size must show wherever a product is named (owner).
  const sized = (asin, name) => (asin && typeof amzLinkSized === 'function') ? amzLinkSized(asin, name) : E(shortName(name || asin));
  function shortName(s) { s = String(s || '').trim(); if (!s) return 'Unnamed product'; const c = s.split(',')[0].trim(); return c.length >= 12 ? c : s; }
  function paintAlerts(d) {
    const box = document.getElementById('d2alerts'); if (!box) return;
    const low = (d && d.lowList) || [], under = (d && d.underStocked) || [];
    if (!low.length && !under.length) { box.innerHTML = empty('bell', 'All clear', 'No product is running low and no top seller is under-stocked. Nice.', null); return; }
    const link = (a, n) => sized(a, n || a);
    const badge = (bg, fg, t) => '<span class="d2-badge" style="background:' + bg + ';color:' + fg + '">' + t + '</span>';
    box.innerHTML = '<div class="d2-rows">' +
      under.slice(0, 5).map(x => '<div class="d2-row"><div style="min-width:0">' + link(x.asin, x.name) + '<div class="d2-sub">Top seller · ' + n0(x.sold) + ' sold' + (x.revenue ? ' · ' + money(x.revenue) : '') + '</div></div>' + badge(x.onhand <= 20 ? '#fdecec' : '#fff5e0', x.onhand <= 20 ? '#b42d2d' : '#a86b00', svg('alert', ' style="width:12px;height:12px"') + ' ' + n0(x.onhand) + ' left') + '</div>').join('') +
      low.filter(x => !under.some(u => u.asin === x.asin)).slice(0, 6).map(x => '<div class="d2-row"><div style="min-width:0">' + link(x.asin, x.name) + '<div class="d2-sub">Low on the shelf</div></div>' + badge('#fff5e0', '#a86b00', svg('alert', ' style="width:12px;height:12px"') + ' ' + n0(x.onhand) + ' left') + '</div>').join('') + '</div>';
  }
  function paintActivity(d) {
    const box = document.getElementById('d2act'); if (!box) return;
    const ev = (d && d.recent) || [];
    if (!ev.length) { box.innerHTML = empty('clock', 'No activity yet today', 'Receiving, prep and shipping show up here the moment they happen.', null); return; }
    document.getElementById('d2actsub').textContent = (d.todayActivity || 0) + ' moves today';
    const KIND = { in: ['Received', C.blue], checkin: ['Checked in at FBA', C.aqua], out: ['Shipped', C.orange], prep: ['Prepped', C.magenta], adjust: ['Count adjusted', C.muted], undo: ['Undone', C.muted] };
    const kind = a => KIND[a.direction] || ['Moved', C.muted];
    const ago = ts => { const s = (Date.now() - new Date(ts)) / 1000; return s < 3600 ? Math.max(1, Math.round(s / 60)) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
    box.innerHTML = '<div class="d2-tl">' + ev.slice(0, 8).map(a => { const k = kind(a); return '<div class="d2-ev" style="--c:' + k[1] + '"><span><b>' + E(k[0]) + '</b> · ' + n0(a.qty) + ' × ' + sized(a.asin, a.name) + '</span><span class="w">' + E(ago(a.ts)) + '</span></div>'; }).join('') + '</div>';
  }

  // ---------- tiles → the screens behind them ----------
  function goTo(where) {
    const tabBtn = id => [...document.querySelectorAll('.tab')].find(t => (t.getAttribute('onclick') || '').indexOf("showTab('" + id + "'") >= 0);
    const open = id => { const b = tabBtn(id); if (typeof showTab === 'function' && b) showTab(id, { currentTarget: b, target: b }); window.scrollTo({ top: 0, behavior: REDUCED ? 'auto' : 'smooth' }); };
    if (where === 'checkin') open('reconcile');
    else if (where === 'transit') { if (typeof showSubTab === 'function') showSubTab('transit'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    else if (where === 'onhand-low' || where === 'onhand-out') {
      const f = document.getElementById('filterOnhand'); if (f) f.value = where === 'onhand-out' ? 'outstock' : 'lowstock';
      const q = document.getElementById('searchOnhand'); if (q) q.value = '';
      open('onhand');
    }
  }

  // ---------- gross sales ----------
  // Pick a period (Today / 7 days / 30 days / MTD / YTD / Custom); every
  // metric for it lines up underneath, each against the period before; click
  // a metric to chart it. Refunds, fees and returns are judged as a rate
  // (of sales or units), so a busy week isn't "worse" for being busy, and
  // settlement lag is compared like for like (only days settled in both).
  const PT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
  const ptDay = ms => PT.format(new Date(ms));
  const addD = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const span = (a, b) => { const o = []; for (let d = a; d <= b; d = addD(d, 1)) o.push(d); return o; };
  const nDays = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000) + 1;
  const hourLbl = h => (h % 12 || 12) + (h < 12 ? 'a' : 'p');
  const money2 = v => '$' + (v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = v => (v * 100).toFixed(1) + '%';
  const METRICS = [
    { k: 'sales', l: 'Gross sales', f: v => '$' + n0(v), chart: money },
    { k: 'orders', l: 'Orders', f: n0, chart: n0 },
    { k: 'units', l: 'Units sold', f: n0, chart: n0 },
    { k: 'aov', l: 'Avg order', f: money2, chart: money2 },
    { k: 'aup', l: 'Avg unit price', f: money2, chart: money2 },
    { k: 'refunds', l: 'Refunds', f: v => '$' + n0(v), chart: money, rate: 'of sales', bad: true },
    { k: 'fees', l: 'Amazon fees', f: v => '$' + n0(v), chart: money, rate: 'of sales', bad: true },
    { k: 'returns', l: 'Returns', f: v => n0(v) + ' units', chart: n0, rate: 'of units', bad: true }
  ];
  function dataMaps(x) {
    const M = {}, S = {}, R = {};
    ((x && x.salesDaily) || []).forEach(r => M[r.day] = r);
    ((x && x.settleDaily) || []).forEach(r => S[r.day] = r);
    ((x && x.returnsDaily) || []).forEach(r => R[r.day] = r);
    const sd = Object.keys(S).sort();
    return { M, S, R, settleFrom: sd[0] || null, settledThrough: (x && x.settledThrough) || null, returnsFrom: (x && x.returnsFrom) || null, T: ptDay(Date.now()) };
  }
  // value of every metric over a set of days (null = not covered)
  function measure(D, days) {
    const all = days.length && days.every(d => D.M[d]);
    const sum = f => days.reduce((t, d) => t + (D.M[d] ? (+D.M[d][f] || 0) : 0), 0);
    const out = {};
    out.sales = all ? sum('sales') : null; out.units = all ? sum('units') : null;
    out.orders = all && days.every(d => D.M[d].orders != null) ? sum('orders') : null;
    out.aov = out.orders ? out.sales / out.orders : null; out.aup = out.units ? out.sales / out.units : null;
    out.est = all ? sum('est') : 0;
    return out;
  }
  const settled = (D, d) => D.settleFrom && d >= D.settleFrom && D.settledThrough && d <= D.settledThrough;
  const returnsCovered = (D, d) => D.returnsFrom && d >= D.returnsFrom && d <= D.T;
  function lagged(D, cur, prev, kind) {
    // only the days covered in the current period, matched day-for-day in the previous one
    const ok = kind === 'returns' ? d => returnsCovered(D, d) : d => settled(D, d);
    const c = cur.filter(ok), p = prev.slice(0, c.length).filter(ok);
    if (!c.length) return { cur: null, prev: null, curRate: null, prevRate: null, through: kind === 'returns' ? null : D.settledThrough };
    const amt = days => kind === 'returns' ? days.reduce((t, d) => t + (D.R[d] ? D.R[d].units : 0), 0) : Math.abs(days.reduce((t, d) => t + (D.S[d] ? D.S[d][kind] : 0), 0));
    const base = days => { const m = measure(D, days); return kind === 'returns' ? m.units : m.sales; };
    const cA = amt(c), pA = p.length === c.length ? amt(p) : null, cB = base(c), pB = p.length === c.length ? base(p) : null;
    return { cur: cA, prev: pA, curRate: cB ? cA / cB : null, prevRate: pB ? pA / pB : null, partial: c.length < cur.length, through: c[c.length - 1], days: c.length };
  }
  function periods(x) {
    const D = dataMaps(x), T = D.T, Y = addD(T, -1), td = +T.slice(8), ty = +T.slice(0, 4);
    const mk = (k, label, cur, prev, curLbl, prevLbl) => {
      const c = measure(D, cur), pv = measure(D, prev), m = {};
      ['sales', 'orders', 'units', 'aov', 'aup'].forEach(f => m[f] = { cur: c[f], prev: pv[f] });
      ['refunds', 'fees', 'returns'].forEach(f => m[f] = lagged(D, cur, prev, f));
      return { k, label, curDays: cur, prevDays: prev, cur: c.sales, prev: pv.sales, est: c.est, m, curLbl, prevLbl, D };
    };
    const out = [];
    const st = x && x.salesToday, ok = st && st.today === T, h = ok ? st.nowHour : null;
    const upto = a => a ? a.slice(0, h + 1).reduce((s, v) => s + v, 0) : null;
    const tS = ok && st.todayStats, yS = ok && st.ydayStats;
    const tm = { sales: { cur: ok ? upto(st.todayHourly) : null, prev: ok ? upto(st.ydayHourly) : null },
                 orders: { cur: tS ? upto(tS.orders) : null, prev: yS ? upto(yS.orders) : null },
                 units: { cur: tS ? upto(tS.units) : null, prev: yS ? upto(yS.units) : null } };
    tm.aov = { cur: tm.orders.cur ? tm.sales.cur / tm.orders.cur : null, prev: tm.orders.prev ? tm.sales.prev / tm.orders.prev : null };
    tm.aup = { cur: tm.units.cur ? tm.sales.cur / tm.units.cur : null, prev: tm.units.prev ? tm.sales.prev / tm.units.prev : null };
    ['refunds', 'fees', 'returns'].forEach(f => tm[f] = { cur: null, prev: null, sameDay: true });
    out.push({ k: 'today', label: 'Today', cur: tm.sales.cur, prev: tm.sales.prev, m: tm, hourly: ok ? st : null, D,
               curLbl: 'so far', prevLbl: ok ? 'yesterday by ' + hourLbl((h + 1) % 24) : 'yesterday', est: ok && D.M[T] ? D.M[T].est : 0 });
    out.push(mk('7', '7 days', span(addD(T, -7), Y), span(addD(T, -14), addD(T, -8)), 'through yesterday', 'the 7 days before'));
    out.push(mk('30', '30 days', span(addD(T, -30), Y), span(addD(T, -60), addD(T, -31)), 'through yesterday', 'the 30 days before'));
    const m1 = T.slice(0, 8) + '01', pm1 = addD(m1, -1).slice(0, 8) + '01', pmEnd = addD(m1, -1);
    out.push(mk('mtd', 'Month to date', span(m1, T), span(pm1, pm1.slice(0, 8) + String(Math.min(td, +pmEnd.slice(8))).padStart(2, '0')), 'through today', 'same days last month'));
    out.push(mk('ytd', 'Year to date', span(ty + '-01-01', T), span((ty - 1) + '-01-01', (ty - 1) + '-' + T.slice(5, 7) + '-' + (T.slice(5) === '02-29' ? '28' : T.slice(8))), 'through today', 'same stretch last year'));
    // Custom: any from/to; compared with the same number of days just before
    let cf = store.get('d2From'), ct = store.get('d2To');
    if (!(cf && ct && cf <= ct)) { ct = Y; cf = addD(T, -14); }
    if (ct > T) ct = T;
    const len = nDays(cf, ct);
    out.push(mk('custom', 'Custom', span(cf, ct), span(addD(cf, -len), addD(cf, -1)), dShort(cf) + ' – ' + dShort(ct), 'the ' + len + ' days before'));
    return { list: out, D, rows: (x && x.salesDaily) || [] };
  }
  function deltaChip(cur, prev, bad, rate) {
    if (cur == null || prev == null) return '<span class="d2-delta flat">no comparison yet</span>';
    if (rate) {   // change in the rate, in points; up is bad
      const d = (cur - prev) * 100; if (Math.abs(d) < 0.05) return '<span class="d2-delta flat">— even</span>';
      const worse = d > 0; return '<span class="d2-delta ' + (worse ? 'down' : 'up') + '">' + (d > 0 ? '▲ ' : '▼ ') + Math.abs(d).toFixed(1) + ' pts</span>';
    }
    const d = cur - prev, p = prev > 0 ? d / prev * 100 : null, up = d >= 0, good = bad ? !up : up;
    if (Math.abs(d) < 0.005 || (p != null && Math.abs(p) < 0.05)) return '<span class="d2-delta flat">— even</span>';
    return '<span class="d2-delta ' + (good ? 'up' : 'down') + '">' + (up ? '▲' : '▼') + ' ' + (p != null ? Math.abs(p).toFixed(1) + '%' : '') + '</span>';
  }
  function moneyDelta(cur, prev) {
    if (cur == null || prev == null) return '';
    const d = cur - prev; return (d >= 0 ? '+' : '−') + '$' + n0(Math.abs(d));
  }
  function paintSales(x) {
    const per = document.getElementById('d2periods'); if (!per) return;
    state.sales = x;
    const P = periods(x), job = x && x.salesJob;
    const asof = document.getElementById('d2sasof'), note = document.getElementById('d2snote');
    if (job && job.running) { asof.textContent = job.progress || 'updating…'; document.getElementById('d2squick').disabled = true; }
    else { const st = x && x.salesToday; asof.textContent = st && st.asOf ? 'as of ' + new Date(st.asOf).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; }
    const strip = document.getElementById('d2metrics');
    if (!P.rows.length) {
      per.style.display = 'block'; if (strip) strip.innerHTML = '';
      per.innerHTML = empty('dollar', job && job.running ? 'Reading your orders from Amazon…' : 'Your sales history starts here',
        job && job.running ? (job.progress || 'This takes a few minutes. It keeps going if you leave the page.') : 'One pull reads your orders and returns back to January last year, so every period can be compared. It takes a few minutes and runs in the background.',
        job && job.running ? null : { go: '', label: 'Pull sales history' });
      const btn = per.querySelector('[data-go]'); if (btn) { btn.removeAttribute('data-go'); btn.dataset.act = 'sales-full'; }
      ['d2sales', 'd2stitle', 'd2skeys'].forEach(id => document.getElementById(id).innerHTML = '');
      return;
    }
    per.style.display = '';
    const sel = store.get('d2Per') || '30';
    per.innerHTML = P.list.map(p => '<button class="d2-per' + (p.k === sel ? ' on' : '') + (p.k === 'custom' ? ' custom' : '') + '" data-per="' + p.k + '"><div class="l">' + p.label + ' <span>· ' + E(p.curLbl) + '</span></div>' +
      '<div class="v">' + (p.cur == null ? '—' : '$' + n0(p.cur)) + '</div>' +
      '<div class="dl">' + deltaChip(p.cur, p.prev) + '<b class="' + (p.cur != null && p.prev != null ? (p.cur >= p.prev ? 'pos' : 'neg') : '') + '">' + moneyDelta(p.cur, p.prev) + '</b></div>' +
      '<div class="p">' + (p.prev == null ? 'vs ' + E(p.prevLbl) + ': not pulled yet' : 'vs $' + n0(p.prev) + ' ' + E(p.prevLbl)) + '</div></button>').join('');
    const p = P.list.find(z => z.k === sel) || P.list[2];
    // custom range picker
    let nt = '';
    if (p.k === 'custom') nt += '<div class="d2-note"><span style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b>Custom range</b> <input type="date" id="d2cf" value="' + p.curDays[0] + '" max="' + P.D.T + '"> to <input type="date" id="d2ct" value="' + p.curDays[p.curDays.length - 1] + '" max="' + P.D.T + '"></span><span style="font-size:11.5px;color:' + C.muted + '">compared with the ' + p.curDays.length + ' days just before</span><button class="d2-btn" data-act="custom-apply">Apply</button></div>';
    const missingPrev = P.list.some(z => z.k !== 'today' && z.k !== 'custom' && z.prev == null);
    if (missingPrev && !(job && job.running)) nt += '<div class="d2-note"><span>Some comparisons need older orders than the app has read yet.</span><button class="d2-btn ghost" data-act="sales-full">Pull full history (a few minutes)</button></div>';
    note.innerHTML = nt;
    // metrics for the chosen period
    const mSel = store.get('d2Metric') || 'sales';
    if (strip) strip.innerHTML = METRICS.map(mt => {
      const v = p.m[mt.k] || {}; let val, chip, sub;
      if (mt.rate) {
        if (v.sameDay) { val = '—'; chip = '<span class="d2-delta flat">not same-day</span>'; sub = mt.k === 'returns' ? 'Amazon reports returns daily' : 'arrives with settlements'; }
        else if (v.cur == null) { val = '—'; chip = '<span class="d2-delta flat">' + (mt.k === 'returns' ? 'not pulled yet' : 'not settled yet') + '</span>'; sub = mt.k === 'returns' ? 'pulled each morning' : (P.D.settledThrough ? 'settled through ' + dShort(P.D.settledThrough) : 'no settlements yet'); }
        else { val = mt.f(v.cur); chip = deltaChip(v.curRate, v.prevRate, true, true); sub = (v.curRate != null ? pct(v.curRate) + ' ' + mt.rate : '') + (v.partial ? ' · through ' + dShort(v.through) : ''); }
      } else { val = v.cur == null ? '—' : mt.f(v.cur); chip = deltaChip(v.cur, v.prev); sub = v.prev == null ? 'no comparison' : 'vs ' + mt.f(v.prev); }
      return '<button class="d2-met' + (mt.k === mSel ? ' on' : '') + '" data-met="' + mt.k + '"><div class="l">' + mt.l + '</div><div class="v">' + val + '</div>' + chip + '<div class="p">' + E(sub) + '</div></button>';
    }).join('');
    drawSales(p, METRICS.find(z => z.k === mSel) || METRICS[0]);
    const st = x.salesToday, age = st && st.asOf ? Date.now() - Date.parse(st.asOf) : Infinity;
    if (!(job && job.running) && age > 3600000 && !state.autoPulled) { state.autoPulled = true; salesPull('today'); }
  }
  // Bars: this period beside the previous one. Today by hour; long ranges
  // (Year to date, a custom range over 3 months) by month.
  function drawSales(p, mt) {
    const box = document.getElementById('d2sales'), title = document.getElementById('d2stitle'), keys = document.getElementById('d2skeys');
    // this period in Amazon orange (owner), the previous one gray
    const GRAY = '#b4bec7', CUR = '#ff9900', D = p.D;
    box._draw = null;
    const KN = { today: ['Today', 'Yesterday'], ytd: ['This year', 'Last year'] }[p.k] || ['This period', 'Previous period'];
    keys.innerHTML = '<span><i class="sq" style="background:' + CUR + '"></i>' + KN[0] + '</span><span><i class="sq" style="background:' + GRAY + '"></i>' + KN[1] + '</span>';
    let o;
    if (p.k === 'today') {
      const H = p.hourly;
      if (!H) { title.textContent = ''; box.innerHTML = empty('clock', 'Today’s numbers are on the way', 'Press Update today to read today’s orders from Amazon (about a minute).', null); return; }
      if (!['sales', 'orders', 'units', 'aov', 'aup'].includes(mt.k)) { title.textContent = ''; box.innerHTML = empty('clock', mt.l + ' don’t come same-day', mt.k === 'returns' ? 'Amazon reports returns once a day; pick 7 days or longer to see them.' : 'They arrive with Amazon’s settlements; pick 7 days or longer to see them.', null); return; }
      const T = H.todayStats || { sales: H.todayHourly }, Yd = H.ydayStats || { sales: H.ydayHourly };
      const ser = (s) => mt.k === 'aov' ? s.sales.map((v, i) => s.orders[i] ? v / s.orders[i] : null) : mt.k === 'aup' ? s.sales.map((v, i) => s.units[i] ? v / s.units[i] : null) : s[mt.k];
      title.textContent = mt.l + ' by hour · today vs. yesterday';
      o = { labels: [...Array(24).keys()], fmtLabel: hourLbl, aria: mt.l + ' by hour', fmt: mt.chart,
        series: [{ name: 'Today', color: CUR, values: (ser(T) || []).map((v, i) => i <= H.nowHour ? v : null) }, { name: 'Yesterday', color: GRAY, values: ser(Yd) || [] }] };
    } else {
      const monthly = p.k === 'ytd' || p.curDays.length > 92;
      // buckets of the current period; the previous period is cut into the same sizes, in order
      const cb = [];
      if (monthly) { let cur = null; p.curDays.forEach(d => { const m = d.slice(0, 7); if (!cur || cur.key !== m) cb.push(cur = { key: m, days: [] }); cur.days.push(d); }); }
      else p.curDays.forEach(d => cb.push({ key: d, days: [d] }));
      let i0 = 0; const pb = cb.map(b => { const ds = p.prevDays.slice(i0, i0 + b.days.length); i0 += b.days.length; return ds; });
      const val = days => {
        if (!days.length) return null;
        if (mt.k === 'refunds' || mt.k === 'fees') { if (!days.every(d => settled(D, d))) return null; return Math.abs(days.reduce((t, d) => t + (D.S[d] ? D.S[d][mt.k] : 0), 0)); }
        if (mt.k === 'returns') { if (!days.every(d => returnsCovered(D, d))) return null; return days.reduce((t, d) => t + (D.R[d] ? D.R[d].units : 0), 0); }
        const m = measure(D, days); return m[mt.k];
      };
      title.textContent = mt.l + (monthly ? ' by month · ' : ' by day · ') + dShort(p.curDays[0]) + ' – ' + dShort(p.curDays[p.curDays.length - 1]) + ' vs. ' + dShort(p.prevDays[0]) + ' – ' + dShort(p.prevDays[p.prevDays.length - 1]) +
        ((mt.k === 'refunds' || mt.k === 'fees') && D.settledThrough ? ' · settled through ' + dShort(D.settledThrough) : '');
      o = { labels: cb.map(b => b.key), fmtLabel: monthly ? mShort : dShort, aria: mt.l + ', this period vs previous', fmt: mt.chart,
        series: [{ name: KN[0], color: CUR, values: cb.map(b => val(b.days)) }, { name: KN[1], color: GRAY, values: pb.map(val) }],
        tipExtra: i => { const pd = pb[i]; const a = !monthly && D.M[cb[i].days[0]]; return '<div style="color:#9fb3bd;font-size:11px;margin-top:3px">' + (pd && pd.length ? 'previous: ' + (monthly ? mShort(pd[0].slice(0, 7)) + ' ' + pd[0].slice(0, 4) : dShort(pd[0])) : '') + (a && a.est && mt.k === 'sales' ? '<br>incl. ' + money(a.est) + ' pending, at list price' : '') + '</div>'; } };
    }
    o.fmtAxis = mt.chart === money2 ? money : mt.chart;
    const draw = () => columnChart(box, o);
    draw(); box._draw = draw;
  }
  function salesPull(mode) {
    const btn = document.getElementById('d2squick'); if (btn) btn.disabled = true;
    const asof = document.getElementById('d2sasof'); if (asof) asof.textContent = mode === 'full' ? 'reading your order history…' : 'reading today’s orders…';
    ownerApi('/api/sales/history', { method: 'POST', body: JSON.stringify({ mode }) }).then(() => {
      const poll = () => ownerApi('/api/sales/history/status').then(j => {
        if (!document.getElementById('d2sasof')) return;
        if (j && j.running) { document.getElementById('d2sasof').textContent = j.progress || 'updating…'; if (mode === 'full' && state.sales && !(state.sales.salesDaily || []).length) paintSales(Object.assign({}, state.sales, { salesJob: j })); setTimeout(poll, 4000); return; }
        if (btn) btn.disabled = false;
        if (j && j.error) { document.getElementById('d2sasof').textContent = 'Update failed: ' + j.error; return; }
        ownerApi('/api/dash2').then(x => { paintSales(x); if (mode !== 'full') settle(document.getElementById('d2sales')); });
      }).catch(() => setTimeout(poll, 6000));
      setTimeout(poll, 3000);
    }).catch(() => { if (btn) btn.disabled = false; if (asof) asof.textContent = 'Update failed — try again'; });
  }

  function wire(root) {
    root.addEventListener('click', e => {
      const t = e.target.closest('[data-goto]'); if (t && !e.target.closest('a')) { goTo(t.dataset.goto); return; }
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.per) { store.set('d2Per', b.dataset.per); if (state && state.sales) paintSales(state.sales); return; }
      if (b.dataset.met) { store.set('d2Metric', b.dataset.met); if (state && state.sales) paintSales(state.sales); return; }
      if (b.dataset.act === 'custom-apply') {
        const f = (document.getElementById('d2cf') || {}).value, t = (document.getElementById('d2ct') || {}).value;
        if (f && t && f <= t) { store.set('d2From', f); store.set('d2To', t); if (state && state.sales) paintSales(state.sales); }
        return;
      }
      if (b.dataset.act === 'sales-quick' || b.dataset.act === 'sales-full') { salesPull(b.dataset.act === 'sales-full' ? 'full' : 'today'); return; }
      if (b.dataset.sec) {
        root.querySelectorAll('.d2-nav button').forEach(x => x.classList.toggle('on', x === b));
        const t = document.getElementById('d2-' + b.dataset.sec); if (t) t.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
      } else if (b.dataset.act === 'collapse') {
        const c = !root.classList.contains('collapsed'); root.classList.toggle('collapsed', c); store.set('d2Side', c ? '1' : '0');
        setTimeout(redraw, 480);
      } else if (b.dataset.act === 'classic') { window.Dash2.setOn(false); }
      else if (b.dataset.act === 'refresh') { window._fbaData = null; render(state.el); }
      else if (b.dataset.go && typeof showSubTab === 'function') showSubTab(b.dataset.go);
    });
    root.addEventListener('keydown', e => { const t = e.target.closest && e.target.closest('[data-goto]'); if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); goTo(t.dataset.goto); } });
    // scroll-spy: highlight the section in view
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting) { const id = en.target.id.replace('d2-', ''); root.querySelectorAll('.d2-nav button').forEach(x => x.classList.toggle('on', x.dataset.sec === id)); } }), { rootMargin: '-30% 0px -60% 0px' });
      SECTIONS.forEach(s => { const el = document.getElementById('d2-' + s[0]); if (el) io.observe(el); });
    }
    if (ro) ro.disconnect();
    if ('ResizeObserver' in window) { let tm; ro = new ResizeObserver(() => { clearTimeout(tm); tm = setTimeout(redraw, 160); }); ro.observe(root.querySelector('.d2-main')); }
  }
  // Show a chart in its final state (no entrance replay).
  function settle(box) { if (box) box.querySelectorAll('.d2-draw,.d2-area,.d2-bar').forEach(z => { z.style.animation = 'none'; z.style.opacity = 1; z.style.strokeDashoffset = 0; z.style.transform = 'none'; }); }
  // Redraw charts at the new width without replaying the entrance.
  function redraw() {
    const root = document.getElementById('d2root'); if (!root) return;
    // only charts still showing a chart (an empty state replaced the svg)
    root.querySelectorAll('.d2-chart').forEach(b => { if (b._draw && b.querySelector('svg')) { b._draw(); b.querySelectorAll('.d2-draw,.d2-area,.d2-bar').forEach(z => { z.style.animation = 'none'; z.style.opacity = 1; z.style.strokeDashoffset = 0; z.style.transform = 'none'; }); } });
    const sp = document.getElementById('d2spark'); if (sp && sp.querySelector('svg') && state && state.spark) sparkline(sp, state.spark, C.blue);
  }

  function render(el) {
    injectCss();
    state = { el };
    el.innerHTML = shell();
    // sit below the app's sticky header, not under it
    const hd = document.querySelector('header'); el.querySelector('#d2root').style.setProperty('--d2top', ((hd && getComputedStyle(hd).position === 'sticky') ? hd.offsetHeight + 12 : 12) + 'px');
    const root = el.querySelector('#d2root'); wire(root);
    const stamp = () => { const u = document.getElementById('d2upd'); if (u) u.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
    // An error reply ({ok:false,error}) must read as "didn't load", not as zeros.
    const ok = d => { if (!d || d.ok === false || d.error) throw new Error((d && d.error) || 'no data'); return d; };
    inventory().then(paintInventory).catch(() => paintInventory(null));
    api('/api/dashboard').then(ok).then(d => { paintTiles(d); paintAlerts(d); paintActivity(d); stamp(); }).catch(() => { paintTiles(null); paintAlerts(null); paintActivity(null); });
    ownerApi('/api/dash2').then(ok).then(x => { if (x && x.fbaDaily && x.fbaDaily.length > 1) state.spark = x.fbaDaily.map(r => r.onhand + r.inbound); paintSales(x); paintFbaTrend(x); paintTop(x); paintWeekly(x); paintFlow(x); paintDeposits(x); })
      .catch(() => { paintSales(null); paintFbaTrend(null); paintTop(null); paintWeekly(null); paintFlow(null); paintDeposits(null); });
    ownerApi('/api/finance/pnl?months=6').then(ok).then(paintPnl).catch(() => paintPnl(null));
  }

  window.Dash2 = {
    render,
    isOn() { return store.get('dashView') !== 'classic'; },
    setOn(on) { store.set('dashView', on ? 'new' : 'classic'); if (typeof loadDashboard === 'function') loadDashboard(); }
  };
})();
