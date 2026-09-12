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

  console.log('--- TEST OPTION CLICK ---');
  const combos = await page.$$('[role="combobox"]');
  if (combos.length >= 4) {
    // Fill Month (Aug / 8)
    await combos[1].click();
    await page.waitForTimeout(1000);
    
    // Dump all options
    const options = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[role="option"]')).map(o => o.textContent);
    });
    console.log('OPTIONS:', options);
    
    // Try to click option containing '8'
    const opts = await page.getByRole('option').all();
    for (let opt of opts) {
        const text = await opt.textContent();
        if (text === '8' || text === '08' || text === 'Aug' || text === 'August' || text.includes(' 8') || text === 'Tháng 8') {
             await opt.click();
             console.log('Clicked month option:', text);
             break;
        }
    }
  }

  await browser.close();
})();
