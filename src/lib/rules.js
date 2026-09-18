/* ============================================================
 * lib/rules.js —— 响应解析与判定规则引擎
 * ------------------------------------------------------------
 * 两大职责：
 *   1. 判定：从提交响应里判断 成功 / 已满 / 重复 / 验证码 / 掉登录 / 未开放
 *   2. 解析：从余量查询响应里抽出 [{id, name, remain}] 列表
 * 都是纯函数，方便在 Node 里直接写自测（见 test/rules.test.mjs）
 * ============================================================ */
(function () {
  if (globalThis.KXRules) return;

  /** 规则求值：返回 true/false
   * rule = { type: 'regex'|'contains'|'notContains'|'status'|'empty'|'always', value, status } */
  function evalRule(rule, text, httpStatus) {
    if (!rule || !rule.type) return false;
    const s = String(text == null ? '' : text);
    switch (rule.type) {
      case 'always':
        return true;
      case 'never':
        return false;
      case 'contains':
        return s.indexOf(String(rule.value || '')) !== -1;
      case 'notContains':
        return s.indexOf(String(rule.value || '')) === -1;
      case 'empty':
        return s.trim().length === 0;
      case 'status':
        return Number(httpStatus) === Number(rule.status || rule.value || 200);
      case 'regex': {
        try {
          return new RegExp(String(rule.value || ''), rule.flags || 'i').test(s);
        } catch (e) {
          return false;
        }
      }
      default:
        return false;
    }
  }

  /** JSON 取值：支持 a.b.0.c / a[0].b / a.*.b（* = 取第一个可用的键） */
  function jsonGet(obj, path) {
    if (!path) return obj;
    const parts = String(path)
      .replace(/\[(\d+)\]/g, '.$1')
      .replace(/\[['"]?([^'"\]]+)['"]?\]/g, '.$1')
      .split('.')
      .filter(Boolean);
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return undefined;
      if (p === '*') {
        if (Array.isArray(cur)) { cur = cur[0]; continue; }
        if (typeof cur === 'object') { cur = cur[Object.keys(cur)[0]]; continue; }
        return undefined;
      }
      cur = cur[p];
    }
    return cur;
  }

  function parseMaybeJson(text) {
    try { return JSON.parse(text); } catch (e) { return undefined; }
  }

  /** 找「以 ID 为键的对象」：{"2099000001":{...},"2099000002":{...}} */
  function findObjectMap(node, depth) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 4) return null;
    const keys = Object.keys(node);
    if (!keys.length) return null;
    const digitKeys = keys.filter(function (k) { return /^\d{2,}$/.test(k); });
    if (digitKeys.length >= Math.max(1, Math.ceil(keys.length * 0.5))) return node;
    for (const k of keys) {
      const v = node[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const deep = findObjectMap(v, depth + 1);
        if (deep) return deep;
      }
    }
    return null;
  }

  /** 找「单条记录」：既没有数组也没有映射表时，把最深一层的记录对象挖出来 */
  function findRecord(node, depth) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 4) return null;
    const keys = Object.keys(node);
    // 有「余量」字段是最强信号
    if (keys.some(function (k) { return REMAIN_PATTERNS.some(function (re) { return re.test(k); }); })) return node;
    // 先往深处找：真实的记录通常在 data/result 里面
    for (const k of keys) {
      const v = node[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const deep = findRecord(v, depth + 1);
        if (deep) return deep;
      }
    }
    // 没有更深层了：这一层要有一个「像 ID 的标量字段」才算记录
    // （不能只看字段名 —— 形如 {code:0,msg:"ok"} 的响应也会命中 /code/i）
    const looksLikeId = keys.some(function (k) {
      const v = node[k];
      if (v == null || typeof v === 'object') return false;
      const s = String(v).trim();
      return /^\d{3,}$/.test(s) && ID_PATTERNS.some(function (re) { return re.test(k); });
    });
    return looksLikeId ? node : null;
  }

  /** 从各种可能的容器里找出「记录数组」 */
  function findArray(node, depth) {
    if (depth > 4 || node == null) return null;
    if (Array.isArray(node)) return node;
    if (typeof node === 'object') {
      // 常见：{rows:[...]}, {data:{list:[...]}}, {items:[...]}
      const prefer = ['rows', 'list', 'items', 'data', 'result', 'records', 'aaData', 'content'];
      for (const k of prefer) {
        if (Array.isArray(node[k])) return node[k];
        if (node[k] && typeof node[k] === 'object') {
          const deep = findArray(node[k], depth + 1);
          if (deep) return deep;
        }
      }
      for (const k of Object.keys(node)) {
        const deep = findArray(node[k], depth + 1);
        if (deep) return deep;
      }
    }
    return null;
  }

  /** 猜字段：在对象里找出匹配的键名 */
  function guessKey(obj, patterns) {
    const keys = Object.keys(obj || {});
    for (const re of patterns) {
      for (const k of keys) {
        if (re.test(k)) return k;
      }
    }
    return '';
  }

  const ID_PATTERNS = [/jxb_?id/i, /^id$/i, /xkkh/i, /bjh/i, /bjdm/i, /kch_?id/i, /class_?id/i, /course_?id/i, /^kch$/i, /code/i];
  /* 注意 KXRS 只在 CAP_PATTERNS 里、不在 REMAIN_PATTERNS 里：
   * 真实站点（吉大正方）的 KXRS 是「容量」、DQRS 是「当前人数」，余量 = 两者之差。
   * 如果哪个系统的 KXRS 确实表示"剩余"，请显式写 query.parse.remainField = 'KXRS'。 */
  const REMAIN_PATTERNS = [/remain/i, /rest/i, /left/i, /syrs/i, /^yl$/i, /available/i, /surplus/i, /balance/i, /^num$/i, /capacity_?left/i, /^key$/i];
  const CAP_PATTERNS = [/capacity/i, /^rl$/i, /^zrs$/i, /^kxrs$/i, /limit/i, /^kcrl$/i];
  const USED_PATTERNS = [/selected/i, /^yxrs$/i, /^dqrs$/i, /chosen/i, /picked/i, /^yixrs$/i, /enrolled/i];
  const NAME_PATTERNS = [/kcmc/i, /course_?name/i, /^name$/i, /title/i, /jxbmc/i, /bj_?mc/i, /^mc$/i];

  /** 每次都变、但绝不是选课ID的噪声字段（时间戳/随机数/签名/令牌） */
  const NOISE_KEY_RE = /(^_|ts$|time|timestamp|rand|random|nonce|token|sign|session|csrf|_t$|^ver$|^v$|stamp)/i;

  function toNumber(v) {
    if (typeof v === 'number') return v;
    if (v == null) return NaN;
    const m = String(v).match(/-?\d+/);
    return m ? parseInt(m[0], 10) : NaN;
  }

  /** 把一条原始记录规整成 {id, name, remain, raw} */
  function normalizeRow(row, parse) {
    const p = parse || {};
    let id = '', name = '', remain = NaN;
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      const idKey = p.idField || guessKey(row, ID_PATTERNS);
      const nameKey = p.nameField || guessKey(row, NAME_PATTERNS);
      id = idKey ? row[idKey] : '';
      name = nameKey ? row[nameKey] : '';

      /* 余量有三种表达方式，按优先级：
       *   1. remainField 写成两列相减的表达式：'KXRS-DQRS'（正方常见：容量 − 当前人数）
       *   2. remainField 直接指向一列：'remain' / 'syrs'
       *   3. 显式给 capacityField / usedField 两列，自动相减
       *   4. 都没有就按列名猜（capacity/used 两列都存在时相减）
       * 真实依据：吉大研究生选课里 KXRS=50、DQRS=50 而提交返回「容量已满」，
       * 说明 KXRS 是容量、DQRS 是已选人数，剩余 = 两者之差。 */
      const remainKey = p.remainField || '';
      const expr = remainKey && String(remainKey).match(/^\s*([A-Za-z0-9_.]+)\s*-\s*([A-Za-z0-9_.]+)\s*$/);
      const capField = p.capacityField || '';
      const usedField = p.usedField || '';

      if (expr) {
        const cap = toNumber(row[expr[1]]);
        const used = toNumber(row[expr[2]]);
        if (isFinite(cap) && isFinite(used)) remain = cap - used;
      } else if (remainKey) {
        remain = toNumber(row[remainKey]);
        if (!isFinite(remain) && capField && usedField) remain = toNumber(row[capField]) - toNumber(row[usedField]);
      } else if (capField && usedField) {
        remain = toNumber(row[capField]) - toNumber(row[usedField]);
      } else {
        // 猜：优先「明确的余量列」，其次「容量 − 已选」
        const guessRemain = guessKey(row, REMAIN_PATTERNS);
        if (guessRemain) remain = toNumber(row[guessRemain]);
        const capKey = guessKey(row, CAP_PATTERNS);
        const usedKey = guessKey(row, USED_PATTERNS);
        if (!isFinite(remain) && capKey && usedKey) remain = toNumber(row[capKey]) - toNumber(row[usedKey]);
      }
    } else if (Array.isArray(row)) {
      id = row[0];
      name = row[1];
      remain = toNumber(row[2]);
    } else {
      id = row;
    }
    return {
      id: id === undefined || id === null ? '' : String(id).trim(),
      name: name === undefined || name === null ? '' : String(name).trim(),
      remain: remain,
      raw: row
    };
  }

  /**
   * 解析余量查询响应 → { ok, list:[{id,name,remain}], error }
   * parse = { type:'json'|'regex'|'none', path, idField, remainField, nameField, regex, idGroup, remainGroup, flags }
   */
  function parseList(parse, text) {
    const p = parse || { type: 'json' };
    const s = String(text == null ? '' : text);

    if (p.type === 'none') return { ok: true, list: [], error: '' };

    if (p.type === 'regex') {
      if (!p.regex) return { ok: false, list: [], error: '未填写 regex' };
      let re;
      try {
        re = new RegExp(p.regex, (p.flags || 'gi').indexOf('g') === -1 ? (p.flags || 'gi') + 'g' : (p.flags || 'gi'));
      } catch (e) {
        return { ok: false, list: [], error: '正则非法: ' + e.message };
      }
      const list = [];
      let m;
      let guard = 0;
      while ((m = re.exec(s)) !== null && guard++ < 5000) {
        if (m[0] === '') { re.lastIndex++; continue; }
        const g = m.groups || {};
        const id = g.id !== undefined ? g.id : m[Number(p.idGroup) || 1];
        const remain = g.remain !== undefined ? g.remain : m[Number(p.remainGroup) || 2];
        const name = g.name !== undefined ? g.name : '';
        if (id === undefined) continue;
        list.push({ id: String(id).trim(), name: String(name || '').trim(), remain: toNumber(remain), raw: m[0] });
      }
      return { ok: true, list, error: '' };
    }

    // 默认 json
    const data = parseMaybeJson(s);
    if (data === undefined) {
      return { ok: false, list: [], error: '响应不是合法 JSON（若返回的是 HTML，请把 parse.type 改成 regex）' };
    }
    let node = p.path ? jsonGet(data, p.path) : data;
    let rows = Array.isArray(node) ? node : findArray(node, 0);
    if (!rows) {
      // 可能是「以 id 为键的对象」：{ "2099000001": {remain: 3}, ... }
      const map = findObjectMap(node, 0);
      if (map) {
        rows = Object.keys(map).map(function (k) {
          const v = map[k];
          return (v && typeof v === 'object' && !Array.isArray(v)) ? Object.assign({ id: k }, v) : { id: k, remain: v };
        });
      } else {
        // 也可能是「单条记录」：{code:0, data:{jxb_id:.., remain:..}}
        const rec = findRecord(node, 0);
        if (rec) rows = [rec];
      }
    }
    if (!rows) {
      return { ok: false, list: [], error: '未找到记录数组：请检查 parse.path，或把 parse.type 改成 regex 用正则抓' };
    }
    const list = rows.map(function (r) { return normalizeRow(r, p); }).filter(function (r) { return r.id; });
    return { ok: true, list, error: '' };
  }

  /**
   * 判定提交结果。
   * 顺序：致命错误（验证码/掉登录/未开放）→ 已选过 → 已满 → **成功（兜底放最后）**。
   *
   * 为什么成功放最后：用户可能把 success 规则取得很宽松（"只要没有失败特征就算成功"），
   * 那种规则会匹配任何响应；如果它在前面，「容量已满」会被它抢走、判成成功。
   * 把明确的结论（dup/full）放在前面，成功的宽规则就只能在剩下的情况里兜底。
   * 配合 engine.keepPollingAfterSuccess（成功后继续轮询），误判成功的代价只是一条通知。
   */
  function classify(rules, text, httpStatus) {
    const r = rules || {};
    const order = ['captcha', 'logout', 'closed', 'dup', 'full', 'success'];
    for (const k of order) {
      if (r[k] && evalRule(r[k], text, httpStatus)) return { kind: k, rule: k, detail: r[k].value || r[k].type };
    }
    if (httpStatus && (httpStatus < 200 || httpStatus >= 400)) return { kind: 'http', rule: 'http', detail: 'HTTP ' + httpStatus };
    return { kind: 'unknown', rule: '', detail: '' };
  }

  /** 结果文案 */
  const KIND_TEXT = {
    success: '选课成功',
    full: '名额已满',
    dup: '已选过（视作完成）',
    captcha: '触发验证码',
    logout: '登录态失效',
    closed: '不在选课时间',
    http: 'HTTP 错误',
    unknown: '结果未知'
  };

  /* ============================================================
   * 参数工具：给「抓包 → 提取选课ID字段 → 生成模板」用
   * ============================================================ */

  function safeDecode(v) {
    try { return decodeURIComponent(String(v).replace(/\+/g, ' ')); } catch (e) { return String(v); }
  }

  /** 把请求体拆成 [{k, v}]（支持 form-urlencoded 与 JSON） */
  function splitParams(body, contentType) {
    const out = [];
    const s = String(body == null ? '' : body);
    if (!s.trim()) return out;
    const ct = String(contentType || '').toLowerCase();
    const looksJson = ct.indexOf('json') !== -1 || /^\s*[{[]/.test(s);
    if (looksJson) {
      let o;
      try { o = JSON.parse(s); } catch (e) { return [{ k: '(raw)', v: s }]; }
      (function walk(obj, prefix) {
        Object.keys(obj || {}).forEach(function (k) {
          const v = obj[k];
          const path = prefix ? prefix + '.' + k : k;
          if (v && typeof v === 'object') walk(v, path);
          else out.push({ k: path, v: v == null ? '' : String(v) });
        });
      })(o, '');
      return out;
    }
    s.split('&').forEach(function (pair) {
      if (!pair) return;
      const i = pair.indexOf('=');
      const k = i === -1 ? pair : pair.slice(0, i);
      const v = i === -1 ? '' : pair.slice(i + 1);
      out.push({ k: safeDecode(k), v: safeDecode(v) });
    });
    return out;
  }

  /**
   * 差分多条同类请求，找出「键相同、值不同」的参数 —— 这些就是
   * 每次选课都在变的字段，选课ID 通常就在其中。
   * entries: [{ body, contentType }] → [{k, values:[...], digitRatio, score}]
   */
  function diffParamKeys(entries) {
    const maps = (entries || []).map(function (e) {
      const m = new Map();
      splitParams(e.body, e.contentType).forEach(function (p) { m.set(p.k, p.v); });
      return m;
    });
    if (!maps.length) return [];
    const keys = new Set();
    maps.forEach(function (m) { m.forEach(function (_v, k) { keys.add(k); }); });
    const out = [];
    keys.forEach(function (k) {
      const values = maps.map(function (m) { return m.has(k) ? m.get(k) : ''; });
      const uniq = Array.from(new Set(values));
      if (uniq.length < 2) return; // 值都一样的键不是我们要找的
      const allDigit = values.every(function (v) { return /^\d{3,}$/.test(String(v)); });
      const digitRatio = values.filter(function (v) { return /^\d+$/.test(String(v)); }).length / values.length;
      const maxLen = Math.max.apply(null, values.map(function (v) { return String(v).length; }));
      const noise = NOISE_KEY_RE.test(k);
      out.push({
        k: k,
        values: values,
        allDigit: allDigit,
        digitRatio: digitRatio,
        noise: noise,
        // 噪声字段（时间戳/随机数/签名）分数压到最低，但仍列出来，免得你以为是插件漏了
        score: (noise ? -200 : 0) + (allDigit ? 100 : 0) + Math.round(digitRatio * 40) + Math.min(30, maxLen)
      });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }

  function esc4re(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 把请求体里某个参数的值替换成模板占位符（如 {{id}}），原样保留其它参数。
   * 同时兼容 form-urlencoded 与 JSON。
   */
  function applyTemplate(rawBody, key, placeholder) {
    let s = String(rawBody == null ? '' : rawBody);
    if (!key || !s) return s;
    const esc = esc4re(key.split('.').pop());
    // form: ...&key=value&...
    const formRe = new RegExp('(^|&)' + esc + '=([^&]*)');
    if (formRe.test(s)) {
      return s.replace(formRe, function (_m, p1) { return p1 + key.split('.').pop() + '=' + placeholder; });
    }
    // json: "key": "value" 或 "key": value
    const jsonRe = new RegExp('("' + esc + '"\\s*:\\s*)("?)([^",}\\]]*)\\2');
    if (jsonRe.test(s)) {
      return s.replace(jsonRe, function (_m, p1, q) { return p1 + q + placeholder + q; });
    }
    return s;
  }

  /** 把 URL 查询串里某个参数替换成模板占位符 */
  function applyUrlTemplate(rawUrl, key, placeholder) {
    let s = String(rawUrl == null ? '' : rawUrl);
    if (!key || !s) return s;
    const esc = esc4re(key);
    const re = new RegExp('([?&])' + esc + '=([^&#]*)');
    if (re.test(s)) return s.replace(re, function (_m, p1) { return p1 + key + '=' + placeholder; });
    return s;
  }

  /** 给一条记录猜字段名，用于自动填 query.parse */
  function guessFields(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { idField: '', remainField: '', nameField: '' };
    }
    return {
      idField: guessKey(row, ID_PATTERNS),
      remainField: guessKey(row, REMAIN_PATTERNS),
      nameField: guessKey(row, NAME_PATTERNS)
    };
  }

  /** 从参数表里猜「哪个键最像选课ID」（纯数字、长度长、优先 id 类命名） */
  function guessIdParam(params) {
    const cands = (params || []).filter(function (p) { return /^\d{3,}$/.test(String(p.v)); });
    if (!cands.length) return '';
    const named = cands.filter(function (p) { return ID_PATTERNS.some(function (re) { return re.test(p.k); }); });
    const pool = named.length ? named : cands;
    pool.sort(function (a, b) { return String(b.v).length - String(a.v).length; });
    return pool[0].k;
  }

  /** 把查询体里的 pageSize 换成指定值（人工「查询一次」时用来一次拿全，
   *  而自动轮询仍用较小的 pageSize 以省流量/降低风控风险）。纯函数，便于自测。 */
  function withPageSize(body, size) {
    const s = String(body == null ? '' : body);
    const n = Number(size) || 0;
    if (!n || n < 1) return s;          // 0 / 非数字 = 不改（别用 Math.max 兜，否则 0 会变成 1）
    if (/pageSize=\d*/.test(s)) return s.replace(/pageSize=\d*/, 'pageSize=' + n);
    if (/\bpageSize\b/.test(s)) return s.replace(/\bpageSize\b/, 'pageSize=' + n);
    return s + (s ? '&' : '') + 'pageSize=' + n;
  }

  /** 从余量原始记录里挑出「帮你区分同名教学班」的辅助信息 */
  function rowExtras(raw) {
    const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const pick = function (keys) {
      for (const k of keys) {
        const v = r[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      }
      return '';
    };
    return {
      teacher: pick(['RKJS', 'JSXM', 'teacher', 'jsxm']),
      time: pick(['PKSJDDMS', 'PKSJDD', 'PKSJDDYWMS', 'time', 'sksj']),
      campus: pick(['XQMC', 'campus', 'xqmc']),
      code: pick(['KCDM', 'KCH', 'courseCode', 'kch']),
      klass: pick(['BJMC', 'jxbmc', 'className'])
    };
  }

  /* ============================================================
   * 课程名模糊匹配（为"下一年教学班代码变了"兜底）
   * ------------------------------------------------------------
   * 教学班ID（bjdm）每年会变，课程名基本不变。所以目标除了存 ID，
   * 还应该存"课程名 + 教师"，ID 失效时按名字重新找回。
   *
   * 归一化处理掉这些**年年会变但无意义**的差异：
   *   · 括号内容：（线上慕课）、(01)、【实验班】
   *   · 全角/半角、空格、各种标点
   *   · 末尾的班级序号：篮球01 / 篮球1
   * 相似度用字符二元组 Dice 系数 —— 对中文短文本效果好且无需分词。
   * ============================================================ */

  /** 归一化课程名（纯函数） */
  function normCourseName(s) {
    let t = String(s == null ? '' : s);
    // 全角 → 半角
    t = t.replace(/[\uFF01-\uFF5E]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/\u3000/g, ' ');
    // 去掉括号内容（中英文括号、书名号、方括号）
    t = t.replace(/[（(【\[《][^）)】\]》]*[）)】\]》]/g, '');
    // 去掉空白与常见标点
    t = t.replace(/[\s\-_·、,，.。/\\|:：;；'"“”‘’!！?？#*+~^&]/g, '');
    // 去掉末尾班级序号（"篮球01" → "篮球"）
    t = t.replace(/[0-9]+$/g, '');
    return t.toLowerCase();
  }

  /** 字符二元组集合 */
  function bigrams(s) {
    const out = [];
    const t = String(s || '');
    if (t.length <= 1) return t ? [t] : [];
    for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
    return out;
  }

  /** Dice 系数（0~1）。中文短文本用它比编辑距离更稳。 */
  function dice(a, b) {
    const A = bigrams(a), B = bigrams(b);
    if (!A.length || !B.length) return a && a === b ? 1 : 0;
    const cnt = new Map();
    A.forEach(function (g) { cnt.set(g, (cnt.get(g) || 0) + 1); });
    let hit = 0;
    B.forEach(function (g) {
      const c = cnt.get(g) || 0;
      if (c > 0) { hit++; cnt.set(g, c - 1); }
    });
    return (2 * hit) / (A.length + B.length);
  }

  /** 两个课程名的相似度 0~1（归一化后：完全相等 1；包含关系按长度加权；否则 Dice） */
  function nameSimilarity(a, b) {
    const na = normCourseName(a), nb = normCourseName(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    if (na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1) {
      const short = Math.min(na.length, nb.length), long = Math.max(na.length, nb.length);
      return 0.8 + 0.2 * (short / long);
    }
    return dice(na, nb);
  }

  /**
   * 按「课程名（+教师/校区/上课时间）」在候选课程里找最像的几个。
   * @param rows   课程列表（{id, name, raw} 或已带 teacher/campus/time）
   * @param target 目标（{label/name, teacher, campus, time, kch}）
   * @returns [{row, score, nameScore, why}] 按分数降序
   *
   * 打分：**课程名相似度为主**（权重 0.85 —— 名字完全一致就是 0.85，已达到自动采用的阈值），
   * 教师/校区/上课时间/课程代码作为加分项，用来在**同名多班**之间做取舍。
   * 教师和校区只在"能对上"时加分，不会因为目标没填而扣分。
   * （踩过的坑：权重设成 0.75 时，名字完全相同也只有 0.75 < 0.8 阈值 → 永远无法自动采用。）
   */
  function matchCoursesByName(rows, target, opts) {
    const t = target || {};
    const wantName = t.name || t.label || '';
    const wantTeacher = String(t.teacher || '');
    const wantCampus = String(t.campus || '');
    const wantTime = String(t.time || '');
    const max = (opts && opts.max) || 5;
    const out = [];
    (rows || []).forEach(function (r) {
      if (!r) return;
      const ex = rowExtras(r.raw);
      const name = r.name || ex.klass || '';
      const nameScore = nameSimilarity(wantName, name);
      let score = nameScore * 0.85;
      const why = ['名称 ' + nameScore.toFixed(2)];
      if (wantTeacher && ex.teacher) {
        if (ex.teacher === wantTeacher || ex.teacher.indexOf(wantTeacher) !== -1 || wantTeacher.indexOf(ex.teacher) !== -1) {
          score += 0.10; why.push('教师命中');
        }
      }
      if (wantCampus && ex.campus) {
        if (ex.campus === wantCampus || ex.campus.indexOf(wantCampus) !== -1) { score += 0.05; why.push('校区命中'); }
      }
      if (wantTime && ex.time) {
        if (ex.time === wantTime) { score += 0.03; why.push('时间命中'); }
      }
      if (t.kch && ex.code && String(t.kch) === String(ex.code)) { score += 0.12; why.push('课程代码命中'); }
      if (score > 0) out.push({ row: r, score: Math.min(1, score), nameScore: nameScore, why: why.join('，') });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, max);
  }

  /**
   * 决定"能不能自动改用某个候选"。
   * 规则：最高分 ≥ minScore（默认 0.8），且明显领先第二名（默认 0.08）。
   * 不够就返回 ambiguous —— 宁可让你在面板上选，也不要抢错课。
   */
  function pickBestMatch(cands, opts) {
    const minScore = (opts && opts.minScore) || 0.8;
    const minGap = (opts && opts.minGap) || 0.08;
    const list = cands || [];
    if (!list.length) return { ok: false, reason: 'no-candidate' };
    const best = list[0];
    if (best.score < minScore) return { ok: false, reason: 'low-score', best: best, candidates: list };
    const second = list[1];
    if (second && best.score - second.score < minGap) {
      return { ok: false, reason: 'ambiguous', best: best, candidates: list };
    }
    return { ok: true, best: best, candidates: list };
  }

  /**
   * 带「最大兜底」的挑选：门槛不过时，**也采用最像的那一个**。
   *
   * 用户明确要求（原话）："查找模糊课程或相似课程最大兜底加入监控"、
   * "模糊门槛可以更低一些，因为抢错了可以退课，比模糊不到更好"。
   * 代价对比很清晰：多抢一门 = 去学校页面退一次课（可逆）；
   * 匹配不到 = 这门课整轮都没参与抢（不可逆）。
   *
   * 关掉兜底（opts.allowFallback === false）就退回 pickBestMatch 的严格行为：
   * 存疑不动、留给人工决定。
   *
   * @returns {ok, best, candidates, fallback, reason}  fallback=true 表示"是兜底采用的最像的那个"
   */
  function pickWithFallback(cands, opts) {
    const o = opts || {};
    const pick = pickBestMatch(cands, { minScore: o.minScore, minGap: o.minGap });
    const list = cands || [];
    if (pick.ok) return { ok: true, best: pick.best, candidates: list, fallback: false, reason: 'confident' };
    if (o.allowFallback !== false && list.length) {
      return { ok: true, best: list[0], candidates: list, fallback: true, reason: 'fallback' };
    }
    return { ok: false, best: pick.best, candidates: list, fallback: false, reason: pick.reason };
  }

  globalThis.KXRules = {
    evalRule,
    jsonGet,
    findArray,
    findObjectMap,
    findRecord,
    parseList,
    normalizeRow,
    classify,
    toNumber,
    KIND_TEXT,
    splitParams,
    diffParamKeys,
    applyTemplate,
    applyUrlTemplate,
    guessIdParam,
    guessFields,
    withPageSize,
    rowExtras,
    normCourseName,
    nameSimilarity,
    matchCoursesByName,
    pickBestMatch,
    pickWithFallback
  };
})();
