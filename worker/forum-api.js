/**
 * zbgamelt 论坛 · 发帖后端（Cloudflare Worker）
 *
 * 前端（GitHub Pages 上的静态站）把帖子发到这里，这里用细粒度 token
 * 调 GitHub GraphQL 建 Discussion —— 写权限只存在 Worker 的加密环境变量里，
 * 浏览器永远拿不到。
 *
 * 需要绑定的机密（用 wrangler secret / dash 面板设置，不要写进代码）：
 *   GITHUB_TOKEN      fine-grained token，权限只要 Discussions: Read and write
 *   TURNSTILE_SECRET  Cloudflare Turnstile 的 secret key
 * 需要绑定的 KV：
 *   RL               命名空间 forum-ratelimit，用于冷却与每日上限
 *
 * 端点：
 *   GET  /health     存活探测
 *   POST /new-post   { nickname?, title, body, turnstileToken } -> { ok, number, url }
 */

const REPO_ID = 'R_kgDOUiCTAQ';                     // zbgamelt/zbgamelt.github.io
const REPO_FULL = 'zbgamelt/zbgamelt.github.io';
const BUILD_WORKFLOW = 'build.yml';
const CATEGORY_ID = 'DIC_kwDOUiCTAc4DF_c1';         // General
const ALLOW_ORIGIN = 'https://zbgamelt.github.io';

const TITLE_MIN = 4, TITLE_MAX = 120;
const BODY_MIN = 8, BODY_MAX = 20000;
const NICK_MAX = 24;
const COOLDOWN_SEC = 120;   // 同一 IP 两次发帖的最小间隔
const DAILY_CAP = 30;       // 每天最多新建多少帖（防止被批量灌水）

const cors = (extra = {}) => ({
  'Access-Control-Allow-Origin': ALLOW_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  ...extra,
});

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: cors({ 'Content-Type': 'application/json; charset=utf-8' }),
  });

// 昵称会写进正文的署名行，先掐掉换行和 markdown 强调符，避免撑破格式
function cleanNick(raw) {
  return String(raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[*_`|>]/g, '')
    .trim()
    .slice(0, NICK_MAX);
}

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token || '');
  if (ip) form.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

async function createDiscussion(env, title, body) {
  const query = `mutation($repo:ID!,$cat:ID!,$title:String!,$body:String!){
    createDiscussion(input:{repositoryId:$repo,categoryId:$cat,title:$title,body:$body}){
      discussion{ number url }
    }
  }`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
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
 * 让静态站尽快重建（新帖几分钟内就出现在站上，而不是等两小时的兜底同步）。
 * 尽力而为：token 没带 Actions 写权限就静默跳过，绝不影响发帖本身。
 */
async function pokeRebuild(env) {
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
    const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    if (url.pathname === '/health') return json({ ok: true, ts: Date.now() });
    if (url.pathname !== '/new-post' || request.method !== 'POST') {
      return json({ error: '没有这个接口' }, 404);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: '请求体不是合法 JSON' }, 400);
    }

    const title = String(payload.title ?? '').trim();
    const body = String(payload.body ?? '').trim();
    const nick = cleanNick(payload.nickname);

    if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
      return json({ error: `标题要 ${TITLE_MIN}-${TITLE_MAX} 个字` }, 400);
    }
    if (body.length < BODY_MIN) return json({ error: '正文太短了' }, 400);
    if (body.length > BODY_MAX) {
      return json({ error: `正文最长 ${BODY_MAX} 字` }, 400);
    }

    // 冷却 + 每日上限（KV 的过期时间就是窗口）
    const coolKey = `cool:${ip}`;
    if (await env.RL.get(coolKey)) {
      return json({ error: '发得有点快，等两分钟再发下一条' }, 429);
    }
    const dayKey = `day:${new Date().toISOString().slice(0, 10)}`;
    const usedToday = Number((await env.RL.get(dayKey)) || 0);
    if (usedToday >= DAILY_CAP) {
      return json({ error: '今天的发帖额度用完了，明天再来' }, 429);
    }

    if (!(await verifyTurnstile(env, payload.turnstileToken, ip))) {
      return json({ error: '人机验证没通过，刷新页面重试一次' }, 403);
    }

    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const fullBody = `${body}\n\n---\n> 由 **${nick || '匿名访客'}** 通过论坛页面发布 · ${stamp}`;

    let discussion;
    try {
      discussion = await createDiscussion(env, title, fullBody);
    } catch (err) {
      return json({ error: `发帖失败：${err.message}` }, 502);
    }

    await env.RL.put(coolKey, '1', { expirationTtl: COOLDOWN_SEC });
    await env.RL.put(dayKey, String(usedToday + 1), { expirationTtl: 172800 });

    // 新帖发完让静态站尽快重建，别让作者等两个小时的兜底同步。
    // 交给 waitUntil 不阻塞响应；token 没带 Actions 写权限时静默失败。
    ctx.waitUntil(pokeRebuild(env));

    return json({ ok: true, number: discussion.number, url: discussion.url });
  },
};
