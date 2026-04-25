// scout-og — OG meta proxy for IB Scout share links
//
// iMessage / Slack / LinkedIn crawl URLs before JS runs, so GitHub Pages
// can never serve address-specific OG tags.  This tiny edge function:
//   1. Fetches the project record to get the address
//   2. Returns an HTML shell with correct OG tags
//   3. Immediately redirects the browser to the real GitHub Pages report
//
// Share URL format:
//   https://<project>.supabase.co/functions/v1/scout-og?id=<project_uuid>
//
// Deploy: supabase functions deploy scout-og

const SB_URL     = Deno.env.get("SUPABASE_URL")!;
const SB_SRK     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REPORT_BASE = "https://fourthutility.github.io/my-first-app/scout-report.html";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const id  = url.searchParams.get("id") || url.searchParams.get("project");

  if (!id) return Response.redirect(REPORT_BASE, 302);

  const reportUrl = `${REPORT_BASE}?project=${id}`;

  // Fetch just enough to get the address — fast, no heavy joins
  let address = "";
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/projects?id=eq.${encodeURIComponent(id)}&select=address,scout_brief`,
      { headers: { "apikey": SB_SRK, "Authorization": `Bearer ${SB_SRK}` } }
    );
    if (res.ok) {
      const rows = await res.json() as Array<{ address?: string; scout_brief?: { formatted_address?: string } }>;
      const row = rows[0];
      if (row) address = row.scout_brief?.formatted_address || row.address || "";
    }
  } catch (_) { /* fall through — redirect without address */ }

  const title = address ? `IB Scout — ${address}` : "IB Scout Report";
  const desc  = address
    ? `Property intelligence report for ${address} · Intelligent Buildings`
    : "Property intelligence report by Intelligent Buildings";

  // Escape for HTML attribute context
  const esc = (s: string) => s.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${esc(reportUrl)}">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:site_name" content="IB Scout · Intelligent Buildings">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(reportUrl)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<script>window.location.replace(${JSON.stringify(reportUrl)})</script>
</head>
<body style="background:#0a0a0f;color:#e2e8f0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:10px">
<div style="font-size:22px;font-weight:800;color:#4ade80">IB Scout</div>
<div style="font-size:13px;color:#64748b">Loading report…</div>
</body></html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});
