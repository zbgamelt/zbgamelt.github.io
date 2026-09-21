#!/usr/bin/env node
/**
 * GitHub Discussions → 静态论坛（零依赖）
 *
 *   node scripts/build.mjs            有 GITHUB_TOKEN 时拉真实 Discussions；
 *                                    拉不到就**报错退出**（绝不退回缓存/样例，
 *                                    更不会把「拉取失败」当成「空论坛」覆盖线上）
 *   node scripts/build.mjs --sample   强制使用预览样例数据（本地看设计用）
 *   node scripts/build.mjs --empty    显式生成空状态页（真的空论坛才用）
 *
 * 关键约束：只要 token 在，数据就必须来自 GitHub 且可信；任何异常一律非 0 退出。
 * 空状态页只有两条出口：明确判定「仓库没开 Discussions」，或显式 --empty。
 * （历史事故：token 失效的报错文案里含 "discussions"，被当成「没开 Discussions」，
 *   静默渲染空页，紧接着 build.yml 的 git add -A 就把整个论坛清空推上 main。）
 *
 * 产物直接落在仓库根目录（index.html / t/<编号>/index.html / 404.html），
 * 因为 zbgamelt.github.io 是「用户站点」仓库，Pages 从 main 分支根目录发布。
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

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
 * 构建期致命错误。用 code 区分「可预期的非故障」和「真故障」，调用方只看 code，
 * 绝不去正则匹配错误文案：
 * 旧代码用 /discussion/i 判「仓库没开 Discussions」，而 token 失效时报的
 * 「拿不到 discussions（仓库可能还没开启 Discussions）」也含这个词 —— 于是
 * 一次失效的 token 就把线上论坛静默清空了。别再回到文案匹配。
 */
class BuildError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BuildError';
    this.code = code;
  }
}

const GH_HEADERS = {
  authorization: `bearer ${token}`,
  'content-type': 'application/json',
  accept: 'application/vnd.github+json',
  'user-agent': 'zbgamelt-forum-builder',
};

/**
 * 统一 HTTP 调用：网络故障 / 非 2xx / 非 JSON 一律抛 BuildError，绝不吞。
 * 401=token 无效或过期，403=权限不足或限流，404=这个 token 看不到该仓库。
 */
async function ghFetch(url, init, what) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new BuildError(`${what}：网络请求失败（${err.message}）`, 'NETWORK');
  }
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new BuildError(`${what}：HTTP ${res.status}，返回的不是 JSON（${raw.slice(0, 200)}）`, 'BAD_RESPONSE');
  }
  if (!res.ok) {
    throw new BuildError(
      `${what}：HTTP ${res.status} ${json.message || ''}`.trim() +
        '（token 可能无效、过期或权限不足；这一步失败绝不能当成「论坛是空的」）',
      'HTTP',
    );
  }
  return json;
}

/**
 * 仓库到底有没有开 Discussions —— 只认 REST 的 has_discussions 这个明确信号。
 * 拿不到这个信号（网络/token 问题）就抛错，绝不假设成「没开」。
 */
async function discussionsEnabled() {
  const json = await ghFetch(
    `https://api.github.com/repos/${OWNER}/${NAME}`,
    { headers: GH_HEADERS },
    '查询仓库信息',
  );
  if (typeof json.has_discussions !== 'boolean') {
    throw new BuildError('查询仓库信息：响应里没有 has_discussions 字段，无法判断 Discussions 状态', 'BAD_RESPONSE');
  }
  return json.has_discussions;
}

async function fetchDiscussions() {
  const query = `query($owner:String!, $name:String!, $cursor:String) {
    repository(owner:$owner, name:$name) {
      discussions(first:50, after:$cursor, orderBy:{field:UPDATED_AT, direction:DESC}) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          number title url createdAt updatedAt bodyHTML
          author { login url avatarUrl }
          category { name emoji }
          comments(first:50) {
            totalCount
            nodes { createdAt bodyHTML isAnswer author { login url avatarUrl } }
          }
        }
      }
    }
  }`;
  const all = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const json = await ghFetch(
      'https://api.github.com/graphql',
      {
        method: 'POST',
        headers: GH_HEADERS,
        body: JSON.stringify({ query, variables: { owner: OWNER, name: NAME, cursor } }),
      },
      '拉取 Discussions',
    );
    if (json.errors) {
      throw new BuildError(`拉取 Discussions 失败（GraphQL 报错）：${JSON.stringify(json.errors)}`, 'GRAPHQL');
    }
    const d = json.data?.repository?.discussions;
    if (!d) throw new BuildError('拉取 Discussions 失败：GraphQL 响应里没有 repository.discussions', 'GRAPHQL');
    all.push(...d.nodes);
    if (!d.pageInfo.hasNextPage) break;
    cursor = d.pageInfo.endCursor;
  }
  return all;
}

async function loadData() {
  const cachePath = join(ROOT, 'data', 'discussions.json');
  const samplePath = join(ROOT, 'data', 'sample-discussions.json');
  const inCI = Boolean(process.env.GITHUB_ACTIONS || process.env.CI);

  if (forceEmpty) {
    console.log('! 按 --empty 构建：只输出空状态页（不发布任何内容）');
    return { discussions: [], source: 'empty' };
  }

  if (!forceSample && token) {
    // 有 token 就只认真实数据：拉不到就报错退出，不许退回缓存/样例，
    // 更不许把「拉取失败」当成「论坛是空的」——线上紧接着就是 git add -A。
    if (!(await discussionsEnabled())) {
      console.log('! 这个仓库没有开启 Discussions（REST has_discussions=false）');
      console.log('! 这是仓库设置、不是 token/网络问题：先渲染空状态页，等 Discussions 一开下次构建自动填充');
      return { discussions: [], source: 'empty' };
    }
    const nodes = await fetchDiscussions();
    if (nodes.length === 0) {
      // 仓库开了 Discussions、token 也有效，却一条都拿不到：宁可让构建红，
      // 也不要拿空论坛去覆盖线上。确实空论坛就显式跑 --empty。
      throw new BuildError(
        'Discussions 已开启、token 也有效，但一个讨论都没拉到 —— 拒绝用空论坛覆盖线上',
        'EMPTY_RESULT',
      );
    }
    writeFileSync(cachePath, JSON.stringify({ discussions: nodes }, null, 2), 'utf8');
    console.log(`✓ 从 GitHub 拉取 ${nodes.length} 个讨论（${new Date().toISOString()}）`);
    return { discussions: nodes, source: 'github' };
  }

  if (inCI && !forceSample) {
    // CI 里没有 token 就是配置坏了：缓存/样例都不是真实内容，不能拿去覆盖线上。
    throw new BuildError(
      `CI 环境里没有 GITHUB_TOKEN（${REPO_FULL}），拒绝用缓存/样例数据构建`,
      'NO_TOKEN_IN_CI',
    );
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

/**
 * PWA（装到手机桌面）的配置。名称等从 data/site.json 的 pwa 块读，改名字不用碰代码；
 * 图标是静态文件（scripts/make-icons.py 生成），这里只生成清单。
 */
const PWA = {
  name: SITE.pwa?.name || SITE.name,
  shortName: SITE.pwa?.shortName || SITE.name,
  desc: SITE.pwa?.desc || SITE.desc || SITE.tagline || '',
  themeColor: SITE.pwa?.themeColor || '#0b0c0e',
  backgroundColor: SITE.pwa?.backgroundColor || '#0b0c0e',
};

function renderManifest() {
  return (
    JSON.stringify(
      {
        name: PWA.name,
        short_name: PWA.shortName,
        description: PWA.desc,
        lang: 'zh-CN',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: PWA.backgroundColor,
        theme_color: PWA.themeColor,
        icons: [
          { src: '/assets/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/assets/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // maskable 单独一份：满幅无圆角，标记收在安全区里，各家桌面的异形遮罩都切不到
          { src: '/assets/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: '论坛', url: '/' },
          { name: '博客', url: '/zbgamelttwo/' },
          { name: '我的', url: '/me/' },
        ],
      },
      null,
      2,
    ) + '\n'
  );
}

const ICON_SEARCH =  '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M10.68 11.74a6 6 0 0 1-7.92-.62 6 6 0 1 1 8.54 0l3.03 3.03-1.06 1.06zM9.11 4.5a4 4 0 1 0-5.66 5.66 4 4 0 0 0 5.66-5.66z"/></svg>';
const ICON_BACK =
  '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M7.78 2.22 2 8l5.78 5.78 1.06-1.06L4.62 8.5H14v-1.5H4.62l4.22-4.22z"/></svg>';
const ICON_PLUS =
  '<svg viewBox="0 0 16 16" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M8.75 2.5v4.75H13.5v1.5H8.75v4.75h-1.5V8.75H2.5v-1.5h4.75V2.5z"/></svg>';
const ICON_HOME =
  '<svg viewBox="0 0 16 16" width="21" height="21" aria-hidden="true"><path fill="currentColor" d="M8 1.3 1.6 6.8V15h4.5v-4.4h3.8V15h4.5V6.8z"/></svg>';
const ICON_USER =
  '<svg viewBox="0 0 16 16" width="21" height="21" aria-hidden="true"><path fill="currentColor" d="M8 8.3a3.65 3.65 0 1 0 0-7.3 3.65 3.65 0 0 0 0 7.3m0 1.5c-3.2 0-5.8 1.7-5.8 3.8V15h11.6v-1.4c0-2.1-2.6-3.8-5.8-3.8"/></svg>';
/** 卡片右上角的「更多」：竖着的三个点 */
const ICON_MORE =
  '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 3.1a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5m0 6.15a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5m0 6.15a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5"/></svg>';

/**
 * 页面外壳。bare=true 用于搜索页：整页铺满，不要站点头部。
 * fab=false 用于发帖页：已经在发帖页了，不必再挂一个发帖悬浮球。
 */
function shell({ title, description, body, base = '', pageClass = '', script = '', bare = false, fab = true, nav = true, navOn = '' }) {
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
  // 底部栏：首页 / 我的。发帖页（专心写东西）与 404（深链下相对路径会错）不挂。
  const navBar = nav
    ? `<nav class="bnav" aria-label="主导航">
  <a class="bnav__item${navOn === 'home' ? ' is-on' : ''}" href="${base || './'}"${navOn === 'home' ? ' aria-current="page"' : ''}>${ICON_HOME}<span>首页</span></a>
  <a class="bnav__item${navOn === 'me' ? ' is-on' : ''}" href="${base}me/"${navOn === 'me' ? ' aria-current="page"' : ''}>${ICON_USER}<span>我的</span></a>
</nav>\n`
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
<link rel="manifest" href="${base}manifest.webmanifest">
<link rel="apple-touch-icon" href="${base}assets/icons/apple-touch-icon.png">
<meta name="theme-color" content="${esc(PWA.themeColor)}">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="${esc(PWA.shortName)}">
<link rel="stylesheet" href="${base}assets/style.css">
</head>
<body class="${pageClass}${nav ? ' has-nav' : ''}">
<a class="skip" href="#main">跳到内容</a>
${header}<main id="main" class="wrap">
${body}
</main>
${fabBtn}${navBar}${swRegister(base)}${script}
</body>
</html>
`;
}

/**
 * 注册 Service Worker（sw.js 在站点根，作用域就是整个站点，论坛和博客都盖到）。
 * 只用它来「能装到桌面」+ 断网兜底，拿不到也不影响页面本身，所以失败静默。
 */
function swRegister(base) {
  return `<script>if('serviceWorker' in navigator){addEventListener('load',function(){navigator.serviceWorker.register('${base}sw.js').catch(function(){})})}</script>`;
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
const WEB_POST_RE = /由\s*(.{1,24}?)\s*通过论坛页面发布/;

function webAuthor(d) {
  const m = WEB_POST_RE.exec(text(d.bodyHTML || ''));
  return m ? m[1].trim() : '';
}

/**
 * 网页发帖的落款块（后端在正文末尾追加的「<hr> + > 由 **昵称** 通过论坛页面发布 · 时间」）
 * 只在 GitHub 那边有意义：论坛页面里昵称已经显示在标题下方那行了，再挂一遍是重复。
 * 注意只在「渲染」时去掉 —— 数据里这行必须留着，webAuthor() 靠它读发帖昵称。
 */
function stripWebByline(html) {
  return String(html || '')
    .replace(/\s*<hr\s*\/?>\s*<blockquote>[\s\S]*?通过论坛页面发布[\s\S]*?<\/blockquote>\s*$/i, '')
    .replace(/\s*<blockquote>[\s\S]*?通过论坛页面发布[\s\S]*?<\/blockquote>\s*$/i, '')
    .replace(/\s*<p[^>]*>\s*由\s*.{1,24}?\s*通过论坛页面发布[\s\S]*?<\/p>\s*$/i, '')
    .trim();
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
  const excerpt = truncate(bodyText(d), 96);
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
  </section>`;
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
    navOn: 'home',
  });
}

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
 * 帖子页：标题栏（返回键 + 居中标题）→ 正文 → 回复区。
 * 回复区用站内评论（/assets/zsocial.js）：注册个邮箱账号就能回，不用 GitHub。
 * giscus 时代留下的 GitHub 回复不再更新，退成构建期快照折进 <details> 备查。
 */
function renderThread(d) {
  const comments = (d.comments?.nodes ?? [])
    .slice()
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const staticReplies = comments
    .map(
      (c) => `    <article class="reply${c.isAnswer ? ' reply--answer' : ''}">
      <header class="reply__head">
        ${avatar(c.author, 34)}
        <div class="post__who">
          ${authorName(c.author)}
          <time datetime="${esc(c.createdAt)}">${esc(fmtDate(c.createdAt))}</time>
        </div>
        ${c.isAnswer ? '<span class="badge">已采纳</span>' : ''}
      </header>
      <div class="md">${sanitize(c.bodyHTML)}</div>
    </article>`,
    )
    .join('\n');
  // 评论键用页面路径（跟博客的约定一致），帖子就是 t/<编号>
  const threadKey = `t/${d.number}`;
  // 旧的 GitHub 回复：giscus 撤掉后不再增长，这些是构建期快照。
  // 折起来放着 —— 既不丢历史，也不挡着新的评论区。
  const legacyBlock = comments.length
    ? `    <details class="replies__old">\n      <summary>旧的 GitHub 回复（${comments.length}）</summary>\n${staticReplies}\n    </details>\n`
    : '';
  const body = `  <header class="tbar tbar--act">
    <a class="tbar__back" href="../../" aria-label="返回话题列表"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></a>
    <div class="tbar__label">帖子</div>
    <div class="tbar__right">
      <button class="tbar__more" id="more" type="button" aria-label="更多操作" aria-haspopup="menu" aria-expanded="false" hidden>${ICON_MORE}</button>
      <div class="tbar__menu" id="menu" role="menu" hidden><button type="button" role="menuitem" data-act="del">删除帖子</button></div>
    </div>
  </header>
  <article class="post">
    <h1 class="post__title">${esc(d.title)}</h1>
    <div class="post__meta">
      ${avatar(d.author, 24)}
      ${authorLabel(d)}
      <time datetime="${esc(d.createdAt)}">${esc(fmtDate(d.createdAt))}</time>
    </div>
    <div class="md post__body">${sanitize(stripWebByline(d.bodyHTML))}</div>
  </article>
  <section class="replies">
${legacyBlock}    <div data-zcomments="${esc(threadKey)}"></div>
  </section>
  <div class="confirm" id="cf" hidden>
    <div class="confirm__box" role="dialog" aria-modal="true" aria-labelledby="cf__t">
      <h2 id="cf__t">删除这篇帖子？</h2>
      <p>删掉就没了，GitHub 上的讨论也会一起消失。</p>
      <p class="confirm__err" id="cf__err" hidden></p>
      <div class="confirm__foot">
        <button class="btn btn--ghost" id="cf__no" type="button">再想想</button>
        <button class="btn btn--danger" id="cf__yes" type="button">删除</button>
      </div>
    </div>
  </div>
`;
  return shell({
    title: `${d.title} — ${SITE.name}`,
    description: truncate(bodyText(d), 140),
    body,
    base: '../../',
    pageClass: 'page-thread',
    script: `${threadOwnerScript(d)}\n<script src="../../assets/zsocial.js" defer></script>`,
    fab: false,   // 帖子页不要发布悬浮球
    nav: false,   // 底部栏只在首页和「我的」挂，别的页面不挂
  });
}

/**
 * 帖子页右上角的 3 点菜单：只有「删除帖子」，且只有作者本人看得到。
 * 页面是静态的，作者在构建期就知道；访客身份只能到浏览器里问 /api/me，
 * 所以按钮默认 hidden，核对通过才显示 —— 未登录的人连按钮都看不见。
 * 删帖走 Worker，作者核对也在 Worker 里再做一次（前端藏按钮只是障眼法）。
 */
function threadOwnerScript(d) {
  const apiBase = apiBaseOf(SITE.post);
  const author = String(d.author?.login || '').toLowerCase();
  const n = Number(d.number) || 0;
  if (!apiBase || !author || !n) return '';
  return `<script>
(function () {
  var API = ${JSON.stringify(apiBase)};
  var N = ${n};
  var AUTHOR = ${JSON.stringify(author)};
  var KEY = 'zbforum_sess';
  var S = '';
  try { S = localStorage.getItem(KEY) || ''; } catch (e) { S = ''; }
  if (location.hash.indexOf('#s=') === 0) {
    S = location.hash.slice(3);
    try { localStorage.setItem(KEY, S); } catch (e) {}
    history.replaceState(null, '', location.pathname + location.search);
  }

  var more = document.getElementById('more');
  var menu = document.getElementById('menu');
  var cf = document.getElementById('cf');
  var err = document.getElementById('cf__err');
  var yes = document.getElementById('cf__yes');
  if (!more || !menu || !cf || !S) return;

  function closeMenu() {
    menu.hidden = true;
    more.setAttribute('aria-expanded', 'false');
  }

  fetch(API + '/api/me', { headers: { Authorization: 'Bearer ' + S } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.login || String(d.login).toLowerCase() !== AUTHOR) return;
      more.hidden = false;
    })
    .catch(function () {});

  more.addEventListener('click', function (e) {
    e.stopPropagation();
    var open = menu.hidden;
    menu.hidden = !open;
    more.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.addEventListener('click', closeMenu);
  menu.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('button[data-act="del"]') : null;
    if (!btn) return;
    closeMenu();
    cf.hidden = false;
  });
  document.getElementById('cf__no').addEventListener('click', function () { cf.hidden = true; });
  yes.addEventListener('click', function () {
    yes.disabled = true;
    yes.textContent = '正在删除…';
    err.hidden = true;
    fetch(API + '/delete-post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S },
      body: JSON.stringify({ numbers: [N] })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        var d = res.d || {};
        if ((d.deleted || []).indexOf(N) !== -1) { location.href = '../../'; return; }
        var msg = (d.failed && d.failed[0] && d.failed[0].error) || d.error || '删除失败，请稍后再试';
        err.textContent = msg;
        err.hidden = false;
        yes.disabled = false;
        yes.textContent = '重试';
      })
      .catch(function () {
        err.textContent = '网络不好，删除没发出去';
        err.hidden = false;
        yes.disabled = false;
        yes.textContent = '重试';
      });
  });
})();
</script>`;
}

/**
 * 站点配置里的 post.api 是基址；万一被写成完整端点（历史上是 .../new-post），
 * 这里也兜住。**必须在构建期算好**：页内脚本是模板字符串，`\/` 会被当成转义
 * 退化成 `/`，带反斜杠的正则写进模板会静默产生 `//...` 注释，整个脚本语法错死掉
 * （有产物自检兜着，但别去踩）。
 */
function apiBaseOf(p) {
  try {
    const u = new URL(p.api);
    let path = u.pathname;
    while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    if (path === '/new-post' || path === '/api') path = '';
    return u.origin + (path === '/' ? '' : path);
  } catch {
    return String(p.api || '');
  }
}

/**
 * 发新帖页。写权限在 Cloudflare Worker 那边（forum-api.zbgame.bid），
 * 本站依然是纯静态，页面里没有任何凭据。
 * 发帖必须先登录 GitHub（站内 OAuth，会话号放在 URL 片段里，Cookie 带不过去）。
 */
function renderCompose() {
  const p = SITE.post;
  const ready = Boolean(p?.api);
  // 这个页面在 /post/ 下，相对深度和 /t/<编号>/ 不同：
  // 少写一个 base 就会去 /post/assets/style.css 找样式（不存在）→ 页面裸奔。
  const base = '../';
  if (!ready) {
    return shell({
      title: `发新帖 — ${SITE.name}`,
      description: '去 GitHub 发新帖',
      base,
      bare: true,   // 发帖页不要全站顶栏（同帖子页）：返回走页内的「← 全部话题」
      body: `  <section class="empty">
    <h1>页内发帖还没接线</h1>
    <p>本站暂时只能跳到 GitHub 发帖。</p>
    <a class="btn" href="${DISCUSS_URL}" target="_blank" rel="noopener">去 GitHub 发帖</a>
  </section>`,
    });
  }
  const body = `  <header class="tbar">
    <a class="tbar__back" href="../" aria-label="返回话题列表"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></a>
    <div class="tbar__label">发布帖子</div>
  </header>
  <section class="compose">
    <p class="compose__sub">发帖要先用 GitHub 账号登录（跟评论区一样）。发布后几分钟内就会出现在首页。</p>
    <div class="gate" id="gate">
      <p>发帖要先用 GitHub 账号登录 —— 登录后回来这页就能写了。</p>
      <a class="btn" id="login">用 GitHub 登录</a>
    </div>
    <div class="who" id="who" hidden>
      <img id="who__av" alt="" width="26" height="26">
      <span>已登录为 <b id="who__name"></b></span>
      <button class="who__out" id="who__out" type="button">退出</button>
    </div>
    <form id="postform" class="form" novalidate hidden>
      <label class="field">
        <span class="field__label">标题</span>
        <input id="title" name="title" type="text" maxlength="120" placeholder="一句话说清楚你要问什么">
      </label>
      <label class="field">
        <span class="field__label">正文</span>
        <textarea id="body" name="body" rows="10" placeholder="支持 Markdown。写得越具体，越容易被答上。"></textarea>
      </label>
      <div class="form__foot">
        <button class="btn" id="submit" type="submit">发布</button>
        <span class="form__note" id="note" role="status" aria-live="polite"></span>
      </div>
    </form>
    <div class="done" id="done" hidden>
      <h2>发出去了 ✅</h2>
      <p id="done__text"></p>
      <p class="done__links">
        <a class="btn btn--ghost" href="../">回论坛首页</a>
      </p>
      <p class="empty__hint">首页要等站点完成重建才会出现这条（通常几分钟）。</p>
    </div>
  </section>`;
  const apiBase = apiBaseOf(p);
  const script = `<script>
(function () {
  var API = ${JSON.stringify(apiBase)};
  var KEY = 'zbforum_sess';
  var S = '';
  try { S = localStorage.getItem(KEY) || ''; } catch (e) { S = ''; }

  // 登录回调把会话号放在 URL 片段里带回来；片段不发给服务器、也不进 Referer
  if (location.hash.indexOf('#s=') === 0) {
    S = location.hash.slice(3);
    try { localStorage.setItem(KEY, S); } catch (e) {}
    history.replaceState(null, '', location.pathname + location.search);
  }

  var gate = document.getElementById('gate');
  var who = document.getElementById('who');
  var form = document.getElementById('postform');
  var note = document.getElementById('note');
  var btn = document.getElementById('submit');
  function setNote(t) { if (note) note.textContent = t; }
  function forget() { try { localStorage.removeItem(KEY); } catch (e) {} S = ''; }
  function showGuest() { gate.hidden = false; who.hidden = true; form.hidden = true; }
  function showUser(login, avatar) {
    gate.hidden = true; who.hidden = false; form.hidden = false;
    document.getElementById('who__name').textContent = '@' + login;
    var av = document.getElementById('who__av');
    if (avatar) { av.src = avatar; } else { av.hidden = true; }
  }

  if (S) {
    fetch(API + '/api/me', { headers: { Authorization: 'Bearer ' + S } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.login) { showUser(d.login, d.avatar); }
        else { forget(); showGuest(); }
      })
      .catch(function () { showGuest(); });
  } else {
    showGuest();
  }

  document.getElementById('login').addEventListener('click', function () {
    var back = location.origin + location.pathname;
    location.href = API + '/auth/login?return=' + encodeURIComponent(back);
  });

  document.getElementById('who__out').addEventListener('click', function () {
    fetch(API + '/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + S } })
      .then(function () { forget(); location.reload(); });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var title = document.getElementById('title').value.trim();
    var body = document.getElementById('body').value.trim();
    if (title.length < 4) return setNote('标题至少 4 个字');
    if (body.length < 8) return setNote('正文再写长一点点');
    btn.disabled = true;
    setNote('正在发布…');
    fetch(API + '/new-post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S },
      body: JSON.stringify({ title: title, body: body })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.d || !res.d.ok) {
          if (res.d && /登录/.test(res.d.error || '')) { forget(); showGuest(); }
          throw new Error((res.d && res.d.error) || '发布失败');
        }
        document.getElementById('done__text').textContent = '《' + title + '》已经建好了。';
        form.hidden = true; who.hidden = true;
        document.getElementById('done').hidden = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      })
      .catch(function (err) { setNote(err.message || '发布失败，稍后再试'); })
      .then(function () { btn.disabled = false; });
  });
})();
</script>`;
  return shell({
    title: `发新帖 — ${SITE.name}`,
    description: '用 GitHub 账号登录后在本站发新帖',
    body,
    base,
    pageClass: 'page-compose',
    script,
    fab: false,
    bare: true,   // 发帖页不要全站顶栏（同帖子页）
    nav: false,   // 发帖页也不挂底部栏：专心写东西
  });
}

/**
 * 「我的」页：第一行大头像 + GitHub 用户名，第二行「我的发帖」入口。
 * 站点依然是纯静态 —— 这里只有 API 地址和会话号，凭据都在 Worker 那边。
 */
/**
 * Android App 的元信息（data/app.json）。
 *
 * APK 文件本身放在仓库的 download/ 下，由 GitHub Pages 直接发 —— 刻意**不**放在那台
 * 服务器的域名里（用户明确要求）。构建不会碰 download/，这里只读元信息渲染下载页。
 */
function loadApp() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'data', 'app.json'), 'utf8'));
  } catch {
    return null;
  }
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return '';
  return n < 1024 * 1024
    ? (n / 1024).toFixed(0) + ' KB'
    : (n / 1024 / 1024).toFixed(1) + ' MB';
}

/**
 * 下载页（/app/）：原生 Android 客户端的安装包。
 *
 * 跟「装到手机桌面」是两个不同的东西，别搞乱：
 *   · 这里给的是真 APK（原生 View 调的接口，不是 WebView 套壳）
 *   · PWA 那个入口在 /me/，不用装包，iOS 也能用
 */
function renderDownload() {
  const a = loadApp();
  const base = '../';
  const file = a?.file || '';
  const size = fmtSize(a?.size);
  const btn = file
    ? `<a class="btn" href="${esc(file)}" download>下载 APK${size ? `（${esc(size)}）` : ''}</a>`
    : '<span class="btn" style="opacity:.5">安装包还在打包中</span>';
  const meta = a
    ? `版本 ${esc(a.version || '—')} · ${esc(a.updated || '')}${a.minSdk ? ` · 需要 Android ${esc(String(a.minSdk))}+` : ''}`
    : '还没做好，过阵子再来。';
  const notes = a?.notes
    ? `<section class="done">
    <h2>这一版有什么</h2>
    <p>${esc(a.notes)}</p>
  </section>
`
    : '';
  const sum = a?.sha256
    ? `    <p class="note">文件校验（SHA-256）：<code style="word-break:break-all">${esc(a.sha256)}</code></p>\n`
    : '';
  const body = `  <section class="empty" style="padding-top:18px">
    <img class="empty__art" src="${base}assets/icons/icon-192.png" width="112" height="112" alt="App 图标" style="border-radius:26px">
    <h1>下载 Android App</h1>
    <p>原生客户端：看帖、回帖、登录注册都在手机上，不是网页套壳。</p>
    ${btn}
    <p class="empty__hint">${meta}</p>
  </section>
${notes}  <section class="done">
    <h2>怎么装</h2>
    <p>1. 点上面的按钮，把 .apk 文件下载到手机。</p>
    <p>2. 手机会拦一下「不允许安装未知来源的应用」—— 去设置里给浏览器开一次权限。</p>
    <p>3. 装完打开就能用，登录直接用你论坛那个邮箱账号。</p>
${sum}  </section>
  <section class="done" style="margin-top:16px">
    <h2>不想装包？</h2>
    <p>也可以把网页版装到手机桌面（iOS 也能用）：打开 <a href="${base}me/">我的</a> 页，点「安装到手机桌面」。</p>
  </section>`;
  return shell({
    title: `下载 Android App — ${SITE.name}`,
    description: '主播模拟器mod 的原生 Android 客户端安装包下载',
    body,
    base,
    pageClass: 'page-download',
    bare: true,
    fab: false,
    navOn: 'me',
  });
}

function renderMe() {
  const p = SITE.post;
  const base = '../';
  const apiBase = apiBaseOf(p);
  const body = `  <section class="me">
    <div class="gate" id="gate">
      <p>用 GitHub 账号登录后，这里能看到你自己的帖子。</p>
      <a class="btn" id="login">用 GitHub 登录</a>
      <a class="btn btn--ghost" href="../login/">用邮箱登录 / 注册</a>
    </div>
    <div id="mebody" hidden>
      <div class="me__id">
        <img class="me__avatar" id="me__av" alt="" width="64" height="64">
        <b class="me__name" id="me__name"></b>
      </div>
      <a class="me__row" href="posts/">
        <span>我的发帖</span>
        <span class="me__chev" aria-hidden="true">›</span>
      </a>
      <a class="me__row" id="me__admin" href="../admin/" hidden>
        <span>管理面板</span>
        <span class="me__chev" aria-hidden="true">›</span>
      </a>
      <p class="me__foot"><button class="me__out" id="out" type="button">退出登录</button></p>
    </div>
    <div class="me__extra">
      <a class="me__row" href="../app/">
        <span>下载 Android App</span>
        <span class="me__chev" aria-hidden="true">›</span>
      </a>
      <button class="me__row me__row--btn" id="me__install" type="button" hidden>
        <span>安装到手机桌面</span>
        <span class="me__chev" aria-hidden="true">›</span>
      </button>
    </div>
  </section>`;
  const script = `<script>
(function () {
  var API = ${JSON.stringify(apiBase)};
  var KEY = 'zbforum_sess';
  var S = '';
  try { S = localStorage.getItem(KEY) || ''; } catch (e) { S = ''; }
  // 登录回调把会话号放在 URL 片段里带回来（片段不发给服务器、也不进 Referer）
  if (location.hash.indexOf('#s=') === 0) {
    S = location.hash.slice(3);
    try { localStorage.setItem(KEY, S); } catch (e) {}
    history.replaceState(null, '', location.pathname + location.search);
  }
  var gate = document.getElementById('gate');
  var mebody = document.getElementById('mebody');
  function forget() { try { localStorage.removeItem(KEY); } catch (e) {} S = ''; }
  function guest() { gate.hidden = false; mebody.hidden = true; }

  // 「安装到手机桌面」：Android/Chrome 会发 beforeinstallprompt，抓住就能一键装；
  // iOS 没这套 API，只能把菜单路径告诉人。已经装好的（standalone）不显示入口。
  var installBtn = document.getElementById('me__install');
  var bip = null;
  var installed = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (installBtn && !installed && isIOS) installBtn.hidden = false;
  addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    bip = e;
    if (installBtn && !installed) installBtn.hidden = false;
  });
  if (installBtn) {
    installBtn.addEventListener('click', function () {
      if (!bip) {
        alert('在 iPhone 上：点底部的「分享」按钮 → 选「添加到主屏幕」。');
        return;
      }
      bip.prompt();
      bip.userChoice.then(function () { bip = null; installBtn.hidden = true; });
    });
  }
  function show(d) {
    gate.hidden = true;
    mebody.hidden = false;
    document.getElementById('me__name').textContent = '@' + d.login;
    if (d.role === 'admin') { document.getElementById('me__admin').hidden = false; }
    var av = document.getElementById('me__av');
    if (d.avatar) { av.src = d.avatar; } else { av.hidden = true; }
  }
  document.getElementById('login').addEventListener('click', function () {
    location.href = API + '/auth/login?return=' + encodeURIComponent(location.origin + location.pathname);
  });
  document.getElementById('out').addEventListener('click', function () {
    fetch(API + '/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + S } })
      .then(function () { forget(); location.reload(); })
      .catch(function () { forget(); location.reload(); });
  });
  if (!S) { guest(); return; }
  fetch(API + '/api/me', { headers: { Authorization: 'Bearer ' + S } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d && d.login) { show(d); } else { forget(); guest(); } })
    .catch(guest);
})();
</script>`;
  return shell({
    title: `我的 — ${SITE.name}`,
    description: '你的 GitHub 账号，以及你发过的帖子',
    body,
    base,
    pageClass: 'page-me',
    script,
    bare: true,
    fab: false,   // 「我的」页不放发布悬浮球：这里只管自己发过的东西
    navOn: 'me',
  });
}

/**
 * 「我的发帖」页：标题栏（← / 我的发帖 / 多选删除）+ 自己的帖子卡片。
 * 卡片右上角有 3 点菜单（只有「删除帖子」）；点「多选删除」进勾选模式批量删。
 * 删除走 Worker，用登录者自己的 token，并在 Worker 里核对作者 —— 只能删自己的。
 */
function renderMyPosts() {
  const p = SITE.post;
  const base = '../../';
  const apiBase = apiBaseOf(p);
  const body = `  <header class="tbar tbar--act">
    <a class="tbar__back" href="../" aria-label="返回">${ICON_BACK}</a>
    <div class="tbar__label">我的发帖</div>
    <div class="tbar__right" id="right">
      <button class="tbar__act" id="sel" type="button">多选删除</button>
    </div>
  </header>
  <div class="gate" id="gate">
    <p>用 GitHub 账号登录后，这里能管理你自己的帖子。</p>
    <a class="btn" id="login">用 GitHub 登录</a>
  </div>
  <p class="note" id="note" role="status" aria-live="polite" hidden></p>
  <div class="list" id="list" hidden></div>
  <section class="empty" id="empty" hidden>
    <p>你还没发过帖子。</p>
    <a class="btn" href="${base}post/">去发第一帖</a>
  </section>
  <div class="confirm" id="cf" hidden>
    <div class="confirm__box" role="dialog" aria-modal="true" aria-labelledby="cf__t">
      <h2 id="cf__t">删除这篇帖子？</h2>
      <p>删掉就没了，GitHub 上的讨论也会一起消失。</p>
      <div class="confirm__foot">
        <button class="btn btn--ghost" id="cf__no" type="button">再想想</button>
        <button class="btn btn--danger" id="cf__yes" type="button">删除</button>
      </div>
    </div>
  </div>`;
  const script = `<script>
(function () {
  var API = ${JSON.stringify(apiBase)};
  var KEY = 'zbforum_sess';
  var S = '';
  try { S = localStorage.getItem(KEY) || ''; } catch (e) { S = ''; }
  if (location.hash.indexOf('#s=') === 0) {
    S = location.hash.slice(3);
    try { localStorage.setItem(KEY, S); } catch (e) {}
    history.replaceState(null, '', location.pathname + location.search);
  }

  var gate = document.getElementById('gate');
  var list = document.getElementById('list');
  var empty = document.getElementById('empty');
  var note = document.getElementById('note');
  var right = document.getElementById('right');
  var cf = document.getElementById('cf');
  var posts = [];
  var picking = false;
  var picked = {};
  var pending = [];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function forget() { try { localStorage.removeItem(KEY); } catch (e) {} S = ''; }
  function setNote(t, bad) {
    note.textContent = t || '';
    note.hidden = !t;
    note.className = bad ? 'note note--bad' : 'note';
  }
  function ago(ms) {
    var m = Math.round((Date.now() - ms) / 60000);
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
  function when(ms) {
    try {
      return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
    } catch (e) { return new Date(ms).toLocaleString(); }
  }
  // 卡片结构跟首页话题行一致；整行本身就是链接，右上角按钮必须是它的兄弟节点
  //（链接里再嵌链接会被 HTML 解析器截断，构建期有 assertNoNestedAnchors 兜着。
  //  注意别在这里写尖括号的锚点例子 —— 那段检查会连注释一起扫，会误报）
  function card(p) {
    var ts = p.us || p.ts || Date.now();
    return '<div class="ownrow" data-n="' + p.n + '">'
      + '<a class="thread" href="../../t/' + p.n + '/">'
      + '<h2 class="thread__title">' + esc(p.t) + '</h2>'
      + (p.x ? '<p class="thread__excerpt">' + esc(p.x) + '</p>' : '')
      + '<div class="thread__meta"><span>我</span><time title="' + esc(when(ts)) + '">' + ago(ts) + '</time></div>'
      + '</a>'
      + '<button class="ownrow__more" type="button" aria-label="更多操作" aria-haspopup="menu" aria-expanded="false">${ICON_MORE}</button>'
      + '<span class="ownrow__check" aria-hidden="true"></span>'
      + '<div class="ownrow__menu" role="menu" hidden><button type="button" role="menuitem" data-act="del">删除帖子</button></div>'
      + '</div>';
  }
  function render() {
    list.innerHTML = posts.map(card).join('');
    list.hidden = posts.length === 0;
    empty.hidden = posts.length > 0;
  }
  function closeMenus() {
    Array.prototype.forEach.call(document.querySelectorAll('.ownrow__menu'), function (m) { m.hidden = true; });
    Array.prototype.forEach.call(document.querySelectorAll('.ownrow__more'), function (b) { b.setAttribute('aria-expanded', 'false'); });
  }
  function paintSel() {
    var n = Object.keys(picked).length;
    Array.prototype.forEach.call(list.querySelectorAll('.ownrow'), function (row) {
      row.classList.toggle('is-picked', !!picked[row.dataset.n]);
    });
    var go = document.getElementById('go');
    if (go) { go.disabled = n === 0; go.textContent = n ? '删除 ' + n : '删除'; }
  }
  function setMode(on) {
    picking = on;
    picked = {};
    list.classList.toggle('is-picking', on);
    closeMenus();
    right.innerHTML = on
      ? '<button class="tbar__act" id="cancel" type="button">取消</button><button class="tbar__act tbar__act--go" id="go" type="button" disabled>删除</button>'
      : '<button class="tbar__act" id="sel" type="button">多选删除</button>';
    paintSel();
  }
  function guest() {
    gate.hidden = false;
    list.hidden = true;
    empty.hidden = true;
    right.hidden = true;
  }
  function askDelete(nums) {
    pending = nums;
    document.getElementById('cf__t').textContent = nums.length > 1 ? '删除这 ' + nums.length + ' 篇帖子？' : '删除这篇帖子？';
    cf.hidden = false;
  }
  function doDelete() {
    cf.hidden = true;
    document.getElementById('cf__yes').disabled = true;
    setNote('正在删除…');
    fetch(API + '/delete-post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S },
      body: JSON.stringify({ numbers: pending })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        var d = res.d || {};
        var gone = d.deleted || [];
        var bad = d.failed || [];
        if (!gone.length) {
          var msg = (bad[0] && bad[0].error) || d.error || '删除失败';
          throw new Error(msg);
        }
        posts = posts.filter(function (p) { return gone.indexOf(p.n) === -1; });
        render();
        setMode(false);
        setNote(gone.length + ' 篇已删除' + (bad.length ? '，' + bad.length + ' 篇没删掉：' + (bad[0].error || '') : ''), bad.length > 0);
      })
      .catch(function (err) { setNote(err.message || '删除失败，稍后再试', true); })
      .then(function () { document.getElementById('cf__yes').disabled = false; });
  }

  document.getElementById('login').addEventListener('click', function () {
    location.href = API + '/auth/login?return=' + encodeURIComponent(location.origin + location.pathname);
  });
  right.addEventListener('click', function (e) {
    var b = e.target;
    while (b && b !== right && b.tagName !== 'BUTTON') b = b.parentNode;
    if (!b || b.tagName !== 'BUTTON') return;
    if (b.id === 'sel') { setMode(true); }
    else if (b.id === 'cancel') { setMode(false); }
    else if (b.id === 'go') {
      var nums = Object.keys(picked).map(Number);
      if (nums.length) askDelete(nums);
    }
  });
  list.addEventListener('click', function (e) {
    var row = e.target;
    while (row && row !== list && !(row.classList && row.classList.contains('ownrow'))) row = row.parentNode;
    if (!row || row === list) return;
    var act = e.target.getAttribute && e.target.getAttribute('data-act');
    if (act === 'del') { e.preventDefault(); askDelete([Number(row.dataset.n)]); return; }
    if (e.target.classList && e.target.classList.contains('ownrow__more')) {
      e.preventDefault();
      var m = row.querySelector('.ownrow__menu');
      var wasHidden = m.hidden;
      closeMenus();
      m.hidden = !wasHidden;
      e.target.setAttribute('aria-expanded', wasHidden ? 'true' : 'false');
      return;
    }
    if (picking) {
      e.preventDefault();
      var n = row.dataset.n;
      if (picked[n]) { delete picked[n]; } else { picked[n] = 1; }
      paintSel();
    }
  });
  document.addEventListener('click', function (e) {
    if (!(e.target.closest && e.target.closest('.ownrow'))) closeMenus();
  });
  document.getElementById('cf__no').addEventListener('click', function () { cf.hidden = true; pending = []; });
  document.getElementById('cf__yes').addEventListener('click', doDelete);
  cf.addEventListener('click', function (e) { if (e.target === cf) { cf.hidden = true; pending = []; } });

  if (!S) { guest(); return; }
  fetch(API + '/my-posts', { headers: { Authorization: 'Bearer ' + S } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.ok) { forget(); guest(); return; }
      gate.hidden = true;
      right.hidden = false;
      posts = d.posts || [];
      render();
    })
    .catch(guest);
})();
</script>`;
  return shell({
    title: `我的发帖 — ${SITE.name}`,
    description: '管理你自己发过的帖子',
    body,
    base,
    pageClass: 'page-myposts',
    script,
    bare: true,
    fab: false,
    navOn: 'me',
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
    nav: false,   // 搜索页也不挂底部栏
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
  // 404 什么都不挂：连站点头部也不要（深链下相对路径本来就不可靠），
  // 页面里自带的「回到论坛首页」已经够指路了。
  return shell({ title: `页面不存在 — ${SITE.name}`, description: '404', body, nav: false, bare: true, fab: false });
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

/**
 * 内联脚本自检：产物里每一段 <script>…</script>（不含 src 外链）都必须能过 JS 解析器。
 *
 * 防的是「模板字面量吞转义」这类静默事故：源码里写
 *   replace(/\/(new-post|api)\/?$/, '')
 * 模板字符串会把 `\/` 退化成 `/`，产物变成
 *   replace(//(new-post|api)/?$/, '')
 * `//` 起注释，整段脚本语法错误、页面上所有按钮失灵 —— 而 grep 产物完全看不出来
 * （历史事故：commit f9963f9）。所以这里不靠 grep，直接交给解析器。
 */
const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function inlineScripts(html) {
  const out = [];
  SCRIPT_BLOCK.lastIndex = 0;
  let m;
  while ((m = SCRIPT_BLOCK.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(m[1])) continue; // 外链脚本，不归我们解析
    if (!m[2].trim()) continue;
    out.push(m[2]);
  }
  return out;
}

/** 报错时只贴出错行附近几行，别把整段脚本糊到 CI 日志里 */
function codeExcerpt(code, line) {
  const lines = code.split('\n');
  const at = Number(line) >= 1 ? Number(line) : 1;
  const start = Math.max(1, at - 3);
  const end = Math.min(lines.length, at + 3);
  const out = [];
  for (let i = start; i <= end; i++) {
    out.push(`      ${String(i).padStart(4)} |${i === at ? '>>' : '  '} ${lines[i - 1]}`);
  }
  return `    出错片段（该段共 ${lines.length} 行）：\n${out.join('\n')}`;
}

function assertInlineScriptsParse(html, label) {
  const blocks = inlineScripts(html);
  blocks.forEach((code, i) => {
    const where = `${label} 内联 <script> #${i + 1}`;

    // ① 先扫一眼就假的残骸（高准确率，能直接指到出错的哪一行）
    const wreck = /(?<!:)\/\/\(/.exec(code);
    if (wreck) {
      const line = code.slice(0, wreck.index).split('\n').length;
      throw new Error(
        `${where} 出现注释残骸 "//("：正则里的 \\/ 被模板字面量吃掉了（\\/ 等价于 /）。\n` +
          `    把带反斜杠的逻辑挪到模板外先算好（参考 renderCompose 里 apiBase 的写法）。\n` +
          codeExcerpt(code, line)
      );
    }
    const trail = /\\[ \t]*\r?\n/.exec(code);
    if (trail) {
      const line = code.slice(0, trail.index).split('\n').length;
      throw new Error(
        `${where} 出现行尾裸反斜杠（残留转义），检查模板字面量里的反斜杠。\n` +
          codeExcerpt(code, line)
      );
    }

    // ② 硬性检查：能解析。失败即构建失败。
    try {
      new vm.Script(code, { filename: where });
    } catch (err) {
      const line = /(\d+)\s*$/.exec((err.stack || '').split('\n')[0] || '')?.[1];
      throw new Error(
        `${where} 无法解析（语法错误）：${err.message}\n` +
          `    模板字面量里的 \\/ 等价于 /，写进 <script> 就变成注释。请把带反斜杠的逻辑\n` +
          `    挪到模板外先算好（参考 renderCompose 里 apiBase 的写法）。\n` +
          codeExcerpt(code, line)
      );
    }
  });
  return blocks.length;
}

/** 构建收尾：把落盘的产物再读回来过一遍，确认写出来的东西是好的 */
function verifyGeneratedPages() {
  let scripts = 0;
  for (const rel of pages) {
    const html = readFileSync(join(ROOT, rel), 'utf8');
    assertNoNestedAnchors(html, rel);
    scripts += assertInlineScriptsParse(html, rel);
  }
  return scripts;
}

const pages = [];

/* ── 邮箱账号 / 管理面板（2026-09-21 加）──────────────────────────
 * 这三个页面的逻辑都走 /assets/zsocial.js（会话号存 localStorage 的 'zbforum_sess'，
 * 跟 /me/、/post/ 共用），所以登录一次全站都认。
 */

function renderLogin() {
  const base = '../';
  const body = `  <section class="auth">
    <h1 class="auth__t">用邮箱登录</h1>
    <p class="auth__sub">还没有账号？<a href="${base}register/">去注册一个</a>（不需要 GitHub）。</p>
    <div class="form">
      <label class="field"><span>邮箱</span><input id="e" type="email" autocomplete="email" placeholder="you@example.com"></label>
      <label class="field"><span>密码</span><input id="p" type="password" autocomplete="current-password" placeholder="你的密码"></label>
      <button class="btn" id="go" type="button">登录</button>
      <a class="btn btn--ghost" href="${base}me/">改用 GitHub 登录</a>
    </div>
    <p class="note" id="note" role="status" aria-live="polite"></p>
  </section>`;
  const script = `<script src="${base}assets/zsocial.js"></script>
<script>
(function () {
  var note = document.getElementById('note');
  var go = document.getElementById('go');
  var back = new URLSearchParams(location.search).get('return') || '/me/';
  if (back.charAt(0) !== '/') back = '/me/';
  function submit() {
    note.textContent = '';
    go.disabled = true;
    ZB.login(document.getElementById('e').value.trim(), document.getElementById('p').value)
      .then(function () { location.href = back; }, function (err) {
        note.textContent = err.message;
        go.disabled = false;
      });
  }
  go.addEventListener('click', submit);
  document.getElementById('p').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') submit(); });
})();
</script>`;
  return shell({
    title: `登录 — ${SITE.name}`,
    description: '用邮箱账号登录',
    body,
    base,
    pageClass: 'page-auth',
    script,
    bare: true,
    fab: false,
    navOn: 'me',
  });
}

function renderRegister() {
  const base = '../';
  const body = `  <section class="auth">
    <h1 class="auth__t">注册</h1>
    <p class="auth__sub">填个邮箱和昵称就能用。已经有账号了？<a href="${base}login/">去登录</a>。</p>
    <div class="form">
      <label class="field"><span>邮箱</span><input id="e" type="email" autocomplete="email" placeholder="you@example.com"></label>
      <label class="field"><span>昵称</span><input id="n" type="text" autocomplete="nickname" placeholder="2-20 个字，中英文都行"></label>
      <label class="field"><span>密码</span><input id="p" type="password" autocomplete="new-password" placeholder="至少 8 位"></label>
      <button class="btn" id="go" type="button">注册并登录</button>
      <a class="btn btn--ghost" href="${base}me/">用 GitHub 登录</a>
    </div>
    <p class="note" id="note" role="status" aria-live="polite"></p>
    <p class="auth__sub" style="margin-top:16px">暂时没有邮箱验证和找回密码 —— 密码自己记牢。</p>
  </section>`;
  const script = `<script src="${base}assets/zsocial.js"></script>
<script>
(function () {
  var note = document.getElementById('note');
  var go = document.getElementById('go');
  function submit() {
    note.textContent = '';
    go.disabled = true;
    ZB.register(
      document.getElementById('e').value.trim(),
      document.getElementById('n').value.trim(),
      document.getElementById('p').value
    ).then(function () { location.href = '/me/'; }, function (err) {
      note.textContent = err.message;
      go.disabled = false;
    });
  }
  go.addEventListener('click', submit);
  document.getElementById('p').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') submit(); });
})();
</script>`;
  return shell({
    title: `注册 — ${SITE.name}`,
    description: '注册一个站内账号',
    body,
    base,
    pageClass: 'page-auth',
    script,
    bare: true,
    fab: false,
    navOn: 'me',
  });
}

function renderAdmin() {
  const base = '../';
  const body = `  <section class="admin">
    <h1 class="auth__t">管理面板</h1>
    <p class="note" id="note" role="status" aria-live="polite">正在确认身份…</p>
    <div id="deny" hidden>
      <p class="auth__sub" id="denytxt">这里只有管理员能看。</p>
      <a class="btn" href="${base}login/?return=%2Fadmin%2F">去登录</a>
    </div>
    <div id="panel" hidden>
      <div class="stats" id="stats"></div>
      <h2 class="admin__h">用户 <span id="un"></span></h2>
      <div id="users"></div>
      <h2 class="admin__h">最近的评论</h2>
      <div id="cmts"></div>
    </div>
  </section>`;
  const script = `<script src="${base}assets/zsocial.js"></script>
<script>
(function () {
  var note = document.getElementById('note');
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function when(ts) {
    var d = new Date(Number(ts) || 0);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function draw(d) {
    document.getElementById('stats').innerHTML =
      '<div class="stat"><b>' + d.users.length + '</b><span>注册用户</span></div>' +
      '<div class="stat"><b>' + d.threads + '</b><span>有评论的位置</span></div>' +
      '<div class="stat"><b>' + d.totalComments + '</b><span>评论总数</span></div>';
    document.getElementById('un').textContent = '(' + d.users.length + ')';
    document.getElementById('users').innerHTML = d.users.length ? d.users.map(function (u) {
      return '<div class="row"><span class="row__t">' + esc(u.n) + ' <i>' + esc(u.e) + '</i></span>' +
        '<span class="row__m">' + esc(when(u.ts)) + (u.r === 'admin' ? ' · 管理员' : '') + (u.b ? ' · 已封' : '') + '</span>' +
        '<button class="btn btn--ghost" data-ban="' + esc(u.e) + '" data-on="' + (u.b ? '0' : '1') + '">' + (u.b ? '解封' : '封号') + '</button></div>';
    }).join('') : '<p class="auth__sub">还没有人注册。</p>';
    document.getElementById('cmts').innerHTML = d.recent.length ? d.recent.map(function (c) {
      return '<div class="row"><span class="row__t">' + esc(c.n) + ' <i>' + esc(c.key) + '</i></span>' +
        '<span class="row__m">' + esc(String(c.b || '').slice(0, 90)) + ' · ' + esc(when(c.ts)) + '</span>' +
        '<button class="btn btn--ghost" data-del="' + esc(c.key) + '|' + esc(c.id) + '">删除</button></div>';
    }).join('') : '<p class="auth__sub">还没有评论。</p>';
  }
  function load() {
    ZB.adminSummary().then(function (d) {
      note.textContent = '';
      document.getElementById('panel').hidden = false;
      draw(d);
    }, function (err) {
      note.textContent = '';
      document.getElementById('deny').hidden = false;
      document.getElementById('denytxt').textContent =
        err.status === 401 ? '你还没登录。' : '这个账号不是管理员。';
    });
  }
  document.getElementById('users').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-ban]');
    if (!b) return;
    ZB.adminBan(b.getAttribute('data-ban'), b.getAttribute('data-on') === '1')
      .then(load, function (e) { note.textContent = e.message; });
  });
  document.getElementById('cmts').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-del]');
    if (!b) return;
    if (!window.confirm('删掉这条评论？')) return;
    var parts = b.getAttribute('data-del').split('|');
    ZB.adminRemoveComment(parts[0], parts[1]).then(load, function (e) { note.textContent = e.message; });
  });
  load();
})();
</script>`;
  return shell({
    title: `管理面板 — ${SITE.name}`,
    description: '站点管理：用户与评论',
    body,
    base,
    pageClass: 'page-admin',
    script,
    bare: true,
    fab: false,
    navOn: 'me',
  });
}

function writePage(relPath, html, label) {
  assertNoNestedAnchors(html, label || relPath);
  assertInlineScriptsParse(html, label || relPath);
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
  rmSync(join(ROOT, 'me'), { recursive: true, force: true });
  rmSync(join(ROOT, 'app'), { recursive: true, force: true });
  rmSync(join(ROOT, 'index.html'), { force: true });
  rmSync(join(ROOT, '404.html'), { force: true });

  writePage('index.html', renderIndex(discussions), 'index.html');
  for (const d of discussions) {
    writePage(join('t', String(d.number), 'index.html'), renderThread(d), `讨论 #${d.number}`);
  }
  writePage('404.html', render404(), '404.html');
  writePage(join('post', 'index.html'), renderCompose(), 'post/index.html');
  writePage(join('search', 'index.html'), renderSearch(discussions), 'search/index.html');
  writePage(join('me', 'index.html'), renderMe(), 'me/index.html');
  writePage(join('me', 'posts', 'index.html'), renderMyPosts(), 'me/posts/index.html');
  writePage(join('login', 'index.html'), renderLogin(), 'login/index.html');
  writePage(join('register', 'index.html'), renderRegister(), 'register/index.html');
  writePage(join('admin', 'index.html'), renderAdmin(), 'admin/index.html');
  writePage(join('app', 'index.html'), renderDownload(), 'app/index.html');
  // PWA 清单（图标是静态文件，这里只写清单）。放在根，作用域盖整个站点。
  writeFileSync(join(ROOT, 'manifest.webmanifest'), renderManifest());
  writeFileSync(join(ROOT, '.nojekyll'), '');
  mkdirSync(join(ROOT, 'assets'), { recursive: true });

  // 收尾自检：产物里任何一段内联 <script> 解析不了就非 0 退出，拦下这次推送/提交
  const scriptCount = verifyGeneratedPages();
  console.log(`✓ 自检通过：${pages.length} 个页面 / ${scriptCount} 段内联脚本全部可解析`);

  console.log(`✓ 生成 ${pages.length} 个页面（数据源：${source}）→ ${ROOT}`);
  if (source === 'sample') console.log('  （样例数据，线上不会被用到）');
}

main().catch((err) => {
  console.error('✗ 构建失败：', err.message);
  process.exit(1);
});
