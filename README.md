# animation-explainer

> 把看不见的技术过程，做成能看见的剧场式动画 HTML。

这是一个跨 agent 的 **skill**：输入一个技术主题（"打开浏览器到屏幕上像素的全过程"、"一个 SQL 查询是怎么执行的"、"TLS 1.3 握手"…），它会产出一份**单文件 HTML 动画演示** —— 多场景、自动播放、章节导航、配真实代码/抓包/日志旁白、云希男声口播，可一键导出 MP4 视频。

## 一键安装（推荐）

```bash
npx skills add AgentBuff/animation-explainer
```

适配 **Claude Code / Cursor / Codex / Cline / Gemini CLI / Windsurf / Antigravity / OpenClaw** 等 50+ agent，一次安装全部生效（背后是 [skills.sh](https://skills.sh) 跨 agent 协议）。

装完后跟你的 agent 说：

> 用 animation-explainer 给我做一个 **[主题]** 的动画演示

例如："用 animation-explainer 做一个 git rebase 的动画演示"、"用 animation-explainer 把 V8 JS 编译过程讲清楚"。

> 如果要导出 MP4 视频，还需要本地装 `ffmpeg` 和 `npx playwright install chromium`，详见下方"导出 MP4"那节。

## 现在能干什么

```
animation-explainer/
├─ SKILL.md                         # 技能定义 + 工作流 + 反 AI slop 清单
├─ package.json                     # msedge-tts + playwright 依赖
├─ scripts/
│  ├─ generate-audio.mjs            # TTS 生成 mp3（edge-tts 云希男声）
│  └─ export-video.mjs              # 导出 MP4（Playwright + ffmpeg）
├─ templates/
│  └─ theater-shell.html            # 最小骨架（含 TTS 模块 + 推进逻辑）
└─ examples/
   ├─ browser-request/
   │  ├─ index.html                 # 浏览器请求底层之旅（8 节，网络协议）
   │  └─ audio/scene-1~8.mp3        # 口播音频
   └─ vue-internals/
      ├─ index.html                 # Vue 3 原理之旅（8 节，前端框架）
      └─ audio/scene-1~8.mp3        # 口播音频
```

## 看效果

直接双击打开（无构建步骤）：

```bash
open examples/browser-request/index.html
```

浏览器里会看到一个 8 节的剧场演示，**带云希男声口播**：

1. **你按下了回车键** — URL 解析
2. **DNS：名字翻译** — 递归查询的动画
3. **TCP 三次握手** — SYN/SYN+ACK/ACK 时序
4. **TLS 握手** — ClientHello → Cert → Key Exchange
5. **HTTP 请求** — 真实报文格式飞向服务器
6. **服务器内部处理** — Nginx → Router → Handler → DB 流水线 + 实时日志
7. **HTTP 响应** — 200 OK + Headers + body 飞回
8. **浏览器渲染** — HTML/CSS → DOM/CSSOM → Render Tree → Layout/Paint

操作：键盘 `← →` 翻页 · `Space` 播放/暂停 · `R` 重播本节 · `M` 静音切换 · 顶部小方块直接跳转。

切换章节按口播结束驱动（不是固定 setTimeout），所以语音和动画始终同步。

## 导出为 MP4 视频（人工审核通过后）

在浏览器里看过觉得 OK，再导出可分发的视频：

```bash
# 第一次跑前
npm install
npx playwright install chromium

# 导出
npm run video:browser     # → examples/browser-request/video.mp4
npm run video:vue         # → examples/vue-internals/video.mp4

# 自定义参数
node scripts/export-video.mjs examples/vue-internals --width=1920 --height=1080 --fps=60
```

输出约 5MB / 2 分钟，1280×800 30fps，H.264 + AAC。可直接发微信/抖音/B站。

工作原理：Playwright headless 录 WebM（无音轨）+ ffmpeg 拼 mp3 + mux → MP4。详情见 [`SKILL.md`](SKILL.md) 的"视频导出"那节。

## 怎么用这个 skill 做新主题

跟 Claude 说：

> "用 animation-explainer skill 给我做一个 [主题] 的动画演示"

例如：

- "用 animation-explainer skill 做一个 git rebase 内部发生了什么的动画演示"
- "用 animation-explainer skill 把 JS 事件循环讲清楚"
- "用 animation-explainer 解释 React fiber reconciler"

Claude 会按 SKILL.md 的 6 + 1 步工作流：

1. 把主题拆成 3–8 个场景
2. 选视觉模式（实物 mockup / 节点+飞包 / 时序图 / 流水线 / 树）
3. **复制 `examples/browser-request/index.html`** 改 —— 不会从零写
4. 用真实命令输出/报文/日志填旁白（反 AI slop）
5. 写 3–5 句口语化中文 narration 字段
6. 自检（反 AI Slop 清单）
7. 跑 `node scripts/generate-audio.mjs examples/<topic>` 生成口播 mp3
8. （可选）人工审核通过后 `node scripts/export-video.mjs examples/<topic>` 导出 MP4

## 设计原则（节选）

完整在 `SKILL.md`。最重要的几条：

- **真实数据胜过完美设计**：旁白里的命令必须能跑、报文必须符合协议、时间数字必须在合理范围
- **隐喻要排他**：一节一个能动的视觉隐喻；"DNS 是电话簿" ✅，"DNS 是分布式服务" ❌
- **3–8 个场景**：少于 3 不必动画化；多于 8 注意力分散
- **5 种已有视觉模式优先**：先问能不能用现有模式讲清楚，再考虑发明新的
- **单文件零依赖**：所有 CSS/JS/SVG 内联，复制到任何机器都能跑

## 不适合的场景

- 静态信息图、纯文字说明（用 Markdown 就行）
- 交互式教程（要让用户输入并响应，本 skill 是"播放型"不是"操作型"）
- 长篇课程（> 8 节就该拆成多个 demo）
- GIF 导出（只支持 MP4；如要 GIF 用 `ffmpeg -i video.mp4 -vf "fps=10,scale=720:-1" out.gif` 二次转）

## 演进路线

每完成一个新 demo：

1. 把它的章节拆解模式补进 `SKILL.md` 的"常见任务参考"表
2. 如果发现了一种**复用了 2 次以上**的新视觉模式，沉淀到 `templates/`
3. demo 之间**不共享代码**（保持单文件分发），但**共享设计 token 和模式**
