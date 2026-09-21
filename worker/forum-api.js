/**
 * zbgamelt 论坛 · 发帖后端（Cloudflare Worker）
 *
 * 前端（GitHub Pages 上的静态站）把帖子发到这里。
 * 访客先用 GitHub 账号登录，Worker 拿**他自己的** token 调 GraphQL 建 Discussion ——
 * 所以帖子在 GitHub 那边的作者就是他本人，不是仓库主；写权限也从不落到浏览器。
 *
 * 会话怎么走（不用 Cookie：跨站 Cookie 现在基本被浏览器掐死了）：
 *   授权回调 → Worker 在 KV 建会话 → 302 跳回站点，会话号放在 URL 片段 `#s=…`
 *   （片段不会发给服务器、也不进 Referer）→ 站点把它存 localStorage，之后每次
 *   请求带 `Authorization: Bearer <会话号>`。用户的 GitHub token 只存在 KV 里。
 *
 * 需要绑定的变量（wrangler secret / dash 面板，不要写进代码）：
 *   GH_OAUTH_CLIENT_ID      OAuth App 的 Client ID
 *   GH_OAUTH_CLIENT_SECRET  OAuth App 的 Client secret
 *   GITHUB_TOKEN            （可选）机器人 token，只用来催站点重建
 *   ALLOW_ORIGIN            （可选）默认 https://zbgamelt.github.io
 * 需要绑定的 KV：
 *   RL   命名空间 forum-ratelimit：限流计数、登录 state、会话（sess: 前缀）
 *
 * 端点：
 *   GET  /health                存活探测
 *   GET  /auth/login?return=…   跳 GitHub 授权（return 只认白名单站点）
 *   GET  /auth/callback         GitHub 回调：换 token → 建会话 → 跳回站点
 *   POST /auth/logout           退出登录
 *   GET  /api/me                当前登录者 { login, avatar }
 *   GET  /my-posts              我发过的帖子（拿登录者自己的 token 查，只返回他本人的）
 *   POST /delete-post           删帖 { numbers:[…] }，只能删自己发的
 *   POST /new-post              发帖 { title, body }，需 Bearer 会话号
 *
 * 站内账号（2026-09-21 加，邮箱 + 密码，不依赖 GitHub）：
 *   POST /register             注册 { email, name, password } → 直接给会话号
 *   POST /login                登录 { email, password } → 会话号
 *   GET  /api/me               现在会带 role/kind，邮箱账号也认
 *
 * 评论（2026-09-21 加，博客文章与论坛帖子共用一套）：
 *   GET  /comments?p=<键>       读某处的评论（公开）
 *   POST /comment              发评论 { p, body }，需登录
 *   POST /comment/delete       删自己的评论 { p, id }
 *
 * 管理面板接口（只有 role=admin 能用）：
 *   GET  /admin/summary        用户 + 最近评论总览
 *   POST /admin/user           封 / 解封 { email, ban }
 *   POST /admin/comment-delete 删任意评论 { p, id }
 *
 * 数据都放 KV：
 *   u:<email> 用户记录 · un:<名字> 名字占用索引 · cmt:<键> 评论数组 · sess:<会话号>
 */

const REPO_ID = 'R_kgDOUiCTAQ';                     // zbgamelt/zbgamelt.github.io
const REPO_FULL = 'zbgamelt/zbgamelt.github.io';
const OWNER = REPO_FULL.split('/')[0];
const NAME = REPO_FULL.split('/')[1];
const BUILD_WORKFLOW = 'build.yml';
const CATEGORY_ID = 'DIC_kwDOUiCTAc4DF_c1';         // General
const DEFAULT_ORIGIN = 'https://zbgamelt.github.io';

const TITLE_MIN = 4, TITLE_MAX = 120;
const BODY_MIN = 8, BODY_MAX = 20000;
const COOLDOWN_SEC = 120;        // 同一 IP 两次发帖的最小间隔
const DAILY_CAP = 30;            // 每天最多新建多少帖（防灌水兜底）
const SESSION_TTL = 60 * 60 * 24 * 30;   // 登录状态保留 30 天
const STATE_TTL = 600;                    // 授权跳转的 state 有效期 10 分钟

/* ---------- 站内账号 / 评论 / 管理 的口径 ---------- */

// 谁是管理员：这里列 GitHub 登录名（小写）。
// 注意：光看 session 里的 r 字段不够 —— 老板早先登录拿到的会话里没有 r，
// 改完名单后它应该立刻生效，所以鉴权一律走 isAdmin()。
const ADMIN_LOGINS = ['zbgamelt', 'zbgame001'];

const PBKDF2_ITER = 100000;      // 密码哈希轮数（⚠️ Workers 的 WebCrypto 上限就是 10 万，写更大直接抛错）
const PW_MIN = 8;
const EMAIL_MAX = 120;
const COMMENT_MIN = 2;
const COMMENT_MAX = 2000;
const COMMENTS_PER_KEY = 300;    // 单个页面/帖子最多留多少条

const REG_PER_HOUR = 5;          // 每 IP 每小时注册上限
const LOGIN_TRIES = 10;          // 每 IP 每 15 分钟登录尝试上限
const LOGIN_WINDOW = 900;
const COMMENT_PER_10MIN = 20;    // 每 IP 每 10 分钟评论上限

const allowOrigin = (env) => env.ALLOW_ORIGIN || DEFAULT_ORIGIN;

const cors = (env, extra = {}) => ({
  'Access-Control-Allow-Origin': allowOrigin(env),
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
  ...extra,
});

const json = (env, obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: cors(env, { 'Content-Type': 'application/json; charset=utf-8' }),
  });

/** 只在登录失败时露脸的一张小提示页（站点本身不经过这里）。 */
const notice = (text, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>论坛登录</title>` +
      `<body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b0c0e;` +
      `color:#e7e9ec;font:16px/1.7 system-ui,-apple-system,'Noto Sans SC',sans-serif">` +
      `<p style="max-width:22em;text-align:center;padding:0 22px">${text}</p></body>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );

/** 只允许跳回本站地址，防止开放重定向。 */
function safeReturn(raw, env) {
  const origin = allowOrigin(env);
  try {
    const u = new URL(String(raw || ''));
    if (u.origin !== origin) return `${origin}/post/`;
    return u.origin + u.pathname + (u.search || '');
  } catch {
    return `${origin}/post/`;
  }
}

/** 回调地址必须和 OAuth App 里登记的一字不差，所以从请求里推。 */
const callbackUrl = (url) => `${url.origin}/auth/callback`;

/* ---------- 账号 / 评论 用的工具 ---------- */

const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= EMAIL_MAX;
const nameOk = (n) => /^[\w\u4e00-\u9fa5.-]{2,20}$/.test(n);

/** PBKDF2-SHA256；salt 不给就现生成一个。 */
async function hashPw(pw, saltB64) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pw),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    key,
    256,
  );
  return { s: b64(salt), h: b64(new Uint8Array(bits)) };
}

/** 定长比较，别让比较耗时泄露信息。 */
function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

const roleOf = (name) =>
  name && ADMIN_LOGINS.includes(String(name).toLowerCase()) ? 'admin' : 'user';

/** 会话是不是管理员：名单实时判定，不依赖会话里存死的 r。 */
const isAdmin = (s) =>
  !!s && (s.r === 'admin' || ADMIN_LOGINS.includes(String(s.l || '').toLowerCase()));

const requestIP = (request) => request.headers.get('CF-Connecting-IP') || '0.0.0.0';

/** 简易滑动窗口限流：KV 的过期时间就是窗口本身。 */
async function tooMany(env, scope, ip, limit, windowSec) {
  const k = `rl:${scope}:${ip}`;
  const n = Number((await env.RL.get(k)) || 0);
  if (n >= limit) return true;
  await env.RL.put(k, String(n + 1), { expirationTtl: windowSec });
  return false;
}

/** 新建会话，返回会话号（片段里交给前端存）。 */
async function newSession(env, data) {
  const sid = crypto.randomUUID();
  await env.RL.put(`sess:${sid}`, JSON.stringify(data), { expirationTtl: SESSION_TTL });
  return sid;
}

/** 评论挂在哪：文章路径或帖子编号，只留安全字符。 */
const commentKey = (raw) =>
  String(raw || '')
    .trim()
    .slice(0, 200)
    .replace(/[^A-Za-z0-9/_.:-]/g, '')
    .replace(/^\/+|\/+$/g, '');

async function readComments(env, key) {
  const raw = await env.RL.get(`cmt:${key}`);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

const publicComment = (c) => ({ id: c.id, n: c.n, a: c.a || '', b: c.b, ts: c.ts });

/** 这条评论归谁：邮箱账号看邮箱，GitHub 账号看登录名。 */
const ownerOf = (s) => (s.k === 'gh' ? `gh:${String(s.l).toLowerCase()}` : `e:${s.e}`);

async function exchangeCode(env, code, redirectUri) {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'zbgamelt-forum-api',
    },
    body: JSON.stringify({
      client_id: env.GH_OAUTH_CLIENT_ID,
      client_secret: env.GH_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const data = await res.json().catch(() => ({}));
  return data.access_token || '';
}

async function ghUser(token) {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'zbgamelt-forum-api',
    },
  });
  if (!res.ok) return null;
  const d = await res.json().catch(() => null);
  return d && d.login ? d : null;
}

/** 会话 = KV 里一条记录：{ t: 用户 token, l: 登录名, a: 头像 }。 */
async function sessionOf(request, env) {
  const raw = request.headers.get('Authorization') || '';
  const sid = raw.startsWith('Bearer ') ? raw.slice(7).trim() : '';
  if (!sid || !/^[0-9a-f-]{36}$/.test(sid)) return null;
  const stored = await env.RL.get(`sess:${sid}`);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

async function createDiscussion(env, token, title, body) {
  const query = `mutation($repo:ID!,$cat:ID!,$title:String!,$body:String!){
    createDiscussion(input:{repositoryId:$repo,categoryId:$cat,title:$title,body:$body}){
      discussion{ number url }
    }
  }`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'zbgamelt-forum-api',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: { repo: REPO_ID, cat: CATEGORY_ID, title, body },
    }),
  });
  const data = await res.json().catch(() => ({}));
  const discussion = data?.data?.createDiscussion?.discussion;
  if (!discussion) {
    const detail = JSON.stringify(data?.errors ?? data).slice(0, 300);
    throw new Error(detail);
  }
  return discussion;
}

/**
 * 用**登录者自己的** token 调 GraphQL（查帖子、删帖子都走这条路）。
 * 出任何错都抛异常，由调用方翻成给用户看的话。
 */
async function gql(token, query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'zbgamelt-forum-api',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.errors) throw new Error(JSON.stringify(data.errors).slice(0, 300));
  return data.data || {};
}

/** 查「我的帖子」：只取本人的，口径跟站点首页一致（标题 + 摘要 + 时间）。 */
const MINE_QUERY = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    discussions(first:100, orderBy:{field:CREATED_AT, direction:DESC}){
      nodes{ number title createdAt updatedAt bodyHTML author{ login } category{ name } }
    }
  }
}`;

/** 删之前先按编号查出 node id 和作者，用来卡「只能删自己的」。 */
const ONE_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ discussion(number:$number){ id author{ login } } }
}`;

const DELETE_MUT = `mutation($id:ID!){ deleteDiscussion(input:{id:$id}){ discussion{ number } } }`;

/**
 * 把 GitHub 的原始报错翻成人话。
 * deleteDiscussion 被权限拒时 GraphQL 返回的是：
 * [{"type":"FORBIDDEN","path":["deleteDiscussion"],"message":"<login> does not
 * have the correct permissions to execute `DeleteDiscussion`"}] ——
 * 这串直接甩到页面上没法看。
 */
function delError(msg) {
  const m = String(msg || '');
  if (m.includes('Bad credentials')) return '站点用的 GitHub token 已失效，暂时删不了';
  if (m.includes('FORBIDDEN') || m.includes('does not have the correct permissions')) {
    return 'GitHub 不让删：站点这边缺一个能写 Discussions 的仓库 token';
  }
  if (/not found|Could not resolve/i.test(m)) return '这条帖子已经不在 GitHub 上了';
  return m.slice(0, 160) || '删除失败';
}

/** 正文 HTML → 列表用的纯文本摘要（口径跟站点首页的 bodyText 一致）。 */
function excerptOf(html, max = 96) {
  const t = String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s*由\s*.{1,24}?\s*通过论坛页面发布[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length <= max ? t : t.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

/**
 * 让静态站尽快重建。发帖人的 token 里没有 workflow 权限，所以这里用机器人 token
 * （有就用，没有就跳过）；另外 GitHub 的 discussion 事件本身也会触发重建。
 * 纯尽力而为，失败绝不影响发帖。
 */
async function pokeRebuild(env) {
  if (!env.GITHUB_TOKEN) return;
  try {
    await fetch(
      `https://api.github.com/repos/${REPO_FULL}/actions/workflows/${BUILD_WORKFLOW}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'zbgamelt-forum-api',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      },
    );
  } catch {
    /* 触发失败无所谓，站点还有定时同步兜底 */
  }
}

export default {
  async fetch(request, env, ctx) {
    // 兜底：任何没接住的异常都翻成 JSON，别甩给访客一张 Cloudflare 1101 白页。
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      const msg = String((err && err.message) || err).slice(0, 200);
      return json(env, { error: `服务端出错了：${msg}` }, 500);
    }
  },
};

async function handle(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    if (path === '/health') return json(env, { ok: true, ts: Date.now(), v: 5 });

    /* ---------- 登录 ---------- */

    if (path === '/auth/login' && request.method === 'GET') {
      if (!env.GH_OAUTH_CLIENT_ID || !env.GH_OAUTH_CLIENT_SECRET) {
        return notice('登录还没配好（缺 OAuth 凭据），先联系站长。', 503);
      }
      const state = crypto.randomUUID();
      await env.RL.put(`st:${state}`, safeReturn(url.searchParams.get('return'), env), {
        expirationTtl: STATE_TTL,
      });
      const auth = new URL('https://github.com/login/oauth/authorize');
      auth.searchParams.set('client_id', env.GH_OAUTH_CLIENT_ID);
      auth.searchParams.set('redirect_uri', callbackUrl(url));
      auth.searchParams.set('scope', 'public_repo');
      auth.searchParams.set('state', state);
      return Response.redirect(auth.toString(), 302);
    }

    if (path === '/auth/callback' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const back = state ? await env.RL.get(`st:${state}`) : null;
      if (!back) return notice('这个登录链接已经失效了，回站点重新点一次「用 GitHub 登录」。', 400);
      await env.RL.delete(`st:${state}`);            // 一次性，用过即废
      if (!code) return notice('GitHub 没有返回授权码，请重试。', 400);

      const token = await exchangeCode(env, code, callbackUrl(url));
      if (!token) return notice('跟 GitHub 换 token 失败了，请回站点重试。<br>（如果反复失败，多半是回调地址和 OAuth App 里登记的不一致。）', 502);

      const me = await ghUser(token);
      if (!me) return notice('拿到了 token 但读不到你的 GitHub 账号，请重试。', 502);

      const sid = await newSession(env, {
        t: token,
        l: me.login,
        a: me.avatar_url || '',
        r: roleOf(me.login),
        k: 'gh',
      });
      // 会话号放片段：不发给服务器、不进 Referer
      return Response.redirect(`${back}#s=${sid}`, 302);
    }

    if (path === '/auth/logout' && request.method === 'POST') {
      const raw = request.headers.get('Authorization') || '';
      const sid = raw.startsWith('Bearer ') ? raw.slice(7).trim() : '';
      if (sid && /^[0-9a-f-]{36}$/.test(sid)) await env.RL.delete(`sess:${sid}`);
      return json(env, { ok: true });
    }

    if (path === '/api/me' && request.method === 'GET') {
      const s = await sessionOf(request, env);
      if (!s) return json(env, { error: '没登录' }, 401);
      return json(env, {
        login: s.l,
        name: s.l,
        avatar: s.a || '',
        role: isAdmin(s) ? 'admin' : s.r || 'user',
        kind: s.k || 'gh',
      });
    }

    /* ---------- 我的 / 删帖 ---------- */

    if (path === '/my-posts' && request.method === 'GET') {
      const s = await sessionOf(request, env);
      if (!s) return json(env, { error: '请先用 GitHub 登录' }, 401);
      // 「我的帖子」列的是 GitHub Discussions，邮箱注册的账号没有 GitHub token。
      if (!s.t) return json(env, { error: '这个功能要 GitHub 登录（站内邮箱账号看不到）' }, 400);
      let nodes;
      try {
        const data = await gql(s.t, MINE_QUERY, { owner: OWNER, name: NAME });
        nodes = data?.repository?.discussions?.nodes || [];
      } catch (err) {
        return json(env, { error: `读不到你的帖子：${err.message}` }, 502);
      }
      const mine = s.l.toLowerCase();
      const posts = nodes
        .filter((d) => (d.author?.login || '').toLowerCase() === mine)
        .map((d) => ({
          n: d.number,
          t: d.title,
          x: excerptOf(d.bodyHTML),
          ts: Date.parse(d.createdAt) || 0,
          us: Date.parse(d.updatedAt) || Date.parse(d.createdAt) || 0,
          cat: d.category?.name || '',
        }));
      return json(env, { ok: true, login: s.l, posts });
    }

    if (path === '/delete-post' && request.method === 'POST') {
      const s = await sessionOf(request, env);
      if (!s) return json(env, { error: '请先用 GitHub 登录' }, 401);

      let payload;
      try {
        payload = await request.json();
      } catch {
        return json(env, { error: '请求体不是合法 JSON' }, 400);
      }
      const raw = Array.isArray(payload.numbers) ? payload.numbers : [payload.number];
      const numbers = [
        ...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0)),
      ].slice(0, 50);
      if (!numbers.length) return json(env, { error: '没给要删的帖子编号' }, 400);

      const mine = s.l.toLowerCase();
      // 删帖得用「仓库级 token」：GitHub 不让普通用户对自己的讨论跑 deleteDiscussion
      //（只有对该仓库有写权限才行），拿登录者自己的 token 删必定 FORBIDDEN。
      // 作者核对仍然用登录者自己的 token —— 保证只能删自己的。
      const delTok = String(env.GITHUB_TOKEN || '').trim() || s.t;
      const deleted = [];
      const failed = [];
      for (const n of numbers) {
        try {
          const one = await gql(s.t, ONE_QUERY, { owner: OWNER, name: NAME, number: n });
          const d = one?.repository?.discussion;
          if (!d) {
            failed.push({ n, error: '这条帖子已经不在 GitHub 上了' });
            continue;
          }
          if ((d.author?.login || '').toLowerCase() !== mine) {
            failed.push({ n, error: '只能删自己发的帖子' });
            continue;
          }
          await gql(delTok, DELETE_MUT, { id: d.id });
          deleted.push(n);
        } catch (err) {
          failed.push({ n, error: delError(err.message) });
        }
      }
      // 删成功就让站点尽快重建；失败无所谓，还有定时同步兜底
      if (deleted.length) ctx.waitUntil(pokeRebuild(env));
      return json(env, { ok: deleted.length > 0, deleted, failed });
    }

    /* ---------- 发帖 ---------- */

    /* ---------- 注册 / 登录（邮箱 + 密码） ---------- */

    if (path === '/register' && request.method === 'POST') {
      const ip = requestIP(request);
      if (await tooMany(env, 'reg', ip, REG_PER_HOUR, 3600)) {
        return json(env, { error: '注册太频繁了，过一会儿再试' }, 429);
      }
      const p = await request.json().catch(() => ({}));
      const email = String(p.email ?? '').trim().toLowerCase();
      const name = String(p.name ?? '').trim();
      const pw = String(p.password ?? '');
      if (!emailOk(email)) return json(env, { error: '邮箱格式不对' }, 400);
      if (!nameOk(name)) return json(env, { error: '名字 2-20 个字，中英文/数字都行，不能有空格' }, 400);
      // admin 只看 GitHub 登录名，所以站长的名字不能被别人抢注（否则等于白送管理员）。
      if (ADMIN_LOGINS.includes(name.toLowerCase())) {
        return json(env, { error: '这个名字留给站长了，换一个' }, 403);
      }
      if (pw.length < PW_MIN) return json(env, { error: `密码至少 ${PW_MIN} 位` }, 400);
      if (await env.RL.get(`u:${email}`)) return json(env, { error: '这个邮箱已经注册过了' }, 409);
      if (await env.RL.get(`un:${name.toLowerCase()}`)) return json(env, { error: '这个名字被占用了，换一个' }, 409);

      const { s, h } = await hashPw(pw);
      const rec = { e: email, n: name, s, h, ts: Date.now(), r: 'user', b: false };
      await env.RL.put(`u:${email}`, JSON.stringify(rec));
      await env.RL.put(`un:${name.toLowerCase()}`, email);
      const sid = await newSession(env, { e: email, l: name, a: '', r: 'user', k: 'pw' });
      return json(env, { ok: true, sid, name, role: 'user' });
    }

    if (path === '/login' && request.method === 'POST') {
      const ip = requestIP(request);
      if (await tooMany(env, 'login', ip, LOGIN_TRIES, LOGIN_WINDOW)) {
        return json(env, { error: '试得太频繁了，等 15 分钟再来' }, 429);
      }
      const p = await request.json().catch(() => ({}));
      const email = String(p.email ?? '').trim().toLowerCase();
      const pw = String(p.password ?? '');
      const raw = email ? await env.RL.get(`u:${email}`) : null;
      if (!raw) return json(env, { error: '邮箱或密码不对' }, 401);
      let rec;
      try {
        rec = JSON.parse(raw);
      } catch {
        return json(env, { error: '账号数据读不出来，找站长' }, 500);
      }
      const { h } = await hashPw(pw, rec.s);
      if (!sameHash(h, rec.h)) return json(env, { error: '邮箱或密码不对' }, 401);
      if (rec.b) return json(env, { error: '这个账号被封了' }, 403);
      const sid = await newSession(env, { e: rec.e, l: rec.n, a: '', r: rec.r || 'user', k: 'pw' });
      return json(env, { ok: true, sid, name: rec.n, role: rec.r || 'user' });
    }

    /* ---------- 评论 ---------- */

    if (path === '/comments' && request.method === 'GET') {
      const key = commentKey(url.searchParams.get('p'));
      if (!key) return json(env, { error: '缺少 p 参数' }, 400);
      const list = await readComments(env, key);
      return json(env, { ok: true, key, comments: list.map(publicComment) });
    }

    if (path === '/comment' && request.method === 'POST') {
      const s = await sessionOf(request, env);
      if (!s) return json(env, { error: '先登录再评论' }, 401);
      if (await tooMany(env, 'cmt', requestIP(request), COMMENT_PER_10MIN, 600)) {
        return json(env, { error: '发得有点快，歇一会儿再发' }, 429);
      }
      const p = await request.json().catch(() => ({}));
      const key = commentKey(p.p);
      const body = String(p.body ?? '').trim();
      if (!key) return json(env, { error: '缺少 p 参数' }, 400);
      if (body.length < COMMENT_MIN) return json(env, { error: '内容太短了' }, 400);
      if (body.length > COMMENT_MAX) return json(env, { error: `内容最长 ${COMMENT_MAX} 字` }, 400);

      // 邮箱账号被封就发不了（GitHub 账号的封禁在 GitHub 那边管）
      if (s.e) {
        const raw = await env.RL.get(`u:${s.e}`);
        if (raw) {
          try {
            if (JSON.parse(raw).b) return json(env, { error: '这个账号被封了' }, 403);
          } catch {
            /* 读不出来就当没封 */
          }
        }
      }

      const list = await readComments(env, key);
      if (list.length >= COMMENTS_PER_KEY) {
        return json(env, { error: '这条下面的评论太多了，新开一层吧' }, 429);
      }
      const c = {
        id: crypto.randomUUID(),
        n: s.l,
        a: s.a || '',
        b: body,
        ts: Date.now(),
        by: ownerOf(s),
      };
      list.push(c);
      await env.RL.put(`cmt:${key}`, JSON.stringify(list));
      return json(env, { ok: true, comment: publicComment(c) });
    }

    if (path === '/comment/delete' && request.method === 'POST') {
      const s = await sessionOf(request, env);
      if (!s) return json(env, { error: '先登录' }, 401);
      const p = await request.json().catch(() => ({}));
      const key = commentKey(p.p);
      const id = String(p.id || '');
      if (!key || !id) return json(env, { error: '参数不全' }, 400);
      const list = await readComments(env, key);
      const target = list.find((x) => x.id === id);
      if (!target) return json(env, { error: '这条评论已经不在了' }, 404);
      if (s.r !== 'admin' && !isAdmin(s) && target.by !== ownerOf(s)) {
        return json(env, { error: '只能删自己的评论' }, 403);
      }
      await env.RL.put(`cmt:${key}`, JSON.stringify(list.filter((x) => x.id !== id)));
      return json(env, { ok: true });
    }

    /* ---------- 管理面板 ---------- */

    if (path.startsWith('/admin/')) {
      const s = await sessionOf(request, env);
      if (!s) return json(env, { error: '先登录' }, 401);
      if (!isAdmin(s)) return json(env, { error: '这里只有管理员能看' }, 403);

      if (path === '/admin/summary' && request.method === 'GET') {
        const users = [];
        let cursor;
        do {
          const page = await env.RL.list({ prefix: 'u:', limit: 100, cursor });
          for (const k of page.keys) {
            const raw = await env.RL.get(k.name);
            if (!raw) continue;
            try {
              const u = JSON.parse(raw);
              users.push({ e: u.e, n: u.n, ts: u.ts, r: u.r || 'user', b: !!u.b });
            } catch {
              /* 坏记录跳过 */
            }
          }
          cursor = page.list_complete ? null : page.cursor;
        } while (cursor && users.length < 300);
        users.sort((a, b) => (b.ts || 0) - (a.ts || 0));

        const comments = [];
        const cpage = await env.RL.list({ prefix: 'cmt:', limit: 100 });
        for (const k of cpage.keys) {
          const key = k.name.slice(4);
          for (const c of await readComments(env, key)) {
            comments.push({ ...publicComment(c), key });
          }
        }
        comments.sort((a, b) => b.ts - a.ts);

        return json(env, {
          ok: true,
          me: s.l,
          users,
          threads: cpage.keys.length,
          totalComments: comments.length,
          recent: comments.slice(0, 60),
        });
      }

      if (path === '/admin/user' && request.method === 'POST') {
        const p = await request.json().catch(() => ({}));
        const email = String(p.email ?? '').trim().toLowerCase();
        const raw = email ? await env.RL.get(`u:${email}`) : null;
        if (!raw) return json(env, { error: '没有这个用户' }, 404);
        let rec;
        try {
          rec = JSON.parse(raw);
        } catch {
          return json(env, { error: '用户记录坏了' }, 500);
        }
        rec.b = !!p.ban;
        await env.RL.put(`u:${email}`, JSON.stringify(rec));
        return json(env, { ok: true, email, banned: rec.b });
      }

      if (path === '/admin/comment-delete' && request.method === 'POST') {
        const p = await request.json().catch(() => ({}));
        const key = commentKey(p.p);
        const id = String(p.id || '');
        if (!key || !id) return json(env, { error: '参数不全' }, 400);
        const list = await readComments(env, key);
        if (!list.some((x) => x.id === id)) return json(env, { error: '这条评论已经不在了' }, 404);
        await env.RL.put(`cmt:${key}`, JSON.stringify(list.filter((x) => x.id !== id)));
        return json(env, { ok: true, key, id });
      }

      return json(env, { error: '没有这个管理接口' }, 404);
    }

    if (path !== '/new-post' || request.method !== 'POST') {
      return json(env, { error: '没有这个接口' }, 404);
    }

    const session = await sessionOf(request, env);
    if (!session) return json(env, { error: '请先用 GitHub 登录' }, 401);

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json(env, { error: '请求体不是合法 JSON' }, 400);
    }

    const title = String(payload.title ?? '').trim();
    const body = String(payload.body ?? '').trim();

    if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
      return json(env, { error: `标题要 ${TITLE_MIN}-${TITLE_MAX} 个字` }, 400);
    }
    if (body.length < BODY_MIN) return json(env, { error: '正文太短了' }, 400);
    if (body.length > BODY_MAX) return json(env, { error: `正文最长 ${BODY_MAX} 字` }, 400);

    const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';

    // 冷却 + 每日上限（KV 的过期时间就是窗口）
    const coolKey = `cool:${ip}`;
    if (await env.RL.get(coolKey)) {
      return json(env, { error: '发得有点快，等两分钟再发下一条' }, 429);
    }
    const dayKey = `day:${new Date().toISOString().slice(0, 10)}`;
    const usedToday = Number((await env.RL.get(dayKey)) || 0);
    if (usedToday >= DAILY_CAP) {
      return json(env, { error: '今天的发帖额度用完了，明天再来' }, 429);
    }

    // 正文就是正文：作者是登录者本人，不再需要往末尾追署名行
    let discussion;
    try {
      discussion = await createDiscussion(env, session.t, title, body);
    } catch (err) {
      const msg = String(err.message || '');
      if (/401|Bad credentials|FORBIDDEN|permission/i.test(msg)) {
        return json(env, { error: '登录可能过期了，退出后重新用 GitHub 登录一次' }, 401);
      }
      return json(env, { error: `发帖失败：${msg}` }, 502);
    }

    await env.RL.put(coolKey, '1', { expirationTtl: COOLDOWN_SEC });
    await env.RL.put(dayKey, String(usedToday + 1), { expirationTtl: 172800 });
    ctx.waitUntil(pokeRebuild(env));

  return json(env, { ok: true, number: discussion.number, url: discussion.url });
}
