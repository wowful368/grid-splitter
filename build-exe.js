#!/usr/bin/env node
/* =========================================================================
   构建 Windows 单文件 EXE（基于 Node 24 内置 SEA）

   【本项目由 AI 生成】人类提供需求、反馈与验收。

   流程：
     1. 把网页资源（index.html/app.js/fflate/slice.js）转成 base64 内嵌模块
     2. 与 desktop-launcher.js 合并成单一入口脚本
     3. 生成 sea-config.json
     4. node --experimental-sea-config 生成 blob
     5. 复制 node.exe，用 postject 注入 blob 与图标
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const BUILD = path.join(ROOT, 'build-exe');
const OUT_EXE = path.join(ROOT, '切图助手.exe');

function log(msg) { console.log(msg); }

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
}

function main() {
  log('=== 构建 切图助手.exe ===\n');
  rmrf(BUILD);
  fs.mkdirSync(BUILD, { recursive: true });

  // ---------------------------------------------------------- 1. 收集资源
  const assets = {
    'index.html': path.join(ROOT, 'index.html'),
    'app.js': path.join(ROOT, 'app.js'),
    'slice.js': path.join(ROOT, 'slice.js'),
    '使用说明.md': path.join(ROOT, '使用说明.md'),
    [path.join('vendor', 'fflate.umd.js')]: path.join(ROOT, 'vendor', 'fflate.umd.js'),
  };

  const embedded = {};
  let totalBytes = 0;
  for (const [key, file] of Object.entries(assets)) {
    if (!fs.existsSync(file)) throw new Error('缺少资源文件: ' + file);
    const buf = fs.readFileSync(file);
    embedded[key] = buf.toString('base64');
    totalBytes += buf.length;
    log('  内嵌 ' + key.padEnd(28) + (buf.length / 1024).toFixed(1) + ' KB');
  }
  log('  资源合计 ' + (totalBytes / 1024).toFixed(1) + ' KB\n');

  // ---------------------------------------------------------- 2. 合成入口
  const launcher = fs.readFileSync(path.join(ROOT, 'desktop-launcher.js'), 'utf8');
  const assetsJs = 'global.__SPLITTER_ASSETS__ = ' + JSON.stringify(embedded) + ';\n';

  const entry = path.join(BUILD, 'entry.js');
  fs.writeFileSync(entry, assetsJs + launcher, 'utf8');
  log('  已生成合成入口 entry.js (' + (fs.statSync(entry).size / 1024).toFixed(1) + ' KB)');

  // ---------------------------------------------------------- 3. sea-config
  const blob = path.join(BUILD, 'sea-prep.blob');
  const seaConfig = path.join(BUILD, 'sea-config.json');
  fs.writeFileSync(seaConfig, JSON.stringify({
    main: entry,
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }, null, 2), 'utf8');
  log('  已生成 sea-config.json');

  // ---------------------------------------------------------- 4. 生成 blob
  log('\n  生成 SEA blob ...');
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], {
    stdio: 'inherit', cwd: BUILD,
  });
  if (!fs.existsSync(blob)) throw new Error('blob 生成失败');
  log('  blob 大小 ' + (fs.statSync(blob).size / 1024 / 1024).toFixed(1) + ' MB');

  // ---------------------------------------------------------- 5. 复制 node.exe
  log('\n  复制 node.exe 作为宿主 ...');
  fs.copyFileSync(process.execPath, OUT_EXE);
  log('  已复制到 ' + path.basename(OUT_EXE));

  // ---------------------------------------------------------- 6. postject 注入
  log('\n  注入 blob ...');
  // postject 随 Node 一起提供，位于 node 安装目录
  const nodeDir = path.dirname(process.execPath);
  const postjectCli = path.join(nodeDir, 'node_modules', 'postject', 'dist', 'cli.js');
  let injector;
  if (fs.existsSync(postjectCli)) {
    injector = { cmd: process.execPath, args: [postjectCli] };
    log('  使用 postject: ' + postjectCli);
  } else {
    // 回退：用 npx 调用
    injector = { cmd: 'npx', args: ['--yes', 'postject'] };
    log('  使用 npx postject');
  }

  const args = injector.args.concat([
    OUT_EXE,
    'NODE_SEA_BLOB', blob,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ]);
  if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');

  try {
    execFileSync(injector.cmd, args, { stdio: 'inherit', cwd: BUILD, shell: false });
  } catch (e) {
    // Windows 下 npx 需要 shell
    execFileSync(injector.cmd, args, { stdio: 'inherit', cwd: BUILD, shell: true });
  }

  const sizeMB = (fs.statSync(OUT_EXE).size / 1024 / 1024).toFixed(1);
  log('\n=== 构建完成 ===');
  log('  产物: ' + OUT_EXE);
  log('  大小: ' + sizeMB + ' MB');
}

main();
