#!/usr/bin/env node
/* =========================================================================
   切图助手 · 桌面版启动器

   【本项目由 AI 生成】人类提供需求、反馈与验收。
   功能设计参考在线工具 https://grid-splitter.tbpdt.top/ 的交互思路，
   未使用其任何代码。

   两种用法：
     1) 双击（不带参数）  -> 启动本地服务并打开浏览器，使用图形界面
     2) 带参数            -> 当作命令行切图工具使用，直接切图

   设计说明：
   - 网页资源（index.html / app.js / fflate）直接内嵌在本文件里，
     打包成单文件 exe 后无需外部依赖。
   - 用本地 HTTP 服务而非 file:// 打开，避免部分浏览器对本地文件的限制。
   ========================================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ---------------------------------------------------------------- 内嵌资源
// 构建时由 build-exe.js 注入（见文件末尾的 __EMBEDDED__ 检查）
const EMBEDDED = global.__SPLITTER_ASSETS__ || null;

function getAsset(name) {
  if (EMBEDDED && EMBEDDED[name] !== undefined) {
    return Buffer.from(EMBEDDED[name], 'base64');
  }
  // 未内嵌时（开发模式）回退到磁盘文件
  const p = path.join(__dirname, name);
  if (fs.existsSync(p)) return fs.readFileSync(p);
  return null;
}

// ---------------------------------------------------------------- 命令行模式
function isCliMode(argv) {
  if (argv.length === 0) return false;
  // 带 --help / --gui 视为特殊；其余有参数就走命令行
  if (argv.includes('--gui') || argv.includes('--serve')) return false;
  return true;
}

function runCli(argv) {
  // 复用同目录的 slice.js（打包时也会内嵌）
  const src = getAsset('slice.js');
  if (!src) {
    console.error('错误: 未找到 slice.js');
    process.exit(2);
  }
  // 为 slice.js 准备 require 环境
  const Module = require('module');
  const m = new Module('slice-cli', null);
  m.filename = path.join(__dirname, 'slice.js');
  m.paths = Module._nodeModulePaths(__dirname);
  try {
    m._compile(src.toString('utf8'), m.filename);
  } catch (e) {
    // slice.js 会自己调用 main，这里捕获以便友好提示
    if (!/process\.exit/.test(String(e))) console.error('执行失败: ' + e.message);
  }
}

// ---------------------------------------------------------------- 图形界面模式
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function startServer() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/' || rel === '') rel = '/index.html';

    // 安全：阻止路径穿越
    const safe = path.normalize(rel).replace(/^(\.\.[\/\\])+/, '').replace(/^[\/\\]/, '');
    const buf = getAsset(safe.replace(/\//g, path.sep)) || getAsset(safe);

    if (!buf) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 未找到: ' + safe);
      return;
    }
    const ext = path.extname(safe).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    // 端口 0 = 让系统分配空闲端口，避免占用冲突
    server.listen(0, '127.0.0.1', () => {
      resolve(server.address().port);
    });
  });
}

function openBrowser(url) {
  // Windows 用 start，macOS 用 open，Linux 用 xdg-open
  if (process.platform === 'win32') {
    // 注意：start 是 cmd 内建命令，需通过 cmd /c 调用
    execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  } else if (process.platform === 'darwin') {
    execFile('open', [url], () => {});
  } else {
    execFile('xdg-open', [url], () => {});
  }
}

async function runGui() {
  let port;
  try {
    port = await startServer();
  } catch (e) {
    console.error('启动本地服务失败: ' + e.message);
    process.exit(1);
  }
  const url = `http://127.0.0.1:${port}/index.html`;

  console.log('');
  console.log('  ┌────────────────────────────────────────────┐');
  console.log('  │        切图助手 · 桌面版 已启动            │');
  console.log('  └────────────────────────────────────────────┘');
  console.log('');
  console.log('  访问地址: ' + url);
  console.log('');
  console.log('  浏览器会自动打开。若未打开，请手动复制上面的地址访问。');
  console.log('');
  console.log('  图片只在本机处理，不会上传到任何服务器。');
  console.log('');
  console.log('  ─────────────────────────────────────────────');
  console.log('  关闭本窗口即可退出程序。');
  console.log('');

  openBrowser(url);

  // 保持进程存活
  process.on('SIGINT', () => process.exit(0));
}

// ---------------------------------------------------------------- 入口
function main() {
  const argv = process.argv.slice(2);
  if (isCliMode(argv)) runCli(argv);
  else runGui();
}

main();
