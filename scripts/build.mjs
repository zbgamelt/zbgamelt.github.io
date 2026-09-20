#!/usr/bin/env node
/**
 * GitHub Discussions → 静态论坛（零依赖）
 *
 *   node scripts/build.mjs            有 GITHUB_TOKEN 时拉真实 Discussions，否则回退缓存/样例
 *   node scripts/build.mjs --sample   强制使用预览样例数据（本地看设计用）
 *
 * 产物直接落在仓库根目录（index.html / t/<编号>/index.html / 404.html），
 * 因为 zbgamelt.github.io 是「用户站点」仓库，Pages 从 main 分支根目录发布。
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_FULL = process.env.GITHUB_REPOSITORY || 'zbgamelt/zbgamelt.github.io';
const [OWNER, NAME] = REPO_FULL.split('/');
const REPO_URL = `https://github.com/${OWNER}/${NAME}`;
const DISCUSS_URL = `${REPO_URL}/discussions`;
const NEW_POST_URL = `${DISCUSS_URL}/new`;

const SITE = loadSiteConfig();
const token = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
const forceSample = process.argv.includes('--sample');
const forceEmpty = process.argv.includes('--empty');
const TZ = 'Asia/Shanghai';

// ────────────────────────────────────────── 数据

/**
 * upvoteCount 就是 GitHub 上的「↑ 赞数」，评论行要显示它。
 * 这个字段万一不可用（或 token 权限不够），自动退化成不带赞数的查询：
 * 宁可少显示一个赞数，也不能让整站构建挂掉。
 */
function discussionsQuery(withUpvotes) {
  const uv = withUpvotes ? ' upvoteCount' : '';
  return `query($owner:String!, $name:String!, $cursor:String) {
    repository(owner:$owner, name:$name) {
      discussions(first:50, after:$cursor, orderBy:{field:UPDATED_AT, direction:DESC}) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          number title url createdAt updatedAt bodyHTML${uv}
          author { login url avatarUrl }
          category { name emoji }
          comments(first:50) {
            totalCount
            nodes { createdAt bodyHTML isAnswer${uv} author { login url avatarUrl } }
          }
        }
      }
    }
  }`;
}

async function fetchDiscussions() {
  let query = discussionsQuery(true);
  const all = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        authorization: `bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'zbgamelt-forum-builder',
      },
      body: JSON.stringify({ query, variables: { owner: OWNER, name: NAME, cursor } }),
    });
    const json = await res.json();
    // 只在「因为 upvoteCount 被拒」时降级重试；其它 GraphQL 报错照旧抛出去
    if (
      json.errors &&
      query.includes('upvoteCount') &&
      /upvoteCount|Cannot query field/i.test(JSON.stringify(json.errors))
    ) {
      console.log('! upvoteCount 字段不可用，退化成不带赞数的查询重试');
      query = discussionsQuery(false);
      continue;
    }
    if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
    const d = json.data?.repository?.discussions;
    if (!d) throw new Error('拿不到 discussions（仓库可能还没开启 Discussions）');
    all.push(...d.nodes);
    if (!d.pageInfo.hasNextPage) break;
    cursor = d.pageInfo.endCursor;
  }
  return all;
}

async function loadData() {
  const cachePath = join(ROOT, 'data', 'discussions.json');
  const samplePath = join(ROOT, 'data', 'sample-discussions.json');

  if (forceEmpty) {
    console.log('! 按 --empty 构建：只输出空状态页（不发布任何内容）');
    return { discussions: [], source: 'empty' };
  }
  if (!forceSample && token) {
    let nodes;
    try {
      nodes = await fetchDiscussions();
    } catch (err) {
      // 仓库刚建好、Discussions 还没开的时候，这里会报错；
      // 那不是构建故障，先发个空状态页，等开了再自动填内容。
      if (/discussion/i.test(err.message)) {
        console.log(`! ${err.message}`);
        console.log('! 先渲染空状态页（Discussions 一开，下次构建就会自动填充）');
        return { discussions: [], source: 'empty' };
      }
      throw err;
    }
    writeFileSync(cachePath, JSON.stringify({ discussions: nodes }, null, 2), 'utf8');
    console.log(`✓ 从 GitHub 拉取 ${nodes.length} 个讨论（${new Date().toISOString()}）`);
    return { discussions: nodes, source: 'github' };
  }
  if (!forceSample && existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    console.log(`✓ 用缓存数据（${cached.discussions.length} 个讨论）`);
    return { discussions: cached.discussions, source: 'cache' };
  }
  const sample = JSON.parse(readFileSync(samplePath, 'utf8'));
  console.log(`! 用预览样例数据（${sample.length} 个讨论）— 不是真实内容`);
  return { discussions: sample, source: 'sample' };
}

// ────────────────────────────────────────── 小工具

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Discussions 的 bodyHTML 由 GitHub 渲染，仍按不可信内容处理 */
const sanitize = (html) =>
  String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(iframe|object|embed|form)[\s\S]*?<\/\1>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|src)\s*=\s*"javascript:[^"]*"/gi, '$1="#"');

const text = (html) =>
  String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const truncate = (s, n) => (s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '…');

function fmtDate(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

const slug = String(SITE.name).replace(/\s+/g, '-').toLowerCase();

// ────────────────────────────────────────── 模板

const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0b0c0e"/><path d="M8 10.5h16v9a2 2 0 0 1-2 2h-8l-4.5 3.5V21.5H10a2 2 0 0 1-2-2z" fill="#ffd83d"/></svg>`,
  );

const ICON_SEARCH =
  '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M10.68 11.74a6 6 0 0 1-7.92-.62 6 6 0 1 1 8.54 0l3.03 3.03-1.06 1.06zM9.11 4.5a4 4 0 1 0-5.66 5.66 4 4 0 0 0 5.66-5.66z"/></svg>';
const ICON_BACK =
  '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M7.78 2.22 2 8l5.78 5.78 1.06-1.06L4.62 8.5H14v-1.5H4.62l4.22-4.22z"/></svg>';
const ICON_PLUS =
  '<svg viewBox="0 0 16 16" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M8.75 2.5v4.75H13.5v1.5H8.75v4.75h-1.5V8.75H2.5v-1.5h4.75V2.5z"/></svg>';

/**
 * 页面外壳。bare=true 用于搜索页：整页铺满，不要站点头部。
 * fab=false 用于发帖页：已经在发帖页了，不必再挂一个发帖悬浮球。
 */
function shell({ title, description, body, base = '', pageClass = '', script = '', bare = false, fab = true }) {
  const header = bare
    ? ''
    : `<header class="top">
  <div class="wrap top__inner">
    <a class="brand" href="${base || './'}">${esc(SITE.name)}</a>
    <a class="iconbtn" href="${base}search/" aria-label="搜索帖子" title="搜索">${ICON_SEARCH}</a>
  </div>
</header>
`;
  const fabBtn = fab
    ? `<a class="fab" href="${base}post/" aria-label="发新帖" title="发新帖">${ICON_PLUS}</a>\n`
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="dark">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<link rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="${base}assets/style.css">
</head>
<body class="${pageClass}">
<a class="skip" href="#main">跳到内容</a>
${header}<main id="main" class="wrap">
${body}
</main>
${fabBtn}${script}
</body>
</html>
`;
}

function avatar(a, size = 40) {
  if (!a?.avatarUrl) {
    return `<span class="avatar avatar--ghost" style="--s:${size}px" aria-hidden="true"></span>`;
  }
  return `<img class="avatar" style="--s:${size}px" src="${esc(a.avatarUrl)}${a.avatarUrl.includes('?') ? '&' : '?'}s=${size * 2}" width="${size}" height="${size}" alt="" loading="lazy">`;
}

/**
 * linked=false 用于列表行：整行已经是 <a>，再嵌一层 <a> 会被 HTML 解析器
 * 强行截断（嵌套锚点非法），导致行的后半截跑到卡片外面。
 */
function authorName(a, linked = true) {
  if (!a?.login) return '<span class="muted">匿名</span>';
  if (!linked) return `<span class="author">${esc(a.login)}</span>`;
  return `<a class="author" href="${esc(a.url || `https://github.com/${a.login}`)}" target="_blank" rel="noopener">${esc(a.login)}</a>`;
}

/**
 * 网页发帖的署名识别。
 * 用网页发的帖都是同一个 token 建的，GitHub 那边作者一律是仓库主；
 * 后端会往正文末尾追一行「> 由 **昵称** 通过论坛页面发布 · 时间」，
 * 这里把昵称捞出来当发帖人显示，否则全站帖子都会挂着仓库主的名字。
 */
const WEB_POST_RE = /由\s*(.{1,24}?)\s*通过论坛页面(?:发布|回复)/;

function webAuthor(d) {
  const m = WEB_POST_RE.exec(text(d.bodyHTML || ''));
  return m ? m[1].trim() : '';
}

/** 正文纯文本，用于摘要和搜索匹配；网页发帖的落款行排掉，不让它混进去。 */
function bodyText(d) {
  return text(d.bodyHTML || '')
    .replace(/\s*由\s*.{1,24}?\s*通过论坛页面发布[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 发帖人（纯文本）：有网页署名用署名，否则用 GitHub 账号。 */
function authorText(d) {
  return webAuthor(d) || d.author?.login || '匿名';
}

/** 有网页署名就显昵称 + 来源标记，否则退回 GitHub 账号。 */
function authorLabel(d, linked = true) {
  const nick = webAuthor(d);
  if (!nick) return authorName(d.author, linked);
  // 论坛网页发布：署名用填写的昵称（原先后面跟一个「网页」小标记，已按要求去掉）
  return `<span class="author">${esc(nick)}</span>`;
}

/**
 * 帖子卡片：无外框，紧贴排布。
 * 第一行标题、第二行内容、第三行左边用户名 / 右边时间。
 * 分类不再直接展示（筛选条已隐藏），但保留 data-cat 数据不删。
 */
function threadRow(d, base) {
  const cat = d.category?.name ?? '';
  const excerpt = truncate(text(d.bodyHTML), 96);
  const ts = new Date(d.updatedAt).getTime();
  return `    <a class="thread" href="${base}t/${d.number}/" data-cat="${esc(cat)}" data-ts="${ts}">
      <h2 class="thread__title">${esc(d.title)}</h2>
      ${excerpt ? `<p class="thread__excerpt">${esc(excerpt)}</p>` : ''}
      <div class="thread__meta">
        ${authorLabel(d, false)}
        <time datetime="${esc(d.updatedAt)}" title="${esc(fmtDate(d.updatedAt))}">${esc(fmtDate(d.updatedAt))}</time>
      </div>
    </a>`;
}

function emptyState() {
  return `  <section class="empty">
    <svg class="empty__art" viewBox="0 0 220 150" role="img" aria-label="还没有帖子">
      <ellipse cx="110" cy="132" rx="62" ry="7" fill="#ffffff" opacity=".04"/>
      <rect x="34" y="30" width="112" height="66" rx="18" fill="#16191d" stroke="#2b2f36"/>
      <path d="M56 96v18l20-18z" fill="#16191d" stroke="#2b2f36" stroke-linejoin="round"/>
      <circle cx="70" cy="63" r="4.5" fill="#ffd83d"/>
      <circle cx="90" cy="63" r="4.5" fill="#ffd83d" opacity=".55"/>
      <circle cx="110" cy="63" r="4.5" fill="#ffd83d" opacity=".28"/>
      <rect x="138" y="52" width="60" height="42" rx="14" fill="#101215" stroke="#24272c" stroke-dasharray="5 5"/>
      <path d="M186 94v12l-14-12z" fill="#101215" stroke="#24272c" stroke-dasharray="5 5"/>
    </svg>
    <h1>这里还一张帖子都没有…</h1>
    <p>论坛的帖子都住在 GitHub Discussions 里，第一贴要不你来开个头？</p>
    <a class="btn" href="post/">去发第一帖</a>
    <p class="empty__hint">不需要 GitHub 账号 · 发完几分钟内会自动同步到这里</p>
  </section>
`;
}

function renderIndex(discussions) {
  const list = discussions
    .slice()
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  // 分类筛选条已隐藏（用户要求不显示），但分类数据仍在每张卡片的 data-cat 上，没有删。
  const body =
    list.length === 0
      ? emptyState()
      : `  <nav class="tabs" aria-label="排序">
    <button class="tab is-active" type="button" data-sort="new" aria-pressed="true">最新</button>
    <button class="tab" type="button" data-sort="old" aria-pressed="false">最早</button>
  </nav>
  <section class="list" id="list">
${list.map((d) => threadRow(d, '')).join('\n')}
  </section>`;
  const script = `<script>
(function () {
  // 相对时间（“3 天前”）在浏览器里算：静态 HTML 里存的是绝对时间，
  // 否则每次构建都会因为“多久之前”变了而提交一次，纯属噪声。
  function ago(iso) {
    var t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    var m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' 小时前';
    var d = Math.round(h / 24);
    if (d < 30) return d + ' 天前';
    var mo = Math.round(d / 30);
    if (mo < 12) return mo + ' 个月前';
    return Math.round(mo / 12) + ' 年前';
  }
  Array.prototype.forEach.call(document.querySelectorAll('.thread__meta time[datetime]'), function (el) {
    var rel = ago(el.getAttribute('datetime'));
    if (rel) el.textContent = rel;
  });

  // 排序：按卡片上的 data-ts 重排 DOM，不刷新页面
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var list = document.getElementById('list');
  if (!list) return;
  var rows = Array.prototype.slice.call(list.children);
  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      tabs.forEach(function (o) {
        var on = o === t;
        o.classList.toggle('is-active', on);
        o.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      rows
        .slice()
        .sort(function (a, b) {
          var x = +a.dataset.ts || 0;
          var y = +b.dataset.ts || 0;
          return t.dataset.sort === 'old' ? x - y : y - x;
        })
        .forEach(function (el) { list.appendChild(el); });
    });
  });
})();
</script>`;
  return shell({
    title: `${SITE.name} — ${SITE.tagline || SITE.desc || '讨论'}`,
    description: SITE.desc || SITE.tagline || '基于 GitHub Discussions 的静态论坛',
    body,
    script,
    pageClass: 'page-index',
  });
}

/**
 * giscus 嵌入（评论用）。
 * 用 mapping="number" + data-term=<讨论编号>：giscus 会直接走
 * GraphQL 的 discussion(number:) 精确取那一条，不走标题模糊搜索，
 * 所以不会串帖，也不需要嵌入 discussion 的 node ID。
 * （属性名是 data-term，不是 data-discussion —— 以 client.js loader 源码为准。）
 */
/**
 * GitHub GraphQL 返回的 category.emoji 是短码（如 ":mega:"），不是 emoji 字符；
 * 样例数据里写的是真 emoji，所以本地预览盖不住这个坑。
 * 认得的映射成真 emoji，认不得的短码宁可留白，不要显示 ":xxx:" 生字。
 */
const CAT_EMOJI = {
  ':mega:': '📣',
  ':bulb:': '💡',
  ':speech_balloon:': '💬',
  ':pencil:': '✏️',
  ':bar_chart:': '📊',
  ':question:': '❓',
  ':raised_hands:': '🙌',
  ':tada:': '🎉',
  ':sparkles:': '✨',
  ':loudspeaker:': '📢',
  ':bug:': '🐛',
  ':rocket:': '🚀',
  ':thought_balloon:': '🗨️',
};

function catEmoji(emoji) {
  if (!emoji) return '';
  const e = String(emoji).trim();
  if (CAT_EMOJI[e]) return CAT_EMOJI[e];
  if (e.startsWith(':') && e.endsWith(':')) return '';
  return e;
}

/**
 * 一条评论：
 *   第一行 头像 + 用户名（时间靠右）
 *   第二行 评论内容
 *   第三行 左「↑ 赞数 / 表情」  右「回复」
 */
function commentRow(c, i) {
  const up = Number(c.upvoteCount ?? 0) || 0;
  const nick = authorText(c);
  return `    <article class="cmt" id="c${i + 1}">
      <header class="cmt__head">
        ${avatar(c.author, 28)}
        <span class="cmt__name">${esc(nick)}</span>
        ${c.isAnswer ? '<span class="badge">已采纳</span>' : ''}
        <time datetime="${esc(c.createdAt)}">${esc(fmtDate(c.createdAt))}</time>
      </header>
      <div class="md cmt__body">${sanitize(c.bodyHTML)}</div>
      <footer class="cmt__foot">
        <span class="cmt__tools">
          <span class="cmt__up" title="GitHub 上收到的赞">↑ ${up}</span>
          <button class="cmt__emoji" type="button" aria-label="选表情">😊</button>
        </span>
        <button class="cmt__reply" type="button" data-reply="${esc(nick)}">回复</button>
      </footer>
    </article>`;
}

/**
 * 帖子页：标题栏（返回键 + 帖子标题）→ 正文 → 评论数 → 输入框 → 评论列表。
 * 原本这里挂的是 giscus（第三方 iframe，要求登录 GitHub 才能评论），
 * 玩家不可能为了一条评论去注册 GitHub，所以改成自绘评论列表。
 * 发表走的还是自家 Worker（forum-api），没有配 api 时输入框会明说“正在接通”。
 */
function renderThread(d) {
  const comments = (d.comments?.nodes ?? [])
    .slice()
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const rows = comments.map((c, i) => commentRow(c, i)).join('\n');
  const p = SITE.post || {};
  const canComment = Boolean(p.comment && p.turnstileSitekey);
  const body = `  <header class="tbar">
    <a class="tbar__back" href="../../" aria-label="返回话题列表"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></a>
    <h1 class="tbar__title">${esc(d.title)}</h1>
  </header>
  <article class="post">
    <div class="post__meta">
      ${avatar(d.author, 24)}
      ${authorLabel(d)}
      <time datetime="${esc(d.createdAt)}">${esc(fmtDate(d.createdAt))}</time>
      <a class="post__src" href="${esc(d.url)}" target="_blank" rel="noopener">在 GitHub 查看</a>
    </div>
    <div class="md post__body">${sanitize(d.bodyHTML)}</div>
  </article>
  <section class="cmts">
    <h2 class="cmts__title">评论 <span id="ccount">${comments.length}</span></h2>
    <div class="cbox">
      <button class="cbox__emoji" type="button" id="cbe" aria-label="选表情">😊</button>
      <input class="cbox__input" id="cinput" type="text" placeholder="说点什么…" maxlength="500" autocomplete="off">
      <button class="cbox__send" type="button" id="csend">发送</button>
    </div>
    <div class="emoji-strip" id="estrip" hidden></div>
${canComment ? `    <div class="cbox__human" id="chuman" hidden><div class="cf-turnstile" data-sitekey="${esc(p.turnstileSitekey)}" data-theme="dark" data-language="zh-cn"></div></div>\n` : ''}    <p class="cbox__hint" id="chint" hidden></p>
    <div class="cmts__list" id="clist">
${rows}
    </div>
${comments.length === 0 ? '    <p class="cmts__none">还没有人评论，你可以是第一个。</p>\n' : ''}  </section>`;
  const script = `<script>
(function () {
  // 相对时间在浏览器里算，避免每次构建都因为“多久之前”变了而提交一次
  function ago(iso) {
    var t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    var m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' 小时前';
    var dd = Math.round(h / 24);
    if (dd < 30) return dd + ' 天前';
    var mo = Math.round(dd / 30);
    if (mo < 12) return mo + ' 个月前';
    return Math.round(mo / 12) + ' 年前';
  }
  Array.prototype.forEach.call(document.querySelectorAll('.cmt__head time[datetime]'), function (el) {
    var rel = ago(el.getAttribute('datetime'));
    if (rel) el.textContent = rel;
  });

  var input = document.getElementById('cinput');
  var sendBtn = document.getElementById('csend');
  var hint = document.getElementById('chint');
  var strip = document.getElementById('estrip');
  var human = document.getElementById('chuman');
  var API = ${JSON.stringify(p.comment || '')};
  var NUM = ${Number(d.number)};

  var EMOJIS = ['😀','😄','😁','😂','🤣','😊','😍','🤔','😅','😭','😡','🥲','👍','👎','🙏','🎉','❤️','🔥','⭐','🐟','☕','😴'];
  if (strip) {
    strip.innerHTML = EMOJIS.map(function (e) {
      return '<button type="button" class="emoji-strip__i">' + e + '</button>';
    }).join('');
    Array.prototype.forEach.call(strip.children, function (b) {
      b.addEventListener('click', function () { insert(b.textContent); });
    });
  }
  function insert(txt) {
    if (!input) return;
    var s = input.selectionStart == null ? input.value.length : input.selectionStart;
    var e = input.selectionEnd == null ? input.value.length : input.selectionEnd;
    input.value = input.value.slice(0, s) + txt + input.value.slice(e);
    input.focus();
    input.selectionStart = input.selectionEnd = s + txt.length;
  }
  function toggleStrip() { if (strip) strip.hidden = !strip.hidden; }
  function focusInput() {
    if (!input) return;
    input.focus();
    try { input.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
  }
  function say(msg) {
    if (!hint) return;
    if (!msg) { hint.hidden = true; hint.textContent = ''; return; }
    hint.textContent = msg;
    hint.hidden = false;
  }
  function nick() {
    try { return localStorage.getItem('forumNick') || ''; } catch (e) { return ''; }
  }

  // 「回复」：把 @对方 预填进输入框；「😊」：展开表情条往评论里插表情
  Array.prototype.forEach.call(document.querySelectorAll('.cmt__reply'), function (b) {
    b.addEventListener('click', function () {
      if (!input) return;
      input.value = '回复 @' + (b.getAttribute('data-reply') || '') + '：';
      focusInput();
      say('');
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.cmt__emoji'), function (b) {
    b.addEventListener('click', function () { toggleStrip(); focusInput(); });
  });
  var cbe = document.getElementById('cbe');
  if (cbe) cbe.addEventListener('click', function () { toggleStrip(); if (input) input.focus(); });

  function submit() {
    if (!input) return;
    var text = input.value.trim();
    if (!text) { focusInput(); return; }
    if (!API) { say('评论接口正在接通中 —— 先点右上「在 GitHub 查看」去那边评论。'); return; }
    if (text.length < 2) { say('多写两个字吧'); return; }
    var ts = document.querySelector('[name="cf-turnstile-response"]');
    var token = ts ? ts.value : '';
    if (!token) {
      if (human) human.hidden = false;
      say('第一次评论过一下人机验证，点一下下面的框再发送');
      return;
    }
    if (sendBtn) sendBtn.disabled = true;
    say('发送中…');
    fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ number: NUM, nickname: nick(), body: text, turnstileToken: token }),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }).catch(function () { return { ok: false, j: {} }; }); })
      .then(function (res) {
        if (sendBtn) sendBtn.disabled = false;
        if (window.turnstile) window.turnstile.reset();
        if (!res.ok) { say(res.j.error || '发送失败，稍后再试'); return; }
        input.value = '';
        say('已提交，刷新页面就能看到你的评论。');
      })
      .catch(function () {
        if (sendBtn) sendBtn.disabled = false;
        say('网络不太顺，稍后再试');
      });
  }
  if (sendBtn) sendBtn.addEventListener('click', submit);
  if (input) input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  if (!API) say('评论功能正在接通中 —— 先点右上「在 GitHub 查看」去那边评论。');
})();
</script>${canComment ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}`;
  return shell({
    title: `${d.title} — ${SITE.name}`,
    description: truncate(text(d.bodyHTML), 140),
    body,
    script,
    base: '../../',
    pageClass: 'page-thread',
  });
}

/**
 * 发新帖页。写权限在 Cloudflare Worker 那边（forum-api.zbgame.bid），
 * 本站依然是纯静态，页面里没有任何凭据。
 * 人机验证用 Turnstile（无感，可疑流量才会显示复选框）。
 */
function renderCompose() {
  const p = SITE.post;
  const ready = Boolean(p?.api && p?.turnstileSitekey);
  // 这个页面在 /post/ 下，相对深度和 /t/<编号>/ 不同：
  // 少写一个 base 就会去 /post/assets/style.css 找样式（不存在）→ 页面裸奔。
  const base = '../';
  if (!ready) {
    return shell({
      title: `发新帖 — ${SITE.name}`,
      description: '去 GitHub 发新帖',
      base,
      body: `  <section class="empty">
    <h1>页内发帖还没接线</h1>
    <p>本站暂时只能跳到 GitHub 发帖。</p>
    <a class="btn" href="${DISCUSS_URL}" target="_blank" rel="noopener">去 GitHub 发帖</a>
  </section>`,
    });
  }
  const body = `  <nav class="crumb"><a href="../">← 全部话题</a></nav>
  <section class="compose">
    <h1>发新帖</h1>
    <p class="compose__sub">不用注册 GitHub 账号。发完几分钟内就会出现在首页。</p>
    <form id="postform" class="form" novalidate>
      <label class="field">
        <span class="field__label">昵称 <i>选填</i></span>
        <input id="nick" name="nickname" type="text" maxlength="24" placeholder="不填就署名「匿名访客」" autocomplete="nickname">
      </label>
      <label class="field">
        <span class="field__label">标题</span>
        <input id="title" name="title" type="text" maxlength="120" placeholder="一句话说清楚你要问什么">
      </label>
      <label class="field">
        <span class="field__label">正文</span>
        <textarea id="body" name="body" rows="10" placeholder="支持 Markdown。写得越具体，越容易被答上。"></textarea>
      </label>
      <div class="cf-turnstile" data-sitekey="${esc(p.turnstileSitekey)}" data-theme="dark" data-language="zh-cn"></div>
      <div class="form__foot">
        <button class="btn" id="submit" type="submit">发布</button>
        <span class="form__note" id="note" role="status" aria-live="polite"></span>
      </div>
    </form>
    <div class="done" id="done" hidden>
      <h2>发出去了 ✅</h2>
      <p id="done__text"></p>
      <p class="done__links">
        <a class="btn" id="done__gh" target="_blank" rel="noopener">在 GitHub 上查看</a>
        <a class="btn btn--ghost" href="../">回论坛首页</a>
      </p>
      <p class="empty__hint">首页要等站点完成重建才会出现这条（通常几分钟）。</p>
    </div>
  </section>`;
  const script = `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script>
(function () {
  var form = document.getElementById('postform');
  if (!form) return;
  var note = document.getElementById('note');
  var btn = document.getElementById('submit');
  function setNote(t) { if (note) note.textContent = t; }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var title = document.getElementById('title').value.trim();
    var body = document.getElementById('body').value.trim();
    var nick = document.getElementById('nick').value.trim();
    var ts = form.querySelector('[name="cf-turnstile-response"]');
    if (title.length < 4) return setNote('标题至少 4 个字');
    if (body.length < 8) return setNote('正文再写长一点点');
    if (!ts || !ts.value) return setNote('人机验证还没完成，稍等一下再点发布');
    btn.disabled = true;
    setNote('正在发布…');
    fetch(${JSON.stringify(p.api)}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: nick, title: title, body: body, turnstileToken: ts.value })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.d || !res.d.ok) throw new Error((res.d && res.d.error) || '发布失败');
        document.getElementById('done__text').textContent = '《' + title + '》已经建好了。';
        document.getElementById('done__gh').href = res.d.url;
        form.hidden = true;
        document.getElementById('done').hidden = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      })
      .catch(function (err) {
        setNote(err.message || '发布失败，稍后再试');
        if (window.turnstile) window.turnstile.reset();
      })
      .then(function () { btn.disabled = false; });
  });
})();
</script>`;
  return shell({
    title: `发新帖 — ${SITE.name}`,
    description: '在本站发一条新帖，不用注册 GitHub 账号',
    body,
    base,
    pageClass: 'page-compose',
    script,
    fab: false,
  });
}

/**
 * 搜索页：整页铺满。第一行是搜索栏（返回 / 输入框 / 搜索图标），
 * 第二行是「帖子 x」，剩下全是结果，行与行之间只有分隔线，没有外框。
 * 帖子数据直接内嵌进页面（不额外 fetch），这样本地 file:// 也能打开验证。
 */
function renderSearch(discussions) {
  const list = discussions.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const data = list.map((d) => ({
    n: d.number,
    t: d.title,
    x: truncate(bodyText(d), 110),
    s: bodyText(d).toLowerCase().slice(0, 600),
    u: authorText(d),
  }));
  const body = `  <div class="sbar">
    <a class="sbar__back" href="../" id="sback" aria-label="返回" title="返回">${ICON_BACK}</a>
    <input id="sq" class="sbar__input" type="search" placeholder="搜索帖子…" autocomplete="off" aria-label="搜索帖子">
    <button id="sgo" class="sbar__go" type="button" aria-label="搜索" title="搜索">${ICON_SEARCH}</button>
  </div>
  <p class="scount" id="scount">帖子 0</p>
  <div class="slist" id="slist"></div>
  <p class="sempty" id="sempty" hidden>没有匹配的帖子，换个词试试？</p>`;
  const script = `<script>
(function () {
  var POSTS = ${JSON.stringify(data)};
  var q = document.getElementById('sq');
  var list = document.getElementById('slist');
  var count = document.getElementById('scount');
  var empty = document.getElementById('sempty');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function render() {
    var terms = q.value.trim().toLowerCase().split(/\\s+/).filter(Boolean);
    var hit = POSTS.filter(function (p) {
      if (!terms.length) return true;
      var hay = (p.t + ' ' + p.x + ' ' + p.s + ' ' + p.u).toLowerCase();
      return terms.every(function (t) { return hay.indexOf(t) !== -1; });
    });
    count.textContent = '帖子 ' + hit.length;
    empty.hidden = hit.length > 0;
    list.innerHTML = hit
      .map(function (p) {
        return (
          '<a class="sitem" href="../t/' + p.n + '/">' +
          '<h2 class="sitem__title">' + esc(p.t) + '</h2>' +
          (p.x ? '<p class="sitem__excerpt">' + esc(p.x) + '</p>' : '') +
          '<div class="sitem__user">' + esc(p.u) + '</div>' +
          '</a>'
        );
      })
      .join('');
  }

  q.addEventListener('input', render);
  q.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); q.blur(); }
  });
  document.getElementById('sgo').addEventListener('click', function () { render(); q.focus(); });
  // 从站内点进来的才走浏览器返回；直接打开这个地址的就回首页
  document.getElementById('sback').addEventListener('click', function (e) {
    try {
      if (document.referrer && new URL(document.referrer).origin === location.origin && history.length > 1) {
        e.preventDefault();
        history.back();
      }
    } catch (err) {}
  });
  render();
  q.focus();
})();
</script>`;
  return shell({
    title: `搜索 — ${SITE.name}`,
    description: '搜索论坛里的帖子',
    body,
    base: '../',
    pageClass: 'page-search',
    script,
    bare: true,
    fab: false,
  });
}

function render404() {
  const body = `  <section class="empty">
    <svg class="empty__art" viewBox="0 0 220 150" role="img" aria-label="页面不存在">
      <ellipse cx="110" cy="132" rx="62" ry="7" fill="#ffffff" opacity=".04"/>
      <circle cx="110" cy="66" r="42" fill="#101215" stroke="#24272c" stroke-dasharray="6 6"/>
      <path d="M96 52c2-9 12-13 20-8 9 5 9 17 1 22-4 3-7 4-7 9" fill="none" stroke="#ffd83d" stroke-width="4" stroke-linecap="round"/>
      <circle cx="110" cy="88" r="3.4" fill="#ffd83d"/>
    </svg>
    <h1>这个页面好像走丢了</h1>
    <p>链接可能拼错了，或者帖子已经被删掉。</p>
    <a class="btn" href="/">回到论坛首页</a>
  </section>`;
  return shell({ title: `页面不存在 — ${SITE.name}`, description: '404', body });
}

/**
 * 防止再犯：<a> 里嵌 <a> 会被 HTML 解析器截断，导致布局静默错位。
 * 注意闭合标签在匹配结果里是 "/a>"（不含 "<"），所以要用首字符判断，
 * 不能用 startsWith('</')——否则每个 </a> 都会被当成开标签。
 */
function assertNoNestedAnchors(html, label) {
  const tag = /<a\b[^>]*>|\/a\s*>/g;
  let open = 0;
  let m;
  while ((m = tag.exec(html)) !== null) {
    if (m[0].charAt(0) === '/') {
      open = Math.max(0, open - 1);
    } else if (++open > 1) {
      throw new Error(`${label}: 发现嵌套 <a>（会被 HTML 解析器截断，破坏布局）`);
    }
  }
}

const pages = [];

function writePage(relPath, html, label) {
  assertNoNestedAnchors(html, label || relPath);
  const full = join(ROOT, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, html);
  pages.push(relPath);
}

// ────────────────────────────────────────── 主流程

function loadSiteConfig() {
  const p = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'site.json');
  const defaults = {
    name: 'zbgamelt 论坛',
    tagline: '提问 · 反馈 · 闲聊',
    desc: '关于 zbgamelt 的讨论：新版本反馈、问题求助、功能建议。',
  };
  if (!existsSync(p)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(p, 'utf8')) };
  } catch {
    return defaults;
  }
}

async function main() {
  const { discussions, source } = await loadData();

  // 清掉上次生成物（保留源目录）
  rmSync(join(ROOT, 't'), { recursive: true, force: true });
  rmSync(join(ROOT, 'post'), { recursive: true, force: true });
  rmSync(join(ROOT, 'search'), { recursive: true, force: true });
  rmSync(join(ROOT, 'index.html'), { force: true });
  rmSync(join(ROOT, '404.html'), { force: true });

  writePage('index.html', renderIndex(discussions), 'index.html');
  for (const d of discussions) {
    writePage(join('t', String(d.number), 'index.html'), renderThread(d), `讨论 #${d.number}`);
  }
  writePage('404.html', render404(), '404.html');
  writePage(join('post', 'index.html'), renderCompose(), 'post/index.html');
  writePage(join('search', 'index.html'), renderSearch(discussions), 'search/index.html');
  writeFileSync(join(ROOT, '.nojekyll'), '');
  mkdirSync(join(ROOT, 'assets'), { recursive: true });

  console.log(`✓ 生成 ${pages.length} 个页面（数据源：${source}）→ ${ROOT}`);
  if (source === 'sample') console.log('  （样例数据，线上不会被用到）');
}

main().catch((err) => {
  console.error('✗ 构建失败：', err.message);
  process.exit(1);
});
