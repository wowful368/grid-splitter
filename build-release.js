/* =========================================================================
   构建发布用压缩包（用于 GitHub Releases）

   【本项目由 AI 生成】人类提供需求、反馈与验收。

   产出：
     grid-splitter-web.zip   手机/电脑网页版，解压即用
     grid-splitter-full.zip  完整项目，含命令行版与文档

   说明：ZIP 打包使用项目内已内置的 fflate 库（vendor/fflate.umd.js），
   不依赖任何外部工具，也不手写压缩格式。
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'build');
const fflate = require(path.join(ROOT, 'vendor', 'fflate.umd.js'));

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel));
}

fs.mkdirSync(OUT, { recursive: true });

// 用 fflate 打包：以 Uint8Array 形式收集文件
function pack(entries) {
  const obj = {};
  for (const [name, content] of entries) {
    obj[name] = new Uint8Array(content);
  }
  // level 9 = 最高压缩率；ZIP 用 UTF-8 文件名（fflate 自动处理）
  return fflate.zipSync(obj, { level: 9 });
}

// ---------------------------------------------------------------- 手机说明
const MOBILE_README = [
  '================================================',
  '  Grid Splitter · 切图助手（网页版）',
  '================================================',
  '',
  '【电脑上使用】',
  '',
  '  双击 index.html 即可。不用安装任何东西，不用联网。',
  '',
  '------------------------------------------------',
  '',
  '【手机上使用】',
  '',
  '  重要：不要只传 index.html！必须整个文件夹一起传，',
  '  保持下面这个目录结构，否则打开会白屏：',
  '',
  '      index.html',
  '      app.js',
  '      vendor/fflate.umd.js',
  '',
  '  方法一（推荐，最简单）：',
  '    用微信/QQ 把整个压缩包发到手机，手机上解压后，',
  '    用文件管理器找到 index.html，长按 ->「打开方式」',
  '    -> 选择浏览器（Chrome / Edge / 夸克 等）。',
  '',
  '  方法二：',
  '    用数据线把整个文件夹拷到手机存储，同样方式打开。',
  '',
  '  如果打不开、或打开是白屏：',
  '    这是手机浏览器对本地文件的限制（安全策略），不是文件坏了。',
  '    解决办法：',
  '      a) 换 Chrome / Edge 浏览器打开',
  '      b) 或者用在线版（无需下载，直接访问网址）',
  '',
  '------------------------------------------------',
  '',
  '【能做什么】',
  '',
  '  - 选择或拖入图片（JPG / PNG / WebP）',
  '  - 拖动裁剪框，只切选中的部分',
  '  - 裁剪形状可选：自定义 / 正方形 / 固定比例',
  '  - 实时预览切分线和编号',
  '  - 等分 / 按固定像素 / 自定义比例 三种切法',
  '  - 一键导出 ZIP，里面是所有切块',
  '',
  '【隐私】',
  '',
  '  完全离线运行。图片只在你的设备上处理，',
  '  不会上传到任何服务器。',
  '',
].join('\r\n');

// ---------------------------------------------------------------- 包 1：网页版
const webZip = pack([
  ['index.html', read('index.html')],
  ['app.js', read('app.js')],
  [path.posix.join('vendor', 'fflate.umd.js'), read(path.join('vendor', 'fflate.umd.js'))],
  ['手机使用说明.txt', Buffer.from(MOBILE_README, 'utf8')],
  ['LICENSE', read('LICENSE')],
]);

// ---------------------------------------------------------------- 包 2：完整项目
const fullZip = pack([
  ['index.html', read('index.html')],
  ['app.js', read('app.js')],
  [path.posix.join('vendor', 'fflate.umd.js'), read(path.join('vendor', 'fflate.umd.js'))],
  ['slice.js', read('slice.js')],
  ['desktop-launcher.js', read('desktop-launcher.js')],
  ['build-exe.js', read('build-exe.js')],
  ['build-release.js', read('build-release.js')],
  ['package.json', read('package.json')],
  ['README.md', read('README.md')],
  ['README.zh-CN.md', read('README.zh-CN.md')],
  ['使用说明.md', read('使用说明.md')],
  ['LICENSE', read('LICENSE')],
  ['.gitignore', read('.gitignore')],
]);

const webPath = path.join(OUT, 'grid-splitter-web.zip');
const fullPath = path.join(OUT, 'grid-splitter-full.zip');
fs.writeFileSync(webPath, Buffer.from(webZip));
fs.writeFileSync(fullPath, Buffer.from(fullZip));

console.log('已生成:');
console.log('  build/grid-splitter-web.zip    ' + (webZip.length / 1024).toFixed(1) + ' KB  （手机/电脑网页版）');
console.log('  build/grid-splitter-full.zip   ' + (fullZip.length / 1024).toFixed(1) + ' KB  （完整项目）');
