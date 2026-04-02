import { describe, it, expect } from 'vitest';
import { BASE_DATA, buildCSV } from '../tracker-core.js';

// Parse a raw CSV string into an array of objects keyed by header name.
function parseCSV(csv) {
  const lines = csv.split('\r\n');
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    // Simple CSV parser: handles double-quote escaping
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && !inQuotes) { inQuotes = true; }
      else if (ch === '"' && inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"' && inQuotes) { inQuotes = false; }
      else if (ch === ',' && !inQuotes) { values.push(current); current = ''; }
      else { current += ch; }
    }
    values.push(current);
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
  });
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------
describe('buildCSV – structure', () => {
  it('produces a non-empty string', () => {
    const csv = buildCSV({});
    expect(typeof csv).toBe('string');
    expect(csv.length).toBeGreaterThan(0);
  });

  it('uses CRLF line endings', () => {
    const csv = buildCSV({});
    expect(csv).toContain('\r\n');
  });

  it('has the correct header row', () => {
    const csv = buildCSV({});
    const firstLine = csv.split('\r\n')[0];
    expect(firstLine).toBe(
      'Address,Status,Use Type,Owner/Developer,Architect,General Contractor,' +
      'Key Contacts,Permit Status,IB Stage,Stiles Interest,Latest Notes,Last Updated'
    );
  });

  it('has exactly 29 lines (1 header + 28 data rows)', () => {
    const lines = buildCSV({}).split('\r\n');
    expect(lines).toHaveLength(29);
  });
});

// ---------------------------------------------------------------------------
// Data accuracy
// ---------------------------------------------------------------------------
describe('buildCSV – data accuracy', () => {
  it('includes all 28 project addresses', () => {
    const rows = parseCSV(buildCSV({}));
    const csvAddresses = rows.map(r => r['Address']);
    for (const base of BASE_DATA) {
      expect(csvAddresses).toContain(base.name);
    }
  });

  it('includes the correct status for each row', () => {
    const rows = parseCSV(buildCSV({}));
    for (const base of BASE_DATA) {
      const csvRow = rows.find(r => r['Address'] === base.name);
      expect(csvRow?.['Status']).toBe(base.status);
    }
  });

  it('includes editable fields when present', () => {
    const edits = { 25: { architect: 'HKS', gc: 'Barton Malow', ibStage: 'Won' } };
    const rows = parseCSV(buildCSV(edits));
    const row25 = rows.find(r => r['Address'] === '1111 S Tryon St');
    expect(row25?.['Architect']).toBe('HKS');
    expect(row25?.['General Contractor']).toBe('Barton Malow');
    expect(row25?.['IB Stage']).toBe('Won');
  });

  it('leaves editable fields empty when not set', () => {
    const rows = parseCSV(buildCSV({}));
    const row1 = rows.find(r => r['Address'] === '1447 S Tryon St');
    expect(row1?.['Architect']).toBe('');
    expect(row1?.['IB Stage']).toBe('');
  });

  it('replaces newlines in contacts with " | "', () => {
    const edits = { 3: { contacts: 'Alice\nBob\nCarol' } };
    const rows = parseCSV(buildCSV(edits));
    const row3 = rows.find(r => r['Address'] === '1203 S Caldwell St');
    expect(row3?.['Key Contacts']).toBe('Alice | Bob | Carol');
  });
});

// ---------------------------------------------------------------------------
// CSV escaping
// ---------------------------------------------------------------------------
describe('buildCSV – CSV escaping', () => {
  it('escapes double-quotes within values', () => {
    const edits = { 1: { notes: 'He said "hello" to the team' } };
    const csv = buildCSV(edits);
    // RFC 4180: embedded quote -> doubled quote inside surrounding quotes
    expect(csv).toContain('"He said ""hello"" to the team"');
  });

  it('wraps every cell in double-quotes', () => {
    const csv = buildCSV({});
    const dataLines = csv.split('\r\n').slice(1);
    for (const line of dataLines) {
      // Each cell should start and end with a quote
      const cells = line.split(/,(?=")/);
      for (const cell of cells) {
        expect(cell.startsWith('"')).toBe(true);
        expect(cell.endsWith('"')).toBe(true);
      }
    }
  });

  it('handles commas in notes without breaking row structure', () => {
    const edits = { 2: { notes: 'Phase 1, Phase 2, and Phase 3' } };
    const rows = parseCSV(buildCSV(edits));
    expect(rows).toHaveLength(28);
    const row2 = rows.find(r => r['Address'] === '1102 S Tryon St');
    expect(row2?.['Latest Notes']).toBe('Phase 1, Phase 2, and Phase 3');
  });
});
