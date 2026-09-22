# hugo-src → /zbgamelttwo/ 子站

子站的 **Hugo 源**：构建产物输出到仓库根目录的 `zbgamelttwo/`，
线上地址 https://zbgamelt.github.io/zbgamelttwo/ （跟论坛同一个 Pages 站点，只是不同子路径）。

## 组成

| 路径 | 说明 |
| --- | --- |
| `hugo.toml` | 站点配置（PaperMod、菜单、baseURL） |
| `content/` | Markdown 内容 |
| `themes/PaperMod/` | 主题**整个塞进来**（不走 submodule / Hugo Modules，CI 免配置） |
| `assets/css/extended/custom.css` | PaperMod 覆盖层：近黑底 + 黄色强调 + 中文字体栈 |
| `i18n/zh-cn.yaml` | 主题只有 `zh.yaml`，本站语言是 `zh-cn`，不补就回落到英文 "Home" / "Table of Contents" |

## 本地构建与预览

```bash
hugo --gc --minify --destination ../zbgamelttwo    # 正式产物（CI 也这么跑）

hugo server --buildDrafts                          # 开发服务器，http://localhost:1313
```

⚠️ **直接 `hugo` 后拿 `public/` 用普通 http 服务器打开，样式会全丢**：
`baseURL` 带 `/zbgamelttwo/` 前缀，本地没这个路径，CSS 全部 404。
要看真实效果：

```bash
hugo --baseURL "http://127.0.0.1:8902/" -d /tmp/preview
```

## 注意事项

- `baseURL` **必须**是 `https://zbgamelt.github.io/zbgamelttwo/`（带子路径）。
  自写模板时不要用 `{{ "/xxx" | relURL }}` —— 前导斜杠会丢掉子路径前缀导致 404，
  用 `.RelPermalink` 或 `{{ "xxx" | relURL }}`（不带前导斜杠）。
- ⚠️ **文章 `date` 不要写到未来**：Hugo 默认跳过未来日期的文章，而且**不报错**——
  表现是构建成功但那一页压根不存在（`Pages` 计数也不变）。写当天日期要留余量。
- `zbgamelttwo/` 是**生成物**，由 `.github/workflows/hugo-subsite.yml` 自动重建并提交，手改会被覆盖。
- 论坛已于 2026-09-22 整体下线，这个目录现在是仓库里唯一需要构建的东西。

## CI：为什么这条线最后要去叫醒论坛的 workflow

本 workflow 跑完用仓库自带的 `GITHUB_TOKEN` 把 `chore(subsite): 重建 zbgamelttwo` 推回 main。
**按 GitHub 的递归防护，用 `GITHUB_TOKEN` 推出去的提交不会再触发任何 workflow** ——
所以这次推送如果同时带着论坛侧还没渲染的改动，`build.yml` 不会自己醒过来。

2026-09-20 就是这么翻车的：同一次 push 同时唤起了 `build.yml` 和本 workflow，
`build.yml` 的裸 `git push` 被本 workflow 抢推拒掉、整条失败；随后本 workflow 用 token
推出的提交又不触发任何 workflow，主站产物一直停在旧提交，`/me/`、`/me/posts/` 线上 404 近一小时。

两道保险（缺一不可）：

1. 本 workflow 的最后一步用 `workflow_dispatch` 显式触发 `build.yml`。
   例外规则：`workflow_dispatch` / `repository_dispatch` 即使由 `GITHUB_TOKEN` 发起也**一定**会创建 run，
   所以这一步不需要额外配 PAT（但 `permissions` 里必须有 `actions: write`）。
2. 两边推送都 rebase 重试，且三次都失败要 `exit 1` —— 不能让失败被最后一条 `git pull` 掩盖成 success。
