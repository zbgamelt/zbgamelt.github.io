/*!
 * zsocial.js — 站内账号 + 评论的前端客户端（论坛 / 子站共用）
 *
 * 会话号存在 localStorage('zbforum_sess')，跟 /me/、/post/ 页完全共用一套：
 * 在论坛登录一次，博客的评论区也是登录状态（同一个源）。
 *
 * 用法（评论挂载）：页面里放一个空容器即可，剩下的它自己长出来
 *   <div data-zcomments="zbgamelttwo/posts/hello-world"></div>
 *   <script src="/assets/zsocial.js" defer></script>
 *
 * 注意：这个文件是给两个不同主题的页面共用的（论坛的 style.css + 博客的 PaperMod），
 * 所以评论区自带的样式是「自带 <style>、类名 zc- 前缀」，不吃任何一方的变量。
 */
(function () {
  'use strict';

  var API = 'https://forum-api.zbgame.bid';
  var SESS = 'zbforum_sess';

  /* ---------- 会话 ---------- */

  function sid() {
    try { return localStorage.getItem(SESS) || ''; } catch (e) { return ''; }
  }
  function setSid(v) {
    try { v ? localStorage.setItem(SESS, v) : localStorage.removeItem(SESS); } catch (e) {}
  }
  function forgot() { setSid(''); }

  function req(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (sid()) headers.Authorization = 'Bearer ' + sid();
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.text().then(function (t) {
        var d = {};
        try { d = JSON.parse(t); } catch (e) { d = { error: '服务端返回了看不懂的东西' }; }
        if (!r.ok) {
          // 会话过期了就顺手清掉，免得一直拿着死号
          if (r.status === 401 && sid()) forgot();
          var err = new Error(d.error || 'HTTP ' + r.status);
          err.status = r.status;
          throw err;
        }
        return d;
      });
    });
  }

  var ZB = {
    api: API,
    sid: sid,
    me: function () { return req('/api/me'); },
    login: function (email, password) {
      return req('/login', { method: 'POST', body: { email: email, password: password } })
        .then(function (d) { setSid(d.sid); return d; });
    },
    register: function (email, name, password) {
      return req('/register', { method: 'POST', body: { email: email, name: name, password: password } })
        .then(function (d) { setSid(d.sid); return d; });
    },
    logout: function () {
      var done = function () { setSid(''); };
      if (!sid()) return Promise.resolve(done());
      return req('/auth/logout', { method: 'POST' }).then(done, done);
    },
    comments: function (key) { return req('/comments?p=' + encodeURIComponent(key)); },
    comment: function (key, body) { return req('/comment', { method: 'POST', body: { p: key, body: body } }); },
    removeComment: function (key, id) { return req('/comment/delete', { method: 'POST', body: { p: key, id: id } }); },
    adminSummary: function () { return req('/admin/summary'); },
    adminBan: function (email, ban) { return req('/admin/user', { method: 'POST', body: { email: email, ban: !!ban } }); },
    adminRemoveComment: function (key, id) { return req('/admin/comment-delete', { method: 'POST', body: { p: key, id: id } }); },
  };
  window.ZB = ZB;

  /* ---------- 小工具 ---------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function when(ts) {
    var d = new Date(Number(ts) || 0);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes());
  }

  var CSS = [
    '.zc{margin:34px 0 8px;font:15px/1.7 inherit}',
    '.zc__h{display:flex;align-items:baseline;gap:8px;margin:0 0 14px;font-size:17px;font-weight:700}',
    '.zc__h span{font-weight:400;font-size:13px;opacity:.55}',
    '.zc__list{display:flex;flex-direction:column;gap:10px;margin:0 0 16px}',
    '.zc__c{border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:11px 13px;background:rgba(255,255,255,.02)}',
    '.zc__top{display:flex;align-items:center;gap:8px;font-size:13px;opacity:.7;margin-bottom:4px}',
    '.zc__n{font-weight:600;opacity:.95}',
    '.zc__b{white-space:pre-wrap;word-break:break-word}',
    '.zc__x{margin-left:auto;background:none;border:0;color:inherit;opacity:.45;cursor:pointer;font-size:12px;padding:2px 4px}',
    '.zc__x:hover{opacity:.9;color:#ff7a6b}',
    '.zc__none{opacity:.5;font-size:14px;margin:0 0 16px}',
    '.zc__box{display:flex;flex-direction:column;gap:9px}',
    '.zc__box textarea{width:100%;box-sizing:border-box;min-height:84px;resize:vertical;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.03);color:inherit;font:inherit}',
    '.zc__box textarea:focus{outline:2px solid #ffd83d55;outline-offset:1px}',
    '.zc__row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
    '.zc__row input{flex:1 1 150px;min-width:0;padding:9px 11px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.03);color:inherit;font:inherit}',
    '.zc__btn{border:0;border-radius:10px;padding:9px 16px;background:#ffd83d;color:#1a1a1a;font:inherit;font-weight:600;cursor:pointer}',
    '.zc__btn[disabled]{opacity:.5;cursor:default}',
    '.zc__btn--ghost{background:transparent;color:inherit;border:1px solid rgba(255,255,255,.18)}',
    '.zc__msg{font-size:13px;color:#ff9b8f;min-height:1em}',
    '.zc__msg--ok{color:#8ee6a0}',
    '.zc__gate{border:1px dashed rgba(255,255,255,.16);border-radius:12px;padding:13px 14px;display:flex;flex-direction:column;gap:9px}',
    '.zc__gate p{margin:0;font-size:14px;opacity:.75}',
  ].join('');

  function styles() {
    if (document.getElementById('zc-css')) return;
    var s = document.createElement('style');
    s.id = 'zc-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* ---------- 评论区 ---------- */

  function mount(el) {
    var key = el.getAttribute('data-zcomments');
    if (!key) return;
    styles();

    var me = null;
    el.className = 'zc';
    el.innerHTML = '<h2 class="zc__h">评论 <span id="zc-n"></span></h2>' +
      '<div class="zc__list" id="zc-list"></div>' +
      '<div class="zc__box" id="zc-box"></div>' +
      '<p class="zc__msg" id="zc-msg" role="status" aria-live="polite"></p>';

    var listEl = el.querySelector('#zc-list');
    var boxEl = el.querySelector('#zc-box');
    var msgEl = el.querySelector('#zc-msg');
    var nEl = el.querySelector('#zc-n');

    function msg(t, ok) {
      msgEl.textContent = t || '';
      msgEl.className = 'zc__msg' + (ok ? ' zc__msg--ok' : '');
    }

    function drawList(items) {
      nEl.textContent = items.length ? '(' + items.length + ')' : '';
      if (!items.length) {
        listEl.innerHTML = '<p class="zc__none">还没有人评论，来做第一个。</p>';
        return;
      }
      listEl.innerHTML = items.map(function (c) {
        var mine = me && (c.n === me.name);
        var can = me && (mine || me.role === 'admin');
        return '<div class="zc__c" data-id="' + esc(c.id) + '">' +
          '<div class="zc__top"><span class="zc__n">' + esc(c.n) + '</span><span>' + esc(when(c.ts)) + '</span>' +
          (can ? '<button class="zc__x" data-del="' + esc(c.id) + '" title="删除">删除</button>' : '') +
          '</div><div class="zc__b">' + esc(c.b) + '</div></div>';
      }).join('');
    }

    function drawBox() {
      if (me) {
        boxEl.innerHTML = '<textarea id="zc-t" placeholder="说点什么…（当前身份：' + esc(me.name) + '）"></textarea>' +
          '<div class="zc__row"><button class="zc__btn" id="zc-send">发表评论</button>' +
          '<button class="zc__btn zc__btn--ghost" id="zc-out">退出登录</button></div>';
        boxEl.querySelector('#zc-send').addEventListener('click', send);
        boxEl.querySelector('#zc-out').addEventListener('click', function () {
          ZB.logout().then(function () { me = null; drawBox(); load(); msg('已退出', true); });
        });
        return;
      }
      // 没登录：站点没装表头，评论要拿账号，这里就地登录 / 注册
      boxEl.innerHTML = '<div class="zc__gate"><p>评论要先用账号登录（不需要 GitHub）。</p>' +
        '<div class="zc__row"><input id="zc-e" type="email" placeholder="邮箱" autocomplete="email">' +
        '<input id="zc-p" type="password" placeholder="密码" autocomplete="current-password"></div>' +
        '<div class="zc__row"><button class="zc__btn" id="zc-in">登录</button>' +
        '<button class="zc__btn zc__btn--ghost" id="zc-reg-toggle">没有账号，去注册</button></div>' +
        '<div class="zc__row" id="zc-reg" hidden><input id="zc-nm" type="text" placeholder="昵称（2-20 字）" autocomplete="nickname">' +
        '<button class="zc__btn" id="zc-reg-go">注册并登录</button></div></div>';
      var regRow = boxEl.querySelector('#zc-reg');
      boxEl.querySelector('#zc-reg-toggle').addEventListener('click', function () {
        regRow.hidden = !regRow.hidden;
      });
      boxEl.querySelector('#zc-in').addEventListener('click', function () {
        var e = boxEl.querySelector('#zc-e').value.trim();
        var p = boxEl.querySelector('#zc-p').value;
        msg('');
        ZB.login(e, p).then(afterAuth, function (err) { msg(err.message); });
      });
      boxEl.querySelector('#zc-reg-go').addEventListener('click', function () {
        var e = boxEl.querySelector('#zc-e').value.trim();
        var p = boxEl.querySelector('#zc-p').value;
        var nm = boxEl.querySelector('#zc-nm').value.trim();
        msg('');
        ZB.register(e, nm, p).then(afterAuth, function (err) { msg(err.message); });
      });
    }

    function afterAuth(d) {
      me = { name: d.name, role: d.role || 'user' };
      msg('已登录：' + d.name, true);
      drawBox();
      load();
    }

    function send() {
      var t = boxEl.querySelector('#zc-t');
      var v = t.value.trim();
      if (v.length < 2) { msg('内容太短了'); return; }
      boxEl.querySelector('#zc-send').disabled = true;
      ZB.comment(key, v).then(function () {
        t.value = '';
        msg('已发表', true);
        load();
      }, function (err) {
        msg(err.message);
      }).then(function () { boxEl.querySelector('#zc-send').disabled = false; });
    }

    listEl.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-del]');
      if (!b) return;
      if (!window.confirm('删掉这条评论？')) return;
      ZB.removeComment(key, b.getAttribute('data-del')).then(function () { load(); msg('已删除', true); },
        function (err) { msg(err.message); });
    });

    function load() {
      return ZB.comments(key).then(function (d) { drawList(d.comments || []); },
        function (err) { msg('评论加载失败：' + err.message); });
    }

    ZB.me().then(function (d) { me = { name: d.name, role: d.role || 'user' }; },
      function () { me = null; }).then(function () {
      drawBox();
      load();
    });
  }

  function boot() {
    var all = document.querySelectorAll('[data-zcomments]');
    for (var i = 0; i < all.length; i++) mount(all[i]);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
