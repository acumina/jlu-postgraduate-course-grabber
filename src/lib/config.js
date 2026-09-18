/* ============================================================
 * lib/config.js —— 选课助手 共享配置层
 * ------------------------------------------------------------
 * 这个文件是「普通脚本」（不是 ES module），通过 globalThis.KX 暴露，
 * 所以下面三种环境都能共用同一份实现：
 *   1. content_scripts 的多个文件（同一 isolated world，共享 globalThis）
 *   2. popup.html 的 <script src>
 *   3. service worker 里的 import './lib/config.js'
 * ============================================================ */
(function () {
  if (globalThis.KX) return;

  /** 存储键：全部状态都在这里，方便导出/导入/备份 */
  const STORAGE_KEY = 'kx_state';
  const CAPTURE_KEY = 'kx_captures';

  /**
   * 默认状态。schema 的每个字段都在下面有注释，
   * tools/har2config.mjs 生成的配置也遵循这个结构。
   */
  function defaults() {
    return {
      v: 1,

      /* 总开关：只有 enabled=true 时引擎才会真的发包 */
      enabled: false,

      /* 生效站点（主机名后缀白名单）。为空时插件在任何站点都不激活。
       * 例：["jwxt.example.edu.cn", "xk.example.edu.cn"] */
      sites: [],

      /* 备选清单：只有课程名/教师/校区（**没有教学班ID**）。
       * 教学班 ID 每年都变，所以跨年/跨电脑能带走的只有这些稳定信息 ——
       * 明年在新电脑上装好扩展后，插件会自动把它变成「按名字监控」的目标，
       * 等选课页能拉到课表时再模糊匹配成今年的真 ID（最大兜底）。
       * 例：[{ name: "研究生心理成长", teacher: "", campus: "" }] */
      wishlist: [],

      /* 工作标签页：引擎跑在这个标签页里（同源页面才能带上 Cookie / SameSite） */
      worker: {
        autoOpen: true,
        /* 空 = 用 sites[0] 的 https 首页 */
        url: '',
        /* 引擎只允许在这个 URL 形态的页面上运行（正则，留空 = 不限制）。
         * 为什么需要：真实事故 —— 自动继续在"选课首页"就把引擎启起来了，
         * 首页没有课程列表 → UI 点击找不到「选课」按钮 → token 永远学不到 →
         * 每 3 秒循环一次无效操作、把日志刷满。
         * 例（吉大研究生选课）：'xsxkapp/course\\.html' */
        urlRe: ''
      },

      /* 引擎参数 */
      engine: {
        intervalMs: 1500,        // 一轮轮询的基础间隔
        jitterPct: 25,           // 抖动百分比，避免固定节奏被限流
        maxConcurrent: 2,        // 同时最多监控/提交几个目标
        submitOnHit: true,       // 查询到有名额时是否自动提交
        /* 判定为「选课成功」之后是否继续轮询这个目标。
         * 默认打开的好处：成功规则就可以取得**很宽松**（宁可误判成功也不错失课程）——
         * 误判成功的代价只是多一条通知（我们会继续抢），误判失败的代价是丢掉课程。
         * 关掉则一旦判定成功就停止对它的提交（更省请求，但要求成功规则很准）。 */
        keepPollingAfterSuccess: true,
        confirmBeforeSubmit: false, // true = 提交前需要你在面板点确认
        maxAttemptsPerTarget: 0, // 0 = 不限制
        minGapMs: 300,           // 两次发包之间的最小间隔（硬保护）
        maxReqPerMinute: 120,    // 每分钟请求上限（硬保护）
        backoff: { onError: 2, maxMs: 30000 },
        stopOn: { captcha: true, logout: true, closed: true, error: false },
        scheduleAt: ''           // 'HH:MM:SS' 定时开抢；空 = 手动启动
      },

      /* 会话保活 + 掉线看门狗
       * 背景：你的系统是「登录满 20 分钟硬超时」→ 心跳救不了，所以保活默认关闭，
       * 重点变成：①硬超时倒计时提醒 ②掉线立刻停机不白刷 ③你重新登录后自动继续。 */
      session: {
        keepAlive: {          enabled: false,         // 硬超时下无效；若实测其实是「空闲超时」，打开它就能续期
          url: '',                // 空 = 用当前工作页地址
          method: 'GET',
          contentType: 'raw',
          headers: {},
          body: '',
          intervalMs: 240000,     // 4 分钟一次（引擎运行时收紧到 2 分钟）
          timeoutMs: 10000,
          cacheBuster: true       // GET 时自动加 _kx=<时间戳>，避免命中缓存
        },
        /* 会话寿命：**实测值优先**。用户最初说 20 分钟，实测是"登录后约 10 分钟绝对失效"
         * （13:04:41 登录 → 13:14:38 收到 401，期间每 1.5 秒都在发请求，不是空闲超时）。
         * 插件会把每次实测的寿命记下来并自动用更准的值（见 content.js 的 effectiveHardTimeoutMs）。 */
        hardTimeoutMs: 600000,    // 10 分钟（按实测调整；0 = 关闭倒计时）
        warnBeforeMs: 120000,     // 距失效 2 分钟时提醒一次
        autoOpenLoginBeforeMs: 90000, // 距失效 90 秒时自动把登录页开好（你只需输验证码）
        probeEveryMs: 300000,     // 正常运行时每 5 分钟做一次登录态体检
        recheckMs: 30000,         // 掉线后每 30 秒探测一次是否已重新登录
        /* 登录时刻只能"估算"：插件无法观测你在 SSO 页面的登录动作，只能拿它自己
         * 最后一次确认「会话还有效」的时刻当锚点。如果这个锚点已经太久没人确认
         * （比如跨了浏览器关闭、隔夜、或你期间重新登录过），就必须作废重算，
         * 否则会出现「刚登录就提示还剩 3 分钟」这种误报。 */
        loginAtStaleMs: 600000,   // 锚点超过 10 分钟没有新观测 → 作废，重新计时
        /* 检测到「去过登录页」后多久之内算「刚登录」。有些系统会静默重新鉴权、
         * 或者你会主动重登一次，插件看不到那次登录动作 —— 靠这个窗口把锚点重算。 */
        loginFlowWindowMs: 1800000,
        autoResume: true,         // 重新登录成功后自动继续抢
        requireLoginBeforeSubmit: true, // 登录态已失效时不再提交，避免无效请求
        loginUrl: '',             // 登录页地址（检测到跳转时自动记忆，也可手工填）
        /* 怎么判断「这是登录页 / 已掉线」 */
        /* 掉线判定的第三只眼睛：直接看页面**渲染出来的文字**。
         * 真实案例：吉大研究生选课掉线后「不跳转登录页」，而是在原地渲染一句
         * 「未登录不能选课」，接口层给的是网络失败（HTTP 0）—— 前两种判据全都漏掉，
         * 插件会以为一切正常。所以直接把这句话认出来。 */
        logoutTextMarkers: { type: 'regex', value: '未登录不能选课|未登录|请先登录|请重新登录|登录已过期|登录已超时|会话已失效|您已退出' },
        /* 连续多少次「体检在网络上就失败」才认为疑似掉线（避免偶发网络抖动误报） */
        probeFailStreak: 3,
        loginMarkers: { type: 'regex', value: 'name=["\']password|请输入密码|统一身份认证|请先登录|登录已超时|重新登录|账号登录|用户登录|未登录不能选课' },
        logoutStatus: [401, 403], // 这些 HTTP 状态码视为掉线
        loginUrlRe: '/(login|sso|cas|auth)', // 最终 URL 命中即视为被重定向到登录页
        loginMarkersOnRedirectOnly: false    // false = 响应体命中 loginMarkers 也算掉线
      },

      /* 余量查询（可选）。若 enabled=false，则进入「盲发」模式：
       * 直接按间隔 POST submit，用 full 规则判断是否已满。 */
      query: {
        enabled: false,
        url: '',
        method: 'POST',
        contentType: 'form',     // form | json | raw
        headers: {},
        body: '',                // 支持 {{id}} 等模板变量
        /* 高级项（面板设置页没有对应的输入框，需要「导出 JSON → 改 → 导入」）：
         * via: 'fetch' 用页面 fetch 重放；极少数系统只认 XHR 时才需要改成 'xhr'
         * timeoutMs: 单次请求超时
         * referrer: 需要指定 Referer 时填（同源才有效，跨源会被浏览器剥掉；
         *           不填 = 用当前页面地址，浏览器本来就会自动带） */
        via: 'fetch',
        timeoutMs: 15000,
        referrer: '',
        parse: {
          type: 'json',          // json | regex | none
          path: '',              // json 数据路径，如 'data.list' / 'rows'
          idField: '',           // 课号/教学班号字段名，如 'jxb_id' / 'BJDM'
          remainField: '',       // 余量字段名，如 'remain' / 'syrs'；也支持 'KXRS-DQRS' 这种两列相减
          capacityField: '',     // 容量列（如 'KXRS'）；与 usedField 一起用时自动相减得余量
          usedField: '',         // 已选列（如 'DQRS'）
          nameField: '',         // 课程名字段名，如 'kcmc'
          regex: '',             // type=regex 时的正则（支持命名组）
          idGroup: 1,
          remainGroup: 2
        }
      },

      /* 选课（提交）请求模板 */
      submit: {
        url: '',
        method: 'POST',
        contentType: 'form',     // form | json | raw
        headers: {},
        body: '',                // 例：'jxb_id={{id}}&kch_id={{kch}}&xkkh={{xkkh}}'
        /* 页面取值：csrfToken 这类「每次会话都会变、不能写死在配置里」的参数用这个。
         * 引擎每次提交前会实时从页面取一次（window / cookie / localStorage / meta），
         * 取不到时兜底用「从抓包中学到的」值（见 content.js 的 resolvePageVars）。
         * 例：{ "csrfToken": { "from": "auto", "key": "csrfToken" } } */
        pageVars: {},
        /* 上面这些变量取不到时就不发包（避免发出必然失败的请求、白刷风控），默认开启 */
        requirePageVars: true,
        /* 模板变量（{{xxx}} 会被替换），可放固定的 xnm/xqm/xkkh 等 */
        vars: {},
        /* 高级项（同 query）：'fetch' 默认；只认 XHR 的系统改成 'xhr' */
        via: 'fetch',
        timeoutMs: 15000,
        referrer: '',
        rules: {
          success: { type: 'regex', value: '选课成功|成功|SUCCESS' },
          full: { type: 'regex', value: '已满|容量已满|人数已满|余量为0' },
          dup: { type: 'regex', value: '已选|重复选择|已经选过' },
          captcha: { type: 'regex', value: '验证码|滑块|captcha|verify' },
          logout: { type: 'regex', value: '未登录|登录超时|重新登录|session' },
          closed: { type: 'regex', value: '未开放|不在选课时间|选课已结束' }
        }
      },

      /* 监控目标。id 就是要监测/提交的「选课ID」 */
      targets: [
        /* { id: '2024-0001', label: '数据结构(张三)', kch: '', enabled: true, priority: 1 }
         * 如果提交模板里还有「每个教学班都不一样」的第三个参数（例如 xkkh），
         * 就给该目标加一个 vars：{ id:'...', kch:'...', vars:{ xkkh:'2024-2025-1-1' } }
         * —— 它会和 submit.vars 一起参与 {{xxx}} 替换，优先级高于 submit.vars。 */
      ],

      /* UI 点击模式（混合）：让页面自己点「选课 → 确定」，token 由页面自己带。
       * 为什么需要：本系统的 csrfToken 每次页面加载都换、且无法从外部读到，
       * 纯 API 发包在重新登录后必然失效。混合模式只在「取不到 token」时点一次
       * （这一次点击本身就是一次真实抢课尝试，不浪费），之后仍走最快的 API 盲发。 */
      ui: {
        enabled: true,
        mode: 'hybrid',        // hybrid = 只在缺 token 时点一次；only = 每次都点；off = 关闭
        selectText: '选课',    // 列表里那个按钮的文字
        confirmText: '确定',   // 确认框里那个按钮的文字
        maxMs: 5000,           // 每步最多等多久（SPA 渲染时机不确定）
        stepMs: 60             // 轮询间隔
      },

      notify: {
        desktop: true,
        sound: true,
        webhook: ''              // 可选：企业微信/钉钉机器人地址
      },

      /* 调试：把抓包与日志自动推给本地收集器，由它落盘到项目目录（默认关闭）
       * 用例：node tools/collector.mjs  →  面板「设置 → 本地抓包落盘」填地址并勾选
       * 全部数据只发往 127.0.0.1，收集器会把 Cookie/Authorization 等凭据头抹掉再写文件。 */
      debug: {
        collectorUrl: '',        // 例：http://127.0.0.1:8790/kx/captures
        autoPush: false,         // 抓到请求就自动推送
        pushLogs: true,          // 连运行日志一起推（排查「为什么没抢到」很有用）
        batchMs: 1000,           // 攒批间隔，避免频繁请求
        maxBatch: 40             // 单批最多几条
      }
    };
  }

  /* ---------------- 工具函数 ---------------- */

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /** 深合并：对象递归合并，数组/原始值整体覆盖 */
  function deepMerge(base, patch) {
    if (!isPlainObject(patch)) return patch === undefined ? base : patch;
    const out = isPlainObject(base) ? Object.assign({}, base) : {};
    for (const k of Object.keys(patch)) {
      const pv = patch[k];
      out[k] = isPlainObject(pv) ? deepMerge(out[k], pv) : pv;
    }
    return out;
  }

  function uid(n) {
    const s = 'abcdefghijkmnpqrstuvwxyz23456789';
    let o = '';
    const len = n || 8;
    for (let i = 0; i < len; i++) o += s[Math.floor(Math.random() * s.length)];
    return o;
  }

  function hostOf(url) {
    try {
      if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
      return new URL(url).hostname.toLowerCase();
    } catch (e) {
      return '';
    }
  }

  /** 把用户输入的站点写成规范形式：去掉协议/路径/端口，只留主机名 */
  function normalizeSite(input) {
    let s = String(input || '').trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^[a-z]+:\/\//, '');
    s = s.split('/')[0].split('?')[0].split('#')[0];
    s = s.replace(/:\d+$/, '');
    s = s.replace(/^\*\./, '');
    return s;
  }

  /** host 是否命中白名单（后缀匹配，'a.b.c' 命中 'b.c'） */
  function siteAllowed(host, sites) {
    host = String(host || '').toLowerCase();
    if (!host) return false;
    const list = Array.isArray(sites) ? sites : [];
    for (const raw of list) {
      const s = normalizeSite(raw);
      if (!s) continue;
      if (host === s || host.endsWith('.' + s)) return true;
    }
    return false;
  }

  /** 模板渲染：{{id}} / {{kch}} / {{ts}} / {{rand}} / 自定义 vars */
  function renderTemplate(tpl, vars) {
    const v = Object.assign({}, vars || {});
    if (v.ts === undefined) v.ts = Date.now();
    if (v.rand === undefined) v.rand = Math.random().toString(36).slice(2, 10);
    return String(tpl == null ? '' : tpl).replace(/\{\{\s*([\w.\-]+)\s*\}\}/g, function (m, key) {
      const val = v[key];
      return val === undefined || val === null ? '' : String(val);
    });
  }

  /**
   * 组装模板变量。优先级（后者覆盖前者）：
   *   submit.vars（全局固定值） < targets[].vars（每个教学班自己的值） < 内置（id/kch/label/name/ts/rand）
   * 抽成共享函数是为了能被自测覆盖 —— 这段顺序错了会静默发出错参数的请求。
   */
  /** 生成"每次都不同"的时间戳。
   *  为什么不能让 Date.now() 直接当 {{ts}}：并发提交是同步启动的一批，
   *  9 个 Date.now() 会落在**同一毫秒** → 9 个请求带一模一样的 ?_=xxx。
   *  真实观察：那种情况下服务器返回过 `{"msg":"<随机32位hex>","code":1}`
   *  （既不是已满也不是成功，插件判成"无法判定"），很可能是被判成了重复请求。
   *  这里保证单调递增且不同 —— 语义上仍然是个毫秒时间戳，只是同毫秒内 +1。 */
  let lastTs = 0;
  function nextTs() {
    const now = Date.now();
    lastTs = now > lastTs ? now : lastTs + 1;
    return lastTs;
  }

  function buildVars(globalVars, target) {
    const t = target || {};
    return Object.assign({}, globalVars || {}, t.vars || {}, {
      id: t.id,
      kch: t.kch || '',
      label: t.label || '',
      name: t.label || '',
      ts: nextTs(),
      rand: uid(6)
    });
  }

  /**
   * 估算登录态剩余时间（纯函数，便于自测）。
   *
   * 背景：学校是「登录满 N 分钟硬超时」，但插件**看不到你的登录动作**（登录发生在
   * SSO 域，插件不在那儿），所以只能用「它自己最后一次确认会话有效的时刻」当锚点。
   *
   * 规则（这就是防止"刚登录却提示还剩 3 分钟"的关键）：
   *   · 锚点 loginAt 存在，但最后一次成功观测 observedAt 已经超过 staleGapMs
   *     → 说明中间发生过插件看不到的事（浏览器关闭、隔夜、重新登录）
   *     → 锚点作废（loginAt = 0），等下一次探测成功再重新起算
   *   · 没有 hardTimeoutMs 或没有 loginAt → leftMs 为 null（不显示、不告警）
   *
   * 返回 { loginAt, leftMs, stale, unknown }
   */
  function authEstimate(input) {
    const i = input || {};
    const now = Number(i.now) || Date.now();
    const hard = Number(i.hardTimeoutMs) || 0;
    const gap = Number(i.staleGapMs) || 600000;
    let loginAt = Number(i.loginAt) || 0;
    const observedAt = Number(i.observedAt) || 0;
    let stale = false;
    if (loginAt && observedAt && now - observedAt > gap) {
      stale = true;
      loginAt = 0;
    }
    const leftMs = (!hard || !loginAt) ? null : loginAt + hard - now;
    return { loginAt: loginAt, leftMs: leftMs, stale: stale, unknown: !loginAt };
  }

  /**
   * 判断「登录时刻锚点」是否必须作废重算（纯函数，便于自测）。
   *
   * 这是修「刚登录却提示还剩 3 分钟」的关键。锚点作废的两种情况：
   *   1. 最近去过登录页（loginFlowAt 在窗口内）—— 你重新登录过/系统静默重鉴权过，
   *      而插件看不到那次登录动作，旧锚点必然偏早
   *   2. 锚点太久没有新观测（observedAt 超过 staleGapMs）—— 浏览器关过、隔夜，
   *      或锚点来自上次会话，已不可信
   *
   * 返回 { reset, reason }
   */
  function authAnchorDecision(input) {
    const i = input || {};
    const now = Number(i.now) || Date.now();
    const loginAt = Number(i.loginAt) || 0;
    const observedAt = Number(i.observedAt) || 0;
    const staleGap = Number(i.staleGapMs) || 600000;
    const flowAt = Number(i.loginFlowAt) || 0;
    const flowWin = Number(i.loginFlowWindowMs) || 1800000;

    if (!loginAt) return { reset: false, reason: '' };
    if (flowAt && now - flowAt >= 0 && now - flowAt <= flowWin) {
      return { reset: true, reason: '检测到刚从登录页回来（说明重新登录过，插件看不到那次登录动作）' };
    }
    if (observedAt && now - observedAt > staleGap) {
      return {
        reset: true,
        reason: '上次记录的登录时刻距今已有 ' + Math.round((now - observedAt) / 60000) + ' 分钟没有确认过会话有效'
      };
    }
    return { reset: false, reason: '' };
  }

  /* ---------------- 页面取值（csrfToken 这类"每次会话都会变"的参数） ---------------- */

  function getByPath(obj, path) {
    if (!path) return obj;
    return String(path).split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
  }

  function firstString(obj, depth) {
    if (obj == null || (depth || 0) > 3) return '';
    if (typeof obj === 'string' || typeof obj === 'number') return String(obj);
    if (typeof obj !== 'object') return '';
    for (const k of Object.keys(obj)) {
      const v = firstString(obj[k], (depth || 0) + 1);
      if (v) return v;
    }
    return '';
  }

  function pickFromCookie(cookieStr, key) {
    const esc = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = String(cookieStr || '').match(new RegExp('(?:^|;\\s*)' + esc + '=([^;]*)'));
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }

  /** 在快照的某个字典里按「键名」找：先精确，再模糊（key 当正则用） */
  function pickByKeyName(box, key) {
    if (!box) return '';
    if (box[key] !== undefined) return String(box[key]);
    try {
      const re = new RegExp(String(key), 'i');
      for (const k of Object.keys(box)) {
        if (re.test(k)) return String(box[k]);
      }
    } catch (e) { /* key 不是合法正则就当没找到 */ }
    return '';
  }

  /**
   * 按「取值说明」从页面探测快照里取一个值（纯函数，便于自测）。
   * spec 形式：
   *   { from:'global',  key:'csrfToken' }                    → window.csrfToken
   *   { from:'cookie',  key:'csrfToken' }                    → document.cookie
   *   { from:'storage', area:'local'|'session', key, path }  → 值先 JSON.parse 再按 path 取
   *   { from:'meta',    key:'csrf-token' }
   *   { from:'learned', key:'csrfToken' }                    → 从抓到的真实请求里学来的（兜底）
   *   { from:'auto',    key:'csrfToken' }                    → 依次试以上全部
   * 可选字段：regex（从取到的文本里再抽一段）、json（storage 值是否先解析）、path
   */
  function resolvePageVar(spec, snapshot, learned) {
    const s = (typeof spec === 'string') ? { from: 'auto', key: spec } : (spec || {});
    const snap = snapshot || {};
    const key = s.key || 'csrfToken';
    const post = function (v) {
      let out = v == null ? '' : String(v);
      if (s.regex) {
        try {
          const m = out.match(new RegExp(s.regex));
          out = m ? (m[1] !== undefined ? m[1] : m[0]) : '';
        } catch (e) { out = ''; }
      }
      return out.trim();
    };
    const fromStorage = function (area) {
      const box = (snap.storage || {})[area === 'session' ? 'session' : 'local'] || {};
      const raw = pickByKeyName(box, key);
      if (raw) {
        if (s.json !== false) {
          try {
            const parsed = JSON.parse(raw);
            const v = s.path ? getByPath(parsed, s.path)
              : (typeof parsed === 'object' && parsed !== null ? (pickByKeyName(parsed, key) || firstString(parsed)) : parsed);
            if (v !== undefined && v !== null && String(v) !== '') return String(v);
          } catch (e) { /* 不是 JSON 就按原文用 */ }
        }
        return raw;
      }
      /* 键名对不上时，再扫一遍所有 storage 值：很多 SPA 会把状态塞在
       * 一个 JSON blob 里（如 appState={"data":{"csrfToken":"..."}}），
       * 这时按「键名」是找不到的，得进 JSON 里找同名字段。 */
      for (const k of Object.keys(box)) {
        const v = box[k];
        if (typeof v !== 'string' || v.length < 2 || v[0] !== '{') continue;
        try {
          const parsed = JSON.parse(v);
          const hit = s.path ? getByPath(parsed, s.path) : pickByKeyName(parsed, key);
          if (hit !== undefined && hit !== null && String(hit) !== '') return String(hit);
        } catch (e) { /* 跳过非 JSON */ }
      }
      return '';
    };

    if (s.from === 'global') return post(pickByKeyName(snap.globals, key));
    if (s.from === 'cookie') return post(pickFromCookie(snap.cookies, key));
    if (s.from === 'storage') return post(fromStorage(s.area));
    if (s.from === 'meta') return post(pickByKeyName(snap.metas, key));
    if (s.from === 'learned') return post((learned || {})[key] || '');
    // auto：cookie 通常是服务端下发的、最稳，所以排第一
    return post(
      pickFromCookie(snap.cookies, key)
      || pickByKeyName(snap.globals, key)
      || fromStorage('local')
      || fromStorage('session')
      || pickByKeyName(snap.metas, key)
      || (learned || {})[key]
      || ''
    );
  }

  /**
   * 实测是否已经推翻「硬超时」这个假设（纯函数）。
   *
   * 为什么需要：用户最初认为系统是「登录满 20 分钟硬超时」，但真实日志显示
   * 会话在登录后 39 分钟仍然有效（因为插件每 5 分钟发一次已鉴权体检请求）——
   * 说明它其实是**空闲超时**，被定时请求续上了。
   * 这种情况下继续按"硬超时"倒计时/停机就是误报，必须自动停用。
   *
   * 判据：会话从推定登录时刻起，已经活过了 hardTimeoutMs + 宽限期，仍然有效。
   */
  function isHardTimeoutDisproved(input) {
    const i = input || {};
    const now = Number(i.now) || Date.now();
    const loginAt = Number(i.loginAt) || 0;
    const hard = Number(i.hardTimeoutMs) || 0;
    const grace = Number(i.graceMs) || 60000;
    if (!loginAt || !hard) return false;
    return (now - loginAt) > (hard + grace);
  }

  /* ---------------- 登录检测（同域登录也要能认出来） ---------------- */

  /** 找出**命中的那个掉线标记**（返回标记词，没命中返回 ''）。
   *  为什么要返回"命中了哪个词"：判了掉线却不知道凭什么判，就没法诊断误判 ——
   *  真实事故：探测拿到一段含「未登录」的页面就把活着的会话判成掉线、把引擎停了一次，
   *  而日志只写"响应内容命中登录页特征"，看不出是哪个词、什么内容，只能靠猜。 */
  function matchLogoutMarker(text, markers) {
    const s = String(text == null ? '' : text);
    if (!s) return '';
    const m = markers || { type: 'regex', value: '未登录不能选课|未登录|请先登录|请重新登录|登录已过期|登录已超时' };
    try {
      if (m.type === 'regex') {
        const hit = new RegExp(String(m.value || ''), m.flags || 'i').exec(s);
        return hit ? hit[0] : '';
      }
      if (m.type === 'contains') {
        const list = String(m.value || '').split('|').filter(Boolean);
        for (const w of list) if (s.indexOf(w) !== -1) return w;
        return '';
      }
      if (m.type === 'always') return '（always）';
      return '';
    } catch (e) { return ''; }
  }

  /** 页面渲染出来的文字里有没有「你已掉线」的迹象（纯函数，便于自测）。
   *  刻意不依赖 KXRules：config.js 在内容脚本里先于 rules.js 加载，自包含更稳。 */
  function looksLoggedOut(text, markers) {
    return !!matchLogoutMarker(text, markers);
  }

  /** 这个 URL 是不是登录接口。注意很多系统（如吉大正方）的登录接口和选课系统
   *  在**同一个域名**下，所以 background 的「非白名单主机 + 像登录页」那套检测抓不到，
   *  只能靠内容脚本录到的登录请求本身来判断。 */
  function isLoginEndpoint(url) {
    return /(check\/login|\/login\/|login\.do|logon|signin|passport)/i.test(String(url || ''));
  }

  /** 登录响应看起来是成功还是失败（正方：{"msg":"登录成功","code":"1"}） */
  function looksLoginSuccess(text) {
    const s = String(text == null ? '' : text);
    if (!s) return false;
    if (/不正确|失败|错误|验证码有误/.test(s)) return false;
    return /登录成功|登陆成功|"code"\s*:\s*"?1"?|success/i.test(s);
  }

  /**
   * 日志聚合（纯函数，便于自测）：同 key 的日志**就地合并**成一条，
   * 只保留最新文案/时间并累加 count，同时把它移到列表末尾（日志页倒序显示，最近的排最前）。
   *
   * 两个必须做对的点（都踩过）：
   *   ① 必须在**整个列表**里找同 key，不能只看最后一条 ——
   *      多目标轮转时，同一目标的相邻两次日志之间会插入其它目标的行和限速行，
   *      "只看末尾"等于永远不合并（真实事故：日志照样刷到 400 条）。
   *   ② 没有 key 的日志（引擎启动、掉线、状态变化这类一次性事件）永不合并，
   *      否则关键信息会被吃掉。
   */
  function aggregatePush(list, item, maxLen) {
    const max = Number(maxLen) || 400;
    const key = item && item.key;
    if (!key) {
      list.push(item);
      while (list.length > max) list.shift();
      return { merged: false, item: item };
    }
    let idx = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].key === key) { idx = i; break; }
    }
    if (idx >= 0) {
      const last = list[idx];
      last.count = (last.count || 1) + 1;
      last.t = item.t;
      last.msg = item.msg;
      if (item.extra !== undefined) last.extra = item.extra;
      list.splice(idx, 1);
      list.push(last);
      return { merged: true, item: last };
    }
    list.push(item);
    while (list.length > max) list.shift();
    return { merged: false, item: item };
  }

  /**
   * 把「备选清单」变成「按名字监控的目标」（纯函数，便于自测）。
   *
   * 为什么需要：教学班 ID 每年都变（形如 20261-101-A0162101001-1785413134156），
   * 所以**跨年、跨电脑**能带过去的只有"课程名"这类稳定信息。备选清单就是它的载体：
   * 先在档案里挑好课 → 存成备选清单（只有名字/教师/校区）→ 明年在新电脑上装好扩展，
   * 插件自动把它变成「按名字监控」的目标，等选课页能拉到课表时再匹配成真 ID。
   *
   * 生成的 target 里 `id` 是**空串** —— 引擎据此认出"这个目标还没有教学班ID"，
   * 从而触发按课程名自动匹配，而不是拿空 ID 去发请求。
   */
  function wishlistToTargets(wishlist) {
    return (wishlist || [])
      .map(function (w) {
        const name = String((w && (w.name || w.label)) || '').trim();
        return {
          id: '',                                  // 空 = 待解析（不是错误状态）
          label: String((w && w.label) || name).trim(),
          name: name,
          teacher: String((w && w.teacher) || '').trim(),
          campus: String((w && w.campus) || '').trim(),
          kch: String((w && (w.kch || w.code)) || '').trim(),
          enabled: true,
          fromWishlist: true
        };
      })
      .filter(function (t) { return t.name; });
  }

  /**
   * 把「项目里的配置文件」与「浏览器里存的配置」合并成最终生效的配置（纯函数，便于自测）。
   *
   * 用途：扩展配置存在浏览器里，而配置文件在项目目录里 —— 不合并的话，
   * 每次改文件都要手动导入一次（用户反馈："这个配置json能自动配置吗"）。
   *
   * 合并规则（关键：分清"这是谁的东西"）：
   *   · 以**文件为准**：站点白名单、提交/查询/已选接口、判定规则、会话与 UI 策略
   *     —— 这些是"系统协议"，应该跟着项目走
   *   · 保留**你的**：targets（选课清单，绝不能被文件冲掉）、
   *     engine（你在面板上调的速率/开关；按 key 合并，文件里的新键仍会补进来）、
   *     notify / debug（通知偏好、收集器地址，属于本地环境）
   *   · wishlist（备选清单）：本地有就用本地的，**本地为空时用文件里的**
   *     —— 这正是"新电脑装好就自动带着去年挑好的课"的关键（种子语义）
   */
  function mergeBundledConfig(fileCfg, storedCfg) {
    const file = fileCfg || {};
    const keep = storedCfg || {};
    const out = Object.assign({}, file);
    out.targets = keep.targets || [];
    out.engine = Object.assign({}, file.engine || {}, keep.engine || {});
    out.notify = keep.notify || file.notify;
    out.debug = keep.debug || file.debug;
    const localWl = Array.isArray(keep.wishlist) ? keep.wishlist : [];
    out.wishlist = localWl.length ? localWl : (Array.isArray(file.wishlist) ? file.wishlist : []);
    return out;
  }

  /** 按 contentType 组装请求体 + 默认 Content-Type */
  function buildBody(contentType, body, vars) {
    const rendered = renderTemplate(body || '', vars);
    const headers = {};
    let out = rendered;
    if (contentType === 'json') {
      headers['Content-Type'] = 'application/json';
      if (!rendered.trim()) out = '{}';
    } else if (contentType === 'form') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    } else {
      // raw：完全由用户负责 headers
    }
    return { body: out, headers: headers };
  }

  /* ---------------- 状态读写 ---------------- */

  let cache = null;
  const listeners = new Set();

  function area() {
    return (chrome && chrome.storage && chrome.storage.local) || null;
  }

  async function load(force) {
    if (cache && !force) return cache;
    const a = area();
    if (!a) { cache = defaults(); return cache; }
    const got = await a.get(STORAGE_KEY);
    cache = deepMerge(defaults(), got && got[STORAGE_KEY] ? got[STORAGE_KEY] : {});
    return cache;
  }

  function snapshot() {
    return cache || defaults();
  }

  async function save(patch) {
    const next = deepMerge(await load(), patch || {});
    cache = next;
    const a = area();
    if (a) await a.set({ [STORAGE_KEY]: next });
    return next;
  }

  async function replace(state) {
    cache = deepMerge(defaults(), state || {});
    const a = area();
    if (a) await a.set({ [STORAGE_KEY]: cache });
    return cache;
  }

  async function reset() {
    return replace(defaults());
  }

  /** 订阅状态变化（跨上下文：popup 改设置，content script 也能收到） */
  function subscribe(cb) {
    listeners.add(cb);
    if (!globalThis.__kxSubscribed && chrome && chrome.storage && chrome.storage.onChanged) {
      globalThis.__kxSubscribed = true;
      chrome.storage.onChanged.addListener(function (changes, ns) {
        if (ns !== 'local' || !changes[STORAGE_KEY]) return;
        cache = deepMerge(defaults(), changes[STORAGE_KEY].newValue || {});
        for (const fn of listeners) {
          try { fn(cache); } catch (e) { /* ignore */ }
        }
      });
    }
    return function () { listeners.delete(cb); };
  }

  /* ---------------- 抓包记录缓存（面板/弹窗共用） ---------------- */

  async function loadCaptures() {
    const a = area();
    if (!a) return [];
    const got = await a.get(CAPTURE_KEY);
    return (got && got[CAPTURE_KEY]) || [];
  }

  /** 只保留最近 max 条，响应体截断，避免 storage 爆掉 */
  async function pushCapture(entry, max) {
    const a = area();
    if (!a) return;
    const list = await loadCaptures();
    list.push(Object.assign({ ts: Date.now() }, entry));
    const cap = max || 40;
    while (list.length > cap) list.shift();
    await a.set({ [CAPTURE_KEY]: list });
  }

  async function clearCaptures() {
    const a = area();
    if (a) await a.set({ [CAPTURE_KEY]: [] });
  }

  /** 按路径整体设值（对象/数组会**整体替换**，不像 save 那样深合并）
   *  面板里编辑 headers / vars / sites 这类整体值时必须用它，否则旧的键会残留。 */
  function withPath(state, path, value) {
    const clone = JSON.parse(JSON.stringify(state));   // 只用于配置对象，足够
    const parts = String(path).split('.');
    let cur = clone;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (!isPlainObject(cur[k]) && !Array.isArray(cur[k])) cur[k] = {};
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = value;
    return clone;
  }

  async function setByPath(path, value) {
    const next = withPath(await load(), path, value);
    return replace(next);
  }

  globalThis.KX = {
    VERSION: '0.1.0',
    STORAGE_KEY,
    CAPTURE_KEY,
    defaults,
    deepMerge,
    uid,
    hostOf,
    normalizeSite,
    siteAllowed,
    renderTemplate,
    buildBody,
    buildVars,
    nextTs,
    resolvePageVar,
    getByPath,
    aggregatePush,
    mergeBundledConfig,
    wishlistToTargets,
    authEstimate,
    authAnchorDecision,
    isHardTimeoutDisproved,
    isLoginEndpoint,
    looksLoginSuccess,
    looksLoggedOut,
    matchLogoutMarker,
    load,
    snapshot,
    save,
    replace,
    reset,
    withPath,
    setByPath,
    subscribe,
    loadCaptures,
    pushCapture,
    clearCaptures
  };
})();
