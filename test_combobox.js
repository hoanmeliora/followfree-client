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

  console.log('--- COMBOBOX FILL TEST ---');
  const combos = await page.$$('[role="combobox"]');
  if (combos.length >= 4) {
    // Fill Day (15)
    await combos[0].click();
    await page.waitForTimeout(500);
    await page.keyboard.type('15');
    await page.keyboard.press('Enter');
    console.log('Day filled');

    // Fill Month (Aug)
    await combos[1].click();
    await page.waitForTimeout(500);
    // Usually typing "8" works if the dropdown supports numbers, or we can use ArrowDown
    await page.keyboard.type('8');
    await page.keyboard.press('Enter');
    console.log('Month filled');

    // Fill Year (1995)
    await combos[2].click();
    await page.waitForTimeout(500);
    await page.keyboard.type('1995');
    await page.keyboard.press('Enter');
    console.log('Year filled');
    
    // Fill Gender (Male / 2)
    await combos[3].click();
    await page.waitForTimeout(500);
    await page.keyboard.press('ArrowDown'); // usually moves to female
    await page.keyboard.press('ArrowDown'); // moves to male
    await page.keyboard.press('Enter');
    console.log('Gender filled');
  }

  // Find Submit button
  const buttons = await page.$$('div[role="button"]');
  for (let b of buttons) {
    const text = await b.textContent();
    if (text && (text.toLowerCase().includes('đăng ký') || text.toLowerCase().includes('sign up'))) {
       console.log('FOUND SUBMIT BUTTON:', text);
       break;
    }
  }

  await browser.close();
})();
