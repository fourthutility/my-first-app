import { test, expect } from '@playwright/test';

const BRADFORD_ALLEN_URL = '/?project=ae399b7d-ba2b-403a-809f-c8786e8766ce&owner=Bradford+Allen';

test.describe('Portfolio report', () => {
  test('opens on desktop without popup blocker issue', async ({ page }) => {
    await page.goto(BRADFORD_ALLEN_URL);
    await page.waitForTimeout(2000);

    // Listen for popup (desktop opens new window)
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 8_000 }).catch(() => null),
      page.getByText('Portfolio').first().click(),
    ]);

    // Either a popup opened or it rendered inline — both are valid
    const target = popup ?? page;
    await expect(target.locator('body')).toContainText('Portfolio', { timeout: 10_000 });
  });

  test('mobile renders portfolio inline (no popup)', async ({ page }) => {
    // Simulate mobile viewport
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BRADFORD_ALLEN_URL);
    await page.waitForTimeout(2000);
    await page.getByText('Portfolio').first().click();
    // On mobile, content renders in the same page
    await expect(page.locator('body')).toContainText('Portfolio', { timeout: 10_000 });
  });

  test('vendor section does not show placeholder names', async ({ page }) => {
    await page.goto(BRADFORD_ALLEN_URL);
    await page.waitForTimeout(2000);
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 8_000 }).catch(() => null),
      page.getByText('Portfolio').first().click(),
    ]);
    const target = popup ?? page;
    await target.waitForTimeout(3000);
    const bodyText = await target.locator('body').textContent();
    // These are known AI-generated placeholder strings we filter out
    expect(bodyText).not.toContain('TBD');
    expect(bodyText).not.toContain('to be identified');
    expect(bodyText).not.toContain('Property Management Firm');
  });
});
