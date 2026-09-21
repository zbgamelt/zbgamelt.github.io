/*!
 * sw.js — 站点的 Service Worker。
 *
 * 只干两件事：① 让站点能被「添加到主屏幕」装成一个 App；② 断网时给一个体面的兜底页。
 * 策略刻意做得保守 —— 这里是论坛，宁可让人看到稍旧的页面，也别看到串页的内容：
 *   · 导航（页面）请求：network-first，断网才回缓存，再不行兜到 /offline.html
 *   · 同源静态资源（css/js/图标）：stale-while-revalidate，先用缓存立刻出图，后台悄悄更新
 *   · 跨域请求（forum-api.zbgame.bid 的接口）一律不碰，永远直连，绝不参与缓存
 *
 * ⚠️ 改了缓存策略就改 CACHE 的版本号，activate 时会把旧版本整个清掉。
 */
const CACHE = 'zb-v1';
const OFFLINE = '/offline.html';

// 预缓存：断网时至少这些还画得出来
const PRECACHE = [
  OFFLINE,
  '/assets/style.css',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // 单个文件挂了不该拖垮整次安装（比如图标还没发布），所以用 allSettled
      .then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 只缓存拿得准的响应：同源、200、basic 型
function cacheable(res) {
  return res && res.ok && (res.type === 'basic' || res.type === 'default');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 接口等跨域，别管
  if (url.pathname === '/sw.js') return;           // 自身永远走网络，免得更新被缓存卡住

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (cacheable(res)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) => hit || caches.match(OFFLINE)),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (cacheable(res)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});
