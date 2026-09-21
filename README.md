# zbgamelt.github.io — Discussions 转静态论坛

帖子住在 **GitHub Discussions** 里，这里只放一个把它们渲染成静态页面的生成器，
产出直接落在仓库根目录，由 GitHub Pages 从 `main` 分支根目录发布。

- 站点：<https://zbgamelt.github.io>
- 讨论区：<https://github.com/zbgamelt/zbgamelt.github.io/discussions>

## 目录结构

```
scripts/build.mjs          # 生成器（零依赖，只用了 Node 内置能力）
assets/style.css           # 站点样式（深色）
data/site.json             # 站点名 / 标语 / 简介
data/discussions.json      # 最近一次抓取的内容缓存（由 workflow 生成）
data/sample-discussions.json  # 本地预览用样例，线上不会用到
.github/workflows/build.yml   # 有新帖/有回复时自动重建并提交
index.html  t/<编号>/  404.html   # ← 生成物，不要手改
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

## 注意

- Discussions 的正文由 GitHub 渲染成 HTML（`bodyHTML`），生成时会再过滤一遍
  `<script>`、`on*=` 之类的内容，但**发帖权限请只开给信任的人**，这是静态站的常规要求。
- 不要手动编辑 `index.html` / `t/` / `404.html`，下次构建会覆盖。
