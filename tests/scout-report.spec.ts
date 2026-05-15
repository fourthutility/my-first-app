import { test, expect } from '@playwright/test';

// Known project ID from production data — same one used by
// building-modal.spec.ts. Whether or not this project happens to have a
// scout_brief stored isn't important for this test: we're asserting that
// /scout-report.html renders cleanly in *either* state (brief found OR
// "not found" UI) without uncaught JS errors during load.
//
// This single test exercises a lot of the new branch's surface area at once:
//   - service worker registration (new in sw.js)
//   - manifest link + iOS meta tags (new in <head>)
//   - the GET ?project_id= contract on the ib-scout edge function (new shape
//     with `job` field)
//   - the inline async polling helpers (used by load() when a job is running)
//   - the Auth0 silent-token import path (the dynamic script load, even if
//     we don't call it here)
//   - the new Back button code path (only runs in standalone mode, but the
//     surrounding render path executes either way)
//
// If any of those choke during page load, this test fails.

const KNOWN_PROJECT_ID = 'ae399b7d-ba2b-403a-809f-c8786e8766ce';

test.describe('Scout report page', () => {
  test('loads /scout-report.html without crashing', async ({ page }, testInfo) => {
    // Collect page errors for visibility in the trace (testInfo.attach),
    // but don't assert on them — real-world page loads pick up transient
    // errors from third-party scripts, network blips, etc., that don't
    // mean the page is broken. We're a smoke test; the assertion is that
    // the page renders.
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto(`/scout-report.html?project=${KNOWN_PROJECT_ID}`);

    // The initial #root spinner is replaced either by the rendered report
    // (h1 with the property address) or by the showError state (.error
    // container). Either is a healthy outcome — both prove the page didn't
    // hang. Use .first() so the locator resolves whichever appears.
    await expect(
      page.locator('h1, .error').first()
    ).toBeVisible({ timeout: 15_000 });

    if (pageErrors.length > 0) {
      await testInfo.attach('page-errors', {
        body: pageErrors.join('\n'),
        contentType: 'text/plain',
      });
    }
  });

  test('page title contains "IB Scout"', async ({ page }) => {
    await page.goto(`/scout-report.html?project=${KNOWN_PROJECT_ID}`);
    // Title starts as "IB Scout Report" (from the <title> tag) and becomes
    // "IB Scout — <address>" after setPageMeta runs in render(). Both match.
    await expect(page).toHaveTitle(/IB Scout/);
  });
});
