#!/usr/bin/env node
/**
 * export-video.mjs · 把一个 demo 录制成 MP4 视频（动画 + 口播音轨）
 *
 * 工作流：
 *   1. Playwright headless Chromium 加载 HTML，录制 WebM（无音轨 — Playwright 的限制）
 *   2. ffmpeg 把每节 mp3 拼起来，节间补 1.2s 静音（对齐 HTML 的 ADVANCE_BUFFER_MS）
 *   3. 开头加 pre-roll 静音（对齐浏览器 autoplay 启动延迟）
 *   4. ffmpeg 把 WebM + 音轨合成 MP4
 *
 * 封面两种模式（自动识别）：
 *   A. audio/cover.mp3 存在 — HTML 里有 cover 节，封面跟普通节一样被录制，
 *      cover.png 取自首节渲染稳定后的截屏
 *   B. audio/cover.mp3 不存在（旧 demo）— 注入静态封面 overlay，
 *      截屏存 cover.png，2s 静态封面拼在 MP4 开头
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
import { readdir, mkdir, rm, stat, copyFile } from 'node:fs/promises';
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

const allAudio = await readdir(audioDir);
const sceneFiles = allAudio
  .filter(f => /^scene-\d+\.mp3$/.test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
const hasCoverMp3 = allAudio.includes('cover.mp3');
const audioFiles = hasCoverMp3 ? ['cover.mp3', ...sceneFiles] : sceneFiles;

if (!audioFiles.length) {
  console.error(`❌ ${audioDir}/ 里没有 scene-N.mp3 / cover.mp3 文件`);
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
const COVER_S    = 2.0;   // 仅在无 cover.mp3 时使用：静态封面静帧时长

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
const recT0 = Date.now();   // 录制时间基准 — 用于后面计算 webm 要裁掉多少"准备阶段"
await page.goto(`file://${htmlPath}`);
await page.waitForTimeout(800);  // 等 demo 渲染稳定，再注入封面

// ───────── 封面 ─────────
// 模式 A（hasCoverMp3）：HTML 有 cover 节，直接从渲染稳定后的页面截屏当 cover.png；
//                       cover 节自己会被录进 webm，不再注入静态封面
// 模式 B（无 cover.mp3）：注入全屏标题层，screenshot，再移除 → 启动播放
const coverPath = path.join(tmpDir, 'cover.png');
let skipS;
if (hasCoverMp3) {
  // 此时页面正展示 CHAPTERS[0] = cover 节（HTML init 阶段就 goTo(0)）
  // 等 cover overlay 入场动画完成（CSS transition 最长 ~0.85s），再截屏
  await page.waitForTimeout(900);
  await page.screenshot({ path: coverPath, type: 'png' });
  // 触发"用户手势"，绕开 autoplay 限制
  await page.evaluate(() => document.body.click());
  // 模式 A 不需要裁帧 — cover 节就是正片开头，整段 webm 都要
  // 但 goto + 等渲染稳定 这段仍是准备帧（封面已经出现但 cover.mp3 还没"开播"对齐）
  // 这里设 skipS=0，因为头部静音 PRE_ROLL_S 会自然对齐
  skipS = 0;
  console.log(`🖼  封面取自首节渲染稳定后的截图（cover 节会被录入正片）`);
} else {
  await page.evaluate(() => {
    const t = (document.title || '').trim();
    // 支持 em dash / en dash / hyphen 分隔主副标题
    const seg = t.split(/\s+[—–\-]\s+/).map(s => s.trim()).filter(Boolean);
    const main = seg[0] || t || 'Animation Explainer';
    const sub  = seg.slice(1).join(' · ');
    const cover = document.createElement('div');
    cover.id = '__cover__';
    cover.style.cssText = [
      'position:fixed','inset:0','z-index:99999',
      'background:radial-gradient(ellipse at 50% 38%, #0d1430 0%, #04060d 65%, #02030a 100%)',
      'display:flex','flex-direction:column','justify-content:center','align-items:center',
      'font-family:"Inter Tight","Inter",system-ui,sans-serif',
      'color:#e8edf6',
      'background-image:radial-gradient(ellipse at 50% 38%, #0d1430 0%, #04060d 65%, #02030a 100%),linear-gradient(rgba(148,163,184,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(148,163,184,.06) 1px,transparent 1px)',
      'background-size:100% 100%,48px 48px,48px 48px',
      'background-blend-mode:normal,normal,normal',
    ].join(';');
    cover.innerHTML = `
      <div style="font-size:13px;letter-spacing:.34em;color:#22d3ee;margin-bottom:30px;text-transform:uppercase;font-weight:500;">Animation Explainer</div>
      <div style="font-size:56px;font-weight:700;letter-spacing:-.02em;margin:0 60px 22px;text-align:center;line-height:1.12;max-width:1080px;">${main}</div>
      ${sub ? `<div style="font-size:20px;color:#94a3b8;font-weight:400;letter-spacing:.01em;text-align:center;max-width:820px;padding:0 40px;line-height:1.55;">${sub}</div>` : ''}
      <div style="position:absolute;bottom:42px;font-size:11px;color:#475569;letter-spacing:.22em;text-transform:uppercase;font-weight:500;">animation-explainer · visualized &amp; narrated</div>
    `;
    document.body.appendChild(cover);
  });
  await page.waitForTimeout(350);
  await page.screenshot({ path: coverPath, type: 'png' });
  await page.evaluate(() => {
    document.getElementById('__cover__')?.remove();
    document.body.click();
  });
  // webm 从 newContext 起就在录，所以前面这段（goto + cover 注入 + screenshot）是"准备帧"
  // 需要在 mux 时裁掉。+0.15s 余量，防止 click 那一帧封面还没消失被录进正片
  skipS = Math.max(0, (Date.now() - recT0) / 1000 + 0.15);
  console.log(`✂  webm 前 ${skipS.toFixed(2)}s 准备帧将被裁掉`);
}

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
//   - 输入 0: anullsrc 生成头部静音
//   - 输入 1..N: 每节 mp3（含 cover.mp3，如果有）
//   - 每节 mp3 apad 1.2s
//   - 把 silence + 所有 padded mp3 concat 起来
// 模式 A（有 cover.mp3）：头部静音 = PRE_ROLL_S，cover 节本身是封面段
// 模式 B（无 cover.mp3）：头部静音 = COVER_S + PRE_ROLL_S，对齐静态封面 + autoplay
const HEAD_SILENCE_S = hasCoverMp3 ? PRE_ROLL_S : (COVER_S + PRE_ROLL_S);
const sceneInputs = audioFiles.map(f => `-i "${path.join(audioDir, f)}"`).join(' ');
const padFilters = audioFiles.map((_, i) =>
  `[${i + 1}:a]apad=pad_dur=${BUFFER_S}[a${i}]`
).join(';');
const concatLabels = audioFiles.map((_, i) => `[a${i}]`).join('');
const filter = [
  `[0:a]atrim=0:${HEAD_SILENCE_S}[silence]`,
  padFilters,
  `[silence]${concatLabels}concat=n=${audioFiles.length + 1}:v=0:a=1[out]`,
].join(';');

const audioMixed = path.join(tmpDir, 'mixed.m4a');
execSync([
  'ffmpeg -y -hide_banner -loglevel error',
  `-f lavfi -i anullsrc=cl=mono:r=24000:d=${HEAD_SILENCE_S + 1}`,
  sceneInputs,
  `-filter_complex "${filter}"`,
  `-map "[out]" -c:a aac -b:a 128k "${audioMixed}"`,
].join(' '), { stdio: 'inherit' });
console.log(`✓ 音轨拼好: ${(statSync(audioMixed).size / 1024).toFixed(0)} KB`);

// ───────────── 3. mux 视频 + 音轨 ─────────────
const outputPath = path.join(targetDir, 'video.mp4');
if (hasCoverMp3) {
  console.log(`\n🎬 输出 MP4 (cover 节 + 正片，无静态封面)...`);
  // 模式 A：直接用 webm 整段（cover 节就在里面），无需 concat 静态封面
  execSync([
    'ffmpeg -y -hide_banner -loglevel error',
    `-i "${webmPath}"`,                          // 输入 0: 录制 webm
    `-i "${audioMixed}"`,                        // 输入 1: 音轨
    `-filter_complex "[0:v]scale=${width}:${height},setsar=1,fps=${fps},format=yuv420p[v]"`,
    '-map "[v]" -map 1:a',
    '-c:v libx264 -preset medium -crf 22',
    '-c:a aac -b:a 128k',
    '-pix_fmt yuv420p',
    '-movflags +faststart',
    '-shortest',
    `"${outputPath}"`,
  ].join(' '), { stdio: 'inherit' });
} else {
  console.log(`\n🎬 输出 MP4 (静态封面 ${COVER_S}s + 正片)...`);
  // 模式 B：concat 静态封面图（loop 成 COVER_S 秒）+ 裁掉准备帧的 webm
  const vFilter = [
    `[0:v]scale=${width}:${height},setsar=1,fps=${fps},format=yuv420p[v0]`,
    `[1:v]trim=start=${skipS.toFixed(3)},setpts=PTS-STARTPTS,scale=${width}:${height},setsar=1,fps=${fps},format=yuv420p[v1]`,
    `[v0][v1]concat=n=2:v=1:a=0[v]`,
  ].join(';');
  execSync([
    'ffmpeg -y -hide_banner -loglevel error',
    `-loop 1 -t ${COVER_S} -i "${coverPath}"`,    // 输入 0: 封面静帧
    `-i "${webmPath}"`,                            // 输入 1: 录制 webm
    `-i "${audioMixed}"`,                          // 输入 2: 音轨
    `-filter_complex "${vFilter}"`,
    '-map "[v]" -map 2:a',
    '-c:v libx264 -preset medium -crf 22',
    '-c:a aac -b:a 128k',
    '-pix_fmt yuv420p',
    '-movflags +faststart',
    '-shortest',
    `"${outputPath}"`,
  ].join(' '), { stdio: 'inherit' });
}

// 把封面单独留一份在 demo 目录（社交平台手动指定封面时直接用）
const coverOutPath = path.join(targetDir, 'cover.png');
await copyFile(coverPath, coverOutPath);

// ───────────── 4. 清理 ─────────────
await rm(tmpDir, { recursive: true, force: true });

const outSize = (statSync(outputPath).size / 1024 / 1024).toFixed(1);
const outDur = getDuration(outputPath);
console.log(`\n✅ 完成`);
console.log(`   ${outputPath}`);
console.log(`   ${outSize} MB · ${outDur.toFixed(1)}s · ${width}x${height} @ ${fps}fps`);
console.log(`   封面: ${coverOutPath}`);
