"use strict";

const { chromium } = require('playwright');

const TARGET_URL = 'http://127.0.0.1:3002';
const ADMIN_SECRET = 'b544162a9a4b07c91491c94a654ca425940c0624cb44d67a10799d6d4513a506';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    extraHTTPHeaders: {
      'Authorization': `Basic ${Buffer.from(`admin:${ADMIN_SECRET}`).toString('base64')}`
    }
  });
  const page = await context.newPage();

  try {
    console.log('Navigating to /sources...');
    await page.goto(`${TARGET_URL}/sources`);

    await page.waitForSelector('.sources-table');

    const lastRowOptions = page.locator('.sources-table tbody tr:last-child .run-options summary');
    console.log('Expanding options for the last row...');
    await lastRowOptions.click();

    await page.waitForTimeout(500);

    const lastRow = page.locator('.sources-table tbody tr:last-child');
    await lastRow.screenshot({ path: '/home/wille/services/datorse_scraper/screenshots/verification_last_row.png' });
    
    await page.screenshot({ path: '/home/wille/services/datorse_scraper/screenshots/verification_full.png', fullPage: true });

    console.log('Screenshots saved to screenshots/ directory.');
  } catch (err) {
    console.error('Test failed:', err);
  } finally {
    await browser.close();
  }
})();
