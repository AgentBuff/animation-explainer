#!/usr/bin/env node
/**
 * export-video.mjs · 把一个 demo 录制成 MP4 视频（动画 + 口播音轨）
 *
 * 工作流：
 *   1. Playwright headless Chromium 加载 HTML，录制 WebM（无音轨 — Playwright 的限制）
 *   2. ffmpeg 把每节 mp3 拼起来，节间补 1.2s 静音（对齐 HTML 的 ADVANCE_BUFFER_MS）
 *   3. 开头加 1s pre-roll 静音（对齐浏览器 autoplay 启动延迟）
 *   4. ffmpeg 把 WebM + 音轨合成 MP4
 *
 * 用法：
 *   node scripts/export-video.mjs <demo-dir> [--width=1280] [--height=800] [--fps=30]
 *
 * 前置：
 *   - 已经跑过 `node scripts/generate-audio.mjs <demo-dir>` 生成 audio/ 目录
 *   - 已经 `npm install` 装好 playwright
 *   - 已经 `npx playwright install chromium` 装好浏览器
 *   - 系统装了 ffmpeg（brew install ffmpeg）
 *
 * 输出：
 *   <demo-dir>/video.mp4
 */

import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { readdir, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ───────────── 参数解析 ─────────────
const args = process.argv.slice(2);
const targetDir = args.find(a => !a.startsWith('--'));
const get = (k, d) => {
  const a = args.find(x => x.startsWith(`--${k}=`));
  return a ? a.split('=')[1] : d;
};
const width  = parseInt(get('width',  '1280'), 10);
const height = parseInt(get('height', '800'),  10);
const fps    = parseInt(get('fps',    '30'),   10);

if (!targetDir) {
  console.error('用法: node scripts/export-video.mjs <demo-dir> [--width=1280] [--height=800] [--fps=30]');
  process.exit(1);
}

// ───────────── 前置检查 ─────────────
try { execSync('ffmpeg -version', { stdio: 'pipe' }); }
catch { console.error('❌ ffmpeg 未安装。brew install ffmpeg'); process.exit(1); }

const htmlPath = path.resolve(targetDir, 'index.html');
const audioDir = path.join(targetDir, 'audio');
if (!existsSync(htmlPath)) {
  console.error(`❌ 找不到 ${htmlPath}`);
  process.exit(1);
}
if (!existsSync(audioDir)) {
  console.error(`❌ 找不到 ${audioDir}/`);
  console.error(`   先跑: node scripts/generate-audio.mjs ${targetDir}`);
  process.exit(1);
}

const audioFiles = (await readdir(audioDir))
  .filter(f => /^scene-\d+\.mp3$/.test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

if (!audioFiles.length) {
  console.error(`❌ ${audioDir}/ 里没有 scene-N.mp3 文件`);
  process.exit(1);
}

// ───────────── 计算时长 ─────────────
function getDuration(file) {
  return parseFloat(execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`,
    { encoding: 'utf8' }
  ).trim());
}

const BUFFER_S   = 1.2;   // 跟 HTML 的 ADVANCE_BUFFER_MS 一致
const PRE_ROLL_S = 1.0;   // 头部静音，对齐浏览器 autoplay 启动延迟
const END_PAD_S  = 0.5;   // 尾部留白，避免 -shortest 切早最后一帧

const durations = audioFiles.map(f => getDuration(path.join(audioDir, f)));
const totalAudio = durations.reduce((a, b) => a + b, 0) + audioFiles.length * BUFFER_S;
const totalRecord = PRE_ROLL_S + totalAudio + END_PAD_S + 1; // 多录 1s 安全

console.log(`📁 ${targetDir}`);
console.log(`🎬 ${audioFiles.length} 节 · 视口 ${width}x${height} @ ${fps}fps`);
console.log(`⏱️  音频总长 ${totalAudio.toFixed(1)}s · 录制 ${totalRecord.toFixed(1)}s`);

// ───────────── 1. Playwright 录制 ─────────────
const tmpDir = path.join(targetDir, '.video-tmp');
await rm(tmpDir, { recursive: true, force: true });
await mkdir(tmpDir, { recursive: true });

console.log(`\n🔴 录制中 (约 ${Math.ceil(totalRecord)}s)...`);
const browser = await chromium.launch({
  headless: true,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',                          // 我们不要 Playwright 录音轨（它本来也录不到），免得喇叭吵
    '--disable-blink-features=AutomationControlled',
    `--window-size=${width},${height}`,
  ],
});
const context = await browser.newContext({
  viewport: { width, height },
  recordVideo: { dir: tmpDir, size: { width, height } },
});
const page = await context.newPage();
await page.goto(`file://${htmlPath}`);
// 触发一次"用户手势"，绕开 autoplay 限制（即便 flag 已开也保险）
await page.evaluate(() => document.body.click());

await page.waitForTimeout(totalRecord * 1000);

await context.close();
await browser.close();

const webmFiles = (await readdir(tmpDir)).filter(f => f.endsWith('.webm'));
if (!webmFiles.length) { console.error('❌ 没找到录制的 WebM'); process.exit(1); }
const webmPath = path.join(tmpDir, webmFiles[0]);
console.log(`✓ 录制完成: ${(statSync(webmPath).size / 1024 / 1024).toFixed(1)} MB`);

// ───────────── 2. 拼接音轨 ─────────────
console.log(`\n🎵 拼接音轨...`);

// 一个 ffmpeg 命令搞定：
//   - 输入 0: anullsrc 生成 PRE_ROLL 秒静音
//   - 输入 1..N: 每节 mp3
//   - 每节 mp3 apad 1.2s
//   - 把 silence + 所有 padded mp3 concat 起来
const sceneInputs = audioFiles.map(f => `-i "${path.join(audioDir, f)}"`).join(' ');
const padFilters = audioFiles.map((_, i) =>
  `[${i + 1}:a]apad=pad_dur=${BUFFER_S}[a${i}]`
).join(';');
const concatLabels = audioFiles.map((_, i) => `[a${i}]`).join('');
const filter = [
  `[0:a]atrim=0:${PRE_ROLL_S}[silence]`,
  padFilters,
  `[silence]${concatLabels}concat=n=${audioFiles.length + 1}:v=0:a=1[out]`,
].join(';');

const audioMixed = path.join(tmpDir, 'mixed.m4a');
execSync([
  'ffmpeg -y -hide_banner -loglevel error',
  `-f lavfi -i anullsrc=cl=mono:r=24000:d=${PRE_ROLL_S + 1}`,
  sceneInputs,
  `-filter_complex "${filter}"`,
  `-map "[out]" -c:a aac -b:a 128k "${audioMixed}"`,
].join(' '), { stdio: 'inherit' });
console.log(`✓ 音轨拼好: ${(statSync(audioMixed).size / 1024).toFixed(0)} KB`);

// ───────────── 3. mux 音视频 ─────────────
console.log(`\n🎬 输出 MP4...`);
const outputPath = path.join(targetDir, 'video.mp4');
execSync([
  'ffmpeg -y -hide_banner -loglevel error',
  `-i "${webmPath}"`,
  `-i "${audioMixed}"`,
  '-c:v libx264 -preset medium -crf 22',
  '-c:a aac -b:a 128k',
  '-pix_fmt yuv420p',                   // 兼容 QuickTime / 微信 / 抖音
  '-movflags +faststart',               // 网页流播友好
  `-r ${fps}`,
  '-shortest',                           // 跟音轨同长
  `"${outputPath}"`,
].join(' '), { stdio: 'inherit' });

// ───────────── 4. 清理 ─────────────
await rm(tmpDir, { recursive: true, force: true });

const outSize = (statSync(outputPath).size / 1024 / 1024).toFixed(1);
const outDur = getDuration(outputPath);
console.log(`\n✅ 完成`);
console.log(`   ${outputPath}`);
console.log(`   ${outSize} MB · ${outDur.toFixed(1)}s · ${width}x${height} @ ${fps}fps`);
