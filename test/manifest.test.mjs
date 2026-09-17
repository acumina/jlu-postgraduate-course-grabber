/* ============================================================
 * test/manifest.test.mjs —— manifest 与文件一致性自检
 * 目的：manifest 里写错文件名 / 忘了把文件加进 web_accessible_resources
 *       这类错误在浏览器里只表现为「静默不工作」，最容易踩，所以自动查。
 * 运行：node test/manifest.test.mjs
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(ROOT, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const exists = (rel) => existsSync(join(ROOT, rel));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('manifest: 基本字段', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.name && manifest.version);
  assert.ok(Array.isArray(manifest.permissions));
  assert.ok(Array.isArray(manifest.host_permissions));
  assert.ok(manifest.permissions.includes('storage'), '需要 storage 权限保存配置');
  assert.equal(manifest.background.type, 'module');
});

test('manifest: 引用的文件都存在', () => {
  assert.ok(exists(manifest.background.service_worker), 'service_worker 不存在: ' + manifest.background.service_worker);
  assert.ok(exists(manifest.action.default_popup), 'popup 不存在');
  for (const cs of manifest.content_scripts || []) {
    for (const js of cs.js || []) assert.ok(exists(js), 'content script 不存在: ' + js);
  }
  for (const war of manifest.web_accessible_resources || []) {
    for (const r of war.resources || []) {
      if (r.includes('*')) {
        /* 通配符（例如 archives/*.json 用于"项目内捆绑的课程档案"）：
         * 目录必须存在即可 —— 档案文件是用户自己往里放的，开始可能是空的。 */
        const dir = r.replace(/\/[^/]*\*.*$/, '');
        assert.ok(existsSync(join(ROOT, dir)), 'web_accessible_resource 的目录不存在: ' + dir);
      } else {
        assert.ok(exists(r), 'web_accessible_resource 不存在: ' + r);
      }
    }
  }
  for (const [size, p] of Object.entries(manifest.icons || {})) {
    assert.ok(exists(p), 'icon' + size + ' 不存在: ' + p);
  }
  for (const [size, p] of Object.entries((manifest.action || {}).default_icon || {})) {
    assert.ok(exists(p), 'action icon' + size + ' 不存在: ' + p);
  }
});

test('manifest: 所有 src 下的 js 都被引用（避免写了却没加载）', () => {
  const referenced = new Set();
  (manifest.content_scripts || []).forEach((cs) => (cs.js || []).forEach((f) => referenced.add(f.replace(/\\/g, '/'))));
  referenced.add(manifest.background.service_worker.replace(/\\/g, '/'));
  (manifest.web_accessible_resources || []).forEach((w) => (w.resources || []).forEach((f) => referenced.add(f.replace(/\\/g, '/'))));
  // popup.js 由 popup.html 引用
  const popupHtml = read(manifest.action.default_popup);
  const popupScripts = [...popupHtml.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const srcDir = join(ROOT, 'src');
  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p.replace(ROOT + '\\', '').replace(ROOT + '/', '').replace(/\\/g, '/'));
    }
  })(srcDir);
  for (const f of files) {
    const base = f.split('/').pop();
    const ok = referenced.has(f) || popupScripts.some((s) => s.endsWith(base));
    assert.ok(ok, 'src 下有文件没被 manifest 或 popup.html 引用: ' + f);
  }
});

test('manifest: content script 必须是普通脚本（不能出现顶层 import/export）', () => {
  for (const cs of manifest.content_scripts || []) {
    for (const f of cs.js || []) {
      const code = read(f);
      assert.ok(!/^\s*import\s/m.test(code), f + ' 里出现了 import —— content script 不能是 ES module');
      assert.ok(!/^\s*export\s/m.test(code), f + ' 里出现了 export —— content script 不能是 ES module');
    }
  }
});

test('manifest: bridge 必须可从页面加载（web_accessible_resources）', () => {
  const all = [];
  (manifest.web_accessible_resources || []).forEach((w) => (w.resources || []).forEach((r) => all.push(r)));
  const content = read('src/content.js');
  const used = [...content.matchAll(/getURL\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.ok(used.length > 0, 'content.js 里应该有 chrome.runtime.getURL(...)');
  for (const u of used) {
    assert.ok(all.includes(u), 'getURL("' + u + '") 用了但没写进 web_accessible_resources');
  }
});

test('manifest: 桥接发的每种消息，内容脚本都得有人接（否则会静默超时）', () => {
  /* 这是踩过的坑：bridge.js 回了 probe-values，但 content.js 的转发只处理
   * ready/capture/replay-result/pong/recording —— 页面明明答了却被丢掉，
   * 表现成「页面没有响应」超时，而且 csrfToken 取值也一起挂掉。 */
  const bridge = read('src/bridge.js');
  const content = read('src/content.js');

  const posted = new Set();
  for (const m of bridge.matchAll(/post\(\{\s*type:\s*'([^']+)'/g)) posted.add(m[1]);
  assert.ok(posted.size >= 4, 'bridge.js 里应该能解析出多种 post 消息，实际只有: ' + [...posted].join(','));

  // 无 id 的推送类消息必须显式处理
  for (const t of ['ready', 'capture']) {
    assert.ok(posted.has(t), 'bridge.js 应该会发 ' + t);
    assert.ok(new RegExp("d\\.type === '" + t + "'").test(content), 'content.js 没处理桥接消息：' + t);
  }
  // 带 id 的应答类消息：必须存在「按 id 兜底 resolve」的分支，而不是逐个硬编码 type
  assert.ok(/if \(d\.id && pending\.has\(d\.id\)\)\s*\{\s*resolvePending/.test(content),
    'content.js 缺少「按 id 兜底 resolve 页面应答」的分支 —— 以后新增消息类型会静默超时');
});

test('manifest: host_permissions 覆盖 content script 的 matches', () => {
  const hp = manifest.host_permissions || [];
  for (const cs of manifest.content_scripts || []) {
    for (const m of cs.matches || []) {
      const origin = m.replace(/\/\*$/, '/*');
      assert.ok(hp.includes(origin) || hp.includes(origin.replace(/\/\*$/, '/*')),
        'content script 的 matches(' + m + ') 不在 host_permissions 里，跨源发包会被拦');
    }
  }
});

test('回归: 登录页地址只允许白名单站点写入配置（真实事故：被 kitty.fo/login 覆盖）', () => {
  /* 事故经过：background 的注释原本写着"不管登录页在不在白名单域名下，只要 URL 像登录页
   * 就记下来"，判定规则是 loginUrlRe=/(login|sso|cas|auth)/ —— 用户逛到任何一个
   * 地址含 /login 的网站（https://kitty.fo/login）就把配置里的学校登录页**覆盖**了。
   * 更讽刺的是：这个系统真正的登录页 URL（.../xsxkapp/index.html）里没有 login/sso/cas/auth，
   * 所以那条规则**只能捡到误报、永远学不到正确值**。 */
  const bg = readFileSync(resolve(ROOT, 'src/background.js'), 'utf8');
  assert.ok(/if \(onSite && st0\.loginUrl !== tab\.url\)/.test(bg),
    '只有白名单站点上的 URL 才能写进 session.loginUrl');
  assert.ok(/只记"刚登录过"标记，不写入登录页配置/.test(bg),
    '外部域名的登录类页面只能标记"刚登录过"，不能写配置');
  // 精确学习：内容脚本看到登录/验证码输入框才记地址
  const content = readFileSync(resolve(ROOT, 'src/content.js'), 'utf8');
  assert.ok(/记下登录页地址（因为在这个页面上真的看到了登录\/验证码输入框）/.test(content),
    '要保留"看到登录表单才学习"的精确方式（URL 规则学不到本系统的登录页）');
});

test('全新环境: 内置预设必须能在没导入任何文件时一键配好', async () => {
  /* 真实缺口：默认白名单是空的 → 新装浏览器里面板在学校网站上根本不会出现，
   * 用户必须先去找 kx-config-*.json 再导入。内置预设把这一步变成一次点击。 */
  const js = manifest.content_scripts[0].js;
  assert.ok(js.includes('src/lib/presets.js'), 'presets.js 必须被注入（否则面板里没有预设可用）');
  assert.ok(js.indexOf('src/lib/presets.js') < js.indexOf('src/lib/config.js'), '预设要在 config 之前注入');

  await import('../src/lib/presets.js').catch(() => { });
  const P = globalThis.KXPresets || {};
  const keys = Object.keys(P);
  assert.ok(keys.length >= 1, '至少要有一个内置预设');
  const p = P[keys[0]];
  assert.deepEqual(p.sites, ['yjsxk.jlu.edu.cn'], '预设必须带生效站点，否则面板不会出现');
  assert.ok(/choiceCourse\.do/.test(p.submit.url), '提交模板要在');
  assert.ok(/loadGxkCourseInfo\.do/.test(p.query.url), '查询模板要在');
  assert.ok(/\{\{csrfToken\}\}/.test(p.submit.body), '提交体要带 csrfToken 占位符');
  assert.ok(p.submit.rules && p.submit.rules.full, '判定规则要在');
  assert.ok(/course\\\.html/.test(p.worker.urlRe), '引擎运行页面的限制要在');
  assert.equal(p.ui.mode, 'hybrid', 'UI 点击模式默认混合');
  assert.equal((p.targets || []).length, 0, '预设不能带 targets（选课清单是用户自己的）');
  /* 预设里**不该**有 enabled：它是"用户想让它跑"这个**运行时意图**，
   * 存独立的 storage 键（kx_want_running）。放进预设/配置文件的话，
   * 每次导入都会把用户的意图冲掉 —— 已经因此踩过两次事故。 */
  assert.equal('enabled' in p, false, '预设不该带 enabled（运行时意图，不归配置文件管）');
  assert.equal(p.debug.autoPush, false, '新环境没有本地收集器，预设不该打开自动推送');
  assert.ok(p.mine && /loadStdCourseInfo/.test(p.mine.url), '预设要带「已选课程」接口（判断选上没有的权威判据）');
  assert.equal('drop' in p, false, '退课不做自动化：预设里不该有 drop 段');
});

test('开源卫生: 内置预设必须与配置文件同步（改配置忘了重新生成预设会立刻暴露）', async () => {
  /* 为什么需要：内置预设（src/lib/presets.js）是从 kx-config-*.json 生成的。
   * 改了配置却忘了跑 node tools/make-preset.mjs，新装用户拿到的就是旧预设 ——
   * 这种漂移在本地看不出来（你用的是浏览器里的配置），只有新用户会踩到。 */
  const cfg = JSON.parse(readFileSync(resolve(ROOT, 'kx-config-吉大研究生选课.json'), 'utf8'));
  await import('../src/lib/presets.js').catch(() => { });
  const P = globalThis.KXPresets || {};
  const key = Object.keys(P)[0];
  assert.ok(key, '内置预设不存在');
  const p = P[key];
  // 预设与配置的差异只允许这三处（生成脚本刻意为之）
  const ignore = new Set(['_说明', 'targets', 'debug', 'enabled']);
  const drift = [];
  for (const k of Object.keys(cfg)) {
    if (ignore.has(k)) continue;
    if (JSON.stringify(cfg[k]) !== JSON.stringify(p[k])) drift.push(k);
  }
  assert.deepEqual(drift, [],
    '这些键在配置与内置预设之间不一致：' + drift.join('、') + ' —— 跑一次 node tools/make-preset.mjs');
  // 预设刻意清空的字段（新装用户不该带着别人的选课清单与本地收集器地址）
  assert.deepEqual(p.targets, [], '预设不能带 targets');
  assert.equal(p.debug.autoPush, false, '预设不能打开自动推送（新环境没有本地收集器）');
});

test('开源卫生: 仓库里不该出现 logs/（抓包与日志含学号/姓名/令牌）', () => {
  const gi = readFileSync(resolve(ROOT, '.gitignore'), 'utf8');
  assert.ok(/^logs\/$/m.test(gi), '.gitignore 必须排除 logs/');
  assert.ok(/^\*\.har$/m.test(gi), '.gitignore 必须排除 *.har');
  assert.ok(/^!test\/fixtures\/\*\.har$/m.test(gi), '但测试夹具要留例外（否则测试跑不了）');
  assert.ok(existsSync(join(ROOT, 'tools/scan-secrets.mjs')), '要有敏感信息扫描工具');
  assert.ok(existsSync(join(ROOT, 'tools/git-check.mjs')), '要有"哪些文件能上传"的核对工具');
  assert.ok(existsSync(join(ROOT, 'tools/install-hooks.mjs')), '要有提交前钩子安装器');
  assert.ok(existsSync(join(ROOT, 'docs/PUBLISH.md')), '要有发布检查清单');
  assert.ok(existsSync(join(ROOT, 'LICENSE')), '开源要带许可证');
});

test('开源卫生: 所有文本文件不能带 BOM（会让 JSON.parse 直接失败）', () => {
  /* 真实事故：用 PowerShell 的 Set-Content -Encoding UTF8 改配置文件会写入 BOM，
   * 于是 JSON.parse 报 "Unexpected token '﻿'"。
   * 对扩展来说这是**功能性 bug**：自动应用配置时是 fetch + JSON.parse 读这个文件的，
   * 带 BOM 就读不进来 → 自动配置失效。所以必须钉住。 */
  const roots = ['src', 'test', 'tools', 'mock', 'docs'];
  const bad = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|json|md|html|css|txt)$/i.test(name)) continue;
      const b = readFileSync(full);
      if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) bad.push(relative(ROOT, full));
    }
  }
  roots.forEach((r) => { if (existsSync(join(ROOT, r))) walk(join(ROOT, r)); });
  ['manifest.json', 'package.json', 'kx-config-吉大研究生选课.json', 'archives/index.json', 'README.md', 'LICENSE', '.gitignore', '.gitattributes']
    .forEach((f) => {
      const full = join(ROOT, f);
      if (!existsSync(full)) return;
      const b = readFileSync(full);
      if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) bad.push(f);
    });
  assert.deepEqual(bad, [], '这些文件带 BOM（改用 fs.writeFileSync 或编辑器保存为"UTF-8 无 BOM"）：' + bad.join('、'));
});

test('开源卫生: 所有 JSON 都能解析（发布物坏掉新用户直接用不了）', () => {
  const list = ['manifest.json', 'package.json', 'kx-config-吉大研究生选课.json', 'archives/index.json'];
  const archivesDir = join(ROOT, 'archives');
  if (existsSync(archivesDir)) {
    readdirSync(archivesDir).filter((f) => /\.json$/i.test(f)).forEach((f) => list.push('archives/' + f));
  }
  list.forEach((f) => {
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(ROOT, f), 'utf8')), f + ' 不是合法 JSON');
  });
});

test('全新环境: 面板要有「载入内置预设」按钮，且是整体覆盖而非深合并', () => {
  const panel = readFileSync(resolve(ROOT, 'src/panel.js'), 'utf8');
  assert.ok(/data-act="load-preset"/.test(panel), '要有载入预设按钮');
  assert.ok(/看起来还没配置/.test(panel), '未配置时要给出明显提示');
  const content = readFileSync(resolve(ROOT, 'src/content.js'), 'utf8');
  assert.ok(/opts && opts\.replace\) \? KX\.replace/.test(content),
    '载入预设要整体覆盖（KX.replace），否则旧配置的残留项会污染预设');
  assert.ok(existsSync(join(ROOT, 'tools/make-preset.mjs')), '要有重新生成预设的脚本（配置变了要能同步）');
});
