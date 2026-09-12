const { chromium } = require('playwright-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(stealthPlugin());

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    viewport: { width: 400, height: 800 },
    isMobile: true
  });
  const page = await context.newPage();
  
  await page.goto('https://mbasic.facebook.com/reg', { waitUntil: 'networkidle' });
  await page.waitForTimeout(6000); 

  console.log('--- URL ---');
  console.log(page.url());

  const bodyText = await page.evaluate(() => document.body.textContent || '');
  console.log('--- BODY SNIPPET ---');
  console.log(bodyText.substring(0, 200));

  console.log('--- INPUTS ---');
  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input')).map(i => ({
      type: i.type,
      name: i.name,
      id: i.id,
      placeholder: i.placeholder,
      ariaLabel: i.getAttribute('aria-label')
    }));
  });
  console.log(inputs);

  console.log('--- SELECTS ---');
  const selects = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('select')).map(s => ({
      name: s.name,
      id: s.id,
      title: s.title,
      ariaLabel: s.getAttribute('aria-label')
    }));
  });
  console.log(selects);

  await browser.close();
})();
