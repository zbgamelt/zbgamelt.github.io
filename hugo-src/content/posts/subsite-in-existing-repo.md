---
title: "把 Hugo 子站挂进已有的 Pages 仓库"
date: 2026-09-20T08:45:00Z
description: "不用新开仓库：博客源放 hugo-src/，产物输出到 zbgamelttwo/，和 App 下载页共用同一个 Pages 站点。"
tags: ["Hugo", "部署"]
---

想加这个站的时候，最直接的办法是新开一个仓库。但 Pages 的用户站点一个账号只有一个
（`zbgamelt.github.io` 已经被占用了），所以改成**在已有仓库里挖一个子目录**。

> 2026-09-22：原先占着根目录的论坛已经整体下线（`t/ post/ search/ me/ login/ register/ admin/`、
> 生成脚本 `scripts/build.mjs`、后端 Worker 一起删了），根地址现在直接跳转到博客。
> 仓库里只剩「博客 + App 下载页」——下面这些结构上的结论都还成立。

## 结构

```text
zbgamelt.github.io/
├── hugo-src/          # ← 博客源（手写，只动这里）
│   ├── hugo.toml
│   └── content/  layouts/  assets/
├── zbgamelttwo/       # ← 博客产物（由 CI 生成，别手改）
├── app/  download/    # App 下载页 + APK 安装包
├── index.html         # 根地址 → 跳转 /zbgamelttwo/
├── 404.html           # 兜底页
└── .github/workflows/hugo-subsite.yml   # 仓库里唯一的构建流水线
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

反过来，**源根的文件**（`manifest.webmanifest`、`sw.js`、`favicon` 这些）只能写**绝对路径**：
它们压根不在子站目录里，`relURL` 会把 `/zbgamelttwo/` 拼上去，一样 404。

## 只有一条流水线

`hugo-subsite.yml` 现在是仓库里唯一的构建流水线：push 到 `main` 且动了 `hugo-src/**` 就触发，
跑 `hugo --gc --minify --destination ../zbgamelttwo`，再把 `zbgamelttwo/` 提交回 `main`。

为什么产物要提交回仓库、而不是发 artifact：Pages 是**从 `main` 分支根目录发布**的（分支部署），
仓库里没有那份 HTML，Pages 就没东西可发。

⚠️ 用仓库自带的 `GITHUB_TOKEN` 推出去的提交**不会触发任何 workflow**（GitHub 的递归防护）。
所以这条线推完不会自己钩住自己，也别指望它能唤醒别的 workflow。
（论坛还在的时候确实要靠它 `workflow_dispatch` 去叫醒 `build.yml`，两条线抢推 `main`
会互相拒；现在那条线没了，跨线唤醒的代码也一起删了。）
推送仍然保留 rebase 重试，三次都失败必须 `exit 1`——不能让推送失败被误报成 success。
