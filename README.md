# zbgamelt.github.io — 博客 + App 下载页

GitHub Pages 从 `main` 分支根目录发布。

> **2026-09-22：论坛已整体下线。**
> 原先的「GitHub Discussions 转静态论坛」（根目录的 `t/ post/ search/ me/ login/ register/ admin/`、
> 生成器 `scripts/build.mjs`、后端 Cloudflare Worker `zbgamelt-forum-api` 及其 KV）
> 全部删掉了，根地址现在直接跳转到博客。
> 删除前的完整快照在 `~/.openclaw/workspace/backups/forum-removed-20260922/`。

## 目录结构

```
hugo-src/                  # 博客源（Hugo + PaperMod）
zbgamelttwo/               # 博客产物（由 .github/workflows/hugo-subsite.yml 生成，别手改）
app/index.html             # Android App 下载页（静态，手工维护）
app-android/               # App 源码（纯 Java，手工打包，不用 Gradle）
download/                  # APK 安装包（构建不碰它）
data/app.json              # 下载页显示的版本 / 体积 / sha256
assets/style.css           # 共用样式（下载页、404 用）
assets/icons/              # PWA / 桌面图标（生成物，别手改）
scripts/make-icons.py      # 生成上面的图标（需要 Pillow）：npm run icons
favicon.ico 等             # 站点图标；博客 hugo.toml 的 params.assets 也指着它们
sw.js  manifest.webmanifest  offline.html      # PWA 三件套
index.html                 # 根地址 → 跳转到 /zbgamelttwo/
404.html                   # 兜底页
.github/workflows/hugo-subsite.yml             # 仓库里唯一的构建流水线
```

## 改博客

1. 改 `hugo-src/` 里的东西：配置在 `hugo-src/hugo.toml`，正文在 `hugo-src/content/`。
2. push 到 `main` —— `hugo-subsite.yml` 会自动构建，并把产物提交到 `zbgamelttwo/`。

⚠️ `hugo.toml` 里 `[params.assets]` 这张子表必须放在 `[params]` 所有普通键**之后**：
TOML 里子表一开张，后面所有裸键都会挂到它名下 —— 曾经因此把 `comments = true`
吞成 `params.assets.comments`，评论区整块消失，而且页面不报任何错。
以后加配置加在上面那堆里，别往中间插表。

## 发布 App

1. 把新 APK 放进 `download/`，同步更新 `data/app.json`（版本 / 体积 / sha256）。
2. 手工改 `app/index.html`：版本号、体积、sha256 三处都要跟着改
   （论坛下线后这页不再由脚本生成，改的就是文件本身）。
