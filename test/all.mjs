/* ============================================================
 * test/all.mjs —— 一次跑完所有自测（在同一个进程里，不 spawn 子进程）
 * 用法：node test/all.mjs
 *
 * 注意：不要用 `node --test test/`。测试运行器会用 child_process 抓子进程输出，
 * 在受限沙箱（禁止命名管道）下会直接报 spawn EPERM —— 那是环境限制，不是测试失败。
 * ============================================================ */
await import('./rules.test.mjs');
await import('./real-site.test.mjs');
await import('./manifest.test.mjs');
await import('./mock.test.mjs');
await import('./har2config.test.mjs');
await import('./panel.test.mjs');
await import('./collector.test.mjs');
await import('./shipped.test.mjs');   // 「随仓库发布的那套文件」能不能直接用
