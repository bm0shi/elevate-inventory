// Tablet mode for the floor (owner's #6), per device: html.tablet, switched
// with the header's "Tablet" button (localStorage tabletMode='1'; the class is
// set in index.html's head so the first paint is already big).
//   - big touch targets everywhere, a big scan box, big messages;
//   - the screen stays awake (Wake Lock) while the app is open;
//   - an Online / Offline pill that really checks the server (/api/ping), with
//     the scans saved on this device while offline (the offline queue in
//     index.html sends them when it's back);
//   - the scan box keeps the cursor, so a scanner gun always lands in it, and
//     the on-screen keyboard stays down (inputmode=none) until ⌨ is tapped.
// Works in both looks. Nothing here changes stock: scans go through the same
// handlers as before (scanFeedback / scanError already beep, buzz and flash).
(function () {
  'use strict';
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  const on = () => document.documentElement.classList.contains('tablet');
  const SCANS = { receive: ['scanIn'], prep: ['scanPrep'], ship: ['scanOut'], reconcile: ['scanRecon'], prod: ['mixScan', 'prodScan'] };

  const CSS = `
  html.tablet button.action{min-height:52px;font-size:16px!important;padding:14px 20px!important}
  html.tablet .mini{min-height:42px;padding:10px 16px!important;font-size:14px!important}
  html.tablet .tab{font-size:15px!important;padding-top:18px!important;padding-bottom:16px!important}
  html.tablet input[type=text],html.tablet input[type=number],html.tablet input[type=search],html.tablet input[type=password]{min-height:54px;font-size:19px!important}
  html.tablet select{min-height:50px;font-size:16px!important}
  html.tablet input[type=checkbox]{width:26px!important;height:26px!important}
  html.tablet .copybtn{font-size:20px;padding:8px 10px}
  /* the small inline buttons on job cards: + Add prepper, leave, Release all, edit */
  html.tablet .pcard button:not(.action):not(.copybtn){min-height:40px;padding:8px 14px!important;font-size:14px!important}
  html.tablet .viewtoggle button{padding:12px 18px!important;font-size:15px!important}
  html.tablet .subtab{padding:10px 16px!important;font-size:14.5px!important}
  html.tablet .toast{font-size:21px!important;padding:18px 28px!important;bottom:28px!important;max-width:92vw;text-align:center}
  html.tablet #scanIn,html.tablet #scanPrep,html.tablet #scanOut,html.tablet #scanRecon,html.tablet #prodScan,html.tablet #mixScan{min-height:70px;font-size:26px!important;font-weight:700;letter-spacing:.5px}
  .tb-kb{display:none}
  html.tablet .tb-kb{display:inline-flex;align-items:center;justify-content:center;min-width:56px;border-radius:10px;border:1px solid #d5dde3;background:#fff;color:#0d4450;font-size:22px;cursor:pointer;margin-left:8px}
  html.tablet .tb-kb.on{background:#0d4450;color:#fff;border-color:#0d4450}
  #tbNet{display:none}
  html.tablet #tbNet{display:inline-flex;align-items:center;gap:7px}
  #tbNet i{width:9px;height:9px;border-radius:50%;background:#3ccf62;box-shadow:0 0 0 3px rgba(60,207,98,.25)}
  #tbNet.off i{background:#ff6b6b;box-shadow:0 0 0 3px rgba(255,107,107,.25);animation:tbp 1.2s infinite}
  @keyframes tbp{50%{opacity:.35}}
  @media (prefers-reduced-motion:reduce){#tbNet.off i{animation:none}}
  `;
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

  // ---- header: the switch + the connection pill ----
  const pillStyle = 'margin-left:6px;padding:3px 10px;font-size:11px;border:none;border-radius:10px;cursor:pointer;font-weight:700';
  function header() {
    const sub = document.querySelector('header .sub'); if (!sub || document.getElementById('tbBtn')) return;
    const net = document.createElement('button'); net.id = 'tbNet'; net.type = 'button';
    net.setAttribute('style', pillStyle + ';background:#1e8449;color:#fff');
    net.title = 'Is this tablet reaching the server? Offline scans are saved here and sent when it is back.';
    net.addEventListener('click', () => { ping(); if (typeof flushOffline === 'function') flushOffline(true); });
    const b = document.createElement('button'); b.id = 'tbBtn'; b.type = 'button';
    b.setAttribute('style', pillStyle + ';background:#0d4450;color:#fff');
    b.title = 'Tablet mode on THIS device: big buttons, big scan box, screen stays on';
    b.addEventListener('click', () => set(!on()));
    const size = document.getElementById('uiScaleBtn');
    sub.insertBefore(b, size ? size.nextSibling : null);
    sub.insertBefore(net, b);
    paintBtn(); paintNet();
  }
  function paintBtn() { const b = document.getElementById('tbBtn'); if (b) b.textContent = '📱 Tablet: ' + (on() ? 'ON' : 'OFF'); }

  function set(v) {
    store.set('tabletMode', v ? '1' : '0');
    document.documentElement.classList.toggle('tablet', !!v);
    paintBtn(); kbButtons(); wake(); ping();
    if (typeof toast === 'function') toast(v ? 'Tablet mode on for this device' : 'Tablet mode off');
  }

  // ---- connection: the server answering, not just Wi-Fi being up ----
  let online = true, pinging = false;
  async function ping() {
    if (!on() || pinging) return; pinging = true;
    const ctl = 'AbortController' in window ? new AbortController() : null;
    const t = setTimeout(() => ctl && ctl.abort(), 6000);
    try { const r = await fetch('/api/ping', { cache: 'no-store', signal: ctl ? ctl.signal : undefined }); online = r.ok; }
    catch (e) { online = false; }
    finally { clearTimeout(t); pinging = false; }
    paintNet();
  }
  function paintNet() {
    const el = document.getElementById('tbNet'); if (!el) return;
    let waiting = 0; try { waiting = typeof offlineLoad === 'function' ? offlineLoad().length : 0; } catch (e) {}
    el.className = online ? '' : 'off';
    // !important: the new look's header gives every pill the same glass background
    el.style.setProperty('background', online ? (waiting ? '#b7791f' : '#1e8449') : '#b42d2d', 'important');
    el.innerHTML = '<i></i>' + (online ? (waiting ? 'Online · sending ' + waiting : 'Online') : 'Offline' + (waiting ? ' · ' + waiting + ' saved here' : ' · scans save here'));
  }
  setInterval(ping, 20000);
  setInterval(paintNet, 3000);
  window.addEventListener('online', ping);
  window.addEventListener('offline', () => { online = false; paintNet(); });

  // ---- keep the screen awake ----
  let lock = null;
  async function wake() {
    try {
      if (on() && 'wakeLock' in navigator && document.visibilityState === 'visible' && !lock) {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
      } else if (!on() && lock) { await lock.release(); lock = null; }
    } catch (e) { lock = null; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { wake(); ping(); } });

  // ---- the scan box keeps the cursor; ⌨ brings the keyboard up to type ----
  function scanBoxes() { return Object.values(SCANS).flat().map(id => document.getElementById(id)).filter(Boolean); }
  function kbButtons() {
    scanBoxes().forEach(inp => {
      const typing = inp.dataset.tbType === '1';
      if (on() && !typing) inp.setAttribute('inputmode', 'none'); else inp.removeAttribute('inputmode');
      let k = inp.nextElementSibling;
      if (!k || !k.classList || !k.classList.contains('tb-kb')) {
        k = document.createElement('button'); k.type = 'button'; k.className = 'tb-kb'; k.textContent = '⌨';
        k.title = 'Type instead of scanning';
        k.addEventListener('click', () => {
          const t = inp.dataset.tbType !== '1'; inp.dataset.tbType = t ? '1' : '';
          if (t) inp.removeAttribute('inputmode'); else if (on()) inp.setAttribute('inputmode', 'none');
          k.classList.toggle('on', t); inp.blur(); setTimeout(() => inp.focus(), 30);
        });
        inp.insertAdjacentElement('afterend', k);
      }
      k.classList.toggle('on', typing);
    });
  }
  function busy() {
    if (window.Palette && document.querySelector('.pal-back') && document.querySelector('.pal-back').style.display !== 'none') return true;
    const a = document.activeElement;
    if (a && a !== document.body && a !== document.documentElement) return true; // someone is typing / picking somewhere
    if ((window.getSelection && String(window.getSelection())) !== '') return true;
    return false;
  }
  function keepFocus() {
    if (!on() || busy() || document.visibilityState !== 'visible') return;
    const panel = document.querySelector('.panel.active'); if (!panel) return;
    const ids = SCANS[panel.id]; if (!ids) return;
    const inp = ids.map(id => document.getElementById(id)).find(el => el && el.offsetParent !== null && !el.disabled);
    if (inp) { kbButtons(); try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); } }
  }
  setInterval(keepFocus, 1200);

  function start() {
    header();
    if (on()) { kbButtons(); wake(); ping(); }
    // scan boxes drawn later (Shipment Production, an invoice opened) get the ⌨ too
    if ('MutationObserver' in window) {
      let q = null;
      new MutationObserver(() => { if (!on() || q) return; q = setTimeout(() => { q = null; kbButtons(); }, 300); })
        .observe(document.body, { childList: true, subtree: true });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.Tablet = { set, on };
})();
