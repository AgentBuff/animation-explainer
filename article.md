# 我做了一个"动画 + 口播"的知识演绎技能，扔个主题就能出片

> **一句话钩子**：花了两个晚上，我让 Claude 给我做出了 8 节带云希男声讲解、按口播节奏自动切换的技术动画，最后一行命令导出成 5MB 的 MP4。这条路打通后，下一个主题——不管是 Vue 原理、Kafka 消息流转还是 Postgres 的 MVCC——只要一句话，几分钟出一个完整的科普视频。

---

## 一、先看效果

我给了 Claude 两个主题，分别得到了两份完整的动画演示。

**主题 1：浏览器请求底层之旅**

你在浏览器输入 `https://example.com` 按下回车，背后到底发生了什么？

8 节，从 URL 解析、DNS 递归查询，到 TCP 三次握手、TLS 握手、HTTP 请求报文飞向服务器，再到 Nginx → Router → Handler → DB 的处理流水线，最后是浏览器把字节变成像素的整个渲染流程。

**主题 2：Vue 3 原理之旅**

同样 8 节，从一个 `.vue` 文件出发，到编译器把 template 转成 render 函数（含静态提升和 patchFlag），再到响应式系统三件套（reactive 的 Proxy 包装 / track 依赖收集 / trigger 触发更新），最后到 VNode → Diff → Patch 真实 DOM。

每节都有：

- **真实在动的 SVG 动画**：不是静态截图，是数据包飞过去、握手箭头依次出现、流水线节点逐段亮起、DOM 树一层层展开
- **真实的代码和日志**：`dig` 输出、`tcpdump` 抓包、HTTP/1.1 报文、Rails server log、Vue 源码里真实的 Proxy handler 实现——不是 AI 瞎编的
- **云希男声的中文口播**：每节 10–20 秒，专业术语保留英文（"Proxy 拦截器"而不是"代理拦截器"），不会读成"乃是一个 Proxy 实例"那种书面腔
- **按口播节奏自动切换**：当前章节的口播说完，停 1.2 秒，再切下一节——而不是固定 setTimeout 把口播打断

最终 `npm run video:vue`，输出 `video.mp4`，5MB，2 分 17 秒，1280×800 30fps。可以直接发微信、抖音、B 站、知乎。

---

## 二、起点：本来只想做一个 demo

最初我只是想给朋友讲清楚一件事：浏览器请求的底层。

试过几次发现，文字讲太抽象，画图讲太静态。最好是个"会动的"——数据包从客户端飞到 DNS 服务器，再飞到根服务器，逐级返回。但这种动画一般要找 motion designer 做，一天上千，不是日常能用的工具。

我想试试让 AI 直接出 HTML 动画。问 Claude："给我做一份'用户输入 URL 后底层发生什么'的演示，要能播放的 HTML 动画，分章节，配真实的代码和日志。"

得到的第一版就让我惊讶——不是 PPT 截图，是真的能播的剧场式演示。

那一刻我意识到：**这个结构本身是可复用的**。多场景、自动播放、章节导航、配真实代码的旁白——任何"看不见但需要看见"的技术主题都可以套这个模子。

于是停下来，把模式抽成一个 Claude Code skill，再用 skill 做第二个、第三个。

---

## 三、关键迭代（也是踩过的坑）

整个过程没有从头规划好，是边做边发现的几个关键节点。

### 1. 沉淀成 skill

第一个 demo 跑通后，我把骨架、设计 token、5 种视觉模式（实物 mockup / 节点+飞包 / 时序图 / 流水线 / 结构树）和"反 AI slop"清单都写进 `SKILL.md`。

效果立竿见影：第二个主题 Vue 原理，从拆解到出片，比第一次快了 5 倍以上。Claude 不会每次重新发明轮子，它就照着 5 种已有模式选一个。

### 2. 加口播：先尝试浏览器原生 TTS

光看动画太冷场。最先想到浏览器自带的 `speechSynthesis` API——零依赖，一行 JS 就能说话。

跑起来，发现声音僵硬得像导航："您已驶入主路。"那种感觉。Mac 系统里的 Ting-Ting 中文 voice 实在撑不起教学场景。

### 3. 切换到 edge-tts：免费的 Neural voice

换方案：用 `msedge-tts` 这个 npm 包，调用微软 Edge 浏览器后端的 TTS 服务。免费、不要 API key，中文有"晓晓"、"云希"、"云扬"等 Neural voice，质量接近商业级。

写一个脚本：从 HTML 里用正则抠出 `CHAPTERS` 数组的 `narration` 字段，逐节生成 `audio/scene-N.mp3`。

HTML 端做双轨设计：探测 `audio/scene-1.mp3` 能不能加载，能就用 mp3，不能就回退到 Web Speech API。这样：

- 项目克隆下来就能用（哪怕没装 Node 依赖，HTML 也能放话）
- 改完 narration 文案，重跑生成脚本即可
- 文件 file:// 双击打开也能工作

### 4. 同步问题：必须按口播驱动切换

第一版用固定 `setTimeout(CHAPTERS[i].duration)` 切下一节。结果发现：口播长度不固定，常常话还没说完就跳到下一节，触发新的口播打断旧的。

改成事件驱动：

```js
speak(text, idx, () => {
  // 口播自然结束 → 1.2s 缓冲 → 切下一节
  if (state.playing) scheduleAdvance(1200);
});
```

`speak()` 接受 `onEnd` 回调，挂在 `audio.onended` 上。口播说完才推进，加 1.2 秒缓冲让观众回看一眼代码。再加一个 60 秒兜底定时器防止 onEnd 因为某些原因没触发。

这次改完整个节奏就对了。

### 5. 一个弱智 bug：代码挤成一行

写完口播改完同步，发现右侧旁白里的代码块全挤在一行：`<template> <div class="counter"> <h1>Count...`

原因找了 30 秒就发现了——`.codeblk` 的 CSS 缺了 `white-space: pre`。HTML 默认把所有空白（含换行）折叠成单个空格。

修复一行，加 `white-space: pre; tab-size: 2;`。然后把这条加进 `SKILL.md` 的强制规则——避免下次新 demo 再踩。

技能能"自我完善"的关键：**每踩一个坑就把它固化成规则**。skill 文件从 235 行写到 425 行，主要就是这种"为防止下次再错"的内容。

### 6. 最后一步：导出 MP4

光在浏览器里看不够，得能发出去。

最初想用 ffmpeg + MediaRecorder API 在浏览器里录屏，复杂、需要用户交互。

换方案：

- **Playwright headless Chromium**：加载 HTML，自动播放
- **recordVideo 录 WebM**：但这有个硬限制——**Playwright 不录音轨**
- **ffmpeg 单独拼音轨**：把 8 个 mp3 文件中间补 1.2 秒静音（对齐 HTML 的 `ADVANCE_BUFFER_MS`），开头加 1 秒 pre-roll（对齐浏览器 autoplay 启动延迟）
- **ffmpeg mux**：WebM（视频）+ 拼好的音轨 → MP4，H.264 + AAC，pix_fmt yuv420p（QuickTime/微信/抖音兼容），faststart（网页流播友好）

`npm run video:vue`，3 分钟跑完，5MB 的 MP4 出现在目录里。

---

## 四、最终的实现架构

```
输入: "用 animation-explainer skill 给我做一个 X 的动画演示"
   ↓
1. Claude 按 SKILL.md 拆 3–8 节，每节配视觉模式
   ↓
2. 复制 examples/browser-request/index.html 改 SVG / 旁白 / CHAPTERS
   ↓ 单文件 HTML（含 SVG 动画 + 旁白文本 + narration 字段）
3. node scripts/generate-audio.mjs examples/<topic>
   ↓ + audio/scene-1~N.mp3 (edge-tts 云希男声)
4. 浏览器打开预览
   - 按口播 onended 驱动切换
   - 控件：上/下/播放/暂停/重播/🔊 静音 + 键盘 ←→/Space/R/M
   ↓ ✅ 人工审核通过
5. node scripts/export-video.mjs examples/<topic>
   - Playwright headless 录 WebM
   - ffmpeg 拼 mp3 + apad(1.2s) + 1s pre-roll
   - mux WebM + 音轨 → MP4
   ↓
输出: video.mp4 (~5MB / 2 分钟)，可发任意平台
```

关键的技术取舍：

- **单文件 HTML + 零构建步骤**：复制到任何机器都能跑，没有 webpack/vite 的负担
- **纯 SVG 动画**：不依赖任何动画库（不用 GSAP/Lottie/Three.js），原生 setAttribute + requestAnimationFrame 完全够
- **TTS 双轨**：mp3 优先质量好、Web Speech 兜底保证最低可用
- **画面切换按口播驱动**：而不是固定 setTimeout，避免口播被打断
- **视频导出走 Playwright + ffmpeg**：成熟工具组合，比 puppeteer-stream 那种 hack 稳定

---

## 五、如何使用

整套技能已经开源（链接在文末）。

**一次性安装：**

```bash
git clone <repo>
cd animation-video-learning-skills
npm install
npx playwright install chromium    # 第一次跑视频导出前需要
```

**看现有 demo：**

```bash
open examples/browser-request/index.html    # 浏览器请求底层
open examples/vue-internals/index.html      # Vue 3 原理
```

**导出视频：**

```bash
npm run video:vue
npm run video:browser
```

**做新主题（如果你在用 Claude Code）：**

跟 Claude 说：

> 用 animation-explainer skill 给我做一个 [主题] 的动画演示

例如：

- "用 animation-explainer skill 做一个 git rebase 内部发生了什么的动画演示"
- "用 animation-explainer 把 V8 怎么编译 JavaScript 讲清楚"
- "用 animation-explainer 解释 Postgres 的 MVCC 怎么工作"

它会：拆场景 → 复制模板改 → 用真实代码填旁白 → 写口播稿 → 跑生成脚本 → 输出到 `examples/<topic>/`。完整工作流在 `SKILL.md` 里有详细描述。

---

## 六、适合做什么 / 不适合做什么

**适合**：

- 网络协议、底层原理、加密算法、编译器、虚拟机、数据库内部、操作系统——所有"看不见但需要看见"的技术主题
- 公司内部技术分享、培训课程片段、工具讲解
- 自己想搞清楚一个概念，反向用动画"逼自己讲明白"

**不适合**：

- 静态信息图（Markdown 写就够）
- 交互式教程（这是"播放型"，不是"操作型"）
- 大于 8 节的长课程（拆成多个 demo 更好）
- 需要真人出镜的内容（这套是纯动画+合成语音）

---

## 七、为什么我相信这事有价值

教技术最好的方式不是写博客，也不是录屏。是动画 + 解说，跟博物馆里的科普影片一样——一边看东西在动，一边听人在讲。

但这种内容贵：好的 motion designer 一天上千，专业配音另算。所以高质量技术科普极少。绝大多数程序员习惯了一行行读文档、一段段读源码，从来没在博物馆里看过"程序员视角的科普纪录片"。

现在 AI 把这件事的成本降到了"几句话 + 几分钟"。一个能讲清楚 Vue 响应式的视频，过去要一个团队几周，现在一个人一个晚上。

这条路才刚刚开始。可以预见的延展：

- 双语字幕（用 ffmpeg 的 subtitle filter）
- 多种视觉风格（暗色/亮色主题切换）
- 更长的复合主题（多个 demo 串成一个系列）
- 直接发布到 B 站/抖音的自动化

如果你也想用这套技能，或者有想做但一直没空做的技术主题，扔在留言区，我帮你跑一个。

---

**项目地址**：[GitHub 仓库链接放这里]

**关注我**：[公众号信息]，下一篇打算用这套工具做一份《Postgres 一条 SQL 是怎么执行的》动画视频。

---

> 写在最后：这篇文章本身的整个开发过程也是用 Claude Code 完成的。从最初一句"我想做一个动画视频学习技能"，到最终拿到完整的 MP4 视频，全程用对话推进。技术不再是壁垒，**对要做什么有清晰的判断**才是壁垒。
