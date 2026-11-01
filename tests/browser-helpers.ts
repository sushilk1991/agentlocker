import { expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const browserMatrix = [
 {width: 1280, theme: 'light'}, {width: 390, theme: 'light'},
 {width: 1280, theme: 'dark'}, {width: 390, theme: 'dark'},
] as const;
// Beside the checkout, including /workspace/agentlocker-shots in this workspace.
export const screenshotDirectory = fileURLToPath(new URL('../../agentlocker-shots/', import.meta.url));

// Only curated local fixtures reach the gallery. Never capture token issuance.
export async function captureScreen(page: Page, screen: string, width: number, theme: 'light' | 'dark') {
 await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^$/);
 await expect(page.locator('#issued-token')).toHaveCount(0);
 for (const input of await page.locator('input[type=password]').all()) await expect(input).toHaveValue('');
 await expect(page.locator('.skeleton')).toHaveCount(0);
 await page.evaluate(() => window.scrollTo(0, 0));
 await expectNoPageOverflow(page);
 // Small text must remain readable on every surface used by the shell.
 const palette = await page.evaluate(() => {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(['muted', 'background', 'card', 'wash'].map(name => [name, style.getPropertyValue('--' + name).trim()]));
 });
 const luminance = (hex: string) => {
  if (hex.length === 4) hex = '#' + [...hex.slice(1)].map(digit => digit + digit).join('');
  const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
   .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
 };
 const text = luminance(palette.muted);
 for (const surface of ['background', 'card', 'wash']) {
  const background = luminance(palette[surface]);
  expect((Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05), `${theme} muted text on ${surface}`).toBeGreaterThanOrEqual(4.5);
 }
 await mkdir(screenshotDirectory, {recursive: true});
 const modal = await page.getByRole('dialog').count() + await page.getByRole('alertdialog').count();
 await page.screenshot({path: `${screenshotDirectory}/${screen}-${theme}-${width}.png`, fullPage: modal === 0, animations: 'disabled'});
}

export async function expectNoPageOverflow(page: Page) {
 await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
