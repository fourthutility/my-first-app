import { describe, it, expect } from 'vitest';
import { statusBadge, ibBadge, dash } from '../tracker-core.js';

// ---------------------------------------------------------------------------
// statusBadge
// ---------------------------------------------------------------------------
describe('statusBadge', () => {
  it('renders a span with the status text', () => {
    expect(statusBadge('Planned')).toContain('Planned');
    expect(statusBadge('Under Construction')).toContain('Under Construction');
    expect(statusBadge('Conversion')).toContain('Conversion');
  });

  it('applies correct colour for Planned (purple)', () => {
    const html = statusBadge('Planned');
    expect(html).toContain('#7e22ce');
    expect(html).toContain('#f3e8ff');
  });

  it('applies correct colour for Under Construction (green)', () => {
    const html = statusBadge('Under Construction');
    expect(html).toContain('#15803d');
    expect(html).toContain('#dcfce7');
  });

  it('applies correct colour for Conversion (red)', () => {
    const html = statusBadge('Conversion');
    expect(html).toContain('#b91c1c');
    expect(html).toContain('#fee2e2');
  });

  it('still renders for an unknown status (no crash, no style)', () => {
    const html = statusBadge('Unknown');
    expect(html).toContain('Unknown');
    expect(html).toContain('status-pill');
  });

  it('returns a string', () => {
    expect(typeof statusBadge('Planned')).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// ibBadge
// ---------------------------------------------------------------------------
describe('ibBadge', () => {
  it('returns the dash placeholder for falsy values', () => {
    expect(ibBadge(null)).toContain('—');
    expect(ibBadge(undefined)).toContain('—');
    expect(ibBadge('')).toContain('—');
  });

  it('renders stage text inside a span', () => {
    const stages = ['Prospect', 'Contacted', 'Meeting Scheduled', 'Proposal Sent', 'Won', 'Lost', 'N/A'];
    for (const s of stages) {
      expect(ibBadge(s)).toContain(s);
    }
  });

  it('applies green style for Won', () => {
    expect(ibBadge('Won')).toContain('#15803d');
  });

  it('applies red style for Lost', () => {
    expect(ibBadge('Lost')).toContain('#b91c1c');
  });

  it('applies blue style for Contacted', () => {
    expect(ibBadge('Contacted')).toContain('#1d4ed8');
  });

  it('renders (but without a matching style) for an unknown stage', () => {
    const html = ibBadge('Some Future Stage');
    expect(html).toContain('Some Future Stage');
    expect(html).toContain('status-pill');
  });
});

// ---------------------------------------------------------------------------
// dash
// ---------------------------------------------------------------------------
describe('dash', () => {
  it('returns an em-dash placeholder for falsy values', () => {
    expect(dash(null)).toContain('—');
    expect(dash(undefined)).toContain('—');
    expect(dash('')).toContain('—');
    expect(dash(0)).toContain('—');
  });

  it('wraps a truthy value in a span', () => {
    const html = dash('Gensler');
    expect(html).toContain('Gensler');
    expect(html).toContain('<span');
  });

  it('does not show dash when value is present', () => {
    expect(dash('HKS')).not.toContain('—');
  });

  it('handles numeric-like string values', () => {
    expect(dash('42')).toContain('42');
  });
});
