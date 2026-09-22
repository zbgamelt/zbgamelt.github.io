#!/usr/bin/env node
/*
 * 评论写入端：校验 + 追加到 data/comments.json
 * ---------------------------------------------------------------
 * 由 .github/workflows/comment.yml 调用（workflow_dispatch → 本脚本 → 提交）。
 * 输入全部来自环境变量，参数值由 App 通过 GitHub API 传进来，一律当不可信数据。
 * 写进仓库的文件由 Pages 直接对外提供静态读取（https://zbgamelt.github.io/data/comments.json）。
 *
 * 设计取舍：
 *   - 一律只追加、不改写历史，方便 git 追溯与回滚。
 *   - 限流/去重/长度上限都在这里做，因为 App 里的令牌是公开的，
 *     必须假设有人会拿它直接灌水。
 *   - 命中策略拒绝时给 ::warning:: 并 exit 0（灌水不该把仓库搞成一片红的失败运行）；
 *     只有脚本自身出错才 exit 1。
 */

import fs from 'node:fs';

const FILE = 'data/comments.json';
const FEED = 'blogfeed.json';

const MAX_TOTAL = 2000;        // 总条数上限，超了就停收（防止无上限灌水）
const MAX_PER_DAY = 100;       // 每天最多收多少条
const NAME_MAX = 24;           // 昵称长度
const TEXT_MAX = 800;          // 正文长度
const DUP_WINDOW_MS = 120000;  // 同一条内容多久内不许重发
const TZ = 8 * 3600 * 1000;    // 展示用时间统一按东八区

const warn = (msg) => console.log(`::warning::评论未收录：${msg}`);

/** 清洗：控制字符、零宽字符、HTML 尖括号、超长截断 */
function clean(raw, max) {
  return String(raw == null ? '' : raw)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[<>]/g, (m) => (m === '<' ? '＜' : '＞'))
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, max);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 东八区 "09-22 22:18" */
function timeText(ts) {
  const d = new Date(ts + TZ);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 文章白名单：只允许给 feed 里真实存在的文章评论 */
function knownSlugs() {
  try {
    const feed = JSON.parse(fs.readFileSync(FEED, 'utf8'));
    const posts = Array.isArray(feed) ? feed : feed.posts || [];
    const set = new Set();
    for (const p of posts) {
      const slug = p && (p.slug || String(p.url || '').replace(/\/+$/, '').split('/').pop());
      if (slug) set.add(String(slug));
    }
    return set;
  } catch (e) {
    console.log(`::warning::读不到 ${FEED}（${e.message}），本次跳过文章白名单校验`);
    return null;
  }
}

function loadStore() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (d && Array.isArray(d.comments)) return d;
  } catch (e) {
    if (e.code !== 'ENOENT') console.log(`::warning::${FILE} 解析失败（${e.message}），按空库处理`);
  }
  return { updated: null, count: 0, comments: [] };
}

function main() {
  const post = clean(process.env.C_POST, 120);
  const name = clean(process.env.C_NAME, NAME_MAX) || '路人';
  const text = clean(process.env.C_TEXT, TEXT_MAX);
  const cid = clean(process.env.C_CID, 64);

  if (!post) return warn('缺少文章号');
  const slugs = knownSlugs();
  if (slugs && !slugs.has(post)) return warn(`文章号不在列表里：${post}`);
  if (!text) return warn('正文为空');

  const store = loadStore();
  const list = store.comments;
  const now = Date.now();

  if (list.length >= MAX_TOTAL) return warn(`评论总数已达上限 ${MAX_TOTAL}`);

  const todayStart = new Date(now + TZ);
  todayStart.setUTCHours(-8, 0, 0, 0);   // 东八区当日 00:00 对应的 UTC 毫秒
  const todayFrom = todayStart.getTime();
  const todayCount = list.filter((c) => Number(c.ts) >= todayFrom).length;
  if (todayCount >= MAX_PER_DAY) return warn(`今天已收满 ${MAX_PER_DAY} 条`);

  const dup = list.slice(-40).some(
    (c) => c.post === post && c.text === text && c.name === name && now - Number(c.ts) < DUP_WINDOW_MS
  );
  if (dup) return warn('内容和刚才那条一模一样，可能是重复提交');

  // 客户端 id：App 靠它确认「我这条发出去了」
  let id = /^[A-Za-z0-9_-]{6,64}$/.test(cid) ? cid : '';
  if (!id || list.some((c) => c.id === id)) {
    id = `c${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  const entry = { id, post, name, text, ts: now, timeText: timeText(now) };
  list.push(entry);

  const out = {
    updated: new Date(now).toISOString(),
    count: list.length,
    comments: list,
  };
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');

  console.log(`✓ 已收录评论 ${id}（${post} / ${name} / ${text.length} 字），当前共 ${list.length} 条`);
}

try {
  main();
} catch (e) {
  console.log(`::error::写入评论失败：${e && e.stack ? e.stack : e}`);
  process.exit(1);
}
