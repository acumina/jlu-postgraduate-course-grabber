/* ============================================================
 * content.js —— 引擎 + 中继 + 应用门面（跑在 isolated world）
 * ------------------------------------------------------------
 * 职责：
 *   1. 站点白名单判断（不在白名单就彻底不干活）
 *   2. 注入 bridge.js（MAIN world）并做消息中继
 *   3. 录包缓冲（内存全量 + storage 限流持久化）
 *   4. 限速闸门（最小间隔 / 每分钟上限）
 *   5. 登录态看门狗（硬超时倒计时、掉线停机、重新登录后自动继续）
 *   6. 抢课引擎（先查余量再抢 / 盲发两种模式）
 *   7. 暴露 KXApp 给 panel.js，并响应 popup / background 的指令
 * ============================================================ */
(function () {
  'use strict';

  const KX = globalThis.KX;
  const R = globalThis.KXRules;
  if (!KX || !R) { console.warn('[KX] 共享库未加载，插件不工作'); return; }

  const HOST = location.hostname.toLowerCase();
  const RUNTIME_KEY = 'kx_runtime';
  const UI_KEY = 'kx_ui';
  const LOGIN_FLOW_KEY = 'kx_login_flow';   // background 发现你访问过登录页时写的标记

  let ACTIVE = false;          // 当前站点是否在白名单里
  let bridgeReady = false;
  let myTabId = null;
  let destroyed = false;

  /* ============================================================
   * 小工具
   * ============================================================ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  const normId = (s) => String(s == null ? '' : s).trim().replace(/^0+(?=\d)/, '');
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const hhmmss = (d) => {
    const t = new Date(d);
    const p = (n) => String(n).padStart(2, '0');
    return p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds());
  };
  const timeStr = (ts) => (ts ? hhmmss(ts) : '-');

  function sameOrigin(u) {
    try { return new URL(u, location.href).origin === location.origin; } catch (e) { return false; }
  }

  function addCacheBuster(u) {
    try {
      const url = new URL(u, location.href);
      url.searchParams.set('_kx', String(Date.now()));
      return url.href;
    } catch (e) { return u; }
  }

  function stripHash(u) { return String(u || '').split('#')[0]; }

  /* 浏览器自己会带的头不要手工设（设了也会被忽略，留着只会误导） */
  const DROP_HEADER = /^(cookie|cookie2|host|content-length|connection|origin|referer|accept-encoding|user-agent|sec-|sec-ch-|proxy-|upgrade|te$|trailer|transfer-encoding|expect|keep-alive|via|dnt|:)/i;
  function cleanHeaders(h) {
    const out = {};
    Object.keys(h || {}).forEach(function (k) {
      const key = String(k).trim();
      if (!key || DROP_HEADER.test(key)) return;
      out[key] = h[k];
    });
    return out;
  }

  function guessCt(entry) {
    const h = entry.reqHeaders || {};
    let ct = h['Content-Type'] || h['content-type'] || entry.respType || '';
    ct = String(ct).toLowerCase();
    if (ct.indexOf('json') !== -1) return 'json';
    if (ct.indexOf('form') !== -1) return 'form';
    if (!entry.reqBody) return 'raw';
    if (/^\s*[{[]/.test(entry.reqBody)) return 'json';
    if (/^[^=&\s]+=[^&]*/.test(entry.reqBody)) return 'form';
    return 'raw';
  }

  /* ============================================================
   * 日志
   * ============================================================ */
  const LOG_MAX = 400;
  const logs = [];
  let logSeq = 0;

  let popupLogTimer = null;
  let lastAggPush = 0;
  function pushPopupLog() {
    if (popupLogTimer) return;
    popupLogTimer = setTimeout(async function () {
      popupLogTimer = null;
      try {
        await chrome.storage.local.set({
          kx_popup_log: logs.slice(-10).map(function (l) { return { level: l.level, msg: l.msg, t: l.t, count: l.count || 1 }; })
        });
      } catch (e) { /* ignore */ }
    }, 1000);
  }

  /**
   * 写日志。
   * opts.key：带 key 的连续同类日志会**就地合并**（盲发模式每秒十几行「▶ 提交」，
   * 不合并的话日志页全是重复内容，真正的状态变化和错误全被埋掉）。
   * 面板里显示为「同一行 + ×N」；推给收集器的原始文件只在合并条目不频繁时补一条，
   * 避免文件爆炸（要逐次细节可以看面板的 ×N 和提交次数统计）。
   */
  function log(level, msg, extra, opts) {
    const item = {
      i: ++logSeq, t: Date.now(), level: level || 'info',
      msg: String(msg), key: (opts && opts.key) || ''
    };
    if (extra && extra.length) item.extra = String(extra).slice(0, 2000);
    const r = KX.aggregatePush(logs, item, LOG_MAX);
    pushPopupLog();
    if (typeof queuePushLog === 'function') {
      if (!r.merged || Date.now() - lastAggPush > 10000) { lastAggPush = Date.now(); queuePushLog(item); }
    }
    if (typeof console !== 'undefined') {
      const fn = level === 'err' ? 'error' : level === 'warn' ? 'warn' : 'log';
      // 合并的重复条目不再往控制台刷，否则 console 也被淹没
      if (!r.merged) console[fn]('[KX]', msg, extra || '');
    }
    if (globalThis.KXPanel && KXPanel.mounted) KXPanel.log(r.item);
    if (level === 'ok' || level === 'err') broadcastStatus();
    return r.item;
  }

  /* ============================================================
   * 录包缓冲
   * ============================================================ */
  const CAP_MAX = 300;
  const captures = [];
  let capSeq = 0;
  let capFlushTimer = null;
  const capPersistQueue = [];

  function interesting(entry) {
    if (!entry || !entry.url) return false;
    if (/\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i.test(entry.url)) return false;
    if (entry.method === 'POST') return true;
    if (/json|xml|html|text/i.test(entry.respType || '')) return true;
    return false;
  }

  function onCapture(entry) {
    if (!entry) return;
    entry.id = 'c' + (++capSeq);
    captures.push(entry);
    while (captures.length > CAP_MAX) captures.shift();
    if (globalThis.KXPanel && KXPanel.mounted) KXPanel.capture(entry);
    // 顺手从页面自己的请求里学 csrfToken 之类的会话参数（用户手工点一次就能学到）
    try { learnTokensFrom(entry); } catch (e) { /* ignore */ }
    // 同域登录检测：登录请求本身就是「你刚登录了」的证据
    try { noteLoginRequest(entry); } catch (e) { /* ignore */ }
    // 推给本地收集器前先抹掉 Cookie/Authorization —— 凭据连 127.0.0.1 也不发
    if (pushCfg().autoPush && pushCfg().collectorUrl && !pushMuted && globalThis.KXExport) {
      queuePush(KXExport.redactCapture(entry));
    }
    if (!interesting(entry)) return;

    capPersistQueue.push({
      id: entry.id,
      kind: entry.kind,
      method: entry.method,
      url: entry.url,
      reqHeaders: entry.reqHeaders,
      reqBody: entry.reqBody,
      status: entry.status,
      respType: entry.respType,
      resp: (entry.resp || '').slice(0, 4000),
      ms: entry.ms,
      ts: entry.ts
    });
    if (capFlushTimer) return;
    capFlushTimer = setTimeout(async function () {
      capFlushTimer = null;
      const batch = capPersistQueue.splice(0, capPersistQueue.length);
      try {
        const a = chrome.storage.local;
        const got = await a.get(KX.CAPTURE_KEY);
        const list = (got && got[KX.CAPTURE_KEY]) || [];
        batch.forEach(function (b) { list.push(b); });
        while (list.length > 40) list.shift();
        await a.set({ [KX.CAPTURE_KEY]: list });
      } catch (e) { /* ignore */ }
    }, 600);
  }

  /* ============================================================
   * 与页面（MAIN world）通信
   * ============================================================ */
  const pending = new Map();     // id -> {resolve, timer}
  const bridgeWaiters = [];

  function injectBridge() {
    try {
      const el = document.createElement('script');
      el.src = chrome.runtime.getURL('src/bridge.js');
      el.async = false;
      el.dataset.kx = '1';
      (document.head || document.documentElement).appendChild(el);
      el.addEventListener('load', function () { el.remove(); });
    } catch (e) {
      log('err', '注入 bridge 失败：' + e.message);
    }
  }

  function toPage(msg, timeoutMs) {
    return new Promise(function (resolve) {
      const id = 'r' + KX.uid(9);
      const timer = setTimeout(function () {
        pending.delete(id);
        resolve({ timeout: true, error: '页面无响应（超时）' });
      }, timeoutMs || 20000);
      pending.set(id, { resolve: resolve, timer: timer });
      window.postMessage(Object.assign({ __kx: true, dir: 'ext2page', id: id }, msg), '*');
    });
  }

  function resolvePending(id, payload) {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve(payload);
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__kx !== true || d.dir !== 'page2ext') return;

    if (d.type === 'ready') {
      bridgeReady = true;
      while (bridgeWaiters.length) bridgeWaiters.shift()(true);
      log('sys', '页面桥接已就绪（' + (d.href || '') + '）');
      broadcastStatus();
      return;
    }
    if (d.type === 'capture') { onCapture(d.entry); return; }
    if (d.type === 'replay-result') { resolvePending(d.id, d.result); return; }
    if (d.type === 'ui-click-result') { resolvePending(d.id, d.report); return; }
    if (d.type === 'focus-captcha-result') { resolvePending(d.id, d.result); return; }
    /* 其余「带 id 的应答」统一交给等待它的调用者 —— 以前这里是逐个 type 硬编码
     * （pong / recording），结果新加的 probe-values 没人接，页面明明回了却被丢掉，
     * 表现成「页面没有响应」超时。用 id 兜底，以后加新消息类型不会再踩这个坑。 */
    if (d.id && pending.has(d.id)) { resolvePending(d.id, d); return; }
  });

  function ensureBridge(timeoutMs) {
    if (bridgeReady) return Promise.resolve(true);
    return new Promise(function (resolve) {
      const t = setTimeout(function () { resolve(false); }, timeoutMs || 5000);
      bridgeWaiters.push(function (ok) { clearTimeout(t); resolve(ok); });
    });
  }

  /** 真正的发包：让页面自己发（同源、带 Cookie、满足 SameSite）。
   *  限速（在飞名额 + 每分钟滑动窗口）就在这一层做 —— 所有请求都经过它，
   *  所以并发上限与速率上限是**全局生效**的，任何调用点都不可能绕过。 */
  async function replay(payload, via) {
    const ok = await ensureBridge(6000);
    if (!ok) return { ok: false, status: 0, error: '桥接未就绪：请刷新页面后重试' };
    const r = await sendPaced(function () {
      return toPage({ type: 'replay', via: via || 'fetch', payload: payload }, (payload.timeoutMs || 15000) + 4000);
    });
    if (r && r.timeout) return { ok: false, status: 0, error: '请求超时（页面无响应）' };
    return r || { ok: false, status: 0, error: '未知错误' };
  }

  function setRecording(on) {
    toPage({ type: 'record', enabled: !!on }, 3000).catch(function () {});
  }

  /* ============================================================
   * 限速闸门
   * ------------------------------------------------------------
   * 真实性能问题（用户实测只有 92 次/分钟，而上限是 600）：
   *   ① 请求是**串行**的：一个目标一个目标 await，中间还硬等 minGapMs（100ms）
   *      → 一轮 9 个目标光等待就 0.9 秒
   *   ② **后台标签页的定时器被浏览器降频**（setTimeout 钳到 1 秒以上），
   *      而我的节流/间隔全用 setTimeout 实现 → 每次等待被放大十倍
   * 结论：改成**并发**（在飞请求数受限），并且把"每个请求之间硬等"换成
   * "滑动窗口内不超过每分钟上限"。fetch 本身不受后台降频影响，所以并发路径
   * 在后台标签页里依然能跑满。
   *
   * 保留的安全边界：每分钟请求上限（滑动窗口）+ 最大在飞请求数。
   * minGapMs 的语义改为「**批次之间**的最小间隔」（不再卡住同一批里的并发）。
   * ============================================================ */
  const reqTimes = [];
  let inFlight = 0;
  let tokens = 0;                 // 令牌桶当前令牌数
  let tokensAt = Date.now();      // 上次补充令牌的时刻

  /** 目标速率（次/分钟）：取「每分钟上限」与「60000/发包最小间隔」的较小者 */
  function ratePerMinute() {
    const cfg = KX.snapshot();
    const perMin = clamp(Number(cfg.engine.maxReqPerMinute) || 120, 5, 3000);
    const gap = clamp(Number(cfg.engine.minGapMs) || 300, 100, 10000);
    return Math.max(1, Math.min(perMin, Math.floor(60000 / gap)));
  }

  /** 占一个"在飞名额"：超过 maxConcurrent 就等（20ms 轮询，等得很短） */
  async function acquireSlot() {
    const max = clamp(Number((KX.snapshot().engine || {}).maxConcurrent) || 1, 1, 50);
    let waited = 0;
    while (inFlight >= max) {
      await sleep(20);
      waited += 20;
      if (waited > 30000) break;      // 兜底：绝不死等
    }
    inFlight++;
  }
  function releaseSlot() { inFlight = Math.max(0, inFlight - 1); }

  /** 令牌桶节流：按目标速率**匀速**放行，桶容量决定"一次最多突发多少个"。
   *
   *  为什么用令牌桶而不是"滑动窗口"：并发改造后曾用滑动窗口，结果 400 次/分钟的预算在
   *  **14 秒内被瞬间烧光**，然后必须等窗口滑过去 —— 日志出现「等待 45104ms」，
   *  引擎看起来像停了 45 秒；而且"14 秒内 400 个请求"这种突发模式比匀速更容易被风控认出来。
   *
   *  桶容量（burstCap）的取舍 —— 这是为"标签页必须留在后台"准备的后路：
   *  · 默认 = 并发数：匀速、突发不超过并发数。但**标签页在后台时** Chrome 会把定时器
   *    限到每分钟 1 次，循环每分钟只醒一次 → 只能发掉桶里攒下的那几个 → 速率掉到 1/10。
   *  · 调大（如 120/400）：被降频时"每分钟醒一次、一次把攒下的额度全发出去"，
   *    速率能补回来，代价是**变成突发**（风控更容易注意到）。
   *  所以：能保持标签页可见就用默认值；必须挂后台再考虑调大。 */
  async function gate() {
    for (;;) {
      const rate = ratePerMinute();          // 次/分钟
      const perMs = rate / 60000;
      const cfg0 = KX.snapshot();
      const conc = clamp(Number((cfg0.engine || {}).maxConcurrent) || 1, 1, 50);
      const burstCfg = Number((cfg0.engine || {}).burstCap) || 0;
      const cap = burstCfg > 0 ? clamp(burstCfg, 1, 2000) : conc;
      const now = Date.now();
      tokens = Math.min(cap, tokens + (now - tokensAt) * perMs);
      tokensAt = now;
      if (tokens >= 1) {
        tokens -= 1;
        reqTimes.push(now);
        while (reqTimes.length && now - reqTimes[0] > 60000) reqTimes.shift();
        return;
      }
      const need = Math.max(10, (1 - tokens) / perMs);
      log('warn', '按速率排队中（目标 ' + rate + ' 次/分钟），约 ' + Math.round(need) + 'ms 后发下一个', '', { key: 'throttle' });
      await sleep(need);
    }
  }

  /** 一次「占用名额 + 过闸门 + 发请求」的完整包装：并发时每个请求各占一个名额 */
  async function sendPaced(fn) {
    await acquireSlot();
    try {
      await gate();
      return await fn();
    } finally {
      releaseSlot();
    }
  }

  /* ============================================================
   * 引擎状态
   * ============================================================ */
  const runtime = new Map();      // normId -> {state, tryCount, ...}
  const approved = new Set();     // 「提交前确认」模式下已确认的目标

  let running = false;
  let status = 'idle';            // idle | running | scheduled | halted | lost-login | monitor
  let statusText = '待机';
  let loopTimer = null;
  let schedTimer = null;
  let sessionTimer = null;
  let nextRunAt = 0;
  let backoffMult = 1;
  let board = [];                 // 自动轮询的快照（小 pageSize）
  let boardAt = 0;
  /* 人工「查询一次」拿到的全量列表**单独存**。
   * 真实教训：以前两者共用 board，人工查到 148 条后，1.5 秒后的自动轮询
   * 用 60 条把它覆盖了 —— 用户以为"查询没生效"。两个写入方不能抢同一份数据。 */
  let boardFull = [];
  let boardFullAt = 0;
  let warnFlighted = false;       // 硬超时预警只提醒一次
  let autoOpenedLogin = false;    // 「提前自动打开登录页」只做一次
  let lastAutoOpenTry = 0;        // 上次尝试自动打开登录页的时刻（地址未配置时的提示节流）
  /* 上次**真的打开了**登录页的时刻 —— 持久化到 storage，跨页面/跨重载共享。
   * 真实事故：原来只有页面级的 autoOpenedLogin 标记，而每次"掉线→恢复"都会把它重置，
   * 于是登录快过期时一遍遍弹新标签页（用户反馈："疯狂弹出新页面"）。 */
  let autoOpenAt = 0;
  let zeroFreeStreak = 0;         // 连续多少轮「一条余量都没有」
  let zeroFreeWarned = false;     // 自检告警过没有
  let hardTimeoutDisproved = false; // 实测证明不是硬超时（见 KX.isHardTimeoutDisproved）
  let authFailStreak = 0;          // 连续多少次体检在「网络层」失败
  let notFoundHinted = false;      // 「目标不在返回页里」的提示只吼一次
  let lastBoardSig = '';           // 上一轮余量快照的签名（用于日志节流）
  let cycleCursor = 0;             // 目标轮转游标（多目标时保证公平，不让后面的目标饿死）
  let hardTimeoutSuspectLogged = false; // 「配置里的硬超时值可疑」只提示一次
  let lastNovarsLog = 0;           // 「取不到 token 跳过提交」的日志节流
  let uiBlockedHere = false;       // 本页面 UI 点击判定不可用（页面没有课程列表），不再重试
  let keepAliveRecordLogged = false; // 保活突破记录只喊一次
  let lastEstimateProbeAt = 0;       // 「推定硬超时到点」的确认探测节流（只探测、绝不停机）
  let lastHaltAt = 0;                // 最近一次停机时刻（面板用来解释"实测速率为什么低"）
  let lastLostStallWarnAt = 0;       // 「掉线却长期没体检」的告警节流（防静默卡死）
  let lastProbeText = '';            // 最近一次体检结论的人话描述（面板直接显示）
  let uiFeedInFlight = false;        // 「UI 点击喂 token」是否正在进行（并发下只允许一个去点）
  let lastThrottleWarnAt = 0;        // 「浏览器后台降频」告警节流（这是代码绕不过的，必须让用户看见）
  /* 本页面是否（曾经）是工作标签页。
   * 真实 bug：自动打开登录页的条件原来是 `running`，但掉线会先 halt() → running=false，
   * 于是"该开登录页"的那一刻恰好不开（功能在最需要它的时候失效）。
   * 用这个标记记住"本页面就是干活的页面"，停机后依然成立。 */
  let thisPageWasWorker = false;
  /* 「响应内容命中未登录字样」这类弱证据的连续命中计数。
   * 弱证据单独一次不足以停机（会造成误停 + 误报）；连续两次才判定。 */
  let weakLostStreak = 0;
  let domLostStreak = 0;   // 「页面可见文字命中未登录」的连续命中计数（同样要求 2 次）

  const stats = {
    startedAt: 0, cycles: 0, queryOk: 0, queryErr: 0,
    submitTry: 0, submitOk: 0, submitFull: 0, submitErr: 0, halts: 0, lastReq: null
  };

  const auth = {
    state: 'unknown',   // unknown | ok | lost | suspect
    why: '',
    lastProbeAt: 0,
    lastOkAt: 0,
    observedAt: 0,      // 最后一次「确认会话有效」的时刻 —— 登录时刻估算的锚点
    loginAt: 0,         // 推定登录时刻（用于 20 分钟硬超时倒计时）
    loginSource: '',    // manual（你点的「我刚登录了」）| observed（探测推定的）
    lifetimeSamples: [], // 实测的会话寿命样本（毫秒），用来自动校准倒计时
    loginUrl: ''
  };

  function rtOf(id) {
    const k = normId(id);
    let rt = runtime.get(k);
    if (!rt) {
      rt = { state: 'idle', tryCount: 0, okCount: 0, failStreak: 0, lastMsg: '', lastAt: 0, nextAt: 0 };
      runtime.set(k, rt);
    }
    return rt;
  }

  function setState(rt, state, msg) {
    rt.state = state;
    if (msg !== undefined) rt.lastMsg = msg;
    rt.lastAt = Date.now();
    saveRuntime();
    if (globalThis.KXPanel && KXPanel.mounted) KXPanel.status(snapshotStatus());
  }

  function authLeftMs() {
    const st = KX.snapshot().session || {};
    return KX.authEstimate({
      loginAt: auth.loginAt,
      observedAt: auth.observedAt || auth.lastOkAt,
      hardTimeoutMs: effectiveHardTimeoutMs(),
      staleGapMs: st.loginAtStaleMs,
      now: Date.now()
    }).leftMs;
  }

  /* ============================================================
   * 会话寿命实测与自动校准
   * ------------------------------------------------------------
   * 真实教训：用户以为"登录满 20 分钟掉线"，实测是「登录后约 10 分钟绝对失效」。
   * 靠猜数值会导致预警和自动打开登录页全都偏晚。所以插件自己量：
   * 每次检测到掉线时，用「现在 − 推定登录时刻」当一次寿命样本，
   * 之后用样本里的最小值（留 30 秒余量）作为倒计时依据。
   * ============================================================ */
  const LIFETIME_KEY = 'kx_lifetime_samples';

  function effectiveHardTimeoutMs() {
    let cfgMs = Number((KX.snapshot().session || {}).hardTimeoutMs) || 0;
    /* 配置里 <3 分钟的值一律视为「被旧版本写坏的」：任何真实会话超时都不会这么短，
     * 而这种坏值会让倒计时刚登录就报"还剩 2 分钟"、并把刚起来的引擎误停机。
     * 修法：① 内存里改用兜底值（10 分钟）② 顺手把坏值写回配置修好（一次性repair，
     * 这不是"校准时写回配置"那种错误设计 —— 那是修我自己的 bug）。 */
    if (cfgMs > 0 && cfgMs < 180000) {
      const bad = cfgMs;
      cfgMs = 600000;
      if (!hardTimeoutSuspectLogged) {
        hardTimeoutSuspectLogged = true;
        log('err', '⚠ 配置里的会话超时是 ' + (bad / 60000).toFixed(1) + ' 分钟，这不合理（旧版本的错误校准写进去的）——'
          + '已改用 10 分钟并把配置修正。若你的系统确实更短，请到设置里手工改成正确值。');
        KX.save({ session: { hardTimeoutMs: 600000 } }).catch(function () { });
      }
    }

    /* 只信「像样」的样本，并取**最近 3 次测量里的最大值**。
     * 为什么是最大值：会话被提前终止的原因很多（你手动退出、换账号、被踢、切页面重新鉴权），
     * 那些都是"活过这么久"的**下界**，不是超时值本身；我们要估计的是"最多能活多久"。
     * 为什么按**时间顺序**取最近 3 次（而不是先按数值排序再取最大 3 个）：
     * 后者在有历史大样本时会一直压住新样本，超时真的变短了就跟不上（测试抓到过这个问题）。 */
    const samples = (auth.lifetimeSamples || [])
      .filter(function (v) { return v >= 180000 && v < 6 * 3600000; });   // 至少 3 分钟才算有效寿命
    if (!samples.length) return cfgMs;
    const recent = samples.slice(-3);
    const best = recent.reduce(function (m, v) { return Math.max(m, v); }, 0);
    const guess = Math.max(180000, best - 30000);   // 留 30 秒余量
    return cfgMs ? Math.min(cfgMs, guess) : guess;
  }

  function recordSessionDeath(where) {
    if (!auth.loginAt) return;
    /* 一次会话只统计一次！
     * 真实事故：掉线后每 30 秒的探测都会再报一次 401，每次都进这个函数，
     * 于是同一次掉线被记成 5 个"样本"（日志里 13.6 → 13.7 → 14.4 → 15.2 → 15.9 分钟连续增长），
     * 既污染估算（把一次观察放大成三次）又把日志刷满。 */
    if (auth.sampleForLoginAt && auth.sampleForLoginAt === auth.loginAt) return;
    auth.sampleForLoginAt = auth.loginAt;
    const life = Date.now() - auth.loginAt;
    /* 只统计「锚点之后确实确认过会话有效」的样本。
     * 否则会把「登录后页面残留旧状态导致的迟到误判」也算成一次"2 分钟寿命"，
     * 把校准值带偏（上面 effectiveHardTimeoutMs 的注释里有完整经过）。 */
    if (!auth.observedAt || auth.observedAt < auth.loginAt) {
      log('info', '探测到会话失效，但锚点之后没有确认过会话有效（可能是迟到的误判），这次不计入寿命样本。');
      return;
    }
    if (life < 180000 || life > 6 * 3600000) {
      log('info', '探测到会话失效，但推算存活时长 ' + (life / 60000).toFixed(1) + ' 分钟不合理（<3 分钟或 >6 小时），不计入寿命样本。');
      return;
    }
    if (!Array.isArray(auth.lifetimeSamples)) auth.lifetimeSamples = [];
    auth.lifetimeSamples.push(life);
    while (auth.lifetimeSamples.length > 5) auth.lifetimeSamples.shift();
    saveRuntime();
    const mins = (life / 60000).toFixed(1);
    const eff = effectiveHardTimeoutMs();
    log('warn', '实测到一次会话失效：从推定登录时刻起活了约 ' + mins + ' 分钟（来源：' + where + '）。'
      + '已累计 ' + auth.lifetimeSamples.length + ' 个样本，倒计时改用 '
      + (eff / 60000).toFixed(1) + ' 分钟（取最近 3 个样本的最大值 −30 秒 —— 提前结束的原因很多，'
      + '那些是下界，不是超时值）。' + (auth.lifetimeSamples.length >= 2 ? ' 多个样本可互证。' : ' 再来一次就能互证。'));
    /* 刻意**不**把校准值写回 session.hardTimeoutMs：校准是派生数据，写回用户配置会造成
     * "错误校准污染配置、且再也修不回来"（真实事故）。它只活在 runtime 里。 */
  }

  /* ============================================================
   * 运行时持久化（目标进度、统计、登录态、待恢复标记）
   * ============================================================ */
  let rtSaveTimer = null;
  function saveRuntime() {
    if (rtSaveTimer) return;
    rtSaveTimer = setTimeout(async function () {
      rtSaveTimer = null;
      const targets = {};
      runtime.forEach(function (v, k) { targets[k] = v; });
      try {
        await chrome.storage.local.set({
          [RUNTIME_KEY]: {
            targets: targets,
            stats: stats,
            auth: {
              state: auth.state, why: auth.why, loginAt: auth.loginAt, loginUrl: auth.loginUrl,
              lastOkAt: auth.lastOkAt, observedAt: auth.observedAt, loginSource: auth.loginSource,
              /* 必须持久化：漏了它的话，页面一刷新样本就空了，"配置里的可疑小值以实测为准"
               * 这道防线就没有实测值可用 → 只能退回被旧版本写坏的 2 分钟值（真实事故）。 */
              lifetimeSamples: (auth.lifetimeSamples || []).slice(0, 5),
              sampleForLoginAt: auth.sampleForLoginAt || 0
            },
            status: status,
            /* 是否处于「主动停机」（验证码/未开放这类刻意的安全停机）。
             * 页面/扩展重载后要区分两种情况：
             *   · 上次在抢课（enabled=true 且没主动停机）→ 应该自动恢复
             *   · 上次是主动停机（比如撞上验证码）→ 不该自动恢复，必须你手动点启动 */
            halted: status === 'halted',
            statusText: statusText,
            host: HOST,
            updatedAt: Date.now()
          }
        });
      } catch (e) { /* ignore */ }
    }, 700);
  }

  async function loadRuntime(loginFlow) {
    try {
      /* 「用户想让它跑」的意图单独读 —— 它存在独立的运行时键里，
       * 导入配置文件（哪怕文件里写着 enabled:false）都不会影响它（真实事故）。 */
      loadWantRunning(await chrome.storage.local.get(WANT_KEY));
      /* 「上次真的打开登录页」的时刻 —— 跨页面/跨重载共享，防止重复弹标签页 */
      try {
        const ao = await chrome.storage.local.get('kx_autologin_at');
        autoOpenAt = Number(ao && ao.kx_autologin_at) || 0;
      } catch (e) { autoOpenAt = 0; }
      const got = await chrome.storage.local.get(RUNTIME_KEY);
      const rt = got && got[RUNTIME_KEY];
      if (!rt) return;
      Object.keys(rt.targets || {}).forEach(function (k) { runtime.set(k, rt.targets[k]); });
      Object.assign(stats, rt.stats || {});
      Object.assign(auth, rt.auth || {});
      if (rt.auth && rt.auth.state === 'ok' && !auth.lastProbeAt) auth.state = 'unknown';
      if (auth.observedAt === undefined) auth.observedAt = auth.lastOkAt || 0;

      /* 清掉历史里被污染的寿命样本：早期版本用「样本最小值」，
       * 一个错误短样本（刚登录时页面残留旧文字 → 误判掉线 → 算出 2.5 分钟）
       * 就把校准值永久带偏成 2 分钟，于是每次刚登录就报"还剩 2 分钟"。
       * 这里把明显不合理的样本丢掉，并同时把被写坏的 hardTimeoutMs 修回配置文件里的值。 */
      if (Array.isArray(auth.lifetimeSamples) && auth.lifetimeSamples.length) {
        const before = auth.lifetimeSamples.length;
        auth.lifetimeSamples = auth.lifetimeSamples.filter(function (v) { return v >= 180000 && v < 6 * 3600000; });
        const bad = before - auth.lifetimeSamples.length;
        if (bad > 0) {
          log('warn', '清掉了 ' + bad + ' 个不合理的会话寿命样本（<3 分钟），倒计时改用剩余样本的中位数。'
            + '（被旧版本写坏的 session.hardTimeoutMs 不再用于倒计时，校准值只存在运行状态里。）');
        }
      }

      // ★ 修「刚登录却提示还剩 3 分钟」：登录时刻只是「锚在插件上次确认会话有效的时刻」
      //   上的估算。锚点一旦不可信（刚去过登录页 / 太久没确认过），必须作废重算，
      //   否则会拿上次会话的旧时刻去推算，导致刚登录就报警甚至误停机。
      const st = KX.snapshot().session || {};
      const decision = KX.authAnchorDecision({
        loginAt: auth.loginAt,
        observedAt: auth.observedAt,
        now: Date.now(),
        staleGapMs: st.loginAtStaleMs,
        loginFlowAt: loginFlow && loginFlow.at,
        loginFlowWindowMs: st.loginFlowWindowMs
      });
      if (decision.reset) {
        const old = auth.loginAt;
        auth.loginAt = 0;
        auth.loginSource = '';
        auth.state = auth.state === 'lost' ? 'lost' : 'unknown';
        warnFlighted = false;
        log('info', '登录时刻锚点已作废重算（原因：' + decision.reason + '）。旧值 ' + hhmmss(old)
          + ' 不再用于倒计时；首次探测成功后会重新起算，若你确实刚登录可点面板「我刚登录了」精确校准。');
      }

    } catch (e) { /* ignore */ }
  }

  /** 读一次「去过登录页」标记（由 background 在 tab 导航时写入），默认读后即清 */
  async function readLoginFlowMarker(consume) {
    try {
      const got = await chrome.storage.local.get(LOGIN_FLOW_KEY);
      const m = got && got[LOGIN_FLOW_KEY];
      if (m && consume) await chrome.storage.local.remove(LOGIN_FLOW_KEY);
      return m || null;
    } catch (e) { return null; }
  }

  /** 记录一次「确认会话有效」，并刷新倒计时锚点 */
  function noteSessionAlive() {
    auth.lastOkAt = Date.now();
    auth.observedAt = Date.now();
  }

  /* ============================================================
   * 通知
   * ============================================================ */
  function toBg(msg) {
    try {
      const p = chrome.runtime.sendMessage(msg);
      return (p && typeof p.then === 'function') ? p.catch(function () { return null; }) : Promise.resolve(null);
    } catch (e) { return Promise.resolve(null); }
  }

  function beep(times) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const n = clamp(times || 1, 1, 5);
      for (let i = 0; i < n; i++) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = i % 2 ? 660 : 880;
        o.connect(g);
        g.connect(ctx.destination);
        const t0 = ctx.currentTime + i * 0.25;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
        o.start(t0);
        o.stop(t0 + 0.22);
      }
      setTimeout(function () { try { ctx.close(); } catch (e) {} }, n * 300 + 300);
    } catch (e) { /* 自动播放策略可能拦截，忽略 */ }
  }

  function notify(title, message, urgent) {
    const cfg = KX.snapshot();
    if (cfg.notify && cfg.notify.desktop !== false) {
      toBg({ type: 'kx:notify', title: title, message: message, urgent: !!urgent });
    }
    if (urgent) beep(3);
    else if (cfg.notify && cfg.notify.sound) beep(1);
    if (cfg.notify && cfg.notify.webhook) {
      toBg({ type: 'kx:webhook', text: '【' + title + '】' + message + ' @' + HOST });
    }
    log(urgent ? 'err' : 'ok', (urgent ? '⚠ ' : '') + title + '：' + message);
  }

  /* ============================================================
   * 登录态看门狗（应对「登录满 20 分钟硬超时」）
   * ============================================================ */
  function evaluateAuth(res, reqUrl) {
    const st = KX.snapshot().session || {};
    if (!res || res.timeout) return { lost: false, unknown: true, why: '超时，先不判定掉线' };
    if (!res.status) return { lost: false, unknown: true, why: '网络失败：' + (res.error || '') };
    const sts = st.logoutStatus || [401, 403];
    if (sts.indexOf(res.status) !== -1) return { lost: true, strong: true, why: 'HTTP ' + res.status };
    const finalUrl = res.finalUrl || '';
    if (finalUrl && st.loginUrlRe) {
      try {
        if (new RegExp(st.loginUrlRe, 'i').test(finalUrl) && stripHash(finalUrl) !== stripHash(reqUrl)) {
          return { lost: true, strong: true, why: '被重定向到登录页', loginUrl: finalUrl };
        }
      } catch (e) { /* 正则写错就当没配 */ }
    }
    if (!st.loginMarkersOnRedirectOnly && R.evalRule(st.loginMarkers, res.body || '')) {
      const body = String(res.body || '');
      /* HTML 页面**不能**拿文字标记判定掉线！
       * 真实事故：保活实验把探测目标改成选课首页 HTML 后，每一次探测都误判掉线
       * （页面 200、会话完全正常）—— 因为 SPA 的 HTML 与其 JS bundle 里**必然**包含
       * 「未登录 / 请先登录 / 重新登录」这些字符串（登录页模板就在同一个 bundle 里）。
       * HTML 只认一条铁证：真的出现了登录表单字段。 */
      const isHtml = /^\s*(<!doctype|<html)/i.test(body) || /<script[\s>]/i.test(body.slice(0, 800));
      if (isHtml) {
        const hasLoginForm = /type=["']password["']/i.test(body)
          || /name=["']loginPwd["']/i.test(body)
          || /id=["']verifyCode["']/i.test(body)
          || /name=["']loginName["']/i.test(body);
        if (hasLoginForm) {
          return { lost: true, strong: false, why: 'HTML 页面里出现登录表单字段（loginName/loginPwd/verifyCode）' };
        }
        return { lost: false, why: 'HTTP ' + res.status + '（HTML 页面，文字标记无判别力，已忽略）' };
      }
      /* 内容命中只是**弱证据** —— 真实事故：探测拿到一段含「未登录/请重新登录」的页面
       * （WAF 拦截页、偶发的服务端提示页都可能含这些词），
       * 于是把活着的会话判成掉线、把引擎停了一次；1 秒后探测又成功、自动恢复。
       * 弱证据必须"连续两次"才下结论（strong=false 交给 noteAuth 累计）。 */
      const marker = KX.matchLogoutMarker(body, st.loginMarkers) || '（内容特征）';
      return {
        lost: true, strong: false,
        why: '响应内容命中登录页特征：' + marker + '（' + body.length + ' 字节）'
          + '　片段：' + body.replace(/\s+/g, ' ').slice(0, 120),
        evidence: { marker: marker, isHtml: false, len: body.length, snippet: body.replace(/\s+/g, ' ').slice(0, 200) }
      };
    }
    return { lost: false, why: 'HTTP ' + res.status };
  }

  /** 每一次发包的结果都过一遍登录态判定，掉线立即停机 */
  function noteAuth(res, reqUrl, where) {
    const v = evaluateAuth(res, reqUrl);
    if (v.loginUrl && v.loginUrl !== auth.loginUrl) {
      auth.loginUrl = v.loginUrl;
      KX.save({ session: { loginUrl: v.loginUrl } }).catch(function () {});
    }
    if (v.lost) {
      const alreadyLost = auth.state === 'lost';
      /* 强证据（HTTP 401/403、被重定向到登录页）→ 立刻判定；
       * 弱证据（响应"内容"里出现未登录字样）→ 必须连续命中两次才判定。
       * 真实事故：探测偶发拿到一段含「未登录」的页面（SPA bundle / WAF 拦截页都会），
       * 于是把活着的会话判成掉线、把引擎白停了一次，1 秒后又自动恢复。
       * 判定错误在这里代价很大（停机 + 响铃 + 让你去重新登录），值得多确认一次。 */
      if (!v.strong) {
        weakLostStreak++;
        const need = clamp(Number(st.weakLostNeed) || 2, 1, 10);
        if (weakLostStreak < need) {
          log('warn', '疑似掉线（' + v.why + '）—— 这是**内容特征**判定，属于弱证据，'
            + '已连续 ' + weakLostStreak + '/' + need + ' 次；再命中一次才判定掉线（避免误停）。');
          if (globalThis.KXPanel && KXPanel.mounted) KXPanel.status(snapshotStatus());
          return false;
        }
        log('warn', '内容特征连续 ' + weakLostStreak + ' 次命中，判定为掉线：' + v.why);
      }
      weakLostStreak = 0;
      auth.state = 'lost';
      auth.why = (where || '请求') + '：' + v.why;
      recordSessionDeath(where || '请求');
      saveRuntime();
      if (running) {
        halt('登录已掉线（' + auth.why + '），等待重新登录', true);
      } else if (!alreadyLost) {
        /* 只在「刚刚变成掉线」时记一条：掉线后每 30 秒都会再探到 401，
         * 每次记一条的话日志会被同一件事刷满（真实事故：每 45 秒一条）。 */
        log('warn', '检测到登录态失效：' + auth.why);
        if (globalThis.KXPanel && KXPanel.mounted) KXPanel.status(snapshotStatus());
      }
      return true;
    }
    if (!v.unknown) {
      weakLostStreak = 0;   // 探测成功 → 弱证据累计清零（疑似掉线不成立）
      domLostStreak = 0;    // 接口都通了，页面文字命中更不成立
      if (auth.state !== 'ok') {
        const wasLost = auth.state === 'lost' || auth.state === 'suspect';
        auth.state = 'ok';
        auth.why = '';
        noteSessionAlive();
        if (wasLost) {
          auth.loginAt = Date.now();     // 推定「刚重新登录」
          auth.loginSource = 'observed';
          warnFlighted = false;
          /* 这里**不再**重置 autoOpenedLogin：每次"掉线→恢复"都重置它，就会一遍遍
           * 弹新标签页（真实事故）。防重复现在靠持久化的 autoOpenAt（全局 3 分钟一次）。 */
          log('ok', '登录态已恢复（推定重新登录时刻 ' + hhmmss(auth.loginAt) + '）');
        } else if (!auth.loginAt) {
          auth.loginAt = Date.now();     // 首次确认会话有效，以此为倒计时起点（真实登录可能更早，属保守估算）
          auth.loginSource = 'observed';
        }
        saveRuntime();
      }
      noteSessionAlive();
      /* 唯一的"自动继续"判断，而且**不放在任何状态分支里**。
       * 规则只有一条：配置里 enabled=true（= 用户想让它跑）而引擎没在跑 → 就启动。
       *   · enabled 由 start() 置 true、由用户点「停止」置 false
       *   · 主动停机（验证码/未开放）会把它置 false → 那种必须你手动确认再启动
       * 之前用 resumePending/wasLost/state!=='ok' 等条件拼过三版，每一版都在某个分支里漏掉过 —— 
       * 现在只保留这一个条件，简单到不可能再漏。 */
      if (!running && wantRunning && (KX.snapshot().session || {}).autoResume !== false) {
        start('会话有效，自动开始/继续', { now: true }).then(function (r) {
          if (r && r.ok) {
            log('ok', '会话有效 → 已自动开始抢课');
            notify('登录成功', '已自动继续抢课', false);
          } else if (r && r.error) {
            // 典型情况：当前页面不是选课页 → 进了选课页会自动开始
            log('warn', '还不能自动开始：' + r.error);
          }
        });
      }
      // 会话活过了「硬超时」推算值 → 说明这个推算不可靠（实测会活更久）
      if (!hardTimeoutDisproved) {
        const st2 = KX.snapshot().session || {};
        if (KX.isHardTimeoutDisproved({ loginAt: auth.loginAt, hardTimeoutMs: st2.hardTimeoutMs, now: Date.now() })) {
          hardTimeoutDisproved = true;
          warnFlighted = true;
          const liveMin = Math.round((Date.now() - auth.loginAt) / 60000);
          const cfgMin = Math.round((Number(st2.hardTimeoutMs) || 0) / 60000);
          log('ok', '★ 实测结论：会话已存活 ' + liveMin + ' 分钟仍然有效，超过了推算值（' + cfgMin + ' 分钟）'
            + '→ 那个「硬超时」估算不准。已停用倒计时预警与"到点停机"（不再误报、更不会把还活着的引擎白停掉）。'
            + '掉线仍会被真实捕捉：提交/体检返回 HTTP 401，或页面出现未登录文字 —— 通常 1~2 分钟内发现。');
          notify('倒计时估算不准，已停用', '会话已活过 ' + cfgMin + ' 分钟（已 ' + liveMin + ' 分钟）仍在工作，'
            + '说明超时不是按登录时刻硬算的。以后不再按推算值提醒或停机；真掉线仍会立刻报警并自动打开登录页。', false);
        }
      }
    }
    return false;
  }

  /** 主动探测一次（同时兼作心跳保活）
   *  注意：默认探测「当前页面地址」而不是提交接口 —— 拿 GET 去捅选课提交口
   *  既没意义又可能被系统记异常。想更轻量就用 session.keepAlive.url 指定一个查询页。 */
  /* ============================================================
   * 「用户想让它跑」这个意图 —— 必须存在**运行时**，不能放配置文件里
   * ------------------------------------------------------------
   * 真实事故：以前用 cfg.enabled 表达它，而配置文件里带着 `enabled: false` ——
   * 用户一导入配置（本意只是更新模板/规则），这个意图就被冲成 false，
   * 于是"进入页面自动开始"永远不触发。
   * 现在用独立的 storage 键：导入配置碰不到它。
   *   start()            → true
   *   手动停止 / 主动停机 → false（验证码/未开放这类必须人工确认再启动）
   *   登录掉线           → 保持 true（登录成功后自动继续）
   * ============================================================ */
  const WANT_KEY = 'kx_want_running';
  let wantRunning = false;
  let wantEverRead = false;      // 是否已经从存储里读到过（没读到过 = 首次使用 → 默认开启）
  function setWantRunning(v) {
    wantRunning = !!v;
    wantEverRead = true;
    try { chrome.storage.local.set({ [WANT_KEY]: wantRunning }); } catch (e) { /* ignore */ }
  }
  /** 读取意图。**首次使用（存储里没有这个键）默认 true** ——
   *  用户明确要求"点入页面就自动进行"，所以默认就该是"想跑"。
   *  只有两种情况下会变成 false：你手动点「停止」，或者主动停机（验证码/未开放）。 */
  function loadWantRunning(got) {
    const raw = got && got[WANT_KEY];
    wantRunning = (raw === undefined || raw === null) ? true : !!raw;
    wantEverRead = true;
    return wantRunning;
  }
  /** 探测登录态。
   *  刻意**不做跨标签页节流**：那是我为修一个 bug 加的补丁，结果它自己把"掉线后恢复探测"
   *  也吞掉了 —— 引擎显示"抢课中"，9 个目标却全部静默跳过提交（真实事故）。
   *  现在就是每个页面按自己的节奏探测：多花几个请求，换来"一眼能看懂"的简单逻辑。 */
  async function probeSession(reason) {
    const cfg = KX.snapshot();
    const st = cfg.session || {};
    const ka = st.keepAlive || {};
    let url = ka.url || cfg.query.url || location.href;
    if (!sameOrigin(url)) {
      auth.lastProbeAt = Date.now();
      log('info', '登录态探测跳过：探测地址与当前页面不同源（请让工作标签页回到 ' + HOST + '）');
      return { skipped: true };
    }
    const method = (ka.enabled ? (ka.method || 'GET') : 'GET').toUpperCase();
    let headers = cleanHeaders(ka.headers || {});
    let body = null;
    if (ka.enabled && method !== 'GET') {
      const built = KX.buildBody(ka.contentType, ka.body, { ts: Date.now(), rand: KX.uid(6) });
      headers = Object.assign(headers, built.headers);
      body = built.body;
    }
    /* 关键实测结论：掉线时对**同一个接口**，GET 会得到网络层失败（HTTP 0），
     * 而 POST 会得到干净的 HTTP 401 —— 后者才是可用的掉线判据。
     * 所以当探测目标就是余量接口时，直接用查询模板的 method/body 发（语义也最接近真实查询）。 */
    let useMethod = method;
    if (!ka.url && cfg.query && cfg.query.url && (url === cfg.query.url || url.indexOf(cfg.query.url.split('?')[0]) === 0) && cfg.query.method) {
      useMethod = String(cfg.query.method).toUpperCase();
      if (useMethod !== 'GET') {
        const qv = Object.assign({}, cfg.submit && cfg.submit.vars, { ts: Date.now(), rand: KX.uid(6) });
        const built = KX.buildBody(cfg.query.contentType, cfg.query.body, qv);
        headers = Object.assign(cleanHeaders(Object.assign({ 'X-Requested-With': 'XMLHttpRequest' }, cfg.query.headers)), built.headers);
        body = built.body;
      }
    }
    if (useMethod === 'GET' && ka.cacheBuster !== false) url = addCacheBuster(url);

    const r = await replay({ url: url, method: useMethod, headers: headers, body: body, timeoutMs: ka.timeoutMs || 10000 });
    auth.lastProbeAt = Date.now();
    const lost = noteAuth(r, url, '探测');
    /* 把本次体检的结论留成人话：面板会显示它。
     * 真实需求：用户看到"等登录"却不知道体检到底做过没有、结果如何，
     * 只能干等（那次静默卡死就是靠这个一眼能看出来的）。 */
    lastProbeText = lost
      ? ('✖ 判定掉线：' + auth.why)
      : (!r || !r.status)
        ? ('✖ 体检失败：' + ((r && r.error) || '无响应') + '（HTTP ' + ((r && r.status) || 0) + '）')
        : ('✔ 会话有效（HTTP ' + r.status + '）');

    /* 探测在「网络层」就失败时（status 0：连接被重置/超时/响应不可读），
     * 绝不能报「体检通过」—— 真实案例里这正是掉线的表现（服务器不返回 401/302），
     * 旧代码却把它记成通过，于是插件以为一切正常、既不报警也不停机。
     * 用连续失败计数来区分「偶发抖动」和「真的掉线」。 */
    if (!lost && (!r || !r.status)) {
      authFailStreak++;
      const why = (r && r.error) || '无响应';
      const need = clamp(Number(st.probeFailStreak) || 3, 1, 20);
      log('warn', '登录态体检失败（第 ' + authFailStreak + ' 次）：' + why
        + '（HTTP ' + ((r && r.status) || 0) + '）。若是网络抖动可忽略，连续 ' + need + ' 次就按疑似掉线处理。');
      if (authFailStreak >= need && auth.state !== 'lost') {
        auth.state = 'suspect';
        auth.why = '连续 ' + authFailStreak + ' 次体检在网络层失败（' + why + '）';
        saveRuntime();
        if (running) halt('登录态疑似失效：' + auth.why, true);
        else notify('登录态疑似失效', auth.why + '。请看一眼页面是不是提示未登录，需要的话重新登录一次。', true);
        if (globalThis.KXPanel && KXPanel.mounted) KXPanel.status(snapshotStatus());
        return r;
      }
      if (globalThis.KXPanel && KXPanel.mounted) KXPanel.status(snapshotStatus());
      return r;
    }
    if (!lost) {
      authFailStreak = 0;
      log('sys', '登录态体检通过（' + (reason || '') + '，HTTP ' + (r && r.status) + '）', (r && r.body || '').slice(0, 200));
      if (globalThis.KXPanel && KXPanel.mounted) KXPanel.status(snapshotStatus());
    }
    return r;
  }

  /** 第三只眼睛：页面自己渲染出来的文字说「未登录不能选课」时，直接判掉线。
   *  真实场景：这个系统的掉线既不返回 401/302，也不跳登录页，接口层只给网络失败，
   *  但页面上写着「未登录不能选课」—— 只靠接口层永远发现不了。 */
  function checkPageLogoutText() {
    if (auth.state === 'lost') return false;
    /* 登录后的 30 秒宽限期：刚登录时页面可能还残留着上一次的「未登录不能选课」文字，
     * 立刻判定掉线会造成"刚登录就说要过期/已掉线"这种自相矛盾的状态（真实事故）。 */
    if (auth.loginAt && Date.now() - auth.loginAt < 30000) return false;
    const st = KX.snapshot().session || {};
    let text = '';
    try {
      // innerText 不含 Shadow DOM，所以不会读到我们自己的面板文字
      text = String((document.body && document.body.innerText) || '').slice(0, 4000);
    } catch (e) { return false; }
    if (!text) return false;
    if (!KX.looksLoggedOut(text, st.logoutTextMarkers)) { domLostStreak = 0; return false; }

    /* 页面文字也是**弱证据**：SPA 可能在会话还活着时渲染出「请重新登录」这类提示
     * （实测：刷新页面后页面显示「未登录不能选课」，但接口还能用）。
     * 连续命中 2 次（15 秒一次，共约 30 秒）才判定 —— 真掉线时这段文字是**持续**显示的，
     * 代价只是晚 30 秒发现；而误判的代价是白停引擎 + 吓你一跳。 */
    domLostStreak++;
    const need = clamp(Number(st.weakLostNeed) || 2, 1, 10);
    if (domLostStreak < need) {
      log('warn', '疑似掉线（页面文字命中「' + (KX.matchLogoutMarker(text, st.logoutTextMarkers) || '?')
        + '」）—— 弱证据 ' + domLostStreak + '/' + need + ' 次；再确认一次才停机。页面片段：'
        + text.replace(/\s+/g, ' ').slice(0, 120));
      if (globalThis.KXPanel && KXPanel.mounted) KXPanel.status(snapshotStatus());
      return false;
    }
    domLostStreak = 0;

    auth.state = 'lost';
    auth.why = '页面显示「' + text.replace(/\s+/g, ' ').slice(0, 60) + '」';
    recordSessionDeath('页面文字');
    saveRuntime();
    const hint = (KX.snapshot().session || {}).loginUrl
      ? '（已记住登录页，点面板「打开登录页」即可）'
      : '（还不知道登录页地址：你登录一次后我就能从 Referer 里拿到，之后可以自动打开）';
    if (running) halt('页面提示未登录：' + auth.why, true);
    else notify('检测到已掉线', auth.why + ' 请重新登录，登录后会自动继续。' + hint, true);
    if (globalThis.KXPanel && KXPanel.mounted) KXPanel.status(snapshotStatus());
    return true;
  }

  /** 每 15 秒跑一次：倒计时预警 + 定期体检 + 掉线后轮询是否已重新登录 */
  function sessionTick() {
    if (destroyed || !ACTIVE) return;
    const cfg = KX.snapshot();
    const st = cfg.session || {};
    const now = Date.now();

    // 0) 第三只眼睛：页面文字直接说「未登录」→ 直接判掉线（每 15 秒看一眼，很便宜）
    if (auth.state !== 'lost' && checkPageLogoutText()) return;

    // 1) 硬超时倒计时（若实测已推翻"硬超时"，整段跳过 —— 那只是噪声）
    const left = hardTimeoutDisproved ? null : authLeftMs();
    if (left !== null) {
      const warn = Number(st.warnBeforeMs) || 180000;
      /* 显示的分钟数必须和**算 left 用的那个值**一致。
       * 真实困惑：这里原来写的是配置里的原始值（10 分钟），而 left 用的是校准后的值（可能只有 4.6 分钟），
       * 于是通知读起来自相矛盾（"按登录 + 10 分钟推算"却只剩 2 分钟）——用户会以为估算在乱跳。 */
      const effMin = (effectiveHardTimeoutMs() / 60000);
      const samples = (auth.lifetimeSamples || []).length;
      const basis = '（按 ' + hhmmss(auth.loginAt) + ' 登录 + ' + effMin.toFixed(1) + ' 分钟推算'
        + (auth.loginSource === 'manual' ? '，你手工校准过' : '，插件探测推定')
        + (samples ? '，已实测校准 ' + samples + ' 次' : '，尚无实测样本') + '）';
      if (left <= 0 && auth.state !== 'lost') {
        /* 到点了 —— 但这只是**推算值**到点，不代表真的掉线。
         * 真实事故：这里原来直接停机（"先停机确认登录态"），而停机发生在探测确认之前
         * （sessionTick 每 15 秒跑、探测每 2 分钟才一次），于是把**会话还活着**的引擎
         * 白停了一次，用户平白丢掉抢课时间。现在只探测、绝不停机：
         * 掉线一律由真实证据判定（HTTP 401 / 页面文字），那才是最可靠的信号。 */
        if (Date.now() - (lastEstimateProbeAt || 0) > 120000) {
          lastEstimateProbeAt = Date.now();
          log('warn', '已到达「推定」硬超时时刻' + basis + ' —— 这只是推算值，不代表真的掉线。'
            + '正在探测确认（不会停机；真掉线会被 HTTP 401 / 页面文字抓到）。'
            + '若你其实刚登录过，点面板「我刚登录了」可校准。');
          probeSession('硬超时确认');
        }
        return;
      }
      if (left > 0 && left <= warn && !warnFlighted) {
        warnFlighted = true;
        notify('登录即将过期', '约 ' + Math.round(left / 60000) + ' 分钟后需要重新登录' + basis
          + '。这个时刻是推算的：若你其实刚登录过，点面板「我刚登录了」即可校准。', true);
      }
      /* 自动打开登录页：**只在"真的扫到掉线"时打开**（auth.state === 'lost'）。
       *
       * 历史教训：
       *   ① 原来还按推算倒计时提前开（left <= 90 秒）—— 推算值不准，结果在你没掉线时也开
       *   ② 原来靠"本页是工作页"防重复，但那管不住**时间维度**：每次"掉线→恢复"都会把
       *      autoOpenedLogin 重置，于是一遍遍开新页（用户反馈："登录时间快结束了疯狂弹出新页面"）
       * 现在三重条件：真掉线 + 本页是工作页 + **全局 3 分钟内只开一次**（时间戳持久化，
       * 跨页面共享）。另外 background 打开前会先找有没有已开着的登录页，有就切过去不新开。
       *
       * 「提前打开」这个便利已取消：推算值不可靠，提前开的代价是刷屏，收益却只是早 90 秒。 */
      if (auth.state === 'lost' && !autoOpenedLogin
        && Date.now() - (autoOpenAt || 0) > 3 * 60000) {
        const lu = auth.loginUrl || (KX.snapshot().session || {}).loginUrl || '';
        if (!lu) {
          if (Date.now() - (lastAutoOpenTry || 0) > 30000) {
            lastAutoOpenTry = Date.now();
            log('info', '想在失效前自动打开登录页，但 session.loginUrl 还是空的 —— '
              + '把登录页地址填进设置（面板 → 设置 → 会话 → 登录页地址）就能用了。');
          }
        } else if (!running && !thisPageWasWorker) {
          // 只有工作标签页才开登录页，其他页面（登录页本身、首页…）一律不动
          if (Date.now() - (lastAutoOpenTry || 0) > 60000) {
            lastAutoOpenTry = Date.now();
            log('sys', '（本页面没在抢课，不自动打开登录页；由工作标签页负责）');
          }
        } else {
          /* 打开登录页：只由工作标签页做，且全局 3 分钟一次（autoOpenAt 持久化，跨页面共享）。
           * background 会先查有没有已开着的登录页 —— 有就切过去，不新开。 */
          autoOpenedLogin = true;
          autoOpenAt = Date.now();
          try { chrome.storage.local.set({ kx_autologin_at: autoOpenAt }); } catch (e) { /* ignore */ }
          log('warn', '检测到已掉线 → 打开登录页（若已开着会直接切过去）');
          toBg({ type: 'kx:open-login', url: lu, mode: 'tab', activate: true });
        }
      }
    }

    // 2) 定期体检 / 掉线后恢复探测
    const ka = st.keepAlive || {};
    let every = auth.state === 'lost'
      ? (Number(st.recheckMs) || 30000)
      : (Number(st.probeEveryMs) || 300000);
    // 打开了心跳保活就按 keepAlive.intervalMs 来；正在抢课时再收紧到 2 分钟，
    // 免得关键时刻正好撞上硬超时却没人发现。
    if (auth.state !== 'lost' && ka.enabled) every = Math.min(every, Number(ka.intervalMs) || 240000);
    if (running) every = Math.min(every, 120000);
    if (now - (auth.lastProbeAt || 0) >= every) {
      /* 掉线状态下要**立刻**探测（用户可能刚输完验证码），不能被全局节流挡住；
       * 健康状态下走节流，避免多个标签页重复体检。 */
      probeSession(auth.state === 'lost' ? '等待重新登录' : '定期体检', { force: auth.state === 'lost' });
    }
    /* 周期性核对「已选课程」—— 这是**权威判据**：即使提交响应的文案我们没认出来
     * （真实事故：选上了却只敢说"看起来成功了"），也会在这里被确认。
     * 只在会话有效、且有目标时才查，避免白花请求。 */
    const mineCfg = st.mine || {};
    const mineEvery = clamp(Number(mineCfg.checkEveryMs) || 180000, 30000, 3600000);
    if (mineCfg.url && auth.state !== 'lost' && (KX.snapshot().targets || []).length > 0
      && now - (myCoursesAt || 0) >= mineEvery) {
      checkMine({ quiet: true }).catch(function () { });
    }

    /* 恢复看门狗：掉线状态下如果长时间没有任何体检发生，说明探测被什么挡住了
     * （真实事故：多标签页节流把"等待重新登录"的探测也吞了 → 引擎显示"抢课中"、
     *  其实 9 个目标全部静默跳过提交，用户完全看不出哪里坏了）。
     * 这类"静默卡死"必须自己吼出来。 */
    if (auth.state === 'lost' && running) {
      const since = now - (auth.lastProbeAt || 0);
      if (since > 90000 && now - (lastLostStallWarnAt || 0) > 300000) {
        lastLostStallWarnAt = now;
        log('err', '⚠ 掉线状态已持续但近 ' + Math.round(since / 1000) + ' 秒没有体检（探测可能被节流/异常挡住了）——'
          + '引擎当前【在跑但不会提交任何目标】。点面板「检测登录态」可强制探测一次并立刻恢复。');
      }
    }

    /* 保活实验的自证：会话活过「此前最长记录」就喊一声。
     * 因为"要不要自动登录"完全取决于保活能不能突破那个短超时 —— 让插件自己把结论说出来，
     * 而不是靠你去数分钟。 */
    if (ka.enabled && auth.loginAt && auth.state !== 'lost') {
      const live = now - auth.loginAt;
      const prevMax = Math.max(0, (auth.lifetimeSamples || []).reduce(function (m, v) { return Math.max(m, v); }, 0));
      if (!keepAliveRecordLogged && prevMax && live > prevMax + 60000) {
        keepAliveRecordLogged = true;
        log('ok', '★ 保活看起来有效：本次会话已存活 ' + (live / 60000).toFixed(1) + ' 分钟，'
          + '超过了此前的记录 ' + (prevMax / 60000).toFixed(1) + ' 分钟。'
          + '继续观察：如果能稳定超过 20 分钟，就可以把「失效前自动打开登录页」关掉，不用再手动登录。');
        notify('保活有效（会话已超时此前记录）', '本次会话活了 ' + (live / 60000).toFixed(1) + ' 分钟，超过之前 '
          + (prevMax / 60000).toFixed(1) + ' 分钟的记录，说明保活请求确实能续期。', false);
      }
    }

    // 3) 定时开抢的倒计时展示
    if (globalThis.KXPanel && KXPanel.mounted) KXPanel.status(snapshotStatus());
  }

  /* ============================================================
   * 引擎：查询余量
   * ============================================================ */
  async function callQuery(cfg, opts) {
    const q = cfg.query || {};
    if (!q.url) return { ok: false, error: '未配置余量查询接口' };
    const vars = Object.assign({}, cfg.submit && cfg.submit.vars, { ts: Date.now(), rand: KX.uid(6) });
    /* 人工「查询一次」时把 pageSize 放大，一次把全部课程拿回来供浏览；
     * 自动轮询仍用配置里的小 pageSize（流量小、风控风险低）。 */
    let qBody = q.body;
    if (opts && opts.fullPage) qBody = R.withPageSize(qBody, opts.pageSize || 200);
    const built = KX.buildBody(q.contentType, qBody, vars);
    const url = KX.renderTemplate(q.url, vars);
    const headers = cleanHeaders(Object.assign({ 'X-Requested-With': 'XMLHttpRequest' }, q.headers, built.headers));
    const r = await replay({
      url: url, method: q.method || 'POST', headers: headers, body: built.body,
      timeoutMs: q.timeoutMs || 15000, referrer: q.referrer || ''
    }, q.via);
    stats.lastReq = { url: url, method: q.method || 'POST', status: r && r.status, ms: r && r.ms, at: Date.now() };
    if (noteAuth(r, url, '余量查询')) return { ok: false, error: '登录态失效' };
    if (!r || r.status === 0) return { ok: false, error: (r && r.error) || '网络错误' };
    if (r.status >= 400) return { ok: false, error: 'HTTP ' + r.status, body: r.body };
    const parsed = R.parseList(q.parse, r.body || '');
    if (!parsed.ok) return { ok: false, error: parsed.error, body: r.body };
    return { ok: true, list: parsed.list, body: r.body };
  }

  /* ============================================================
   * 引擎：提交选课
   * ============================================================ */
  async function submitOne(cfg, t, rt) {
    const s = cfg.submit || {};
    if (!s.url) return 'nourl';
    // 变量优先级：targets[].vars（每个教学班自己的变量） > submit.vars（全局固定值） > 内置
    const vars = KX.buildVars(s.vars, t);

    // 每次会话都会变的参数（csrfToken 之类）：提交前实时从页面取，取到就覆盖写死的值
    const pageVarSpec = s.pageVars || {};
    let missingVars = [];
    if (Object.keys(pageVarSpec).length) {
      const dyn = await resolvePageVars(pageVarSpec);
      Object.keys(dyn).forEach(function (k) { vars[k] = dyn[k]; });
      missingVars = Object.keys(pageVarSpec).filter(function (k) { return !dyn[k]; });

      /* 混合模式：token 取不到时，让页面自己点一次「选课 → 确定」。
       * 页面自己发请求会带上它内部的 csrfToken → 我们录到就学到了；
       * 而且这一次点击本身就是真实抢课尝试（不浪费额度）。
       * 并发下必须加锁：否则一批里多个目标同时发现没 token，会同时去点页面
       * （只需要点一次；后到的等下一轮，那时 token 已经学到了）。 */
      if (missingVars.length && uiAllowed() && !uiBlockedHere && !uiFeedInFlight
        && (uiCfg().mode === 'hybrid' || uiCfg().mode === 'only')) {
        uiFeedInFlight = true;
        try {
        const t0 = Date.now();
        log('warn', '取不到 ' + missingVars.join('、') + ' → 启用 UI 点击模式，让页面自己点一次「'
          + (uiCfg().selectText || '选课') + ' → ' + (uiCfg().confirmText || '确定') + '」来取得 token');
        const rep = await uiClickFor(t);
        const steps = (rep && rep.steps) ? rep.steps.join('；') : '';
        if (rep && rep.ok) {
          rt.tryCount++;
          stats.submitTry++;
          log('pkg', 'UI 点击完成（' + (rep.ms || 0) + 'ms）：' + steps
            + (rep.resultText ? '　结果提示：' + rep.resultText : ''), '');
          // 用页面自己发出的那条请求来判断结果（它才是真正生效的提交）；轮询等它被抓到
          const again = await judgeUiClickResultWait(cfg, t0, 3000);
          if (again.kind) {
            const kind = again.kind;
            if (kind === 'success') { rt.okCount++; stats.submitOk++; setState(rt, 'success', '选课成功（UI 点击）'); notify('选课成功', (t.label || t.id) + ' 抢到了（UI 点击）', false); return 'success'; }
            if (kind === 'dup') { stats.submitOk++; setState(rt, 'success', '已选过（UI 点击）'); return 'dup'; }
            if (kind === 'full') { stats.submitFull++; rt.failStreak = 0; setState(rt, 'waiting', '名额已满（UI 点击）'); return 'full'; }
            if (kind === 'captcha' || kind === 'logout' || kind === 'closed') {
              noteAuth({ status: 200, body: again.text, url: location.href }, location.href, 'UI 点击');
              setState(rt, 'blocked', 'UI 点击得到 ' + kind);
              if (kind !== 'logout' || (cfg.engine.stopOn || {}).logout !== false) halt('UI 点击发现 ' + kind + '：' + again.text.slice(0, 80), true);
              return kind;
            }
            setState(rt, 'retry', 'UI 点击结果未判定');
            log('warn', 'UI 点击后仍无法判定结果，响应片段：' + again.text.replace(/\s+/g, ' ').slice(0, 200));
            return 'unknown';
          }
          // 没抓到那条请求：可能是点击没生效，或页面用了我们没 hook 的方式
          log('warn', 'UI 点击看起来执行了，但没有抓到对应的提交请求（'
            + '可能按钮点错了、或页面被弹框挡住）。报告：' + steps);
          setState(rt, 'retry', 'UI 点击未产生请求');
          return 'nouireq';
        }
        /* UI 点击失败：如果原因是「页面上找不到这门课」，说明当前页面根本没有课程列表
         * （典型：还停在选课首页）。这种情况**不要在每轮里反复重试** ——
         * 真实事故：每 3 秒扫描一次 DOM + 刷三条日志，直到把日志刷满。
         * 本页面加载期间只判定一次，并只吼一次让用户知道该去哪。 */
        const why = String((rep && rep.error) || (rep && rep.detail) || '');
        /* 页面自己卡在「正在提交中」遮罩：这是页面自身提交撞上会话失效后的残留状态，
         * 我们点不动也不该硬点 —— 明确告诉用户刷新该页，别让它反复尝试。 */
        if (rep && rep.stuck) {
          uiBlockedHere = true;
          log('err', '⚠ 页面自身卡在「' + String(rep.stuckText || '').slice(0, 40) + '」（页面自己的提交遮罩，多半是它那次提交撞上了会话失效）——'
            + '已停止 UI 点击（硬点也没用）。请**刷新该选课页**后重新进入，插件会继续。');
          notify('请刷新选课页面', '页面卡在「正在提交中」遮罩上（页面自身的残留状态），刷新该页即可恢复。', true);
          setState(rt, 'retry', '页面卡在提交遮罩');
          return 'uistuck';
        }
        if (/找不到/.test(why)) {
          uiBlockedHere = true;
          log('err', '⚠ UI 点击在这页用不了：' + why + '。'
            + '这说明当前页面没有课程列表（是不是还停在选课首页/我的计划页？）。'
            + '请从首页点进「选课」页面 —— 插件会在那个页面上自动继续；本页面不再重试（避免空转刷屏）。');
          notify('请进入选课页面', why + '。从首页点进「选课」后插件会自动继续。', true);
          setState(rt, 'retry', '页面没有课程列表');
          return 'uipage';
        }
        log('warn', 'UI 点击失败：' + (why || '未知') + '　步骤：' + steps
          + '　→ 回退到直接发包（若有 token）');
        } finally {
          uiFeedInFlight = false;      // 无论成功失败都要解锁，否则之后永远不再喂 token
        }
      }

      if (missingVars.length) {
        const msg = '取不到页面参数 ' + missingVars.join('、') + '（' + JSON.stringify(pageVarSpec[missingVars[0]]) + '）'
          + '。这个系统的 csrfToken 不在响应、cookie、存储里，只能靠"页面发出请求时被我们录到"来学习 —— '
          + (uiBlockedHere ? '当前页面没有课程列表（UI 点击已判定不可用），请点进选课页。'
            : uiAllowed() ? 'UI 点击模式已尝试但没成功（看上面的日志），请手动在页面上点一次「选课 → 确定」。'
              : '请在页面上**手点一次「选课 → 确定」**（哪怕提示容量已满），插件学到后本次页面内就能自动提交了。');
        if (s.requirePageVars !== false) {
          rt.failStreak++;
          setState(rt, 'retry', '缺少 ' + missingVars.join('、'));
          // 这个情况会连续出现，日志按 60 秒节流，别让它在日志里刷屏
          if (Date.now() - lastNovarsLog > 60000) {
            lastNovarsLog = Date.now();
            log('warn', '跳过本轮提交：' + msg + '（避免发出必然失败的请求。这条提示每分钟最多记一次）');
          }
          return 'novars';
        }
        log('warn', msg);
      }
    }

    // mode=only：每次都走 UI 点击，不发 API 请求（最像真人，但慢 50~150ms）
    if (uiAllowed() && uiCfg().mode === 'only') {
      const t0 = Date.now();
      const rep = await uiClickFor(t);
      if (rep && rep.ok) {
        rt.tryCount++; stats.submitTry++;
        const judged = judgeUiClickResult(cfg, t0);
        if (judged.kind === 'success') { rt.okCount++; stats.submitOk++; setState(rt, 'success', '选课成功（UI 点击）'); notify('选课成功', (t.label || t.id) + ' 抢到了', false); return 'success'; }
        if (judged.kind === 'full') { stats.submitFull++; setState(rt, 'waiting', '名额已满（UI 点击）'); return 'full'; }
        if (judged.kind === 'dup') { stats.submitOk++; setState(rt, 'success', '已选过'); return 'dup'; }
        setState(rt, 'retry', judged.kind ? ('UI 点击 ' + judged.kind) : 'UI 点击未产生请求');
        return judged.kind || 'nouireq';
      }
      setState(rt, 'retry', 'UI 点击失败');
      return 'uifail';
    }
    const url = KX.renderTemplate(s.url, vars);
    const built = KX.buildBody(s.contentType, s.body, vars);
    const headers = cleanHeaders(Object.assign({ 'X-Requested-With': 'XMLHttpRequest' }, s.headers, built.headers));

    rt.tryCount++;
    stats.submitTry++;
    setState(rt, 'submitting', '第 ' + rt.tryCount + ' 次尝试');
    log('pkg', '▶ 提交 ' + (t.label || t.id) + ' → ' + (s.method || 'POST') + ' ' + url, built.body, { key: 'submit:' + normId(t.id) });

    const r = await replay({
      url: url, method: s.method || 'POST', headers: headers, body: built.body,
      timeoutMs: s.timeoutMs || 15000, referrer: s.referrer || ''
    }, s.via);
    stats.lastReq = { url: url, method: s.method || 'POST', status: r && r.status, ms: r && r.ms, at: Date.now() };

    // 登录态优先判定：掉线不算目标失败，避免无意义重试
    if (noteAuth(r, url, '提交')) {
      rt.state = 'paused-login';
      return 'login';
    }

    if (!r || r.status === 0) {
      rt.failStreak++;
      stats.submitErr++;
      setState(rt, 'retry', (r && r.error) || '网络错误');
      log('err', '✖ ' + (t.label || t.id) + ' 请求失败：' + ((r && r.error) || '未知'));
      return 'error';   // 退避统一由 cycle() 施加，避免两处各乘一次
    }

    const cls = R.classify(s.rules, r.body || '', r.status);
    const head = (r.body || '').slice(0, 300).replace(/\s+/g, ' ');
    switch (cls.kind) {
      case 'success':
        rt.okCount++;
        stats.submitOk++;
        backoffMult = 1;
        /* 只通知一次 —— 开了 keepPollingAfterSuccess 之后成功还会继续提交，
         * 不抑制的话每轮都弹一条"成功"（真抢到也就算了，误判时会很烦）。 */
        if (!rt.successNotified) {
          rt.successNotified = true;
          setState(rt, 'success', cfg.engine.keepPollingAfterSuccess ? '判定成功（继续轮询中）' : '选课成功');
          notify('判定选课成功', (t.label || t.id) + ' 的响应看起来是成功了：'
            + (r.body || '').replace(/\s+/g, ' ').slice(0, 100)
            + '　→ 正在核对「已选课程」确认。'
            + '（同名班仍在继续抢 —— 多抢到只是多退一次，误停会丢课，所以宁可不自动收手。）', false);
          /* 注意：这里**故意不**去停同名其它班。
           * 提交响应的判定只是猜测（真实教训：选上了却判成"无法判定"，猜错的代价是丢课），
           * 用户明确要求："应该抢到同名的继续抢，因为你的成功判定并不可靠"。
           * 想收手的话把 engine.autoStopSameName 设为 true —— 那只在「已选课程」**权威确认**后才停。 */
        }
        return 'success';
      case 'dup':
        stats.submitOk++;
        backoffMult = 1;
        if (!rt.successNotified) {
          rt.successNotified = true;
          setState(rt, 'success', cfg.engine.keepPollingAfterSuccess ? '已选过（继续轮询中）' : '已选过（视作完成）');
          notify('已选过该课程', (t.label || t.id) + ' 服务器返回"已选过"，应该是之前已经选上了。', false);
        }
        return 'dup';
      case 'full':
        stats.submitFull++;
        rt.failStreak = 0;
        setState(rt, 'waiting', '名额已满，继续监控');
        log('info', '- ' + (t.label || t.id) + ' 名额已满', '', { key: 'full:' + normId(t.id) });
        return 'full';
      case 'captcha':
        stats.halts++;
        setState(rt, 'blocked', '触发验证码');
        if ((cfg.engine.stopOn || {}).captcha !== false) halt('触发验证码，已自动停止并等待你手工处理', true);
        else log('err', '⚠ ' + (t.label || t.id) + ' 触发验证码：' + head);
        return 'captcha';
      case 'logout':
        auth.state = 'lost';
        auth.why = '提交响应命中登录失效特征';
        if ((cfg.engine.stopOn || {}).logout !== false) halt('登录态失效（' + head.slice(0, 80) + '）', true);
        return 'logout';
      case 'closed':
        setState(rt, 'blocked', '不在选课时间');
        if ((cfg.engine.stopOn || {}).closed !== false) halt('系统提示不在选课时间（' + head.slice(0, 80) + '）', true);
        return 'closed';
      case 'http':
        rt.failStreak++;
        stats.submitErr++;
        setState(rt, 'retry', 'HTTP ' + r.status);
        log('err', '✖ ' + (t.label || t.id) + ' HTTP ' + r.status + '：' + head);
        return (r.status === 429 || r.status === 503) ? 'http429' : 'http';
      default:
        rt.failStreak++;
        stats.submitErr++;
        setState(rt, 'retry', '结果未知');
        log('warn', '? ' + (t.label || t.id) + ' 结果无法判定，请检查 success 规则。响应片段：' + head);
        return 'unknown';
    }
  }

  /* ============================================================
   * 引擎：一轮
   * ============================================================ */
  function nextDelay(cfg) {
    /* 批次之间的间隔 = max(轮询间隔, 发包最小间隔)。
     * minGapMs 的语义已改：它现在是"**批次之间**的最小间隔"，不再是"每个请求之间硬等" ——
     * 逐请求硬等会把并发压回串行（那正是实测只有 92 次/分钟的原因之一）。 */
    const base = Math.max(
      clamp(Number(cfg.engine.intervalMs) || 1500, 300, 600000),
      clamp(Number(cfg.engine.minGapMs) || 0, 100, 10000)
    );
    const j = clamp(Number(cfg.engine.jitterPct) || 0, 0, 80) / 100;
    let d = base * (1 + (Math.random() * 2 - 1) * j);
    if (backoffMult > 1) d *= backoffMult;
    const maxMs = clamp(Number((cfg.engine.backoff || {}).maxMs) || 30000, 1000, 600000);
    return Math.round(clamp(d, 250, maxMs));
  }

  async function cycle() {
    const cfg = KX.snapshot();
    stats.cycles++;
    let hadError = false;
    let hardError = false;   // 429/503 这类「被限流」的强信号，退避要更狠

    // 1) 余量查询
    let list = null;
    if (cfg.query && cfg.query.enabled && cfg.query.url) {
      const q = await callQuery(cfg);
      if (q.ok) {
        board = q.list;
        boardAt = Date.now();
        list = q.list;
        stats.queryOk++;
        backoffMult = 1;
        /* 日志节流：以前每轮（1.5 秒一次）都把整段响应体写进日志，几十 KB 一条，
         * 结果日志页被刷满、真正有用的信息全被埋掉（真实教训）。
         * 现在只在「余量快照发生变化」时记一条带响应体的，其余按心跳记一行摘要。 */
        const sig = list.map(function (r) { return r.id + ':' + (isFinite(r.remain) ? r.remain : '?'); }).join('|');
        const summarize = function () {
          const free = list.filter(function (r) { return isFinite(r.remain) && r.remain > 0; });
          return list.length + ' 条，其中有余额 ' + free.length + ' 门'
            + (free.length ? '：' + free.slice(0, 5).map(function (r) { return (r.name || r.id) + '=' + r.remain; }).join('，') : '');
        };
        if (sig !== lastBoardSig) {
          lastBoardSig = sig;
          log('info', '余量快照变化 → ' + summarize(), (q.body || '').slice(0, 400));
        } else if (stats.queryOk % 40 === 0) {
          log('sys', '余量查询稳定中（每 40 轮记一次）：' + summarize());
        }
        if (globalThis.KXPanel && KXPanel.mounted) KXPanel.board(list, boardAt, { full: false, fullCount: boardFull.length, fullAt: boardFullAt });

        /* 自检：如果连续多轮「余量列表里一条都没有余额」，很可能是余量公式配错了
         * （例如 KXRS/DQRS 的含义与预期不同，导致算出来恒为 0）—— 那样插件会静默地
         * 一个请求都不发，日志看起来还一切正常。这种沉默失败必须吼出来。 */
        const freeCount = list.filter(function (r) { return isFinite(r.remain) && r.remain > 0; }).length;
        const noNumber = list.filter(function (r) { return !isFinite(r.remain); }).length;
        if (list.length && freeCount === 0) {
          zeroFreeStreak++;
          if (zeroFreeStreak === 12) {
            log('warn', '⚠ 已连续 12 轮查询到「所有课余量都是 0」' + (noNumber === list.length ? '（而且一条都没算出来——很可能字段名配错了）' : '')
              + '。如果这时候系统里其实还有名额，说明余量公式不对：请到设置页检查 query.parse 的 '
              + 'remainField / capacityField / usedField（本配置用的是 余量 = KXRS − DQRS），'
              + '或者直接拿学校页面显示的余量和这里对一下。');
          }
        } else {
          zeroFreeStreak = 0;
          if (freeCount > 0) zeroFreeWarned = true;
        }
      } else {
        stats.queryErr++;
        hadError = true;
        log('warn', '余量查询失败：' + q.error, (q.body || '').slice(0, 500));
      }
    }

    // 2) 逐目标处理
    /* 有"还没有ID"的目标（备选清单变来的）→ 立刻按课程名解析。
     * 不解析它们一个请求都发不出去（下面 filter 会把空 ID 的目标过滤掉），
     * 所以这里不等节流、也不等"查不到"才触发 —— 这就是用户要的
     * "进选课页自动查找模糊/相似课程并加入监控，不需要第一次手动操作"。 */
    if ((cfg.targets || []).some(function (t) { return t && t.enabled !== false && !String(t.id || '').trim(); })) {
      autoResolveTargets('有目标还没有教学班ID（备选清单）').catch(function () { });
    }
    const targets = (cfg.targets || []).filter(function (t) { return t && t.id && t.enabled !== false; });
    targets.sort(function (a, b) { return (Number(a.priority) || 99) - (Number(b.priority) || 99); });
    const maxConc = Math.max(1, Number(cfg.engine.maxConcurrent) || 1);
    const maxAtt = Number(cfg.engine.maxAttemptsPerTarget) || 0;
    const batch = [];              // 本轮要并发提交的目标
    let done = 0;
    let submitted = 0;             // 本轮实际发出的请求数（主循环据此决定要不要等间隔）

    /* 轮转起点：每轮从不同的目标开始，保证公平（后面的目标不会被饿死）。
     * 并发上限现在由 replay() 那一层的"在飞名额"统一把关，所以这里不再 break —— 
     * 整批一起发出去，由名额限制决定谁先谁后。 */
    const nT = targets.length;
    const ordered = nT ? targets.slice(cycleCursor % nT).concat(targets.slice(0, cycleCursor % nT)) : targets;
    cycleCursor = nT ? (cycleCursor + 1) % nT : 0;

    for (const t of ordered) {
      if (!running) return;
      const rt = rtOf(t.id);
      /* 成功/重复之后是否还继续提交这个目标：由 engine.keepPollingAfterSuccess 决定。
       * 打开时（默认）成功规则可以取得很宽松 —— 误判成功的代价只是多一条通知，
       * 而误判失败的代价是丢掉课程。 */
      if (!cfg.engine.keepPollingAfterSuccess && (rt.state === 'success' || rt.state === 'dup')) continue;
      if (rt.nextAt && Date.now() < rt.nextAt) continue;
      if (maxAtt && rt.tryCount >= maxAtt) {
        if (rt.state !== 'giveup') { setState(rt, 'giveup', '已达到最大尝试次数'); log('warn', (t.label || t.id) + ' 达到最大尝试次数，停止'); }
        continue;
      }

      // 2.1 余量闸门（查得到就只抢有余额的）
      let row = null;
      if (list) {
        row = list.find(function (r) { return normId(r.id) === normId(t.id); }) || null;
        if (row) {
          rt.remain = row.remain;
          if (row.name) rt.name = row.name;
          if (isFinite(row.remain) && row.remain <= 0) {
            setState(rt, 'waiting', '余量 ' + row.remain);
            continue;
          }
          if (isFinite(row.remain) && row.remain > 0) {
            log('ok', '★ 发现名额：' + (row.name || t.id) + ' 余量 ' + row.remain);
          }
        } else {
          // 查不到目标时，很可能它不在返回的这一页里（教务系统普遍分页）—— 明确指出怎么修
          setState(rt, 'notfound', boardFull.some(function (r) { return normId(r.id) === normId(t.id); })
            ? '不在自动轮询的那一页里（手动全量里有它）' : '本轮余量里没有这个 ID（可能在分页之外）');
          /* 跨年兜底：查不到就**自动按课程名找回**（教学班代码每年会变）。
           * 用户需求："新一年选课的时候自动监控和选择监控列表里模糊匹配的课"。
           * 内部有节流（默认 10 分钟一次）与置信度门槛（高分且唯一才自动改），
           * 所以不会因为一次脏数据就把目标改乱。 */
          autoResolveTargets('轮询时发现目标查不到').catch(function () { });
          if (!notFoundHinted) {
            notFoundHinted = true;
            const inFull = boardFull.some(function (r) { return normId(r.id) === normId(t.id); });
            log('warn', '目标 ' + t.id + ' 不在本轮余量结果里。'
              + (inFull
                ? '它**在**你刚才手动全量查到的列表里，说明只是自动轮询的 pageSize（'
                  + (/pageSize=(\d+)/.exec((cfg.query || {}).body || '') || [, '?'])[1]
                  + '）太小、没覆盖到它 —— 把设置里 query.body 的 pageSize 调大（比如 200）即可。'
                : '正在尝试按课程名自动找回（教学班代码可能变了）；找不到会提示你去档案页手工选。')
              + '（注意：调大 pageSize 会让每轮请求的响应变大。）');
          }
          continue;   // 查不到就不盲发，避免误提交
        }
      }

      // 2.2 提交前确认
      if (cfg.engine.confirmBeforeSubmit && !approved.has(normId(t.id))) {
        setState(rt, 'needconfirm', '等待你确认提交');
        continue;
      }

      // 2.3 只监控不提交
      if (cfg.engine.submitOnHit === false) {
        if (!row || (isFinite(row.remain) && row.remain > 0)) {
          if (rt.state !== 'ready') {
            setState(rt, 'ready', '有名额（仅监控模式）');
            notify('发现名额', (row && (row.name || row.id) || t.id) + ' 余量 ' + (row && row.remain), false);
          }
        }
        continue;
      }

      // 2.4 登录态兜底
      if ((cfg.session || {}).requireLoginBeforeSubmit !== false && auth.state === 'lost') {
        setState(rt, 'paused-login', '登录态失效，已暂停提交');
        continue;
      }

      /* 收集这一批要提交的目标，**并发**发出。
       * 以前是一个一个 await（每个之间还硬等 minGapMs）→ 9 个目标光等待就 0.9 秒，
       * 后台标签页里更被定时器降频放大十倍（实测只有 92 次/分钟，而上限是 600）。
       * 现在：并发上限与速率上限都在 replay() 那一层统一把关（在飞名额 + 每分钟滑动窗口），
       * 所以这里可以放心地把整批一起发出去。 */
      batch.push(t);
    }

    if (batch.length && running) {
      done = batch.length;
      submitted = batch.length;
      const results = await Promise.all(batch.map(function (t) {
        return submitOne(cfg, t, rtOf(t.id)).catch(function (e) {
          log('warn', (t.label || t.id) + ' 提交异常：' + ((e && e.message) || e));
          return 'error';
        });
      }));
      results.forEach(function (kind) {
        if (kind === 'http429') { hadError = true; hardError = true; }
        else if (kind === 'error' || kind === 'http' || kind === 'unknown') hadError = true;
      });
      if (!running) return submitted;
    }

    // 退避只在这一处施加（submitOne 只负责判定结果），
    // 否则会被这里的 else 分支把 429 的退避重置掉。
    if (hardError) backoffMult = clamp(backoffMult * 4, 1, 64);
    else if (hadError) backoffMult = clamp(backoffMult * (Number(cfg.engine.backoff.onError) || 2), 1, 32);
    else backoffMult = 1;
    saveRuntime();
    broadcastStatus();
    /* 返回"这一轮真的发出了几个请求" —— 主循环据此决定要不要再等间隔：
     * 有提交就立刻下一轮（速率交给令牌桶控），没提交才按 intervalMs 等。 */
    return submitted;
  }

  /** 引擎主循环。
   *  关键点：**这一轮真的发出了请求，就不要再等间隔** ——
   *  速率已经完全由令牌桶（gate）控制，额外的等待只会白白浪费令牌。
   *  真实数据：9 个目标、目标速率 400/分钟（每 150ms 一个令牌）→
   *  一轮 9 个提交本来就要 1.35 秒，若再等一个 intervalMs（后台标签页会被钳到 1 秒），
   *  一轮变成 2.35 秒发 9 个 = 229 次/分钟 —— 实测 261，与这个算法完全吻合。
   *  另外：为 0 的等待**不要走 setTimeout**（后台标签页会把 0 也钳到 1 秒），
   *  直接在循环里接着跑。 */
  async function tick() {
    if (!running) return;
    for (;;) {
      if (!running) return;
      let submitted = 0;
      try {
        submitted = await cycle() || 0;
      } catch (e) {
        log('err', '引擎异常：' + (e && e.message ? e.message : e));
      }
      if (!running) return;
      if (submitted > 0) { nextRunAt = Date.now(); continue; }   // 有提交 → 立刻下一轮
      const d = nextDelay(KX.snapshot());
      nextRunAt = Date.now() + d;
      const t0 = Date.now();
      await sleep(d);
      /* 检测「浏览器把定时器降频」——这是**代码无法绕过**的浏览器行为：
       * 页面隐藏 5 分钟后，Chrome 把定时器限到每分钟 1 次（省电）。
       * 后果：循环每分钟只醒一次 → 发一批就睡 30-60 秒 → 实测速率掉到目标的 1/10。
       * 真实数据：间隔出现 0,0,0,0,0,0,0,0（一批同时发）、然后 30/43/57 秒的静默。
       * 必须让用户看见这件事，否则会以为是"并发不够"。 */
      const actual = Date.now() - t0;
      if (actual > d * 3 + 500) {
        if (Date.now() - (lastThrottleWarnAt || 0) > 120000) {
          lastThrottleWarnAt = Date.now();
          log('err', '⚠ 浏览器在给后台标签页降频：本轮实际等了 ' + actual + 'ms（预期 ' + Math.round(d)
            + 'ms，慢了约 ' + Math.round(actual / Math.max(1, d)) + ' 倍）——**实测速率会被压到目标的几分之一**。'
            + '解法：把这个选课标签页切到前台（保持窗口可见、不要最小化），速率立刻恢复。'
            + '（这是 Chrome 的省电策略，插件无法绕过。）');
        }
      }
      if (!running) return;
      broadcastStatus();
    }
  }

  /* ============================================================
   * 启动 / 停止 / 定时开抢
   * ============================================================ */
  function halt(reason, urgent) {
    const wasRunning = running;
    running = false;
    status = 'halted';
    statusText = reason;
    lastHaltAt = Date.now();       // 面板据此区分「速率低是因为停机」还是「被限流」
    if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
    if (wasRunning) stats.halts++;
    // 只有「登录相关」的停机才自动恢复：验证码/未开放这类需要你亲自处理，
    // 自动重启只会把请求继续打出去，反而更危险。
    /* 主动停机（验证码/未开放/时间冲突这类）→ 把 enabled 置 false：
     * 意味着"用户想让它跑"这个意图被撤回了，需要你处理完手动点启动。
     * 登录相关停机则**保留 enabled=true** → 登录成功后自动继续（这是你要的"自动进行"）。 */
    if (!loginRelated) setWantRunning(false);
    saveRuntime();
    if (urgent) notify('已自动停止', reason, true);
    else log('warn', '引擎已停止：' + reason);
    if (!loginRelated) {
      log('warn', '处理完之后在面板上点「启动」即可继续；也可以给 engine.scheduleAt 设个定时开抢。');
    }
    if (globalThis.KXPanel && KXPanel.mounted) KXPanel.status(snapshotStatus());
    broadcastStatus();
  }

  /** 当前页面允许跑引擎吗（worker.urlRe 限制）。
   *  真实事故：自动继续在"选课首页"启动了引擎，而首页没有课程列表 →
   *  UI 点击找不到「选课」按钮 → token 学不到 → 每 3 秒循环一次无效操作。 */
  function pageAllowedForEngine(cfg) {
    const re = ((cfg.worker || {}).urlRe || '').trim();
    if (!re) return { ok: true };
    try {
      if (new RegExp(re, 'i').test(location.href)) return { ok: true };
      return { ok: false, error: '当前页面不是选课页（worker.urlRe = ' + re + '，当前 ' + location.href + '）。'
        + '请先回到首页 → 点进选课页，插件会在那里自动继续。' };
    } catch (e) {
      return { ok: true };   // 正则写错时不拦，避免把自己锁死
    }
  }

  async function start(reason, opts) {
    const cfg = KX.snapshot();
    if (!ACTIVE) return { ok: false, error: '当前站点不在插件白名单里' };
    const allow = pageAllowedForEngine(cfg);
    if (!allow.ok) { log('warn', '拒绝启动：' + allow.error); return { ok: false, error: allow.error }; }
    // 「只监控不提交」需要有余量查询接口；需要提交时必须有提交模板。
    const needSubmit = cfg.engine.submitOnHit !== false;
    if (needSubmit && !(cfg.submit || {}).url) {
      const msg = '还没配置提交接口：先在「抓包」页手工选一次课，然后点「设为提交模板」';
      log('err', msg);
      return { ok: false, error: msg };
    }
    if (!needSubmit && !(cfg.query.enabled && cfg.query.url)) {
      const msg = '当前是「只监控不提交」模式，但还没配余量查询接口：先在「抓包」页把课表/余量那条请求设为「余量查询模板」';
      log('err', msg);
      return { ok: false, error: msg };
    }
    const targets = (cfg.targets || []).filter(function (t) { return t && t.id && t.enabled !== false; });
    if (!targets.length) return { ok: false, error: '还没有监控目标：在「目标」页添加要监测的选课ID' };

    // 模板里用了 {{kch}} 就必须每个目标都填课程号，否则会发出 kch_id= 这样的空值，
    // 提交十有八九失败 —— 提前吼一声，别等白刷几十次才发现。
    const bodyTpl = (cfg.submit || {}).body || '';
    if (/\{\{\s*kch\s*\}\}/.test(bodyTpl)) {
      const missing = targets.filter(function (t) { return !String(t.kch || '').trim(); });
      if (missing.length) {
        log('warn', '⚠ 提交模板用了 {{kch}}，但这些目标没填课程号：' + missing.map(function (t) { return t.id; }).join('、')
          + '。它们会被替换成空值，提交很可能失败——请在「目标」页补上课程号，或把 body 里的 {{kch}} 改回固定值。');
      }
    }

    await claimWorker();
    setWantRunning(true);

    /* 启动时先核对一次「已选课程」（权威判据）：
     * 立刻就能发现"这个目标其实早就选上了"（真实事故：选上了却还在傻抢，
     * 而响应一直是「名额已满」—— 因为服务器先校验容量、后校验重复）。 */
    if ((cfg.mine || {}).url) checkMine({ quiet: true }).catch(function () { });

    // 定时开抢
    const at = (cfg.engine.scheduleAt || '').trim();
    const forceNow = !!(opts && opts.now);
    if (!forceNow && at && /^\d{1,2}:\d{2}(:\d{2})?$/.test(at)) {
      const secs = parseHms(at);
      const now = new Date();
      const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      target.setSeconds(secs);
      if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
      const wait = target.getTime() - Date.now();
      status = 'scheduled';
      statusText = '已定时：' + hhmmss(target) + '（' + Math.round(wait / 1000) + ' 秒后启动）';
      if (schedTimer) clearTimeout(schedTimer);
      schedTimer = setTimeout(function () {
        schedTimer = null;
        log('ok', '定时开抢时间到，启动引擎');
        // 注意：这里必须用 { now: true } 绕过定时分支，否则会又算出「明天这个时候」
        start('定时开抢', { now: true, clearSchedule: true });
      }, wait);
      log('ok', '已定时开抢 ' + hhmmss(target) + '（本地时钟，注意与本机时间是否准确）');
      broadcastStatus();
      return { ok: true, scheduledAt: target.getTime() };
    }

    return await startNow(reason, !!(opts && opts.clearSchedule));
  }

  /** 真正开始跑循环（不走定时分支） */
  async function startNow(reason, clearSchedule) {
    const cfg = KX.snapshot();
    if (running) return { ok: true, already: true };
    running = true;
    thisPageWasWorker = true;      // 记住"本页面就是干活的页面"：掉线停机后它仍负责开登录页
    status = cfg.engine.submitOnHit === false ? 'monitor' : 'running';
    statusText = cfg.engine.submitOnHit === false ? '监控中（不自动提交）' : '抢课中';
    stats.startedAt = Date.now();
    backoffMult = 1;
    if (clearSchedule) {
      // 定时开抢是一次性的：触发后清掉，免得下次点「启动」又排到明天
      KX.save({ engine: { scheduleAt: '' } }).catch(function () {});
      log('sys', '定时开抢已触发，engine.scheduleAt 已清空（想要下次定时请重新填）');
    }
    const targets = (cfg.targets || []).filter(function (t) { return t && t.id && t.enabled !== false; });
    const blind = !(cfg.query && cfg.query.enabled);
    log('ok', '引擎启动（' + (reason || '手动') + '）：' + targets.length + ' 个目标，间隔 ' + cfg.engine.intervalMs + 'ms，'
      + (blind ? '盲发模式（不查余量，直接提交）' : '先查余量再抢') + (document.hidden ? '（注意：当前标签页在后台，浏览器可能降频）' : ''));
    if (blind) {
      /* 盲发 = 高频写提交接口，这是风控最敏感的行为。把真实速率算给用户看，
       * 并说明"两个闸门取小"这个关系 —— 否则用户调了并发但速率没变，会以为插件坏了。 */
      const perMin = clamp(Number(cfg.engine.maxReqPerMinute) || 120, 5, 3000);
      const gap = clamp(Number(cfg.engine.minGapMs) || 300, 100, 10000);
      const gapCap = Math.floor(60000 / gap);
      const eff = Math.min(perMin, gapCap);
      const n = targets.length || 1;
      const each = eff / n;
      log('warn', '⚠ 盲发模式速率：每分钟上限 ' + perMin + ' 次 ｜ 发包最小间隔 ' + gap + 'ms（单独看允许 '
        + gapCap + ' 次/分钟）→ 实际约 ' + eff + ' 次/分钟。当前 ' + n + ' 个目标 → 每个目标约 '
        + each.toFixed(0) + ' 次/分钟（≈每 ' + (each > 0 ? (60 / each).toFixed(1) : '∞') + ' 秒轮到一次）。'
        + '速率由这两者取小决定，所以要提速必须一起调。目标越多每个越慢（总预算共享）；不想要的课点「停」而不是留着。'
        + (n >= 6 ? '　（提示：目标较多时，「先查余量再抢」每轮只用 1 次请求就能覆盖全部课程，通常更划算。）' : ''));
    }
    if (document.hidden) log('warn', '工作标签页处于后台/最小化，定时器可能被浏览器降频，建议让这个页面保持可见');
    broadcastStatus();
    tick();
    return { ok: true };
  }

  function stop(reason) {
    running = false;
    status = 'stopped';
    statusText = '已停止' + (reason ? '：' + reason : '');
    if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
    if (schedTimer) { clearTimeout(schedTimer); schedTimer = null; }
    nextRunAt = 0;
    setWantRunning(false);
    saveRuntime();
    log('info', '引擎已停止' + (reason ? '（' + reason + '）' : ''));
    if (globalThis.KXPanel && KXPanel.mounted) KXPanel.status(snapshotStatus());
    broadcastStatus();
  }

  function parseHms(s) {
    const p = String(s).split(':').map(Number);
    return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
  }

  async function claimWorker() {
    const r = await toBg({ type: 'kx:whoami' });
    if (r && r.tabId != null) {
      myTabId = r.tabId;
      toBg({ type: 'kx:claim-worker', tabId: r.tabId, href: location.href });
    }
  }

  /* ============================================================
   * 状态快照（给面板/弹窗/角标）
   * ============================================================ */
  function targetsView() {
    const cfg = KX.snapshot();
    return (cfg.targets || []).map(function (t) {
      const rt = runtime.get(normId(t.id)) || {};
      return {
        id: t.id, label: t.label || '', kch: t.kch || '',
        enabled: t.enabled !== false, priority: Number(t.priority) || 99,
        state: rt.state || 'idle', tryCount: rt.tryCount || 0, okCount: rt.okCount || 0,
        lastMsg: rt.lastMsg || '', remain: rt.remain, name: rt.name,
        lastAt: rt.lastAt || 0, nextAt: rt.nextAt || 0,
        needConfirm: cfg.engine.confirmBeforeSubmit && !approved.has(normId(t.id))
      };
    });
  }

  function snapshotStatus() {
    const cfg = KX.snapshot();
    return {
      active: ACTIVE, host: HOST, href: location.href, bridgeReady: bridgeReady, tabId: myTabId,
      running: running, status: status, statusText: statusText,
      scheduleAt: (cfg.engine || {}).scheduleAt || '',
      nextRunAt: nextRunAt, backoffMult: backoffMult,
      stats: Object.assign({}, stats),
      auth: {
        state: auth.state, why: auth.why, lastOkAt: auth.lastOkAt, lastProbeAt: auth.lastProbeAt,
        lastProbeText: lastProbeText,          // 最近一次体检的结论（面板显示，便于一眼看出卡在哪）
        loginAt: auth.loginAt, loginSource: auth.loginSource, observedAt: auth.observedAt,
        lifetimeSamples: (auth.lifetimeSamples || []).slice(),
        effectiveHardTimeoutMs: effectiveHardTimeoutMs(),
        leftMs: authLeftMs(), loginUrl: auth.loginUrl
      },
      targets: targetsView(),
      boardAt: boardAt, board: board,
      captureCount: captures.length,
      logCount: logs.length,
      /* 实测速率：闸门里保留了最近 60 秒的发包时刻，直接数一下就知道真跑了多快。
       * 它是判断"服务器是否在限流我"的最直接指标 —— 配了 400 却只有 50，
       * 说明出现了退避（大概率被限流/被拒）。 */
      reqPerMinute: reqTimes.length,
      lastHaltAt: lastHaltAt,          // 最近一次停机的时刻（用来区分"速率低"是停机还是被限流）
      throttledAt: lastThrottleWarnAt, // 最近一次检测到"浏览器后台降频"的时刻（面板据此说明速率为什么低）
      backoffMult: backoffMult,
      push: lastPush, pushMuted: pushMuted,
      pendingPush: pushBatch.length + pushLogBatch.length
    };
  }

  let bcTimer = null;
  function broadcastStatus() {
    if (bcTimer) return;
    bcTimer = setTimeout(function () {
      bcTimer = null;
      if (destroyed) return;
      toBg({ type: 'kx:status', status: snapshotStatus() });
    }, 200);
  }

  /* ============================================================
   * 推送到本地收集器（tools/collector.mjs）
   * ------------------------------------------------------------
   * 走 background 发（扩展源的 fetch 不受页面 CORS 限制，也不带站点 Cookie）。
   * 攒批推送，避免抓包高峰把本地服务打爆。
   * ============================================================ */
  const pushBatch = [];         // 待推送的抓包记录
  const pushLogBatch = [];      // 待推送的日志
  let pushTimer = null;
  let pushingNow = false;       // 推送进行中：此时产生的日志不再入队，否则会「推送→记日志→再推送」自激
  let pushMuted = false;        // 连续失败后静音，避免刷屏
  let pushFailStreak = 0;
  let lastPush = { at: 0, ok: false, entries: 0, logs: 0, error: '' };

  function pushCfg() { return (KX.snapshot().debug) || {}; }

  function queuePush(entry) {
    if (pushMuted) return;
    pushBatch.push(entry);
    const max = clamp(Number(pushCfg().maxBatch) || 40, 1, 200);
    while (pushBatch.length > max * 3) pushBatch.shift();
    schedulePush();
  }

  function queuePushLog(item) {
    if (pushMuted || pushingNow) return;              // 关键：防止自激
    if (pushCfg().pushLogs === false) return;
    pushLogBatch.push({ t: item.t, level: item.level, msg: item.msg, extra: item.extra || '' });
    while (pushLogBatch.length > 400) pushLogBatch.shift();
    schedulePush();
  }

  function schedulePush() {
    if (pushTimer || pushingNow || pushMuted) return;
    const ms = clamp(Number(pushCfg().batchMs) || 1000, 200, 10000);
    pushTimer = setTimeout(function () { pushTimer = null; flushPush(); }, ms);
  }

  /** 推送（攒批到点自动调，或面板「立即推送」强制调）
   *  注意：函数内部不要用 log() 之外的方式报错，log() 在 pushingNow 期间不会入队。 */
  async function flushPush(force) {
    const d = pushCfg();
    if (!d.collectorUrl) {
      if (force) log('warn', '还没填本地收集器地址（设置 → 本地抓包落盘）');
      return { ok: false, error: '还没填本地收集器地址' };
    }
    if (!force && !d.autoPush) return { ok: true, skipped: true };

    // 手动点「推送」时的直觉是「把我现在抓到的都推过去」。但抓包记录只在 autoPush 打开时
    // 才入队（queuePush 里有那个判断），所以这里必须补一次：否则会只推走日志、0 条抓包 —— 这个坑真踩过。
    if (force && globalThis.KXExport) {
      const inBatch = new Set(pushBatch.map(function (e) { return e.ts + '|' + e.url; }));
      captures.forEach(function (c) {
        const k = c.ts + '|' + c.url;
        if (!inBatch.has(k)) { inBatch.add(k); pushBatch.push(KXExport.redactCapture(c)); }
      });
    }

    if (!pushBatch.length && !pushLogBatch.length) {
      if (force) log('info', '没有待推送的抓包记录（页面上还没抓到请求，或者抓包前没刷新页面）');
      return { ok: true, empty: true };
    }

    const max = clamp(Number(d.maxBatch) || 40, 1, 200);
    const entries = pushBatch.splice(0, max);
    const logsOut = pushLogBatch.splice(0, max * 5);
    pushingNow = true;
    let r = null;
    try {
      r = await toBg({
        type: 'kx:push',
        url: d.collectorUrl,
        payload: { source: 'kx-grabber', host: HOST, pageUrl: location.href, entries: entries, logs: logsOut }
      });
    } finally {
      pushingNow = false;
    }

    lastPush = { at: Date.now(), ok: !!(r && r.ok), entries: entries.length, logs: logsOut.length, error: (r && (r.error || r.body)) || '' };
    let summary = null;
    if (r && r.ok && typeof r.body === 'string') { try { summary = JSON.parse(r.body); } catch (e) { summary = null; } }
    if (r && r.ok) {
      pushFailStreak = 0;
      if (summary) lastPush.added = summary.added;
      // 只有手动推送才记日志，否则每批都刷一条会淹没日志页
      if (force) log('ok', '已推送 ' + entries.length + ' 条抓包、' + logsOut.length + ' 条日志到本地收集器'
        + (summary ? '（服务端新增 ' + summary.added + ' 条，累计 ' + summary.total + ' 条）' : ''));
    } else {
      pushFailStreak++;
      pushBatch.unshift.apply(pushBatch, entries);     // 失败不丢数据，下轮重试
      pushLogBatch.unshift.apply(pushLogBatch, logsOut);
      if (pushFailStreak === 1 || force) {
        log('warn', '推送本地收集器失败：' + (lastPush.error || '无响应')
          + ' —— 先在项目目录跑 node tools/collector.mjs，并确认地址是 http://127.0.0.1:8790/kx/captures');
      }
      if (pushFailStreak >= 5) {
        pushMuted = true;
        log('err', '本地收集器连续 ' + pushFailStreak + ' 次推送失败，已暂停自动推送（不影响抓包与抢课）。修好后点「测试连接」即可恢复。');
      }
    }
    if (globalThis.KXPanel && KXPanel.mounted) KXPanel.status(snapshotStatus());
    if (!pushMuted && (pushBatch.length || pushLogBatch.length)) schedulePush();
    return Object.assign({}, r || {}, summary && typeof summary.added === 'number' ? { added: summary.added, total: summary.total } : {});
  }

  async function pingCollector() {
    const d = pushCfg();
    if (!d.collectorUrl) return { ok: false, error: '还没填本地收集器地址' };
    const base = String(d.collectorUrl).replace(/\/kx\/captures.*$/, '').replace(/\/+$/, '');
    const r = await toBg({ type: 'kx:ping-collector', url: base + '/kx/ping' });
    pushMuted = false;
    pushFailStreak = 0;
    if (r && r.ok && r.body) {
      log('ok', '收集器连接正常：已落盘 ' + (r.body.entries != null ? r.body.entries : '?') + ' 条；文件 '
        + (((r.body.files || {}).har) || '') + '（自动推送已恢复）');
    } else {
      log('warn', '收集器连接失败：' + ((r && (r.error || r.body)) || '无响应') + ' —— 先在项目目录跑 node tools/collector.mjs');
    }
    return r;
  }

  /** 打包当前所有抓包记录（面板「导出抓包」用，导出的是 HAR，可直接喂 har2config） */
  function exportCaptures() {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
    const entries = captures.slice();
    if (globalThis.KXExport) {
      return {
        filename: 'kx-captures-' + stamp + '.har',
        text: JSON.stringify(KXExport.toHar(entries, { host: HOST, pageUrl: location.href }), null, 2)
      };
    }
    return {
      filename: 'kx-captures-' + stamp + '.json',
      text: JSON.stringify({ source: 'kx-grabber', host: HOST, pageUrl: location.href, entries: entries, logs: logs.slice(-200) }, null, 2)
    };
  }

  /* ============================================================
   * 页面取值：csrfToken 这类「每次会话都会变、不能写死在配置里」的参数
   * ------------------------------------------------------------
   * 真实背景：吉大研究生选课的提交必须带 csrfToken，而它只出现在请求体里，
   * 任何接口响应都不返回它 —— 重新登录后必然变化，写死就会全部提交失败。
   * 三条腿走路：
   *   ① 提交前实时到页面里取（window / cookie / localStorage / meta）
   *   ② 兜底用「从抓到的真实请求里学到的」值
   *   ③ 两条都取不到就**不发包**（避免发出必然失败的请求去刷风控）
   * ============================================================ */
  const learnedTokens = {};        // host -> { key: value }
  const learnedAt = {};            // host -> 学到这些值的时刻（用于判断是否已被页面刷新作废）
  let learnedLoaded = false;
  const BOOT_AT = Date.now();      // 本页面加载时刻：晚于它学到的 token 才在本次页面里有效

  /** 把持久化的「学到的 token」读回来。
   *  必须做的原因：这个值是从抓包学来的，而刷新/重载页面会清空内存 ——
   *  不读回来就等于每次刷新都丢掉 token，提交会静默失败。 */
  async function loadLearnedTokens() {
    if (learnedLoaded) return;
    learnedLoaded = true;
    try {
      const got = await chrome.storage.local.get(['kx_learned_tokens', 'kx_learned_at']);
      const saved = got && got.kx_learned_tokens;
      if (saved && typeof saved === 'object') {
        Object.keys(saved).forEach(function (h) {
          learnedTokens[h] = Object.assign({}, learnedTokens[h] || {}, saved[h] || {});
        });
      }
      const at = got && got.kx_learned_at;
      if (at && typeof at === 'object') Object.keys(at).forEach(function (h) { learnedAt[h] = Number(at[h]) || 0; });

      /* 实测结论：这个系统的 csrfToken 是**每次页面加载换一个**（不是每次登录）。
       * 所以本次页面加载之前学到的 token 已经作废，用它提交只会被服务器拒绝、
       * 还会白白刷请求。这里明确判定为"过期"，不参与取值。 */
      if (learnedAt[HOST] && learnedAt[HOST] < BOOT_AT) {
        const ageMin = ((BOOT_AT - learnedAt[HOST]) / 60000).toFixed(1);
        const willAuto = ((KX.snapshot().ui) || {}).enabled !== false && ((KX.snapshot().ui) || {}).mode !== 'off';
        log('warn', '上次学到的会话参数（' + Object.keys(learnedTokens[HOST] || {}).join('、') + '）是在 '
          + ageMin + ' 分钟前、也就是**上一次页面加载时**学到的，而这类 token 每次页面加载都会换 —— 已判定过期、不再使用。'
          + (willAuto
            ? 'UI 点击模式已启用：引擎发起提交时会自动让页面点一次「选课 → 确定」把新 token 喂进来（那次点击也是一次真实尝试），你不用手动点。'
            : '需要你在页面上**手点一次「选课 → 确定」**，让插件学到本次页面的新 token。'));
      }
    } catch (e) { /* ignore */ }
  }
  let pageSnapshot = null;
  let pageSnapshotAt = 0;

  /** 从抓到的请求体里学 token（用户手工点一次选课，就能把当前会话的 token 学到） */
  function learnTokensFrom(entry) {
    if (!entry || !entry.url || !entry.reqBody) return;
    let host = '';
    try { host = new URL(entry.url).hostname; } catch (e) { return; }
    const body = String(entry.reqBody);
    const found = {};
    // form 风格：key=value
    body.split('&').forEach(function (seg) {
      const i = seg.indexOf('=');
      if (i <= 0) return;
      const k = seg.slice(0, i);
      const v = seg.slice(i + 1);
      if (/token|csrf|nonce/i.test(k) && v && v.length >= 8) found[k] = v;
    });
    // json 风格
    if (/^\s*\{/.test(body)) {
      try {
        JSON.parse(body);
        Object.keys(JSON.parse(body)).forEach(function (k) {
          const v = JSON.parse(body)[k];
          if (/token|csrf|nonce/i.test(k) && typeof v === 'string' && v.length >= 8) found[k] = v;
        });
      } catch (e) { /* 不是合法 JSON 就算了 */ }
    }
    const keys = Object.keys(found);
    if (!keys.length) return;
    learnedTokens[host] = Object.assign({}, learnedTokens[host] || {}, found);
    learnedAt[host] = Date.now();
    try {
      chrome.storage.local.set({ kx_learned_tokens: learnedTokens, kx_learned_at: learnedAt });
    } catch (e) { /* ignore */ }
    log('sys', '从抓包中学到 ' + host + ' 的会话参数：' + keys.join('、')
      + '（本次页面加载有效；下次页面加载会换新值，届时要重新学）');
  }

  /** 让页面报一次「我能看到的 token 都在哪」（不带 eval，避开页面 CSP） */
  async function probePageValues(quiet) {
    const r = await toPage({ type: 'probe-values' }, 6000);
    if (!r || !r.snapshot) {
      if (!quiet) log('warn', '页面探测失败：' + ((r && r.error) || '无响应'));
      return null;
    }
    pageSnapshot = r.snapshot;
    pageSnapshotAt = Date.now();
    const summary = {
      globals: Object.keys(r.snapshot.globals || {}),
      cookies: (r.snapshot.cookieInfo || []).map(function (c) { return c.name; }),
      localStorage: Object.keys((r.snapshot.storage || {}).local || {}),
      sessionStorage: Object.keys((r.snapshot.storage || {}).session || {}),
      metas: Object.keys(r.snapshot.metas || {}),
      hits: r.snapshot.hits || []
    };
    if (!quiet) {
      const hits = (summary.hits || []).slice(0, 15).map(function (h) {
        const tag = h.kind === 'hex32' ? '   ← storage 里的 32 位十六进制，最像 csrfToken'
          : h.kind === 'html-hex32' ? '   ← 页面 HTML/内联脚本里（前一截：' + (h.ctx || '') + '）'
          : h.kind === 'window-hex32' ? '   ← window 上的字符串属性（键名不像 token，但值是 32 位十六进制）'
          : h.kind === 'input-hex32' ? '   ← 表单隐藏字段里'
          : '   ← 键名含 token/csrf';
        return h.where + '  =  ' + h.value + tag;
      });
      log('sys', '页面探测：全局变量[' + summary.globals.join(',') + ']　cookie[' + summary.cookies.join(',')
        + ']　localStorage[' + summary.localStorage.join(',') + ']　sessionStorage[' + summary.sessionStorage.join(',') + ']',
        JSON.stringify({ cookieInfo: r.snapshot.cookieInfo, storageInfo: r.snapshot.storageInfo, hits: summary.hits }).slice(0, 8000));
      if (hits.length) log('ok', '发现 token 候选（' + hits.length + ' 条）：\n  ' + hits.join('\n  '));
      else log('warn', '页面里没找到 token 候选：它可能来自某个接口响应，或者叫别的名字。把上面那行键名发我。');
    }
    return r.snapshot;
  }

  /** 解析配置里的 submit.pageVars → {csrfToken: '...'} */
  async function resolvePageVars(spec) {
    const keys = Object.keys(spec || {});
    if (!keys.length) return {};
    // 快照超过 30 秒就重新取一次（token 会随会话变）
    if (!pageSnapshot || Date.now() - pageSnapshotAt > 30000) {
      await probePageValues(true);
    }
    // 只用「本次页面加载之后」学到的值；更早的属于上一次页面，已经作废
    const learned = (learnedAt[HOST] && learnedAt[HOST] >= BOOT_AT) ? (learnedTokens[HOST] || {}) : {};
    const out = {};
    keys.forEach(function (k) {
      try {
        const v = KX.resolvePageVar(spec[k], pageSnapshot || {}, learned);
        if (v) out[k] = v;
      } catch (e) { /* 单条失败不影响其它 */ }
    });
    return out;
  }

  /** 从抓到的请求里识别「你刚登录了」。
   *  为什么必须靠这个：吉大正方的登录接口和选课系统**同一个域名**
   *  （yjsxk.jlu.edu.cn/.../login/check/login.do），background 那套
   *  「访问了非白名单主机上的登录页」的检测永远不会触发。
   *  而登录请求本身会被我们录到 —— 这是最可靠的信号。 */
  function noteLoginRequest(entry) {
    if (!entry || String(entry.method).toUpperCase() !== 'POST') return;
    if (!KX.isLoginEndpoint(entry.url)) return;
    const snippet = String(entry.resp || '').replace(/\s+/g, ' ').slice(0, 160);
    if (!KX.looksLoginSuccess(entry.resp)) {
      log('warn', '检测到一次登录尝试（看起来没成功）：' + snippet);
      return;
    }
    const old = auth.loginAt;
    /* 关键：**不要**在这里把 state 置成 'ok' —— 那会把「刚才还是掉线状态」这个证据抹掉，
     * 导致 noteAuth 里的 wasLost 分支不再成立 → 重新登录后不会自动继续抢课。
     * 只重置锚点与提醒标记，state 转换交给下一次成功的探测（它会顺带触发自动继续）。 */
    auth.loginAt = 0;
    auth.observedAt = 0;
    auth.loginSource = '';
    warnFlighted = false;
    autoOpenedLogin = false;
    hardTimeoutDisproved = false;    // 新会话，重新累计"存活时长"
    saveRuntime();
    // 顺手写一个标记：万一下一步页面会整页跳转（内容脚本重启），新页面加载时也能据此重置
    try {
      chrome.storage.local.set({ [LOGIN_FLOW_KEY]: { at: Date.now(), url: entry.url, host: HOST } });
    } catch (e) { /* ignore */ }
    log('ok', '检测到登录成功 → 登录时刻锚点已重置到现在（旧值 ' + (old ? hhmmss(old) : '无') + '）。'
      + 'csrfToken 这类会话参数会在下次提交前重新从页面读取，不会被旧值污染。');
  }

  /* ============================================================
   * UI 点击（混合模式的"喂 token"）
   * ------------------------------------------------------------
   * 页面自己点「选课 → 确定」时，请求由页面 JS 发出 → 会带上它内部的 csrfToken
   * → 我们的录包钩子抓到那条请求 → learnTokensFrom 自动学到 token。
   * 而且这次点击本身就是一次真实抢课尝试，不浪费请求额度。
   * 之后就用最快的 API 盲发跑高频。
   * ============================================================ */
  function uiCfg() { return (KX.snapshot().ui) || {}; }
  function uiAllowed() {
    const u = uiCfg();
    return u.enabled !== false && u.mode !== 'off';
  }

  /** 点击目标课程那一行的「选课」→「确定」 */
  async function uiClickFor(target) {
    const u = uiCfg();
    const key = String(target.kch || target.label || target.id || '').trim();
    const report = await toPage({
      type: 'ui-click',
      payload: { key: key, ui: { selectText: u.selectText, confirmText: u.confirmText, maxMs: u.maxMs, stepMs: u.stepMs } }
    }, clamp(Number(u.maxMs) || 5000, 1000, 20000) * 4);
    if (!report) return { ok: false, error: '页面没有响应（桥接未就绪？刷新页面再试）' };
    return report;
  }

  /** UI 点击之后，从刚抓到的请求里找这次提交的结果（页面自己发的请求会被我们录到）
   *  返回 'success' | 'full' | 'dup' | 'captcha' | 'logout' | 'closed' | 'unknown' | '' */
  function judgeUiClickResult(cfg, sinceTs) {
    const s = cfg.submit || {};
    let path = '';
    try { path = new URL(KX.renderTemplate(s.url || '', { ts: Date.now() })).pathname; } catch (e) { path = ''; }
    const hit = captures.slice().reverse().find(function (c) {
      if (!c || c.ts < sinceTs) return false;
      if (String(c.method).toUpperCase() !== 'POST') return false;
      try { return path && new URL(c.url).pathname === path; } catch (e) { return false; }
    });
    if (!hit) return { kind: '', text: '' };
    const cls = R.classify(s.rules, hit.resp || '', hit.status);
    return { kind: cls.kind, text: String(hit.resp || '').slice(0, 200), entry: hit };
  }

  /** 轮询等待「页面自己发出的那条提交请求」被抓到（响应要读回来，需要时间）。
   *  以前只等 150ms 就下结论，会误判成"UI 点击没产生请求"——页面请求 + 我们读响应
   *  通常 100~400ms，弹框多的系统更久。 */
  async function judgeUiClickResultWait(cfg, sinceTs, maxMs) {
    const limit = clamp(Number(maxMs) || 3000, 500, 15000);
    const t0 = Date.now();
    let last = { kind: '', text: '' };
    for (;;) {
      last = judgeUiClickResult(cfg, sinceTs);
      if (last.kind) return last;
      if (Date.now() - t0 > limit) return last;
      await sleep(200);
    }
  }

  /**
   * 跨标签页全局节流 —— **已不再使用**。
   * 保留这段注释作为教训记录：它是为"防止多标签页重复体检/重复通知"加的补丁，
   * 结果把"掉线后恢复探测"也一起吞掉了（引擎显示"抢课中"、9 个目标静默跳过提交），
   * 而且让状态机多了一层看不见的耦合。
   * 现在的做法：探测各页面按自己的节奏走；"自动打开登录页"只由工作标签页做
   * （thisPageWasWorker）—— 新开的登录页不是工作页，天然不会再去开第二个，
   * 这样既简单又不会形成标签页风暴。
   */

  /* ============================================================
   * 课程档案（本地快照）
   * ------------------------------------------------------------
   * 用途（用户需求）：选课**还没开**的时候先把目标挑好，以及跨年参考。
   * 所以把"全量查询"的结果整份存到本地（含教师/时间/校区/容量/已选），
   * **离线、未登录、非选课期间都能看**。
   * 下一年教学班代码（bjdm）会变，档案里的"课程名+教师"就是重新找回目标的依据。
   * ============================================================ */
  const ARCHIVE_KEY = 'kx_course_archive';
  let archive = { at: 0, site: '', rows: [] };

  async function loadArchive() {
    try {
      const got = await chrome.storage.local.get(ARCHIVE_KEY);
      const a = got && got[ARCHIVE_KEY];
      if (a && Array.isArray(a.rows)) {
        archive = { at: Number(a.at) || 0, site: a.site || '', rows: a.rows };
      }
    } catch (e) { /* ignore */ }
    return archive;
  }

  /** 把当前拿到的课程列表存成档案（归一化成稳定结构，便于跨年对比/导入导出） */
  async function saveArchive(list, why) {
    const rows = (list || []).map(function (r) {
      const ex = R.rowExtras(r.raw);
      return {
        id: r.id,
        name: r.name || ex.klass || '',
        klass: ex.klass || '',
        code: ex.code || '',
        teacher: ex.teacher || '',
        campus: ex.campus || '',
        time: ex.time || '',
        capacity: (r.raw && r.raw.KXRS !== undefined) ? r.raw.KXRS : null,
        used: (r.raw && r.raw.DQRS !== undefined) ? r.raw.DQRS : null,
        remain: isFinite(r.remain) ? r.remain : null
      };
    });
    archive = { at: Date.now(), site: HOST, rows: rows };
    try { await chrome.storage.local.set({ [ARCHIVE_KEY]: archive }); } catch (e) { /* ignore */ }
    log('ok', '课程档案已更新：' + rows.length + ' 门（' + (why || '全量查询') + '）——'
      + '离线也能在面板「档案」页浏览、搜索、挑目标；教学班代码变了可以按课程名重新解析。');
    return archive;
  }

  /** 归档用的"课程行"还原成面板可用的形状（{id,name,remain,raw}） */
  function archiveAsRows() {
    return (archive.rows || []).map(function (r) {
      return {
        id: r.id, name: r.name, remain: r.remain,
        raw: { RKJS: r.teacher, XQMC: r.campus, PKSJDDMS: r.time, KCDM: r.code, BJMC: r.klass, KXRS: r.capacity, DQRS: r.used }
      };
    });
  }

  /**
   * 按课程名把目标重新解析到当前的课程ID（跨年兜底）。
   * 返回每条目标的处理结果；高置信度的自动改，存疑的只报告（让你在面板上选）。
   * @param dryRun true = 只看不改（面板上先预览）
   */
  async function resolveTargetsByName(opts) {
    const dryRun = !!(opts && opts.dryRun);
    const cfg = KX.snapshot();
    const list = (opts && opts.rows) || archiveAsRows();
    if (!list.length) return { ok: false, error: '档案是空的 —— 先在「档案」页点「刷新档案（全量查询）」' };
    const eng = cfg.engine || {};
    const minScore = Number(eng.autoResolveMinScore) || 0.6;
    const minGap = Number(eng.autoResolveMinGap) || 0.04;
    /* 最大兜底（用户要求："查找模糊课程或相似课程最大兜底"、"抢错了可以退课，比模糊不到更好"）：
     * 连门槛都不过时，也采用**最像的那一个**。关掉它（engine.autoResolveFallback=false）
     * 就退回旧行为：存疑不动、留给人工选。 */
    const allowFallback = eng.autoResolveFallback !== false;

    const targets = (cfg.targets || []).slice();
    const inList = {};
    list.forEach(function (r) { inList[normId(r.id)] = r; });
    const report = [];
    let changed = 0;
    let fallbackCount = 0;

    /* 用**下标**遍历并按下标回写 —— 不能按 ID 找：
     * 备选清单生成的"名字目标"ID 都是空串，按 ID 找会把所有待解析目标
     * 全都写到同一个（第 0 个）目标上（这是个已修的真 bug）。 */
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!t || t.enabled === false) continue;
      if (t.id && inList[normId(t.id)]) {
        report.push({ id: t.id, label: t.label, action: 'keep', why: '当前列表里就有这个ID' });
        continue;
      }
      const cands = R.matchCoursesByName(list, { label: t.label, name: t.name, teacher: t.teacher, campus: t.campus, kch: t.kch });
      /* 门槛来自配置（用户选择"更激进"：抢错能退课，错过就没了）；
       * allowFallback = 相似度不够也采用最像的那个（最大兜底）。 */
      const pick = R.pickWithFallback(cands, {
        minScore: minScore,
        minGap: minGap,
        allowFallback: allowFallback
      });
      const isFallback = !!pick.fallback;
      if (!pick.ok) {
        report.push({
          id: t.id, label: t.label, action: 'manual', reason: pick.reason,
          candidates: (pick.candidates || []).map(function (c) {
            return { id: c.row.id, name: c.row.name, teacher: c.row.teacher, campus: c.row.campus, time: c.row.time, score: Math.round(c.score * 100) / 100, why: c.why };
          })
        });
        continue;
      }
      const b = pick.best;
      if (!dryRun) {
        targets[i] = Object.assign({}, t, {
          id: b.row.id,
          label: t.label || b.row.name,
          name: t.name || b.row.name,
          teacher: t.teacher || b.row.teacher,
          campus: t.campus || b.row.campus,
          kch: t.kch || b.row.code || '',
          resolvedAt: Date.now(),
          resolvedScore: Math.round(b.score * 100) / 100,
          resolvedFallback: isFallback
        });
      }
      changed++;
      if (isFallback) fallbackCount++;
      report.push({
        id: t.id, label: t.label || b.row.name, action: dryRun ? 'would-change' : 'changed',
        fallback: isFallback,
        to: b.row.id, toName: b.row.name, toTeacher: b.row.teacher,
        score: Math.round(b.score * 100) / 100, why: b.why
      });
    }

    if (!dryRun && changed) {
      await KX.save({ targets: targets });
      log('warn', '按课程名解析了 ' + changed + ' 个目标的ID'
        + (fallbackCount ? '（其中 ' + fallbackCount + ' 个是**最大兜底**：相似度不够高也采用了最像的）' : '')
        + ' —— ' + report.filter(function (r) { return r.action === 'changed'; })
          .map(function (r) { return (r.label || r.id) + '→' + r.toName + '(' + r.score + ')' + (r.fallback ? '兜底' : ''); })
          .slice(0, 6).join('；'));
    }
    const manual = report.filter(function (r) { return r.action === 'manual'; }).length;
    return {
      ok: true, dryRun: dryRun, total: targets.length, changed: changed, manual: manual,
      fallback: fallbackCount, report: report
    };
  }

  /* ============================================================
   * 已选课程（权威判据）+ 退课
   * ------------------------------------------------------------
   * 真实教训：15:28:31 选上了「研究生心理成长」，插件只敢说
   * "看起来成功了，请你去学校页面确认" —— 而抓包里其实早就有
   * `loadStdCourseInfo.do`（返回本人在该学期已选的全部教学班，含 BJDM/WID）。
   * 提交响应的文案永远可能变；**已选列表才是权威判据**。
   * 顺带还解决了另一个坑：课已满时服务器先做容量校验、后做重复校验，
   * 于是"我已经在里面了"也会被返回「名额已满」——只有查已选列表才能分辨。
   * ============================================================ */
  let myCourses = [];
  let myCoursesAt = 0;

  async function fetchMyCourses(cfg) {
    const m = (cfg && cfg.mine) || KX.snapshot().mine || {};
    if (!m.url) return { ok: false, error: '未配置「已选课程」接口（设置里 mine.url）' };
    const vars = Object.assign({}, (cfg && cfg.submit && cfg.submit.vars) || {}, { ts: KX.nextTs(), rand: KX.uid(6) });
    const url = KX.renderTemplate(m.url, vars);
    const r = await replay({
      url: url, method: m.method || 'GET',
      headers: cleanHeaders(Object.assign({ 'X-Requested-With': 'XMLHttpRequest' }, m.headers)),
      timeoutMs: m.timeoutMs || 15000, referrer: m.referrer || ''
    }, m.via);
    if (!r || !r.status) return { ok: false, error: '请求失败：' + ((r && r.error) || '无响应') };
    if (r.status >= 400) return { ok: false, error: 'HTTP ' + r.status, status: r.status };
    let obj = null;
    try { obj = JSON.parse(r.body); } catch (e) { return { ok: false, error: '响应不是 JSON：' + String(r.body || '').slice(0, 80) }; }
    const arr = KX.getByPath(obj, m.path || 'results') || KX.getByPath(obj, 'results')
      || KX.getByPath(obj, 'datas') || KX.getByPath(obj, 'rows') || [];
    if (!Array.isArray(arr)) return { ok: false, error: '没找到课程数组（path=' + (m.path || 'results') + '）' };
    const idF = m.idField || 'BJDM';
    const list = arr.map(function (x) {
      return {
        id: String(x[idF] || '').trim(),
        name: x[m.nameField || 'KCMC'] || '',
        teacher: x[m.teacherField || 'RKJS'] || '',
        wid: x[m.widField || 'WID'] || '',
        canDrop: String(x[m.dropAllowedField || 'IS_SFYXTK'] || '') === '1',
        raw: x
      };
    }).filter(function (x) { return x.id; });
    return { ok: true, status: r.status, list: list };
  }

  /** 核对「已选课程」：把已在里面的目标标成"已选上"（权威），并发通知。
   *  同时在面板上提供已选列表（含退课入口）。 */
  async function checkMine(opts) {
    const quiet = !!(opts && opts.quiet);
    const cfg = KX.snapshot();
    const r = await fetchMyCourses(cfg);
    if (!r.ok) {
      if (!quiet) log('warn', '核对「已选课程」失败：' + r.error);
      return r;
    }
    myCourses = r.list;
    myCoursesAt = Date.now();
    const ids = {};
    myCourses.forEach(function (x) { ids[normId(x.id)] = x; });
    let newly = 0;
    (cfg.targets || []).forEach(function (t) {
      const rt = rtOf(t.id);
      const hit = ids[normId(t.id)];
      if (hit) {
        rt.selectedAt = rt.selectedAt || Date.now();
        if (rt.state !== 'success') {
          newly++;
          setState(rt, 'success', '服务器确认：已在你的已选课程里');
          log('ok', '✔ 「已选课程」确认：' + (t.label || t.id) + ' 已选上（教师 ' + (hit.teacher || '?') + '，WID ' + String(hit.wid).slice(0, 8) + '…）');
          // 同名一起抢、中一个收手：停掉同名的其它班（不能 await —— 这里在 forEach 同步回调里）
          stopSameNameOthers(cfg, t).catch(function () { });
        }
        if (!rt.successNotified) {
          rt.successNotified = true;
          notify('已选上（服务器确认）', (t.label || t.id) + ' 已在你的「已选课程」里。'
            + '不需要它了就点「停」或「删」；要退课请去学校页面手动退 —— ⚠ 退之前务必先把目标停掉，'
            + '否则插件会把你刚退的课又抢回来。', false);
        }
      } else if (rt.selectedAt) {
        rt.selectedAt = 0;   // 退掉了/被踢了 → 继续抢
        log('warn', (t.label || t.id) + ' 不在「已选课程」里了（被退掉或被系统移除）—— 恢复继续抢。');
      }
    });
    if (newly) log('ok', '「已选课程」核对完成：新确认 ' + newly + ' 个目标已选上（你总共已选 ' + myCourses.length + ' 门）');
    if (globalThis.KXPanel && KXPanel.mounted) KXPanel.mine(myCourses, myCoursesAt);
    return r;
  }

  /** 退课**不做自动化**（用户明确要求：退课他自己去学校页面手动退）。
   *  所以这里只提供一条必要的提醒：退课前记得把目标「停」或「删」，
   *  否则插件会把你刚退掉的课又抢回来 —— 这是手动退课流程里最容易踩的坑。 */

  /** 列出**项目 archives/ 目录**里随扩展一起打包的档案（靠 archives/index.json 索引，
   *  因为浏览器扩展不允许枚举自己目录里的文件）。
   *  这样"把档案放进项目单独文件夹"就能在面板上点着读，不用每次弹文件选择框。 */
  async function listBundledArchives() {
    try {
      const url = chrome.runtime.getURL('archives/index.json');
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return { ok: false, error: 'archives/index.json 读不到（HTTP ' + r.status + '）——跑一次 node tools/make-archive-index.mjs' };
      const obj = await r.json();
      return { ok: true, generatedAt: obj.generatedAt || 0, files: obj.files || [] };
    } catch (e) {
      return { ok: false, error: '读取项目 archives/ 索引失败：' + ((e && e.message) || e) };
    }
  }

  /** 读取项目 archives/ 里的某个档案并导入 */
  async function loadBundledArchive(name) {
    if (!/^[\w\-. ]+\.json$/i.test(String(name || ''))) return { ok: false, error: '文件名不合法' };
    try {
      const r = await fetch(chrome.runtime.getURL('archives/' + name), { cache: 'no-store' });
      if (!r.ok) return { ok: false, error: '读不到该文件（HTTP ' + r.status + '）' };
      const obj = await r.json();
      if (!obj || !Array.isArray(obj.rows)) return { ok: false, error: '不是档案格式（需要 {rows:[...]}）' };
      archive = { at: Number(obj.at) || Date.now(), site: obj.site || '', rows: obj.rows };
      await chrome.storage.local.set({ [ARCHIVE_KEY]: archive });
      log('ok', '已从项目 archives/ 读取档案：' + name + '（' + obj.rows.length + ' 门，档案时间 '
        + (obj.at ? hhmmss(obj.at) : '未知') + '）');
      if (globalThis.KXPanel && KXPanel.mounted) KXPanel.archive(archive, archiveAsRows());
      return { ok: true, count: obj.rows.length, at: archive.at };
    } catch (e) {
      return { ok: false, error: '读取失败：' + ((e && e.message) || e) };
    }
  }

  /** 自动按课程名把目标匹配成今年的教学班ID（用户要的"进选课页自动搞定"）。
   *
   *  三个触发点：
   *   ① 有"还没有ID"的目标（来自备选清单）→ **立刻处理，不受节流**
   *   ② 轮询/全量列表里查不到某个目标（教学班代码每年会变）
   *   ③ 直接进选课页/自动开始时
   *
   *  匹配策略：按「课程名+教师+校区」算相似度，分数够就采用；
   *  **不够也采用最像的那个（最大兜底）** —— 用户明确要求"抢错了可以退课，比模糊不到更好"。
   *  关掉兜底（engine.autoResolveFallback=false）就退回"存疑不动、留给人工选"。
   */
  let lastAutoResolveAt = 0;
  async function autoResolveTargets(reason) {
    const cfg = KX.snapshot();
    if (cfg.engine.autoResolve === false) return { ok: false, skipped: true };
    /* 「还没有ID的目标」不处理就一个请求都发不出去 → 必须立刻做，不受节流限制 */
    const pending = (cfg.targets || []).filter(function (t) {
      return t && t.enabled !== false && !String(t.id || '').trim();
    });
    const everyMs = clamp(Number(cfg.engine.autoResolveEveryMs) || 600000, 60000, 3600000);
    if (!pending.length && Date.now() - lastAutoResolveAt < everyMs) return { ok: false, skipped: 'throttled' };
    lastAutoResolveAt = Date.now();

    let rows = boardFull.length ? boardFull : (board.length ? board : []);
    if (!rows.length) {
      const q = await callQuery(cfg, { fullPage: true, pageSize: 200 });
      if (!q.ok) return { ok: false, error: q.error };
      boardFull = q.list;
      boardFullAt = Date.now();
      rows = boardFull;
      await saveArchive(rows, '自动解析目标时顺带归档').catch(function () { });
      if (globalThis.KXPanel && KXPanel.mounted) KXPanel.board(boardFull, boardFullAt, { full: true });
    }
    if (!rows.length) return { ok: false, error: '这一轮没拿到课程列表（可能还没到选课时间）' };
    const r = await resolveTargetsByName({ rows: rows, why: reason || '自动解析' });
    if (r && r.ok && r.changed) {
      notify('已自动匹配到今年的课程', r.changed + ' 门课已匹配到教学班ID'
        + (r.fallback ? '（其中 ' + r.fallback + ' 个为最大兜底匹配）' : '')
        + '，开始抢课。', false);
    }
    if (r && r.ok && r.manual) {
      log('warn', '有 ' + r.manual + ' 个目标按课程名匹配**存疑**（同名多班或找不到足够像的）——'
        + '去「档案」页点「按课程名重新解析目标」，在那里选一下。');
    }
    return r;
  }

  /** 记住"项目 archives/ 里的档案文件名"（选过一次文件夹之后就不用再选、也不用索引工具）。
   *  读取用扩展自身的 URL，所以是永久的 —— 只要文件还在项目的 archives/ 目录里。 */
  const ARCH_NAMES_KEY = 'kx_archive_names';
  let rememberedArchives = [];
  async function loadRememberedArchives() {
    try {
      const got = await chrome.storage.local.get(ARCH_NAMES_KEY);
      const a = got && got[ARCH_NAMES_KEY];
      rememberedArchives = Array.isArray(a) ? a.slice(0, 50) : [];
    } catch (e) { rememberedArchives = []; }
    return rememberedArchives;
  }
  async function rememberArchives(names) {
    const set = {};
    rememberedArchives.concat(names || []).forEach(function (n) { if (n) set[n] = 1; });
    rememberedArchives = Object.keys(set).sort();
    try { await chrome.storage.local.set({ [ARCH_NAMES_KEY]: rememberedArchives }); } catch (e) { /* ignore */ }
    return rememberedArchives;
  }

  /** 「同名组」的键：把课程名归一化（去掉括号、序号、空格标点）。
   *  同名教学班算同一门课 —— 用来实现"同名一起抢，抢到一个就收手"。 */
  function sameNameKey(t) {
    return R.normCourseName((t && (t.name || t.label)) || '');
  }

  /**
   * 命中一个 → 停掉同名的其它目标。
   *
   * **默认关闭**（engine.autoStopSameName 默认 false），这是刻意的：
   * 用户原话 ——"应该抢到同名的继续抢，因为你的成功判定并不可靠"。
   * 理由成立：多抢一个的代价是退一次课（可逆），而**误停一个的代价是丢掉课程**（不可逆）。
   * 所以宁可多抢。
   *
   * 想开启的话（避免重复中签、省得退课），它只在**「已选课程」列表权威确认**后才停 ——
   * 那条判据直接来自服务器（本人在该学期已选的教学班），不是解析响应文案猜出来的。
   * @returns 被停掉的目标数
   */
  async function stopSameNameOthers(cfg, winner) {
    if ((cfg.engine || {}).autoStopSameName !== true) return 0;   // 默认不开
    const key = sameNameKey(winner);
    if (!key) return 0;
    const list = (cfg.targets || []).slice();
    const victims = list.filter(function (t) {
      return normId(t.id) !== normId(winner.id) && t.enabled !== false && sameNameKey(t) === key;
    });
    if (!victims.length) return 0;
    victims.forEach(function (t) { t.enabled = false; });
    await KX.save({ targets: list });
    victims.forEach(function (t) {
      const rt = rtOf(t.id);
      if (rt) setState(rt, 'done', '同名课程已选上，自动停下');
    });
    log('ok', '同名课程已选上 → 自动停掉同名其它班 ' + victims.length + ' 个：'
      + victims.map(function (t) { return t.label || t.id; }).join('、')
      + '（避免同时中好几个同名班还要退课；想继续留着的去「目标」页点「启」）');
    notify('同名课程已选上', (winner.label || winner.id) + ' 选上了，已自动停掉同名的其它 '
      + victims.length + ' 个班（避免重复中签）。', false);
    return victims.length;
  }

  /* ============================================================
   * 自动应用"项目里的配置文件"
   * ------------------------------------------------------------
   * 为什么需要：配置文件在项目目录里，而扩展的配置存在浏览器里 ——
   * 于是每次改了文件都得手动导入一次（用户反馈："这个配置json能自动配置吗"）。
   *
   * 做法：启动时读取项目里的配置文件，按**内容哈希**判断是否变了；
   * 变了就自动应用，并保留属于**你**的部分：
   *   · targets   —— 你的选课清单（绝不能被文件冲掉）
   *   · engine    —— 你在面板上调的速率/开关（按 key 深合并，文件里的新键仍会补进来）
   *   · notify / debug —— 通知偏好、收集器地址（本地环境相关）
   * 其余（站点白名单、提交/查询/已选接口、判定规则、会话与 UI 策略）以**文件为准**。
   *
   * 效果：改了配置文件，重载扩展就生效，不用再手动导入。
   * ============================================================ */
  const CFG_FILE = 'kx-config-吉大研究生选课.json';
  const CFG_HASH_KEY = 'kx_bundled_cfg_hash';

  function strHash(s) {
    let h = 5381;
    const t = String(s || '');
    for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0;
    return h.toString(36) + ':' + t.length;
  }

  /** 保留"属于用户"的部分 —— 实现在 config.js 里（纯函数，有自测） */
  function mergeBundledConfig(fileCfg, storedCfg) {
    return KX.mergeBundledConfig(fileCfg, storedCfg);
  }

  async function autoApplyBundledConfig() {
    let text = '';
    try {
      const r = await fetch(chrome.runtime.getURL(CFG_FILE), { cache: 'no-store' });
      if (!r.ok) return { ok: false, error: '读不到项目配置文件（HTTP ' + r.status + '）' };
      text = await r.text();
    } catch (e) {
      return { ok: false, error: '读项目配置文件失败：' + ((e && e.message) || e) };
    }
    let fileCfg = null;
    try { fileCfg = JSON.parse(text); } catch (e) { return { ok: false, error: '项目配置文件不是合法 JSON' }; }
    if (!fileCfg || typeof fileCfg !== 'object') return { ok: false, error: '项目配置文件格式不对' };

    const hash = strHash(text);
    let last = '';
    try {
      const got = await chrome.storage.local.get(CFG_HASH_KEY);
      last = String((got && got[CFG_HASH_KEY]) || '');
    } catch (e) { /* ignore */ }
    if (last === hash) return { ok: true, applied: false, hash: hash };

    const cur = KX.snapshot();
    const merged = mergeBundledConfig(fileCfg, cur);
    const changed = Object.keys(fileCfg).filter(function (k) {
      try { return JSON.stringify(fileCfg[k]) !== JSON.stringify(cur[k]); } catch (e) { return true; }
    });
    await KX.replace(merged);
    try {
      await chrome.storage.local.set({ [CFG_HASH_KEY]: hash });
      await chrome.storage.local.set({ kx_bundled_cfg_at: Date.now() });
    } catch (e) { /* ignore */ }
    log('ok', '已**自动应用**项目里的配置文件（不用手动导入）：'
      + (changed.length ? '更新了 ' + changed.join('、') : '内容有变动')
      + '　保留了你的目标列表（' + ((cur.targets || []).length) + ' 个）与调速设置。');
    return { ok: true, applied: true, hash: hash, changed: changed };
  }

  /**
   * 备选清单 → 目标（首次进页面自动做，不需要手动操作）。
   *
   * 用户要的明年流程："先预备选档案里的今年课 → 点页面登陆 → 直接进入选课页面
   * 查找模糊课程或相似课程最大兜底加入监控 → 开始自动选课（不需要第一次手动操作）"。
   *
   * 这个函数负责第一步：把「备选清单」（只有课程名，跨年/跨电脑都能带走）
   * 自动变成本次要监控的目标。ID 留空，等选课页能拉到课表时由
   * resolveTargetsByName 模糊匹配成真 ID。
   *
   * 只在**当前没有任何目标**时做，绝不动你已有的清单。
   */
  async function seedTargetsFromWishlist() {
    const cfg = KX.snapshot();
    const wl = Array.isArray(cfg.wishlist) ? cfg.wishlist : [];
    if (!wl.length) return { ok: true, seeded: 0, why: '备选清单是空的' };
    if ((cfg.targets || []).length) return { ok: true, seeded: 0, why: '已有目标，不动' };
    const targets = KX.wishlistToTargets(wl);
    if (!targets.length) return { ok: true, seeded: 0, why: '备选清单里没有有效的课程名' };
    await KX.save({ targets: targets });
    log('ok', '备选清单已自动生效：' + targets.length + ' 门课进入监控（现在还没有教学班ID）——'
      + '进入选课页后会自动按课程名匹配今年的班级，然后开始抢。');
    notify('已按备选清单准备监控', targets.length + ' 门课已加入监控，进选课页后自动匹配并开抢。', false);
    return { ok: true, seeded: targets.length };
  }

  /* ============================================================
   * 面板门面：给 panel.js 用的 API
   * ============================================================ */
  async function applyCapture(entry, role, subs) {
    if (!entry) return { ok: false, error: '没有可用的抓包记录' };
    const ct = guessCt(entry);
    const headers = cleanHeaders(entry.reqHeaders || {});
    let url = entry.url || '';
    let body = entry.reqBody || '';
    const list = subs || [];
    list.forEach(function (s) {
      const ph = '{{' + s.placeholder + '}}';
      if (s.inUrl) url = R.applyUrlTemplate(url, s.key, ph);
      body = R.applyTemplate(body, s.key, ph);
    });
    // 没指定替换 → 自动猜一个最像选课ID的数字参数
    if (!list.length && role === 'submit') {
      const params = R.splitParams(body, ct);
      const guess = R.guessIdParam(params);
      if (guess) {
        body = R.applyTemplate(body, guess, '{{id}}');
        const g = R.applyUrlTemplate(url, guess, '{{id}}');
        url = g;
        log('sys', '自动把参数 ' + guess + ' 换成了 {{id}}，请在设置页确认');
      }
    }

    if (role === 'query') {
      const parsed = R.parseList(Object.assign({}, (KX.snapshot().query || {}).parse, { type: 'json' }), entry.resp || '');
      const patch = { query: { enabled: true, url: url, method: entry.method || 'POST', contentType: ct, headers: headers, body: body } };
      if (parsed.ok && parsed.list.length) {
        const f = R.guessFields(parsed.list[0].raw);
        patch.query.parse = Object.assign({}, (KX.snapshot().query || {}).parse, {
          type: 'json', idField: f.idField, remainField: f.remainField, nameField: f.nameField
        });
        log('ok', '已设为「余量查询」模板：识别到 ' + parsed.list.length + ' 条记录，字段 id=' + (f.idField || '?') + ' 余量=' + (f.remainField || '?'));
      } else {
        patch.query.parse = Object.assign({}, (KX.snapshot().query || {}).parse, { type: 'json', idField: '', remainField: '', nameField: '' });
        log('warn', '已设为「余量查询」模板，但没能自动解析出记录：' + (parsed.error || '响应里没有数组') + '。请在设置页手工填 parse.path');
      }
      await KX.save(patch);
      return { ok: true, patch: patch };
    }

    await KX.save({
      submit: {
        url: url, method: entry.method || 'POST', contentType: ct,
        headers: headers, body: body
      }
    });
    log('ok', '已设为「提交」模板：' + (entry.method || 'POST') + ' ' + url);

    // ★ 防呆：教务系统里「加载/查询」类接口常被误当成提交接口（真实踩过：
    //   loadGxkCourseInfo.do 被设为提交模板，结果每次"抢课"都在查课程信息）。
    //   提交类接口一般含 submit/save/select/add/xkgo/choose/apply/enroll 这类词。
    const looksQuery = /(load|query|get|list|search|info|detail|option|tree|dropdown|view)/i.test(url);
    const looksSubmit = /(submit|save|select|add|xkgo|choose|apply|enroll|confirm|operate|baoming)/i.test(url);
    if (looksQuery && !looksSubmit) {
      log('warn', '⚠ 注意：这个接口地址看起来是「查询类」（含 load/query/get/list/info 等词），可能不是真正的提交接口。'
        + '真正的提交接口通常是你在页面上点「选课/确认」那一刻才发出的那条 POST，响应里会出现「选课成功 / 人数已满」。'
        + '建议再点一次选课，找那条请求重新设。');
    }
    return { ok: true };
  }

  async function testSubmit(id) {
    const cfg = KX.snapshot();
    const t = (cfg.targets || []).find(function (x) { return normId(x.id) === normId(id); }) || { id: id };
    const rt = rtOf(t.id);
    const r = await submitOne(cfg, t, rt);
    return { ok: r === 'success' || r === 'dup', kind: r, rt: rt, status: snapshotStatus() };
  }

  async function testQuery() {
    const q = await callQuery(KX.snapshot(), { fullPage: true, pageSize: 200 });
    if (q.ok) {
      boardFull = q.list;
      boardFullAt = Date.now();
      /* 顺手存档案：全量查询本身就是"我拥有完整课程列表"的时刻，
       * 存档后离线/未登录/选课未开时都能在「档案」页挑目标。 */
      await saveArchive(boardFull, '全量查询').catch(function () { });
      if (globalThis.KXPanel && KXPanel.mounted) {
        KXPanel.board(boardFull, boardFullAt, { full: true, pollCount: board.length, pollAt: boardAt });
        KXPanel.archive(archive, archiveAsRows());
      }
      log('ok', '人工全量查询：' + boardFull.length + ' 条（独立保存，不会被自动轮询覆盖）');
    }
    return q;
  }

  /** 面板「试一次点击选课」：验证选择器能不能用 + 实测耗时（不改目标状态） */
  async function testUiClick(id) {
    const cfg = KX.snapshot();
    const t = (cfg.targets || []).find(function (x) { return normId(x.id) === normId(id); }) || { id: id };
    const t0 = Date.now();
    const report = await uiClickFor(t);
    const judged = await judgeUiClickResultWait(cfg, t0, 3000);
    log(report && report.ok ? 'ok' : 'err', 'UI 点击测试（' + (t.label || t.id) + '，定位键 '
      + (t.kch || t.label || t.id) + '）：' + ((report && report.ok) ? '成功' : '失败')
      + '　' + ((report && report.steps || []).join('；'))
      + (report && report.resultText ? '　弹框：' + report.resultText : '')
      + '　判定：' + (judged.kind || '未判定') + '　耗时 ' + ((report && report.ms) || 0) + 'ms');
    return { ok: !!(report && report.ok), report: report, kind: judged.kind, text: judged.text };
  }

  /** 面板「重置存活时长校准」：清掉可能被污染的历史样本，回到配置文件里的基准值。
   *  （会话被提前终止的原因很多 —— 手动退出、换账号、被踢 —— 那些样本会把估算带偏。） */
  async function resetLifetimeCalibration() {
    auth.lifetimeSamples = [];
    hardTimeoutDisproved = false;
    warnFlighted = false;
    keepAliveRecordLogged = false;
    await KX.save({ session: { hardTimeoutMs: 600000 } });
    log('ok', '已重置「会话存活时长」校准：样本清零、倒计时回到 10 分钟基准。'
      + '下一次真实掉线会重新测一次（测到的值会写进日志，方便你核对）。');
    return { ok: true };
  }

  const KXApp = {
    config: function () { return KX.snapshot(); },
    save: function (patch, opts) { return (opts && opts.replace) ? KX.replace(patch) : KX.save(patch); },
    /** 整体替换配置（导入用）。刻意不用 save 的深合并：否则旧的多余键（例如上一次
     *  适配留下的 Content-Type 请求头）会残留下来，让人以为文件没生效。 */
    importConfig: function (obj) { return KX.replace(obj); },
    status: snapshotStatus,
    targets: targetsView,
    captures: function () { return captures.slice(); },
    captureById: function (id) { return captures.find(function (c) { return c.id === id; }) || null; },
    board: function () { return { list: board, at: boardAt }; },
    logs: function () { return logs.slice(); },
    start: start,
    stop: stop,
    halt: halt,
    probe: probeSession,
    confirmTarget: function (id) { approved.add(normId(id)); saveRuntime(); if (globalThis.KXPanel && KXPanel.mounted) KXPanel.status(snapshotStatus()); return true; },
    denyTarget: function (id) { approved.delete(normId(id)); return true; },
    /** 新增监控目标。
     *  extra 允许是数字（旧的 priority 用法）或对象 {priority, name, teacher, campus} ——
     *  档案页加入监控时会带上教师/校区/课程名，这些信息**是跨年找回 ID 的关键**
     *  （教学班代码每年会变，名字和教师基本不变）。 */
    addTarget: async function (id, label, kch, extra) {
      const cfg = KX.snapshot();
      const list = (cfg.targets || []).slice();
      if (list.some(function (t) { return normId(t.id) === normId(id); })) return { ok: false, error: '该 ID 已在列表里' };
      if (!String(id || '').trim()) return { ok: false, error: 'ID 不能为空' };
      const x = (extra && typeof extra === 'object') ? extra : { priority: Number(extra) || 0 };
      const t = {
        id: String(id).trim(),
        label: label || x.name || '',
        name: x.name || label || '',
        kch: kch || '',
        teacher: x.teacher || '',
        campus: x.campus || '',
        enabled: true,
        priority: Number(x.priority) || list.length + 1
      };
      list.push(t);
      await KX.save({ targets: list });
      log('ok', '新增监控目标 ' + id + (t.label ? '（' + t.label + '）' : '')
        + (t.teacher ? '　教师 ' + t.teacher : '') + (t.campus ? '　' + t.campus : '')
        + '　（已记下课程名/教师，明年代码变了能按名字找回）');
      return { ok: true };
    },
    removeTarget: async function (id) {
      const cfg = KX.snapshot();
      const list = (cfg.targets || []).filter(function (t) { return normId(t.id) !== normId(id); });
      runtime.delete(normId(id));
      await KX.save({ targets: list });
      return { ok: true };
    },
    updateTarget: async function (id, patch) {
      const cfg = KX.snapshot();
      const list = (cfg.targets || []).map(function (t) {
        return normId(t.id) === normId(id) ? Object.assign({}, t, patch) : t;
      });
      await KX.save({ targets: list });
      return { ok: true };
    },
    resetTargetState: function (id) {
      const rt = rtOf(id);
      rt.state = 'idle'; rt.tryCount = 0; rt.failStreak = 0; rt.nextAt = 0; rt.lastMsg = '';
      saveRuntime();
      if (globalThis.KXPanel && KXPanel.mounted) KXPanel.status(snapshotStatus());
      return true;
    },
    applyCapture: applyCapture,
    testSubmit: testSubmit,
    testQuery: testQuery,
    pushNow: function () { return flushPush(true); },
    pingCollector: pingCollector,
    exportCaptures: exportCaptures,
    probePageValues: function () { return probePageValues(false); },
    testUiClick: testUiClick,
    resetLifetimeCalibration: resetLifetimeCalibration,
    /* 课程档案 + 跨年兜底（按课程名重新解析目标ID） */
    archive: function () { return { at: archive.at, site: archive.site, rows: archive.rows }; },
    archiveRows: archiveAsRows,
    archiveNow: async function () {
      if (boardFull.length) return saveArchive(boardFull, '手动归档当前全量列表');
      const q = await testQuery();
      return q.ok ? archive : { error: '查询失败，没有可归档的数据' };
    },
    importArchive: async function (obj) {
      if (!obj || !Array.isArray(obj.rows)) return { ok: false, error: '不是档案格式（需要 {rows:[...]}）' };
      archive = { at: Number(obj.at) || Date.now(), site: obj.site || '', rows: obj.rows };
      try { await chrome.storage.local.set({ [ARCHIVE_KEY]: archive }); } catch (e) { return { ok: false, error: String(e.message || e) }; }
      log('ok', '已导入课程档案：' + archive.rows.length + ' 门（原档案时间 ' + hhmmss(archive.at) + '）');
      return { ok: true, count: archive.rows.length };
    },
    clearArchive: async function () {
      archive = { at: 0, site: '', rows: [] };
      try { await chrome.storage.local.remove(ARCHIVE_KEY); } catch (e) { /* ignore */ }
      return { ok: true };
    },
    /* 配置来源：显示"项目里的配置文件是否已自动应用"，并允许手动重新应用 */
    configSource: async function () {
      const got = await chrome.storage.local.get(['kx_bundled_cfg_at', CFG_HASH_KEY]);
      return {
        file: CFG_FILE,
        appliedAt: Number((got && got.kx_bundled_cfg_at) || 0),
        hash: String((got && got[CFG_HASH_KEY]) || '')
      };
    },
    reapplyBundledConfig: async function () {
      try { await chrome.storage.local.remove(CFG_HASH_KEY); } catch (e) { /* ignore */ }
      const r = await autoApplyBundledConfig();
      if (r && r.applied) log('ok', '已重新应用项目配置文件（' + (r.changed || []).join('、') + '）');
      return r;
    },
    resolveTargets: resolveTargetsByName,
    /* 备选清单（跨年/跨电脑带走"想选哪些课"的唯一载体 —— 教学班 ID 每年都变） */
    wishlist: function () { return ((KX.snapshot().wishlist) || []).slice(); },
    addWishlist: async function (items) {
      const cur = (KX.snapshot().wishlist) || [];
      const seen = {};
      cur.forEach(function (w) { const k = R.normCourseName((w && (w.name || w.label)) || ''); if (k) seen[k] = 1; });
      const add = [];
      (items || []).forEach(function (it) {
        const name = String((it && (it.name || it.label)) || '').trim();
        if (!name) return;
        const k = R.normCourseName(name);
        if (seen[k]) return;                       // 同名只留一份
        seen[k] = 1;
        add.push({
          name: name,
          teacher: String((it && it.teacher) || '').trim(),
          campus: String((it && it.campus) || '').trim(),
          code: String((it && (it.code || it.kch)) || '').trim(),
          addedAt: Date.now()
        });
      });
      if (!add.length) return { ok: true, added: 0, total: cur.length, skipped: (items || []).length };
      const next = cur.concat(add);
      await KX.save({ wishlist: next });
      log('ok', '备选清单 +' + add.length + ' 门（共 ' + next.length + ' 门）：'
        + add.map(function (w) { return w.name; }).join('、')
        + '　—— 明年/换电脑后会自动变成监控目标并按课程名匹配班级。');
      return { ok: true, added: add.length, total: next.length };
    },
    clearWishlist: async function () {
      await KX.save({ wishlist: [] });
      log('warn', '备选清单已清空');
      return { ok: true };
    },
    seedFromWishlist: seedTargetsFromWishlist,
    autoResolveTargets: autoResolveTargets,
    /* 项目 archives/ 目录里的档案（随扩展打包，一键读取） */
    listBundledArchives: listBundledArchives,
    loadBundledArchive: loadBundledArchive,
    rememberedArchives: function () { return rememberedArchives.slice(); },
    rememberArchives: rememberArchives,
    /* 已选课程（权威判据）+ 退课 */
    mine: function () { return { at: myCoursesAt, list: myCourses }; },
    checkMine: function () { return checkMine({}); },
    learnedTokens: function () { return learnedTokens; },
    lastPush: function () { return lastPush; },
    clearLog: function () { logs.length = 0; return true; },
    clearCaptures: async function () { captures.length = 0; await KX.clearCaptures(); return true; },
    setRecording: setRecording,
    markLogin: function () {
      auth.loginAt = Date.now();
      auth.loginSource = 'manual';
      auth.observedAt = Date.now();
      warnFlighted = false;
      auth.state = 'ok';
      auth.why = '';
      saveRuntime();
      log('ok', '已手工校准：登录时刻记为现在，' + Math.round((Number((KX.snapshot().session || {}).hardTimeoutMs) || 0) / 60000) + ' 分钟后失效');
      return true;
    },
    openLogin: function () {
      const url = auth.loginUrl || (KX.snapshot().session || {}).loginUrl || '';
      if (!url) return { ok: false, error: '还不知道登录页地址：先让它掉线一次（探测到跳转后会自动记住），或在设置里手工填 session.loginUrl' };
      toBg({ type: 'kx:open-login', url: url });
      return { ok: true, url: url };
    },
    bridgeReady: function () { return bridgeReady; },
    sameOrigin: sameOrigin,
    normId: normId
  };
  globalThis.KXApp = KXApp;

  /* ============================================================
   * 指令处理（popup / background）
   * ============================================================ */
  async function runCmd(cmd, payload) {
    const p = payload || {};
    switch (cmd) {
      case 'start': return await start(p.reason || '面板启动');
      case 'stop': stop(p.reason || ''); return { ok: true };
      case 'status': return { ok: true, status: snapshotStatus() };
      case 'probe': await probeSession('手动', { force: true }); return { ok: true, status: snapshotStatus() };
      case 'mark-login': KXApp.markLogin(); return { ok: true };
      case 'open-login': return KXApp.openLogin();
      case 'test-query': return await testQuery();
      case 'test-submit': return await testSubmit(p.id);
      case 'confirm': KXApp.confirmTarget(p.id); return { ok: true };
      case 'reset-target': KXApp.resetTargetState(p.id); return { ok: true };
      case 'set-recording': setRecording(p.enabled); return { ok: true };
      case 'clear-captures': await KXApp.clearCaptures(); return { ok: true };
      case 'export-captures': return { ok: true, export: exportCaptures() };
      case 'push-now': return await flushPush(true);
      case 'ping-collector': return await pingCollector();
      case 'probe-values': { const snap = await probePageValues(false); return { ok: !!snap, snapshot: snap }; }
      case 'clear-log': KXApp.clearLog(); return { ok: true };
      case 'reload-config': await KX.load(true); return { ok: true, config: KX.snapshot() };
      case 'show-panel': if (globalThis.KXPanel) KXPanel.setVisible(true); return { ok: true };
      case 'hide-panel': if (globalThis.KXPanel) KXPanel.setVisible(false); return { ok: true };
      case 'toggle-panel': if (globalThis.KXPanel) KXPanel.toggle(); return { ok: true, visible: globalThis.KXPanel ? KXPanel.isVisible() : false };
      default: return { ok: false, error: '未知指令 ' + cmd };
    }
  }

  async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return { ok: false, error: 'bad message' };
    if (msg.to && msg.to !== 'content') return { ok: false, error: 'not for content' };
    if (msg.type === 'kx:ping' || msg.type === 'kx:cmd') {
      if (!ACTIVE) {
        return {
          ok: !!msg.__allowInactive, active: false, host: HOST,
          error: '该站点未在插件白名单：请在弹窗里点「加入站点白名单」后刷新页面',
          status: { active: false, host: HOST, href: location.href }
        };
      }
      if (msg.type === 'kx:ping') return { ok: true, status: snapshotStatus() };
      return await runCmd(msg.cmd, msg.payload);
    }
    return { ok: false, error: 'unknown type' };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    handleMessage(msg).then(sendResponse, function (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    });
    return true;   // 异步响应
  });

  /* ============================================================
   * 启动流程
   * ============================================================ */
  async function boot() {
    /* 先把"项目里的配置文件"应用进来（变了才应用），再读配置 ——
     * 这样改了文件只要重载扩展就生效，不用手动导入。 */
    await autoApplyBundledConfig().catch(function () { });
    const cfg = await KX.load(true);
    ACTIVE = KX.siteAllowed(HOST, cfg.sites);
    if (!ACTIVE) {
      // 不在白名单：什么都不做，只保留上面那个极轻量的消息处理器
      return;
    }
    injectBridge();
    // 先看有没有「刚从登录页回来」的标记，再加载运行时状态（loadRuntime 会据此作废旧锚点）
    const loginFlow = await readLoginFlowMarker(true);
    await loadRuntime(loginFlow);
    await loadLearnedTokens();
    await loadArchive();      // 课程档案（离线可用：选课未开时也能在面板上挑目标）
    await loadRememberedArchives();   // 记住过的 archives/ 文件名（不用索引工具也能列出）
    await seedTargetsFromWishlist();  // 备选清单 → 监控目标（新电脑上"零手动"的第一步）
    setRecording(true);

    KX.subscribe(function () { /* 配置变化时刷新面板 */ if (globalThis.KXPanel && KXPanel.mounted) KXPanel.status(snapshotStatus()); });

    // 挂面板（等 DOM 可用）
    const mount = function () {
      if (globalThis.KXPanel) {
        try {
          chrome.storage.local.get(UI_KEY).then(function (got) {
            const ui = (got && got[UI_KEY]) || {};
            KXPanel.mount(KXApp, ui);
            KXPanel.status(snapshotStatus());
            // 把"配置来源"状态推给面板（设置页显示"项目配置是否已自动应用"）
            KXApp.configSource().then(function (c) {
              if (globalThis.KXPanel && KXPanel.configSource) KXPanel.configSource(c);
            }).catch(function () { });
            // 备选清单（档案页显示"跨年清单"）
            if (globalThis.KXPanel && KXPanel.wishlist) KXPanel.wishlist(KXApp.wishlist());
            // 把本地课程档案推给面板：离线/未登录/选课未开时，「档案」页照样能看和挑课
            if (archive.rows.length) KXPanel.archive(archive, archiveAsRows());
            /* 自动把"项目 archives/ 里的档案列表"推给面板 —— 不用用户先点一次「重新扫描」 */
            listBundledArchives().then(function (r) {
              if (r && r.ok) KXPanel.bundled(r, rememberedArchives.slice());
              else KXPanel.bundled({ files: [] }, rememberedArchives.slice());
            }).catch(function () { KXPanel.bundled({ files: [] }, rememberedArchives.slice()); });
            log('sys', '站点已激活：' + HOST + '（面板' + (KXPanel.isVisible() ? '已展开' : '已收起') + '）');
            if (ui.tab) KXPanel.setTab(ui.tab);
          });
        } catch (e) { KXPanel.mount(KXApp, {}); }
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
      mount();
    }

    // 会话看门狗
    sessionTimer = setInterval(sessionTick, 15000);
    setTimeout(sessionTick, 1500);

    /* 如果当前页面就是登录页：把光标放进验证码框，让你只需敲 4 个字符。
     * 这是"重新登录"这个人工动作的最后一厘米优化（登录页由插件自动开好）。 */
    (function focusCaptchaIfLoginPage() {
      const st = KX.snapshot().session || {};
      let looksLogin = false;
      try { looksLogin = !!st.loginUrlRe && new RegExp(st.loginUrlRe, 'i').test(location.href); } catch (e) { looksLogin = false; }
      if (!looksLogin && !/login/i.test(location.href)) return;
      const tryFocus = async function (attempt) {
        const r = await toPage({ type: 'focus-captcha' }, 2500);
        if (r && r.ok) {
          /* 这是学习登录页地址的**精确**方式：页面上真的有输入框（验证码/密码）才算登录页，
           * 比"URL 里含 login"可靠得多 —— 后者会把任何无关网站的 /login 也当成登录页
           * （真实事故：配置里的登录页被覆盖成了 https://kitty.fo/login）。
           * 而且本系统真正的登录页 URL（.../xsxkapp/index.html）里没有 login 字样，
           * URL 规则根本学不到它，只有"看到表单"才学得到。 */
          if (location.href !== st.loginUrl) {
            KX.save({ session: { loginUrl: location.href } }).catch(function () { });
            log('ok', '记下登录页地址（因为在这个页面上真的看到了登录/验证码输入框）：' + location.href);
          }
          log('ok', '已在登录页，光标已放进「' + r.name + '」输入框 —— 你只需输入验证码后回车（插件随后会自动继续抢课）');
          return;
        }
        if (attempt < 3) setTimeout(function () { tryFocus(attempt + 1); }, 1200);
        else log('info', '登录页已打开，但没能自动聚焦验证码框（表单结构可能不同）—— 手工点一下输入框即可。');
      };
      setTimeout(function () { tryFocus(1); }, 1500);
    })();

    /* ============================================================
     * 进入页面后自动开始 —— 只有一条规则
     * ------------------------------------------------------------
     * enabled=true 表示"用户想让它跑"（点启动/自动开始时置 true，点停止置 false）。
     * 引擎是跑在页面里的，页面一加载它就没了，所以这里按这条规则自动拉起：
     *   · 掉线状态 → 先探测登录态（探测成功会自动开始，见 noteAuth）
     *   · 其余 → 直接开始（start 内部会检查"当前页面能不能跑"，不是选课页就拒绝并说明原因）
     * 之前的 resumePending / wasHalted / 全局节流 等分支都已删掉 —— 每加一个分支
     * 就多一个"在某个分支里漏掉关键动作"的机会，实际已经因此踩了三次。
     * ============================================================ */
    if (wantRunning) {
      if (auth.state === 'lost') {
        log('warn', '上次是掉线停机状态，先探测登录态；登录成功后会自动开始抢课');
        setTimeout(function () { probeSession('进入页面后确认登录态'); }, 2000);
      } else {
        log('ok', '检测到「应该处于抢课中」（enabled=true）而页面刚加载 —— 自动开始');
        setTimeout(function () {
          start('进入页面后自动开始').then(function (r) {
            if (r && r.ok === false) log('warn', '自动开始未成功：' + r.error);
          });
        }, 1500);
      }
    } else {
      log('info', '当前是「待机」状态（enabled=false）。点面板「启动」即开始抢课；'
        + '之后每次进入选课页都会自动开始。若你是被验证码/未开放停机过，需要手动确认后再启动。');
    }

    // 页面卸载时保存
    window.addEventListener('pagehide', function () { saveRuntime(); });

    broadcastStatus();
  }

  /* 面板收起/展开状态持久化 */
  async function saveUi(ui) {
    try { await chrome.storage.local.set({ [UI_KEY]: ui }); } catch (e) { /* ignore */ }
  }
  globalThis.KXSaveUi = saveUi;

  boot().catch(function (e) {
    console.warn('[KX] boot 失败', e);
  });
})();
