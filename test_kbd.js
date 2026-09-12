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

  console.log('--- STARTING KEYBOARD NAV ---');
  const textInputs = await page.$$('input[type="text"]');
  if (textInputs.length > 0) {
    await textInputs[0].focus();
    console.log('Focused Input 0');
    
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Tab');
      const activeElementTag = await page.evaluate(() => document.activeElement.tagName);
      const activeElementType = await page.evaluate(() => document.activeElement.type);
      const activeElementRole = await page.evaluate(() => document.activeElement.getAttribute('role'));
      const activeElementText = await page.evaluate(() => document.activeElement.innerText || document.activeElement.textContent);
      console.log(`Tab ${i + 1}: Tag=${activeElementTag}, Type=${activeElementType}, Role=${activeElementRole}, Text=${activeElementText.substring(0, 30).trim()}`);
    }
  }

  await browser.close();
})();
