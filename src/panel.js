/* ============================================================
 * panel.js —— 注入到页面里的悬浮面板（Shadow DOM，样式不污染页面）
 * ------------------------------------------------------------
 * 五个页签：抓包 / 目标 / 余量 / 日志 / 设置
 * 只通过 globalThis.KXApp 与引擎交互，自己不做任何网络请求。
 * ============================================================ */
(function () {
  'use strict';
  const KX = globalThis.KX;
  const R = globalThis.KXRules;
  if (!KX || !R) return;

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; }
.wrap { position: fixed; z-index: 2147483647; right: 14px; top: 14px; width: 430px;
  background: #16181d; color: #e6e8ee; border: 1px solid #2c3140; border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0,0,0,.5); font-size: 12px; overflow: hidden; }
.wrap.collapsed { width: auto; }
.hd { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #1d2027;
  border-bottom: 1px solid #2c3140; cursor: move; user-select: none; }
.hd .title { font-weight: 600; font-size: 12.5px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; flex: none; }
.dot.on { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
.dot.warn { background: #f59e0b; }
.dot.err { background: #ef4444; box-shadow: 0 0 8px #ef4444; }
.hd .st { flex: 1; color: #9aa3b2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn { background: #262b36; color: #dfe3ea; border: 1px solid #39404f; border-radius: 6px;
  padding: 3px 8px; cursor: pointer; font-size: 11.5px; }
.btn:hover { background: #313847; }
.btn.p { background: #2563eb; border-color: #2563eb; color: #fff; }
.btn.p:hover { background: #1d4ed8; }
.btn.d { background: #7f1d1d; border-color: #991b1b; color: #fff; }
.btn.g { background: #14532d; border-color: #166534; color: #dcfce7; }
.btn.sm { padding: 1px 6px; font-size: 11px; }
.tabs { display: flex; gap: 2px; padding: 6px 8px 0; background: #1a1d23; border-bottom: 1px solid #2c3140; }
.tabs .tab { padding: 5px 9px; border-radius: 6px 6px 0 0; color: #9aa3b2; cursor: pointer; font-size: 12px; }
.tabs .tab.active { background: #16181d; color: #fff; border: 1px solid #2c3140; border-bottom-color: #16181d; }
.tabs .cnt { color: #6b7280; font-size: 10.5px; }
.body { max-height: 62vh; overflow: auto; padding: 8px 10px 12px; }
.body.mini { max-height: none; }
.row { display: flex; align-items: center; gap: 6px; padding: 4px 0; }
.grow { flex: 1; min-width: 0; }
.mono { font-family: Consolas, Menlo, monospace; font-size: 11px; }
.small { font-size: 10.5px; color: #8b93a3; }
.ell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item { border: 1px solid #2c3140; border-radius: 8px; padding: 6px 8px; margin-bottom: 6px; background: #1b1e25; }
.item.sel { border-color: #2563eb; background: #1b2436; }
.item .top { display: flex; align-items: center; gap: 6px; }
.tag { font-size: 10px; padding: 1px 5px; border-radius: 4px; background: #2b3240; color: #9fb0c9; white-space: nowrap; }
.tag.post { background: #2b3a5e; color: #bcd0f7; }
.tag.get { background: #24382e; color: #a7dbc0; }
.tag.ok { background: #14532d; color: #bbf7d0; }
.tag.bad { background: #7f1d1d; color: #fecaca; }
pre { background: #101217; border: 1px solid #262b36; border-radius: 6px; padding: 6px; margin: 4px 0;
  white-space: pre-wrap; word-break: break-all; max-height: 180px; overflow: auto; font-size: 10.5px;
  font-family: Consolas, Menlo, monospace; color: #cfd6e4; }
input[type=text], input[type=number], select, textarea { background: #101217; color: #e6e8ee;
  border: 1px solid #333a49; border-radius: 5px; padding: 3px 6px; font-size: 11.5px; width: 100%; }
textarea { min-height: 54px; resize: vertical; font-family: Consolas, Menlo, monospace; }
label.ck { display: flex; align-items: center; gap: 5px; color: #c8cfdb; cursor: pointer; }
.grp { border-top: 1px solid #262b36; margin-top: 8px; padding-top: 6px; }
.grp > .gt { color: #8ab4f8; font-weight: 600; margin-bottom: 4px; }
.kv { display: grid; grid-template-columns: 132px 1fr; gap: 4px 8px; align-items: center; }
.logline { padding: 2px 0; border-bottom: 1px dashed #23272f; display: flex; gap: 6px; }
.logline .tm { color: #6b7280; flex: none; font-family: Consolas, monospace; }
.lv-ok { color: #4ade80; } .lv-err { color: #f87171; } .lv-warn { color: #fbbf24; }
.lv-sys { color: #93c5fd; } .lv-pkg { color: #c4b5fd; } .lv-info { color: #cbd5e1; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { text-align: left; padding: 3px 4px; border-bottom: 1px solid #262b36; font-size: 11px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
th { color: #8b93a3; font-weight: 500; }
/* 表格在窄面板里最容易崩：状态徽章和数字一律不许折行，多余的用省略号 */
td .tag { display: inline-block; }
.resize-hint { position: absolute; left: 0; top: 0; bottom: 0; width: 6px; cursor: ew-resize; }
.hint { color: #7c8598; font-size: 10.5px; line-height: 1.5; margin: 3px 0 6px; }
.pill { position: fixed; z-index: 2147483647; right: 14px; top: 14px; background: #16181d;
  color: #e6e8ee; border: 1px solid #2c3140; border-radius: 20px; padding: 5px 12px; cursor: pointer;
  font-size: 12px; box-shadow: 0 6px 20px rgba(0,0,0,.45); display: flex; align-items: center; gap: 6px; }
`;

  const S = {
    app: null,
    shadow: null,
    host: null,
    ui: { visible: true, tab: 'captures', collapsed: false, x: null, y: null, w: 620 },
    status: null,
    board: [],
    boardAt: 0,
    sel: new Set(),
    diff: null,
    lastHash: '',
    drag: null
  };

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** 面板宽度：默认 620（表格列多，560 会把「课程」列挤没），点标题栏按钮循环切换，也可拖左边缘自由调 */
  const WIDTH_STEPS = [620, 760, 900, 1080];
  function clampWidth(w) {
    const max = Math.max(360, Math.min(1200, (window.innerWidth || 1200) - 20));
    return Math.max(320, Math.min(max, Math.round(Number(w) || WIDTH_STEPS[0])));
  }
  const tstr = (ts) => {
    if (!ts) return '-';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  };
  const shortUrl = (u) => {
    try { const x = new URL(u); return x.pathname + (x.search ? x.search.slice(0, 40) : ''); }
    catch (e) { return String(u).slice(0, 70); }
  };

  /* ---------------- 配置读写小工具 ---------------- */
  function getPath(obj, path) {
    return String(path).split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
  }
  async function setPath(path, value) {
    if (KX.setByPath) return KX.setByPath(path, value);
    const patch = {};
    let cur = patch;
    const parts = String(path).split('.');
    parts.forEach(function (k, i) {
      if (i === parts.length - 1) cur[k] = value;
      else { cur[k] = {}; cur = cur[k]; }
    });
    return S.app.save(patch);
  }

  /* ============================================================
   * 渲染
   * ============================================================ */
  function render() {
    if (!S.shadow || !S.app) return;
    const st = S.status || S.app.status();

    /* 重建 innerHTML 会丢掉滚动位置，所以**重建之前**先抓一次当前值。
     * 真实事故：以前只在"异步刷新"路径（scheduleRender）里抓，按钮点击触发的
     * 直接 render() 用的是上一次存的旧值 → 点「详情」后面板跳回顶部。 */
    if (S.shadow.querySelector) {
      const scOld = S.shadow.querySelector('.body');
      if (scOld && typeof scOld.scrollTop === 'number') S.scrollTop = scOld.scrollTop;
    }

    if (!S.ui.visible) {
      S.shadow.innerHTML = '<div class="pill" data-act="show"><span class="dot ' + dotCls(st) + '"></span>选课助手 <span class="small">' + esc(st.statusText || '') + '</span></div>';
      return;
    }

    const cfg = S.app.config();
    const tabs = [
      ['captures', '抓包', st.captureCount],
      ['targets', '目标', (cfg.targets || []).length],
      ['board', '当前余量', (S.board || []).length],
      ['archive', '档案', ((S.archive || {}).rows || []).length],
      ['log', '日志', st.logCount],
      ['settings', '设置', '']
    ];
    const head = ''
      + '<div class="hd" data-drag="1">'
      + '<span class="dot ' + dotCls(st) + '"></span>'
      + '<span class="title">选课助手</span>'
      + '<span class="st" title="' + esc(st.statusText) + '">' + esc(st.statusText || '待机') + '</span>'
      + (st.running
        ? '<button class="btn d" data-act="stop">停止</button>'
        : '<button class="btn p" data-act="start">启动</button>')
      + '<button class="btn sm" data-act="wider" title="面板太窄？点它循环切换宽度（560 → 700 → 860 → 1040），也可以拖面板左边缘自由调整">'
      + '宽 ' + Math.round(S.ui.w || 560) + '</button>'
      + '<button class="btn sm" data-act="toggle">' + (S.ui.collapsed ? '展开' : '收起') + '</button>'
      + '</div>';

    const tabBar = '<div class="tabs">' + tabs.map(function (t) {
      return '<div class="tab ' + (S.ui.tab === t[0] ? 'active' : '') + '" data-tab="' + t[0] + '">' + t[1]
        + (t[2] !== '' && t[2] != null ? ' <span class="cnt">' + t[2] + '</span>' : '') + '</div>';
    }).join('') + '</div>';

    let body = '<div class="hint">面板打不开或样式异常？刷新页面即可重新注入。</div>';
    if (!S.ui.collapsed) {
      if (S.ui.tab === 'captures') body = viewCaptures(st);
      else if (S.ui.tab === 'targets') body = viewTargets(st, cfg);
      else if (S.ui.tab === 'board') body = viewBoard(cfg);
      else if (S.ui.tab === 'archive') body = viewArchive(cfg);
      else if (S.ui.tab === 'log') body = viewLog();
      else body = viewSettings(st, cfg);
    }

    const style = (S.ui.x != null ? 'left:' + S.ui.x + 'px;right:auto;top:' + S.ui.y + 'px;' : '')
      + (S.ui.collapsed ? '' : 'width:' + clampWidth(S.ui.w || 430) + 'px;');
    S.shadow.innerHTML = '<div class="wrap' + (S.ui.collapsed ? ' collapsed' : '') + '" style="' + style + '">'
      + head + (S.ui.collapsed ? '' : tabBar + '<div class="body">' + body + '</div>') + '</div>'
      + (S.ui.collapsed ? '' : '<div class="resize-hint"></div>');

    const sc = S.shadow.querySelector('.body');
    if (sc && S.scrollTop != null) sc.scrollTop = S.scrollTop;
  }

  function dotCls(st) {
    if (!st) return '';
    if (st.auth && st.auth.state === 'lost') return 'err';
    if (st.running) return 'on';
    if (st.status === 'halted' || st.status === 'scheduled') return 'warn';
    return '';
  }

  /* ---------------- 抓包页 ---------------- */
  function viewCaptures(st) {
    const caps = S.app.captures();
    let h = '<div class="row">'
      + '<span class="small grow">抓到 ' + caps.length + ' 条请求（默认只保留本页内存，最近 40 条会存本地）</span>'
      + '<button class="btn sm" data-act="test-query">试一次余量查询</button>'
      + '<button class="btn sm" data-act="push-now">推送</button>'
      + '<button class="btn sm" data-act="export-captures">导出HAR</button>'
      + '<button class="btn sm" data-act="clear-caps">清空</button>'
      + '</div>'
      + '<div class="hint">用法：先手工在页面上选一次课 → 这里会出现那条 POST → 点它「设为提交模板」→ 插件就知道怎么模拟发包了。'
      + '（想让我远程帮你配，就跑 <code>node tools/collector.mjs</code> 再填好设置里的收集器地址，点「推送」即可）</div>';

    if (!caps.length) {
      return h + '<div class="small">还没有抓到请求。请刷新页面后操作一次「选课」。</div>';
    }

    const sel = caps.filter(function (c) { return S.sel.has(c.id); });
    if (sel.length >= 2) {
      h += '<div class="item"><div class="top"><b>已选 ' + sel.length + ' 条</b>'
        + '<button class="btn sm" data-act="diff">对比找出变化的参数字段</button>'
        + '<button class="btn sm" data-act="sel-clear">取消选择</button></div>'
        + (S.diff ? renderDiff() : '<div class="hint">对比后会把「键相同、值不同」的参数列出来 —— 选课ID 通常就在里面。</div>')
        + '</div>';
    } else if (sel.length === 1) {
      h += '<div class="item"><div class="top"><span class="small">已选 1 条，再勾一条不同课程的同类请求就能做差分</span>'
        + '<button class="btn sm" data-act="sel-clear">取消</button></div></div>';
    }

    const list = caps.slice().reverse().slice(0, 60);
    h += list.map(function (c) {
      const isPost = String(c.method).toUpperCase() === 'POST';
      const bad = !c.status || c.status >= 400;
      return '<div class="item' + (S.sel.has(c.id) ? ' sel' : '') + '" data-cid="' + c.id + '">'
        + '<div class="top">'
        + '<input type="checkbox" data-act="sel" data-cid="' + c.id + '"' + (S.sel.has(c.id) ? ' checked' : '') + '>'
        + '<span class="tag ' + (isPost ? 'post' : 'get') + '">' + esc(c.method) + '</span>'
        + '<span class="tag ' + (bad ? 'bad' : 'ok') + '">' + (c.status || 'ERR') + '</span>'
        + '<span class="grow mono ell" title="' + esc(c.url) + '">' + esc(shortUrl(c.url)) + '</span>'
        + '<span class="small">' + tstr(c.ts) + (c.ms ? ' · ' + c.ms + 'ms' : '') + '</span>'
        + '</div>'
        + '<div class="row"><button class="btn sm p" data-act="use-submit" data-cid="' + c.id + '">设为提交模板</button>'
        + '<button class="btn sm" data-act="use-query" data-cid="' + c.id + '">设为余量查询模板</button>'
        + '<button class="btn sm" data-act="detail" data-cid="' + c.id + '">详情</button>'
        + '<button class="btn sm" data-act="curl" data-cid="' + c.id + '">复制 cURL</button>'
        + '</div>'
        + (S.detailId === c.id ? renderDetail(c) : '')
        + '</div>';
    }).join('');
    return h;
  }

  function renderDetail(c) {
    const params = R.splitParams(c.reqBody || '', headerCt(c));
    const paramRows = params.length
      ? '<table><tr><th>参数</th><th>值</th><th></th></tr>' + params.map(function (p) {
        const inUrl = String(c.url).indexOf(encodeURIComponent(p.v)) !== -1 || String(c.url).indexOf(p.v) !== -1;
        return '<tr><td class="mono">' + esc(p.k) + '</td><td class="mono ell" title="' + esc(p.v) + '">' + esc(p.v) + '</td>'
          + '<td><button class="btn sm" data-act="tpl" data-cid="' + c.id + '" data-key="' + esc(p.k) + '" data-inurl="' + (inUrl ? 1 : 0) + '" data-ph="id">→ {{id}}</button> '
          + '<button class="btn sm" data-act="tpl" data-cid="' + c.id + '" data-key="' + esc(p.k) + '" data-inurl="' + (inUrl ? 1 : 0) + '" data-ph="kch">→ {{kch}}</button></td></tr>';
      }).join('') + '</table>'
      : '<div class="small">没有可解析的请求体</div>';

    return '<div>'
      + '<div class="small">URL：<span class="mono">' + esc(c.url) + '</span></div>'
      + '<div class="small">请求头（可用）：</div><pre>' + esc(JSON.stringify(c.reqHeaders || {}, null, 1)) + '</pre>'
      + '<div class="small">请求体参数（点按钮即可替换成模板变量）：</div>' + paramRows
      + '<div class="small">原始请求体：</div><pre>' + esc(c.reqBody || '(空)') + '</pre>'
      + '<div class="small">响应 (' + esc(c.respType || '') + ')：</div><pre>' + esc((c.resp || '').slice(0, 1500) || '(空)') + '</pre>'
      + '</div>';
  }

  function headerCt(c) {
    const h = c.reqHeaders || {};
    return h['Content-Type'] || h['content-type'] || '';
  }

  function renderDiff() {
    const d = S.diff || [];
    if (!d.length) return '<div class="hint">没有找到「值不同」的参数。可能这几条请求不是同一类操作，或参数在 URL 里。</div>';
    return '<div class="small">变化的参数（打分从高到低，数字类更可能是选课ID）：</div>'
      + '<table><tr><th>参数</th><th>各条的值</th><th></th></tr>' + d.map(function (x) {
        return '<tr><td class="mono">' + esc(x.k) + (x.noise ? ' <span class="tag">时间戳/令牌?</span>' : '') + '</td>'
          + '<td class="mono small">' + esc(x.values.slice(0, 3).join(' | ')) + '</td>'
          + '<td><button class="btn sm p" data-act="apply-diff" data-key="' + esc(x.k) + '" data-ph="id">这就是选课ID → {{id}}</button></td></tr>';
      }).join('') + '</table>'
      + '<div class="hint">点上面的按钮后，会把「基准那条（勾选里最新的一条）」设为提交模板，并把该参数替换成 {{id}}，然后你在「目标」页添加要监测的 ID 即可。</div>';
  }

  /** 展开的「详情」：把这门课原始响应里的**所有**有用字段列出来。
   *  窄面板塞不下这么多列，所以做成点开看 —— 尤其「台球/篮球」这种同名十几个教学班，
   *  靠教师+校区+上课时间+备注才能确定是哪一个。 */
  function boardDetailHtml(r, ex, cfg) {
    const raw = (r.raw && typeof r.raw === 'object' && !Array.isArray(r.raw)) ? r.raw : {};
    const rows = [
      ['选课ID（提交时替换 {{id}}）', r.id],
      ['课程代码', ex.code], ['班级名称', ex.klass], ['课程名', r.name],
      ['教师', ex.teacher], ['校区', ex.campus], ['上课时间', ex.time],
      ['学分', raw.XF || raw.KCXF || ''], ['总学时', raw.KCZXS || ''],
      ['容量', raw.KXRS !== undefined ? raw.KXRS : ''], ['已选', raw.DQRS !== undefined ? raw.DQRS : ''],
      ['余量（容量 − 已选）', isFinite(r.remain) ? r.remain : '（未知）'],
      ['开课单位', raw.KCKKDWMC || raw.RWKKDWMC || ''],
      ['课程类别', raw.KCLBMC || ''], ['授课语言', raw.SKYYMC || ''],
      ['学期', raw.XNXQMC || ''], ['课程备注', raw.XKBZ || '']
    ].filter(function (x) { return x[1] !== '' && x[1] !== undefined && x[1] !== null; });
    const inList = (cfg.targets || []).some(function (t) { return String(t.id).trim() === String(r.id).trim(); });
    return '<div class="item" style="margin:4px 0 2px">'
      + '<table>' + rows.map(function (x) {
        return '<tr><td class="small" style="width:150px;color:#8b93a3">' + esc(x[0]) + '</td>'
          + '<td class="mono" style="white-space:normal;word-break:break-all">' + esc(String(x[1])) + '</td></tr>';
      }).join('') + '</table>'
      + '<div class="row">' + (inList ? '<span class="small">已在监控列表里</span>'
        : '<button class="btn sm p" data-act="add-target" data-id="' + esc(r.id) + '" data-label="' + esc(r.name || '') + '" data-kch="' + esc(ex.code || '') + '">加入监控</button>')
      + '<button class="btn sm" data-act="board-copy-id" data-id="' + esc(r.id) + '">复制选课ID</button></div>'
      + '</div>';
  }

  /** 读一个本地 JSON 文件（FileReader 是异步的，回调风格便于复用） */
  function readJsonFile(file, cb) {
    try {
      const fr = new FileReader();
      fr.onload = function () {
        try { cb(JSON.parse(String(fr.result || '')), null); }
        catch (e) { cb(null, 'JSON 解析失败：' + e.message); }
      };
      fr.onerror = function () { cb(null, '读文件失败'); };
      fr.readAsText(file);
    } catch (e) { cb(null, String((e && e.message) || e)); }
  }

  /* ---------------- 档案页（课程快照，离线可用） ----------------
   * 用途：选课还没开的时候先把目标挑好；跨年还能拿它按课程名找回目标
   * （下一年教学班代码 bjdm 会变，课程名基本不变）。 */
  function viewArchive(cfg) {
    const a = S.archive || { at: 0, rows: [] };
    const all = a.rows || [];
    const kw = String(S.archFilter || '').trim().toLowerCase();
    const norm = function (s) { return String(s == null ? '' : s).toLowerCase(); };
    const list = kw ? all.filter(function (r) {
      return (norm(r.name) + ' ' + norm(r.teacher) + ' ' + norm(r.campus) + ' ' + norm(r.code) + ' ' + norm(r.id)).indexOf(kw) !== -1;
    }) : all;
    const sel = S.archSel || new Set();
    const free = all.filter(function (r) { return isFinite(r.remain) && r.remain > 0; }).length;

    let h = '<div class="row"><span class="small grow">'
      + (a.at ? '档案时间 ' + tstr(a.at) + '，共 <b>' + all.length + ' 门</b>' : '<b>还没有档案</b>')
      + (kw ? '（筛出 ' + list.length + '）' : '') + (all.length ? '　当前有余量：' + free + ' 门' : '')
      + '</span><button class="btn sm p" data-act="arch-refresh">刷新档案（全量查询）</button></div>'
      + '<div class="hint">档案 = 本地保存的完整课程列表快照（含教师/时间/校区/容量/已选），'
      + '<b>不需要登录、不在选课期间也能看</b>。选课未开之前可以先把目标挑好；'
      + '下一年教学班代码变了，点「按课程名重新解析目标」就能用课程名把ID找回（模糊匹配，存疑的会让你选）。</div>'
      /* 语义说明（真实困惑："研究生心理成长这门课怎么没了 课表里的"）：
       * 档案抓的是【可选课程】列表，而学校系统在选上之后就不再把该课放进这个列表。 */
      + '<div class="hint"><b>注意档案的范围</b>：它抓的是学校的「<b>可选课程</b>」列表 —— '
      + '已经选上的课<b>不会</b>出现在这里面（学校系统就是这样：选上后该课就从可选列表消失）。'
      + '想确认某门课到底选上没有，看「目标」页的<b>已选课程</b>区块（那是服务器权威数据）。'
      + '所以如果你在档案里找不到刚选上的课，<b>那是正常的</b>。</div>'
      /* 「从零开始」引导：新电脑/第一次用时，直接在这里告诉你该干什么 */
      + (S.onboarding
        ? '<div class="hint" style="border-left:3px solid #2c7;padding-left:8px;margin:6px 0">'
          + '<b>① 先挑课（就是现在这一步）</b><br>'
          + '下面是<b>去年保存的课表</b>（' + all.length + ' 门）。用上面的搜索框找你要抢的课 → 勾选 → '
          + '点 <b>「加入备选清单（明年自动找回）」</b>。<br>'
          + '备选清单只记课程名（不记教学班ID，因为ID每年都变）——'
          + '明年在新电脑上装好扩展后，它会在你<b>登录并进入选课页</b>时自动匹配成今年的班级并开抢，'
          + '<b>不需要你手动操作</b>。<br>'
          + '<span class="small">（挑完点下面的「复制为配置片段」贴进项目配置文件，就能带到任何新电脑）</span>'
          + '<div class="row"><button class="btn sm" data-act="onboard-skip">不用挑课，跳过</button></div></div>'
        : '')
      + '<div class="row">'
      + '<button class="btn sm p" data-act="arch-download">导出为文件（下载）</button>'
      + '<button class="btn sm p" data-act="arch-pick">选择文件导入</button>'
      + '<button class="btn sm" data-act="arch-copy">复制到剪贴板</button>'
      + '<button class="btn sm" data-act="arch-resolve">按课程名重新解析目标</button>'
      + (all.length ? '<button class="btn sm d" data-act="arch-clear">清空档案</button>' : '')
      + '</div>'
      + '<div class="row"><input type="file" data-act="arch-file" accept=".json,application/json" style="font-size:10px"></div>'
      + '<textarea data-act="arch-json" placeholder="也可以把 JSON 直接粘到这里，再点下面的「导入档案 JSON」"></textarea>'
      + '<div class="row"><button class="btn sm" data-act="arch-import">导入档案 JSON（用上面的框）</button></div>'
      + '<div class="hint">档案存在<b>浏览器里</b>（重载插件、重启浏览器都不丢；但卸载扩展或清浏览器数据会没）。'
      + '想长期保存（比如留到明年）就点「导出为文件」，它会把 <code>kx-courses-日期.json</code> 存到你的**下载文件夹**。</div>'
      /* 项目 archives/ 目录（随扩展打包）—— 一键读取，不用每次选文件 */
      + '<div class="grp" style="margin-top:6px"><div class="gt">项目 archives/ 目录里的档案'
      + (S.bundledGeneratedAt ? '　<span class="small">索引生成于 ' + tstr(S.bundledGeneratedAt) + '</span>' : '') + '</div>'
      + (function () {
        const b = S.bundled || { files: [] };
        const remembered = (S.bundledRemembered || []).filter(function (n) {
          return !(b.files || []).some(function (f) { return f.name === n; });
        }).map(function (n) { return { name: n, fromPick: true }; });
        const files = (b.files || []).concat(remembered);
        let hh = '';
        if (S.bundledErr) {
          hh += '<div class="hint">读不到索引：' + esc(S.bundledErr)
            + '<br>在项目目录执行 <code>node tools/make-archive-index.mjs</code>，然后重载扩展。</div>';
        }
        if (!files.length) {
          hh += '<div class="hint"><b>这里还是空的。</b>两种用法任选：<br>'
            + '① <b>推荐</b>：点下面的「选择文件夹…」，选中项目的 <code>archives</code> 文件夹 —— '
            + '插件会记住里面的档案，以后这里一直列出来（<b>不用跑索引工具</b>）<br>'
            + '② 或者：拷文件进去 → 执行 <code>node tools/make-archive-index.mjs</code> → 重载扩展</div>';
        } else {
          hh += '<table><tr><th>文件</th><th style="width:52px">门数</th><th style="width:112px">档案时间</th><th style="width:52px"></th></tr>'
            + files.map(function (f) {
              return '<tr><td class="mono ell" title="' + esc(f.name) + '">' + esc(f.name)
                + (f.fromPick ? ' <span class="small">（选文件夹时记住）</span>' : '') + '</td>'
                + '<td class="small">' + (f.rows !== undefined ? f.rows : '?') + '</td>'
                + '<td class="small">' + (f.at ? tstr(f.at) : '-') + (f.terms && f.terms.length ? '<br>' + esc(f.terms.join(' ')) : '') + '</td>'
                + '<td><button class="btn sm p" data-act="arch-load-bundled" data-name="' + esc(f.name) + '">读取</button></td></tr>';
            }).join('') + '</table>';
        }
        /* 兜底：直接填文件名读取 —— 索引过期/漏文件时不用等重跑工具 */
        hh += '<div class="row"><input type="text" data-act="arch-name" placeholder="或直接填文件名，如 kx-courses-20260917-1558.json" value="' + esc(S.archName || '') + '">'
          + '<button class="btn sm" data-act="arch-load-name">读取</button></div>'
          + '<div class="row"><button class="btn sm" data-act="arch-refresh-bundled">重新扫描 archives/</button>'
          + '<button class="btn sm" data-act="arch-pick-dir">选择文件夹…（记住里面的档案）</button></div>'
          + '<div class="row"><input type="file" data-act="arch-dir" webkitdirectory directory multiple style="font-size:10px"></div>';
        if (S.dirList && S.dirList.length) {
          hh += '<div class="small">刚选的文件夹里有 ' + S.dirList.length + ' 个 JSON：</div>'
            + '<table>' + S.dirList.map(function (f) {
              return '<tr><td class="mono ell" title="' + esc(f.name) + '">' + esc(f.name) + '</td>'
                + '<td class="small">' + (f.rows !== undefined ? f.rows + ' 门' : '') + '</td>'
                + '<td><button class="btn sm" data-act="arch-load-picked" data-idx="' + f.idx + '">读取</button></td></tr>';
            }).join('') + '</table>';
        }
        return hh;
      })()
      + '</div>';

    if (!all.length) return h + '<div class="small">还没有档案。点「刷新档案（全量查询）」把当前所有课程存下来。</div>';

    h += '<div class="row"><input type="text" data-act="arch-filter" placeholder="搜索课程名 / 教师 / 校区 / 代码" value="' + esc(S.archFilter || '') + '"></div>'
      + '<div class="row"><span class="small grow">已勾选 <b>' + sel.size + '</b> 门</span>'
      + '<button class="btn sm p" data-act="arch-add-sel"' + (sel.size ? '' : ' disabled') + '>把勾选的加入监控</button>'
      + '<button class="btn sm" data-act="arch-clear-sel"' + (sel.size ? '' : ' disabled') + '>清空勾选</button>'
      + (function () {
        /* 「同名一起抢」：同名教学班（羽毛球×12、钢琴艺术赏析×3）一起加入监控，
         * 机会最大化；命中一个时引擎会自动停掉同名的其它班（autoStopSameName）。 */
        if (!sel.size) return '';
        const keys = {};
        all.filter(function (r) { return sel.has(r.id); }).forEach(function (r) {
          const k = R.normCourseName(r.name || '');
          if (k) keys[k] = 1;
        });
        let total = 0;
        all.forEach(function (r) { if (keys[R.normCourseName(r.name || '')]) total++; });
        return '<button class="btn sm p" data-act="arch-add-same-name">连同同名班一起加（共 ' + total + ' 门）</button>'
          + '<button class="btn sm p" data-act="arch-add-wishlist">加入备选清单（明年自动找回，共 ' + total + ' 门）</button>';
      })()
      + '</div>'
      + (sel.size ? '<div class="hint">同名教学班可以<b>一起抢</b>（多一个班多一次机会）。'
        + '插件默认<b>不会</b>因为"判定抢到了"就自动停掉同名其它班 —— '
        + '多抢一个只是多退一次课（可逆），而误停一个会丢掉课程（不可逆）。'
        + '抢到多余的自己去学校页面退掉即可。</div>' : '')
      + (function () {
        /* 备选清单：跨年/跨电脑带走"想选哪些课"的唯一载体。
         * 教学班 ID 每年都变，只有课程名能带过去 —— 明年在新电脑上装好扩展，
         * 插件会自动把它变成"按名字监控"的目标，进选课页后模糊匹配成真 ID 并开抢。 */
        const wl = S.wishlist || [];
        let hh = '<div class="grp" style="margin-top:6px"><div class="gt">备选清单（跨年用）'
          + '　<span class="small">共 ' + wl.length + ' 门</span></div>';
        if (!wl.length) {
          hh += '<div class="hint">把今年挑好的课<b>加入备选清单</b>：它只记课程名（不记教学班ID），'
            + '所以明年在新电脑上装好扩展后，插件会自动把这些课变成监控目标、'
            + '进选课页按课程名匹配今年的班级并开抢 —— <b>不需要你第一次手动操作</b>。</div>';
        } else {
          hh += '<table><tr><th>课程名</th><th style="width:90px">教师</th><th style="width:70px">校区</th></tr>'
            + wl.slice(0, 30).map(function (w) {
              return '<tr><td class="ell" title="' + esc(w.name || '') + '">' + esc(w.name || '') + '</td>'
                + '<td class="small">' + esc(w.teacher || '') + '</td>'
                + '<td class="small">' + esc(w.campus || '') + '</td></tr>';
            }).join('') + '</table>'
            + (wl.length > 30 ? '<div class="small">…还有 ' + (wl.length - 30) + ' 门</div>' : '')
            + '<div class="hint">明年/换电脑后：装好扩展 → 在选课页登录 → 这些课会自动变成监控目标并按名字匹配班级。'
            + '（当前已有目标时不会重复添加）</div>';
        }
        hh += '<div class="row"><button class="btn sm" data-act="wish-clear"' + (wl.length ? '' : ' disabled') + '>清空备选清单</button>'
          + '<button class="btn sm" data-act="wish-seed"' + (wl.length ? '' : ' disabled') + '>立即用它生成监控目标</button>'
          + '<button class="btn sm p" data-act="wish-copy"' + (wl.length ? '' : ' disabled') + '>复制为配置片段（贴进项目配置文件）</button></div>';
        if (wl.length) {
          hh += '<div class="hint">想让<b>新电脑/重装后</b>也自动带着这些课：点上面「复制为配置片段」，'
            + '把复制到的内容替换项目里 <code>kx-config-吉大研究生选课.json</code> 的 <code>"wishlist"</code> 字段，'
            + '然后提交/同步那个文件。新电脑上装好扩展、登录、进选课页，剩下的都自动。</div>';
        }
        hh += '</div>';
        return hh;
      })();

    h += '<table><tr>'
      + '<th style="width:24px"></th><th style="width:104px">教学班ID</th><th>课程</th>'
      + '<th style="width:78px">校区</th><th style="width:112px">教师 / 时间</th>'
      + '<th style="width:54px">当前余量</th><th style="width:92px"></th></tr>'
      + list.slice(0, 400).map(function (r) {
        const inList = (cfg.targets || []).some(function (t) { return String(t.id).trim() === String(r.id).trim(); });
        const tail = String(r.id).replace(/^.*?-/, '').replace(/-\d+$/, '');
        const rm = r.remain;
        return '<tr title="' + esc(r.id) + '">'
          + '<td><input type="checkbox" data-act="arch-sel" data-id="' + esc(r.id) + '"' + (sel.has(r.id) ? ' checked' : '') + '></td>'
          + '<td class="mono">' + esc(tail) + '</td>'
          + '<td class="ell" title="' + esc(r.klass || r.name) + '">' + esc(r.name || '-') + '</td>'
          + '<td class="ell small">' + esc(r.campus || '-') + '</td>'
          + '<td class="ell small" title="' + esc(r.teacher + ' ' + r.time) + '">' + esc(r.teacher || '-') + (r.time ? ' · ' + esc(r.time) : '') + '</td>'
          + '<td>' + (isFinite(rm) ? (rm > 0 ? '<b style="color:#4ade80">' + rm + '</b>' : rm) : '?') + '</td>'
          + '<td>' + (inList ? '<span class="small">已监控</span>'
            : '<button class="btn sm" data-act="arch-add" data-id="' + esc(r.id) + '" data-label="' + esc(r.name || '') + '" data-kch="' + esc(r.code || '') + '" data-teacher="' + esc(r.teacher || '') + '" data-campus="' + esc(r.campus || '') + '">加监控</button>')
          + '</td></tr>';
      }).join('') + '</table>';
    if (list.length > 400) h += '<div class="small">（只显示前 400 条，用筛选框缩小范围）</div>';
    return h;
  }

  /* ---------------- 目标页 ---------------- */
  function viewTargets(st, cfg) {
    const list = (st.targets || []).slice().sort(function (a, b) { return a.priority - b.priority; });
    const usesKch = /\{\{\s*kch\s*\}\}/.test(((cfg.submit || {}).body) || '');
    let h = '<div class="row"><span class="small grow">监控目标（id 就是「选课ID」，提交时会替换 {{id}}）</span>'
      + (st.running ? '<button class="btn sm d" data-act="stop">停止</button>' : '<button class="btn sm p" data-act="start">启动</button>')
      + '</div>'
      + '<textarea data-act="import" placeholder="批量导入，每行一条：选课ID,备注（课程号可留空）&#10;选课ID 就是 bjdm，例如：&#10;20261-101-A0362202001-1788509883433,刑法与刑事诉讼原理与实务&#10;20261-105-A0422105001-1783734434438,健美操&#10;&#10;不知道 ID？去「余量」页搜课程名，点「加监控」最省事。"></textarea>'
      + '<div class="row"><button class="btn sm" data-act="import-go">导入上面这些</button>'
      + '<button class="btn sm" data-act="probe">检测登录态</button>'
      + (st.auth && st.auth.state === 'lost' ? '<button class="btn sm p" data-act="open-login">打开登录页</button>' : '')
      + '<button class="btn sm" data-act="mark-login">我刚登录了</button></div>'
      + (usesKch ? '<div class="hint">提交模板里用了 <code>{{kch}}</code>：每个目标都必须填课程号，留空会发出空值导致提交失败。</div>' : '');

    /* 「待解析」目标（ID 为空，通常是备选清单变来的）：
     * 必须显眼地告诉用户"这不是坏了，是等选课页拉课表后自动匹配"。 */
    const pending = (st.targets || []).filter(function (t) { return t && t.enabled !== false && !String(t.id || '').trim(); });
    if (pending.length) {
      h += '<div class="hint" style="border-left:3px solid #2c7;padding-left:6px">'
        + '<b>' + pending.length + ' 个目标还没有教学班ID</b>（来自备选清单）——'
        + '这是<b>正常状态</b>：进入选课页、能拉到今年课表时，插件会自动按'
        + '<b>课程名+教师+校区</b>模糊匹配（相似度不够也采用最像的那个 = 最大兜底），'
        + '而且会<b>把所有够像的教学班一起加入监控</b>（例如「羽毛球」有 12 个班 → 建 12 个目标，'
        + '哪个先有名额就抢哪个），<b>不需要你手动操作</b>。'
        + '<br>想立刻试一次：点上面「启动」或到「余量」页点「查询一次(全量)」。</div>';
    }
    /* 同名组提示：解析后会有若干"同名第N个班"的目标 —— 告诉用户它们是一组、
     * 抢到其中一个之后其余的仍会继续抢（这是刻意的，不是 bug）。 */
    const groupCount = (st.targets || []).filter(function (t) { return t && t.sameNameGroup; }).length;
    if (groupCount) {
      h += '<div class="hint">其中 <b>' + groupCount + '</b> 个是「同名教学班」（按课程名匹配时一起加进来的）。'
        + '抢到其中任意一个之后，<b>其余的仍会继续抢</b> —— 这是刻意的：'
        + '漏掉就整轮错过，而多抢一门只是去学校页面退一次课。多出来的自己退掉即可。</div>';
    }

    /* 已选课程（服务器权威判据）—— 放在目标页最上面：
     * 这里是"到底选上了没有"的答案，也是退课的入口。
     * 真实教训：15:28:31 选上了「研究生心理成长」，插件只敢说"看起来成功了，请你去确认"，
     * 而抓包里早就有 loadStdCourseInfo 这个接口。 */
    const mine = S.mine || { at: 0, list: [] };
    const mineList = mine.list || [];
    if (mineList.length || (cfg.mine || {}).url) {
      h += '<div class="grp"><div class="gt">已选课程（服务器确认）'
        + (mine.at ? '　' + tstr(mine.at) : '') + '</div>';
      if (!mineList.length) {
        h += '<div class="small">还没核对过。点「检查已选课程」拉一次（这是判断"到底选上没有"的权威依据）。</div>';
      } else {
        h += '<div class="small">这个学期你已选 <b>' + mineList.length + '</b> 门'
          + '（退课请去学校页面手动退；<b>退之前先把对应目标「停」或「删」，否则插件会把它抢回来</b>）</div>'
          + '<table><tr><th>课程</th><th style="width:96px">教师</th><th style="width:60px">学分</th></tr>'
          + mineList.map(function (m) {
            return '<tr><td class="ell" title="' + esc(m.name) + '">' + esc(m.name || '-') + '</td>'
              + '<td class="ell small">' + esc(m.teacher || '-') + '</td>'
              + '<td class="small">' + esc(String((m.raw && m.raw.XF) || '-')) + '</td></tr>';
          }).join('') + '</table>';
      }
      h += '<div class="row"><button class="btn sm" data-act="check-mine">检查已选课程</button>'
        + '<span class="small grow">核对一次就知道"到底选上没有"（服务器权威判据）</span></div></div>';
    }

    // 实测速率：让用户一眼看出"配了 600 到底跑到了多少"，并说清低速率的原因
    if (st.running && st.reqPerMinute != null) {
      const n = (st.targets || []).filter(function (t) { return t.enabled; }).length || 1;
      const cap = Number(cfg.engine.maxReqPerMinute) || 0;
      const gapCap = Math.floor(60000 / (Number(cfg.engine.minGapMs) || 300));
      const each = st.reqPerMinute / n;
      const low = cap && st.reqPerMinute < cap * 0.5;
      /* 低速率的原因要分清，否则会把人带偏：
       * 「停机等重新登录」和「被限流退避」是两件完全不同的事（早先的提示只说了后者，误导过用户）。 */
      const haltedRecently = (Date.now() - (st.lastHaltAt || 0)) < 180000;
      /* 浏览器给后台标签页降频是**代码绕不过**的，而且它会把速率压到目标的几分之一。
       * 必须让用户一眼看出"不是插件慢，是浏览器在省电"（真实困惑来源）。 */
      const throttledByBrowser = st.throttledAt && (Date.now() - st.throttledAt) < 180000;
      let why = '';
      if (throttledByBrowser) {
        why = '<br>⚠ <b>浏览器正在给这个后台标签页降频</b>（Chrome 会把隐藏页面的定时器限到每分钟 1 次）'
          + '—— 实测速率因此只有目标的几分之一。'
          + '<br><b>把这个选课标签页切到前台（窗口可见、不要最小化）即可恢复。</b>'
          + '插件无法绕过这个浏览器省电策略；如果你必须挂后台，可以把设置里的 <code>engine.burstCap</code> 调大（如 120）'
          + '让它"每分钟醒一次、一次把额度发掉"，代价是变成突发（风控更容易注意到）。';
      } else if (low) {
        why = haltedRecently
          ? '<br>⚠ 实测低是因为<b>刚发生过停机</b>（多半在等你重新登录）—— 不是被限流。'
          : (st.backoffMult > 1
            ? '<br>⚠ 实测低且正在退避 ×' + st.backoffMult + '：多半是被限流/被拒，看日志里的「结果无法判定 / HTTP 429」。'
            : '<br>⚠ 实测低但没看到退避或停机：可能是标签页在后台被浏览器降频（让工作页保持可见）。');
      }
      h += '<div class="hint">实测速率：<b>' + st.reqPerMinute + '</b> 次/分钟'
        + (cap ? '（上限 ' + Math.min(cap, gapCap) + '）' : '')
        + '　每目标约 ' + each.toFixed(0) + ' 次/分钟（每 ' + (each > 0 ? (60 / each).toFixed(1) : '∞') + ' 秒轮到一次）'
        + (st.backoffMult > 1 ? '　<b>退避中 ×' + st.backoffMult + '</b>' : '')
        + why
        + '</div>';
    }

    if (st.auth && st.auth.leftMs != null) {      // 用「自动校准后」的值显示，而不是配置里的原始值 —— 否则校准了用户也看不出来
      const hardMin = ((st.auth.effectiveHardTimeoutMs || cfg.session.hardTimeoutMs || 0) / 60000);
      const basis = st.auth.loginSource === 'manual' ? '你手工校准' : '插件探测推定';
      const cal = (st.auth.lifetimeSamples && st.auth.lifetimeSamples.length)
        ? '，已实测校准 ' + st.auth.lifetimeSamples.length + ' 次（取最大值 —— 提前结束的原因很多，那些是下界）' : '，尚无实测样本';
      h += '<div class="hint">推算剩余：<b>' + Math.ceil(st.auth.leftMs / 1000) + ' 秒</b>（按 '
        + tstr(st.auth.loginAt) + ' 登录 + ' + hardMin.toFixed(1) + ' 分钟推算' + cal + '，' + basis + '）。'
        + '<b>这只是推算，实测常常活得更久</b>（已出现过活过推算值的情况）—— 它只用于提前提醒，<b>不会停机</b>；'
        + '真掉线一律由 HTTP 401 / 页面文字判定，1~2 分钟内发现。'
        + '<br><button class="btn sm" data-act="calib-reset">重置存活时长校准</button> '
        + '<button class="btn sm" data-act="mark-login">我刚登录了</button> '
        + '<button class="btn sm" data-act="warn-off">关闭推算提醒</button>'
        + '　（估算明显不准点第一个；确定刚登录过点第二个；这个提醒反复误报就点第三个）</div>';
    } else if (st.auth && st.auth.state !== 'lost') {
      h += '<div class="hint">登录时刻尚未确定，首次探测成功后开始推算。刚登录过就点「我刚登录了」可精确校准。</div>';
    }

    /* 掉线时的诊断信息：一眼看出「体检到底做过没有、结果是什么」。
     * 真实事故：面板显示"等登录"、引擎显示"抢课中"，但所有目标被静默跳过、
     * 探测又被节流吞掉 —— 用户完全看不出哪里坏了，只能干等。 */
    if (st.auth && st.auth.state === 'lost') {
      const ago = st.auth.lastProbeAt ? Math.round((Date.now() - st.auth.lastProbeAt) / 1000) : null;
      h += '<div class="hint" style="border-color:#7f1d1d"><b>当前处于「掉线」状态：引擎就算在跑也不会提交任何目标</b>'
        + '（等登录）。<br>最近体检：' + (ago == null ? '从未' : (tstr(st.auth.lastProbeAt) + '（' + ago + ' 秒前）'))
        + '　' + esc(st.auth.lastProbeText || '（无结论）')
        + '<br>掉线原因：' + esc(st.auth.why || '-')
        + '<br><button class="btn sm p" data-act="probe">立即检测登录态</button>'
        + '<button class="btn sm" data-act="open-login">打开登录页</button>'
        + (st.running ? '<button class="btn sm" data-act="stop">停止引擎</button>' : '<button class="btn sm" data-act="start">启动</button>')
        + '　（登录完成后点「立即检测登录态」即可立刻恢复提交，不用等）</div>';
    }

    if (!list.length) return h + '<div class="small">还没有目标。把选课页面上的教学班号/选课ID 粘进上面的框里。</div>';

    /* 表格列数随模板自适应：
     * · 提交模板没用 {{kch}} 就不显示「课程号」列（你这套系统就是，省 110px 给「操作」列）
     * · 「操作」列给足宽度，否则「重置」「删」会被裁掉点不到（真实事故） */
    h += '<table><tr>'
      + '<th style="width:96px">ID</th>'
      + '<th>备注</th>'
      + (usesKch ? '<th style="width:96px">课程号</th>' : '')
      + '<th style="width:88px">状态</th>'
      + '<th style="width:38px">次数</th>'
      + '<th style="width:118px">操作</th></tr>'
      + list.map(function (t) {
        const badge = stateText(t.state);
        const missKch = usesKch && !String(t.kch || '').trim();
        return '<tr>'
          + '<td class="mono" title="' + esc(t.id) + '">' + esc(String(t.id).replace(/^.*?-/, '')) + '</td>'
          + '<td class="ell" title="' + esc(t.label) + '">' + esc(t.label || '-') + '</td>'
          + (usesKch ? '<td><input type="text" style="width:86px' + (missKch ? ';border-color:#ef4444' : '') + '" data-act="t-kch" data-id="' + esc(t.id) + '" value="' + esc(t.kch || '') + '" placeholder="必填" title="对应 {{kch}}，留空会发出空值"></td>' : '')
          + '<td>' + badge + (t.remain != null ? ' <span class="small">余' + t.remain + '</span>' : '') + '</td>'
          + '<td>' + t.tryCount + (t.okCount ? ' <span class="small">✔' + t.okCount + '</span>' : '') + '</td>'
          + '<td><button class="btn sm" data-act="t-toggle" data-id="' + esc(t.id) + '" data-on="' + (t.enabled ? 0 : 1) + '" title="' + (t.enabled ? '暂停这个目标（不删除）' : '重新启用这个目标') + '">' + (t.enabled ? '停' : '启') + '</button> '
          + (t.needConfirm && cfg.engine.confirmBeforeSubmit ? '<button class="btn sm p" data-act="confirm" data-id="' + esc(t.id) + '" title="确认提交这个目标">确认</button> ' : '')
          + '<button class="btn sm" data-act="t-reset" data-id="' + esc(t.id) + '" title="清零尝试次数与状态（不删除）">重置</button> '
          + '<button class="btn sm d" data-act="t-del" data-id="' + esc(t.id) + '" title="从监控列表里删除这个目标">删</button></td>'
          + '</tr>';
      }).join('') + '</table>'
      + '<div class="hint">「停」只是暂停监控；要从列表里移除就点红色的「删」。'
      + '（注意：删除目标只影响插件的监控列表，**不会退掉你已经选上的课** —— 退课要去学校页面的「已选课程 / 退课」。）</div>';

    if (st.targets && st.targets.some(function (t) { return t.lastMsg; })) {
      h += '<div class="grp"><div class="gt">最近状态</div>' + st.targets.filter(function (t) { return t.lastMsg; }).map(function (t) {
        // 注意：stateText() 返回的是 HTML 片段，这里不能整体转义，否则会把源码显示出来
        return '<div class="small">' + esc(t.id) + '：' + stateText(t.state) + ' ' + esc(t.lastMsg || '') + '</div>';
      }).join('') + '</div>';
    }
    return h;
  }

  function stateText(s) {
    const map = {
      idle: '<span class="tag">未开始</span>',
      submitting: '<span class="tag post">提交中</span>',
      success: '<span class="tag ok">✔ 成功</span>',
      waiting: '<span class="tag">等名额</span>',
      ready: '<span class="tag ok">有名额</span>',
      notfound: '<span class="tag bad">未找到</span>',
      retry: '<span class="tag bad">重试中</span>',
      'paused-login': '<span class="tag bad">等登录</span>',
      blocked: '<span class="tag bad">已阻塞</span>',
      giveup: '<span class="tag bad">已放弃</span>',
      needconfirm: '<span class="tag post">待确认</span>'
    };
    return map[s] || '<span class="tag">' + esc(s || '未知') + '</span>';
  }

  /* ---------------- 余量页 ---------------- */
  function viewBoard(cfg) {
    /* 两份数据分开显示：人工「查询一次」= 全量（独立保存，不会被轮询覆盖）；
     * 自动轮询 = 小 pageSize 的快照（每 1.5 秒刷新）。默认优先显示全量。 */
    const fullList = S.boardFull || [];
    const pollList = S.board || [];
    const showFull = !!fullList.length && S.boardView !== 'poll';
    const all = showFull ? fullList : pollList;
    const at = showFull ? (S.boardFullAt || 0) : (S.boardAt || 0);
    const kw = String(S.boardFilter || '').trim().toLowerCase();
    const list = kw ? all.filter(function (r) {
      const ex = R.rowExtras(r.raw);
      return (String(r.name || '') + ' ' + String(r.id || '') + ' ' + ex.teacher + ' ' + ex.campus + ' ' + ex.code).toLowerCase().indexOf(kw) !== -1;
    }) : all;
    const remainFree = all.filter(function (r) { return isFinite(r.remain) && r.remain > 0; }).length;

    let h = '<div class="row"><span class="small grow">'
      + (at ? '更新于 ' + tstr(at) + '　' : '')
      + (showFull ? '<b>全量 ' + all.length + ' 门</b>' : '轮询快照 ' + all.length + ' 门')
      + (kw ? '（筛出 ' + list.length + '）' : '')
      + '　余量>0：' + remainFree + ' 门'
      + '</span><button class="btn sm" data-act="test-query">查询一次(全量)</button></div>';

    /* 盲发模式下自动轮询不查余量，但人工「查询一次(全量)」照样能用 ——
     * 这是「要选很多课」时最省事的加目标方式：搜出来 → 勾选 → 一次全加。 */
    if (!cfg.query.enabled) {
      h += '<div class="hint">当前是<b>盲发模式</b>：自动轮询不查余量（所以这里默认是空的），'
        + '但你仍然可以点上面的「查询一次(全量)」把 148 门课拉回来，用来搜课 + 批量加监控。</div>';
    }

    if (fullList.length && pollList.length) {
      h += '<div class="row"><span class="small grow">当前显示：'
        + (showFull ? '<b>全量（' + fullList.length + ' 门，' + tstr(S.boardFullAt) + '）</b>'
          : '<b>轮询快照（' + pollList.length + ' 门，' + tstr(S.boardAt) + '）</b>')
        + '</span><button class="btn sm" data-act="board-view">切到' + (showFull ? '轮询快照' : '全量') + '</button></div>';
      if (pollList.length < fullList.length) {
        h += '<div class="hint">自动轮询每轮只取 ' + pollList.length + ' 门（pageSize 较小，省流量）；'
          + '若「目标」里的课不在前 ' + pollList.length + ' 门，引擎会一直显示「未找到」——'
          + '把设置里 query.body 的 pageSize 调大到 ' + fullList.length + ' 就能覆盖全部。</div>';
      }
    }

    h += '<div class="row"><input type="text" data-act="board-filter" placeholder="输入课程名 / 教师 / 校区 / 代码 筛选（例如：羽毛球、胡光霞、A0422）" value="' + esc(S.boardFilter || '') + '"></div>';

    // 勾选批量加监控（要选很多课时最省事）
    const sel = S.boardSel || new Set();
    const selCount = sel.size;
    h += '<div class="row"><span class="small grow">已勾选 <b>' + selCount + '</b> 门（可跨筛选保留）</span>'
      + '<button class="btn sm p" data-act="board-add-sel"' + (selCount ? '' : ' disabled') + '>把勾选的加入监控</button>'
      + '<button class="btn sm" data-act="board-clear-sel"' + (selCount ? '' : ' disabled') + '>清空勾选</button></div>';

    if (!list.length) return h + '<div class="small">' + (kw ? '没有匹配「' + esc(kw) + '」的课程。' : '暂无余量数据。点「查询一次(全量)」试试。') + '</div>';
    /* 列宽预算要算清楚：面板窄时，如果各列写死的宽度加起来超过可用宽度，
     * 「课程」这个自适应列会被压成 0 宽度、字全部消失（真实事故）。
     * 现在的固定宽度合计 ≈ 456px，默认面板 620px，留给「课程」约 140px。 */
    h += '<table><tr>'
      + '<th style="width:24px"></th>'
      + '<th style="width:104px">教学班ID</th>'
      + '<th>课程</th>'
      + '<th style="width:78px">校区</th>'
      + '<th style="width:118px">教师 / 时间</th>'
      + '<th style="width:38px">余量</th>'
      + '<th style="width:96px"></th></tr>'
      + list.slice(0, 300).map(function (r) {
        const inList = (cfg.targets || []).some(function (t) { return String(t.id).trim() === String(r.id).trim(); });
        const ex = R.rowExtras(r.raw);
        const tail = String(r.id).replace(/^.*?-/, '').replace(/-\d+$/, '');
        const open = S.expandBoardId === r.id;
        const checked = sel.has(r.id);
        return '<tr title="' + esc(r.id) + '">'
          + '<td><input type="checkbox" data-act="board-sel" data-id="' + esc(r.id) + '"' + (checked ? ' checked' : '') + '></td>'
          + '<td class="mono">' + esc(tail) + '</td>'
          + '<td class="ell" title="' + esc(ex.klass || r.name || '') + '">' + esc(r.name || '-') + '</td>'
          + '<td class="ell small">' + esc(ex.campus || '-') + '</td>'
          + '<td class="ell small" title="' + esc(ex.teacher + ' ' + ex.time) + '">' + esc(ex.teacher || '-') + (ex.time ? ' · ' + esc(ex.time) : '') + '</td>'
          + '<td>' + (isFinite(r.remain) ? (r.remain > 0 ? '<b style="color:#4ade80">' + r.remain + '</b>' : r.remain) : '?') + '</td>'
          + '<td><button class="btn sm" data-act="board-more" data-id="' + esc(r.id) + '">' + (open ? '收起' : '详情') + '</button>'
          + (inList ? ' <span class="small">已监控</span>'
            : ' <button class="btn sm" data-act="add-target" data-id="' + esc(r.id) + '" data-label="' + esc(r.name || '') + '" data-kch="' + esc(ex.code || '') + '">加监控</button>')
          + '</td></tr>'
          + (open ? '<tr><td colspan="7" style="white-space:normal">' + boardDetailHtml(r, ex, cfg) + '</td></tr>' : '');
      }).join('') + '</table>';
    if (list.length > 200) h += '<div class="small">（只显示前 200 条，用上面的筛选框缩小范围）</div>';
    return h;
  }

  /* ---------------- 日志页 ---------------- */
  function viewLog() {
    const all = S.app.logs();
    const logs = all.slice(-200).reverse();
    const total = all.reduce(function (n, l) { return n + (l.count || 1); }, 0);
    const merged = all.filter(function (l) { return (l.count || 1) > 1; }).length;
    return '<div class="row"><span class="small grow">显示最近 ' + logs.length + ' 条（原始事件 ' + total + ' 个，'
      + (merged ? '其中 ' + merged + ' 条是合并的重复项，显示为 ×次数' : '无合并') + '）</span>'
      + '<button class="btn sm" data-act="clear-log">清空</button></div>'
      + logs.map(function (l) {
        const n = l.count || 1;
        return '<div class="logline"><span class="tm">' + tstr(l.t) + '</span>'
          + (n > 1 ? '<span class="tag" title="同一目标的连续 ' + n + ' 次相同事件已合并显示">×' + n + '</span>' : '')
          + '<span class="lv-' + esc(l.level) + '">' + esc(l.msg) + '</span></div>'
          + (l.extra ? '<pre>' + esc(l.extra) + '</pre>' : '');
      }).join('');
  }

  /* ---------------- 设置页 ---------------- */
  const RULE_KEYS = [
    ['success', '成功'], ['full', '已满'], ['dup', '已选过'],
    ['captcha', '验证码'], ['logout', '掉登录'], ['closed', '未开放']
  ];

  /* 速率预设：一次改齐三个互相制约的参数（用户只改一个时会以为插件坏了）。
   * 实际速率 = min(每分钟上限, 60000÷发包最小间隔)；每个目标的频率 = 实际速率 ÷ 启用目标数。 */
  const RATE_PRESETS = [
    { name: '慢', gap: 1000, cap: 60, int: 1000 },
    { name: '中', gap: 500, cap: 120, int: 600 },
    { name: '快', gap: 150, cap: 400, int: 300 },
    { name: '极速', gap: 100, cap: 800, int: 250 }
  ];

  function viewSettings(st, cfg) {
    const e = cfg.engine, q = cfg.query, s = cfg.submit, se = cfg.session || {};
    const deb = cfg.debug || {};
    const ruleSel = function (type) {
      return ['regex', 'contains', 'notContains', 'status', 'always', 'never'].map(function (t) {
        return '<option value="' + t + '"' + (type === t ? ' selected' : '') + '>' + t + '</option>';
      }).join('');
    };

    return ''
      + '<div class="grp"><div class="gt">引擎</div><div class="kv">'
      + '<label>轮询间隔(ms)</label><input type="number" data-path="engine.intervalMs" value="' + esc(e.intervalMs) + '">'
      + '<label>抖动(%)</label><input type="number" data-path="engine.jitterPct" value="' + esc(e.jitterPct) + '">'
      + '<label>每轮最多提交</label><input type="number" data-path="engine.maxConcurrent" value="' + esc(e.maxConcurrent) + '">'
      + '<label>发包最小间隔(ms)</label><input type="number" data-path="engine.minGapMs" value="' + esc(e.minGapMs) + '">'
      + '<label>每分钟请求上限</label><input type="number" data-path="engine.maxReqPerMinute" value="' + esc(e.maxReqPerMinute) + '">'
      + '<label>单目标最大次数</label><input type="number" data-path="engine.maxAttemptsPerTarget" value="' + esc(e.maxAttemptsPerTarget) + '">'
      + '<label>定时开抢 HH:MM:SS</label><input type="text" data-path="engine.scheduleAt" value="' + esc(e.scheduleAt) + '" placeholder="留空=立即启动">'
      + '</div>'
      + '<div class="row"><label class="ck"><input type="checkbox" data-path="engine.submitOnHit" data-type="bool"' + (e.submitOnHit !== false ? ' checked' : '') + '>命中名额后自动提交（不勾=只监控提醒）</label></div>'
      + '<div class="row"><label class="ck"><input type="checkbox" data-path="engine.confirmBeforeSubmit" data-type="bool"' + (e.confirmBeforeSubmit ? ' checked' : '') + '>提交前需要我手动确认</label></div>'
      + '<div class="row"><label class="ck"><input type="checkbox" data-path="engine.stopOn.captcha" data-type="bool"' + ((e.stopOn || {}).captcha !== false ? ' checked' : '') + '>出现验证码自动停机</label></div>'
      + '<div class="row"><label class="ck"><input type="checkbox" data-path="engine.stopOn.logout" data-type="bool"' + ((e.stopOn || {}).logout !== false ? ' checked' : '') + '>掉登录自动停机</label></div>'
      + '<div class="row"><label class="ck"><input type="checkbox" data-path="engine.stopOn.closed" data-type="bool"' + ((e.stopOn || {}).closed !== false ? ' checked' : '') + '>提示不在选课时间时停机</label></div>'
      + (function () {
        // 速率预设：一次改齐三个参数，并把"每个目标多久轮一次"算出来
        const nT = (cfg.targets || []).filter(function (t) { return t.enabled !== false; }).length || 1;
        return '<div class="hint">速率预设 —— 点一下同时改「轮询间隔 / 最小间隔 / 每分钟上限」三个数。'
          + '实际速率 = min(每分钟上限, 60000÷最小间隔)，<b>每个目标的频率 = 实际速率 ÷ 目标数（现在 ' + nT + ' 个）</b>：</div>'
          + '<div class="row">' + RATE_PRESETS.map(function (p) {
            const eff = Math.min(p.cap, Math.floor(60000 / p.gap));
            const each = eff / nT;
            const active = Number(e.minGapMs) === p.gap && Number(e.maxReqPerMinute) === p.cap;
            return '<button class="btn sm' + (active ? ' p' : '') + '" data-act="rate-preset" data-gap="' + p.gap + '" data-cap="' + p.cap + '" data-int="' + p.int + '"'
              + ' title="每分钟上限 ' + p.cap + '、最小间隔 ' + p.gap + 'ms、轮询间隔 ' + p.int + 'ms">'
              + p.name + ' ' + eff + '/分' + (nT > 1 ? '（每目标 ' + each.toFixed(0) + '/分 ≈ ' + (60 / each).toFixed(1) + ' 秒）' : '') + '</button>';
          }).join('') + '</div>'
          + '<div class="hint">想真正更快，只有三条路：① 点「极速」（上限 600/分，受最小间隔 100ms 限制）'
          + '② <b>减少目标数</b>（每少一个，其它每轮快 ' + (nT > 1 ? Math.round(100 / nT) : 0) + '% 左右）'
          + '③ 改成「先查余量再抢」—— 每轮只用 1 次请求就能覆盖全部课程（目标多时它更划算）。</div>';
      })()
      + '</div>'

      + '<div class="grp"><div class="gt">会话 / 20 分钟硬超时</div>'
      + '<div class="hint">硬超时下心跳保活没有作用，所以默认关闭；掉线后插件会停机并持续探测，你重新登录成功就自动继续。</div><div class="kv">'
      + '<label>硬超时(分钟)</label><input type="number" data-path="session.hardTimeoutMs" data-div="60000" value="' + esc(Math.round((se.hardTimeoutMs || 0) / 60000)) + '">'
      + '<label>提前提醒(分钟)</label><input type="number" data-path="session.warnBeforeMs" data-div="60000" value="' + esc(Math.round((se.warnBeforeMs || 0) / 60000)) + '">'
      + '<label>体检间隔(秒)</label><input type="number" data-path="session.probeEveryMs" data-div="1000" value="' + esc(Math.round((se.probeEveryMs || 0) / 1000)) + '">'
      + '<label>掉线重试(秒)</label><input type="number" data-path="session.recheckMs" data-div="1000" value="' + esc(Math.round((se.recheckMs || 0) / 1000)) + '">'
      + '<label>登录页地址</label><input type="text" data-path="session.loginUrl" value="' + esc(se.loginUrl || '') + '" placeholder="检测到跳转后会自动记住">'
      + '</div>'
      + '<div class="row"><label class="ck"><input type="checkbox" data-path="session.autoResume" data-type="bool"' + (se.autoResume !== false ? ' checked' : '') + '>重新登录后自动继续抢</label></div>'
      + '<div class="row"><label class="ck"><input type="checkbox" data-path="session.requireLoginBeforeSubmit" data-type="bool"' + (se.requireLoginBeforeSubmit !== false ? ' checked' : '') + '>登录态失效时不再提交</label></div>'
      + '<div class="row"><label class="ck"><input type="checkbox" data-path="session.keepAlive.enabled" data-type="bool"' + ((se.keepAlive || {}).enabled ? ' checked' : '') + '>心跳保活（仅当实测是「空闲超时」时才需要）</label></div>'
      + '<div class="row"><button class="btn sm p" data-act="keepalive-trial" data-kind="page">试验①：每90秒访问一次选课首页</button>'
      + '<button class="btn sm p" data-act="keepalive-trial" data-kind="api">试验②：每90秒调轻量接口</button>'
      + '<button class="btn sm" data-act="keepalive-stop">停止试验</button></div>'
      + '<div class="hint">「约 10 分钟自动掉线」目前只能靠手动重登。但有两个**没被排除**的可能性，15 分钟就能证伪：'
      + '<br>· <b>试验①</b>：会话 TTL 也许只被「页面请求」刷新、而 API 请求不刷新 → 每 90 秒 fetch 一次选课首页 HTML'
      + '<br>· <b>试验②</b>：某些权限校验接口也许能刷新 TTL → 每 90 秒调一次 <code>loadXspyjhkxztInfo.do</code>（仅 221 字节）'
      + '<br><b>判据</b>：日志出现 <code>★ 保活看起来有效：本次会话已存活 X 分钟，超过了此前的记录…</code> → 成功，'
      + '<b>以后不用再手动登录</b>；若仍在约 10 分钟准时掉线 → 是绝对超时，只能走"自动开登录页 + 你输 4 位验证码"。</div>'
      + '<div class="hint">当前保活地址：<code>' + esc((se.keepAlive || {}).url || '（空）') + '</code>'
      + '　间隔：' + Math.round(((se.keepAlive || {}).intervalMs || 240000) / 1000) + ' 秒</div>'
      + '</div>'

      + '<div class="grp"><div class="gt">提交模板</div><div class="kv">'
      + '<label>URL</label><input type="text" data-path="submit.url" value="' + esc(s.url) + '">'
      + '<label>Method</label><input type="text" data-path="submit.method" value="' + esc(s.method) + '">'
      + '<label>Content-Type</label><select data-path="submit.contentType">' + ['form', 'json', 'raw'].map(function (t) {
        return '<option value="' + t + '"' + (s.contentType === t ? ' selected' : '') + '>' + t + '</option>';
      }).join('') + '</select>'
      + '</div>'
      + '<div class="small">请求体（用 {{id}} 表示选课ID，可加 {{kch}} 等自定义变量）</div>'
      + '<textarea data-path="submit.body">' + esc(s.body) + '</textarea>'
      + '<div class="small">额外请求头（JSON）</div>'
      + '<textarea data-path="submit.headers" data-type="json">' + esc(JSON.stringify(s.headers || {}, null, 1)) + '</textarea>'
      + '<div class="small">模板变量（JSON，例如 {"xnm":"2024","xqm":"12"}）</div>'
      + '<textarea data-path="submit.vars" data-type="json">' + esc(JSON.stringify(s.vars || {}, null, 1)) + '</textarea>'
      + '<div class="row"><button class="btn sm" data-act="probe-values">探测页面 token</button>'
      + '<button class="btn sm" data-act="ui-click-test">试一次点击选课</button>'
      + '<button class="btn sm" data-act="test-submit">对第一个目标试提交一次</button></div>'
      + '<div class="hint">「探测页面 token」会把页面里所有像 token 的东西列到「日志」页：'
      + 'cookie / window 变量 / localStorage / sessionStorage / meta。'
      + '<br>「试一次点击选课」= 让**页面自己**点「选课 → 确定」（token 由页面自己带，也会顺便被插件学到），'
      + '并报告每一步耗时 —— 这是验证 UI 点击模式能不能用的按钮，不消耗你自己的操作。</div>'
      + '</div>'

      + '<div class="grp"><div class="gt">UI 点击模式（混合）</div>'
      + '<div class="hint">这个系统的 csrfToken 每次页面加载都换、又无法从外部读到，所以纯 API 发包在重新登录后必然失效。'
      + '<br><b>hybrid（推荐）</b>：平时用最快的 API 盲发；一旦取不到 token，就让页面自己点一次「选课 → 确定」把 token 喂给插件 —— '
      + '那一次点击本身就是一次真实抢课尝试，不浪费。'
      + '<br><b>only</b>：每次提交都走点击（慢 50~150ms，但最像真人）。<b>off</b>：关闭，缺 token 就跳过提交。</div>'
      + '<div class="kv"><label>模式</label><select data-path="ui.mode">'
      + ['hybrid', 'only', 'off'].map(function (m) {
        return '<option value="' + m + '"' + ((cfg.ui || {}).mode === m ? ' selected' : '') + '>' + m + '</option>';
      }).join('') + '</select>'
      + '<label>按钮文字</label><input type="text" data-path="ui.selectText" value="' + esc((cfg.ui || {}).selectText || '选课') + '">'
      + '<label>确认按钮</label><input type="text" data-path="ui.confirmText" value="' + esc((cfg.ui || {}).confirmText || '确定') + '">'
      + '</div>'
      + '<div class="row"><label class="ck"><input type="checkbox" data-path="ui.enabled" data-type="bool"' + ((cfg.ui || {}).enabled !== false ? ' checked' : '') + '>启用 UI 点击</label></div>'
      + '</div>'

      + '<div class="grp"><div class="gt">判定规则</div><div class="kv">'
      + RULE_KEYS.map(function (rk) {
        const r = (s.rules || {})[rk[0]] || {};
        return '<label>' + rk[1] + '</label><div class="row" style="gap:4px">'
          + '<select data-path="submit.rules.' + rk[0] + '.type" style="width:112px">' + ruleSel(r.type || 'regex') + '</select>'
          + '<input type="text" data-path="submit.rules.' + rk[0] + '.value" value="' + esc(r.value || '') + '">'
          + '</div>';
      }).join('')
      + '</div><div class="hint">优先顺序：验证码 → 掉登录 → 未开放 → 成功 → 已选过 → 已满。命中前三个会按上面的开关停机。</div></div>'

      + '<div class="grp"><div class="gt">余量查询</div>'
      + '<div class="row"><label class="ck"><input type="checkbox" data-path="query.enabled" data-type="bool"' + (q.enabled ? ' checked' : '') + '>启用「先查余量再抢」</label></div><div class="kv">'
      + '<label>URL</label><input type="text" data-path="query.url" value="' + esc(q.url) + '">'
      + '<label>Method</label><input type="text" data-path="query.method" value="' + esc(q.method) + '">'
      + '<label>Content-Type</label><select data-path="query.contentType">' + ['form', 'json', 'raw'].map(function (t) {
        return '<option value="' + t + '"' + (q.contentType === t ? ' selected' : '') + '>' + t + '</option>';
      }).join('') + '</select>'
      + '<label>parse.type</label><select data-path="query.parse.type">' + ['json', 'regex', 'none'].map(function (t) {
        return '<option value="' + t + '"' + ((q.parse || {}).type === t ? ' selected' : '') + '>' + t + '</option>';
      }).join('') + '</select>'
      + '<label>parse.path</label><input type="text" data-path="query.parse.path" value="' + esc((q.parse || {}).path || '') + '" placeholder="如 data.list，留空自动找数组">'
      + '<label>id 字段</label><input type="text" data-path="query.parse.idField" value="' + esc((q.parse || {}).idField || '') + '">'
      + '<label>余量字段</label><input type="text" data-path="query.parse.remainField" value="' + esc((q.parse || {}).remainField || '') + '">'
      + '<label>名称字段</label><input type="text" data-path="query.parse.nameField" value="' + esc((q.parse || {}).nameField || '') + '">'
      + '<label>parse.regex</label><input type="text" data-path="query.parse.regex" value="' + esc((q.parse || {}).regex || '') + '" placeholder="(?<id>\\d+)[^\\d]+(?<remain>\\d+)">'
      + '</div>'
      + '<div class="small">查询体</div><textarea data-path="query.body">' + esc(q.body) + '</textarea>'
      + '<div class="small">查询头（JSON）</div><textarea data-path="query.headers" data-type="json">' + esc(JSON.stringify(q.headers || {}, null, 1)) + '</textarea>'
      + '</div>'

      + '<div class="grp"><div class="gt">通知</div>'
      + '<div class="row"><label class="ck"><input type="checkbox" data-path="notify.desktop" data-type="bool"' + (cfg.notify.desktop !== false ? ' checked' : '') + '>桌面通知</label>'
      + '<label class="ck"><input type="checkbox" data-path="notify.sound" data-type="bool"' + (cfg.notify.sound !== false ? ' checked' : '') + '>提示音</label></div>'
      + '<div class="kv"><label>Webhook</label><input type="text" data-path="notify.webhook" value="' + esc(cfg.notify.webhook || '') + '" placeholder="可选：企业微信/钉钉机器人地址"></div>'
      + '</div>'

      + '<div class="grp"><div class="gt">生效站点（每行一个主机名）</div>'
      + '<textarea data-path="sites" data-type="lines">' + esc((cfg.sites || []).join('\n')) + '</textarea>'
      + '<div class="hint">只有这些站点上的页面才会注入面板和引擎。改完要刷新页面。</div>'
      + '</div>'

      + '<div class="grp"><div class="gt">本地抓包落盘（做适配时用，可选）</div>'
      + '<div class="hint">先在项目目录跑 <code>node tools/collector.mjs</code>，再把下面地址填上并勾选自动推送：抓到的请求会直接写成 '
      + '<code>logs/kx-captures.har</code> 与 <code>.jsonl</code>，之后跑 '
      + '<code>node tools/har2config.mjs logs/kx-captures.har --host 你的域名 --out kx-config.json</code> 就能自动生成配置。'
      + '<br>推送前会自动抹掉 Cookie/Authorization；只允许本机 127.0.0.1 地址，防抓包外泄。</div>'
      + '<div class="kv"><label>收集器地址</label><input type="text" data-path="debug.collectorUrl" value="' + esc(deb.collectorUrl || '') + '" placeholder="http://127.0.0.1:8790/kx/captures"></div>'
      + '<div class="row"><label class="ck"><input type="checkbox" data-path="debug.autoPush" data-type="bool"' + (deb.autoPush ? ' checked' : '') + '>自动推送抓包</label>'
      + '<label class="ck"><input type="checkbox" data-path="debug.pushLogs" data-type="bool"' + (deb.pushLogs !== false ? ' checked' : '') + '>连运行日志一起推</label></div>'
      + '<div class="row"><button class="btn sm" data-act="ping-collector">测试连接</button>'
      + '<button class="btn sm" data-act="push-now">立即推送</button>'
      + '<button class="btn sm" data-act="export-captures">导出抓包 HAR</button></div>'
      + (st.push && st.push.at
        ? '<div class="small">上次推送：' + tstr(st.push.at) + '　' + (st.push.ok ? '✔ 成功 ' + st.push.entries + ' 条 / 日志 ' + st.push.logs + ' 条' : '✖ 失败 ' + esc(st.push.error || ''))
        + (st.pendingPush ? '　待推送 ' + st.pendingPush + ' 条' : '') + (st.pushMuted ? '　<b>自动推送已暂停</b>' : '') + '</div>'
        : '<div class="small">还没有推送过。地址留空 = 不启用（不影响抓包与抢课）。</div>')
      + '</div>'

      + '<div class="grp"><div class="gt">配置导入 / 导出</div>'
      + (function () {
        /* 自动配置：启动时读项目里的配置文件，内容变了就自动应用（保留你的目标与调速）。
         * 用户问过"这个配置json能自动配置吗" —— 这就是答案，这里显示状态并允许手动重应用。 */
        const c = S.configSource || {};
        return '<div class="hint">配置来源：<b>项目里的配置文件</b> <code>' + esc(c.file || 'kx-config-*.json') + '</code>'
          + (c.appliedAt ? '　已于 ' + tstr(c.appliedAt) + ' 自动应用' : '　（还没应用过）')
          + '<br>改了配置文件只要<b>重载扩展</b>就会自动生效，不用再手动导入。'
          + '自动应用会保留你的<b>目标列表</b>、面板上调的<b>速率/开关</b>、通知与收集器偏好。</div>'
          + '<div class="row"><button class="btn sm" data-act="cfg-reapply">重新应用项目配置</button></div>';
      })()
      + (function () {
        /* 全新环境的第一道坎：默认白名单是空的，面板在学校网站上根本不会出现，
         * 所以"先载入内置预设"是安装即用的关键一步。已经配过就不再啰嗦。 */
        const needSetup = !(cfg.sites || []).length || !(cfg.submit || {}).url;
        const presets = Object.keys((globalThis.KXPresets) || {});
        if (!presets.length) return '';
        const names = { 'jlu-yxk': '吉大研究生选课', 'jlu-yjsxk': '吉林大学研究生选课' };
        return '<div class="hint">' + (needSetup
          ? '<b>看起来还没配置</b>（生效站点是空的，面板不会在选课网站上出现）。点下面的内置预设一键配好：'
          : '换了环境或想回到已知可用的配置，可以载入内置预设（会覆盖当前配置）：')
          + '</div>'
          + '<div class="row">' + presets.map(function (k) {
            return '<button class="btn sm' + (needSetup ? ' p' : '') + '" data-act="load-preset" data-key="' + esc(k) + '">'
              + '载入内置预设：' + esc(names[k] || k) + '</button>';
          }).join('') + '</div>';
      })()
      + '<div class="row"><button class="btn sm" data-act="export">导出 JSON</button>'
      + '<button class="btn sm" data-act="import-config">从下面的框导入</button></div>'
      + '<textarea data-act="config-json" placeholder="把导出的 JSON 粘到这里再点导入"></textarea>'
      + '<div class="row"><button class="btn sm d" data-act="reset-config">恢复默认配置</button></div>'
      + '</div>';
  }

  /* ============================================================
   * 事件
   * ============================================================ */
  function onAction(act, el) {
    const app = S.app;
    const cid = el.dataset.cid;
    const cap = cid ? app.captureById(cid) : null;

    switch (act) {
      case 'start':
        app.start('面板').then(function (r) {
          if (r && r.ok === false) alert('启动失败：' + r.error);
        });
        break;
      case 'stop': app.stop('面板'); break;
      case 'toggle':
        S.ui.collapsed = !S.ui.collapsed;
        render();
        break;
      case 'wider': {
        const cur = clampWidth(S.ui.w || 430);
        const i = WIDTH_STEPS.indexOf(cur);
        S.ui.w = WIDTH_STEPS[(i + 1) % WIDTH_STEPS.length] === undefined ? WIDTH_STEPS[0] : WIDTH_STEPS[(i + 1) % WIDTH_STEPS.length];
        persistUi();
        render();
        break;
      }
      case 'show':
        S.ui.visible = true;
        persistUi();
        render();
        break;
      case 'detail':
        S.detailId = S.detailId === cid ? null : cid;
        render();
        break;
      case 'sel': {
        if (S.sel.has(cid)) S.sel.delete(cid); else S.sel.add(cid);
        S.diff = null;
        render();
        break;
      }
      case 'sel-clear': S.sel.clear(); S.diff = null; render(); break;
      case 'diff': {
        const entries = app.captures().filter(function (c) { return S.sel.has(c.id); })
          .map(function (c) { return { body: c.reqBody || '', contentType: headerCt(c) }; });
        S.diff = R.diffParamKeys(entries);
        render();
        break;
      }
      case 'use-submit': {
        // 防呆：把「查询类」接口设成提交模板是真实踩过两次的坑（loadXspyjhkxztInfo.do），
        // 只写一行日志拦不住，这里直接弹窗确认。
        const u = (cap && cap.url) || '';
        const looksQuery = /(load|query|get|list|search|info|detail|option|tree|dropdown|view)/i.test(u);
        const looksSubmit = /(submit|save|select|add|xkgo|choose|apply|enroll|confirm|operate|baoming|choice)/i.test(u);
        const isGet = String((cap && cap.method) || '').toUpperCase() === 'GET';
        if ((looksQuery && !looksSubmit) || isGet) {
          const why = [];
          if (looksQuery && !looksSubmit) why.push('接口名像「查询类」（含 load/query/get/list/info 等词）');
          if (isGet) why.push('它是 GET 请求（真正的选课提交几乎都是 POST）');
          if (!confirm('⚠ 这条请求看起来不是提交接口：\n\n· ' + why.join('\n· ') + '\n\n' + u + '\n\n'
            + '真正的提交接口是你在页面上点「选课」→ 弹框点「确定」那一刻发出的那条 **POST**，'
            + '它的响应里会写着「容量已满」或「选课成功」。\n\n'
            + '确定仍要把它设为提交模板吗？（选「取消」我把正确的 POST 指给你）')) break;
        }
        app.applyCapture(cap, 'submit').then(function () { S.ui.tab = 'targets'; persistUi(); render(); });
        break;
      }
      case 'use-query':
        app.applyCapture(cap, 'query').then(function () { S.ui.tab = 'board'; persistUi(); render(); });
        break;
      case 'tpl':
        app.applyCapture(cap, 'submit', [{ key: el.dataset.key, placeholder: el.dataset.ph, inUrl: el.dataset.inurl === '1' }])
          .then(function () { render(); });
        break;
      case 'apply-diff': {
        const baseId = Array.from(S.sel).pop();
        const base = app.captureById(baseId);
        app.applyCapture(base, 'submit', [{ key: el.dataset.key, placeholder: 'id', inUrl: false }])
          .then(function () {
            S.sel.clear(); S.diff = null; S.ui.tab = 'targets'; persistUi(); render();
          });
        break;
      }
      case 'curl': {
        const h = Object.keys(cap.reqHeaders || {}).map(function (k) { return "-H '" + k + ': ' + cap.reqHeaders[k] + "'"; }).join(' ');
        const b = cap.reqBody ? " --data-raw '" + cap.reqBody.replace(/'/g, "'\\''") + "'" : '';
        copy("curl -X " + cap.method + " '" + cap.url + "' " + h + b);
        break;
      }
      case 'clear-caps': app.clearCaptures().then(render); S.sel.clear(); S.diff = null; break;
      case 'clear-log': app.clearLog(); render(); break;
      case 'test-query':
        app.testQuery().then(function (r) {
          if (r && r.ok) alert('查询成功，解析到 ' + r.list.length + ' 条记录');
          else alert('查询失败：' + ((r && r.error) || '未知'));
          render();
        });
        break;
      case 'probe-values':
        app.probePageValues().then(function (snap) {
          if (!snap) { alert('探测失败：页面没有响应，刷新页面再试'); return; }
          const g = Object.keys(snap.globals || {});
          const ls = Object.keys((snap.storage || {}).local || {});
          const ss = Object.keys((snap.storage || {}).session || {});
          const ck = String(snap.cookies || '').split(';').map(function (s) { return s.split('=')[0].trim(); }).filter(Boolean);
          alert('页面里像 token 的东西：\n\n'
            + '全局变量：' + (g.join(', ') || '（无）') + '\n'
            + 'cookie：' + (ck.join(', ') || '（无）') + '\n'
            + 'localStorage：' + (ls.join(', ') || '（无）') + '\n'
            + 'sessionStorage：' + (ss.join(', ') || '（无）') + '\n\n'
            + '完整值已写进「日志」页（会一起推给本地收集器）。把日志推给我，我来配 submit.pageVars。');
          render();
        });
        break;
      case 'ui-click-test': {
        const t = (app.config().targets || [])[0];
        if (!t) { alert('先在「目标」页加一个 ID'); break; }
        if (!confirm('会用你页面上真实的「选课」按钮点一次：\n\n目标：' + (t.label || t.id) + '\n定位键：' + (t.kch || t.label || t.id)
          + '\n\n这一下等于你真的点了一次选课（可能真的选上，也可能提示已满）。继续吗？')) break;
        app.testUiClick(t.id).then(function (r) {
          alert('UI 点击测试结果：\n\n' + ((r && r.report && r.report.steps || []).join('\n') || '（无步骤）')
            + '\n\n耗时：' + ((r && r.report && r.report.ms) || 0) + ' ms'
            + '\n结果判定：' + ((r && r.kind) || '未判定')
            + ((r && r.report && r.report.resultText) ? '\n弹框文字：' + r.report.resultText : ''));
          render();
        });
        break;
      }
      case 'keepalive-trial': {
        const origin = 'https://' + ((app.config().sites || [''])[0] || location.hostname);
        const kind = el.dataset.kind || 'page';
        const url = kind === 'page'
          ? origin + '/yjsxkapp/sys/xsxkapp/index.html'                                  // 选课首页 HTML（走页面 servlet）
          : origin + '/yjsxkapp/sys/xsxkapp/xsxkCourse/loadXspyjhkxztInfo.do';            // 轻量权限接口（221 字节）
        if (!confirm('[保活试验] 每 90 秒调用一次：\n\n' + url + '\n\n'
          + '目的：验证它能不能给会话续期。\n'
          + '· 若能 → 会话可长期保持，不用再手动登录\n'
          + '· 若仍约 10 分钟掉线 → 是绝对超时，只能手动重登\n\n'
          + '实验期间插件一直跑着，别再点「我刚登录了」。开始吗？')) break;
        app.save({ session: { keepAlive: { enabled: true, url: url, method: 'GET', intervalMs: 90000, timeoutMs: 10000, cacheBuster: true } } })
          .then(function () {
            alert('试验已开始（' + (kind === 'page' ? '页面请求' : '轻量接口') + '，每 90 秒一次）。\n\n'
              + '请正常使用插件（可以启动抢课），约 15 分钟后看日志：\n'
              + '· 出现「★ 保活看起来有效」→ 成功了，以后不用再手动登录\n'
              + '· 仍然约 10 分钟掉线 → 绝对超时，走自动开登录页方案\n\n'
              + '（日志里每 90 秒会有一条「登录态体检通过」，那是保活请求在工作。）');
            render();
          });
        break;
      }
      case 'keepalive-stop':
        app.save({ session: { keepAlive: { enabled: false, url: '' } } }).then(function () {
          alert('已停止保活实验，恢复为"接近失效时提醒 + 自动打开登录页 + 光标就位"。');
          render();
        });
        break;
      case 'calib-reset':
        app.resetLifetimeCalibration().then(function () {
          alert('已重置存活时长校准：\n\n· 历史样本清空（那些被手动退出/换账号的短样本会带偏估算）\n'
            + '· 推算基准回到 10 分钟\n· 下次真实掉线会重新测一次\n\n'
            + '（注意：这只影响"提前提醒"，不影响抢课；真掉线仍会被立刻发现。）');
          render();
        });
        break;
      case 'warn-off':
        app.save({ session: { warnBeforeMs: 0 } }).then(function () {
          alert('已关闭「按推算值提前提醒」。\n\n'
            + '· 不再有"登录即将过期"这类可能误报的提醒\n'
            + '· 真掉线仍然会立刻处理：检测到 HTTP 401 / 页面未登录文字 → 响铃 + 自动打开登录页 + 光标放进验证码框\n'
            + '· 想重新打开：设置 → 会话 → 提前提醒(分钟) 填 2');
          render();
        });
        break;
      case 'check-mine':
        app.checkMine().then(function (r) {
          if (!r || r.ok === false) { alert('核对失败：' + ((r && r.error) || '未知') + '\n\n'
            + '（这一步需要已登录；它查的是你自己的「已选课程」列表）'); return; }
          const list = (r.list || []);
          alert('已选课程：' + list.length + ' 门\n\n' + list.slice(0, 20).map(function (m) {
            return '· ' + m.name + '（' + (m.teacher || '?') + '）' + (m.canDrop === false ? '［学校不允许退］' : '');
          }).join('\n') + (list.length > 20 ? '\n…' : '')
            + '\n\n目标是"已选上"的会自动标出来。');
          render();
        });
        break;
      /* 项目 archives/ 目录：一键读取（随扩展打包，永久可用） */
      case 'arch-refresh-bundled':
        app.listBundledArchives().then(function (r) {
          if (!r || r.ok === false) { S.bundledErr = (r && r.error) || '未知'; S.bundled = { files: [] }; S.bundledGeneratedAt = 0; }
          else { S.bundledErr = ''; S.bundled = { files: r.files, generatedAt: r.generatedAt }; S.bundledGeneratedAt = r.generatedAt; }
          S.bundledRemembered = app.rememberedArchives ? app.rememberedArchives() : (S.bundledRemembered || []);
          render();
        });
        break;
      case 'arch-load-bundled':
        app.loadBundledArchive(el.dataset.name).then(function (r) {
          if (!r || r.ok === false) { alert('读取失败：' + ((r && r.error) || '未知')); return; }
          alert('已读取项目里的档案：' + el.dataset.name + '\n\n共 ' + r.count + ' 门课'
            + (r.at ? '（档案时间 ' + tstr(r.at) + '）' : '') + '\n\n'
            + '现在可以搜索、勾选目标。跨年用法：选课开了以后点「按课程名重新解析目标」把ID换成新的。');
          render();
        });
        break;
      case 'arch-load-name': {
        const inp = S.shadow.querySelector('input[data-act="arch-name"]');
        const name = String((S.archName || (inp && inp.value) || '')).trim().replace(/^.*[\\/]/, '');
        if (!name) { alert('请填文件名'); break; }
        app.loadBundledArchive(name).then(function (r) {
          if (!r || r.ok === false) {
            alert('读取失败：' + ((r && r.error) || '未知') + '\n\n'
              + '常见原因：① 文件名打错了 ② 文件不在项目的 archives/ 目录里\n'
              + '（也可以点「选择文件夹…」直接选那个目录）');
            return;
          }
          alert('已读取：' + name + '\n共 ' + r.count + ' 门课。');
          render();
        });
        break;
      }
      case 'arch-pick-dir': {
        const f = S.shadow.querySelector('input[data-act="arch-dir"]');
        if (f) f.click();
        break;
      }
      /* 从"临时选的文件夹"里读某个文件 */
      case 'arch-load-picked': {
        const item = (S.dirList || []).find(function (x) { return String(x.idx) === String(el.dataset.idx); });
        if (!item || !item.file) { alert('文件已失效，请重新选择文件夹'); break; }
        readJsonFile(item.file, function (obj, err) {
          if (err) { alert('读取失败：' + err); return; }
          app.importArchive(obj).then(function (r) {
            if (!r || r.ok === false) { alert('导入失败：' + ((r && r.error) || '未知')); return; }
            alert('已读取：' + item.name + '\n共 ' + r.count + ' 门课。');
            render();
          });
        });
        break;
      }
      case 'cfg-reapply':
        app.reapplyBundledConfig().then(function (r) {
          if (!r || r.ok === false) { alert('重新应用失败：' + ((r && r.error) || '未知')); return; }
          alert(r.applied
            ? '已重新应用项目配置文件。\n\n变动的部分：' + ((r.changed || []).join('、') || '（无）')
              + '\n\n你的目标列表、面板调速、通知与收集器偏好都保留了。'
            : '项目配置文件与当前配置一致，无需重新应用。');
          render();
        });
        break;
      case 'rate-preset': {
        const gap = Number(el.dataset.gap) || 300;
        const cap = Number(el.dataset.cap) || 120;
        const int = Number(el.dataset.int) || 600;
        const eff = Math.min(cap, Math.floor(60000 / gap));
        const nT = (app.config().targets || []).filter(function (t) { return t.enabled !== false; }).length || 1;
        app.save({ engine: { minGapMs: gap, maxReqPerMinute: cap, intervalMs: int } }).then(function () {
          alert('速率已改为约 ' + eff + ' 次/分钟\n\n'
            + '每分钟上限：' + cap + '\n发包最小间隔：' + gap + 'ms\n轮询间隔：' + int + 'ms\n\n'
            + '按当前 ' + nT + ' 个目标算：每个目标约 ' + (eff / nT).toFixed(0) + ' 次/分钟（每 ' + (60 / (eff / nT)).toFixed(1) + ' 秒轮到一次）\n\n'
            + (app.status().running ? '引擎正在跑，下一轮就用新速率（不用重载、不用重启）。' : '下次启动时生效。')
            + (eff >= 400 ? '\n\n⚠ 高频写入提交接口很容易触发风控（验证码/429/临时封禁）。建议先跑 10 分钟看日志，出现验证码会自动停机。' : ''));
          render();
        });
        break;
      }
      /* ---------------- 档案页 ---------------- */
      case 'arch-refresh': {
        const ta0 = S.shadow.querySelector('textarea[data-act="arch-json"]');
        if (ta0) ta0.value = '';
        app.testQuery().then(function (q) {
          if (!q || !q.ok) { alert('查询失败：' + ((q && q.error) || '无响应') + '\n\n档案需要一次成功的全量查询。'); return; }
          alert('档案已刷新：' + ((S.archive.rows || []).length) + ' 门课。\n\n'
            + '这份快照存在本地，离线、未登录、选课未开时都能在「档案」页查看和挑目标。');
          render();
        });
        break;
      }
      /* 档案导出/导入：做成**真正的文件操作**（原来只有剪贴板+文本框，太绕）。
       * 导出用 <a download> + blob：不需要额外权限，文件直接进下载文件夹。
       * 导入用 <input type=file>：直接选文件，不用复制粘贴。 */
      case 'arch-download': {
        const a = app.archive();
        if (!a.rows || !a.rows.length) { alert('还没有档案可导出 —— 先点「刷新档案（全量查询）」'); break; }
        const json = JSON.stringify(a);
        const d = new Date();
        const p2 = (n) => String(n).padStart(2, '0');
        const name = 'kx-courses-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + '.json';
        let downloaded = false;
        try {
          const blob = new Blob([json], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const el2 = document.createElement('a');
          el2.href = url;
          el2.download = name;
          el2.style.display = 'none';
          (document.body || document.documentElement).appendChild(el2);
          el2.click();
          setTimeout(function () { URL.revokeObjectURL(url); el2.remove(); }, 4000);
          downloaded = true;
        } catch (e) { downloaded = false; }
        const ta0 = S.shadow.querySelector('textarea[data-act="arch-json"]');
        if (ta0) ta0.value = json;
        copy(json);   // 同时放一份到剪贴板兜底
        alert((downloaded
          ? '已开始下载：\n' + name + '\n（在你的「下载」文件夹里）'
          : '这个网站的策略阻止了直接下载，已改为复制到剪贴板')
          + '\n\n共 ' + a.rows.length + ' 门课。'
          + (downloaded ? '' : '\n请打开记事本粘贴，存成 kx-courses.json')
          + '\n\n明年开课前用「选择文件导入」把它选回来即可。');
        break;
      }
      case 'arch-pick': {
        const f = S.shadow.querySelector('input[data-act="arch-file"]');
        if (f) f.click();
        break;
      }
      case 'arch-file-read': {
        // 由 change 事件带着 file 进来
        const file = el._kxFile;
        if (!file) break;
        const fr = new FileReader();
        fr.onload = function () {
          try {
            const obj = JSON.parse(String(fr.result || ''));
            if (!obj || !Array.isArray(obj.rows)) { alert('不是档案格式（需要 {rows:[...]}）'); return; }
            app.importArchive(obj).then(function (r) {
              if (!r || r.ok === false) { alert('导入失败：' + ((r && r.error) || '未知')); return; }
              alert('已导入档案：' + r.count + ' 门课（原档案时间 ' + (obj.at ? tstr(obj.at) : '未知') + '）。\n\n'
                + '现在可以在「档案」页搜索、勾选目标；再过一遍「按课程名重新解析目标」把ID换成今年的。');
              render();
            });
          } catch (e) { alert('文件解析失败：' + e.message); }
        };
        fr.readAsText(file);
        break;
      }
      case 'arch-copy': {
        const a = app.archive();
        if (!a.rows || !a.rows.length) { alert('还没有档案可导出'); break; }
        const json = JSON.stringify(a);
        const ta = S.shadow.querySelector('textarea[data-act="arch-json"]');
        if (ta) { ta.value = json; ta.select(); }
        copy(json);
        alert('已复制档案 JSON（' + a.rows.length + ' 门）到剪贴板。\n\n粘到记事本存成 kx-courses.json 就是长期备份。');
        break;
      }
      case 'arch-import': {
        const ta = S.shadow.querySelector('textarea[data-act="arch-json"]');
        try {
          const obj = JSON.parse(String((ta && ta.value) || ''));
          if (!obj || !Array.isArray(obj.rows)) { alert('不是档案格式（需要 {rows:[...]}）'); break; }
          app.importArchive(obj).then(function (r) {
            if (!r || r.ok === false) { alert('导入失败：' + ((r && r.error) || '未知')); return; }
            alert('已导入档案：' + r.count + ' 门课。');
            render();
          });
        } catch (e) { alert('JSON 解析失败：' + e.message); }
        break;
      }
      case 'arch-clear':
        if (confirm('清空本地课程档案？（不影响目标列表）')) app.clearArchive().then(render);
        break;
      case 'arch-add-wishlist': {
        /* 加入备选清单：只记课程名（跨年/跨电脑可带走） */
        const ids = Array.from(S.archSel || []);
        if (!ids.length) break;
        const rows0 = (S.archive.rows || []);
        const keys = {};
        rows0.filter(function (r) { return ids.indexOf(r.id) !== -1; })
          .forEach(function (r) { const k = R.normCourseName(r.name || ''); if (k) keys[k] = 1; });
        const want = rows0.filter(function (r) { return keys[R.normCourseName(r.name || '')]; });
        if (!confirm('把这些课加入备选清单？\n\n共 ' + want.length + ' 门\n\n'
          + '· 备选清单只记**课程名/教师/校区**，不记教学班ID（ID每年都变）\n'
          + '· 明年在新电脑上装好扩展后，这些课会**自动**变成监控目标、\n'
          + '  进选课页按课程名匹配今年的班级并开抢 —— 不需要你手动操作\n'
          + '· 已经有的目标不会被影响')) break;
        app.addWishlist(want.map(function (r) {
          return { name: r.name, teacher: r.teacher, campus: r.campus, code: r.code };
        })).then(function (r) {
          alert('已加入备选清单：新增 ' + (r.added || 0) + ' 门，共 ' + (r.total || 0) + ' 门。'
            + ((r.skipped ? '\n（' + r.skipped + ' 门因为同名已存在而跳过）' : ''))
            + '\n\n明年/换电脑后会自动生效 ✅\n\n'
            + '强烈建议点「复制为配置片段（贴进项目配置文件）」，把清单写进项目 —— '
            + '这样新电脑上装好扩展、登录、进选课页，剩下的全自动。');
          S.archSel = new Set();
          S.onboarding = false;      // 挑过了，引导关掉
          render();
        });
        break;
      }
      case 'onboard-skip':
        S.onboarding = false;
        toast('已跳过挑课 —— 以后想加课随时可在「档案」页勾选');
        render();
        break;
      case 'wish-clear':
        if (!confirm('清空备选清单？（不影响现有的监控目标）')) break;
        app.clearWishlist().then(function () { render(); });
        break;
      case 'wish-copy':
        (function () {
          const wl = S.wishlist || [];
          if (!wl.length) { alert('备选清单是空的'); return; }
          const snippet = '"wishlist": ' + JSON.stringify(wl.map(function (w) {
            return { name: w.name, teacher: w.teacher || '', campus: w.campus || '', code: w.code || '' };
          }), null, 2).split('\n').map(function (l, i) { return i === 0 ? l : '  ' + l; }).join('\n') + ',';
          copy(snippet);
          alert('已复制备选清单（' + wl.length + ' 门）到剪贴板。\n\n'
            + '用法：打开项目的 kx-config-吉大研究生选课.json，\n'
            + '把它的 "wishlist" 字段整段替换成刚复制的内容，保存。\n'
            + '（新电脑上装好扩展后会自动读取，不用手动导入）');
        })();
        break;
      case 'wish-seed':
        app.seedFromWishlist().then(function (r) {
          alert(r && r.seeded
            ? '已用备选清单生成 ' + r.seeded + ' 个监控目标（还没有ID）。\n\n'
              + '进选课页后会自动按课程名匹配今年的班级并开始抢 ✅'
            : '没有生成：' + ((r && r.why) || '未知原因') + '\n\n（只有当前一个目标都没有时才会生成）');
          render();
        });
        break;
      case 'arch-resolve': {
        if (!(S.archive.rows || []).length) { alert('档案是空的 —— 先点「刷新档案（全量查询）」'); break; }
        app.resolveTargets({ dryRun: true }).then(function (r) {
          if (!r || r.ok === false) { alert((r && r.error) || '解析失败'); return; }
          const lines = (r.report || []).map(function (x) {
            if (x.action === 'keep') return '· ' + (x.label || x.id) + '：ID 仍然有效（不动）';
            if (x.action === 'would-change') return '· ' + (x.label || x.id) + ' → ' + x.toName + '（' + x.toTeacher + '）　匹配度 ' + x.score;
            if (x.action === 'manual') {
              const c = (x.candidates || []).slice(0, 3).map(function (y) { return y.name + '/' + y.teacher + '(' + y.score + ')'; }).join('　');
              return '· ' + (x.label || x.id) + '：需要你决定（' + (x.reason === 'ambiguous' ? '有多个同类班' : '没找到足够像的') + '）'
                + (c ? '\n　　候选：' + c : '');
            }
            return '';
          }).join('\n');
          const msg = '按课程名解析目标：共 ' + r.total + ' 个\n'
            + '可自动改 ID：' + r.changed + ' 个　需要你决定：' + r.manual + ' 个\n\n' + lines
            + '\n\n点「确定」执行自动改 ID（存疑的不会动），点「取消」什么都不做。';
          if (!r.changed) { alert(msg); return; }
          if (!confirm(msg)) return;
          app.resolveTargets({}).then(function (r2) {
            alert('已按课程名重新解析：改了 ' + ((r2 && r2.changed) || 0) + ' 个目标的ID。\n'
              + '（在「目标」页能看到新ID；日志里也有记录）');
            render();
          });
        });
        break;
      }
      case 'arch-sel':
        if (!S.archSel) S.archSel = new Set();
        if (S.archSel.has(el.dataset.id)) S.archSel.delete(el.dataset.id); else S.archSel.add(el.dataset.id);
        render();
        break;
      case 'arch-clear-sel':
        S.archSel = new Set();
        render();
        break;
      case 'arch-add-same-name': {
        /* 同名一起抢：把勾选课程的同名教学班全部加入监控 */
        const ids = Array.from(S.archSel || []);
        if (!ids.length) break;
        const rows0 = (S.archive.rows || []);
        const keys = {};
        rows0.filter(function (r) { return ids.indexOf(r.id) !== -1; })
          .forEach(function (r) { const k = R.normCourseName(r.name || ''); if (k) keys[k] = 1; });
        const want = rows0.filter(function (r) { return keys[R.normCourseName(r.name || '')]; });
        if (!confirm('把同名的教学班一起加入监控？\n\n共 ' + want.length + ' 门（你勾选了 ' + ids.length + ' 门）\n\n'
          + '· 机会最大化：同名班里哪个先有名额就抢哪个\n'
          + '· 插件**不会**因为"判定抢到了"就停掉同名其它班（误停会丢课）；\n'
          + '  抢到多个的话，多出来的你自己去学校页面退掉\n'
          + '· 个别班完全不想要，加入后到「目标」页点「停」')) break;
        (async function () {
          let ok = 0, dup = 0;
          for (const row of want) {
            const r = await S.app.addTarget(row.id, row.name || '', row.code || '',
              { teacher: row.teacher || '', campus: row.campus || '', name: row.name || '' });
            if (r.ok) ok++; else dup++;
          }
          S.archSel = new Set();
          alert('同名班加入完成：成功 ' + ok + ' 个' + (dup ? '，已在列表里 ' + dup + ' 个' : '')
            + '\n\n命中任意一个后，同名的其它班会自动停下。');
          render();
        })();
        break;
      }
      case 'arch-add-sel': {
        const ids = Array.from(S.archSel || []);
        if (!ids.length) break;
        const all = (S.archive.rows || []);
        (async function () {
          let ok = 0, dup = 0;
          for (const id of ids) {
            const row = all.find(function (r) { return r.id === id; });
            const r = await S.app.addTarget(id, (row && row.name) || '', (row && row.code) || '', {
              teacher: (row && row.teacher) || '', campus: (row && row.campus) || '', name: (row && row.name) || ''
            });
            if (r.ok) ok++; else dup++;
          }
          S.archSel = new Set();
          alert('加入完成：成功 ' + ok + ' 个' + (dup ? '，重复 ' + dup + ' 个' : ''));
          render();
        })();
        break;
      }
      case 'ping-collector':
        app.pingCollector().then(function (r) {
          if (r && r.ok) alert('收集器连接正常');
          else alert('连接失败：' + ((r && (r.error || r.body)) || '无响应') + '\n先在项目目录跑：node tools/collector.mjs');
          render();
        });
        break;
      case 'push-now':
        app.pushNow().then(function (r) {
          if (r && r.ok) {
            alert(r.empty
              ? '没有可推送的抓包记录。\n\n按顺序确认：\n① 这次操作前刷新过页面（内容脚本只在页面加载时注入）\n② 「抓包」页里确实有请求记录\n③ 设置里收集器地址填的是 http://127.0.0.1:8790/kx/captures'
              : '已推送 ' + r.entries + ' 条抓包、' + r.logs + ' 条日志'
                + (typeof r.added === 'number' ? '（服务端新增 ' + r.added + ' 条，累计 ' + r.total + ' 条）' : ''));
          } else {
            alert('推送失败：' + ((r && (r.error || r.body)) || '无响应') + '\n\n先在项目目录跑：node tools/collector.mjs');
          }
          render();
        });
        break;
      case 'export-captures': {
        const exp = app.exportCaptures();
        const blob = new Blob([exp.text], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = exp.filename;
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
        alert('已导出 ' + exp.filename + '\n把它放到 E:\\Code\\选课插件\\ 目录里，我就能本地读它并生成配置。');
        break;
      }
      case 'test-submit': {
        const t = (app.config().targets || [])[0];
        if (!t) { alert('先在「目标」页加一个 ID'); break; }
        if (!confirm('真的要对 ' + t.id + ' 发送一次选课请求吗？')) break;
        app.testSubmit(t.id).then(function (r) { alert('结果：' + r.kind); render(); });
        break;
      }
      case 'probe': app.probe('面板').then(render); break;
      case 'open-login': {
        const r = app.openLogin();
        if (r && r.ok === false) alert(r.error);
        break;
      }
      case 'mark-login': app.markLogin(); render(); break;
      case 'confirm': app.confirmTarget(el.dataset.id); render(); break;
      case 't-toggle': app.updateTarget(el.dataset.id, { enabled: el.dataset.on === '1' }).then(render); break;
      case 't-reset': app.resetTargetState(el.dataset.id); render(); break;
      case 't-del': {
        const cfgD = S.app.config();
        const tgt = (cfgD.targets || []).find(function (x) { return String(x.id) === String(el.dataset.id); }) || {};
        if (!confirm('把「' + (tgt.label || el.dataset.id) + '」从监控列表里删除？\n\n'
          + '· 只影响插件的监控列表，不会退掉你已经选上的课\n'
          + '· 想退课请去学校页面的「已选课程」\n'
          + '· 只是想暂停，点「停」就行（不用删）')) break;
        app.removeTarget(el.dataset.id).then(render);
        break;
      }
      case 'add-target':
      /* 档案页每行那个「加监控」按钮 —— 真实 bug：按钮写的是 data-act="arch-add"，
       * 但这里**只有 add-target 分支**，于是点击落到 default → 什么都不发生
       * （用户报"加监控点击没反应"）。两个名字都接住，并且加断言防止再犯：
       * test/panel.test.mjs 会检查"每个 data-act 都有对应的 case"。 */
      case 'arch-add':
        app.addTarget(el.dataset.id, el.dataset.label, el.dataset.kch).then(function (r) {
          if (r && r.ok === false) alert(r.error);
          render();
        });
        break;
      case 'board-more':
        S.expandBoardId = (S.expandBoardId === el.dataset.id) ? null : el.dataset.id;
        render();
        break;
      case 'board-sel': {
        if (!S.boardSel) S.boardSel = new Set();
        if (S.boardSel.has(el.dataset.id)) S.boardSel.delete(el.dataset.id); else S.boardSel.add(el.dataset.id);
        // checkbox 的 checked 状态由浏览器维护，这里只更新计数 → 局部刷新计数行
        render();
        break;
      }
      case 'board-clear-sel':
        S.boardSel = new Set();
        render();
        break;
      case 'board-add-sel': {
        const ids = Array.from(S.boardSel || []);
        if (!ids.length) { alert('还没勾选课程'); break; }
        const all = (S.boardFull && S.boardFull.length) ? S.boardFull : (S.board || []);
        if (!confirm('把勾选的 ' + ids.length + ' 门课加入监控？\n\n'
          + '提醒：盲发模式下每分钟请求上限是所有目标共享的 —— 目标越多，每个目标轮得越慢。'
          + '监控很多课时，建议改成「先查余量再抢」（设置 → 余量查询 → 启用）。')) break;
        (async function () {
          let ok = 0, dup = 0;
          for (const id of ids) {
            const row = all.find(function (r) { return r.id === id; });
            const ex = R.rowExtras(row && row.raw);
            const r = await S.app.addTarget(id, (row && row.name) || '', ex.code || '');
            if (r.ok) ok++; else dup++;
          }
          S.boardSel = new Set();
          alert('加入完成：成功 ' + ok + ' 个' + (dup ? '，重复 ' + dup + ' 个' : ''));
          render();
        })();
        break;
      }
      case 'board-view':
        S.boardView = (S.boardView === 'poll') ? 'full' : 'poll';
        render();
        break;
      case 'board-copy-id':
        copy(el.dataset.id);
        break;
      case 'import-go': {
        const ta = S.shadow.querySelector('textarea[data-act="import"]');
        const lines = String(ta && ta.value || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
        if (!lines.length) { alert('先粘贴几行，每行「ID,备注」'); break; }
        (async function () {
          let ok = 0, dup = 0, bad = 0;
          for (const line of lines) {
            const parts = line.split(/[,，\t]+/).map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
            const id = parts[0];
            const label = parts[1] || '';
            const kch = parts[2] || '';
            if (!id || !/^[\w.\-]{2,64}$/.test(id)) { bad++; continue; }
            const r = await S.app.addTarget(id, label, kch);
            if (r.ok) ok++; else dup++;
          }
          alert('导入完成：成功 ' + ok + '，重复 ' + dup + '，格式不对 ' + bad);
          render();
        })();
        break;
      }
      case 'load-preset': {
        const key = el.dataset.key;
        const preset = ((globalThis.KXPresets) || {})[key];
        if (!preset) { alert('找不到内置预设 ' + key); break; }
        const p = JSON.parse(JSON.stringify(preset));
        if (!confirm('载入内置预设「' + key + '」？\n\n'
          + '会配好：\n'
          + '· 生效站点：' + ((p.sites || []).join(', ') || '（空）') + '\n'
          + '· 提交接口：' + String(((p.submit || {}).url) || '').split('/').pop() + '\n'
          + '· 查询接口：' + String((((p.query || {}).url) || '')).split('/').pop() + '\n'
          + '· 引擎只在 ' + ((p.worker || {}).urlRe || '任意页面') + ' 上运行\n'
          + '· UI 点击模式：' + (((p.ui || {}).mode) || 'hybrid') + '\n\n'
          + '会覆盖的只是**系统协议**部分（站点/接口/判定规则/页面限制）。\n'
          + '你的**监控目标**、**备选清单**、调好的**速率**、通知与收集器偏好都会保留。\n\n'
          + '继续吗？')) break;
        /* 保留属于用户的数据：目标、备选清单、调速、通知/收集器偏好。
         * 真实教训：以前这里会把目标列表一起清空 —— 现在没必要冒这个险
         * （想删目标有专门的删除按钮）。 */
        const curWanted = app.config();
        p.targets = curWanted.targets || [];
        p.wishlist = curWanted.wishlist || [];
        p.engine = Object.assign({}, p.engine || {}, curWanted.engine || {});
        // 保留用户已有的「通知/收集器」偏好：那属于个人环境，不该被预设重置
        const cur = app.config();
        p.notify = cur.notify;
        p.debug = cur.debug;
        app.save(p, { replace: true }).then(function () {
          alert('已载入内置预设。\n\n接下来：\n'
            + '① 回首页登录，然后点进「选课」页面\n'
            + '② 余量页点「查询一次(全量)」→ 搜课 → 勾选 → 加入监控\n'
            + '③ 点「启动」\n\n'
            + '（提交接口需要每次都变的 csrfToken，插件会在需要时自动点一次页面上的「选课」按钮把它喂进来，你不用手动操作。）');
          render();
        });
        break;
      }
      case 'export': {
        const data = S.app.config();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'kx-config.json';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
        break;
      }
      case 'import-config': {
        const ta = S.shadow.querySelector('textarea[data-act="config-json"]');
        try {
          const obj = JSON.parse(String(ta && ta.value || ''));
          if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { alert('这不是一个配置对象（应该是 {...}）'); break; }
          /* 目标列表单独问一次 —— 真实事故：用户导入配置文件来更新模板/规则，
           * 结果文件里带的旧 targets 把他辛苦挑的 9 个目标冲成了 2 个。
           * 绝大多数导入的意图是"更新设置"，不是"换掉选课清单"。 */
          const cur = (app.config().targets || []);
          const inc = (obj.targets || []);
          let keepTargets = true;
          if (cur.length && inc.length) {
            keepTargets = confirm('导入的配置里有 ' + inc.length + ' 个目标，你现在有 ' + cur.length + ' 个。\n\n'
              + '【确定】= 保留你现在的 ' + cur.length + ' 个目标（只更新模板/规则等设置）← 推荐\n'
              + '【取消】= 用配置里的 ' + inc.length + ' 个目标替换（你现在的会被丢掉）');
          } else if (cur.length && !inc.length) {
            keepTargets = true;   // 文件里没有目标 → 不动用户的清单
          }
          if (!confirm('导入会覆盖模板、判定规则、会话与调试设置。继续吗？')) break;
          const patch = JSON.parse(JSON.stringify(obj));
          if (keepTargets) patch.targets = cur;
          app.importConfig(patch).then(function (st) {
            alert('导入成功。\n目标 ' + (st.targets || []).length + ' 个'
              + (keepTargets && cur.length ? '（保留了你原来的）' : '')
              + '\n提交接口：' + ((st.submit || {}).url || '（空）')
              + '\n余量接口：' + ((st.query || {}).url || '（未启用）'));
            S.ui.tab = 'settings';
            render();
          });
        } catch (e) { alert('JSON 解析失败：' + e.message); }
        break;
      }
      case 'reset-config':
        if (confirm('恢复默认配置？目标列表也会被清空。')) {
          KX.reset().then(function () { render(); });
        }
        break;
      default: break;
    }
  }

  function copy(text) {
    try {
      navigator.clipboard.writeText(text).then(function () { toast('已复制到剪贴板'); }, function () { fallbackCopy(text); });
    } catch (e) { fallbackCopy(text); }
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制（兼容模式）'); } catch (e) { alert('复制失败，请手工选中'); }
    ta.remove();
  }
  function toast(msg) {
    log2(msg);
    render();
  }
  function log2(msg) {
    S._toast = msg;
    try { console.log('[KX]', msg); } catch (e) {}
  }

  function persistUi() {
    if (globalThis.KXSaveUi) globalThis.KXSaveUi({ visible: S.ui.visible, tab: S.ui.tab, collapsed: S.ui.collapsed, x: S.ui.x, y: S.ui.y, w: S.ui.w });
  }

  function bind() {
    const sh = S.shadow;
    sh.addEventListener('click', function (ev) {
      const el = ev.target.closest('[data-act],[data-tab]');
      if (!el) return;
      if (el.dataset.tab) {
        S.ui.tab = el.dataset.tab;
        persistUi();
        render();
        return;
      }
      const act = el.dataset.act;
      if (act === 'sel') {
        // checkbox 交给 change 处理，避免双重触发
        return;
      }
      onAction(act, el);
    });
    sh.addEventListener('change', function (ev) {
      const el = ev.target;
      if (el.dataset && el.dataset.act === 'board-sel') {
        onAction('board-sel', el);
        return;
      }
      if (el.dataset && el.dataset.act === 'arch-sel') {
        onAction('arch-sel', el);
        return;
      }
      if (el.dataset && el.dataset.act === 'arch-file') {
        // 选文件 → 交给 onAction 读出来（FileReader 是异步的，所以把 file 挂到元素上带过去）
        const f = (el.files && el.files[0]);
        if (!f) return;
        el._kxFile = f;
        onAction('arch-file-read', el);
        return;
      }
      /* 「选择文件夹」：列出文件夹里的 .json（含门数），让你点着读。
       * 如果这些文件就在项目的 archives/ 里（能用扩展 URL 取到），就**把文件名记住** ——
       * 以后不需要索引工具、不需要重新选文件夹，列表里一直有（真实痛点：
       * 拷了文件但没重跑索引工具 → 列表空的，用户完全不知道该怎么办）。 */
      if (el.dataset && el.dataset.act === 'arch-dir') {
        const files = Array.from(el.files || []).filter(function (f) { return /\.json$/i.test(f.name) && f.name !== 'index.json'; });
        if (!files.length) { alert('这个文件夹里没有 .json 文件（index.json 不算档案）'); return; }
        S.dirList = files.map(function (f, i) { return { idx: i, name: f.name, file: f, size: f.size }; });
        files.forEach(function (f, i) {
          readJsonFile(f, function (obj) {
            if (obj && Array.isArray(obj.rows)) {
              S.dirList[i].rows = obj.rows.length;
              S.dirList[i].at = Number(obj.at) || 0;
            }
            render();
          });
        });
        render();
        // 试着用扩展 URL 读一遍：能读到 → 说明这个文件夹就是项目的 archives/ → 记住文件名
        (function () {
          const names = files.map(function (f) { return f.name; });
          Promise.all(names.map(function (n) {
            return fetch(chrome.runtime.getURL('archives/' + n), { cache: 'no-store' })
              .then(function (r) { return r.ok ? n : null; }).catch(function () { return null; });
          })).then(function (okNames) {
            const ok2 = okNames.filter(Boolean);
            if (!ok2.length) return;   // 不是项目的 archives/ → 只当临时列表
            app.rememberArchives(ok2).then(function () {
              log('ok', '已记住 archives/ 里的 ' + ok2.length + ' 个档案（以后列表里一直有，不需要索引工具）');
              render();
            });
          });
        })();
        return;
      }
      /* 直接填文件名读取（索引过期时的兜底） */
      if (el.dataset && el.dataset.act === 'arch-name') {
        const inp = S.shadow.querySelector('input[data-act="arch-name"]');
        S.archName = String((inp && inp.value) || '').trim();
        onAction('arch-load-name', el);
        return;
      }
      if (el.dataset && el.dataset.act === 'sel') {
        onAction('sel', el);
        return;
      }
      if (el.dataset && el.dataset.act === 't-kch') {
        S.app.updateTarget(el.dataset.id, { kch: String(el.value || '').trim() }).then(function () { render(); });
        return;
      }
      const path = el.dataset && el.dataset.path;
      if (!path) return;
      let val;
      const type = el.dataset.type;
      if (type === 'bool') val = !!el.checked;
      else if (type === 'json') {
        try { val = JSON.parse(el.value || '{}'); } catch (e) { alert('JSON 格式错误：' + e.message); return; }
      } else if (type === 'lines') {
        val = String(el.value || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      } else if (el.type === 'number') {
        val = Number(el.value) || 0;
        const div = Number(el.dataset.div) || 1;
        if (div !== 1) val = val * div;
      } else {
        val = el.value;
      }
      setPath(path, val).then(function () {
        if (path === 'sites') toast('站点白名单已更新，刷新页面后生效');
        render();
      });
    });
    sh.addEventListener('input', function (ev) {
      const el = ev.target;
      // 余量页的筛选框：要立即重绘，但重绘会换掉 input 元素，所以得把焦点和光标位置还回去
      if (el.dataset && el.dataset.act === 'board-filter') {
        S.boardFilter = el.value;
        const pos = el.selectionStart;
        render();
        const again = sh.querySelector('input[data-act="board-filter"]');
        if (again) {
          again.focus();
          try { again.setSelectionRange(pos == null ? again.value.length : pos, pos == null ? again.value.length : pos); } catch (e) { /* ignore */ }
        }
        return;
      }
      if (el.closest && el.closest('.body')) {
        const sc = sh.querySelector('.body');
        if (sc) S.scrollTop = sc.scrollTop;
      }
    });

    // 拖动（标题栏移动）+ 左边缘调宽度
    sh.addEventListener('pointerdown', function (ev) {
      const wrap = sh.querySelector('.wrap');
      if (!wrap) return;
      const r = wrap.getBoundingClientRect();
      /* 关键：点在按钮上时**绝不能**进入拖动逻辑。
       * 真实事故：标题栏整块是拖动区（data-drag），按钮也在里面 ——
       * 按「启动」被当成开始拖动，pointerup 时又 render() 重建面板 DOM，
       * 元素在 click 事件派发前就被销毁 → 标题栏上的所有按钮（启动/停止/收起/宽度）
       * 全部点不动，而面板内部按钮正常。这种 bug 极难从现象反推。 */
      if (ev.target.closest && ev.target.closest('[data-act],[data-tab],input,textarea,select')) return;
      // 靠近左边缘 8px 内 → 调整宽度（表格列多的时候靠它）
      if (!S.ui.collapsed && ev.clientX - r.left <= 8 && ev.clientX - r.left >= -2) {
        S.drag = null;
        S.resize = { right: r.right };
        try { wrap.setPointerCapture && wrap.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
        ev.preventDefault();
        return;
      }
      if (!ev.target.closest('[data-drag]')) return;
      S.resize = null;
      S.drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
      S.dragMoved = false;
      try { ev.target.setPointerCapture && ev.target.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    });
    sh.addEventListener('pointermove', function (ev) {
      if (S.resize) {
        const w = clampWidth(S.resize.right - ev.clientX);
        S.ui.w = w;
        if (S.ui.x != null) S.ui.x = Math.max(0, Math.round(S.resize.right - w));
        const wrap = sh.querySelector('.wrap');
        if (wrap) {
          wrap.style.width = w + 'px';
          if (S.ui.x != null) { wrap.style.left = S.ui.x + 'px'; wrap.style.right = 'auto'; }
        }
        return;
      }
      if (!S.drag) return;
      S.dragMoved = true;
      S.ui.x = Math.max(0, Math.min(window.innerWidth - 200, ev.clientX - S.drag.dx));
      S.ui.y = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - S.drag.dy));
      const wrap = sh.querySelector('.wrap');
      if (wrap) { wrap.style.left = S.ui.x + 'px'; wrap.style.right = 'auto'; wrap.style.top = S.ui.y + 'px'; }
    });
    sh.addEventListener('pointerup', function () {
      const moved = !!S.resize || (S.drag && S.dragMoved);
      S.drag = null; S.resize = null; S.dragMoved = false;
      // 只有真的拖动/调宽过才重绘：否则会把按钮的 click 事件吃掉（见上面 pointerdown 的注释）
      if (moved) { persistUi(); render(); }
    });

    /* 滚动 / 按住时标记"用户正在操作"，scheduleRender 会让路，
     * 避免自动刷新把滚动位置和手感搅乱。 */
    const markInteracting = function (ms) {
      S.interactingUntil = Date.now() + (ms || 450);
      if (S.pendingRender && !S.interactTimer) {
        S.interactTimer = setTimeout(function () {
          S.interactTimer = null;
          if (S.pendingRender) { S.pendingRender = false; scheduleRender(); }
        }, (ms || 450) + 80);
      }
    };
    sh.addEventListener('wheel', function () { markInteracting(500); }, { passive: true });
    sh.addEventListener('pointerdown', function () { markInteracting(600); });
    sh.addEventListener('touchstart', function () { markInteracting(700); }, { passive: true });
    sh.addEventListener('keydown', function () { markInteracting(600); });
    sh.addEventListener('pointercancel', function () { S.drag = null; });
    sh.addEventListener('focusout', function () { setTimeout(flushPendingRender, 0); });
  }

  /* ============================================================
   * 对外接口
   * ============================================================ */
  let rafPending = false;
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      // 正在输入框里打字时不要重绘（否则会把光标和已输入内容冲掉）
      const ae = S.shadow && S.shadow.activeElement;
      if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) {
        S.pendingRender = true;
        return;
      }
      /* 用户正在滚动 / 拖选择时不要重绘：重绘会重建整个 DOM（148 行表格也在内），
       * 滚动会一顿一顿的、甚至被拉回原位（真实反馈：滚动不流畅）。
       * 等手停下来再补一次。 */
      if (Date.now() < (S.interactingUntil || 0)) {
        S.pendingRender = true;
        if (!S.interactTimer) {
          S.interactTimer = setTimeout(function () {
            S.interactTimer = null;
            if (S.pendingRender) { S.pendingRender = false; scheduleRender(); }
          }, Math.max(120, (S.interactingUntil || 0) - Date.now() + 60));
        }
        return;
      }
      S.pendingRender = false;
      const sc = S.shadow && S.shadow.querySelector('.body');
      if (sc) S.scrollTop = sc.scrollTop;
      render();
    });
  }
  function flushPendingRender() {
    if (S.pendingRender) { S.pendingRender = false; scheduleRender(); }
  }

  globalThis.KXPanel = {
    mounted: false,

    mount: function (app, ui) {
      if (S.host) return;
      S.app = app;
      if (ui && typeof ui === 'object') S.ui = Object.assign(S.ui, ui);

      const host = document.createElement('div');
      host.id = 'kx-panel-host';
      host.setAttribute('data-kx', '1');
      const shadow = host.attachShadow({ mode: 'open' });
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        shadow.adoptedStyleSheets = [sheet];
      } catch (e) {
        const st = document.createElement('style');
        st.textContent = CSS;
        shadow.appendChild(st);
      }
      (document.body || document.documentElement).appendChild(host);
      S.host = host;
      S.shadow = shadow;
      bind();
      this.mounted = true;
      render();
    },

    log: function () { scheduleRender(); },
    capture: function () { scheduleRender(); },
    board: function (list, at, meta) {
      const m = meta || {};
      if (m.full) {                      // 人工全量查询结果
        S.boardFull = list || [];
        S.boardFullAt = at || Date.now();
      } else {                           // 自动轮询快照
        S.board = list || [];
        S.boardAt = at || Date.now();
      }
      if (m.fullCount !== undefined) S.pollCount = m.fullCount;
      if (m.pollAt !== undefined) S.pollAt = m.pollAt;
      scheduleRender();
    },
    /** 课程档案（本地快照）：面板「档案」页据此渲染，离线/未登录也能用 */
    archive: function (a, rows) {
      S.archive = { at: (a && a.at) || 0, site: (a && a.site) || '', rows: ((a && a.rows) || []).slice() };
      S.archiveRows = rows || [];
      scheduleRender();
    },
    /** 项目 archives/ 目录里的档案列表（内容脚本读 index.json 后推过来）；
     *  remembered = 用户"选文件夹"时记住的文件名（不需要索引工具也能一直列出）。 */
    bundled: function (b, remembered) {
      S.bundled = { files: ((b && b.files) || []).slice(), generatedAt: (b && b.generatedAt) || 0 };
      S.bundledGeneratedAt = (b && b.generatedAt) || 0;
      if (Array.isArray(remembered)) S.bundledRemembered = remembered.slice();
      S.bundledErr = '';
      scheduleRender();
    },
    /** 配置来源状态（项目里的配置文件是否已自动应用） */
    configSource: function (c) {
      S.configSource = c || {};
      scheduleRender();
    },
    /** 备选清单（跨年用：只有课程名，明年自动变成监控目标） */
    wishlist: function (w) {
      S.wishlist = Array.isArray(w) ? w.slice() : [];
      scheduleRender();
    },
    /** 已选课程（服务器权威判据）：目标页据此显示"确认已选上" */
    mine: function (list, at) {
      S.mine = { at: at || Date.now(), list: (list || []).slice() };
      scheduleRender();
    },
    status: function (st) {
      S.status = st;
      const h = st && JSON.stringify([st.status, st.statusText, st.running, (st.targets || []).map(function (t) { return t.id + t.state + t.tryCount; }).join(','), st.auth && st.auth.state, st.auth && Math.round((st.auth.leftMs || 0) / 5000), st.captureCount, st.pendingPush, st.pushMuted]);
      if (h === S.lastHash) return;
      S.lastHash = h;
      scheduleRender();
    },

    setVisible: function (v) { S.ui.visible = !!v; persistUi(); render(); },
    isVisible: function () { return !!S.ui.visible; },
    toggle: function () { S.ui.visible = !S.ui.visible; persistUi(); render(); return S.ui.visible; },
    /** 展开面板（"从零开始"引导时用：直接让你看到「档案」页去挑课） */
    expand: function () { S.ui.visible = true; S.ui.collapsed = false; persistUi(); render(); },
    /** 「从零开始」引导开关：档案页顶部显示醒目提示 */
    onboarding: function (on) { S.onboarding = !!on; scheduleRender(); },
    setTab: function (t) { if (t) { S.ui.tab = t; render(); } },
    refresh: function () { render(); }
  };
})();
