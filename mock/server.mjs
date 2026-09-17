/* ============================================================
 * mock/server.mjs —— 本地模拟教务系统（零依赖，只用 node:http）
 * ------------------------------------------------------------
 * 为什么要有它：这套插件最终会往真实选课系统大量发包，一旦规则写错
 * 可能白刷几百次甚至触发风控。先用这个假系统把链路跑通，再去真站点。
 *
 * 它刻意复刻了真实系统里最关键的几个行为，用来验证插件：
 *   1. 「登录满 N 分钟硬超时」—— 到点后所有接口 302 跳 /login（默认 20 分钟，可用 --ttl 秒改小）
 *   2. 提交成功 / 人数已满 / 教学班不存在 三种文本响应
 *   3. 连续对已满的教学班刷 N 次后返回「请输入验证码」，用来验证插件会不会自动停机
 *   4. 某门课会定期自动放出一个名额，用来验证「发现名额 → 自动抢到」的完整闭环
 *
 * 用法：
 *   node mock/server.mjs                  # 默认 http://127.0.0.1:8787
 *   node mock/server.mjs --port 9000 --ttl 120   # 端口 9000，登录 2 分钟后硬超时
 *   node mock/server.mjs --no-auto-open          # 关闭「自动放名额」
 * 然后：浏览器打开 http://127.0.0.1:8787 → 点「一键登录」→ 在插件弹窗里把
 *       127.0.0.1 加入白名单 → 刷新 → 手工选一次课 → 面板里设为提交模板。
 * ============================================================ */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const DEFAULT_PORT = 8787;
const DEFAULT_TTL_MS = 20 * 60 * 1000;   // 和学校一致的 20 分钟硬超时
const AUTO_OPEN_MS = 20000;              // 每 20 秒给「数据结构」放 1 个名额
const CAPTCHA_EVERY = 3;                 // 对已满教学班连刷 3 次 → 要求验证码

/* ---------------- 状态 ---------------- */
function newState() {
  return {
    sessions: new Map(),        // sid -> { loginAt, exp }
    seq: 0,
    courses: [
      // A：一开始没名额，会被「自动放名额」逐步放出来 ← 用来演示自动抢课
      { jxb_id: '2099000001', kch_id: 'CS101', kcmc: '数据结构', jsxm: '张三', capacity: 3, selected: 3, autoOpen: true },
      // B：现在就有名额 ← 用来验证「一步抢到」
      { jxb_id: '2099000002', kch_id: 'CS102', kcmc: '操作系统', jsxm: '李四', capacity: 60, selected: 57, autoOpen: false },
      // C：永远满 ← 用来验证「已满规则」与「验证码自动停机」
      { jxb_id: '2099000003', kch_id: 'CS103', kcmc: '编译原理', jsxm: '王五', capacity: 1, selected: 1, autoOpen: false }
    ],
    fullAttempts: {},           // jxb_id -> 对已满课程刷了多少次
    log: []
  };
}

function remainOf(c) { return Math.max(0, c.capacity - c.selected); }

/* ---------------- 小工具 ---------------- */
const nowStr = () => new Date().toTimeString().slice(0, 8);
const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const json = (res, obj, status = 200) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
};
const text = (res, body, status = 200, ct = 'text/plain; charset=utf-8') => {
  res.writeHead(status, { 'Content-Type': ct, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
};
const redirect = (res, to) => {
  res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
  res.end();
};

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(''));
  });
}

function parseForm(body, url) {
  const out = {};
  const q = (url && url.search) ? url.search.slice(1) : '';
  for (const part of [q, String(body || '')]) {
    for (const seg of part.split('&')) {
      if (!seg) continue;
      const i = seg.indexOf('=');
      const k = decodeURIComponent(i < 0 ? seg : seg.slice(0, i));
      const v = decodeURIComponent((i < 0 ? '' : seg.slice(i + 1)).replace(/\+/g, ' '));
      if (k) out[k] = v;
    }
  }
  return out;
}

/* ---------------- HTML 页面 ---------------- */
function pageIndex(s, host) {
  const rows = s.courses.map((c) => `<tr>
      <td>${esc(c.jxb_id)}</td><td>${esc(c.kch_id)}</td><td>${esc(c.kcmc)}</td><td>${esc(c.jsxm)}</td>
      <td><b style="color:${remainOf(c) > 0 ? '#0a0' : '#c00'}">${remainOf(c)}</b> / ${c.capacity}</td></tr>`).join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>模拟教务系统</title>
<style>body{font-family:system-ui,"Microsoft YaHei";max-width:820px;margin:24px auto;line-height:1.7;color:#222}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}
code{background:#f3f4f6;padding:1px 5px;border-radius:4px}a.btn,button{display:inline-block;margin:4px 6px 4px 0;padding:6px 10px;border:1px solid #888;border-radius:6px;background:#f7f7f7;cursor:pointer;text-decoration:none;color:#111}
.warn{background:#fff7e6;border:1px solid #f0c36d;padding:8px 10px;border-radius:6px}</style></head><body>
<h2>模拟教务系统</h2>
<div class="warn">这是本地假系统，只用来验证「选课助手」插件。所有数据都在内存里，重启即重置。</div>
<p>服务地址：<code>http://${esc(host)}</code>，硬超时：<code>${Math.round(s.ttlMs / 1000)} 秒</code>，
自动放名额：<code>${s.autoOpen ? '开（每 ' + Math.round(AUTO_OPEN_MS / 1000) + ' 秒给「数据结构」放 1 个）' : '关'}</code></p>
<p>
  <a class="btn" href="/login?auto=1&next=/xk">一键登录</a>
  <a class="btn" href="/xk">去选课页</a>
  <a class="btn" href="/xk/remain">HTML 版余量表（测正则解析）</a>
  <a class="btn" href="/__state">查看服务端状态(JSON)</a>
  <a class="btn" href="/logout">退出登录</a>
</p>
<h3>当前教学班</h3>
<table><tr><th>选课ID(jxb_id)</th><th>课程号</th><th>课程名</th><th>教师</th><th>余量/容量</th></tr>${rows}</table>
<p style="color:#666">把上面第一列的 <code>jxb_id</code> 填进插件面板的「目标」页，就是你要监测的选课ID。</p>
</body></html>`;
}

function pageLogin(host, next) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>统一身份认证 · 登录</title>
<style>body{font-family:system-ui,"Microsoft YaHei";max-width:380px;margin:60px auto;text-align:center}
input{width:100%;padding:8px;margin:6px 0;box-sizing:border-box}
button{width:100%;padding:9px;margin-top:8px;cursor:pointer}</style></head><body>
<h2>统一身份认证</h2>
<p style="color:#666">模拟登录页（${esc(host)}）</p>
<form method="POST" action="/login">
  <input name="username" placeholder="学号（随便填）" value="20240001">
  <input name="password" type="password" placeholder="密码（随便填）" value="test1234">
  <input type="hidden" name="next" value="${esc(next)}">
  <button type="submit">登录</button>
</form>
<p style="color:#666;font-size:13px">登录后 ${Math.round(DEFAULT_TTL_MS / 60000)} 分钟会硬超时被踢下线（可用 --ttl 调小方便测试）。</p>
</body></html>`;
}

function pageXk(s) {
  const opts = s.courses.map((c) => `<option value="${esc(c.jxb_id)}|${esc(c.kch_id)}">${esc(c.kcmc)}（余 ${remainOf(c)}）</option>`).join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>学生选课</title>
<style>body{font-family:system-ui,"Microsoft YaHei";max-width:760px;margin:24px auto;line-height:1.7}
button{padding:6px 10px;margin:4px 6px 4px 0;cursor:pointer;border:1px solid #888;border-radius:6px;background:#f7f7f7}
pre{background:#111;color:#0f0;padding:10px;border-radius:6px;min-height:60px;white-space:pre-wrap}</style></head><body>
<h2>学生选课（模拟）</h2>
<p><a href="/">← 回首页</a>　<a href="/logout">退出登录</a></p>
<p>这个页面发的请求和真系统长得一样：<code>POST /xk/submit</code>，body 是
<code>jxb_id=xxx&amp;kch_id=yyy&amp;xnm=2024&amp;xqm=12</code>，带 <code>X-Requested-With</code> 头。
先用插件面板的「抓包」页记录下面这次手工操作，再点「设为提交模板」。</p>
<p><button id="q">手工查询余量</button><button id="s">手工选课</button>
<select id="sel">${opts}</select></p>
<pre id="out">（结果会显示在这里）</pre>
<script>
const out = document.getElementById('out');
function show(t){ out.textContent = t; }
document.getElementById('q').onclick = async () => {
  const r = await fetch('/xk/query', {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','X-Requested-With':'XMLHttpRequest'}, body:'xnm=2024&xqm=12', credentials:'include'});
  show(r.status + ' ' + (await r.text()));
};
document.getElementById('s').onclick = async () => {
  const [jxb_id, kch_id] = document.getElementById('sel').value.split('|');
  const body = 'jxb_id=' + encodeURIComponent(jxb_id) + '&kch_id=' + encodeURIComponent(kch_id) + '&xnm=2024&xqm=12';
  const r = await fetch('/xk/submit', {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','X-Requested-With':'XMLHttpRequest'}, body: body, credentials:'include'});
  show(r.status + ' ' + r.url + '\\n' + (await r.text()));
  location.reload();
};
</script>
</body></html>`;
}

function pageRemainHtml(s) {
  const rows = s.courses.map((c) => `<tr><td>${esc(c.jxb_id)}</td><td>${esc(c.kcmc)}</td><td>${remainOf(c)}</td></tr>`).join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>余量表</title>
<style>td{border:1px solid #ccc;padding:4px 8px}</style></head><body>
<h3>余量（HTML 表格版，用来测试 parse.type=regex）</h3>
<table>${rows}</table>
<p>正则示例：<code>&lt;td&gt;(?&lt;id&gt;\\d{6,})&lt;/td&gt;&lt;td&gt;(?&lt;name&gt;[^&lt;]+)&lt;/td&gt;&lt;td&gt;(?&lt;remain&gt;\\d+)&lt;/td&gt;</code></p>
</body></html>`;
}

/* ---------------- 业务 ---------------- */
function getSession(s, req) {
  const cookies = String(req.headers.cookie || '');
  const m = cookies.match(/MOCK_SESSION=([^;]+)/);
  if (!m) return null;
  const sess = s.sessions.get(m[1]);
  if (!sess) return null;
  if (Date.now() > sess.exp) {                 // ← 硬超时：到点即失效，和学校一样
    s.sessions.delete(m[1]);
    return { expired: true };
  }
  return sess;
}

export function createMockServer(options = {}) {
  const s = newState();
  s.ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS;
  s.autoOpen = options.autoOpen !== false;
  s.port = options.port || DEFAULT_PORT;

  let timer = null;
  if (s.autoOpen) {
    timer = setInterval(() => {
      for (const c of s.courses) {
        if (c.autoOpen && c.selected > 0 && remainOf(c) < 2) { c.selected = Math.max(0, c.selected - 1); break; }
      }
    }, AUTO_OPEN_MS);
    if (timer.unref) timer.unref();
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
    const p = url.pathname;
    const host = '127.0.0.1:' + (server.address() ? server.address().port : s.port);
    const sess = getSession(s, req);

    try {
      /* ---- 首页 ---- */
      if (p === '/' && req.method === 'GET') {
        return text(res, pageIndex({ ...s, ttlMs: s.ttlMs }, host), 200, 'text/html; charset=utf-8');
      }
      if (p === '/__state' && req.method === 'GET') {
        return json(res, {
          ttlMs: s.ttlMs,
          autoOpen: s.autoOpen,
          sessions: [...s.sessions.entries()].map(([id, v]) => ({ id, leftMs: v.exp - Date.now() })),
          courses: s.courses.map((c) => ({ ...c, remain: remainOf(c) })),
          fullAttempts: s.fullAttempts,
          log: s.log.slice(-30)
        });
      }

      /* ---- 登录 ---- */
      if (p === '/login' && req.method === 'GET') {
        const next = url.searchParams.get('next') || '/xk';
        if (url.searchParams.get('auto') === '1') {
          const sid = 'sid' + (++s.seq) + Math.random().toString(36).slice(2, 8);
          s.sessions.set(sid, { loginAt: Date.now(), exp: Date.now() + s.ttlMs });
          s.log.push([nowStr(), 'login(auto)', sid]);
          res.writeHead(302, {
            Location: next,
            'Set-Cookie': `MOCK_SESSION=${sid}; Path=/; HttpOnly=false; SameSite=Lax`,
            'Cache-Control': 'no-store'
          });
          return res.end();
        }
        return text(res, pageLogin(host, next), 200, 'text/html; charset=utf-8');
      }
      if (p === '/login' && req.method === 'POST') {
        const form = parseForm(await readBody(req), url);
        const sid = 'sid' + (++s.seq) + Math.random().toString(36).slice(2, 8);
        s.sessions.set(sid, { loginAt: Date.now(), exp: Date.now() + s.ttlMs });
        s.log.push([nowStr(), 'login(' + (form.username || '?') + ')', sid]);
        res.writeHead(302, {
          Location: form.next || '/xk',
          'Set-Cookie': `MOCK_SESSION=${sid}; Path=/; HttpOnly=false; SameSite=Lax`,
          'Cache-Control': 'no-store'
        });
        return res.end();
      }
      if (p === '/logout') {
        s.sessions.clear();
        res.writeHead(302, { Location: '/login', 'Set-Cookie': 'MOCK_SESSION=; Path=/; Max-Age=0' });
        return res.end();
      }

      /* ---- 需要登录的页面 ---- */
      if (p === '/xk' && req.method === 'GET') {
        if (!sess || sess.expired) {
          s.log.push([nowStr(), 'xk → 302 /login', sess && sess.expired ? '硬超时' : '无会话']);
          return redirect(res, '/login?next=/xk');
        }
        return text(res, pageXk(s), 200, 'text/html; charset=utf-8');
      }
      if (p === '/xk/remain' && req.method === 'GET') {
        if (!sess || sess.expired) return redirect(res, '/login?next=/xk/remain');
        return text(res, pageRemainHtml(s), 200, 'text/html; charset=utf-8');
      }

      /* ---- 余量查询接口 ---- */
      if (p === '/xk/query' && req.method === 'POST') {
        if (!sess || sess.expired) {
          s.log.push([nowStr(), 'query → 302 /login', sess && sess.expired ? '硬超时' : '无会话']);
          return redirect(res, '/login?next=/xk/query');   // ← 插件靠这个 302 判定掉线
        }
        return json(res, {
          code: 0,
          msg: 'ok',
          data: {
            rows: s.courses.map((c) => ({
              jxb_id: c.jxb_id, kch_id: c.kch_id, kcmc: c.kcmc, jsxm: c.jsxm,
              capacity: c.capacity, selected: c.selected, remain: remainOf(c)
            }))
          }
        });
      }

      /* ---- 选课提交接口 ---- */
      if (p === '/xk/submit' && req.method === 'POST') {
        if (!sess || sess.expired) {
          s.log.push([nowStr(), 'submit → 302 /login', sess && sess.expired ? '硬超时' : '无会话']);
          return redirect(res, '/login?next=/xk/submit');
        }
        const form = parseForm(await readBody(req), url);
        const id = form.jxb_id;
        const c = s.courses.find((x) => x.jxb_id === id);
        s.log.push([nowStr(), 'submit', id, sess && sess.left ? '' : '']);
        if (!c) return text(res, '{"code":2,"msg":"教学班不存在或参数错误"}', 200, 'application/json; charset=utf-8');

        if (remainOf(c) > 0) {
          c.selected += 1;
          s.fullAttempts[id] = 0;
          return json(res, { code: 0, msg: '选课成功', data: { jxb_id: id, remain: remainOf(c) } });
        }
        // 已满：连刷 N 次就要求验证码（用来验证插件会不会自动停机）
        s.fullAttempts[id] = (s.fullAttempts[id] || 0) + 1;
        if (s.fullAttempts[id] % CAPTCHA_EVERY === 0) {
          return text(res, '<html><body><h3>请输入验证码</h3><img src="/captcha.png"><input name="yzm"></body></html>',
            200, 'text/html; charset=utf-8');
        }
        return json(res, { code: 1, msg: '该教学班人数已满，请选择其他教学班', data: { jxb_id: id } });
      }

      if (p === '/captcha.png') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': 0 });
        return res.end();
      }

      /* ---- 兜底 ---- */
      if (p === '/favicon.ico') { res.writeHead(404); return res.end(); }
      return text(res, '404 Not Found: ' + p, 404);
    } catch (e) {
      return text(res, '500 ' + (e && e.message ? e.message : e), 500);
    }
  });

  server.on('close', () => { if (timer) clearInterval(timer); });
  server.mockState = s;
  return server;
}

/* ---------------- 直接运行时启动 ---------------- */
function parseArgv(argv) {
  const out = { port: DEFAULT_PORT, ttlMs: DEFAULT_TTL_MS, autoOpen: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i]) || DEFAULT_PORT;
    else if (argv[i] === '--ttl') out.ttlMs = (Number(argv[++i]) || 1200) * 1000;
    else if (argv[i] === '--no-auto-open') out.autoOpen = false;
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

const argv = parseArgv(process.argv.slice(2));
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (argv.help) {
    console.log('用法：node mock/server.mjs [--port 8787] [--ttl 秒] [--no-auto-open]');
  } else {
    const server = createMockServer(argv);
    server.listen(argv.port, '127.0.0.1', () => {
      console.log('模拟教务系统已启动： http://127.0.0.1:' + argv.port);
      console.log('  硬超时：' + Math.round(argv.ttlMs / 1000) + ' 秒    自动放名额：' + (argv.autoOpen ? '开' : '关'));
      console.log('  下一步：打开首页点「一键登录」→ 插件弹窗里把 127.0.0.1 加入白名单 → 刷新页面');
    });
  }
}
