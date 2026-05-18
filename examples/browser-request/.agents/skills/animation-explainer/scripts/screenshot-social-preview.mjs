#!/usr/bin/env node
/**
 * 把 social-preview/preview.html 渲染为 1280×640 PNG（@2x retina）
 * 用于 GitHub 仓库的 Social Preview（Settings → General → Social preview）
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const htmlPath = path.join(root, 'social-preview/preview.html');
const outPath = path.join(root, 'social-preview/social-preview.png');

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 640 },
  deviceScaleFactor: 1,  // 1280×640 原生（GitHub 上限 1MB，2x retina 会超）
});
const page = await ctx.newPage();
await page.goto('file://' + htmlPath);
await page.waitForLoadState('networkidle');
await page.waitForTimeout(800);  // 等 Google Fonts 加载
await page.screenshot({ path: outPath, type: 'png', fullPage: false });
await browser.close();
console.log(`✓ ${outPath}`);
