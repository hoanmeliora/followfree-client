const { chromium } = require('playwright-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(stealthPlugin());

(async () => {
  const browser = await chromium.launch({ headless: true });
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

  const labels = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input');
    return Array.from(inputs).map(i => {
      let parent = i.parentElement;
      while (parent && parent.tagName !== 'LABEL' && parent.tagName !== 'DIV') {
        parent = parent.parentElement;
      }
      return parent ? parent.innerText : 'none';
    });
  });
  console.log('--- INPUT WRAPPERS TEXT ---');
  console.log(labels);

  const rawDom = await page.evaluate(() => document.body.innerHTML.substring(0, 5000));
  console.log('--- DOM SNIPPET ---');
  console.log(rawDom);

  await browser.close();
})();
