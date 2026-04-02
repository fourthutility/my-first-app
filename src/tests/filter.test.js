import { describe, it, expect } from 'vitest';
import { BASE_DATA, filterRows, computeStats, getRow } from '../tracker-core.js';

// Helpers
const allRows = (editableData = {}) => BASE_DATA.map(b => getRow(b.id, editableData));

// ---------------------------------------------------------------------------
// filterRows — status filter
// ---------------------------------------------------------------------------
describe('filterRows – status filter', () => {
  it('"all" returns every row', () => {
    const result = filterRows(allRows(), 'all', '');
    expect(result).toHaveLength(28);
  });

  it('"Planned" returns only Planned rows', () => {
    const result = filterRows(allRows(), 'Planned', '');
    expect(result.length).toBeGreaterThan(0);
    expect(result.every(r => r.status === 'Planned')).toBe(true);
  });

  it('"Under Construction" returns only Under Construction rows', () => {
    const result = filterRows(allRows(), 'Under Construction', '');
    expect(result.length).toBeGreaterThan(0);
    expect(result.every(r => r.status === 'Under Construction')).toBe(true);
  });

  it('"Conversion" returns only Conversion rows', () => {
    const result = filterRows(allRows(), 'Conversion', '');
    expect(result.length).toBeGreaterThan(0);
    expect(result.every(r => r.status === 'Conversion')).toBe(true);
  });

  it('Planned + Under Construction + Conversion counts add up to 28', () => {
    const planned      = filterRows(allRows(), 'Planned', '').length;
    const construction = filterRows(allRows(), 'Under Construction', '').length;
    const conversion   = filterRows(allRows(), 'Conversion', '').length;
    expect(planned + construction + conversion).toBe(28);
  });
});

// ---------------------------------------------------------------------------
// filterRows — text search
// ---------------------------------------------------------------------------
describe('filterRows – text search', () => {
  it('empty search string returns all rows', () => {
    expect(filterRows(allRows(), 'all', '')).toHaveLength(28);
  });

  it('search by address is case-insensitive', () => {
    const lower = filterRows(allRows(), 'all', 'tryon');
    const upper = filterRows(allRows(), 'all', 'TRYON');
    expect(lower.length).toBeGreaterThan(0);
    expect(lower).toEqual(upper);
  });

  it('search by owner name finds the correct row', () => {
    const result = filterRows(allRows(), 'all', 'Avery Hall');
    expect(result).toHaveLength(1);
    expect(result[0].owner).toBe('Avery Hall Investments');
  });

  it('search by partial address matches correctly', () => {
    const result = filterRows(allRows(), 'all', '1447');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('1447 S Tryon St');
  });

  it('search that matches nothing returns empty array', () => {
    expect(filterRows(allRows(), 'all', 'xyzzy-no-match-1234')).toHaveLength(0);
  });

  it('search within editable fields (architect)', () => {
    const edits = { 25: { architect: 'HKS Architects' } };
    const rows  = allRows(edits);
    const result = filterRows(rows, 'all', 'HKS');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(25);
  });

  it('search within editable fields (notes)', () => {
    const edits = { 3: { notes: 'Affordable housing project' } };
    const rows  = allRows(edits);
    const result = filterRows(rows, 'all', 'affordable housing');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(3);
  });

  it('search within editable fields (contacts)', () => {
    const edits = { 10: { contacts: 'Jane Doe\nJohn Smith' } };
    const rows  = allRows(edits);
    expect(filterRows(rows, 'all', 'Jane Doe')).toHaveLength(1);
    expect(filterRows(rows, 'all', 'john smith')).toHaveLength(1);
  });

  it('search with special regex characters does not throw', () => {
    expect(() => filterRows(allRows(), 'all', '(test)')).not.toThrow();
    expect(() => filterRows(allRows(), 'all', '[bracket')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// filterRows — combined filter + search
// ---------------------------------------------------------------------------
describe('filterRows – combined filter and search', () => {
  it('filters to Planned AND matches search term', () => {
    const result = filterRows(allRows(), 'Planned', 'cousins');
    expect(result.length).toBeGreaterThan(0);
    expect(result.every(r => r.status === 'Planned')).toBe(true);
    expect(result.every(r => r.owner.toLowerCase().includes('cousins'))).toBe(true);
  });

  it('returns empty when filter+search combo matches nothing', () => {
    // Avery Hall is Under Construction, so filtering for Planned yields nothing
    const result = filterRows(allRows(), 'Planned', 'Avery Hall');
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computeStats
// ---------------------------------------------------------------------------
describe('computeStats', () => {
  it('total is always 28', () => {
    expect(computeStats(BASE_DATA, {}).total).toBe(28);
  });

  it('status counts are correct', () => {
    const stats = computeStats(BASE_DATA, {});
    expect(stats.planned).toBe(23);
    expect(stats.construction).toBe(4);
    expect(stats.conversion).toBe(1);
  });

  it('ibActive counts non-N/A, non-Lost, non-empty stages', () => {
    const edits = {
      1: { ibStage: 'Won' },
      2: { ibStage: 'Contacted' },
      3: { ibStage: 'Lost' },
      4: { ibStage: 'N/A' },
      5: { ibStage: '' },
    };
    expect(computeStats(BASE_DATA, edits).ibActive).toBe(2);
  });

  it('ibActive is 0 with no editable data', () => {
    expect(computeStats(BASE_DATA, {}).ibActive).toBe(0);
  });

  it('planned + construction + conversion equals total', () => {
    const stats = computeStats(BASE_DATA, {});
    expect(stats.planned + stats.construction + stats.conversion).toBe(stats.total);
  });
});
