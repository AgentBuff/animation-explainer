#!/usr/bin/env node
/**
 * generate-audio.mjs · 用 edge-tts 给 demo 的每个 scene 生成 mp3 旁白
 *
 * 用法:
 *   node scripts/generate-audio.mjs <demo-dir> [--voice=zh-CN-YunxiNeural] [--rate=+5%]
 *
 * 示例:
 *   node scripts/generate-audio.mjs examples/vue-internals
 *   node scripts/generate-audio.mjs examples/vue-internals --voice=zh-CN-XiaoxiaoNeural --rate=+0%
 *
 * 中文 Neural voice 推荐:
 *   zh-CN-YunxiNeural      云希 · 男 · 年轻清爽（默认，适合技术解说）
 *   zh-CN-YunyangNeural    云扬 · 男 · 新闻播报，沉稳权威
 *   zh-CN-YunjianNeural    云健 · 男 · 浑厚，适合教学
 *   zh-CN-XiaoxiaoNeural   晓晓 · 女 · 温柔标准
 *   zh-CN-XiaoyiNeural     晓伊 · 女 · 活泼年轻
 *   zh-CN-XiaochenNeural   晓辰 · 女 · 自然口语
 *
 * 输出: <demo-dir>/audio/scene-N.mp3
 */

import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { readFile, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const targetDir = args.find(a => !a.startsWith('--'));
const voiceArg = args.find(a => a.startsWith('--voice='));
const voice = voiceArg ? voiceArg.split('=')[1] : 'zh-CN-YunxiNeural';
const rateArg = args.find(a => a.startsWith('--rate='));
const rate = rateArg ? rateArg.split('=')[1] : '+5%';

if (!targetDir) {
  console.error('用法: node scripts/generate-audio.mjs <demo-dir> [--voice=zh-CN-YunxiNeural] [--rate=+5%]');
  process.exit(1);
}

const htmlPath = path.join(targetDir, 'index.html');
let html;
try {
  html = await readFile(htmlPath, 'utf8');
} catch (e) {
  console.error(`❌ 读取失败: ${htmlPath}`);
  console.error(e.message);
  process.exit(1);
}

// 从 HTML 里抠出 CHAPTERS 数组中所有 narration: "..." 字符串
const narrations = [];
const re = /narration\s*:\s*"((?:[^"\\]|\\.)*)"/g;
let m;
while ((m = re.exec(html))) {
  const text = m[1]
    .replace(/\\"/g, '"')
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  narrations.push(text);
}

if (!narrations.length) {
  console.error(`❌ 在 ${htmlPath} 里没找到 CHAPTERS 的 narration 字段`);
  process.exit(1);
}

console.log(`📖 ${targetDir}`);
console.log(`🎙️  voice: ${voice}    rate: ${rate}`);
console.log(`📝 ${narrations.length} 节口播稿\n`);

const audioDir = path.join(targetDir, 'audio');
await mkdir(audioDir, { recursive: true });

const tts = new MsEdgeTTS();
await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

for (let i = 0; i < narrations.length; i++) {
  const outPath = path.join(audioDir, `scene-${i + 1}.mp3`);
  const text = narrations[i];
  const preview = text.slice(0, 28) + (text.length > 28 ? '…' : '');
  process.stdout.write(`  [${i + 1}/${narrations.length}] ${preview}  `);
  try {
    const { audioStream } = tts.toStream(text, { rate });
    await pipeline(audioStream, createWriteStream(outPath));
    console.log(`✓ scene-${i + 1}.mp3`);
  } catch (e) {
    console.log(`✗ ${e.message || e}`);
  }
}

tts.close();
console.log(`\n✅ 完成 · 输出到 ${audioDir}/`);
console.log(`   重新打开 demo，HTML 会自动检测并使用 mp3 旁白`);
