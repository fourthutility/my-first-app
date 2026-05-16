// IB Scout — contextual help panel
//
// Each page calls IBHelp.init('<pageKey>') after load. Clicking the `?`
// icon in the top bar opens a slide-out panel with content keyed to
// the current page. All content lives in CONTENT below so cross-page
// conventions (icons, status pills, dedupe semantics) stay in one
// file as the app grows.
//
// Adding a new surface = add an entry to CONTENT keyed by some unique
// pageKey + call IBHelp.init('<pageKey>') from that page's script.

(function () {
  "use strict";

  // Section bodies are HTML so we can render <code>, <b>, <ul> inline.
  // Keep sections short — eyes glaze past a wall of text.
  const CONTENT = {
    "pipeline": {
      title: "IB Scout — Project Pipeline",
      sections: [
        {
          heading: "What this page shows",
          body: "Every commercial building IB tracks across your target markets — roughly 3,800 rows. Click any row to open the Scout brief: permits, ownership, AI insights, recent activity — stitched together in about a minute."
        },
        {
          heading: "Top counts",
          body: "The five pills above the filter row are market-wide totals. <b>Existing</b> = operating buildings. <b>Proposed</b> = announced or permitting. <b>Pipeline</b> = new construction or under conversion. <b>IB Active Pursuits</b> = your team's in-flight deals. <b>All Markets</b> = everything in scope."
        },
        {
          heading: "Status tabs",
          body: "The tabs to the right of the search bar (<b>All</b>, <b>Existing</b>, <b>Proposed</b>, <b>Planned</b>, <b>Construction</b>, <b>Conversion</b>) filter by building lifecycle. Click to toggle."
        },
        {
          heading: "Deal stage filters",
          body: "The colored chips below the status tabs cross-filter by sales motion: <b>No Deal</b> (cold), <b>Active</b> (in progress), <b>Won</b> / <b>Lost</b> (closed outcomes), <b>Intellinet</b> (existing customer relationships)."
        },
        {
          heading: "Search & narrowers",
          body: "<ul><li><b>Search box</b> — free-text match against address, developer, or contact.</li><li><b>Market dropdown</b> — narrow to a specific geography.</li><li><b>Owner / developer</b> — filter by who owns or built the property.</li><li><b>Near Me</b> — use browser location to surface nearby buildings.</li></ul>"
        },
        {
          heading: "Table vs Map view",
          body: "Two buttons at the top-left of the filter row toggle the layout. <b>Table</b> shows full rows with every column; <b>Map</b> groups buildings geographically."
        },
        {
          heading: "Top-bar icons",
          body: "<ul><li><code>↓</code> — Export the current filtered view as CSV.</li><li><code>📡</code> <b>BD Feed</b> — incoming business-development opportunities (opens in a new tab).</li><li><code>🏢</code> <b>Portfolio Scout</b> — AI-assisted import from an owner's portfolio page (opens in a new tab).</li><li><code>?</code> — this panel.</li></ul>"
        },
        {
          heading: "CSV import",
          body: "Click the <code>⬆</code> floating button at the bottom-right to bulk-import buildings from a CSV file. Useful when your inventory came from manual research that doesn't live behind a single portfolio URL."
        }
      ]
    },

    "portfolio-scout": {
      title: "Portfolio Scout",
      sections: [
        {
          heading: "What it does",
          body: "Paste an owner's portfolio page URL. The extractor fetches the page, hands it to Claude Haiku, and pulls out the listed buildings. You review each candidate row-by-row and approve the ones that should land in Scout inventory."
        },
        {
          heading: "The form",
          body: "<ul><li><b>Owner / Company Name</b> — attribution. Becomes the <code>owner_developer</code> field on every imported row.</li><li><b>Portfolio Page URL</b> — typically <code>https://&lt;company&gt;.com/properties</code> or <code>/portfolio</code>. The cleaner / less JavaScript-heavy the page, the better the extraction.</li></ul>"
        },
        {
          heading: "Extraction methods",
          body: "The status line after a scrape names the path the extractor took:<ul><li><code>haiku_html</code> — content-bearing static HTML, parsed by Claude Haiku. The modal path.</li><li><code>sitemap</code> — the page was a JavaScript shell; candidate URLs recovered from <code>sitemap.xml</code>.</li><li><code>jsonld</code> — page exposed structured <code>RealEstateListing</code> schema. Rare. Cleanest when it happens.</li></ul>"
        },
        {
          heading: "Skip reasons",
          body: "Sometimes a URL can't be processed:<ul><li><code>skip:cloudflare</code> — bot challenge. Needs a real browser to bypass.</li><li><code>skip:fund_structure</code> — fund overview without a building list.</li><li><code>skip:shell_no_sitemap</code> — JavaScript shell with no usable sitemap.</li><li><code>skip:http_NNN</code> — bad URL or server error.</li></ul>"
        },
        {
          heading: "Confidence pill",
          body: "Each candidate carries a <code>HIGH</code> / <code>MEDIUM</code> / <code>LOW</code> pill keyed to field coverage. <b>High</b> = address + asset class + SF all present. <b>Low</b> = no address extracted (Approve will be disabled until you Enrich one in)."
        },
        {
          heading: "“✓ in Scout” badge",
          body: "Means the candidate's normalized address matched a row already in your <code>projects</code> table. Approve is disabled for duplicates; use Reject (or Enrich first, if you still want a PM verification on it). The match is exact-on-normalized — false negatives are expected, false positives essentially zero."
        },
        {
          heading: "Property Management",
          body: "Every candidate gets a default PM — the URL publisher (Stiles for stiles.com, etc.). The pill shows confidence:<ul><li><code>IMPLIED</code> — defaulted from the publisher. Not verified.</li><li><code>EXTRACTED</code> — verified via web search after you clicked Enrich.</li><li><code>UNKNOWN</code> — Enrich ran but couldn't find a credible answer.</li></ul>"
        },
        {
          heading: "Per-row actions",
          body: "<ul><li><b>Approve</b> — promotes the row into <code>projects</code>. Disabled when there's no address or the row is already in Scout.</li><li><b>Enrich</b> — per-row deeper pass: fetches the detail page (if linked) to fill missing fields, then runs a web search to verify the PM firm. Takes 5-10 seconds.</li><li><b>Reject</b> — marks rejected; no write to <code>projects</code>.</li></ul>"
        }
      ]
    }
  };

  function sectionsHtml(sections) {
    return sections.map(s => `
      <section class="ib-help-section">
        <h3>${s.heading}</h3>
        <div>${s.body}</div>
      </section>
    `).join("");
  }

  function injectPanel() {
    if (document.getElementById("ibHelpOverlay")) return;

    const css = `
      #ibHelpOverlay { position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:9500; display:none; }
      #ibHelpOverlay.open { display:block; }
      #ibHelpPanel { position:absolute; top:0; right:0; height:100vh; width:min(460px, 92vw); background:#0f172a; border-left:1px solid #1e2433; color:#e2e8f0; font-family:'Epilogue', system-ui, -apple-system, sans-serif; display:flex; flex-direction:column; transform:translateX(100%); transition:transform 0.22s ease; box-shadow:-8px 0 32px rgba(0,0,0,0.4); }
      #ibHelpOverlay.open #ibHelpPanel { transform:translateX(0); }
      .ib-help-header { display:flex; align-items:center; justify-content:space-between; padding:18px 20px; border-bottom:1px solid #1e2433; flex-shrink:0; }
      .ib-help-header h2 { font-size:15px; font-weight:700; color:#f1f5f9; margin:0; letter-spacing:.01em; }
      .ib-help-close { background:none; border:none; color:#94a3b8; font-size:18px; cursor:pointer; padding:4px 10px; line-height:1; border-radius:6px; }
      .ib-help-close:hover { color:#f1f5f9; background:#1e2433; }
      .ib-help-body { padding:18px 22px 60px; overflow-y:auto; flex:1; line-height:1.6; font-size:13px; color:#cbd5e1; }
      .ib-help-section { margin-bottom:22px; }
      .ib-help-section h3 { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.1em; color:#86efac; margin:0 0 8px; }
      .ib-help-section ul { padding-left:18px; margin:6px 0; }
      .ib-help-section li { margin-bottom:4px; }
      .ib-help-section code { background:#0a0a14; color:#fbbf24; font-family:'DM Mono', monospace; font-size:11px; padding:1px 6px; border-radius:3px; border:1px solid #1e2433; white-space:nowrap; }
      .ib-help-section b { color:#f1f5f9; font-weight:600; }
    `;

    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const overlay = document.createElement("div");
    overlay.id = "ibHelpOverlay";
    overlay.innerHTML = `
      <div id="ibHelpPanel" onclick="event.stopPropagation()">
        <div class="ib-help-header">
          <h2 id="ibHelpTitle">Help</h2>
          <button class="ib-help-close" onclick="IBHelp.close()" title="Close (ESC)">✕</button>
        </div>
        <div class="ib-help-body" id="ibHelpBody"></div>
      </div>
    `;
    overlay.addEventListener("click", () => window.IBHelp.close());
    document.body.appendChild(overlay);

    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && overlay.classList.contains("open")) window.IBHelp.close();
    });
  }

  window.IBHelp = {
    pageKey: null,

    init(pageKey) {
      this.pageKey = pageKey;
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", injectPanel);
      } else {
        injectPanel();
      }
    },

    open() {
      const content = CONTENT[this.pageKey];
      if (!content) { console.warn("IBHelp: no content for pageKey", this.pageKey); return; }
      const titleEl = document.getElementById("ibHelpTitle");
      const bodyEl  = document.getElementById("ibHelpBody");
      if (!titleEl || !bodyEl) return;
      titleEl.textContent = content.title;
      bodyEl.innerHTML    = sectionsHtml(content.sections);
      bodyEl.scrollTop    = 0;
      document.getElementById("ibHelpOverlay").classList.add("open");
    },

    close() {
      const overlay = document.getElementById("ibHelpOverlay");
      if (overlay) overlay.classList.remove("open");
    }
  };
})();
