/**
 * tracker-core.js
 * Pure logic extracted from south-end-tracker.html for testability.
 * The HTML file remains the deployment artifact; this module is the
 * authoritative source for all unit-testable functions.
 */

export const BASE_DATA = [
  { id:1,  name:"1447 S Tryon St",       status:"Conversion",         statusHex:"#FF0000", owner:"Radford W. Koltz",                     lat:35.2098, lng:-80.8572 },
  { id:2,  name:"1102 S Tryon St",       status:"Planned",            statusHex:"#C86AC8", owner:"Crescent Communities",                 lat:35.2162, lng:-80.8571 },
  { id:3,  name:"1203 S Caldwell St",    status:"Planned",            statusHex:"#C86AC8", owner:"Inlivian",                             lat:35.2148, lng:-80.8530 },
  { id:4,  name:"125 West Blvd",         status:"Planned",            statusHex:"#C86AC8", owner:"Design Center Phase II LLC",           lat:35.2228, lng:-80.8618 },
  { id:5,  name:"1320 S Tryon St",       status:"Planned",            statusHex:"#C86AC8", owner:"White Lodging",                        lat:35.2127, lng:-80.8571 },
  { id:6,  name:"1427 S Tryon St",       status:"Planned",            statusHex:"#C86AC8", owner:"Cousins Properties",                   lat:35.2106, lng:-80.8571 },
  { id:7,  name:"1933 South Blvd",       status:"Planned",            statusHex:"#C86AC8", owner:"Southern Land Company",                lat:35.2032, lng:-80.8542 },
  { id:8,  name:"205 E Bland Street",    status:"Planned",            statusHex:"#C86AC8", owner:"Cousins Properties",                   lat:35.2208, lng:-80.8550 },
  { id:9,  name:"2103 S Tryon St",       status:"Planned",            statusHex:"#C86AC8", owner:"Portman Residential",                  lat:35.2010, lng:-80.8573 },
  { id:10, name:"2401 Distribution St",  status:"Planned",            statusHex:"#C86AC8", owner:"Cousins Properties",                   lat:35.1988, lng:-80.8625 },
  { id:11, name:"2500 Distribution St",  status:"Planned",            statusHex:"#C86AC8", owner:"MPV Properties",                       lat:35.1978, lng:-80.8635 },
  { id:12, name:"409 Basin St",          status:"Planned",            statusHex:"#C86AC8", owner:"Griffin Brothers",                     lat:35.2188, lng:-80.8608 },
  { id:13, name:"1120 S Tryon St",       status:"Planned",            statusHex:"#C86AC8", owner:"Cousins Properties",                   lat:35.2158, lng:-80.8571 },
  { id:14, name:"1301 South Blvd",       status:"Planned",            statusHex:"#C86AC8", owner:"Inlivian",                             lat:35.2130, lng:-80.8542 },
  { id:15, name:"1426 S Tryon St",       status:"Planned",            statusHex:"#C86AC8", owner:"Highwood Properties",                  lat:35.2108, lng:-80.8571 },
  { id:16, name:"1600 Camden Rd",        status:"Planned",            statusHex:"#C86AC8", owner:"Harris Development Group LLC",         lat:35.2078, lng:-80.8520 },
  { id:17, name:"1601 South Blvd",       status:"Planned",            statusHex:"#C86AC8", owner:"Sterling Bay",                         lat:35.2076, lng:-80.8542 },
  { id:18, name:"1603 South Blvd",       status:"Planned",            statusHex:"#C86AC8", owner:"Sterling Bay",                         lat:35.2074, lng:-80.8542 },
  { id:19, name:"1728 South Blvd",       status:"Planned",            statusHex:"#C86AC8", owner:"MRP Realty",                           lat:35.2054, lng:-80.8542 },
  { id:20, name:"2120 S Tryon",          status:"Planned",            statusHex:"#C86AC8", owner:"Vision Ventures",                      lat:35.2008, lng:-80.8573 },
  { id:21, name:"2132 Hawkins St",       status:"Planned",            statusHex:"#C86AC8", owner:"Omersha Holdings LLC",                 lat:35.2005, lng:-80.8558 },
  { id:22, name:"216 E Worthington Ave", status:"Planned",            statusHex:"#C86AC8", owner:"Centrum Realty & Development",         lat:35.2188, lng:-80.8522 },
  { id:23, name:"2915 Griffith St",      status:"Planned",            statusHex:"#C86AC8", owner:"George Barrett",                       lat:35.1928, lng:-80.8612 },
  { id:24, name:"300 W Tremont Ave",     status:"Planned",            statusHex:"#C86AC8", owner:"Cousins Properties",                   lat:35.2163, lng:-80.8628 },
  { id:25, name:"1111 S Tryon St",       status:"Under Construction", statusHex:"#92D050", owner:"Riverside Investment & Development",   lat:35.2160, lng:-80.8570 },
  { id:26, name:"1726 S Tryon St",       status:"Under Construction", statusHex:"#92D050", owner:"Panorama Holdings",                   lat:35.2056, lng:-80.8572 },
  { id:27, name:"2810 S Tryon St",       status:"Under Construction", statusHex:"#92D050", owner:"Avery Hall Investments",               lat:35.1943, lng:-80.8575 },
  { id:28, name:"510 W Tremont Ave",     status:"Under Construction", statusHex:"#92D050", owner:"Northwood Investors LLC",              lat:35.2158, lng:-80.8643 },
];

export const STORAGE_KEY = 'ib_south_end_v1';

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

export function loadData(storage = localStorage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveData(editableData, storage = localStorage) {
  storage.setItem(STORAGE_KEY, JSON.stringify(editableData));
}

export function getRow(id, editableData = {}) {
  return { ...BASE_DATA.find(r => r.id === id), ...(editableData[id] || {}) };
}

// ---------------------------------------------------------------------------
// Badge helpers
// ---------------------------------------------------------------------------

const STATUS_STYLES = {
  'Planned':            'background:#f3e8ff;color:#7e22ce;',
  'Under Construction': 'background:#dcfce7;color:#15803d;',
  'Conversion':         'background:#fee2e2;color:#b91c1c;',
};

const IB_STAGE_STYLES = {
  'Prospect':           'background:#f1f5f9;color:#64748b;',
  'Contacted':          'background:#dbeafe;color:#1d4ed8;',
  'Meeting Scheduled':  'background:#e0e7ff;color:#4338ca;',
  'Proposal Sent':      'background:#ffedd5;color:#c2410c;',
  'Won':                'background:#dcfce7;color:#15803d;',
  'Lost':               'background:#fee2e2;color:#b91c1c;',
  'N/A':                'background:#f8fafc;color:#cbd5e1;',
};

export function statusBadge(status) {
  const style = STATUS_STYLES[status] || '';
  return `<span class="status-pill" style="${style}">${status}</span>`;
}

export function ibBadge(stage) {
  if (!stage) return '<span style="color:#cbd5e1;font-size:12px;">—</span>';
  const style = IB_STAGE_STYLES[stage] || '';
  return `<span class="status-pill" style="${style}">${stage}</span>`;
}

export function dash(v) {
  return v
    ? `<span class="text-slate-700">${v}</span>`
    : '<span style="color:#e2e8f0;">—</span>';
}

// ---------------------------------------------------------------------------
// Filter / search
// ---------------------------------------------------------------------------

/**
 * Filter and search the full project list.
 * @param {object[]} rows        - merged rows (output of BASE_DATA.map(b => getRow(b.id, editableData)))
 * @param {string}   activeFilter - 'all' | 'Planned' | 'Under Construction' | 'Conversion'
 * @param {string}   search       - raw search string (will be lowercased internally)
 * @returns {object[]} matching rows
 */
export function filterRows(rows, activeFilter, search) {
  const q = search.toLowerCase().trim();
  return rows.filter(row => {
    if (activeFilter !== 'all' && row.status !== activeFilter) return false;
    if (!q) return true;
    return [
      row.name,
      row.owner,
      row.contacts  || '',
      row.notes     || '',
      row.architect || '',
      row.gc        || '',
      row.useType   || '',
    ].join(' ').toLowerCase().includes(q);
  });
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Compute the summary stats shown in the stats bar.
 * @param {object[]} allRows     - all 28 base rows (un-filtered)
 * @param {object}   editableData
 * @returns {{ total, planned, construction, conversion, ibActive }}
 */
export function computeStats(allRows, editableData) {
  return {
    total:        allRows.length,
    planned:      allRows.filter(r => r.status === 'Planned').length,
    construction: allRows.filter(r => r.status === 'Under Construction').length,
    conversion:   allRows.filter(r => r.status === 'Conversion').length,
    ibActive:     Object.values(editableData).filter(
      d => d.ibStage && !['N/A', 'Lost', ''].includes(d.ibStage)
    ).length,
  };
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

const CSV_HEADERS = [
  'Address', 'Status', 'Use Type', 'Owner/Developer', 'Architect',
  'General Contractor', 'Key Contacts', 'Permit Status', 'IB Stage',
  'Stiles Interest', 'Latest Notes', 'Last Updated',
];

function csvCell(v) {
  return `"${String(v).replace(/"/g, '""')}"`;
}

export function buildCSV(editableData) {
  const rows = BASE_DATA.map(b => {
    const r = getRow(b.id, editableData);
    return [
      r.name,
      r.status,
      r.useType        || '',
      r.owner,
      r.architect      || '',
      r.gc             || '',
      (r.contacts      || '').replace(/\n/g, ' | '),
      r.permitStatus   || '',
      r.ibStage        || '',
      r.stilesInterest || '',
      r.notes          || '',
      r.lastUpdated    || '',
    ].map(csvCell).join(',');
  });
  return [CSV_HEADERS.join(','), ...rows].join('\r\n');
}
