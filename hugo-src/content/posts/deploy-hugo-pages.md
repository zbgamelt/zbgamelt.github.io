---
title: "部署说明：Hugo + GitHub Pages"
date: 2026-09-20T08:30:00Z
description: "从推送代码到 Pages 上线，整条流水线长什么样，以及首次部署要注意的两个开关。"
tags: ["部署", "CI"]
---

这个站点是怎么上线的，写下来备查。

## 目录结构

```text
.
├── hugo.toml                 # 站点配置
├── content/                  # Markdown 内容
├── layouts/                  # 模板（自带主题）
├── assets/css/main.css       # 样式，经 Hugo Pipes 压缩+指纹
└── .github/workflows/hugo.yml# 构建与部署
```

## 发布流程

1. 提交推送到 `main`
2. Actions 安装 Hugo extended、执行 `hugo --gc --minify`
3. 产物 `public/` 上传为 Pages artifact
4. `deploy-pages` 发布

## 注意事项

- 首次需要把仓库的 **Settings → Pages → Source** 设为 **GitHub Actions**。
- 需要改站点地址时，改 `hugo.toml` 里的 `baseURL`。
- 样式改动走缓存指纹，浏览器不会拿到旧 CSS。
