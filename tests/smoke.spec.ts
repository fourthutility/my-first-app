import { test, expect } from '@playwright/test';

test.describe('Smoke — app loads', () => {
  test('page title and header render', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('IB Scout');
    await expect(page.locator('.header-title')).toContainText('IB Scout');
  });

  test('version footer is present and not 1.0.0', async ({ page }) => {
    await page.goto('/');
    const footer = page.locator('#app-version-footer');
    await expect(footer).toBeVisible();
    const text = await footer.textContent();
    expect(text).toContain('v0.');           // pre-1.0
    expect(text).not.toContain('v1.0.0');   // guard against accidental bump
  });

  test('map view renders the map container', async ({ page }) => {
    await page.goto('/');
    // App defaults to table view (#tableWrap visible, #mapWrap hidden).
    // switchView('map') adds .visible to #mapWrap (see js/app.js:3197).
    await page.locator('#btnMap').click();
    await expect(page.locator('#mapWrap')).toHaveClass(/visible/);
  });

  test('view toggle works', async ({ page }, testInfo) => {
    await page.goto('/');
    // Default is table view, so toggle to map first to make the back-toggle
    // observable. switchView writes inline display style on #tableWrap and
    // toggles .visible on #mapWrap (see js/app.js:3193).
    await page.locator('#btnMap').click();
    await expect(page.locator('#mapWrap')).toHaveClass(/visible/);
    await page.locator('#btnTable').click();

    // On mobile (≤768px viewport) the desktop #tableWrap stays hidden via
    // `display: none !important` in css/app.css:935 — the mobile UX swaps in
    // the card layout (#mobileCards). Assert the right surface per project.
    const isMobile = testInfo.project.name === 'Mobile Safari';
    const tableSurface = isMobile ? '#mobileCards' : '#tableWrap';
    await expect(page.locator(tableSurface)).toBeVisible();
  });

  test('market filter dropdown is present', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#metroSelect')).toBeVisible();
  });
});
