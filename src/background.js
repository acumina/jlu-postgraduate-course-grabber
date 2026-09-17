/* ============================================================
 * background.js —— MV3 service worker（协调层，不跑引擎）
 * ------------------------------------------------------------
 * 引擎刻意放在页面里（content script）跑，因为：
 *   · 只有页面同源发包才能带上 SameSite 会话 Cookie
 *   · SW 会被浏览器随时回收，定时器不靠谱
 * 这里只负责：工作标签页登记、角标、桌面通知、webhook、
 * 掉线后自动重新拉起工作页、以及其他页面加载后的「自动继续」探测。
 * ============================================================ */
import './lib/config.js';

const KX = globalThis.KX;
const WORKER_KEY = 'kx_worker';
const RUNTIME_KEY = 'kx_runtime';
const LOGIN_FLOW_KEY = 'kx_login_flow';
const ALARM = 'kx-watchdog';

const S = {
  workerTabId: null,
  workerWindowId: null,
  lastStatus: null,
  lastProbeHint: 0
};

/* ---------------- 基础工具 ---------------- */
async function store(key, val) {
  try { await chrome.storage.local.set({ [key]: val }); } catch (e) { /* ignore */ }
}
async function fetchStore(key) {
  try { const g = await chrome.storage.local.get(key); return g ? g[key] : null; } catch (e) { return null; }
}

/** SW 里没有页面日志，只能打控制台（chrome://extensions → 服务工作线程） */
function consoleLog(...args) { try { console.log('[KX/bg]', ...args); } catch (e) { /* ignore */ } }

function setBadge(status) {  try {
    const on = status && status.running;
    const lost = status && status.auth && status.auth.state === 'lost';
    const text = on ? 'ON' : (lost ? '!' : '');
    chrome.action.setBadgeText({ text: text });
    if (text) chrome.action.setBadgeBackgroundColor({ color: on ? '#16a34a' : '#dc2626' });
    if (on) {
      const ok = (status.targets || []).filter(function (t) { return t.state === 'success'; }).length;
      chrome.action.setTitle({ title: '选课助手 · 抢课中' + (ok ? '（已成功 ' + ok + '）' : '') });
    } else {
      chrome.action.setTitle({ title: lost ? '选课助手 · 登录态已失效' : '选课助手' });
    }
  } catch (e) { /* ignore */ }
}

async function notifyUser(title, message, urgent) {
  if (!chrome.notifications) return;
  try {
    await chrome.notifications.create('kx-' + Date.now(), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: String(title || '选课助手').slice(0, 60),
      message: String(message || '').slice(0, 320),
      priority: urgent ? 2 : 1,
      requireInteraction: !!urgent
    });
  } catch (e) {
    // 没有图标等异常时退化为角标闪烁
    try { chrome.action.setBadgeBackgroundColor({ color: '#dc2626' }); chrome.action.setBadgeText({ text: '!' }); } catch (e2) {}
  }
  if (urgent) beepTitle(title);
}

let beepTimer = null;
function beepTitle(title) {
  try {
    let n = 0;
    if (beepTimer) clearInterval(beepTimer);
    const base = '选课助手 · ' + String(title || '').slice(0, 20);
    beepTimer = setInterval(function () {
      n++;
      chrome.action.setTitle({ title: (n % 2 ? '⚠ ' : '') + base });
      if (n > 5) { clearInterval(beepTimer); beepTimer = null; chrome.action.setTitle({ title: '选课助手' }); }
    }, 700);
  } catch (e) { /* ignore */ }
}

async function postWebhook(url, text) {
  if (!url) return;
  try {
    // 企业微信 / 钉钉机器人都接受 msgtype=text 的结构
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text } })
    });
  } catch (e) { /* ignore */ }
}

async function sendToContent(tabId, msg) {
  if (tabId == null) return null;
  try { return await chrome.tabs.sendMessage(tabId, Object.assign({ to: 'content' }, msg)); }
  catch (e) { return null; }
}

function workerUrlFrom(cfg, fallback) {
  if (fallback) return fallback;
  if (cfg.worker && cfg.worker.url) return cfg.worker.url;
  const site = (cfg.sites || [])[0];
  return site ? 'https://' + KX.normalizeSite(site) + '/' : '';
}

/* ---------------- 消息处理 ---------------- */
async function handle(msg, sender) {
  const type = msg && msg.type;
  const tabId = sender && sender.tab ? sender.tab.id : null;

  switch (type) {
    case 'kx:whoami':
      return { ok: true, tabId: tabId, windowId: sender && sender.tab ? sender.tab.windowId : null, url: sender && sender.tab ? sender.tab.url : '' };

    case 'kx:claim-worker': {
      S.workerTabId = msg.tabId != null ? msg.tabId : tabId;
      S.workerWindowId = sender && sender.tab ? sender.tab.windowId : null;
      await store(WORKER_KEY, { tabId: S.workerTabId, windowId: S.workerWindowId, href: msg.href || '', at: Date.now() });
      return { ok: true, tabId: S.workerTabId };
    }

    case 'kx:status': {
      S.lastStatus = msg.status || null;
      if (msg.status && msg.status.running && tabId != null && S.workerTabId == null) {
        S.workerTabId = tabId;
        await store(WORKER_KEY, { tabId: tabId, href: msg.status.href, at: Date.now() });
      }
      setBadge(S.lastStatus);
      return { ok: true };
    }

    case 'kx:notify':
      await notifyUser(msg.title, msg.message, msg.urgent);
      return { ok: true };

    case 'kx:webhook': {
      const cfg = await KX.load();
      await postWebhook((cfg.notify || {}).webhook, msg.text || '');
      return { ok: true };
    }

    /* 把抓包/日志推给本地收集器（tools/collector.mjs）。
     * 放在 SW 里发的原因：扩展源的 fetch 不受页面 CORS / SameSite 限制，也不带站点 Cookie。 */
    case 'kx:push': {
      if (!msg.url) return { ok: false, error: '没有收集器地址' };
      if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(msg.url)) {
        return { ok: false, error: '收集器地址必须是本机 http://127.0.0.1:<端口>/… （拒绝把抓包发到外部地址）' };
      }
      try {
        const r = await fetch(msg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(msg.payload || {})
        });
        const text = await r.text();
        return { ok: r.ok, status: r.status, body: text.slice(0, 400) };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    }

    case 'kx:ping-collector': {
      if (!msg.url) return { ok: false, error: '没有收集器地址' };
      if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(msg.url)) {
        return { ok: false, error: '只允许探测本机地址' };
      }
      try {
        const r = await fetch(msg.url, { cache: 'no-store' });
        const text = await r.text();
        let body = null;
        try { body = JSON.parse(text); } catch (e) { body = { raw: text.slice(0, 200) }; }
        return { ok: r.ok, status: r.status, body: body };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    }

    case 'kx:open-login': {
      const cfg = await KX.load();
      const url = msg.url || (cfg.session || {}).loginUrl;
      if (!url) return { ok: false, error: '还不知道登录页地址' };
      try {
        /* mode:'tab' = 用**独立标签页**放登录页。插件"扫到真掉线"时用这个：
         * 绝不能把工作页跳走 —— 跳转=页面卸载=正在跑的引擎一起消失。 */
        if (msg.mode === 'tab') {
          /* 关键：**先找有没有已经开着的登录页**。有就切过去，绝不再开一个 ——
           * 真实事故：登录快过期时一遍遍弹新标签页（页面级去重被"掉线→恢复"重置了），
           * 用户反馈"疯狂弹出新页面"。判断"已开着"用路径比较（忽略查询串）。 */
          try {
            const all = await chrome.tabs.query({});
            const want = (function () {
              try { const u = new URL(url); return u.origin + u.pathname; } catch (e) { return url; }
            })();
            const exist = all.find(function (t) {
              if (!t.url) return false;
              try { const u = new URL(t.url); return (u.origin + u.pathname) === want; } catch (e) { return false; }
            });
            if (exist) {
              await chrome.tabs.update(exist.id, { active: msg.activate !== false });
              if (exist.windowId != null) await chrome.windows.update(exist.windowId, { focused: true });
              consoleLog('登录页已经开着，切过去（不新开）：' + url);
              return { ok: true, tabId: exist.id, mode: 'tab', reused: true };
            }
          } catch (e) { /* 查不到就当没开着，走下面的新建 */ }
          const t = await chrome.tabs.create({ url: url, active: msg.activate !== false });
          return { ok: true, tabId: t.id, mode: 'tab' };
        }
        const target = S.workerTabId != null ? S.workerTabId : tabId;
        if (target != null) {
          await chrome.tabs.update(target, { url: url, active: true });
          const t = await chrome.tabs.get(target);
          if (t && t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
        } else {
          await chrome.tabs.create({ url: url, active: true });
        }
        return { ok: true, mode: 'worker' };
      } catch (e) { return { ok: false, error: String(e.message || e) }; }
    }

    case 'kx:open-worker': {
      const cfg = await KX.load();
      const url = workerUrlFrom(cfg, msg.url);
      if (!url) return { ok: false, error: '没有可用地址：先在弹窗里点「把当前站点加入白名单」' };
      try {
        if (msg.mode === 'popup') {
          // 小窗工作台：窗口可见 → 浏览器不会把定时器降频，抢课节奏最稳
          const w = await chrome.windows.create({ url: url, type: 'popup', width: 470, height: 360, left: 20, top: 20, focused: true });
          S.workerWindowId = w.id;
          if (w.tabs && w.tabs[0]) {
            S.workerTabId = w.tabs[0].id;
            await store(WORKER_KEY, { tabId: S.workerTabId, windowId: w.id, href: url, at: Date.now() });
          }
        } else {
          const t = await chrome.tabs.create({ url: url, active: true });
          S.workerTabId = t.id;
          S.workerWindowId = t.windowId;
          await store(WORKER_KEY, { tabId: t.id, windowId: t.windowId, href: url, at: Date.now() });
        }
        return { ok: true, url: url };
      } catch (e) { return { ok: false, error: String(e.message || e) }; }
    }

    case 'kx:get': {
      const cfg = await KX.load();
      return { ok: true, config: cfg, status: S.lastStatus, workerTabId: S.workerTabId };
    }

    default:
      return { ok: false, error: '未知消息 ' + type };
  }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  const type = msg && msg.type;
  if (!type || String(type).indexOf('kx:') !== 0) return;   // 不认识的直接放过
  handle(msg, sender).then(sendResponse, function (e) {
    sendResponse({ ok: false, error: String((e && e.message) || e) });
  });
  return true;
});

/* ---------------- 通知点击 → 聚焦工作页 ---------------- */
if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener(async function () {
    try {
      let id = S.workerTabId;
      if (id == null) {
        const w = await fetchStore(WORKER_KEY);
        id = w && w.tabId;
      }
      if (id != null) {
        const t = await chrome.tabs.get(id);
        await chrome.tabs.update(id, { active: true });
        if (t && t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
      }
    } catch (e) { /* ignore */ }
  });
}

/* ---------------- 工作标签页被关掉 ---------------- */
chrome.tabs.onRemoved.addListener(async function (tabId) {
  if (tabId !== S.workerTabId) return;
  S.workerTabId = null;
  await store(WORKER_KEY, null);
  const rt = await fetchStore(RUNTIME_KEY);
  if (rt && rt.status === 'running') {
    await notifyUser('工作标签页已关闭', '抢课已停止。需要的话点通知或用弹窗重新打开「小窗工作台」。', true);
  }
  setBadge(null);
});

/* ---------------- 页面加载完成 → 掉线自动恢复探测 / 识别「你登录过」 ---------------- */
chrome.tabs.onUpdated.addListener(async function (tabId, info, tab) {
  if (info.status !== 'complete' || !tab || !tab.url) return;
  if (!/^https?:/i.test(tab.url)) return;
  const cfg = await KX.load();
  const host = KX.hostOf(tab.url);
  const onSite = KX.siteAllowed(host, cfg.sites);
  const st0 = cfg.session || {};

  /* 识别"像登录页的导航"，用来判断「你刚重新登录过」。
   *
   * 真实事故：原来注释写着"不管登录页在不在白名单域名下，只要 URL 像登录页就记下来"，
   * 判定规则是 loginUrlRe=/(login|sso|cas|auth)/ —— 于是用户逛到任何一个地址里含
   * /login 的网站（例如 https://kitty.fo/login）都会**覆盖**掉他配置好的学校登录页地址。
   * 而对这个系统来说，真正的登录页 URL（.../xsxkapp/index.html）里根本没有
   * login/sso/cas/auth —— 这条规则**只能捡到误报、学不到正确值**。
   *
   * 现在的规则：
   *   ① **只有白名单站点上的 URL 才写进配置**（外部域名一律不写）
   *   ② 外部域名的"像登录页"只用来标记「你刚重新登录过」（这个判断本身有价值：
   *      登录可能发生在别的域，插件不在那儿）
   *   ③ 排除验证码类 URL（它每次登录都会出现，不是登录页） */
  let urlLooksLogin = false;
  try { urlLooksLogin = !!st0.loginUrlRe && new RegExp(st0.loginUrlRe, 'i').test(tab.url); } catch (e) { urlLooksLogin = false; }
  const looksLogin = urlLooksLogin && !/vcode|captcha/i.test(tab.url);
  if (looksLogin) {
    await store(LOGIN_FLOW_KEY, { at: Date.now(), url: tab.url, host: host });
    if (onSite && st0.loginUrl !== tab.url) {
      await KX.save({ session: { loginUrl: tab.url } });
      consoleLog('记住登录页地址（白名单站点内）：' + tab.url);
    } else if (!onSite) {
      consoleLog('外部域名的登录类页面：只记"刚登录过"标记，不写入登录页配置 —— ' + tab.url);
    }
  }

  /* 不在白名单站点上就不做后续的掉线恢复探测（内容脚本没注入那儿） */
  if (!onSite) return;

  const rt = await fetchStore(RUNTIME_KEY);
  const needsProbe = rt && (rt.resumePending || (rt.auth && rt.auth.state === 'lost'));
  if (!needsProbe) return;
  if (Date.now() - S.lastProbeHint < 5000) return;   // 防止同一时刻多标签页重复探测
  S.lastProbeHint = Date.now();
  setTimeout(function () {
    sendToContent(tabId, { type: 'kx:cmd', cmd: 'probe' });
  }, 1200);
});

/* ---------------- 看门狗：工作页没了就（按配置）拉回来 ---------------- */
chrome.alarms.create(ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async function (a) {
  if (a.name !== ALARM) return;
  const cfg = await KX.load();
  const rt = await fetchStore(RUNTIME_KEY);
  const shouldWork = cfg.enabled || (rt && rt.resumePending);

  // 工作页是否还在
  let alive = false;
  if (S.workerTabId != null) {
    try { await chrome.tabs.get(S.workerTabId); alive = true; } catch (e) { alive = false; }
  }
  if (!alive) {
    const w = await fetchStore(WORKER_KEY);
    if (w && w.tabId != null) {
      try { await chrome.tabs.get(w.tabId); S.workerTabId = w.tabId; alive = true; } catch (e) { alive = false; }
    }
  }
  if (alive) return;

  if (shouldWork && (cfg.worker || {}).autoOpen !== false) {
    const url = workerUrlFrom(cfg, '');
    if (url) {
      try {
        const t = await chrome.tabs.create({ url: url, active: false });
        S.workerTabId = t.id;
        await store(WORKER_KEY, { tabId: t.id, href: url, at: Date.now() });
        await notifyUser('已自动恢复工作页', '检测到工作标签页不在了，已重新打开 ' + url + '（若页面在后台，节奏可能被降频）', false);
      } catch (e) { /* ignore */ }
    }
  }
  setBadge(S.lastStatus);
});

chrome.runtime.onInstalled.addListener(async function () {
  await KX.load(true);
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
});
