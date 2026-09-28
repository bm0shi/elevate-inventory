// ============================================================
// ROUGH LTL FREIGHT ESTIMATE (New shipment → destination options). Pure.
// Amazon won't quote partnered freight until a placement option is
// confirmed (FBA_INB_0344), and confirming locks the destination, so the
// owner couldn't weigh a split (no placement fee, 5 small pallets across the
// country) against one warehouse (a fee, fewer pallets). This is our own
// estimate: distance ship-from → warehouse city × a per-pallet LTL rate,
// scaled by pallet weight, then corrected by what our own shipments really
// cost (calibrate). Shown as ±25–35%: good for a clear winner, not a close
// call. Nothing here is sent to Amazon.
// ============================================================

// Approximate coordinates. Cities first (Amazon FC towns and big metros,
// where a state centroid would be hundreds of miles off), then state
// centroids as the fallback.
const CITY = {
  'AZ|PHOENIX': [33.45, -112.07], 'AZ|GLENDALE': [33.54, -112.19], 'AZ|GOODYEAR': [33.44, -112.36], 'AZ|LITCHFIELD PARK': [33.49, -112.36],
  'AZ|TOLLESON': [33.45, -112.26], 'AZ|TUCSON': [32.22, -110.97], 'AZ|MESA': [33.42, -111.83], 'AZ|CHANDLER': [33.31, -111.84],
  'CA|MORENO VALLEY': [33.94, -117.23], 'CA|SAN BERNARDINO': [34.11, -117.29], 'CA|ONTARIO': [34.06, -117.65], 'CA|RIALTO': [34.11, -117.37],
  'CA|FONTANA': [34.09, -117.44], 'CA|REDLANDS': [34.06, -117.18], 'CA|RIVERSIDE': [33.95, -117.40], 'CA|PERRIS': [33.78, -117.23],
  'CA|BEAUMONT': [33.93, -116.98], 'CA|VICTORVILLE': [34.54, -117.29], 'CA|LONG BEACH': [33.77, -118.19], 'CA|LOS ANGELES': [34.05, -118.24],
  'CA|STOCKTON': [37.96, -121.29], 'CA|TRACY': [37.74, -121.43], 'CA|PATTERSON': [37.47, -121.13], 'CA|SACRAMENTO': [38.58, -121.49],
  'CA|VACAVILLE': [38.36, -121.99], 'CA|NEWARK': [37.53, -122.04], 'CA|SAN DIEGO': [32.72, -117.16], 'CA|FRESNO': [36.74, -119.79],
  'TX|HOUSTON': [29.76, -95.37], 'TX|KATY': [29.79, -95.82], 'TX|DALLAS': [32.78, -96.80], 'TX|FORT WORTH': [32.76, -97.33],
  'TX|HASLET': [32.97, -97.35], 'TX|COPPELL': [32.95, -96.99], 'TX|SAN ANTONIO': [29.42, -98.49], 'TX|SCHERTZ': [29.55, -98.27],
  'TX|AUSTIN': [30.27, -97.74], 'TX|EL PASO': [31.76, -106.49], 'TX|ROBINSON': [31.47, -97.12], 'TX|SHERTZ': [29.55, -98.27],
  'FL|JACKSONVILLE': [30.33, -81.66], 'FL|ORLANDO': [28.54, -81.38], 'FL|TAMPA': [27.95, -82.46], 'FL|LAKELAND': [28.04, -81.95],
  'FL|MIAMI': [25.76, -80.19], 'FL|DAVENPORT': [28.16, -81.60], 'FL|RUSKIN': [27.72, -82.43],
  'NY|NEW YORK': [40.71, -74.01], 'NY|STATEN ISLAND': [40.58, -74.15], 'NY|SCHODACK': [42.53, -73.68], 'NY|SYRACUSE': [43.05, -76.15],
  'IL|JOLIET': [41.53, -88.08], 'IL|CHICAGO': [41.88, -87.63], 'IL|AURORA': [41.76, -88.32], 'IL|MONEE': [41.42, -87.74], 'IL|EDWARDSVILLE': [38.81, -89.95],
  'PA|ALLENTOWN': [40.60, -75.49], 'PA|CARLISLE': [40.20, -77.19], 'PA|PITTSBURGH': [40.44, -80.00], 'PA|HAZLETON': [40.96, -75.97],
  'GA|ATLANTA': [33.75, -84.39], 'GA|MACON': [32.84, -83.63], 'GA|UNION CITY': [33.59, -84.54], 'GA|JEFFERSON': [34.12, -83.57],
  'OH|PERRYSBURG': [41.56, -83.63], 'OH|COLUMBUS': [39.96, -83.00], 'OH|WEST JEFFERSON': [39.94, -83.27], 'OH|MONROE': [39.44, -84.36],
  'WA|PASCO': [46.24, -119.10], 'WA|KENT': [47.38, -122.23], 'WA|DUPONT': [47.10, -122.63], 'WA|SEATTLE': [47.61, -122.33], 'WA|SPOKANE': [47.66, -117.43],
  'MD|HAGERSTOWN': [39.64, -77.72], 'MD|BALTIMORE': [39.29, -76.61], 'TN|CLARKSVILLE': [36.53, -87.36], 'TN|MEMPHIS': [35.15, -90.05],
  'TN|NASHVILLE': [36.16, -86.78], 'TN|LEBANON': [36.21, -86.29], 'TN|MURFREESBORO': [35.85, -86.39], 'TN|CHATTANOOGA': [35.05, -85.31],
  'NJ|ROBBINSVILLE': [40.21, -74.62], 'NJ|EDISON': [40.52, -74.41], 'NJ|NEWARK': [40.74, -74.17], 'IN|INDIANAPOLIS': [39.77, -86.16],
  'IN|WHITESTOWN': [39.99, -86.35], 'IN|PLAINFIELD': [39.70, -86.40], 'IN|JEFFERSONVILLE': [38.28, -85.74], 'KY|LOUISVILLE': [38.25, -85.76],
  'KY|HEBRON': [39.07, -84.70], 'KY|SHEPHERDSVILLE': [37.99, -85.72], 'NC|CHARLOTTE': [35.23, -80.84], 'NC|CONCORD': [35.41, -80.58],
  'NC|GARNER': [35.71, -78.61], 'SC|SPARTANBURG': [34.95, -81.93], 'SC|WEST COLUMBIA': [33.99, -81.07], 'VA|RICHMOND': [37.54, -77.44],
  'VA|CHESTER': [37.36, -77.44], 'VA|PETERSBURG': [37.23, -77.40], 'MI|DETROIT': [42.33, -83.05], 'MI|SHEPHERD': [43.52, -84.69],
  'MN|SHAKOPEE': [44.80, -93.53], 'MO|KANSAS CITY': [39.10, -94.58], 'MO|ST. PETERS': [38.80, -90.63], 'MO|SAINT LOUIS': [38.63, -90.20],
  'KS|KANSAS CITY': [39.11, -94.63], 'KS|EDGERTON': [38.76, -95.01], 'CO|AURORA': [39.73, -104.83], 'CO|THORNTON': [39.87, -104.97],
  'CO|COLORADO SPRINGS': [38.83, -104.82], 'UT|SALT LAKE CITY': [40.76, -111.89], 'NV|NORTH LAS VEGAS': [36.20, -115.12],
  'NV|LAS VEGAS': [36.17, -115.14], 'NV|RENO': [39.53, -119.81], 'NV|SPARKS': [39.53, -119.75], 'OR|TROUTDALE': [45.54, -122.39],
  'OR|PORTLAND': [45.52, -122.68], 'WI|KENOSHA': [42.58, -87.82], 'OK|OKLAHOMA CITY': [35.47, -97.52], 'NM|ALBUQUERQUE': [35.08, -106.65],
  'AL|BESSEMER': [33.40, -86.95], 'MS|OLIVE BRANCH': [34.96, -89.83], 'LA|SHREVEPORT': [32.53, -93.75], 'AR|LITTLE ROCK': [34.75, -92.29],
  'CT|WINDSOR': [41.85, -72.64], 'MA|FALL RIVER': [41.70, -71.16], 'DE|MIDDLETOWN': [39.45, -75.72], 'ID|NAMPA': [43.58, -116.56],
};
const STATE = {
  AL: [32.8, -86.8], AK: [61.4, -152.3], AZ: [34.2, -111.7], AR: [34.9, -92.4], CA: [36.8, -119.4], CO: [39.0, -105.5], CT: [41.6, -72.7],
  DE: [39.0, -75.5], DC: [38.9, -77.0], FL: [28.6, -82.4], GA: [32.7, -83.4], HI: [20.8, -156.3], ID: [44.4, -114.6], IL: [40.0, -89.2],
  IN: [39.9, -86.3], IA: [42.1, -93.5], KS: [38.5, -98.4], KY: [37.5, -85.3], LA: [31.1, -92.0], ME: [45.4, -69.2], MD: [39.0, -76.8],
  MA: [42.3, -71.8], MI: [44.3, -85.4], MN: [46.3, -94.3], MS: [32.7, -89.7], MO: [38.4, -92.5], MT: [47.0, -109.6], NE: [41.5, -99.8],
  NV: [39.3, -116.6], NH: [43.7, -71.6], NJ: [40.2, -74.7], NM: [34.4, -106.1], NY: [42.9, -75.5], NC: [35.6, -79.4], ND: [47.5, -100.5],
  OH: [40.3, -82.8], OK: [35.6, -97.5], OR: [43.9, -120.6], PA: [40.9, -77.8], RI: [41.7, -71.5], SC: [33.9, -80.9], SD: [44.4, -100.2],
  TN: [35.9, -86.4], TX: [31.5, -99.3], UT: [39.3, -111.7], VT: [44.1, -72.7], VA: [37.5, -78.9], WA: [47.4, -120.5], WV: [38.6, -80.6],
  WI: [44.6, -89.9], WY: [43.0, -107.6],
};
// { city, state } → { at: [lat, lon], exact } (exact = the city was known).
function locate(p) {
  const st = String((p && p.state) || '').trim().toUpperCase().slice(0, 2);
  const city = String((p && p.city) || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (CITY[st + '|' + city]) return { at: CITY[st + '|' + city], exact: true };
  if (STATE[st]) return { at: STATE[st], exact: false };
  return null;
}
// Road miles between two places (great circle × 1.2 for roads), or null.
function miles(a, b) {
  const A = locate(a), B = locate(b);
  if (!A || !B) return null;
  const r = (d) => d * Math.PI / 180, [la1, lo1] = A.at, [la2, lo2] = B.at;
  const h = Math.sin(r(la2 - la1) / 2) ** 2 + Math.cos(r(la1)) * Math.cos(r(la2)) * Math.sin(r(lo2 - lo1) / 2) ** 2;
  return Math.round(3959 * 2 * Math.asin(Math.sqrt(h)) * 1.2);
}

// Generic partnered-LTL rate before calibration: per pallet, a base plus a
// per-mile part (~$240 a pallet at 400 mi, ~$720 at 2,000 mi), scaled for
// pallet weight (a 500 lb pallet costs less than a 1,400 lb one, not in
// proportion), with a minimum per shipment.
const RATE = { base: 120, perMile: 0.30, refLb: 1000, minShipment: 150 };
function modelCost(pallets, mi) {
  if (!(mi >= 0) || !(pallets || []).length) return null;
  const per = RATE.base + RATE.perMile * mi;
  const t = pallets.reduce((n, p) => n + per * Math.pow(Math.min(1.5, Math.max(0.5, (Number(p.weight) || 0) / RATE.refLb)), 0.6), 0);
  return Math.max(RATE.minShipment, t);
}
// Our shipments' real freight vs the model → a correction factor (median
// ratio, held to 0.5–2 so one odd bill can't swing it). samples: [{ actual,
// pallets: [{ weight }], miles }] → { k, n }.
function calibrate(samples) {
  const r = (samples || []).map(s => { const m = modelCost(s.pallets, s.miles); return m > 0 && s.actual > 0 ? s.actual / m : null; })
    .filter(x => x != null).sort((a, b) => a - b);
  if (!r.length) return { k: 1, n: 0 };
  const med = r.length % 2 ? r[(r.length - 1) / 2] : (r[r.length / 2 - 1] + r[r.length / 2]) / 2;
  return { k: Math.min(2, Math.max(0.5, med)), n: r.length };
}
// One shipment's estimate: pallets [{ weight }], from/to { city, state }, k.
// → { cost, miles, exact } or null when a place is unknown.
function estimate(pallets, from, to, k) {
  const mi = miles(from, to);
  if (mi == null) return null;
  const c = modelCost(pallets, mi);
  const B = locate(to);
  return c == null ? null : { cost: Math.round(c * (k || 1)), miles: mi, exact: !!(B && B.exact) };
}

module.exports = { locate, miles, modelCost, calibrate, estimate, RATE };
