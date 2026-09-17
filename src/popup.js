/* ============================================================
 * popup.js —— 工具栏弹窗
 * 只做「看状态 + 按按钮」，不持有引擎；所有动作都转发给当前标签页的 content script
 * ============================================================ */
(function () {
  'use strict';
  const KX = globalThis.KX;
  const $ = (id) => document.getElementById(id);
  let tab = null;
  let lastStatus = null;

  function fmt(ms) {
    if (ms == null) return '-';
    if (ms <= 0) return '已过期';
    const s = Math.ceil(ms / 1000);
    if (s < 60) return s + ' 秒';
    return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  }

  const AUTH_TEXT = { ok: '正常', lost: '已掉线', suspect: '疑似过期', unknown: '未检测' };
  const AUTH_CLS = { ok: 'lo', lost: 'le', suspect: 'lw', unknown: '' };

  async function activeTab() {
    const list = await chrome.tabs.query({ active: true, currentWindow: true });
    return list && list[0];
  }

  async function send(msg) {
    if (!tab || tab.id == null) return null;
    msg.to = 'content';
    try { return await chrome.tabs.sendMessage(tab.id, msg); }
    catch (e) { return null; }
  }

  function setWarn(html) {
    $('warn').innerHTML = html || '';
  }

  async function refresh() {
    tab = await activeTab();
    const cfg = await KX.load(true);
    const ping = await send({ type: 'kx:ping', __allowInactive: true });
    lastStatus = ping && ping.status ? ping.status : null;

    const host = (tab && tab.url) ? KX.hostOf(tab.url) : '';
    const sites = cfg.sites || [];
    const allowed = host ? KX.siteAllowed(host, sites) : false;
    const httpOk = tab && /^https?:/i.test(tab.url || '');

    $('host').textContent = host || '(不支持的页面)';
    $('host').title = (tab && tab.url) || '';
    $('btnSite').disabled = !httpOk || allowed;
    $('btnSite').textContent = allowed ? '当前站点已在白名单' : '把当前站点加入白名单';

    if (!httpOk) {
      setWarn('<div class="warnbox">这个页面不是普通网页（chrome:// 或扩展页），插件无法在这个页面工作。请打开学校的选课页面再试。</div>');
      $('statusText').textContent = '不可用';
      $('auth').textContent = '-';
      $('targets').textContent = '-';
      $('counts').textContent = '-';
      renderLog([]);
      return;
    }
    if (!allowed) {
      setWarn('<div class="warnbox">当前站点还没加入白名单：点下面的按钮加入，然后<strong>刷新页面</strong>，面板就会出现。</div>');
      $('statusText').textContent = '未激活';
      $('auth').textContent = '-';
      $('targets').textContent = '-';
      $('counts').textContent = '-';
      renderLog([]);
      $('btnStart').disabled = true;
      $('btnStop').disabled = true;
      return;
    }
    if (!ping || !ping.ok) {
      setWarn('<div class="warnbox">页面里没找到插件注入的脚本：请<strong>刷新页面</strong>；如果还不行，检查是否在 chrome://extensions 里报错。</div>');
      $('statusText').textContent = '未注入';
      renderLog([]);
      return;
    }

    const st = ping.status;
    $('dot').className = 'dot ' + (st.auth && st.auth.state === 'lost' ? 'err' : (st.running ? 'on' : (st.status === 'halted' ? 'warn' : '')));
    $('statusText').textContent = st.statusText || st.status;
    $('auth').textContent = (AUTH_TEXT[st.auth.state] || st.auth.state)
      + (st.auth.leftMs != null ? '（推算剩 ' + fmt(st.auth.leftMs) + '）' : '');
    $('auth').className = 'v ' + (AUTH_CLS[st.auth.state] || '');
    const okCount = (st.targets || []).filter(function (t) { return t.state === 'success'; }).length;
    $('targets').textContent = (st.targets || []).length + ' 个 / 成功 ' + okCount;
    $('counts').textContent = st.captureCount + ' 条 / ' + (st.stats ? st.stats.submitTry : 0) + ' 次';

    $('btnStart').disabled = st.running;
    $('btnStop').disabled = !st.running;

    const cfgSess = cfg.session || {};
    if (st.auth.state === 'lost') {
      setWarn('<div class="warnbox">⚠ 登录态已失效：引擎已停止，正在每 ' + Math.round((cfgSess.recheckMs || 30000) / 1000)
        + ' 秒探测一次。你重新登录成功后' + (cfgSess.autoResume !== false ? '会自动继续抢' : '需要手动点启动') + '。</div>');
    } else if (st.auth.leftMs != null && st.auth.leftMs < (cfgSess.warnBeforeMs || 180000)) {
      setWarn('<div class="warnbox">⏳ 按 ' + Math.round((cfgSess.hardTimeoutMs || 0) / 60000) + ' 分钟硬超时推算，登录态将在 '
        + fmt(st.auth.leftMs) + '后失效，请及时重新登录。</div>');
    } else {
      setWarn('');
    }

    const logs = await new Promise(function (resolve) {
      chrome.storage.local.get('kx_popup_log', function (g) { resolve((g && g.kx_popup_log) || []); });
    });
    renderLog(logs);
  }

  function renderLog(logs) {
    const el = $('log');
    if (!logs || !logs.length) {
      el.innerHTML = '<div style="color:#6b7280">（打开面板的「日志」页可以看到完整记录）</div>';
      return;
    }
    el.innerHTML = logs.slice(-8).reverse().map(function (l) {
      const cls = l.level === 'err' ? 'le' : l.level === 'warn' ? 'lw' : (l.level === 'ok' ? 'lo' : 'ls');
      return '<div class="' + cls + '">' + String(l.msg).replace(/[<>&]/g, '') + '</div>';
    }).join('');
  }

  async function cmd(c, payload) {
    const r = await send({ type: 'kx:cmd', cmd: c, payload: payload || {} });
    if (r && r.ok === false) alert(r.error || '操作失败');
    await refresh();
    return r;
  }

  $('btnStart').addEventListener('click', function () { cmd('start'); });
  $('btnStop').addEventListener('click', function () { cmd('stop'); });
  $('btnPanel').addEventListener('click', function () { cmd('toggle-panel'); });
  $('btnProbe').addEventListener('click', function () { cmd('probe'); });
  $('btnMark').addEventListener('click', function () { cmd('mark-login'); });
  $('btnLogin').addEventListener('click', function () {
    cmd('open-login').then(function (r) {
      if (r && r.ok === false) alert(r.error);
    });
  });
  $('btnWorker').addEventListener('click', async function () {
    const cfg = await KX.load(true);
    const url = (cfg.worker && cfg.worker.url) || (tab && tab.url) || ('https://' + ((cfg.sites || [])[0] || ''));
    const r = await chrome.runtime.sendMessage({ type: 'kx:open-worker', mode: 'popup', url: url });
    if (r && r.ok === false) alert(r.error || '打开失败');
  });
  $('btnTab').addEventListener('click', async function () {
    const cfg = await KX.load(true);
    const url = (cfg.worker && cfg.worker.url) || (tab && tab.url) || ('https://' + ((cfg.sites || [])[0] || ''));
    const r = await chrome.runtime.sendMessage({ type: 'kx:open-worker', mode: 'tab', url: url });
    if (r && r.ok === false) alert(r.error || '打开失败');
  });
  $('btnSite').addEventListener('click', async function () {
    if (!tab || !tab.url) return;
    const host = KX.normalizeSite(KX.hostOf(tab.url));
    if (!host) { alert('拿不到当前站点主机名'); return; }
    const cfg = await KX.load(true);
    const sites = (cfg.sites || []).slice();
    if (!sites.some(function (s) { return KX.normalizeSite(s) === host; })) sites.push(host);
    await KX.save({ sites: sites, worker: { url: (cfg.worker && cfg.worker.url) || tab.url } });
    alert('已加入白名单：' + host + '\n请刷新当前页面，面板就会出现。');
    refresh();
  });

  // 打开时先把内容脚本最近的日志抓过来（content 会把它写到 kx_popup_log）
  refresh();
  setInterval(refresh, 2000);
})();
