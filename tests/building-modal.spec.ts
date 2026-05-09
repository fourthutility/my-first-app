import { test, expect } from '@playwright/test';

// A known project ID that exists in production data
const KNOWN_PROJECT_ID = 'ae399b7d-ba2b-403a-809f-c8786e8766ce'; // Bradford Allen

test.describe('Building modal', () => {
  test('opens via URL parameter', async ({ page }) => {
    await page.goto(`/?project=${KNOWN_PROJECT_ID}`);
    // Modal should open automatically
    await expect(page.locator('#modal, [id*="modal"]').first()).toBeVisible({ timeout: 10_000 });
  });

  test('modal shows address', async ({ page }) => {
    await page.goto(`/?project=${KNOWN_PROJECT_ID}`);
    await page.waitForTimeout(2000); // allow data to load
    const modal = page.locator('#modal').first();
    await expect(modal).toBeVisible({ timeout: 10_000 });
    // Address field should not be empty
    const addressInput = modal.locator('input[id*="address"], input').first();
    const val = await addressInput.inputValue().catch(() => '');
    expect(val.length).toBeGreaterThan(0);
  });

  test('Scout button is present', async ({ page }) => {
    await page.goto(`/?project=${KNOWN_PROJECT_ID}`);
    await page.waitForTimeout(2000);
    await expect(page.getByText('Scout').first()).toBeVisible({ timeout: 10_000 });
  });

  test('Portfolio button is present', async ({ page }) => {
    await page.goto(`/?project=${KNOWN_PROJECT_ID}`);
    await page.waitForTimeout(2000);
    await expect(page.getByText('Portfolio').first()).toBeVisible({ timeout: 10_000 });
  });

  test('Copy Link button copies a URL containing the project ID', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/?project=${KNOWN_PROJECT_ID}`);
    await page.waitForTimeout(2000);
    await page.getByText('Copy Link').click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain(KNOWN_PROJECT_ID);
  });
});
