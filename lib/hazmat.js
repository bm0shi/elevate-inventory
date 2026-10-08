// Reading Amazon's hazmat answers. Two sources, because neither is filled in
// for every listing:
//   1. the listing's seller-declared dangerous-goods regulation (Catalog Items
//      attribute supplier_declared_dg_hz_regulation);
//   2. FBA Inbound Eligibility (itemPreview), whose ineligibility reasons are
//      codes, not words.
// Each returns { hazmat: true|false|null, detail }. null = Amazon didn't say,
// which is deliberately NOT treated as safe.

// The scan used to search the eligibility reasons for words like HAZMAT, but
// Amazon sends codes (FBA_INB_0016), so it could never flag anything. These
// are the dangerous-goods codes from Amazon's model (fbaInbound.json):
// 0007-0014 = under hazmat review (can't be sent until it clears),
// 0015 = regulated, unfulfillable, 0016 = fulfillable hazmat (needs the
// hazmat program), 0097 = fully regulated.
const HAZMAT_CODES = {
  FBA_INB_0007: 'hazmat review', FBA_INB_0008: 'hazmat review (battery)',
  FBA_INB_0009: 'hazmat review (needs SDS)', FBA_INB_0010: 'hazmat review',
  FBA_INB_0011: 'hazmat review', FBA_INB_0012: 'hazmat review',
  FBA_INB_0013: 'hazmat review', FBA_INB_0014: 'hazmat review',
  FBA_INB_0015: 'hazmat, unfulfillable', FBA_INB_0016: 'hazmat (fulfillable)',
  FBA_INB_0097: 'fully regulated hazmat',
};

// Declared regulation values: not_applicable = clean; unknown = the seller
// didn't know, which used to be read as HAZMAT; ghs, storage, transportation,
// waste, other = regulated.
function fromDeclared(attrs) {
  const dg = attrs && attrs.supplier_declared_dg_hz_regulation;
  if (!Array.isArray(dg) || !dg.length) return { hazmat: null, detail: '' };
  const vals = dg.map(x => String((x && x.value) || '').toLowerCase().trim()).filter(Boolean);
  const known = vals.filter(v => v !== 'unknown');
  if (!known.length) return { hazmat: null, detail: vals.join(', ') };
  const clean = known.every(v => v === 'not_applicable' || v === 'none');
  return { hazmat: !clean, detail: known.join(', ') };
}

// One itemPreview payload entry. Not eligible for another reason (no SKU on
// our account, missing dimensions...) says nothing about hazmat.
function fromEligibility(item) {
  if (!item) return { hazmat: null, detail: '' };
  const codes = (item.ineligibilityReasonList || []).map(x => String(x).toUpperCase());
  const haz = codes.filter(c => HAZMAT_CODES[c]);
  if (haz.length) return { hazmat: true, detail: [...new Set(haz.map(c => HAZMAT_CODES[c]))].join(', ') + ' (' + haz.join(', ') + ')' };
  if (item.isEligibleForProgram === true) return { hazmat: false, detail: 'inbound eligible' };
  return { hazmat: null, detail: codes.join(', ') };
}

// Amazon's own classification (eligibility codes) outranks what a seller
// declared on the listing; the declaration fills in when Amazon is silent.
function combine(decl, elig) {
  if (elig && elig.hazmat === true) return { hazmat: true, detail: elig.detail, source: 'amazon-inbound' };
  if (decl && decl.hazmat !== null) return { hazmat: decl.hazmat, detail: decl.detail, source: 'amazon-dg' };
  if (elig && elig.hazmat === false) return { hazmat: false, detail: elig.detail, source: 'amazon-inbound' };
  return { hazmat: null, detail: [decl && decl.detail, elig && elig.detail].filter(Boolean).join(' · '), source: '' };
}

module.exports = { HAZMAT_CODES, fromDeclared, fromEligibility, combine };
