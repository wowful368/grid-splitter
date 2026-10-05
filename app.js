/* =========================================================================
   切图助手 · 本地版
   纯浏览器端图片网格切分工具，图片不离开本机。
   依赖：fflate（本地 vendor 目录，用于 ZIP 打包）

   【本项目由 AI 生成】人类提供需求、反馈与验收。
   功能设计参考在线工具 https://grid-splitter.tbpdt.top/ 的交互思路，
   未使用其任何代码（该站为 React 打包产物，此处为原生 JS 实现）。
   ========================================================================= */
(function () {
  'use strict';

  // ---------------------------------------------------------------- 状态
  var state = {
    items: [],        // {file, name, url, img, w, h}
    current: -1,      // 当前编辑的图片索引
    mode: 'even',     // even | size | custom
    crop: { x: 0, y: 0, w: 1, h: 1 }, // 相对原图的归一化裁剪框
    shape: 'free',    // free(自定义) | square(正方形) | ratio(固定比例)
    ratio: 1,         // shape='ratio' 时的宽高比（宽/高）
    autoAlign: true,  // 等分时自动微调裁剪尺寸，保证每块完全相等
    dragging: null,   // 当前拖拽类型
    dragStart: null,
    outputs: []       // 导出产生的 blob url，用于释放
  };

  // ---------------------------------------------------------------- 元素
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), dropzone = $('dropzone'), stageCanvas = $('stageCanvas');
  var baseImg = $('baseImg'), overlay = $('overlay'), octx = overlay.getContext('2d');
  var statusBadge = $('statusBadge'), previewMeta = $('previewMeta');
  var btnExport = $('btnExport'), btnReset = $('btnReset'), btnClear = $('btnClear');
  var useCrop = $('useCrop'), lossless = $('lossless'), keepRemainder = $('keepRemainder');
  var autoAlign = $('autoAlign');
  var shapeBox = $('shapeBox'), shapeSeg = $('shapeSeg'), ratioRow = $('ratioRow');
  var ratioInput = $('ratioInput'), ratioPresets = $('ratioPresets');
  var quality = $('quality'), qualityVal = $('qualityVal'), rowQuality = $('rowQuality');
  var resultPanel = $('resultPanel'), resultMsg = $('resultMsg'), resultList = $('resultList');
  var multiPanel = $('multiPanel'), multiList = $('multiList');

  // ---------------------------------------------------------------- 工具
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function parseRatio(str, fallbackCount) {
    var parts = String(str).split(',').map(function (s) { return parseFloat(s.trim()); })
      .filter(function (n) { return isFinite(n) && n > 0; });
    if (!parts.length) return null;
    return parts;
  }

  // 按比例把总长度切成若干段，余数逐段分配，保证各段之和严格等于总长
  function distribute(total, ratios) {
    var sum = ratios.reduce(function (a, b) { return a + b; }, 0);
    var out = [], used = 0;
    for (var i = 0; i < ratios.length; i++) {
      var end = Math.round((total * ratios.slice(0, i + 1).reduce(function (a, b) { return a + b; }, 0)) / sum);
      out.push(end - used);
      used = end;
    }
    // 修正累计取整可能产生的偏差
    var diff = total - out.reduce(function (a, b) { return a + b; }, 0);
    if (diff !== 0) out[out.length - 1] += diff;
    return out;
  }

  // 计算当前参数下的切块布局（返回归一化坐标，稍后乘实际尺寸）
  function computeTiles() {
    var src = currentItem();
    if (!src) return null;

    // 1) 先确定裁剪区域（像素）
    var cropPx = useCrop.checked
      ? {
          x: Math.round(state.crop.x * src.w),
          y: Math.round(state.crop.y * src.h),
          w: Math.round(state.crop.w * src.w),
          h: Math.round(state.crop.h * src.h)
        }
      : { x: 0, y: 0, w: src.w, h: src.h };
    cropPx.w = Math.max(1, cropPx.w);
    cropPx.h = Math.max(1, cropPx.h);

    var tiles = [];   // {x,y,w,h} 相对裁剪区左上角
    var outer = null; // 余料块
    var aligned = null; // 若发生整除对齐，记录调整信息供界面提示

    // 把裁剪区尺寸收敛成行列数的整数倍，使每块尺寸完全相等。
    // 仅在「开启了裁剪」且为等分模式时生效：
    // 未开裁剪时应切完整原图，不应擅自裁掉边缘像素。
    function alignCrop(nCols, nRows) {
      if (!state.autoAlign || state.mode === 'size' || !useCrop.checked) return;
      if (!isFinite(nCols) || !isFinite(nRows) || nCols < 1 || nRows < 1) return;
      var nw = Math.floor(cropPx.w / nCols) * nCols;
      var nh = Math.floor(cropPx.h / nRows) * nRows;
      if (nw < 1 || nh < 1) return;
      if (nw !== cropPx.w || nh !== cropPx.h) {
        aligned = { fromW: cropPx.w, fromH: cropPx.h, toW: nw, toH: nh };
        // 保持中心不变
        cropPx.x = Math.round(cropPx.x + (cropPx.w - nw) / 2);
        cropPx.y = Math.round(cropPx.y + (cropPx.h - nh) / 2);
        cropPx.w = nw;
        cropPx.h = nh;
        // 钳制回图片范围内
        cropPx.x = Math.max(0, Math.min(cropPx.x, src.w - nw));
        cropPx.y = Math.max(0, Math.min(cropPx.y, src.h - nh));
      }
      // 正方形模式下对齐后仍需保持正方
      if (state.shape === 'square') {
        var side = Math.min(cropPx.w, cropPx.h);
        cropPx.w = side; cropPx.h = side;
      }
    }

    if (state.mode === 'size') {
      // 按固定像素尺寸切分
      var tw = Math.max(1, parseInt($('tileW').value, 10) || 1);
      var th = Math.max(1, parseInt($('tileH').value, 10) || 1);
      var cols = Math.max(1, Math.floor(cropPx.w / tw));
      var rows = Math.max(1, Math.floor(cropPx.h / th));
      var usedW = cols * tw, usedH = rows * th;
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          tiles.push({ x: c * tw, y: r * th, w: tw, h: th });
        }
      }
      if (keepRemainder.checked && (usedW < cropPx.w || usedH < cropPx.h)) {
        outer = {
          tiles: [],
          x: usedW, y: 0, w: cropPx.w - usedW, h: cropPx.h,
          x2: 0, y2: usedH, w2: cropPx.w, h2: cropPx.h - usedH
        };
      }
    } else if (state.mode === 'custom') {
      var colR = parseRatio($('colRatio').value) || [1];
      var rowR = parseRatio($('rowRatio').value) || [1];
      // 自定义比例模式下不对齐（比例本身已决定分段，强行整除会破坏比例）
      var ws = distribute(cropPx.w, colR);
      var hs = distribute(cropPx.h, rowR);
      var ax = 0;
      for (var ci = 0; ci < ws.length; ci++) {
        var ay = 0;
        for (var ri = 0; ri < hs.length; ri++) {
          tiles.push({ x: ax, y: ay, w: ws[ci], h: hs[ri] });
          ay += hs[ri];
        }
        ax += ws[ci];
      }
    } else {
      // 等分
      var nCols = clamp(parseInt($('cols').value, 10) || 1, 1, 100);
      var nRows = clamp(parseInt($('rows').value, 10) || 1, 1, 100);
      // 先把裁剪区收敛成行列数的整数倍，保证每块尺寸完全相等
      alignCrop(nCols, nRows);
      var wArr = distribute(cropPx.w, new Array(nCols).fill(1));
      var hArr = distribute(cropPx.h, new Array(nRows).fill(1));
      var bx = 0;
      for (var i2 = 0; i2 < wArr.length; i2++) {
        var by = 0;
        for (var j = 0; j < hArr.length; j++) {
          tiles.push({ x: bx, y: by, w: wArr[i2], h: hArr[j] });
          by += hArr[j];
        }
        bx += wArr[i2];
      }
    }

    return { crop: cropPx, tiles: tiles, outer: outer, src: src, aligned: aligned };
  }

  function currentItem() {
    return state.current >= 0 ? state.items[state.current] : null;
  }

  // ---------------------------------------------------------------- 绘制
  // overlay 相对图片区域外扩的像素数：让贴边手柄落在 overlay 实体内，
  // 否则裁剪框贴边时鼠标位于元素边界外，pointerdown 根本不会触发。
  var OVERLAY_PAD = 12;

  function syncCanvasSize() {
    var img = baseImg;
    var r = img.getBoundingClientRect();
    var host = stageCanvas.getBoundingClientRect();
    // 图片在 overlay 内缩进 OVERLAY_PAD 像素
    overlay.style.left = (r.left - host.left - OVERLAY_PAD) + 'px';
    overlay.style.top = (r.top - host.top - OVERLAY_PAD) + 'px';
    overlay.style.width = (r.width + OVERLAY_PAD * 2) + 'px';
    overlay.style.height = (r.height + OVERLAY_PAD * 2) + 'px';
    var dpr = window.devicePixelRatio || 1;
    overlay.width = Math.round((r.width + OVERLAY_PAD * 2) * dpr);
    overlay.height = Math.round((r.height + OVERLAY_PAD * 2) * dpr);
  }

  // 图片在 overlay 内的实际绘制区域（CSS 像素）
  function imgRectInOverlay() {
    var w = overlay.clientWidth - OVERLAY_PAD * 2;
    var h = overlay.clientHeight - OVERLAY_PAD * 2;
    return { x: OVERLAY_PAD, y: OVERLAY_PAD, w: w, h: h };
  }

  // 把屏幕坐标换算成相对图片的归一化坐标（0~1，可略微越界）
  function toNorm(clientX, clientY) {
    var r = overlay.getBoundingClientRect();
    var ir = imgRectInOverlay();
    return {
      x: (clientX - r.left - ir.x) / ir.w,
      y: (clientY - r.top - ir.y) / ir.h,
    };
  }

  function draw() {
    var src = currentItem();
    if (!src) return;
    syncCanvasSize();

    var cssW = overlay.clientWidth, cssH = overlay.clientHeight;
    var dpr = window.devicePixelRatio || 1;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, cssW, cssH);

    var layout = computeTiles();
    if (!layout) return;
    var crop = layout.crop;

    // 统一坐标系：图片区域在 overlay 内的矩形
    var IR = imgRectInOverlay();
    // 图片像素 -> overlay CSS 像素 的比例
    var sx = IR.w / src.w, sy = IR.h / src.h;
    // 裁剪区在 overlay 中的矩形
    var cropRectL = IR.x + crop.x * sx;
    var cropRectT = IR.y + crop.y * sy;
    var cropRectW = crop.w * sx;
    var cropRectH = crop.h * sy;

    // 裁剪区之外的遮罩
    if (useCrop.checked) {
      octx.save();
      octx.fillStyle = 'rgba(6,8,12,.66)';
      octx.beginPath();
      octx.rect(IR.x, IR.y, IR.w, IR.h);
      octx.rect(cropRectL, cropRectT, cropRectW, cropRectH);
      octx.fill('evenodd');
      octx.restore();
    }

    // 切分线（含最后一行/列的外边线）
    octx.save();
    octx.lineWidth = 1.25;
    octx.strokeStyle = 'rgba(91,140,255,.95)';
    octx.shadowColor = 'rgba(0,0,0,.85)';
    octx.shadowBlur = 3;
    var vLines = {}, hLines = {};
    layout.tiles.forEach(function (t) {
      vLines[t.x] = 1;
      vLines[t.x + t.w] = 1;
      hLines[t.y] = 1;
      hLines[t.y + t.h] = 1;
    });
    Object.keys(vLines).forEach(function (vx) {
      var X = cropRectL + (+vx) * sx;
      line(X, cropRectT, X, cropRectT + cropRectH);
    });
    Object.keys(hLines).forEach(function (vy) {
      var Y = cropRectT + (+vy) * sy;
      line(cropRectL, Y, cropRectL + cropRectW, Y);
    });
    octx.restore();

    // 块序号
    octx.save();
    octx.font = '600 11px "Microsoft YaHei",sans-serif';
    octx.textAlign = 'left';
    octx.textBaseline = 'top';
    layout.tiles.forEach(function (t, i) {
      var label = String(i + 1);
      var lx = cropRectL + t.x * sx + 4;
      var ly = cropRectT + t.y * sy + 4;
      var wpx = octx.measureText(label).width;
      octx.fillStyle = 'rgba(10,12,18,.72)';
      octx.fillRect(lx - 2, ly - 1, wpx + 6, 14);
      octx.fillStyle = '#9db4ff';
      octx.fillText(label, lx + 1, ly);
    });
    octx.restore();

    // 裁剪框边框与手柄
    if (useCrop.checked) {
      octx.save();
      octx.strokeStyle = '#ffb454';
      octx.lineWidth = 1.5;
      octx.setLineDash([6, 4]);
      octx.strokeRect(cropRectL, cropRectT, cropRectW, cropRectH);
      octx.setLineDash([]);
      octx.fillStyle = '#ffb454';
      var hs = 5;
      [[cropRectL, cropRectT],
       [cropRectL + cropRectW, cropRectT],
       [cropRectL, cropRectT + cropRectH],
       [cropRectL + cropRectW, cropRectT + cropRectH],
       [cropRectL + cropRectW / 2, cropRectT],
       [cropRectL + cropRectW / 2, cropRectT + cropRectH],
       [cropRectL, cropRectT + cropRectH / 2],
       [cropRectL + cropRectW, cropRectT + cropRectH / 2]].forEach(function (p) {
        octx.fillRect(p[0] - hs, p[1] - hs, hs * 2, hs * 2);
      });
      octx.restore();
    }

    // 更新信息栏
    var px = layout.crop;
    var shapeNote = '';
    if (useCrop.checked) {
      if (state.shape === 'square') {
        shapeNote = (px.w === px.h)
          ? ' <span style="color:var(--ok)">✓ 正方形</span>'
          : ' <span style="color:var(--warn)">非正方形</span>';
      } else if (state.shape === 'ratio') {
        shapeNote = ' <span style="color:var(--ok)">比例 ' + state.ratio.toFixed(3) + '</span>';
      }
    }
    previewMeta.innerHTML =
      '原图: <b>' + src.w + ' × ' + src.h + '</b><br>' +
      '裁剪区: <b>' + px.w + ' × ' + px.h + '</b>' + shapeNote + '<br>' +
      '切块数: <b>' + layout.tiles.length + '</b>' +
      (layout.tiles.length ? '（单块 ' + layout.tiles[0].w + ' × ' + layout.tiles[0].h + '）' : '') +
      (layout.aligned
        ? '<br><span style="color:var(--muted)">已微调为可整除: ' +
          layout.aligned.fromW + '×' + layout.aligned.fromH + ' → ' +
          layout.aligned.toW + '×' + layout.aligned.toH + '</span>'
        : '') +
      (layout.outer ? '<br><span style="color:var(--warn)">另有边缘余料待输出</span>' : '');

    stageCanvas.style.display = '';
    dropzone.style.display = 'none';
    btnExport.disabled = false;
    btnReset.disabled = !useCrop.checked;
    btnClear.disabled = false;
    statusBadge.textContent = '已载入 · ' + src.name.slice(0, 22);
    rowQuality.style.display = lossless.checked ? 'none' : '';
  }

  function line(x1, y1, x2, y2) {
    octx.beginPath();
    octx.moveTo(x1, y1);
    octx.lineTo(x2, y2);
    octx.stroke();
  }

  // ---------------------------------------------------------------- 裁剪形状约束
  // 关键：裁剪框用归一化坐标，但正方形/比例必须在【像素】层面成立。
  // 设图片宽 W、高 H，归一化尺寸 (nw, nh) 对应的像素尺寸为 (nw*W, nh*H)。
  // 要求像素宽高比 = k，即 (nw*W)/(nh*H) = k  =>  nh = nw * W / (k * H)。
  function ratioK() {
    return state.shape === 'square' ? 1 : (state.shape === 'ratio' ? state.ratio : 0);
  }

  // 由归一化宽度推出满足比例的归一化高度
  function hFromW(nw, k) {
    var it = currentItem();
    if (!it || !k) return null;
    return nw * it.w / (k * it.h);
  }

  // 由归一化高度推出满足比例的归一化宽度
  function wFromH(nh, k) {
    var it = currentItem();
    if (!it || !k) return null;
    return nh * k * it.h / it.w;
  }

  // 把裁剪框收敛到合法范围（不出画布）并满足形状约束
  function constrainCrop(c, anchor) {
    var k = ratioK();
    var x = c.x, y = c.y, w = c.w, h = c.h;
    var min = 0.01;

    if (k) {
      // 以调用方给定的基准边为准，推导另一边
      if (anchor === 'h') {
        w = wFromH(h, k);
      } else {
        h = hFromW(w, k);
      }
      if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return { x: x, y: y, w: min, h: min };
      // 若超出画布，按能放下的最大尺寸等比缩小
      var scale = 1;
      if (x + w > 1) scale = Math.min(scale, (1 - x) / w);
      if (y + h > 1) scale = Math.min(scale, (1 - y) / h);
      if (scale < 1) { w *= scale; h *= scale; }
      // 仍越界则贴边
      if (x + w > 1) x = 1 - w;
      if (y + h > 1) y = 1 - h;
    }

    // 尺寸下限
    if (w < min) {
      w = min;
      if (k) h = hFromW(w, k);
    }
    if (h < min) {
      h = min;
      if (k) w = wFromH(h, k);
    }
    // 位置钳制
    x = clamp(x, 0, Math.max(0, 1 - w));
    y = clamp(y, 0, Math.max(0, 1 - h));

    return { x: x, y: y, w: w, h: h };
  }

  // 切换形状时，让当前裁剪框立即符合新形状
  function applyShapeToCrop() {
    var it = currentItem();
    if (!it) return;
    var k = ratioK();
    if (!k) return; // 自由模式无需调整

    var c = state.crop;
    // 若当前是全图，则以图片中心为基准取能放下的最大合规框
    var cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    var nw, nh;
    if (isFullCrop()) {
      if (k >= 1) {
        // 宽比高大（或正方形）：宽度受限
        nw = 1;
        nh = hFromW(nw, k);
        if (nh > 1) { nh = 1; nw = wFromH(nh, k); }
      } else {
        nh = 1;
        nw = wFromH(nh, k);
        if (nw > 1) { nw = 1; nh = hFromW(nw, k); }
      }
      cx = 0.5; cy = 0.5;
    } else {
      // 保持中心，按当前宽度推导
      nw = c.w;
      nh = hFromW(nw, k);
      if (nh > 1) { nh = 1; nw = wFromH(nh, k); }
    }
    state.crop = constrainCrop({
      x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh,
    }, 'w');
  }

  // ---------------------------------------------------------------- 交互：裁剪框
  function isFullCrop() {
    var c = state.crop;
    return c.x <= 0.0005 && c.y <= 0.0005 && c.w >= 0.999 && c.h >= 0.999;
  }

  function hitTest(px, py) {
    var n = toNorm(px, py);
    var x = n.x, y = n.y;
    // 裁剪框铺满全图时，任何位置都应开始框选新区域
    if (isFullCrop()) return 'new';

    var c = state.crop;
    // 判定阈值按「图片显示尺寸」换算成归一化值，保证不同尺寸下灵敏度一致
    var IR = imgRectInOverlay();
    var tx = Math.max(10, Math.min(18, IR.w * 0.04)) / IR.w;
    var ty = Math.max(10, Math.min(18, IR.h * 0.04)) / IR.h;

    var L = c.x, T = c.y, R = c.x + c.w, B = c.y + c.h;
    var nearL = Math.abs(x - L) <= tx, nearR = Math.abs(x - R) <= tx;
    var nearT = Math.abs(y - T) <= ty, nearB = Math.abs(y - B) <= ty;

    // 角落手柄优先（判据放宽，便于抓取）
    var cx2 = tx * 1.6, cy2 = ty * 1.6;
    if (Math.abs(x - L) <= cx2 && Math.abs(y - T) <= cy2) return 'nw';
    if (Math.abs(x - R) <= cx2 && Math.abs(y - T) <= cy2) return 'ne';
    if (Math.abs(x - L) <= cx2 && Math.abs(y - B) <= cy2) return 'sw';
    if (Math.abs(x - R) <= cx2 && Math.abs(y - B) <= cy2) return 'se';
    // 边线手柄
    if (nearL && y > T && y < B) return 'w';
    if (nearR && y > T && y < B) return 'e';
    if (nearT && x > L && x < R) return 'n';
    if (nearB && x > L && x < R) return 's';
    // 内部 = 移动
    if (x > L && x < R && y > T && y < B) return 'move';
    return 'new';
  }

  overlay.style.pointerEvents = 'auto';
  overlay.style.cursor = 'default';

  overlay.addEventListener('pointerdown', function (e) {
    if (!currentItem() || !useCrop.checked) return;
    var n0 = toNorm(e.clientX, e.clientY);
    var x = clamp(n0.x, 0, 1);
    var y = clamp(n0.y, 0, 1);
    var hit = hitTest(e.clientX, e.clientY);
    state.dragStart = { x: x, y: y, crop: Object.assign({}, state.crop), hit: hit };

    if (hit === 'new') {
      // 从按下点开始拉一个新框；方向由起点到终点的相对位置决定
      state.crop = { x: x, y: y, w: 0.001, h: 0.001 };
      state.dragging = 'newbox';
    } else {
      state.dragging = hit;
    }

    try { overlay.setPointerCapture(e.pointerId); } catch (err) {}
    draw();
    e.preventDefault();
  });

  overlay.addEventListener('pointermove', function (e) {
    if (!state.dragging) {
      if (currentItem() && useCrop.checked) {
        var h = hitTest(e.clientX, e.clientY);
        var cur = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
                    n: 'ns-resize', s: 'ns-resize', w: 'ew-resize', e: 'ew-resize',
                    move: 'move', new: 'crosshair' }[h];
        overlay.style.cursor = cur || 'default';
      }
      return;
    }
    var n1 = toNorm(e.clientX, e.clientY);
    var x = clamp(n1.x, 0, 1);
    var y = clamp(n1.y, 0, 1);
    var s = state.dragStart, c = s.crop, d = state.dragging;
    var nx = c.x, ny = c.y, nw = c.w, nh = c.h;

    if (d === 'newbox') {
      // 从起点向当前点拉框
      var x0 = s.x, y0 = s.y;
      var k = ratioK();
      if (k) {
        // 有形状约束：以拖动位移中较大的那一边为准，保证手感自然
        var dw = Math.abs(x - x0), dh = Math.abs(y - y0);
        var useW = dw >= wFromH(dh, k) ? dw : wFromH(dh, k);
        nw = useW;
        nh = hFromW(nw, k);
        nx = (x < x0) ? x0 - nw : x0;
        ny = (y < y0) ? y0 - nh : y0;
        // 越界时改为从起点向反方向生长
        if (nx < 0 || ny < 0 || nx + nw > 1 || ny + nh > 1) {
          nx = clamp(nx, 0, Math.max(0, 1 - nw));
          ny = clamp(ny, 0, Math.max(0, 1 - nh));
          if (nw > 1) { nw = 1; nh = hFromW(nw, k); ny = clamp(ny, 0, Math.max(0, 1 - nh)); }
          if (nh > 1) { nh = 1; nw = wFromH(nh, k); nx = clamp(nx, 0, Math.max(0, 1 - nw)); }
        }
      } else {
        nx = Math.min(x0, x); ny = Math.min(y0, y);
        nw = Math.abs(x - x0); nh = Math.abs(y - y0);
        // 自由模式下按住 Shift 临时锁正方形
        if (e.shiftKey) {
          var sideW = Math.min(nw, wFromH(nh, 1) || nw);
          nw = sideW; nh = hFromW(nw, 1);
          if (x < x0) nx = x0 - nw;
          if (y < y0) ny = y0 - nh;
        }
      }
      if (nw < 0.01) nw = 0.01;
      if (nh < 0.01) nh = 0.01;
      state.crop = constrainCrop({ x: nx, y: ny, w: nw, h: nh }, 'w');
    } else if (d === 'move') {
      nx = clamp(c.x + (x - s.x), 0, Math.max(0, 1 - c.w));
      ny = clamp(c.y + (y - s.y), 0, Math.max(0, 1 - c.h));
      state.crop = { x: nx, y: ny, w: c.w, h: c.h };
    } else {
      var kk = ratioK();
      if (kk) {
        // 有形状约束时，按拖动的边驱动，另一边由比例推出
        var hasW = d.indexOf('w') > -1, hasE = d.indexOf('e') > -1;
        var hasN = d.indexOf('n') > -1, hasS = d.indexOf('s') > -1;
        var driven, wantW, wantH;

        if (hasW) { wantW = (c.x + c.w) - x; driven = 'w'; }
        else if (hasE) { wantW = x - c.x; driven = 'w'; }
        else if (hasN) { wantH = (c.y + c.h) - y; driven = 'h'; }
        else if (hasS) { wantH = y - c.y; driven = 'h'; }
        else { wantW = c.w; driven = 'w'; }

        // 角手柄：宽高两个方向都能拖，取更贴合鼠标的那个
        if ((hasW || hasE) && (hasN || hasS)) {
          var hh = hasN ? (c.y + c.h) - y : y - c.y;
          if (wFromH(hh, kk) > wantW) { wantH = hh; driven = 'h'; }
        }

        if (driven === 'w') {
          nw = Math.max(0.01, wantW);
          nh = hFromW(nw, kk);
        } else {
          nh = Math.max(0.01, wantH);
          nw = wFromH(nh, kk);
        }
        if (!isFinite(nw) || !isFinite(nh) || nw <= 0 || nh <= 0) {
          nw = c.w; nh = c.h;
        }

        // 按被拖动的边定位新左上角；未拖动的方向保持中心
        var nL, nT;
        if (hasW) nL = c.x + c.w - nw;
        else if (hasE) nL = c.x;
        else nL = c.x + (c.w - nw) / 2;

        if (hasN) nT = c.y + c.h - nh;
        else if (hasS) nT = c.y;
        else nT = c.y + (c.h - nh) / 2;

        state.crop = constrainCrop({ x: nL, y: nT, w: nw, h: nh }, driven);
      } else {
        var L = c.x, T = c.y, R = c.x + c.w, B = c.y + c.h;
        if (d.indexOf('w') > -1) L = Math.min(x, R - 0.01);
        if (d.indexOf('e') > -1) R = Math.max(x, L + 0.01);
        if (d.indexOf('n') > -1) T = Math.min(y, B - 0.01);
        if (d.indexOf('s') > -1) B = Math.max(y, T + 0.01);
        nx = clamp(L, 0, 1); ny = clamp(T, 0, 1);
        nw = clamp(R - L, 0.01, 1 - nx); nh = clamp(B - T, 0.01, 1 - ny);
        // Shift 锁原比例
        if (e.shiftKey && c.w > 0 && c.h > 0) {
          var ar = (c.w * currentItem().w) / (c.h * currentItem().h);
          var kk2 = ar;
          if (d === 'se' || d === 'nw' || d === 'ne' || d === 'sw') {
            nh = hFromW(nw, kk2);
            if (ny + nh > 1) { nh = 1 - ny; nw = wFromH(nh, kk2); }
          }
        }
        state.crop = constrainCrop({ x: nx, y: ny, w: nw, h: nh }, 'w');
      }
    }
    draw();
  });

  function endDrag(e) {
    if (!state.dragging) return;
    state.dragging = null;
    try { overlay.releasePointerCapture(e.pointerId); } catch (err) {}
    draw();
  }
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);

  window.addEventListener('resize', function () { if (currentItem()) draw(); });

  // ---------------------------------------------------------------- 载入图片
  function loadFiles(files) {
    var arr = Array.prototype.slice.call(files).filter(function (f) {
      return /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name);
    });
    if (!arr.length) {
      alert('请上传 JPG、PNG 或 WebP 格式的图片');
      return;
    }
    arr.forEach(function (f) {
      var url = URL.createObjectURL(f);
      var img = new Image();
      var item = { file: f, name: f.name.replace(/\.[^.]+$/, ''), url: url, img: img, w: 0, h: 0 };
      img.onload = function () {
        item.w = img.naturalWidth;
        item.h = img.naturalHeight;
        state.items.push(item);
        renderMulti();
        if (state.current < 0) selectItem(0);
        else draw();
      };
      img.onerror = function () { alert('图片解码失败：' + f.name); };
      img.src = url;
    });
  }

  function selectItem(i) {
    state.current = i;
    var it = state.items[i];
    if (!it) return;
    baseImg.src = it.url;
    state.crop = { x: 0, y: 0, w: 1, h: 1 };
    // 等待图片渲染完成再计算画布尺寸
    var go = function () {
      // 图片换了，若当前有形状约束，重算合规选框
      if (state.shape !== 'free') applyShapeToCrop();
      requestAnimationFrame(function () { draw(); });
    };
    if (baseImg.complete) go(); else baseImg.onload = go;
    renderMulti();
  }

  function renderMulti() {
    if (state.items.length <= 1) { multiPanel.style.display = 'none'; return; }
    multiPanel.style.display = '';
    multiList.innerHTML = '';
    state.items.forEach(function (it, i) {
      var d = document.createElement('div');
      d.className = 'it';
      d.style.cursor = 'pointer';
      if (i === state.current) d.style.background = 'rgba(91,140,255,.14)';
      d.innerHTML = '<span class="nm">' + (i + 1) + '. ' + escapeHtml(it.name) +
        ' <span style="color:#5f6a7d">(' + it.w + '×' + it.h + ')</span></span>';
      d.addEventListener('click', function () { selectItem(i); });
      multiList.appendChild(d);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------------------------------------------------------------- 导出
  function loadZipLib() {
    if (typeof window.fflate === 'undefined' && typeof fflate === 'undefined') {
      throw new Error('未找到 fflate 库，请确认 vendor/fflate.umd.js 存在');
    }
    return (typeof window.fflate !== 'undefined') ? window.fflate : fflate;
  }

  btnExport.addEventListener('click', async function () {
    var src = currentItem();
    if (!src) { alert('请先上传一张图片'); return; }
    btnExport.disabled = true;
    btnExport.textContent = '⏳ 正在切片…';
    resultPanel.style.display = 'none';

    try {
      var targets = state.items.length > 1 ? state.items : [src];
      var entries = {};
      var totalTiles = 0;

      for (var k = 0; k < targets.length; k++) {
        var it = targets[k];
        // 逐张按当前参数计算布局
        var savedCurrent = state.current;
        state.current = state.items.indexOf(it);
        var layout = computeTiles();
        state.current = savedCurrent;
        if (!layout) continue;

        var cols = {}, rows = {};
        layout.tiles.forEach(function (t) { cols[t.x] = 1; rows[t.y] = 1; });
        var xs = Object.keys(cols).map(Number).sort(function (a, b) { return a - b; });
        var ys = Object.keys(rows).map(Number).sort(function (a, b) { return a - b; });
        var pad = String(Math.max(xs.length, ys.length)).length;
        var ext = lossless.checked ? 'png' : 'jpg';
        var q = clamp(parseInt(quality.value, 10) / 100, 0.5, 1);
        var prefix = targets.length > 1 ? it.name + '/' : it.name + '_';

        for (var i = 0; i < layout.tiles.length; i++) {
          var t = layout.tiles[i];
          var cv = document.createElement('canvas');
          cv.width = t.w; cv.height = t.h;
          var ctx = cv.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(it.img,
            layout.crop.x + t.x, layout.crop.y + t.y, t.w, t.h,
            0, 0, t.w, t.h);
          var blob = await new Promise(function (res) {
            if (lossless.checked) cv.toBlob(function (b) { res(b); }, 'image/png');
            else cv.toBlob(function (b) { res(b); }, 'image/jpeg', q);
          });
          if (!blob) throw new Error('编码失败');
          var ri = ys.indexOf(t.y) + 1, ci = xs.indexOf(t.x) + 1;
          var nm = prefix + 'r' + String(ri).padStart(pad, '0') +
                   'c' + String(ci).padStart(pad, '0') + '.' + ext;
          entries[nm] = new Uint8Array(await blob.arrayBuffer());
          totalTiles++;
        }

        // 余料
        if (layout.outer && keepRemainder.checked) {
          var o = layout.outer;
          var pieces = [];
          if (o.w > 0) pieces.push({ x: o.x, y: o.y, w: o.w, h: o.h, tag: 'right' });
          if (o.h > 0) pieces.push({ x: o.x2, y: o.y2, w: o.w2, h: o.h2, tag: 'bottom' });
          for (var pi = 0; pi < pieces.length; pi++) {
            var p = pieces[pi];
            var cv2 = document.createElement('canvas');
            cv2.width = p.w; cv2.height = p.h;
            cv2.getContext('2d').drawImage(it.img,
              layout.crop.x + p.x, layout.crop.y + p.y, p.w, p.h, 0, 0, p.w, p.h);
            var b2 = await new Promise(function (res) {
              if (lossless.checked) cv2.toBlob(function (b) { res(b); }, 'image/png');
              else cv2.toBlob(function (b) { res(b); }, 'image/jpeg', q);
            });
            entries[prefix + 'remainder_' + p.tag + '.' + ext] = new Uint8Array(await b2.arrayBuffer());
            totalTiles++;
          }
        }
      }

      if (!totalTiles) throw new Error('没有可导出的切块，请检查参数');

      var FL = loadZipLib();
      var zipped = FL.zipSync(entries, { level: 6 });
      var zipBlob = new Blob([zipped], { type: 'application/zip' });
      var zipUrl = URL.createObjectURL(zipBlob);
      var zipName = '切图助手_' + Date.now() + '.zip';

      // 清理上一次的下载链接
      state.outputs.forEach(function (u) { URL.revokeObjectURL(u); });
      state.outputs = [zipUrl];

      resultPanel.style.display = '';
      resultMsg.textContent = '✅ 导出成功，共 ' + totalTiles + ' 张切图，已打包为 ZIP';
      resultList.innerHTML = '';
      var d = document.createElement('div');
      d.className = 'it';
      d.innerHTML = '<span class="nm">' + zipName + '（' +
        (zipped.length / 1024).toFixed(0) + ' KB）</span>' +
        '<a href="' + zipUrl + '" download="' + zipName + '">下载</a>';
      resultList.appendChild(d);

      // 自动触发下载
      var a = document.createElement('a');
      a.href = zipUrl; a.download = zipName;
      document.body.appendChild(a); a.click(); a.remove();

      statusBadge.textContent = '导出完成 · ' + totalTiles + ' 张';
    } catch (err) {
      resultPanel.style.display = '';
      resultMsg.className = 'err';
      resultMsg.textContent = '❌ 导出失败：' + err.message;
    } finally {
      btnExport.disabled = false;
      btnExport.textContent = '📦 切分并导出 ZIP';
    }
  });

  // ---------------------------------------------------------------- 面板联动
  $('modeSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    Array.prototype.forEach.call(this.children, function (c) { c.classList.remove('on'); });
    b.classList.add('on');
    state.mode = b.dataset.mode;
    $('paneEven').style.display = state.mode === 'even' ? '' : 'none';
    $('paneSize').style.display = state.mode === 'size' ? '' : 'none';
    $('paneCustom').style.display = state.mode === 'custom' ? '' : 'none';
    draw();
  });

  document.querySelectorAll('[data-preset]').forEach(function (b) {
    b.addEventListener('click', function () {
      var p = b.dataset.preset.split(',');
      $('cols').value = p[0];
      $('rows').value = p[1];
      draw();
    });
  });

  ['cols', 'rows', 'tileW', 'tileH', 'colRatio', 'rowRatio'].forEach(function (id) {
    $(id).addEventListener('input', draw);
  });

  // ---- 裁剪形状：自定义 / 正方形 / 矩形 ----
  function syncShapeUI() {
    var showShape = useCrop.checked;
    shapeBox.style.display = showShape ? '' : 'none';
    ratioRow.style.display = (showShape && state.shape === 'ratio') ? '' : 'none';
    ratioPresets.hidden = !(showShape && state.shape === 'ratio');
    Array.prototype.forEach.call(shapeSeg.children, function (c) {
      c.classList.toggle('on', c.dataset.shape === state.shape);
    });
  }

  function parseAspect(str) {
    // 支持 "4:3"、"16:9"、"1.5" 三种写法
    var s = String(str || '').trim();
    var m = s.match(/^(\d+(?:\.\d+)?)\s*[:：\/]\s*(\d+(?:\.\d+)?)$/);
    if (m) {
      var a = parseFloat(m[1]), b = parseFloat(m[2]);
      if (a > 0 && b > 0) return a / b;
    }
    var v = parseFloat(s);
    if (isFinite(v) && v > 0) return v;
    return null;
  }

  shapeSeg.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    state.shape = b.dataset.shape;
    if (state.shape === 'ratio') {
      var k = parseAspect(ratioInput.value);
      state.ratio = k || 4 / 3;
    }
    syncShapeUI();
    applyShapeToCrop();
    draw();
  });

  ratioInput.addEventListener('input', function () {
    var k = parseAspect(ratioInput.value);
    if (k && state.shape === 'ratio') {
      state.ratio = k;
      applyShapeToCrop();
      draw();
    }
  });

  document.querySelectorAll('[data-ratio]').forEach(function (b) {
    b.addEventListener('click', function () {
      ratioInput.value = b.dataset.ratio;
      var k = parseAspect(b.dataset.ratio);
      if (k) {
        state.ratio = k;
        state.shape = 'ratio';
        syncShapeUI();
        applyShapeToCrop();
        draw();
      }
    });
  });

  useCrop.addEventListener('change', function () {
    syncShapeUI();
    if (useCrop.checked && state.shape !== 'free') applyShapeToCrop();
    draw();
  });
  lossless.addEventListener('change', draw);
  keepRemainder.addEventListener('change', draw);
  autoAlign.addEventListener('change', function () {
    state.autoAlign = autoAlign.checked;
    draw();
  });
  quality.addEventListener('input', function () { qualityVal.textContent = quality.value; });

  btnReset.addEventListener('click', function () {
    state.crop = { x: 0, y: 0, w: 1, h: 1 };
    // 非自由模式下，重置后立即收敛到合规的最大选框
    if (state.shape !== 'free') applyShapeToCrop();
    draw();
  });

  btnClear.addEventListener('click', function () {
    state.items.forEach(function (it) { URL.revokeObjectURL(it.url); });
    state.outputs.forEach(function (u) { URL.revokeObjectURL(u); });
    state.items = []; state.current = -1; state.outputs = [];
    baseImg.src = '';
    stageCanvas.style.display = 'none';
    dropzone.style.display = '';
    multiPanel.style.display = 'none';
    resultPanel.style.display = 'none';
    btnExport.disabled = true; btnReset.disabled = true; btnClear.disabled = true;
    statusBadge.textContent = '等待上传';
    previewMeta.textContent = '尚未载入图片';
  });

  // ---------------------------------------------------------------- 上传
  dropzone.addEventListener('click', function () {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
    inp.addEventListener('change', function () { loadFiles(inp.files); });
    inp.click();
  });
  ['dragenter', 'dragover'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add('over'); });
    document.addEventListener(ev, function (e) { e.preventDefault(); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dropzone.addEventListener(ev, function () { dropzone.classList.remove('over'); });
  });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
  });

  // Ctrl+V 粘贴图片
  document.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.files;
    if (items && items.length) loadFiles(items);
  });

  // 初始化界面状态
  syncShapeUI();

  // 暴露给自动化测试使用
  window.__SPLITTER__ = {
    state: state,
    computeTiles: computeTiles,
    loadFiles: loadFiles,
    selectItem: selectItem,
    draw: draw,
    applyShapeToCrop: applyShapeToCrop,
    syncShapeUI: syncShapeUI
  };
})();
