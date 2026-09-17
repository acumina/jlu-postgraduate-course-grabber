/* ============================================================
 * lib/export.js —— 抓包记录 → HAR 1.2（共享库）
 * ------------------------------------------------------------
 * 为什么要抽成共享库：三处都要用同一套转换，转换逻辑分叉会造成
 * 「面板导出的文件」和「收集器落盘的文件」字段不一致，排查时最坑。
 *   1. content script（面板「导出抓包」按钮）
 *   2. tools/collector.mjs（本地落盘）—— Node 里用 new Function 读它
 *   3. 以后要加别的导出格式也在这里扩
 *
 * 是普通脚本，通过 globalThis.KXExport 暴露（同 KX / KXRules 的做法）。
 * 关键设计：凭据头（Cookie/Authorization/Set-Cookie）在这里统一抹掉，
 * 所以任何走这个库落盘/导出的文件都不含会话凭据。
 * ============================================================ */
(function () {
  if (globalThis.KXExport) return;

  /** 会话凭据类请求头：导出/落盘时一律抹掉（它们泄漏的后果最严重，且发包时由浏览器自动带） */
  const REDACT_HEADER_RE = /^(cookie|cookie2|set-cookie|authorization|proxy-authorization|x-auth-token)$/i;

  /** 敏感「参数名」：出现在请求体里也要抹掉。
   *  教训：只抹请求头是不够的 —— 一次登录就把 loginPwd=密码的 SHA-256 写进了日志文件。 */
  const SENSITIVE_PARAM_RE = /(loginpwd|password|passwd|^pwd$|secret|jtoken|vtoken|verifycode|verify_code|smscode|privatekey|private_key)/i;
  /** 登录类接口：整个请求体的值全部抹掉，只留键名 */
  const LOGIN_URL_RE = /(check\/login|\/login\/|login\.do|logon|signin)/i;

  function isRedacted(name) {
    return REDACT_HEADER_RE.test(String(name || '').trim());
  }
  function isSensitiveParam(name) {
    const k = String(name || '').trim();
    if (!k) return false;
    if (SENSITIVE_PARAM_RE.test(k)) return true;
    return /^(login|user)(name|id|code)?$/i.test(k);   // 学号/账号本身也是个人信息
  }

  /**
   * 抹掉请求体里的敏感值（form 与 json 都处理；登录接口整条按敏感处理）。
   * 返回 [清理后的 body, 被抹掉的键名数组]
   */
  function redactBody(url, body, contentType) {
    const raw = String(body == null ? '' : body);
    if (!raw) return [raw, []];
    const isLogin = LOGIN_URL_RE.test(String(url || ''));
    const removed = [];
    const mask = function (k, v) {
      if (isLogin || isSensitiveParam(k)) { removed.push(k); return '***'; }
      return v;
    };

    const looksJson = /json/i.test(String(contentType || '')) || /^\s*[{[]/.test(raw);
    if (looksJson) {
      try {
        const obj = JSON.parse(raw);
        (function walk(o) {
          Object.keys(o).forEach(function (k) {
            const v = o[k];
            if (v && typeof v === 'object') { walk(v); return; }
            o[k] = mask(k, v);
          });
        })(obj);
        return [JSON.stringify(obj), Array.from(new Set(removed))];
      } catch (e) { return [raw, []]; }
    }
    const out = raw.split('&').map(function (seg) {
      if (!seg) return seg;
      const i = seg.indexOf('=');
      if (i < 0) return seg;
      const k = seg.slice(0, i);
      let keyPlain = k;
      try { keyPlain = decodeURIComponent(k.replace(/\+/g, ' ')); } catch (e) { /* 原样 */ }
      return k + '=' + mask(keyPlain, seg.slice(i + 1));
    }).join('&');
    return [out, Array.from(new Set(removed))];
  }

  function objToHarHeaders(obj) {
    if (!obj || typeof obj !== 'object') return [];
    return Object.keys(obj).map(function (k) {
      return { name: k, value: String(obj[k] == null ? '' : obj[k]) };
    });
  }

  function harHeadersToObj(list) {
    const out = {};
    (list || []).forEach(function (h) {
      if (h && h.name) out[h.name] = h.value;
    });
    return out;
  }

  function queryOf(url) {
    try {
      const u = new URL(String(url));
      const out = [];
      u.searchParams.forEach(function (v, k) { out.push({ name: k, value: v }); });
      return out;
    } catch (e) { return []; }
  }

  function guessCt(body) {
    const s = String(body || '');
    if (!s) return '';
    if (/^\s*[{[]/.test(s)) return 'application/json';
    if (/^[^=&\s]+=[^&]*/.test(s)) return 'application/x-www-form-urlencoded';
    return 'text/plain';
  }

  function ctOf(headers) {
    const h = (headers || []).find(function (x) { return String(x.name).toLowerCase() === 'content-type'; });
    return h ? String(h.value).split(';')[0].trim() : '';
  }

  /**
   * 抹掉凭据头的副本。返回的对象里会多一个 _redactedHeaders 数组，
   * 让读文件的人明确知道「哪些头被故意抹掉了」，而不是以为抓包丢了。
   */
  function redactCapture(c) {
    if (!c || typeof c !== 'object') return c;
    const reqHeaders = {}, respHeaders = {}, redacted = [];
    Object.keys(c.reqHeaders || {}).forEach(function (k) {
      if (isRedacted(k)) redacted.push(k);
      else reqHeaders[k] = c.reqHeaders[k];
    });
    Object.keys(c.respHeaders || {}).forEach(function (k) {
      if (isRedacted(k)) redacted.push(k);
      else respHeaders[k] = c.respHeaders[k];
    });
    const out = Object.assign({}, c, { reqHeaders: reqHeaders, respHeaders: respHeaders });
    if (redacted.length) out._redactedHeaders = Array.from(new Set(redacted));
    // 请求体里的敏感值同样要抹：密码/验证码/登录名等（只抹头是不够的）
    const [body, bodyKeys] = redactBody(c.url, c.reqBody, c.reqHeaders && (c.reqHeaders['Content-Type'] || c.reqHeaders['content-type']));
    if (bodyKeys.length) {
      out.reqBody = body;
      out._redactedBody = bodyKeys;
    }
    return out;
  }

  /** 单条抓包记录 → HAR 1.2 entry（内部先抹凭据） */
  function captureToHarEntry(c) {
    const raw = c || {};
    const reqHeadersRaw = objToHarHeaders(raw.reqHeaders);
    const respHeadersRaw = objToHarHeaders(raw.respHeaders);
    const clean = redactCapture(raw);
    const reqHeaders = objToHarHeaders(clean.reqHeaders);
    const respHeaders = objToHarHeaders(clean.respHeaders);
    const body = String(clean.reqBody == null ? '' : clean.reqBody);
    const resp = String(raw.resp == null ? '' : raw.resp);
    const method = String(raw.method || 'GET').toUpperCase();

    const entry = {
      startedDateTime: new Date(Number(raw.ts) || Date.now()).toISOString(),
      time: Number(raw.ms) || 0,
      request: {
        method: method,
        url: String(raw.url || ''),
        httpVersion: 'HTTP/1.1',
        headers: reqHeaders,
        queryString: queryOf(raw.url),
        cookies: [],
        headersSize: -1,
        bodySize: body.length
      },
      response: {
        status: Number(raw.status) || 0,
        statusText: '',
        httpVersion: 'HTTP/1.1',
        headers: respHeaders,
        cookies: [],
        content: {
          size: resp.length,
          mimeType: String(raw.respType || ctOf(respHeadersRaw) || ''),
          text: resp
        },
        redirectURL: (raw.finalUrl && raw.finalUrl !== raw.url) ? String(raw.finalUrl) : '',
        headersSize: -1,
        bodySize: resp.length
      },
      cache: {},
      timings: { send: 0, wait: Number(raw.ms) || 0, receive: 0 }
    };
    if (body && method !== 'GET' && method !== 'HEAD') {
      entry.request.postData = { mimeType: ctOf(reqHeadersRaw) || guessCt(body), text: body };
    }
    if (clean._redactedHeaders) entry._redactedHeaders = clean._redactedHeaders;
    if (raw.kind) entry._kind = raw.kind;          // fetch / xhr
    if (raw.pageUrl) entry._pageUrl = raw.pageUrl;
    return entry;
  }

  /** 一批记录 → 标准 HAR 1.2 对象（har2config 能直接吃） */
  function toHar(entries, meta) {
    const m = meta || {};
    return {
      log: {
        version: '1.2',
        creator: { name: 'kx-grabber', version: (globalThis.KX && KX.VERSION) || '0.1.0' },
        pages: [],
        entries: (entries || []).map(captureToHarEntry),
        _meta: {
          host: m.host || '',
          pageUrl: m.pageUrl || '',
          collectedAt: new Date().toISOString(),
          count: (entries || []).length
        }
      }
    };
  }

  globalThis.KXExport = {
    REDACT_HEADER_RE,
    SENSITIVE_PARAM_RE,
    isRedacted,
    isSensitiveParam,
    redactBody,
    redactCapture,
    captureToHarEntry,
    toHar,
    objToHarHeaders,
    harHeadersToObj,
    guessCt
  };
})();
