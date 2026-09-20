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
 *   POST /new-post              发帖 { title, body }，需 Bearer 会话号
 */

const REPO_ID = 'R_kgDOUiCTAQ';                     // zbgamelt/zbgamelt.github.io
const REPO_FULL = 'zbgamelt/zbgamelt.github.io';
const BUILD_WORKFLOW = 'build.yml';
const CATEGORY_ID = 'DIC_kwDOUiCTAc4DF_c1';         // General
const DEFAULT_ORIGIN = 'https://zbgamelt.github.io';

const TITLE_MIN = 4, TITLE_MAX = 120;
const BODY_MIN = 8, BODY_MAX = 20000;
const COOLDOWN_SEC = 120;        // 同一 IP 两次发帖的最小间隔
const DAILY_CAP = 30;            // 每天最多新建多少帖（防灌水兜底）
const SESSION_TTL = 60 * 60 * 24 * 30;   // 登录状态保留 30 天
const STATE_TTL = 600;                    // 授权跳转的 state 有效期 10 分钟

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
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    if (path === '/health') return json(env, { ok: true, ts: Date.now() });

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

      const sid = crypto.randomUUID();
      await env.RL.put(
        `sess:${sid}`,
        JSON.stringify({ t: token, l: me.login, a: me.avatar_url || '' }),
        { expirationTtl: SESSION_TTL },
      );
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
      return json(env, { login: s.l, avatar: s.a });
    }

    /* ---------- 发帖 ---------- */

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
  },
};
