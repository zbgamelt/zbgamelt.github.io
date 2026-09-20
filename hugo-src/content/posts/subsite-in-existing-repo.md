---
title: "把 Hugo 子站挂进已有的 Pages 仓库"
date: 2026-09-20T08:45:00Z
description: "不用新开仓库：源放 hugo-src/，产物输出到 zbgamelttwo/，跟论坛共用同一个 Pages 站点。"
tags: ["Hugo", "部署"]
---

想加这个站的时候，最直接的办法是新开一个仓库。但 Pages 的用户站点一个账号只有一个
（`zbgamelt.github.io` 已经被论坛占了），所以改成**在已有仓库里挖一个子目录**。

## 结构

```text
zbgamelt.github.io/
├── scripts/build.mjs      # 论坛：把 Discussions 渲染成静态页
├── index.html  t/  post/  # 论坛产物（由 CI 生成）
├── hugo-src/              # ← 子站源（手写）
│   ├── hugo.toml
│   ├── content/  layouts/  assets/
└── zbgamelttwo/           # ← 子站产物（由 CI 生成）
```

线上地址：<https://zbgamelt.github.io/zbgamelttwo/>

## 两个容易踩的点

**1. `baseURL` 必须带子路径。**

```toml
baseURL = "https://zbgamelt.github.io/zbgamelttwo/"
```

**2. 模板里别用前导斜杠的 `relURL`。**

```go-html-template
{{ "/posts/" | relURL }}   <!-- ❌ 会输出 /posts/，丢掉 /zbgamelttwo/ 前缀 → 404 -->
{{ "posts/"  | relURL }}   <!-- ✅ /zbgamelttwo/posts/ -->
{{ (site.GetPage "posts").RelPermalink }}  <!-- ✅ 最稳 -->
```

这个坑很隐蔽：首页和导航看着都正常，点进去才 404。

## 两条流水线并存

论坛的 `build.yml` 只清理 `t/`、`post/`、`search/`、`index.html`、`404.html`，
不碰子站目录；子站的 `hugo-subsite.yml` 只提交 `zbgamelttwo/`。
两边都可能往 `main` 推，所以子站那条加了 rebase 重试，避免撞车。
