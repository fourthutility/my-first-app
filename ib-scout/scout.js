#!/usr/bin/env node
// scout.js — IB Scout Property Intelligence Pipeline
//
// Step 1 → Google Places API        (geocode/validate address)
// Step 2 → Attom property/detailowner  (owner, building specs)
// Step 3 → Attom sale/detail           (last sale)
// Step 4 → Attom saleshistory/detail   (transaction history)
// Step 5 → Claude HAIKU               (parse + normalize only)
// Step 6 → Scoring logic              (pure code, no LLM)
// Step 7 → Claude SONNET              (intelligence report — only Sonnet call)
// Step 8 → Console output
//
// Run: node scout.js [optional address]

require('dotenv').config();

const ATTOM_KEY  = process.env.ATTOM_API_KEY;
const ANTH_KEY   = process.env.ANTHROPIC_API_KEY;
const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;

const TEST_ADDRESS = process.argv[2] || '110 East Boulevard, Charlotte, NC 28203';

// ─── Validate env ────────────────────────────────────────────────────────────

if (!ATTOM_KEY || !ANTH_KEY || !GOOGLE_KEY) {
  console.error('\n❌  Missing required environment variables.');
  console.error('    Copy .env.example to .env and fill in your API keys.\n');
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function httpGet(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url.split('?')[0]}: ${text.slice(0, 400)}`);
  }
  try { return JSON.parse(text); } catch { return text; }
}

async function callClaude(model, system, user) {
  const isHaiku = model.includes('haiku');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTH_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: isHaiku ? 1024 : 2048,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err.slice(0, 400)}`);
  }
  const data = await res.json();
  return data.content[0].text;
}

function parseJsonRobust(raw) {
  try { return JSON.parse(raw); } catch {}
  const stripped = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(stripped); } catch {}
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error('Could not parse JSON from model output: ' + raw.slice(0, 200));
}

// ─── Step 1: Google Geocode ──────────────────────────────────────────────────

async function geocodeAddress(address) {
  console.log('\n[Step 1] Geocoding with Google Places...');
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_KEY}`;
  const data = await httpGet(url);

  if (data.status !== 'OK') {
    throw new Error('Address not found. Check input and retry.');
  }

  const result = data.results[0];
  const ac = result.address_components;
  const get = (type) => (ac.find(c => c.types.includes(type)) || {}).short_name || null;

  const geo = {
    formatted_address: result.formatted_address,
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    street_number: get('street_number'),
    route: get('route'),
    city: get('locality') || get('sublocality') || get('neighborhood'),
    state: get('administrative_area_level_1'),
    zip: get('postal_code'),
    county: get('administrative_area_level_2'),
  };

  console.log(`  ✓ ${geo.formatted_address}`);
  return geo;
}

// ─── Attom request helper ────────────────────────────────────────────────────

function attomGet(endpoint, geo) {
  const street = [geo.street_number, geo.route].filter(Boolean).join(' ');
  const cityStateZip = `${geo.city},${geo.state} ${geo.zip}`;
  const params = new URLSearchParams({ address1: street, address2: cityStateZip });
  const url = `https://api.gateway.attomdata.com/propertyapi/v1.0.0/${endpoint}?${params}`;
  return httpGet(url, { APIKey: ATTOM_KEY, Accept: 'application/json' });
}

// ─── Step 2: Property Detail + Owner ────────────────────────────────────────

async function getPropertyDetail(geo) {
  console.log('\n[Step 2] Fetching property detail + owner from Attom...');
  const data = await attomGet('property/detailowner', geo);

  console.log('\n--- RAW Attom detailowner (truncated to 3000 chars) ---');
  console.log(JSON.stringify(data, null, 2).slice(0, 3000));
  console.log('--- END RAW ---');

  const prop = data?.property?.[0];
  if (!prop) throw new Error('Attom returned no property record. Try a different address.');

  const fields = {
    'owner.owner1.fullname':       prop?.owner?.owner1?.fullname,
    'owner.mailingaddressoneline': prop?.owner?.mailingaddressoneline,
    'summary.proptype':            prop?.summary?.proptype,
    'summary.propsubtype':         prop?.summary?.propsubtype,
    'building.summary.storycount': prop?.building?.summary?.storycount,
    'building.size.universalsize': prop?.building?.size?.universalsize,
    'summary.yearbuilt':           prop?.summary?.yearbuilt,
    'lot.lotsize2':                prop?.lot?.lotsize2,
    'identifier.apn':              prop?.identifier?.apn,
  };

  console.log('\n  Field checklist:');
  for (const [f, v] of Object.entries(fields)) {
    console.log(`    ${v != null ? '✓' : '✗'}  ${f}: ${v ?? 'null'}`);
  }

  return data;
}

// ─── Step 3: Last Sale ───────────────────────────────────────────────────────

async function getLastSale(geo) {
  console.log('\n[Step 3] Fetching last sale from Attom...');
  try {
    const data = await attomGet('sale/detail', geo);
    console.log('  ✓ sale/detail returned');
    return data;
  } catch (e) {
    console.warn(`  ⚠  sale/detail failed: ${e.message}`);
    return null;
  }
}

// ─── Step 4: Sales History ───────────────────────────────────────────────────

async function getSalesHistory(geo) {
  console.log('\n[Step 4] Fetching sales history from Attom...');
  try {
    const data = await attomGet('saleshistory/detail', geo);
    const count = data?.sale?.length ?? 0;
    console.log(`  ✓ saleshistory/detail returned ${count} records`);
    return data;
  } catch (e) {
    console.warn(`  ⚠  saleshistory/detail failed: ${e.message}`);
    return null;
  }
}

// ─── Step 5: Normalize with Claude Haiku ────────────────────────────────────

async function normalizeWithHaiku(detailData, saleData, historyData) {
  console.log('\n[Step 5] Normalizing with Claude Haiku...');

  const rawBundle = JSON.stringify({
    property_detail: detailData?.property?.[0] ?? {},
    last_sale:       saleData?.sale?.[0] ?? {},
    sales_history:   (historyData?.sale ?? []).slice(0, 5),
  });

  const system = `You are a commercial real estate data parser. You receive raw property assessor and transaction data and return a clean, normalized JSON object. Return ONLY valid JSON. No preamble. No markdown. No explanation.`;

  const user = `Parse this property data and return this exact JSON schema:

${rawBundle}

Schema to return:
{
  "owner_entity": "string — clean formatted name",
  "owner_type": "individual | LLC | REIT | trust | institution | unknown",
  "owner_mailing_address": "string or null",
  "last_sale_date": "YYYY-MM-DD or null",
  "last_sale_price": number or null,
  "price_per_sf": number or null,
  "sale_disclosure": "arms-length | non-disclosure | unknown",
  "building_sf": number or null,
  "stories": number or null,
  "year_built": number or null,
  "lot_size_sf": number or null,
  "property_type": "office | industrial | retail | multifamily | mixed-use | other",
  "assessed_value": number or null,
  "apn": "string or null",
  "sales_history": [
    { "date": "YYYY-MM-DD", "price": number, "buyer": "string", "seller": "string" }
  ],
  "data_flags": ["list any missing or suspicious fields here"]
}`;

  const raw = await callClaude('claude-haiku-4-5-20251001', system, user);
  const normalized = parseJsonRobust(raw);
  console.log('  ✓ Normalized JSON received');
  return normalized;
}

// ─── Step 6: IB Opportunity Score (pure code) ────────────────────────────────

function scoreProperty(p) {
  console.log('\n[Step 6] Calculating IB opportunity score...');
  let score = 0;
  const now = new Date();

  if (p.last_sale_date) {
    const yearsAgo = now.getFullYear() - new Date(p.last_sale_date).getFullYear();
    if (yearsAgo <= 3)      score += 30;
    else if (yearsAgo <= 6) score += 15;
  }

  if      (p.building_sf >= 100000) score += 25;
  else if (p.building_sf >= 50000)  score += 15;
  else if (p.building_sf >= 25000)  score += 8;

  if      (['office', 'mixed-use'].includes(p.property_type))       score += 20;
  else if (['multifamily', 'retail'].includes(p.property_type))     score += 10;

  if (['LLC', 'REIT', 'institution'].includes(p.owner_type)) score += 15;

  if (p.year_built && p.year_built < 2005) score += 10;

  return Math.min(score, 100);
}

function priorityLabel(score) {
  if (score >= 70) return 'HIGH PRIORITY';
  if (score >= 40) return 'WATCH';
  return 'LOW';
}

// ─── Step 7: Intelligence Report with Claude Sonnet ─────────────────────────

async function generateReport(formattedAddress, normalized, score) {
  console.log('\n[Step 7] Generating intelligence report with Claude Sonnet...');

  const system = `You are an analyst for Intelligent Buildings (IB), a commercial real estate technology advisory firm. IB positions digital infrastructure as the "Fourth Utility" — a managed service that improves NOI for CRE owners. Write concise, professional property intelligence reports for IB's BD team. Focus on ownership structure, transaction signals, and why this property is or isn't a fit for IB's managed services offering.`;

  const user = `Write a Property Intelligence Report for the IB BD team based on this data:

Property: ${formattedAddress}
Normalized Data: ${JSON.stringify(normalized, null, 2)}
IB Opportunity Score: ${score}/100

Structure the report with these sections:
1. Property Summary (4–5 lines: address, type, SF, stories, year built)
2. Ownership (owner entity, type, mailing address, what this signals)
3. Transaction History (last sale + prior sales — what the timing tells us)
4. IB Fit Assessment (why this property is or isn't a match for Fourth Utility managed services — be specific, not generic)
5. Recommended Next Step (one concrete action for the IB BD team)

Keep the full report under 300 words. Write for a BD team, not a data analyst.`;

  const report = await callClaude('claude-sonnet-4-6', system, user);
  console.log('  ✓ Report generated');
  return report;
}

// ─── Step 8: Console Output ──────────────────────────────────────────────────

function printReport(geo, normalized, score, report) {
  const label = priorityLabel(score);
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const chk = (v) => (v != null && v !== '') ? '✓' : '✗';
  const fmt = (v) => v != null ? String(v) : 'null';

  const line = '='.repeat(48);
  const dash = '-'.repeat(48);

  console.log('\n' + line);
  console.log('IB SCOUT — PROPERTY INTELLIGENCE REPORT');
  console.log(line);
  console.log(`Address:     ${geo.formatted_address}`);
  console.log(`Run Date:    ${today}`);
  console.log(`Scout Score: ${score}/100 (${label})`);
  console.log(dash);
  console.log(report);
  console.log(dash);
  console.log('RAW DATA CHECKLIST:');
  console.log(`  ${chk(normalized.owner_entity)}  Owner Entity:        ${fmt(normalized.owner_entity)}`);
  console.log(`  ${chk(normalized.owner_mailing_address)}  Owner Mailing Addr:  ${fmt(normalized.owner_mailing_address)}`);
  console.log(`  ${chk(normalized.last_sale_date)}  Last Sale Date:      ${fmt(normalized.last_sale_date)}`);
  console.log(`  ${chk(normalized.last_sale_price)}  Last Sale Price:     ${normalized.last_sale_price ? '$' + normalized.last_sale_price.toLocaleString() : 'null'}`);
  console.log(`  ${chk(normalized.building_sf)}  Building SF:         ${normalized.building_sf ? normalized.building_sf.toLocaleString() : 'null'}`);
  console.log(`  ${chk(normalized.stories)}  Stories:             ${fmt(normalized.stories)}`);
  console.log(`  ${chk(normalized.year_built)}  Year Built:          ${fmt(normalized.year_built)}`);
  console.log(`  ${chk(normalized.property_type)}  Property Type:       ${fmt(normalized.property_type)}`);
  console.log(`  ${chk(normalized.apn)}  APN:                 ${fmt(normalized.apn)}`);
  if (normalized.data_flags?.length) {
    console.log(`\n  Data Flags: ${normalized.data_flags.join(', ')}`);
  }
  console.log(line + '\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍  IB Scout — Pipeline starting`);
  console.log(`    Address: ${TEST_ADDRESS}`);

  try {
    // Step 1
    const geo = await geocodeAddress(TEST_ADDRESS);

    // Steps 2–4 (Attom calls in parallel to save time)
    const [detailData, saleData, historyData] = await Promise.all([
      getPropertyDetail(geo),
      getLastSale(geo),
      getSalesHistory(geo),
    ]);

    // Step 5
    const normalized = await normalizeWithHaiku(detailData, saleData, historyData);

    // Step 6
    const score = scoreProperty(normalized);
    console.log(`  ✓ Score: ${score}/100 (${priorityLabel(score)})`);

    // Step 7
    const report = await generateReport(geo.formatted_address, normalized, score);

    // Step 8
    printReport(geo, normalized, score, report);

  } catch (err) {
    console.error('\n❌  Pipeline failed:', err.message);
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
  }
}

main();
