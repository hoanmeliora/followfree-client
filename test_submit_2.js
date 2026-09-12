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

  console.log('--- FIND SIGN UP BTN ---');
  const texts = ['Đăng ký', 'Sign Up', 'Tiếp', 'Tạo tài khoản mới', 'Tạo tài khoản'];
  let found = false;
  for (let t of texts) {
      const locators = await page.getByText(t, { exact: true }).all();
      if (locators.length > 0) {
          console.log(`FOUND BUTTON WITH TEXT: ${t}`);
          found = true;
          break;
      }
  }

  if (!found) {
      console.log('Dumping all text content...');
      const allTexts = await page.evaluate(() => document.body.innerText);
      console.log(allTexts);
  }

  await browser.close();
})();
