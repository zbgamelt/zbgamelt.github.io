---
title: "本站是怎么部署的"
date: 2026-09-20T08:30:00Z
description: "Hugo + PaperMod，源在 hugo-src/，产物由 GitHub Actions 提交回 main，Pages 从仓库根目录发布。"
tags: ["部署", "CI"]
---

写给以后的自己看。

## 用了什么

| 东西 | 选择 |
| --- | --- |
| 生成器 | Hugo extended 0.166.0 |
| 主题 | [PaperMod](https://github.com/adityatelange/hugo-PaperMod)（**整个塞进 `themes/`**，不用 submodule / Hugo Modules） |
| 样式覆盖 | `assets/css/extended/custom.css`（近黑底 + 黄色强调） |
| 部署 | GitHub Actions 构建 → 提交回 `main` → Pages 直接发布 |

## 目录

```text
hugo-src/                  # 手写，只有这个目录要动
├── hugo.toml
├── content/  layouts/（无，用主题的）
├── assets/css/extended/custom.css
├── i18n/zh-cn.yaml        # 补主题缺的中文标签
└── themes/PaperMod/
zbgamelttwo/               # 生成物，别手改
```

## 为什么产物要提交进仓库

因为 Pages 是**从 `main` 分支根目录发布**的（分支部署，不是 artifact 部署）。
所以 `hugo-subsite.yml` 构建完会把 `zbgamelttwo/` 提交回去，Pages 再自己重建。

## 本地预览

```bash
cd hugo-src
hugo server --buildDrafts        # http://localhost:1313
```

⚠️ 本地直接 `hugo` 出来的页面样式会**全丢**，因为 `baseURL` 带着 `/zbgamelttwo/` 前缀，
本地服务器上这个路径不存在。要看真实效果得：

```bash
hugo --baseURL "http://127.0.0.1:8902/" -d /tmp/preview
```
