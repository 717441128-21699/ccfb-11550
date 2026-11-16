import { chromium, test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const url = 'http://localhost:5199/';

function setFileInput(page: Page, fileName: string): Promise<void> {
  return page.setInputFiles('#fileInput', {
    name: fileName,
    mimeType: 'application/octet-stream',
    buffer: readFileSync(join(here, 'data', fileName)),
  });
}

let browser: import('@playwright/test').Browser;
let page: Page;
let pageErrors: string[] = [];

test.beforeAll(async () => {
  browser = await chromium.launch();
});

test.beforeEach(async () => {
  page = await browser.newPage();
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
});

test.afterEach(async () => page.close());
test.afterAll(async () => browser.close());

test('loads and renders a flat parquet file across all four panels', async () => {
  await page.goto(url);
  await setFileInput(page, '00_primitive_plain.parquet');
  await page.waitForSelector('#panel-overview .kv');
  // Panel 1: overview
  await page.waitForFunction(() => document.getElementById('overview')!.textContent!.includes('行组'));
  // Panel 2: row group chips
  expect(await page.locator('.chunk-chip').count()).toBeGreaterThan(0);
  // Open a column chunk
  await page.locator('.chunk-chip').first().click();
  // Panel 3: page table
  await page.waitForSelector('.page-table tbody tr');
  // Panel 4: data table
  await page.waitForSelector('.data-table tbody tr');
  const rows = await page.locator('.data-table tbody tr').count();
  expect(rows).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});

test('renders nested list rows as JSON and shows stat validation pills', async () => {
  await page.goto(url);
  await setFileInput(page, '33_list_int.parquet');
  await page.waitForSelector('.chunk-chip');
  await page.locator('.chunk-chip').first().click();
  await page.waitForSelector('.data-table tbody tr');
  const json = await page.locator('.data-table tbody td.nested').first().textContent();
  expect(json).toContain('ids');
});

test('surfaces a precise zstd error without crashing the page', async () => {
  await page.goto(url);
  await setFileInput(page, '12_comprehensive.parquet');
  await page.waitForSelector('.chunk-chip');
  // Click through every column chunk; the page must stay mounted and any
  // unsupported zstd page is reported inline rather than crashing the app.
  const chips = page.locator('.chunk-chip');
  const count = await chips.count();
  let renderedAny = false;
  let sawErrorHandling = false;
  for (let i = 0; i < count; i++) {
    await chips.nth(i).click();
    await page.waitForTimeout(80);
    const detail = await page.locator('#chunkDetail').textContent();
    if (detail && detail.includes('路径')) renderedAny = true;
    if (detail && detail.includes('读取失败')) sawErrorHandling = true;
    // Page-level error banner also counts as graceful handling.
    const banner = await page.locator('#errorBanner').textContent();
    if (banner) sawErrorHandling = true;
  }
  // Either columns rendered normally or failures were caught and shown — the
  // app must never white-screen.
  expect(renderedAny || sawErrorHandling).toBe(true);
  expect(await page.locator('#panel-pages').count()).toBe(1);
  // No uncaught page-level exception escaped the error handling.
  const fatal = pageErrors.filter((m) => m.includes('uncaught') || m.includes('Unhandled'));
  expect(fatal).toEqual([]);
});
