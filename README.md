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

## 想换成 giscus 内嵌评论

现在回复是「点按钮跳到 GitHub Discussions」。如果哪天想让回复直接嵌在页面里，
把 `data/site.json` 的 `giscus` 填上从 <https://giscus.app> 拿到的两个 ID 即可：

```json
"giscus": { "repoId": "R_xxx", "categoryId": "DIC_xxx" }
```

前提是给这个仓库装上 giscus GitHub App（在 giscus.app 页面点授权，需要仓库管理员操作）。

## 注意

- Discussions 的正文由 GitHub 渲染成 HTML（`bodyHTML`），生成时会再过滤一遍
  `<script>`、`on*=` 之类的内容，但**发帖权限请只开给信任的人**，这是静态站的常规要求。
- 不要手动编辑 `index.html` / `t/` / `404.html`，下次构建会覆盖。
