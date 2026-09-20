---
title: "你好，世界"
date: 2026-09-20T09:00:00Z
description: "第一篇。为什么选 Hugo，以及日常写文章的两个命令。"
tags: ["Hugo", "建站"]
---

第一篇，先跑通链路。

## 为什么用 Hugo

- **快**：几百个页面也是毫秒级构建。
- **单文件**：一个二进制，没有运行时依赖。
- **纯静态**：产物就是 HTML/CSS/JS，扔到哪都能跑。

## 写文章

```bash
hugo new content posts/my-post.md
hugo server --buildDrafts   # 本地预览 http://localhost:1313
```

推送到 `main` 分支后，GitHub Actions 会自动构建并发布到 Pages。

> 这句是引用块的样式示例。
