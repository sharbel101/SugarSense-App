const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const URL = 'http://localhost:4173';
const VIEWPORT = { width: 390, height: 844 };

async function shot(page, name) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log('captured', name);
}

async function main() {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.setViewportSize(VIEWPORT);

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot(page, '01-home');

  await page.getByRole('button', { name: 'Predict', exact: true }).click();
  await shot(page, '02-predict');

  // reveal the "why this forecast" advanced details panel
  await page.getByText('Advanced details').click();
  await shot(page, '03-predict-advanced');

  await page.getByRole('button', { name: 'Scan a meal' }).click();
  await shot(page, '04-scan-camera');

  await page.getByLabel('Take photo').click();
  await shot(page, '05-meal-review');

  await page.getByText('Confirm', { exact: true }).click();
  await shot(page, '06-post-meal');

  await page.getByText('Review calculation').click();
  await shot(page, '07-post-meal-calc');

  // "Done" returns to the Home tab, which brings the bottom nav back
  await page.getByText('Done', { exact: true }).click();
  await page.waitForTimeout(300);

  await page.getByRole('button', { name: 'Safety', exact: true }).click();
  await shot(page, '08-safety-normal');

  await page.getByText('Preview: Attention').click();
  await shot(page, '09-safety-attention');

  await page.getByRole('button', { name: 'Insights', exact: true }).click();
  await shot(page, '10-insights');

  await page.getByLabel('Profile and settings').last().click();
  await shot(page, '11-profile');

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
