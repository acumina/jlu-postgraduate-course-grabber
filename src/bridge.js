/* ============================================================
 * bridge.js —— 运行在页面 MAIN world 的桥接层
 * ------------------------------------------------------------
 * 为什么需要它？
 *   content script 跑在 isolated world 里，它的 fetch/XHR 是「扩展进程」发起的，
 *   跨源请求会丢失 SameSite=Lax 的会话 Cookie，很多教务系统因此直接判定未登录。
 *   所以真正的发包必须由页面自己（MAIN world，同源）来发 —— 这个文件就干这个。
 *
 * 它是通过 <script src="chrome-extension://.../src/bridge.js"> 注入的普通脚本，
 * 不依赖 ES module，也不受页面 CSP 中 script-src 'unsafe-inline' 的限制。
 *
 * 两个职责：
 *   1. 录包：hook window.fetch / XMLHttpRequest，把页面自己发的请求广播给扩展
 *   2. 发包：接收扩展的 replay 指令，用页面身份发起请求并回传结果
 * ============================================================ */
(function () {
  'use strict';
  if (window.__KX_BRIDGE__) return;
  window.__KX_BRIDGE__ = true;

  var MAX_TEXT = 6000;             // 请求体的截断长度（够看清结构即可）
  var MAX_RESP_TEXT = 200000;      // 响应体截断长度必须给足：真实教训是正方余量接口一页 30 条约 36KB，
                                   // 截到 6KB 后 JSON 被切断，parseList 直接报「不是合法 JSON」
  var MAX_REPLAY_TEXT = 1000000;   // 引擎发包时读回来的响应（要拿去解析，基本不截）
  var MAX_BODY_BYTES = 2 * 1024 * 1024; // 超过 2MB 的响应不记录
  var recordEnabled = true;        // 默认开启，避免漏掉页面早期的请求

  function post(msg) {
    try {
      msg.__kx = true;
      msg.dir = 'page2ext';
      window.postMessage(msg, '*');
    } catch (e) { /* ignore */ }
  }

  function truncate(s, n) {
    s = s == null ? '' : String(s);
    var lim = n || MAX_TEXT;
    if (s.length <= lim) return s;
    return s.slice(0, lim) + '\n…[已截断，共 ' + s.length + ' 字符]';
  }

  function headersToObj(h) {
    var out = {};
    try {
      if (!h) return out;
      if (typeof h.forEach === 'function' && !Array.isArray(h)) { // Headers 实例
        h.forEach(function (v, k) { out[k] = v; });
        return out;
      }
      if (Array.isArray(h)) { // HAR 风格 [{name,value}]
        h.forEach(function (it) { if (it && it.name) out[it.name] = it.value; });
        return out;
      }
      Object.keys(h).forEach(function (k) { out[k] = h[k]; });
    } catch (e) { /* ignore */ }
    return out;
  }

  function parseRawHeaders(raw) {
    var out = {};
    String(raw || '').trim().split(/[\r\n]+/).forEach(function (line) {
      var i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    });
    return out;
  }

  function ctOf(headers) {
    var o = headersToObj(headers);
    var v = o['content-type'] || o['Content-Type'] || '';
    return String(v).split(';')[0].trim();
  }

  function isRecordable(url) {
    if (!url) return false;
    var s = String(url);
    if (s.indexOf('chrome-extension://') === 0) return false;
    if (s.indexOf('data:') === 0 || s.indexOf('blob:') === 0) return false;
    return true;
  }

  function absolute(url) {
    try { return new URL(String(url), location.href).href; } catch (e) { return String(url); }
  }

  function bodyToText(body) {
    try {
      if (body == null) return '';
      if (typeof body === 'string') return body;
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        var arr = [];
        body.forEach(function (v, k) { arr.push(k + '=' + (typeof v === 'string' ? v : '[File]')); });
        return arr.join('&');
      }
      if (typeof Blob !== 'undefined' && body instanceof Blob) return '[Blob ' + body.size + ' bytes]';
      if (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) {
        try {
          return new TextDecoder().decode(body);
        } catch (e) { return '[binary]'; }
      }
      return String(body);
    } catch (e) { return '[无法读取 body]'; }
  }

  function emit(entry) {
    if (!recordEnabled) return;
    entry.ts = Date.now();
    entry.pageUrl = location.href;
    post({ type: 'capture', entry: entry });
  }

  /* ============================================================
   * 一、录包：hook fetch
   * ============================================================ */
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = '', method = 'GET', reqHeaders = {}, reqBody = '';
      try {
        if (typeof Request !== 'undefined' && input instanceof Request) {
          url = input.url;
          method = (input.method || 'GET').toUpperCase();
          reqHeaders = headersToObj(input.headers);
          if (init && init.method) method = String(init.method).toUpperCase();
          if (init && init.headers) reqHeaders = Object.assign(reqHeaders, headersToObj(init.headers));
        } else {
          url = absolute(input);
          method = String((init && init.method) || 'GET').toUpperCase();
          reqHeaders = headersToObj(init && init.headers);
        }
        if (init && init.body !== undefined) reqBody = bodyToText(init.body);
      } catch (e) { /* ignore */ }

      var started = Date.now();
      var p = origFetch.apply(this, arguments);
      if (!isRecordable(url)) return p;

      return p.then(function (res) {
        try {
          var len = Number(res.headers.get('content-length') || 0);
          var ct = res.headers.get('content-type') || '';
          var textLike = /json|text|xml|javascript|html/i.test(ct);
          var base = {
            kind: 'fetch',
            method: method,
            url: url,
            reqHeaders: reqHeaders,
            reqBody: truncate(reqBody),
            status: res.status,
            statusText: res.statusText,
            respHeaders: headersToObj(res.headers),
            respType: ctOf(res.headers),
            ms: Date.now() - started,
            self: false
          };
          if (textLike && len <= MAX_BODY_BYTES) {
            res.clone().text().then(function (t) {
              base.resp = truncate(t, MAX_RESP_TEXT);
              emit(base);
            }).catch(function () { emit(base); });
          } else {
            base.resp = '[非文本或过大，未记录]';
            emit(base);
          }
        } catch (e) { /* ignore */ }
        return res;
      }, function (err) {
        emit({
          kind: 'fetch', method: method, url: url, reqHeaders: reqHeaders,
          reqBody: truncate(reqBody), status: 0, error: String((err && err.message) || err), ms: Date.now() - started
        });
        throw err;
      });
    };
  }

  /* ============================================================
   * 二、录包：hook XMLHttpRequest
   * ============================================================ */
  var selfXhr = new WeakSet();       // 我们自己重放的 xhr，不回录
  var XHR = window.XMLHttpRequest;
  if (typeof XHR === 'function' && XHR.prototype) {
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;
    var origSetHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function (method, url) {
      try {
        if (!selfXhr.has(this)) {
          this.__kx = {
            method: String(method || 'GET').toUpperCase(),
            url: absolute(url),
            reqHeaders: {},
            started: 0
          };
        }
      } catch (e) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.setRequestHeader = function (k, v) {
      try { if (this.__kx) this.__kx.reqHeaders[k] = v; } catch (e) { /* ignore */ }
      return origSetHeader.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      var self = this;
      try {
        if (this.__kx) {
          this.__kx.started = Date.now();
          this.__kx.reqBody = truncate(bodyToText(body));
          this.addEventListener('loadend', function () {
            try {
              if (selfXhr.has(self) || !self.__kx) return;
              var info = self.__kx;
              var type = self.responseType;
              var text = '';
              if (type === '' || type === 'text') text = self.responseText || '';
              else if (type === 'json') text = JSON.stringify(self.response || null);
              else text = '[' + type + ' 响应，未记录]';
              emit({
                kind: 'xhr',
                method: info.method,
                url: self.responseURL || info.url,
                reqHeaders: info.reqHeaders,
                reqBody: info.reqBody,
                status: self.status,
                statusText: self.statusText,
                respHeaders: parseRawHeaders(self.getAllResponseHeaders()),
                respType: (parseRawHeaders(self.getAllResponseHeaders())['content-type'] || '').split(';')[0],
                resp: truncate(text, MAX_RESP_TEXT),
                ms: Date.now() - info.started
              });
            } catch (e) { /* ignore */ }
          });
        }
      } catch (e) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  }

  /* ============================================================
   * 三、发包：重放（这就是「模拟发包」）
   * ============================================================ */
  function doFetch(payload) {
    var p = payload || {};
    var url = absolute(p.url);
    var method = String(p.method || 'POST').toUpperCase();
    var headers = Object.assign({}, p.headers || {});
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = null;
    var timeoutMs = Number(p.timeoutMs || 15000);

    var init = {
      method: method,
      headers: headers,
      credentials: p.credentials || 'include',
      redirect: 'follow',
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined
    };
    if (p.body != null && method !== 'GET' && method !== 'HEAD') init.body = p.body;
    /* Referer 是禁止手工设置的请求头，但 fetch 提供了 referrer 初始化项：
     * 同源范围内可以指定，跨源会被浏览器按策略剥掉（这是浏览器行为，无法绕过）。
     * 只有系统严格校验来源、且当前页面地址不是它期望的那个时才需要填。 */
    if (p.referrer) init.referrer = p.referrer;
    if (p.referrerPolicy) init.referrerPolicy = p.referrerPolicy;

    var started = Date.now();
    if (ctrl) timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);

    var finish = function (result) {
      if (timer) clearTimeout(timer);
      result.ms = Date.now() - started;
      return result;
    };

    var pf;
    try {
      pf = origFetch.call(window, url, init);
    } catch (e) {
      return Promise.resolve(finish({ ok: false, status: 0, error: String((e && e.message) || e) }));
    }
    return pf.then(function (res) {
      return res.text().then(function (t) {
        return finish({
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          headers: headersToObj(res.headers),
          respType: ctOf(res.headers),
          body: truncate(t, MAX_REPLAY_TEXT),
          finalUrl: res.url
        });
      });
    }, function (err) {
      var msg = String((err && err.message) || err);
      if (err && err.name === 'AbortError') msg = '请求超时（' + timeoutMs + 'ms）';
      return finish({ ok: false, status: 0, error: msg });
    });
  }

  function doXhr(payload) {
    var p = payload || {};
    return new Promise(function (resolve) {
      var xhr;
      try {
        xhr = new XHR();
        selfXhr.add(xhr);
        xhr.open(String(p.method || 'POST').toUpperCase(), absolute(p.url), true);
        xhr.withCredentials = p.credentials !== 'omit';
        var h = p.headers || {};
        Object.keys(h).forEach(function (k) {
          try { xhr.setRequestHeader(k, h[k]); } catch (e) { /* ignore */ }
        });
        xhr.timeout = Number(p.timeoutMs || 15000);
        var started = Date.now();
        var done = function (result) {
          result.ms = Date.now() - started;
          resolve(result);
        };
        xhr.onloadend = function () {
          var type = xhr.responseType;
          var text = '';
          if (type === '' || type === 'text') text = xhr.responseText || '';
          else if (type === 'json') text = JSON.stringify(xhr.response || null);
          else text = '[' + type + ']';
          done({
            ok: xhr.status >= 200 && xhr.status < 300,
            status: xhr.status,
            statusText: xhr.statusText,
            headers: parseRawHeaders(xhr.getAllResponseHeaders()),
            body: truncate(text, MAX_REPLAY_TEXT),
            finalUrl: xhr.responseURL
          });
        };
        xhr.ontimeout = function () { done({ ok: false, status: 0, error: '请求超时' }); };
        xhr.onerror = function () { done({ ok: false, status: 0, error: '网络错误（可能是跨域或连接被拒）' }); };
        xhr.send(p.body != null ? p.body : null);
      } catch (e) {
        resolve({ ok: false, status: 0, error: String((e && e.message) || e) });
      }
    });
  }

  /* ============================================================
   * 五、UI 点击：让页面自己完成「选课 → 确定」
   * ------------------------------------------------------------
   * 为什么需要：这个系统的 csrfToken 每次页面加载都换、且不可从外部获取
   * （不在响应/cookie/存储/全局变量里），所以纯 API 发包在重新登录后必然失效。
   * 让页面自己点按钮，token 由它的 JS 自己带上 —— 我们只负责找按钮、点它、
   * 并从录包钩子里读结果。
   *
   * 设计原则（都是踩过坑后的取舍）：
   *   · 用**文字**找按钮而不是 class 名（class 会变，文字不会）
   *   · 每一步都是「轮询等待 + 超时」而不是固定 sleep（SPA 渲染时机不确定）
   *   · 先清理遗留的提示框（上次失败的「选课失败!」会挡住后续点击 → 静默卡死）
   *   · 全程返回结构化报告，失败原因要能说清（不静默失败）
   * ============================================================ */
  var UI_DEF = {
    selectText: '选课',
    confirmText: '确定',
    cancelText: '取消',
    stepMs: 60,
    maxMs: 5000
  };

  function isVisible(el) {
    try {
      if (!el || !el.getBoundingClientRect) return false;
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      var st = window.getComputedStyle(el);
      if (!st || st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.05) return false;
      return true;
    } catch (e) { return false; }
  }

  function textOf(el) {
    try {
      return String((el.innerText || el.textContent || el.value || '') + '').replace(/\s+/g, ' ').trim();
    } catch (e) { return ''; }
  }

  /** 所有「可点的元素」——按钮/链接/带 role=button 的，宽范围扫，靠文字筛 */
  function clickables(root) {
    var out = [];
    try {
      var list = (root || document).querySelectorAll('button, a, input[type=button], input[type=submit], [role=button], [onclick], .btn, .el-button, .ant-btn');
      for (var i = 0; i < list.length; i++) out.push(list[i]);
    } catch (e) { /* ignore */ }
    return out;
  }

  /** 精确匹配优先：文字完全等于目标词 > 以目标词开头 > 包含目标词（避免「退课」被「选课」误命中） */
  function findButton(word, opts) {
    var want = String(word || '');
    var exclude = (opts && opts.exclude) ? opts.exclude : null;
    var minTop = (opts && opts.minTop) || 0;   // 只找这个纵向位置以下的（弹框里的按钮通常在下面）
    var cands = clickables();
    var best = null, bestScore = -1;
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      if (!isVisible(el)) continue;
      if (minTop) {
        try { if (el.getBoundingClientRect().top < minTop) continue; } catch (e) { continue; }
      }
      var t = textOf(el);
      if (!t || t.length > 20) continue;
      if (exclude && exclude.test(t)) continue;
      var score = -1;
      if (t === want) score = 100;
      else if (new RegExp('^' + want + '$').test(t)) score = 90;
      else if (t.indexOf(want) === 0) score = 70;
      else if (t.indexOf(want) !== -1) score = 40;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return bestScore >= 40 ? best : null;
  }

  /** 找一门课所在的那一行，并在行内找「选课」按钮。
   *  定位键优先用课程代码（同名教学班多，课程名不可靠）。 */
  function findSelectButtonFor(keyText, ui) {
    var key = String(keyText || '').trim();
    if (!key) return { el: null, why: '没给定位键（课程代码/课程名）' };
    // 1) 找到含该关键字的最内层元素
    var hits = [];
    try {
      var all = document.querySelectorAll('td, div, span, a, p, li, label');
      for (var i = 0; i < all.length && i < 8000; i++) {
        var t = textOf(all[i]);
        if (t && t.indexOf(key) !== -1 && t.length < 400) hits.push(all[i]);
      }
    } catch (e) { /* ignore */ }
    if (!hits.length) return { el: null, why: '页面上找不到「' + key + '」' };
    var selRe = new RegExp('^' + ui.selectText + '$');
    // 2) 从最内层命中的元素向上找祖先，看谁的子树里有「选课」按钮
    for (var h = 0; h < hits.length && h < 40; h++) {
      var node = hits[h];
      for (var up = 0; up < 8 && node; up++) {
        var btn = findButton(ui.selectText, { exclude: /退课|已选|取消/, root: node });
        var inner = null;
        try {
          var cands = clickables(node);
          for (var ci = 0; ci < cands.length; ci++) {
            var cand = cands[ci];
            if (!isVisible(cand)) continue;
            var ct = textOf(cand);
            if (selRe.test(ct)) { inner = cand; break; }
          }
        } catch (e) { /* ignore */ }
        var target = inner || btn;
        if (target) return { el: target, row: node, why: 'ok' };
        node = node.parentElement;
      }
    }
    return { el: null, why: '找到「' + key + '」但没有在同一行里找到「' + ui.selectText + '」按钮' };
  }

  /** 去掉模态框文字里混进来的按钮标签（innerText 会把「确定」「取消」也算进去，
   *  导致日志里出现「…（#6qz9u）确定」这种尾巴） */
  function cleanModalText(text, ui) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    [ui.confirmText, ui.cancelText, '确定', '取消', '关闭', 'OK'].forEach(function (w) {
      if (!w) return;
      var re = new RegExp('\\s*' + String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$');
      for (var i = 0; i < 3 && re.test(t); i++) t = t.replace(re, '').trim();
    });
    return t;
  }

  /** 页面上有没有遗留的提示框（例如上次的「选课失败!」）——它会挡住后续点击 */
  function findBlockingModal(ui) {
    var okBtn = findButton(ui.confirmText, {});
    if (!okBtn) return null;
    // 往上找有「模态」特征的祖先：半透明遮罩/高 z-index/居中
    var node = okBtn;
    for (var up = 0; up < 6 && node; up++) {
      var t = cleanModalText(textOf(node), ui);
      if (t && /选课失败|选课成功|提示|警告|注意|确认|确定要/.test(t) && t.length < 300) {
        return { btn: okBtn, box: node, text: t.slice(0, 80) };
      }
      node = node.parentElement;
    }
    return null;
  }

  function waitFor(fn, timeoutMs, stepMs) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function tick() {
        var v = null;
        try { v = fn(); } catch (e) { v = null; }
        if (v) return resolve(v);
        if (Date.now() - t0 > timeoutMs) return resolve(null);
        setTimeout(tick, stepMs);
      })();
    });
  }

  /** 页面自己卡在「正在提交中」了吗？
   *  真实场景：页面自身那次提交撞上会话失效（401）后，它的 loading 弹框不会消失
   *  （「正在提交中，请耐心等待…… 提交中请勿刷新页面」），此时：
   *   · 整页被遮罩挡住，我们的 UI 点击要么点不到、要么点了也没用
   *   · 继续点只会叠加无效操作
   *  所以识别出来就**停止点击**并明确告知用户（唯一解法是刷新该页）。 */
  function findStuckSubmitting() {
    try {
      var all = document.querySelectorAll('div,p,span,h1,h2,h3,label');
      for (var i = 0; i < all.length && i < 4000; i++) {
        var t = textOf(all[i]);
        if (!t || t.length > 120) continue;
        if (/正在提交中|提交中，请|请勿刷新页面|正在处理中/.test(t) && isVisible(all[i])) {
          return { text: t.slice(0, 80), el: all[i] };
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function uiClickSelect(payload) {
    var p = payload || {};
    var ui = Object.assign({}, UI_DEF, p.ui || {});
    var report = { ok: false, ms: 0, steps: [], key: p.key || '', detail: '' };
    var t0 = Date.now();
    var say = function (s) { report.steps.push(s); };

    return Promise.resolve()
      .then(function () {
        /* 0）先看页面是不是自己卡在「正在提交中」——这是**页面自身**的状态，
         * 我们点不动也不该硬点（真实场景：页面提交撞上 401 后 loading 永不消失）。 */
        var stuck = findStuckSubmitting();
        if (stuck) {
          report.stuck = true;
          report.stuckText = stuck.text;
          say('页面自身卡在「' + stuck.text + '」，已放弃点击（这种情况需要刷新该页面）');
          throw new Error('页面卡在「' + stuck.text + '」——这是页面自己的提交遮罩，请刷新该页面后重新进入选课页');
        }
        // ① 再清理遗留弹框，否则点击会被挡住
        var box = findBlockingModal(ui);
        if (box) {
          say('先关闭遗留提示框：「' + box.text.slice(0, 30) + '」');
          try { box.btn.click(); } catch (e) { /* ignore */ }
          return waitFor(function () { return !findBlockingModal(ui); }, 1200, ui.stepMs);
        }
        return null;
      })
      .then(function () {
        // ② 找目标那一行的「选课」按钮
        var found = findSelectButtonFor(p.key, ui);
        report.found = !!found.el;
        report.detail = found.why;
        if (!found.el) { say('没找到按钮：' + found.why); throw new Error(found.why); }
        say('找到「' + ui.selectText + '」按钮');
        report.clickedSelect = true;
        try { found.el.click(); } catch (e) { throw new Error('点击「' + ui.selectText + '」失败：' + e.message); }
        return waitFor(function () {
          // ③ 等确认框（排除掉「选课」按钮本身，取更靠下的那个「确定」）
          var b = findButton(ui.confirmText, { exclude: /取消/, minTop: 0 });
          if (!b) return null;
          // 判断它是否在弹框里
          var node = b, inModal = false;
          for (var up = 0; up < 6 && node; up++) {
            var t = textOf(node);
            if (t && /确定要选择|确认|提示|选课/.test(t) && t.length < 300) { inModal = true; break; }
            node = node.parentElement;
          }
          return inModal ? b : null;
        }, ui.maxMs, ui.stepMs);
      })
      .then(function (confirmBtn) {
        if (!confirmBtn) {
          say('没等到确认框（可能这个系统点击后直接提交了，或弹框文字不是「' + ui.confirmText + '」）');
          report.modalFound = false;
          report.ok = true;               // 已经点过选课，可能已经发出请求
          return null;
        }
        report.modalFound = true;
        say('确认框出现，点「' + ui.confirmText + '」');
        try { confirmBtn.click(); } catch (e) { throw new Error('点击「' + ui.confirmText + '」失败：' + e.message); }
        report.clickedConfirm = true;
        return waitFor(function () { return true; }, 120, ui.stepMs);
      })
      .then(function () {
        // ④ 等结果弹框出现并关掉它（否则下一次点击会被挡住）
        return waitFor(function () {
          var b = findBlockingModal(ui);
          return b && /选课失败|选课成功/.test(b.text) ? b : null;
        }, ui.maxMs, ui.stepMs);
      })
      .then(function (resultBox) {
        if (resultBox) {
          report.resultText = resultBox.text;
          say('结果提示：「' + resultBox.text.slice(0, 40) + '」，已关闭');
          try { resultBox.btn.click(); } catch (e) { /* ignore */ }
          report.dismissed = true;
        } else {
          say('没看到结果提示框（可能没弹，或已自动关闭）');
        }
        report.ok = !!(report.clickedSelect);
        report.ms = Date.now() - t0;
        return report;
      })
      .catch(function (e) {
        report.ok = false;
        report.error = String((e && e.message) || e);
        report.ms = Date.now() - t0;
        say('中止：' + report.error);
        return report;
      });
  }

  /* ============================================================
   * 六、小工具：把焦点放到登录表单的验证码输入框
   * ------------------------------------------------------------
   * 目的：把"重新登录"这件人工动作压到最短 —— 登录页自动开好了，
   * 光标已经在验证码框里，你只要敲 4 个字符然后回车。
   * 不做自动填账号密码（那是浏览器密码管理器的事），也不做自动提交。
   * ============================================================ */
  function focusCaptchaField() {
    var pat = /(verify|yzm|captcha|vcode|checkcode|authcode|code)/i;
    var best = null, bestScore = -1;
    try {
      var inputs = document.querySelectorAll('input');
      for (var i = 0; i < inputs.length && i < 60; i++) {
        var el = inputs[i];
        if (!isVisible(el)) continue;
        var type = String(el.type || 'text').toLowerCase();
        if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'checkbox' || type === 'file') continue;
        var key = String(el.name || '') + ' ' + String(el.id || '') + ' ' + String(el.placeholder || '') + ' ' + String(el.className || '');
        var score = 0;
        if (pat.test(key)) score = 100;
        else if (type === 'password') score = 60;      // 退而求其次：密码框（多数人用密码管理器自动填，回车即可）
        else score = 10;
        // 已经填了内容的输入框优先（说明账号密码已被自动填充，就差验证码）
        if (el.value) score += 30;
        if (score > bestScore) { bestScore = score; best = el; }
      }
    } catch (e) { /* ignore */ }
    if (!best) return { ok: false, why: '没找到可聚焦的输入框' };
    try {
      best.focus();
      best.click();
      if (best.scrollIntoView) best.scrollIntoView({ block: 'center' });
      return { ok: true, name: best.name || best.id || best.type || 'input' };
    } catch (e) { return { ok: false, why: String(e.message || e) }; }
  }

  /* ============================================================
   * 四、消息通道
   * ============================================================ */
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__kx !== true || d.dir !== 'ext2page') return;

    switch (d.type) {
      case 'ping':
        post({ type: 'pong', id: d.id, href: location.href });
        break;
      case 'record':
        recordEnabled = !!d.enabled;
        post({ type: 'recording', id: d.id, enabled: recordEnabled });
        break;
      case 'replay': {
        var fn = d.via === 'xhr' ? doXhr : doFetch;
        fn(d.payload).then(function (result) {
          post({ type: 'replay-result', id: d.id, result: result });
        }, function (e) {
          post({ type: 'replay-result', id: d.id, result: { ok: false, status: 0, error: String(e) } });
        });
        break;
      }
      /* 探测页面里能拿到的东西 —— 用来找 csrfToken 这类「每次会话都会变、
       * 不能写死在配置里」的值。
       * 刻意**不使用 eval / new Function**：页面 CSP 常常没有 unsafe-eval，
       * 用了会直接抛错；这里只做属性访问、cookie 解析和 storage 遍历，CSP 拦不住。 */
      case 'probe-values': {
        var snap = {
          href: location.href,
          title: document.title,
          cookies: String(document.cookie || '').slice(0, 4000),
          cookieInfo: [],          // 只报名字和长度：取值时引擎会实时从页面读，不需要把值抄走
          globals: {},
          storage: { local: {}, session: {} },
          storageInfo: [],         // [{where,key,len,json}]
          metas: {},
          hits: []                 // 在 JSON 里按路径找到的 token 候选
        };
        try {
          String(document.cookie || '').split(';').forEach(function (seg) {
            var kv = seg.split('=');
            var n = String(kv[0] || '').trim();
            if (n) snap.cookieInfo.push({ name: n, len: String(kv.slice(1).join('=') || '').length });
          });
        } catch (e) { /* ignore */ }
        try {
          Object.keys(window).some(function (k, i) {
            if (i > 4000) return true;
            if (!/token|csrf|nonce|ticket|auth|sign/i.test(k)) return false;
            try {
              var v = window[k];
              if (typeof v === 'string' || typeof v === 'number') snap.globals[k] = String(v).slice(0, 300);
            } catch (e) { /* 有些全局属性 getter 会抛 */ }
            return false;
          });
        } catch (e) { /* ignore */ }

        /* 在 JSON 里按路径找 token：csrftoken 常被塞在某个字典 blob 深处
         * （真实案例：sessionStorage.xk_dicinfo 是个大 JSON，csrfToken 就在里面）。
         * 两条线索：① 键名像 token/csrf ② 值是 32 位十六进制（正方 csrfToken 的形态）。 */
        var walk = function (node, path, depth, out) {
          if (out.n > 4000 || depth > 4 || node == null) return;
          out.n++;
          if (typeof node !== 'object') {
            if (typeof node === 'string' && /^[0-9a-f]{32}$/i.test(node)) out.hex.push({ path: path, value: node });
            return;
          }
          Object.keys(node).forEach(function (k) {
            var p = path ? path + '.' + k : k;
            var v = node[k];
            if (/token|csrf|nonce/i.test(k) && (typeof v === 'string' || typeof v === 'number')) {
              out.named.push({ path: p, value: String(v).slice(0, 120) });
            }
            walk(v, p, depth + 1, out);
          });
        };

        try {
          [['localStorage', 'local'], ['sessionStorage', 'session']].forEach(function (pair) {
            var store = window[pair[0]];
            if (!store) return;
            var box = snap.storage[pair[1]];
            var n = 0;
            for (var i = 0; i < store.length && n < 200; i++, n++) {
              var key = store.key(i);
              var val = String(store.getItem(key) == null ? '' : store.getItem(key));
              snap.storageInfo.push({ where: pair[1], key: key, len: val.length, head: val.slice(0, 40) });
              box[key] = val.slice(0, 300);
              if (val && (val[0] === '{' || val[0] === '[')) {
                try {
                  var out = { n: 0, named: [], hex: [] };
                  walk(JSON.parse(val), pair[1] + '.' + key, 0, out);
                  out.named.forEach(function (h) { snap.hits.push({ where: h.path, value: h.value, kind: 'named' }); });
                  out.hex.forEach(function (h) { snap.hits.push({ where: h.path, value: h.value, kind: 'hex32' }); });
                } catch (e) { /* 不是 JSON 就算了 */ }
              }
            }
          });
        } catch (e) { /* ignore */ }
        try {
          var metas = document.querySelectorAll('meta');
          for (var mi = 0; mi < metas.length && mi < 60; mi++) {
            var nm = metas[mi].getAttribute('name') || metas[mi].getAttribute('property') || '';
            if (nm && /token|csrf/i.test(nm)) snap.metas[nm] = String(metas[mi].getAttribute('content') || '').slice(0, 300);
          }
        } catch (e) { /* ignore */ }

        /* 大范围搜捕：csrfToken 常常既不进 cookie、也不进 storage、也不挂在 window 上，
         * 而是被页面自己的 JS 模块（闭包）持有 —— 那种情况从外部永远拿不到。
         * 但在放弃之前，先把这两个地方翻一遍：① 页面 HTML/内联脚本里的 32 位十六进制
         * ② window 上**任何**字符串属性里值为 32 位十六进制的（不看键名）。 */
        try {
          var html = String(document.documentElement && document.documentElement.outerHTML || '');
          var hexRe = /[0-9a-f]{32}/gi, mm, guardH = 0;
          while ((mm = hexRe.exec(html)) !== null && guardH++ < 40) {
            snap.hits.push({
              where: 'HTML@' + mm.index,
              value: mm[0],
              kind: 'html-hex32',
              ctx: html.slice(Math.max(0, mm.index - 70), mm.index).replace(/[\r\n]+/g, ' ')
            });
          }
        } catch (e) { /* ignore */ }
        try {
          var names = Object.getOwnPropertyNames(window);
          for (var wi = 0; wi < names.length && wi < 6000; wi++) {
            var nm2 = names[wi];
            var v2;
            try { v2 = window[nm2]; } catch (e) { continue; }
            if (typeof v2 === 'string' && /^[0-9a-f]{32}$/i.test(v2)) {
              snap.hits.push({ where: 'window.' + nm2, value: v2, kind: 'window-hex32' });
            }
          }
        } catch (e) { /* ignore */ }
        try {
          var inputs = document.querySelectorAll('input');
          for (var ii = 0; ii < inputs.length && ii < 200; ii++) {
            var iv = String(inputs[ii].value || '');
            if (/^[0-9a-f]{32}$/i.test(iv)) {
              snap.hits.push({ where: 'input[' + (inputs[ii].name || inputs[ii].id || ii) + ']', value: iv, kind: 'input-hex32' });
            }
          }
        } catch (e) { /* ignore */ }
        post({ type: 'probe-values', id: d.id, snapshot: snap });
        break;
      }
      /* UI 点击：让页面自己完成「选课 → 确定」。
       * 主要用于混合模式下的"喂 token"：页面自己发请求时才会带上它内部的 csrfToken，
       * 我们录到那次请求就能学到 token，之后再用 API 高速盲发。 */
      case 'ui-click': {
        uiClickSelect(d.payload).then(function (report) {
          post({ type: 'ui-click-result', id: d.id, report: report });
        }, function (e) {
          post({ type: 'ui-click-result', id: d.id, report: { ok: false, error: String(e) } });
        });
        break;
      }
      case 'focus-captcha': {
        var fr = focusCaptchaField();
        post({ type: 'focus-captcha-result', id: d.id, result: fr });
        break;
      }
      default:
        break;
    }
  });

  post({ type: 'ready', href: location.href });
})();
