# hugo-src → /zbgamelttwo/ 子站

子站的 **Hugo 源**：构建产物输出到仓库根目录的 `zbgamelttwo/`，
线上地址 https://zbgamelt.github.io/zbgamelttwo/ （同一个 Pages 站点的子路径；
2026-09-22 论坛下线后，仓库里只剩博客和 App 下载页）。

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

## CI：产物提交回 main，以及为什么保留 rebase 重试

本 workflow 跑完用仓库自带的 `GITHUB_TOKEN` 把 `chore(subsite): 重建 zbgamelttwo` 推回 main。
**按 GitHub 的递归防护，用 `GITHUB_TOKEN` 推出去的提交不会再触发任何 workflow** ——
它不会自己钩住自己；也正因为产物在仓库里（Pages 是分支部署，从 `main` 根目录发布），
这份提交必须由它自己推回去。

⚠️ 推送失败不能被吞掉：以前循环最后跑的是 `git pull`，push 被拒也以 0 退出、整条 workflow
报 success。现在三次 rebase 重试都失败会 `exit 1`（2026-09-20 的事故：主站产物停在旧提交，
`/me/`、`/me/posts/` 线上 404 近一小时）。

论坛下线（2026-09-22）之前，这段还需要额外用 `workflow_dispatch` 去叫醒论坛那条 `build.yml`
（两条 workflow 抢推 `main` 会互相拒）。现在 `hugo-subsite.yml` 是仓库里唯一的 workflow，
跨线唤醒那段已经删掉；rebase 重试只作防御保留。
