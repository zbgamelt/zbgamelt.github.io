# hugo-src → /zbgamelttwo/ 子站

这个目录是**子站的 Hugo 源**：构建产物输出到仓库根目录的 `zbgamelttwo/`，
线上地址 https://zbgamelt.github.io/zbgamelttwo/ （跟论坛同一个 Pages 站点，只是不同子路径）。

## 本地构建

```bash
cd hugo-src
hugo --gc --minify --destination ../zbgamelttwo
```

## 注意

- `hugo.toml` 的 `baseURL` **必须**是 `https://zbgamelt.github.io/zbgamelttwo/`（带子路径）。
  模板里不要用 `{{ "/xxx" | relURL }}` —— 前导斜杠会丢掉子路径前缀导致 404，
  用 `.RelPermalink` 或 `{{ "xxx" | relURL }}`（不带前导斜杠）。
- `zbgamelttwo/` 是**生成物**，由 `.github/workflows/hugo-subsite.yml` 自动重建并提交，手改会被覆盖。
- 改内容只动 `content/`、`layouts/`、`assets/`、`hugo.toml`。
- ⚠️ **文章 `date` 不要写到未来**：Hugo 默认跳过未来日期的文章，而且**不报错**——表现是
  构建成功但那一页压根不存在（`Pages` 计数也不变）。写当天日期时留点余量，或改用已过去的时间。
- 论坛的 `scripts/build.mjs` 只清理 `t/`、`post/`、`search/`、`index.html`、`404.html`，不会碰这个目录。
