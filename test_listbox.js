const { chromium } = require('playwright-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(stealthPlugin());

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();
  
  await page.goto('https://www.facebook.com/reg', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000); 

  console.log('--- COMBOBOX LISTBOX TEST ---');
  const combos = await page.$$('[role="combobox"]');
  if (combos.length >= 4) {
    // Fill Month (Aug / 8) -> Index 7
    await combos[1].click();
    await page.waitForTimeout(500);
    const mOpts = await page.locator('[role="listbox"]').getByRole('option').all();
    console.log(`Found ${mOpts.length} month options. Clicking index 7...`);
    await mOpts[7].click();

    await page.waitForTimeout(500);
    const mText = await combos[1].textContent();
    console.log(`Month is now: ${mText}`);
  }

  await browser.close();
})();
