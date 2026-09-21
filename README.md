# zbgamelt.github.io — Discussions 转静态论坛

帖子住在 **GitHub Discussions** 里，这里只放一个把它们渲染成静态页面的生成器，
产出直接落在仓库根目录，由 GitHub Pages 从 `main` 分支根目录发布。

- 站点：<https://zbgamelt.github.io>
- 讨论区：<https://github.com/zbgamelt/zbgamelt.github.io/discussions>

## 目录结构

```
scripts/build.mjs          # 生成器（零依赖，只用了 Node 内置能力）
scripts/make-icons.py      # 生成手机桌面图标（Pillow），改完重跑一次
assets/style.css           # 站点样式（深色）
assets/zsocial.js          # 站内账号 + 评论的前端客户端（论坛/博客共用）
assets/icons/              # PWA 图标（生成物，别手改）
data/site.json             # 站点名 / 标语 / 简介 / PWA 名字
worker/forum-api.js        # Cloudflare Worker：登录注册、评论、管理（部署见 worker/）
hugo-src/                  # 博客子站（Hugo + PaperMod），产物在 zbgamelttwo/
data/discussions.json      # 最近一次抓取的内容缓存（由 workflow 生成）
data/sample-discussions.json  # 本地预览用样例，线上不会用到
.github/workflows/build.yml   # 有新帖/有回复时自动重建并提交
index.html  t/<编号>/  404.html   # ← 生成物，不要手改
sw.js  manifest.webmanifest  offline.html   # PWA（manifest 是生成物，另两个是手写的）
```

## 本地看效果

```bash
node scripts/build.mjs --sample   # 用样例数据渲染，随便看
node scripts/build.mjs            # 有 GITHUB_TOKEN 时拉真实 Discussions
```

然后用任意静态服务器打开根目录即可：

```bash
python3 -m http.server 8080
```

## 同步是怎么发生的

| 触发 | 说明 |
|---|---|
| `discussion` / `discussion_comment` | 有人发帖或回复，立刻重建 |
| `push` 到 `scripts/` `data/site.json` `assets/` | 改了生成器或样式，重建 |
| 每 2 小时定时 | 兜底（比如编辑/删除帖子时不一定会发事件） |
| 手动 | Actions 页面点 Run workflow |

构建用 `GITHUB_TOKEN`（workflow 里声明了 `discussions: read`）读 Discussions，
再把生成的 HTML 提交回 `main`。因为推送用的是 `GITHUB_TOKEN`，不会再次触发自己。

## 回复 / 评论

帖子和博客文章的回复区是**站内评论**（`assets/zsocial.js` + Worker 的 `/comments` `/comment`），
只要注册一个邮箱账号就能回，**不需要 GitHub 账号**。评论存在 Worker 的 KV 里，键是页面路径
（帖子 `t/<编号>`，博客 `zbgamelttwo/posts/<slug>`）。登录态存在 `localStorage('zbforum_sess')`，
论坛和博客同源共用一份。

早先用的是 giscus（第三方 iframe，必须登录 GitHub），已经撤掉。那段时间留下的 GitHub 回复
不丢，作为构建期快照折在帖子页的「旧的 GitHub 回复」`<details>` 里备查 —— 它**不再更新**，
不要再把 `data/site.json` 的 `giscus` 当成生效配置（现在没有任何代码读它，属于遗留字段）。

## 手机端（PWA）

站点能当 App 装到手机桌面：`display: standalone`，点开没有浏览器地址栏。

- `manifest.webmanifest` —— 由 `data/site.json` 的 `pwa` 块生成（改名字改那份 JSON 就行，
  **不要手改 manifest**，下次构建会覆盖）。作用域是整个源，论坛和博客共用一个 App。
- `sw.js` —— Service Worker。只干两件事：满足「可安装」要求 + 断网时给兜底页。
  策略刻意保守：导航 network-first（宁可慢也别给旧页面），同源静态资源
  stale-while-revalidate，**跨域的接口一律不碰**。改策略记得改里面的 `CACHE` 版本号。
- `offline.html` —— 断网兜底页，样式全内联，不依赖 style.css 有没有被缓存住。
- `assets/icons/` —— 图标（192 / 512 / maskable / apple-touch）。
  改图标就改 `scripts/make-icons.py` 然后 `python3 scripts/make-icons.py`；
  它同时会写**源根**的 `favicon.ico` / `favicon-16x16.png` / `favicon-32x32.png`。
  图形跟 favicon（build.mjs 里的 `FAVICON`）是同一个标记，改一个记得改另一个。

安装入口在「我的」页（`/me/`）。Android/Chrome 走 `beforeinstallprompt` 一键装，
iOS 没有这套 API，只能提示「分享 → 添加到主屏幕」。

⚠️ 子站（`hugo-src/layouts/_partials/extend_head.html`）里引 manifest 必须写
**源根的绝对路径** `/manifest.webmanifest`，不能用 `relURL` —— 子站发布在 `/zbgamelttwo/` 下，
`relURL` 会拼成 `/zbgamelttwo/manifest.webmanifest`，那是 404。
同理，`hugo-src/hugo.toml` 的 `[params.assets]` 里，源根的图标也一律写前导斜杠。

⚠️ **别让同一个标签出现两份。** PaperMod 自己会输出 `theme-color`、`apple-touch-icon`、
`favicon` 这几个标签，所以它们统一由 `[params.assets]` 指过去，**不要在 `extend_head.html`
里再写一遍** —— 两边各写一份的后果是页面里两个 `theme-color`，装到桌面后状态栏是 PaperMod
默认的灰色，而不是站点的近黑。

## 注意

- Discussions 的正文由 GitHub 渲染成 HTML（`bodyHTML`），生成时会再过滤一遍
  `<script>`、`on*=` 之类的内容，但**发帖权限请只开给信任的人**，这是静态站的常规要求。
- 不要手动编辑 `index.html` / `t/` / `404.html` / `manifest.webmanifest`，下次构建会覆盖。
