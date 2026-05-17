#!/usr/bin/env node
// Portfolio Scout pressure test — runs a batch of URLs through the
// scrape edge function, tallies hit rate, produces a markdown report
// categorizing successes and failures by extraction method.
//
// Auth: requires APP_SECRET env var (the legacy x-app-secret header
// the edge function accepts alongside Auth0 tokens). Find it in the
// Supabase Dashboard → Functions → portfolio-scout-scrape → Secrets.
//
// Usage:
//   APP_SECRET=xxx node scripts/portfolio-scout-pressure-test.js
//
// Flags:
//   --urls <path>           URL list (default: scripts/portfolio-scout-test-urls.json)
//   --out <path>            write markdown report to this file (default: stdout)
//   --concurrency <n>       parallel scrapes (default 1; raise for speed, watch ScrapingAnt's
//                           1-concurrent free-tier limit)
//
// Reading the report:
//   ✓ = candidates extracted (a "hit")
//   ⊝ = skipped with reason (may be correct — fund pages, login walls)
//   ✗ = error (network, auth, function deploy issue)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPABASE_URL      = 'https://lnldwxttyfjmaobluciy.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxubGR3eHR0eWZqbWFvYmx1Y2l5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMDI4ODksImV4cCI6MjA5MTg3ODg4OX0.W0ujmEJpBqKJcMYdwd__bJ0yszSG5QGBfqwFl7hZdLc';
const ENDPOINT          = `${SUPABASE_URL}/functions/v1/portfolio-scout-scrape`;

const APP_SECRET = process.env.APP_SECRET;
if (!APP_SECRET) {
  console.error('Error: APP_SECRET env var is required.');
  console.error('Get the value from Supabase Dashboard → Functions → portfolio-scout-scrape → Secrets.');
  console.error('Run as: APP_SECRET=xxx node scripts/portfolio-scout-pressure-test.js');
  process.exit(1);
}

// Argument parsing
const argv = process.argv.slice(2);
function arg(name, defaultVal) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : defaultVal;
}
const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const urlsPath   = arg('--urls', path.join(__dirname, 'portfolio-scout-test-urls.json'));
const outPath    = arg('--out', null);
const concurrency = Math.max(1, parseInt(arg('--concurrency', '1'), 10));

if (!fs.existsSync(urlsPath)) {
  console.error(`Error: URL list not found at ${urlsPath}`);
  process.exit(1);
}
const urls = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
console.error(`Loaded ${urls.length} URLs from ${urlsPath}`);
console.error(`Concurrency: ${concurrency}\n`);

// Scrape one URL via the SSE endpoint. Parses the stream, returns
// a result object with method / candidates / skip / timing.
async function scrapeOne(entry) {
  const startMs = Date.now();
  const candidates = [];
  let method = null;
  let skip   = null;
  let owner  = null;
  let suggestionCount = 0;
  let duplicates = 0;
  let error  = null;

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-app-secret':  APP_SECRET,
        'apikey':        SUPABASE_ANON_KEY,
        'Accept':        'text/event-stream',
      },
      body: JSON.stringify({ action: 'scrape', source_url: entry.url }),
    });

    if (!res.ok) {
      error = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    } else {
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('text/event-stream')) {
        error = `Non-SSE response (${ct || 'no content-type'}) — edge function likely needs redeploy.`;
      } else if (!res.body) {
        error = 'Streaming response had no body';
      } else {
        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';
          for (const part of parts) {
            let evType = '', data = '';
            for (const line of part.split('\n')) {
              if (line.startsWith('event: ')) evType = line.slice(7).trim();
              else if (line.startsWith('data: ')) data = line.slice(6).trim();
            }
            if (!evType) continue;
            let parsed = {};
            try { parsed = JSON.parse(data || '{}'); } catch {}
            if      (evType === 'property') candidates.push(parsed.candidate);
            else if (evType === 'skip')     { skip = parsed.reason; method = parsed.method; }
            else if (evType === 'complete') {
              method          = parsed.method || method;
              owner           = parsed.owner_name;
              suggestionCount = Array.isArray(parsed.suggestions) ? parsed.suggestions.length : 0;
              duplicates      = typeof parsed.duplicates_detected === 'number' ? parsed.duplicates_detected : 0;
            }
            else if (evType === 'error') error = parsed.message || 'stream error';
          }
        }
      }
    }
  } catch (e) {
    error = e.message;
  }

  const elapsed = Math.round((Date.now() - startMs) / 100) / 10;
  const ok = !skip && !error && candidates.length > 0;
  return { ...entry, ok, candidates: candidates.length, method, skip, owner, suggestionCount, duplicates, error, elapsed };
}

async function main() {
  const results = new Array(urls.length);
  let cursor = 0;

  async function worker() {
    while (cursor < urls.length) {
      const i = cursor++;
      const entry = urls[i];
      process.stderr.write(`[${i + 1}/${urls.length}] ${entry.url} … `);
      const r = await scrapeOne(entry);
      results[i] = r;
      if (r.ok)        console.error(`✓ ${r.candidates} candidates (${r.method}, ${r.elapsed}s)`);
      else if (r.skip) console.error(`⊝ ${r.skip} (${r.elapsed}s)`);
      else             console.error(`✗ ${r.error ? r.error.slice(0, 80) : 'no candidates'}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Stats
  const total       = results.length;
  const hits        = results.filter(r => r.ok).length;
  const correctSkips = results.filter(r => r.skip && (r.expected || '').toLowerCase().startsWith('skip:')).length;
  const wrongSkips  = results.filter(r => r.skip).length - correctSkips;
  const errors      = results.filter(r => r.error && !r.skip).length;

  const lines = [];
  lines.push('# Portfolio Scout — Pressure-Test Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Endpoint: ${ENDPOINT}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Effective hit rate**: ${hits + correctSkips}/${total} = ${Math.round((hits + correctSkips) / total * 100)}% (extractions + correctly-skipped fund/login pages)`);
  lines.push(`- **Buildings extracted**: ${hits}/${total} = ${Math.round(hits / total * 100)}%`);
  lines.push(`- **Correctly skipped** (expected skip:* outcome): ${correctSkips}`);
  lines.push(`- **Unexpected skips**: ${wrongSkips}`);
  lines.push(`- **Errors**: ${errors}`);
  lines.push('');

  // Per-method breakdown
  const byMethod = {};
  for (const r of results) {
    const key = r.method || (r.error ? 'error' : 'unknown');
    byMethod[key] = (byMethod[key] || 0) + 1;
  }
  lines.push('## Method distribution');
  lines.push('');
  for (const [m, n] of Object.entries(byMethod).sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${m}\`: ${n}`);
  }
  lines.push('');

  // Results table
  lines.push('## Per-URL results');
  lines.push('');
  lines.push('| # | URL | Category | Hit? | Method | Cands | Time | Notes |');
  lines.push('|---|---|---|---|---|---|---|---|');
  results.forEach((r, i) => {
    const hit = r.ok ? '✓' : (r.skip ? '⊝' : '✗');
    const method = r.skip || r.method || (r.error ? 'error' : '—');
    const cand = r.candidates || 0;
    const time = r.elapsed ? `${r.elapsed}s` : '—';
    const notes = r.error ? `error: ${r.error.slice(0, 70)}` : (r.suggestionCount ? `${r.suggestionCount} suggestions` : '');
    lines.push(`| ${i + 1} | ${r.url} | ${r.category || ''} | ${hit} | \`${method}\` | ${cand} | ${time} | ${notes} |`);
  });
  lines.push('');

  // Failure breakdown
  const reasonCounts = {};
  for (const r of results) {
    if (r.ok) continue;
    const reason = r.skip || (r.error ? `error: ${(r.error || '').slice(0, 40)}` : 'no-candidates');
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }
  lines.push('## Failure breakdown');
  lines.push('');
  if (Object.keys(reasonCounts).length === 0) {
    lines.push('All URLs yielded candidates.');
  } else {
    for (const [reason, n] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(`- \`${reason}\`: ${n}`);
    }
  }

  const report = lines.join('\n');
  if (outPath) {
    fs.writeFileSync(outPath, report);
    console.error(`\nReport written to ${outPath}`);
  } else {
    console.log('\n' + report);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
