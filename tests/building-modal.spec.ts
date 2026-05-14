import { test, expect } from '@playwright/test';

// A known project ID that exists in production data. Owner is Bradford Allen
// (11 buildings as of writing) so the conditional Portfolio button shows.
const KNOWN_PROJECT_ID = 'ae399b7d-ba2b-403a-809f-c8786e8766ce';

test.describe('Building modal', () => {
  test('opens via URL parameter', async ({ page }) => {
    await page.goto(`/?project=${KNOWN_PROJECT_ID}`);
    // #modalOverlay is always in the DOM with opacity:0; the .open class is
    // only added by openModal() when projects.find() matches the URL's id.
    // Asserting the class (not just visibility) proves the modal actually
    // opened with the right data — otherwise the test passes against any
    // always-present DOM node.
    await expect(page.locator('#modalOverlay')).toHaveClass(/open/, { timeout: 10_000 });
  });

  test('modal shows the project address', async ({ page }) => {
    await page.goto(`/?project=${KNOWN_PROJECT_ID}`);
    await expect(page.locator('#modalOverlay')).toHaveClass(/open/, { timeout: 10_000 });
    // openModal populates #f-address from p.address for existing projects.
    await expect(page.locator('#f-address')).not.toHaveValue('');
  });

  test('IB Scout button is present', async ({ page }) => {
    await page.goto(`/?project=${KNOWN_PROJECT_ID}`);
    await expect(page.locator('#modalOverlay')).toHaveClass(/open/, { timeout: 10_000 });
    // Specific button id — getByText('Scout') would also match the header
    // title "IB Scout" and pass even if the modal never opened.
    await expect(page.locator('#ibScoutBtn')).toBeVisible();
  });

  test('Portfolio button is present', async ({ page }) => {
    await page.goto(`/?project=${KNOWN_PROJECT_ID}`);
    await expect(page.locator('#modalOverlay')).toHaveClass(/open/, { timeout: 10_000 });
    // #portfolioReportBtn is conditionally shown (>=2 buildings for same owner,
    // js/app.js:521-526). Bradford Allen has 11. Tighter than
    // getByText('Portfolio') which matches the always-in-DOM hidden button.
    await expect(page.locator('#portfolioReportBtn')).toBeVisible({ timeout: 10_000 });
  });

  test('Copy Link button copies a URL containing the project ID', async ({ page, context, browserName }) => {
    // WebKit's Playwright integration doesn't expose the clipboard-write
    // permission. Skipping per-browser instead of globally so chromium still
    // exercises the path.
    test.skip(browserName === 'webkit', 'Clipboard API unsupported in WebKit under Playwright');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/?project=${KNOWN_PROJECT_ID}`);
    await expect(page.locator('#modalOverlay')).toHaveClass(/open/, { timeout: 10_000 });
    await page.locator('#copyLinkBtn').click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain(KNOWN_PROJECT_ID);
  });
});
