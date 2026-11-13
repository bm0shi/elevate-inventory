// BOLD look: light / dark, per device (owner 11/13: "there's a light mode and
// dark mode right"). Loaded from index.html's head only when this device is on
// the Bold look (html.n3).
//
// look3.css carries the dark TOKENS (html.n3.dk). This file does the rest:
// the app writes thousands of colours straight into style="" (index.html) and
// into the CSS that onhand2.js / dash2.js / palette.js inject, none of them
// tokens. Rather than rewrite every screen, dark mode turns each of those
// colours dark where it is used, by its job:
//   a background that is light  → the dark card family (a light tint keeps its hue)
//   text that is dark           → light (coloured text keeps its hue, brighter)
//   a border that is light      → a faint line
// Saturated mid-tones (buttons, status colours, the orange mark) are left
// alone, and so is dark text sitting on its own bright background.
// Every change is remembered (what it was, what it became), so switching back
// to light, or printing, puts each colour back exactly. Nothing here touches
// what a button does.
(function () {
  'use strict';
  const root = document.documentElement;
  if (!root.classList.contains('n3')) return;
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

  // ---------- colour maths ----------
  const NAMED = { white: [255, 255, 255, 1], black: [0, 0, 0, 1] };
  function parse(tok) {
    const t = tok.trim().toLowerCase();
    if (NAMED[t]) { const n = NAMED[t]; return { r: n[0], g: n[1], b: n[2], a: n[3] }; }
    if (t[0] === '#') {
      let h = t.slice(1); if (h.length === 3 || h.length === 4) h = h.split('').map(x => x + x).join('');
      if (h.length !== 6 && h.length !== 8) return null;
      const n = parseInt(h.slice(0, 6), 16); if (isNaN(n)) return null;
      return { r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255, a: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
    }
    const m = t.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
    if (!m) return null;
    let a = m[4] == null ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  function hsl(c) {
    const r = c.r / 255, g = c.g / 255, b = c.b / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    let h = 0, s = 0;
    if (d) { s = d / (1 - Math.abs(2 * l - 1)); h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
    return { h, s, l, a: c.a };
  }
  function css(h, s, l, a) {
    s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
    const k = n => (n + h / 30) % 12, f = n => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    const v = [f(0), f(8), f(4)].map(x => Math.round(x * 255));
    return a < 1 ? `rgba(${v[0]}, ${v[1]}, ${v[2]}, ${Math.round(a * 1000) / 1000})` : `rgb(${v[0]}, ${v[1]}, ${v[2]})`;
  }
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  // The three jobs. Each returns the dark colour, or null to leave it.
  const MAP = {
    bg(c) {
      if (c.a === 0) return null;
      if (c.l >= 0.8) {
        if (c.s < 0.18 || c.l > 0.975) return css(205, 0.22, 0.10 + (1 - c.l) * 0.9, c.a);       // white / light grey → the card family
        return css(c.h, Math.min(c.s, 0.6) * 0.85, 0.15 + (1 - c.l) * 0.55, c.a);                   // a light tint keeps its hue
      }
      if (c.l >= 0.5 && c.s < 0.2) return css(205, 0.14, 0.12 + (1 - c.l) * 0.6, c.a);              // mid grey
      return null;                                                                                    // buttons, status, already dark
    },
    text(c) {
      if (c.a === 0 || c.l >= 0.55) return null;
      if (c.s < 0.2 || c.l < 0.14) return css(205, 0.12, clamp(1 - c.l * 0.6, 0.62, 0.96), c.a);    // ink → near white
      return css(c.h, Math.min(c.s, 0.9), clamp(0.64 + (0.5 - c.l) * 0.25, 0.62, 0.78), c.a);       // coloured text, brighter
    },
    border(c) {
      if (c.a === 0) return null;
      if (c.l >= 0.5) return (c.s < 0.2 || c.l > 0.975) ? css(205, 0.14, 0.17 + (1 - c.l) * 0.5, c.a) : css(c.h, c.s * 0.6, 0.32, c.a);
      if (c.l < 0.25) return css(c.h, Math.min(c.s, 0.6), 0.5, c.a);                                // a dark outline would vanish
      return null;
    },
  };
  const TOKEN = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/gi;
  function mapValue(role, val) {
    let hit = false;
    const out = val.replace(TOKEN, tok => { const c = parse(tok); if (!c) return tok; const m = MAP[role](hsl(c)); if (m == null) return tok; hit = true; return m; });
    return hit ? out : null;
  }
  const ROLE = { 'background-color': 'bg', 'background-image': 'bg', color: 'text', 'caret-color': 'text', 'text-decoration-color': 'text', '-webkit-text-fill-color': 'text',
    'border-top-color': 'border', 'border-right-color': 'border', 'border-bottom-color': 'border', 'border-left-color': 'border', 'outline-color': 'border', 'column-rule-color': 'border' };
  const ORDER = { bg: 0, border: 1, text: 2 };

  // ---------- one style block (an element's style="" or a stylesheet rule) ----------
  const seen = new WeakMap();           // CSSStyleDeclaration → Map(prop → [was, became])
  // An element's style="" is never rewritten through el.style: that makes the
  // browser re-spell the whole attribute ("background:#fff;" → "background:
  // rgb(…)"), and look2.css / look3.css recognise buttons by that exact text
  // (button.action[style*="background:#fff;"]); the first try turned "Send
  // back to On Hand" into a primary button. The dark colours are ADDED after
  // the original text instead (a later declaration wins), and light mode puts
  // the original text back.
  const elText = new WeakMap();         // element → [original style text, text with the dark colours added]
  function paintEl(el) {
    const cur = el.getAttribute('style'); if (cur == null) return;
    const t = elText.get(el); if (t && t[1] === cur) return;
    const add = paint(el.style, true); if (!add || !add.length) return;
    const next = cur.replace(/[;\s]*$/, '') + ';' + add.map(a => a[0] + ':' + a[1] + (a[2] ? ' !important' : '')).join(';');
    el.setAttribute('style', next);
    const rec = seen.get(el.style); add.forEach(a => rec.set(a[0], [a[3], el.style.getPropertyValue(a[0])]));
    // painted before and changed by the app since: the first text is no longer the whole truth
    elText.set(el, [t ? null : cur, next]);
  }
  function unpaintEl(el) {
    const t = elText.get(el);
    if (t && t[0] != null && el.getAttribute('style') === t[1]) { el.setAttribute('style', t[0]); seen.delete(el.style); }
    else unpaint(el.style);            // the app changed it since: put each colour back one by one
    elText.delete(el);
  }
  function paint(style, collect) {
    let rec = seen.get(style); const out = collect ? [] : null;
    const props = [];
    for (let i = 0; i < style.length; i++) { const p = style[i]; if (ROLE[p]) props.push(p); }
    if (!props.length) return;
    props.sort((a, b) => ORDER[ROLE[a]] - ORDER[ROLE[b]]);
    let ownBright = false;              // dark text on its own bright background stays dark
    for (const p of props) {
      const cur = style.getPropertyValue(p);
      if (!cur || cur.indexOf('var(') >= 0) continue;
      const known = rec && rec.get(p);
      const role = ROLE[p];
      if (p === 'background-color') {
        const was = known && known[1] === cur ? known[0] : cur, c = parse(was);
        if (c && c.a > 0.5) { const h = hsl(c); if (MAP.bg(h) == null && h.l >= 0.45) ownBright = true; }
      }
      if (known && known[1] === cur) continue;                       // already done
      if (role === 'text' && ownBright) { if (known) rec.delete(p); continue; }
      const m = mapValue(role, cur);
      if (m == null) { if (known) rec.delete(p); continue; }
      if (!rec) { rec = new Map(); seen.set(style, rec); }
      if (collect) { out.push([p, m, style.getPropertyPriority(p), cur]); continue; }
      style.setProperty(p, m, style.getPropertyPriority(p));
      rec.set(p, [cur, style.getPropertyValue(p)]);
    }
    return out;
  }
  function unpaint(style) {
    const rec = seen.get(style); if (!rec) return;
    rec.forEach((v, p) => { if (style.getPropertyValue(p) === v[1]) style.setProperty(p, v[0], style.getPropertyPriority(p)); });
    seen.delete(style);
  }

  // SVG charts carry colours as attributes (fill="#45545f").
  const svgSeen = new WeakMap();
  function paintSvg(el) {
    for (const a of ['fill', 'stroke']) {
      const cur = el.getAttribute(a); if (!cur || cur === 'none' || cur === 'currentColor' || cur.indexOf('url(') === 0) continue;
      const rec = svgSeen.get(el) || {}; if (rec[a] && rec[a][1] === cur) continue;
      const isText = /^(text|tspan)$/i.test(el.tagName);
      const m = mapValue(a === 'stroke' ? 'border' : isText ? 'text' : 'bg', cur);
      if (m == null) continue;
      el.setAttribute(a, m); rec[a] = [cur, m]; svgSeen.set(el, rec);
    }
  }
  function unpaintSvg(el) { const rec = svgSeen.get(el); if (!rec) return; for (const a in rec) if (el.getAttribute(a) === rec[a][1]) el.setAttribute(a, rec[a][0]); svgSeen.delete(el); }

  // ---------- the page ----------
  function eachRule(list, fn) {
    for (const r of list) {
      if (r.style && r.selectorText != null) fn(r.style);
      else if (r.cssRules && !/keyframes/i.test(r.constructor.name)) { try { eachRule(r.cssRules, fn); } catch (e) {} }
    }
  }
  function eachSheet(fn) {
    for (const s of document.styleSheets) {
      if (s.href && /\/look3\.css/.test(s.href)) continue;          // hand-made dark tokens: not ours to touch
      let rules; try { rules = s.cssRules; } catch (e) { continue; } // another site's sheet (fonts)
      eachRule(rules, fn);
    }
  }
  function tree(node, style, svg) {
    if (node.nodeType !== 1) return;
    if (node.hasAttribute('style')) style(node);
    if (node.namespaceURI === 'http://www.w3.org/2000/svg') svg(node);
    const kids = node.querySelectorAll('[style],svg [fill],svg [stroke]');
    for (const k of kids) { if (k.hasAttribute('style')) style(k); if (k.namespaceURI === 'http://www.w3.org/2000/svg') svg(k); }
  }
  let on = false, sheetCount = -1;
  function sheets() { sheetCount = document.styleSheets.length; eachSheet(paint); }
  const mo = new MutationObserver(list => {
    if (!on) return;
    let css = document.styleSheets.length !== sheetCount;
    for (const m of list) {
      if (m.type === 'attributes') { const t = m.target; if (m.attributeName === 'style') paintEl(t); else paintSvg(t); continue; }
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) { if (n.nodeType === 3 && n.parentNode && n.parentNode.nodeName === 'STYLE') css = true; continue; }
        if (n.nodeName === 'STYLE') css = true;
        else if (n.nodeName === 'LINK') { css = true; n.addEventListener('load', () => on && sheets()); }
        tree(n, paintEl, paintSvg);
      }
    }
    if (css) sheets();
  });
  function dark(v) {
    if (v === on) return;
    on = v; root.classList.toggle('dk', v);
    if (v) {
      sheets(); if (document.body) tree(document.body, paintEl, paintSvg);
      mo.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'fill', 'stroke'] });
    } else {
      mo.disconnect(); eachSheet(unpaint); if (document.body) tree(document.body, unpaintEl, unpaintSvg);
    }
    label();
  }
  function label() { const b = document.getElementById('n3DarkBtn'); if (b) b.textContent = on ? '☀ Light' : '☾ Dark'; }

  // The header's Light / Dark button. Remembered per device.
  window.setAppDark = function (v) { v = v == null ? !on : !!v; store.set('appDark', v ? '1' : '0'); dark(v); };
  window.appIsDark = () => on;
  if (store.get('appDark') === '1') dark(true);
  document.addEventListener('DOMContentLoaded', () => { label(); if (on) { sheets(); tree(document.body, paintEl, paintSvg); } });
  window.addEventListener('load', () => { if (on) sheets(); });
  // Paper is white: print in the light colours, then go back.
  let printing = false;
  window.addEventListener('beforeprint', () => { if (on) { printing = true; dark(false); } });
  window.addEventListener('afterprint', () => { if (printing) { printing = false; dark(true); } });
})();
