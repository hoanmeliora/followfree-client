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
  await page.waitForTimeout(4000); 

  console.log('--- URL ---');
  console.log(page.url());

  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input')).map(i => ({
      name: i.name,
      type: i.type,
      id: i.id,
      ariaLabel: i.getAttribute('aria-label')
    }));
  });
  console.log('--- INPUTS ---');
  console.log(inputs);

  const selects = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('select')).map(s => ({
      name: s.name,
      id: s.id,
      ariaLabel: s.getAttribute('aria-label')
    }));
  });
  console.log('--- SELECTS ---');
  console.log(selects);

  await browser.close();
})();
