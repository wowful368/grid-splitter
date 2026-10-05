#!/usr/bin/env node
/* =========================================================================
   切图助手 · 命令行版
   把图片按网格切分，支持等分 / 自定义比例 / 固定尺寸三种模式。

   【本项目由 AI 生成】人类提供需求、反馈与验收。
   功能设计参考在线工具 https://grid-splitter.tbpdt.top/ 的交互思路，
   未使用其任何代码（该站为 React 打包产物，此处为原生 JS 实现）。

   用法示例：
     node slice.js 图片.jpg
     node slice.js 图片.jpg -r 2 -c 2
     node slice.js 图片.jpg -o 输出目录 -r 3 -c 3 --png
     node slice.js 图片.jpg --crop 100,100,800,600 -r 2 -c 2
     node slice.js 图片.jpg --col-ratio 1,2,1 --row-ratio 1,1
     node slice.js 图片.jpg --tile 1080x1080 --remainder
     node slice.js 图片.jpg --name "{base}_{row}x{col}"
   命名模板可用占位符：{base} 原名 {row} 行号 {col} 列号
                        {w} 块宽 {h} 块高 {n} 序号
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// ---------------------------------------------------------------- 参数解析
function parseArgs(argv) {
  const o = {
    input: null, out: null, rows: null, cols: null,
    colRatio: null, rowRatio: null, tile: null,
    crop: null, png: false, quality: 92, remainder: false,
    name: '{base}_r{row}c{col}', prefix: '', quiet: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail('参数 ' + a + ' 缺少取值');
      return v;
    };
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-o' || a === '--out') o.out = next();
    else if (a === '-r' || a === '--rows') o.rows = parseInt(next(), 10);
    else if (a === '-c' || a === '--cols') o.cols = parseInt(next(), 10);
    else if (a === '--col-ratio') o.colRatio = next();
    else if (a === '--row-ratio') o.rowRatio = next();
    else if (a === '--tile') o.tile = next();
    else if (a === '--crop') o.crop = next();
    else if (a === '--png') o.png = true;
    else if (a === '--jpg') o.png = false;
    else if (a === '-q' || a === '--quality') o.quality = parseInt(next(), 10);
    else if (a === '--remainder') o.remainder = true;
    else if (a === '--name') o.name = next();
    else if (a === '--prefix') o.prefix = next();
    else if (a === '--quiet') o.quiet = true;
    else if (a.startsWith('-')) fail('未知参数: ' + a);
    else rest.push(a);
  }
  o.inputs = rest;
  return o;
}

function fail(msg) {
  console.error('错误: ' + msg);
  console.error('用 --help 查看用法');
  process.exit(2);
}

const USAGE = `
切图助手 · 命令行版

用法:
  node slice.js <图片...> [选项]

切分模式（三选一，默认按行列等分）:
  -r, --rows <n>          行数
  -c, --cols <n>          列数
      --col-ratio <列表>  列宽比，如 1,2,1
      --row-ratio <列表>  行高比，如 1,1
      --tile <宽x高>      按固定像素切，如 1080x1080

可选:
  -o, --out <目录>        输出目录（默认：图片同级的 <文件名>_切片）
      --crop <x,y,w,h>    先裁剪再切（像素坐标）
      --png               输出无损 PNG（默认 JPEG）
  -q, --quality <50-100>  JPEG 质量，默认 92
      --remainder         按尺寸切时，输出切不完的边缘余料
      --name <模板>       命名模板，默认 {base}_r{row}c{col}
                          占位符: {base} {row} {col} {w} {h} {n}
      --prefix <前缀>     文件名前缀
      --quiet             只输出结果摘要
  -h, --help              显示本帮助

示例:
  node slice.js a.jpg -r 2 -c 2
  node slice.js a.jpg -r 3 -c 3 --png -o ./out
  node slice.js a.jpg --tile 1080x1080 --remainder
  node slice.js a.jpg --crop 50,50,1200,1200 --col-ratio 1,2,1
`;

// ---------------------------------------------------------------- 工具
function parseRatio(str) {
  const parts = String(str).split(',').map((s) => parseFloat(s.trim()))
    .filter((n) => isFinite(n) && n > 0);
  if (!parts.length) fail('比例列表无效: ' + str);
  return parts;
}

// 把总长按比例分段，保证各段之和严格等于总长
function distribute(total, ratios) {
  const sum = ratios.reduce((a, b) => a + b, 0);
  const out = [];
  let used = 0;
  let acc = 0;
  for (let i = 0; i < ratios.length; i++) {
    acc += ratios[i];
    const end = Math.round((total * acc) / sum);
    out.push(end - used);
    used = end;
  }
  const diff = total - out.reduce((a, b) => a + b, 0);
  if (diff !== 0) out[out.length - 1] += diff;
  return out;
}

function parseCrop(str) {
  const p = String(str).split(',').map((s) => parseInt(s.trim(), 10));
  if (p.length !== 4 || p.some((n) => !isFinite(n))) fail('--crop 需为 x,y,w,h 四个整数');
  return { x: p[0], y: p[1], w: p[2], h: p[3] };
}

function parseTile(str) {
  const m = String(str).match(/^(\d+)\s*[x×*]\s*(\d+)$/i);
  if (!m) fail('--tile 格式应为 宽x高，如 1080x1080');
  return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
}

function renderName(tpl, ctx) {
  return tpl.replace(/\{(base|row|col|w|h|n)\}/g, (_, k) => String(ctx[k]));
}

// ---------------------------------------------------------------- 主流程
async function processOne(input, o) {
  if (!fs.existsSync(input)) fail('找不到文件: ' + input);
  const ext = path.extname(input);
  const base = path.basename(input, ext);

  const meta = await sharp(input).rotate().metadata();
  const W = meta.width, H = meta.height;
  // 注意：此处不预解码成 buffer。sharp 无参 toBuffer() 会按源格式重新编码，
  // 对 JPEG 源等于二次有损压缩；改为每个切块各自从源文件解码裁切。

  // 裁剪区域
  let crop = { x: 0, y: 0, w: W, h: H };
  if (o.crop) {
    crop = parseCrop(o.crop);
    crop.x = Math.max(0, Math.min(crop.x, W - 1));
    crop.y = Math.max(0, Math.min(crop.y, H - 1));
    crop.w = Math.max(1, Math.min(crop.w, W - crop.x));
    crop.h = Math.max(1, Math.min(crop.h, H - crop.y));
  }

  // 计算切块
  let tiles = [];
  let remainder = null;

  if (o.tile) {
    const t = parseTile(o.tile);
    const nCols = Math.max(1, Math.floor(crop.w / t.w));
    const nRows = Math.max(1, Math.floor(crop.h / t.h));
    for (let r = 0; r < nRows; r++) {
      for (let c = 0; c < nCols; c++) {
        tiles.push({ x: c * t.w, y: r * t.h, w: t.w, h: t.h });
      }
    }
    const usedW = nCols * t.w, usedH = nRows * t.h;
    if (o.remainder && (usedW < crop.w || usedH < crop.h)) {
      remainder = [];
      if (usedW < crop.w) remainder.push({ x: usedW, y: 0, w: crop.w - usedW, h: crop.h, tag: 'right' });
      if (usedH < crop.h) remainder.push({ x: 0, y: usedH, w: crop.w, h: crop.h - usedH, tag: 'bottom' });
    }
  } else {
    let colR, rowR;
    if (o.colRatio || o.rowRatio) {
      colR = o.colRatio ? parseRatio(o.colRatio) : [1];
      rowR = o.rowRatio ? parseRatio(o.rowRatio) : [1];
    } else {
      const nCols = o.cols || 1;
      const nRows = o.rows || 1;
      if (nCols < 1 || nRows < 1) fail('行数与列数必须为正整数');
      colR = new Array(nCols).fill(1);
      rowR = new Array(nRows).fill(1);
    }
    const ws = distribute(crop.w, colR);
    const hs = distribute(crop.h, rowR);
    let ax = 0;
    for (let ci = 0; ci < ws.length; ci++) {
      let ay = 0;
      for (let ri = 0; ri < hs.length; ri++) {
        tiles.push({ x: ax, y: ay, w: ws[ci], h: hs[ri] });
        ay += hs[ri];
      }
      ax += ws[ci];
    }
  }

  if (!tiles.length) fail('算不出任何切块，请检查参数');

  // 输出目录
  const outDir = o.out || path.join(path.dirname(input), base + '_切片');
  fs.mkdirSync(outDir, { recursive: true });

  // 行列号映射
  const xs = [...new Set(tiles.map((t) => t.x))].sort((a, b) => a - b);
  const ys = [...new Set(tiles.map((t) => t.y))].sort((a, b) => a - b);
  const pad = String(Math.max(xs.length, ys.length)).length;
  const outExt = o.png ? 'png' : 'jpg';
  const q = Math.max(50, Math.min(100, o.quality));

  const written = [];
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const ri = ys.indexOf(t.y) + 1;
    const ci = xs.indexOf(t.x) + 1;
    const nm = o.prefix + renderName(o.name, {
      base, row: String(ri).padStart(pad, '0'), col: String(ci).padStart(pad, '0'),
      w: t.w, h: t.h, n: i + 1,
    }) + '.' + outExt;

    // 直接从源文件解码后裁切。
    // 注意：不可先把 rotate() 的结果 toBuffer() 中转——sharp 无参 toBuffer()
    // 会按源格式重新编码（JPEG 源即二次有损压缩）。此处每块独立解码以保像素无损。
    let pipe = sharp(input).rotate().extract({
      left: crop.x + t.x, top: crop.y + t.y, width: t.w, height: t.h,
    });
    pipe = o.png ? pipe.png({ compressionLevel: 9 })
                 : pipe.jpeg({ quality: q, chromaSubsampling: '4:4:4' });
    const outPath = path.join(outDir, nm);
    await pipe.toFile(outPath);
    written.push({ name: nm, w: t.w, h: t.h, path: outPath });
  }

  // 余料
  if (remainder) {
    for (const p of remainder) {
      if (p.w < 1 || p.h < 1) continue;
      const nm = o.prefix + renderName(o.name, {
        base, row: 'x', col: 'x', w: p.w, h: p.h, n: 0,
      }) + '_remainder_' + p.tag + '.' + outExt;
      let pipe = sharp(input).rotate().extract({
        left: crop.x + p.x, top: crop.y + p.y, width: p.w, height: p.h,
      });
      pipe = o.png ? pipe.png({ compressionLevel: 9 })
                   : pipe.jpeg({ quality: q, chromaSubsampling: '4:4:4' });
      const outPath = path.join(outDir, nm);
      await pipe.toFile(outPath);
      written.push({ name: nm, w: p.w, h: p.h, path: outPath });
    }
  }

  // 逐块回读校验，防止写出损坏文件
  let bad = 0;
  for (const w of written) {
    const m = await sharp(w.path).metadata();
    if (m.width !== w.w || m.height !== w.h) {
      console.error('  ✗ 尺寸不符: ' + w.name + ' 期望 ' + w.w + 'x' + w.h +
        ' 实际 ' + m.width + 'x' + m.height);
      bad++;
    }
  }

  // 汇总
  const gCols = xs.length, gRows = ys.length;
  const sumW = [].concat(...[...new Set(tiles.map((t) => t.w))]);
  if (!o.quiet) {
    console.log('原图: ' + W + ' x ' + H);
    if (o.crop) console.log('裁剪区: ' + crop.w + ' x ' + crop.h + ' @ (' + crop.x + ',' + crop.y + ')');
    console.log('切分: ' + gRows + ' 行 x ' + gCols + ' 列 = ' + tiles.length + ' 块');
  }
  console.log('输出目录: ' + outDir);
  console.log('已写出 ' + written.length + ' 个文件' + (bad ? '（其中 ' + bad + ' 个尺寸异常）' : '，尺寸校验全部通过'));
  if (!o.quiet) {
    written.slice(0, 8).forEach((w) => console.log('  ' + w.name + '  ' + w.w + 'x' + w.h));
    if (written.length > 8) console.log('  … 其余 ' + (written.length - 8) + ' 个省略');
  }
  return { outDir, count: written.length, bad };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.inputs.length) {
    console.log(USAGE);
    process.exit(o.help ? 0 : 2);
  }
  let total = 0, bad = 0;
  for (const input of o.inputs) {
    if (o.inputs.length > 1) console.log('=== ' + path.basename(input) + ' ===');
    const r = await processOne(input, o);
    total += r.count;
    bad += r.bad;
  }
  if (bad) process.exit(1);
}

main().catch((e) => {
  console.error('失败: ' + e.message);
  process.exit(1);
});
