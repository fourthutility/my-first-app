import { describe, it, expect, beforeEach } from 'vitest';
import { BASE_DATA, STORAGE_KEY, loadData, saveData, getRow } from '../tracker-core.js';

// ---------------------------------------------------------------------------
// BASE_DATA integrity
// ---------------------------------------------------------------------------
describe('BASE_DATA', () => {
  it('contains exactly 28 projects', () => {
    expect(BASE_DATA).toHaveLength(28);
  });

  it('has unique IDs from 1 to 28', () => {
    const ids = BASE_DATA.map(r => r.id);
    expect(new Set(ids).size).toBe(28);
    expect(Math.min(...ids)).toBe(1);
    expect(Math.max(...ids)).toBe(28);
  });

  it('every row has required fields', () => {
    for (const row of BASE_DATA) {
      expect(row).toHaveProperty('id');
      expect(row).toHaveProperty('name');
      expect(row).toHaveProperty('status');
      expect(row).toHaveProperty('owner');
      expect(row).toHaveProperty('lat');
      expect(row).toHaveProperty('lng');
    }
  });

  it('only contains valid status values', () => {
    const validStatuses = new Set(['Planned', 'Under Construction', 'Conversion']);
    for (const row of BASE_DATA) {
      expect(validStatuses).toContain(row.status);
    }
  });

  it('all coordinates are in the Charlotte, NC bounding box', () => {
    for (const row of BASE_DATA) {
      expect(row.lat).toBeGreaterThan(35.18);
      expect(row.lat).toBeLessThan(35.25);
      expect(row.lng).toBeGreaterThan(-80.88);
      expect(row.lng).toBeLessThan(-80.84);
    }
  });
});

// ---------------------------------------------------------------------------
// loadData / saveData
// ---------------------------------------------------------------------------
describe('loadData', () => {
  beforeEach(() => localStorage.clear());

  it('returns empty object when storage is empty', () => {
    expect(loadData()).toEqual({});
  });

  it('parses and returns stored JSON', () => {
    const data = { 1: { ibStage: 'Won', architect: 'Acme' } };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    expect(loadData()).toEqual(data);
  });

  it('returns empty object on malformed JSON instead of throwing', () => {
    localStorage.setItem(STORAGE_KEY, 'not-valid-json{{');
    expect(loadData()).toEqual({});
  });

  it('ignores unrelated storage keys', () => {
    localStorage.setItem('some_other_key', JSON.stringify({ x: 1 }));
    expect(loadData()).toEqual({});
  });
});

describe('saveData', () => {
  beforeEach(() => localStorage.clear());

  it('persists data under the correct storage key', () => {
    const data = { 5: { ibStage: 'Contacted' } };
    saveData(data);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(data));
  });

  it('overwrites previous value on second save', () => {
    saveData({ 1: { ibStage: 'Prospect' } });
    saveData({ 1: { ibStage: 'Won' } });
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(stored[1].ibStage).toBe('Won');
  });

  it('round-trips correctly with loadData', () => {
    const data = { 3: { architect: 'HKS', gc: 'Barton Malow' } };
    saveData(data);
    expect(loadData()).toEqual(data);
  });
});

// ---------------------------------------------------------------------------
// getRow
// ---------------------------------------------------------------------------
describe('getRow', () => {
  it('returns base data when no edits exist', () => {
    const row = getRow(1, {});
    expect(row.id).toBe(1);
    expect(row.name).toBe('1447 S Tryon St');
    expect(row.status).toBe('Conversion');
  });

  it('merges editable fields on top of base fields', () => {
    const edits = { 1: { architect: 'Gensler', ibStage: 'Won' } };
    const row = getRow(1, edits);
    expect(row.architect).toBe('Gensler');
    expect(row.ibStage).toBe('Won');
    // base fields still present
    expect(row.name).toBe('1447 S Tryon St');
    expect(row.lat).toBe(35.2098);
  });

  it('editable fields do not bleed across rows', () => {
    const edits = { 1: { architect: 'Only for row 1' } };
    const row2 = getRow(2, edits);
    expect(row2.architect).toBeUndefined();
  });

  it('returns undefined for a non-existent id', () => {
    const row = getRow(999, {});
    expect(row.id).toBeUndefined();
  });

  it('edit with empty string overrides base field', () => {
    const edits = { 25: { owner: '' } };
    const row = getRow(25, edits);
    expect(row.owner).toBe('');
  });
});
