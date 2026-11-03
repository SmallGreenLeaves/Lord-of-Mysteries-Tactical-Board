(function () {
  'use strict';

  window.GM = window.GM || {};
  var GM = window.GM;
  var U = GM.util;

  var W = 1600;
  var H = 1000;
  var MIN_K = 0.4;
  var MAX_K = 8;

  var board = {
    svg: null,
    viewport: null,
    layers: {},
    drag: null,
    pan: null
  };

  function q(sel, root) { return (root || document).querySelector(sel); }

  /* ============================ 坐标转换 ============================ */

  /* 地图世界 → 视图：每张图按自己的 board 尺寸等比铺满 1600×1000，
     transform = translate(ox,oy) scale(S)。旧地图 board=1600×1000 → S=1、ox=oy=0，行为不变。 */
  function mapMetrics(md) {
    var b = (md && md.board) || { width: W, height: H };
    var S = Math.min(W / b.width, H / b.height);
    return {
      S: S,
      ox: (W - b.width * S) / 2,
      oy: (H - b.height * S) / 2,
      width: b.width,
      height: b.height
    };
  }

  /* 屏幕像素 / 视图单位（viewBox 铺满窗口后的实际比例） */
  function screenScale() {
    try {
      if (board.svg && board.svg.getScreenCTM) {
        var m = board.svg.getScreenCTM();
        if (m && isFinite(m.a) && m.a !== 0) return Math.abs(m.a);
      }
    } catch (err) { /* noop */ }
    return 1;
  }

  function screenToView(clientX, clientY) {
    var svg = board.svg;
    if (!svg || !svg.getScreenCTM) return { x: clientX, y: clientY };
    try {
      var pt = svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      var p = pt.matrixTransform(svg.getScreenCTM().inverse());
      return { x: p.x, y: p.y };
    } catch (err) {
      return { x: clientX, y: clientY };
    }
  }

  function viewToWorld(p) {
    var v = GM.state.view;
    var mk = mapMetrics(GM.currentMap());
    return { x: ((p.x - v.x) / v.k - mk.ox) / mk.S, y: ((p.y - v.y) / v.k - mk.oy) / mk.S };
  }

  function eventWorld(e) {
    return viewToWorld(screenToView(e.clientX, e.clientY));
  }

  function applyWorldTransform() {
    var md = GM.currentMap();
    var mk = mapMetrics(md);
    var tr = 'translate(' + mk.ox + ' ' + mk.oy + ') scale(' + mk.S + ')';
    ['base', 'zones', 'routes', 'markers', 'notes', 'overlayDraw'].forEach(function (key) {
      if (board.layers[key]) board.layers[key].setAttribute('transform', tr);
    });
  }

  function applyTransform() {
    var v = GM.state.view;
    if (!board.viewport) return;
    board.viewport.setAttribute('transform', 'translate(' + v.x + ' ' + v.y + ') scale(' + v.k + ')');
    var label = q('#zoomLabel');
    if (label) label.textContent = Math.round(v.k * 100) + '%';

    applyWorldTransform();

    /* 战术级 LOD：单位太小（全图概览）时隐藏文字，避免 150 个标签糊成一团 */
    var md = GM.currentMap();
    var mk = mapMetrics(md);
    var unitPx = mk.S * v.k * screenScale();
    if (board.svg) {
      board.svg.classList.toggle('lod-low', unitPx < 2.4);
      board.svg.classList.toggle('unit-map', isUnitMap(md));
    }

    var scaleChip = q('#hudScale');
    if (scaleChip) {
      var corridor = (md.unit && md.unit.corridorUnits) || 25;
      scaleChip.textContent = '1 unit = ' + unitPx.toFixed(2) + ' px · 主通道 ' + corridor + ' u';
    }
  }

  function snapPoint(world) {
    var project = GM.state.project;
    var md = GM.currentMap();
    var enabled = project && project.grid.enabled;
    var size = (md && md.gridSize) || (project && project.grid.size) || 32;
    if (!enabled) return { x: world.x, y: world.y };
    return {
      x: Math.round(world.x / size) * size,
      y: Math.round(world.y / size) * size
    };
  }

  /* 标记大小换算：灰雾试验场用视图像素；猎龙之城、四方战与星墓高原用世界单位（1 unit = 1 人宽）。
     判定口径：有墙体环（四方战）或显式声明 md.unit（猎龙之城 / 星墓高原）都算 unit 地图。 */
  function isUnitMap(md) {
    if (!md) return false;
    if (md.unit) return true;
    return !!(md.geometry && md.geometry.rings && md.geometry.rings.length);
  }

  /* ============================ 墙体（仅视觉信息） ============================ */

  /* 墙体不再拦放置：任何位置都能放标记。以下判定仅用于 HUD 通道宽度等内部校验。 */
  /* 沿某个方向能连续走多远（世界单位），用于 hover 通道宽度 */
  function corridorSpan(md, x, y, dx, dy, max) {
    var step = 0.5;
    var d = 0;
    while (d + step <= max) {
      d += step;
      if (!U.isWalkable(md, x + dx * d, y + dy * d)) break;
    }
    return d;
  }

  board.isWalkable = function (x, y) {
    var md = GM.currentMap();
    if (!isUnitMap(md)) return true;
    return U.isWalkable(md, x, y);
  };

  /* 通道宽度：取 x / y 两个方向跨度的较小值（走廊横向跨度远大于宽度） */
  board.corridorWidth = function (x, y) {
    var md = GM.currentMap();
    if (!isUnitMap(md)) return 0;
    if (!U.isWalkable(md, x, y)) return -1;
    var sx = corridorSpan(md, x, y, 1, 0, 46) + corridorSpan(md, x, y, -1, 0, 46);
    var sy = corridorSpan(md, x, y, 0, 1, 46) + corridorSpan(md, x, y, 0, -1, 46);
    return Math.max(0.5, Math.min(sx, sy));
  };

  var widthProbe = { key: '', t: 0 };

  function updateWidthChip(md, world) {
    var chip = q('#hudWidth');
    if (!chip) return;
    /* 通道宽度依赖墙体环；星墓高原没有墙环（只有路网），不显示该 chip，避免报出虚假的「人并排」 */
    var hasWalls = !!(md.geometry && md.geometry.rings && md.geometry.rings.length);
    if (!isUnitMap(md) || !hasWalls) {
      chip.classList.add('hidden');
      return;
    }
    chip.classList.remove('hidden');
    var key = Math.round(world.x * 2) + ',' + Math.round(world.y * 2);
    var now = Date.now();
    if (key === widthProbe.key && now - widthProbe.t < 250) return;
    widthProbe.key = key;
    widthProbe.t = now;
    if (!U.isWalkable(md, world.x, world.y)) {
      chip.textContent = '墙体 · 美术层（可放置标记）';
      return;
    }
    var w = board.corridorWidth(world.x, world.y);
    chip.textContent = '此处约 ' + Math.round(w) + ' 人并排';
  }


  /* ============================ 底图绘制（按参考图手绘 SVG） ============================ */

  function factionColor(project, id) {
    var list = (project && project.factions) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i].color;
    }
    return '#8a919f';
  }

  function factionName(project, id) {
    var list = (project && project.factions) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i].name;
    }
    return id || '';
  }

  /* 墙体：深色主体 + 浅色顶边，模拟石砌隔断 */
  function wall(x1, y1, x2, y2, w) {
    w = w || 12;
    return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="#151c25" stroke-width="' + w + '" stroke-linecap="square"></line>' +
      '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="#4b5666" stroke-width="1.2" stroke-linecap="square" opacity="0.85"></line>';
  }

  /* ============================ 原图底图（猎龙之城 / 霍纳奇斯） ============================ */

  /* 原图模式：SVG <image> 按世界坐标 1:1 铺满（相对路径引用 assets 里的 png，不内联 base64）。
     矢量重绘层默认隐藏，可用图层面板手动叠回；模式按地图分别记在独立 localStorage 键里，
     不写工程存档、不进撤销栈。默认原图（保真优先）。 */
  var PHOTO_KEY = 'gm.tactical.baseimg.v1';
  var PHOTO_IMAGES = {
    'hunt-city': { href: 'assets/maps/reference/hunt-city.png', w: 960, h: 540, upp: 2 },
    hornacis: { href: 'assets/maps/reference/hornacis/terrain.png', w: 1440, h: 810, upp: 0.75 },
    'club-war': { href: 'assets/maps/reference/club-war/terrain.png', w: 1440, h: 810, upp: 0.75 }
  };
  /* 原图模式下默认隐藏的矢量层（redraw = 猎龙之城整体线稿：领地色区 / 路网 / 城墙 / 祭坛 / 地基） */
  var PHOTO_VECTOR = { water: true, ice: true, snow: true, height: true, road: true, cliff: true, redraw: true };
  var photoModes = null;
  var photoOverrides = {};

  function photoStore() {
    if (photoModes) return photoModes;
    photoModes = {};
    try {
      var raw = window.localStorage.getItem(PHOTO_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') photoModes = parsed;
    } catch (err) { photoModes = {}; }
    return photoModes;
  }

  function photoImage(md) { return md ? PHOTO_IMAGES[md.id] : null; }

  /* 默认原图；只有显式存了 'redraw' 才是重绘 */
  function photoActive(md) {
    if (!photoImage(md)) return false;
    return photoStore()[md.id] !== 'redraw';
  }

  /* 图层的「有效显隐」：原图模式下默认隐藏矢量层，除非用户手动叠回；其它情况读工程图层开关 */
  function layerOn(id, md) {
    var project = GM.state.project;
    if (photoActive(md) && PHOTO_VECTOR[id]) return photoOverrides[md.id + ':' + id] === true;
    return project ? project.layers[id] !== false : true;
  }

  function photoImageSvg(md) {
    var ph = photoImage(md);
    if (!ph || !photoActive(md)) return '';
    return '<image class="base-photo" x="0" y="0" width="' + ph.w + '" height="' + ph.h +
      '" preserveAspectRatio="none" href="' + ph.href + '"></image>';
  }

  /* 原图模式下给标记 / 文字加描边阴影，保证亮暗区都可读 */
  function photoWrap(md, body) {
    if (!photoActive(md) || !body) return body;
    return '<g class="photo-obj" filter="url(#photoHalo)">' + body + '</g>';
  }

  GM.photo = {
    supported: function (mapId) { return !!PHOTO_IMAGES[mapId]; },
    mode: function () { return photoActive(GM.currentMap()) ? 'photo' : 'redraw'; },
    active: function () { return photoActive(GM.currentMap()); },
    vectorLayer: function (id) { return !!PHOTO_VECTOR[id]; },
    vectorOn: function (id) { return layerOn(id, GM.currentMap()); },
    image: function () { return photoImage(GM.currentMap()); },
    setMode: function (mode) {
      var md = GM.currentMap();
      if (!photoImage(md)) return;
      var store = photoStore();
      store[md.id] = mode === 'redraw' ? 'redraw' : 'photo';
      try { window.localStorage.setItem(PHOTO_KEY, JSON.stringify(store)); } catch (err) { /* 存储不可用时只保内存 */ }
    },
    toggleVector: function (id) {
      var md = GM.currentMap();
      var key = md.id + ':' + id;
      photoOverrides[key] = !photoOverrides[key];
      return photoOverrides[key];
    }
  };

  function commonBackdrop(md, project) {
    var b = (md && md.board) || { width: W, height: H };
    var unitMap = isUnitMap(md);
    var caption = unitMap
      ? '<text class="world-mark" x="' + (b.width / 2) + '" y="' + (b.height + 12) + '" font-size="4" text-anchor="middle" opacity="0.55">' + U.esc(md.name) + ' · ' + U.esc(md.modeLabel) + '</text>'
      : '<text class="world-mark" x="30" y="976" opacity="0.75">' + U.esc(md.name) + ' · ' + U.esc(md.modeLabel) + '</text>' +
        '<text class="world-mark" x="1570" y="976" opacity="0.4" text-anchor="end" font-size="10">HAND-DRAWN SVG · 1600 × 1000</text>';
    return '' +
      '<rect x="0" y="0" width="' + b.width + '" height="' + b.height + '" fill="#080b10"></rect>' +
      '<rect x="0" y="0" width="' + b.width + '" height="' + b.height + '" fill="url(#fogGlow)"></rect>' +
      '<rect x="0" y="0" width="' + b.width + '" height="' + b.height + '" fill="url(#gridPattern)" opacity="0.9"></rect>' +
      caption;
  }

  function artSandbox(md) {
    return '' +
      '<path d="M185,255 L520,158 L872,214 L1120,148 L1420,245 L1395,650 L1178,822 L812,872 L438,806 L206,635 Z" fill="#0f161f" stroke="#2b3646" stroke-width="1.5"></path>' +
      '<path d="M185,255 L520,158 L872,214 L1120,148 L1420,245 L1395,650 L1178,822 L812,872 L438,806 L206,635 Z" fill="none" stroke="#1b2431" stroke-width="7" opacity="0.5"></path>' +
      '<path d="M240,690 C430,610 520,470 690,420 S980,360 1170,300 S1330,260 1400,250" fill="none" stroke="#1c3442" stroke-width="26" opacity="0.55"></path>' +
      '<path d="M240,690 C430,610 520,470 690,420 S980,360 1170,300 S1330,260 1400,250" fill="none" stroke="#284a5a" stroke-width="10" opacity="0.35"></path>' +
      '<path d="M300,340 L760,520 L1190,700" fill="none" stroke="#3a4352" stroke-width="3" stroke-dasharray="10 8" opacity="0.6"></path>' +
      '<path d="M450,270 L600,430 L560,590 L380,700" fill="none" stroke="#312d27" stroke-width="18" opacity="0.5"></path>' +
      '<g fill="#1a222d" stroke="#2c3745" stroke-width="1">' +
      '<path d="M1060,210 L1190,190 L1240,260 L1110,280 Z"></path>' +
      '<path d="M270,460 L370,450 L400,520 L290,540 Z"></path>' +
      '<path d="M880,690 L990,680 L1010,750 L900,770 Z"></path>' +
      '</g>' +
      '<g fill="none" stroke="#46505f" stroke-width="1" opacity="0.45">' +
      '<circle cx="1240" cy="560" r="26"></circle><circle cx="1240" cy="560" r="42"></circle>' +
      '<circle cx="420" cy="380" r="18"></circle>' +
      '</g>' +
      '<text x="800" y="470" fill="#2f3947" font-size="42" text-anchor="middle" letter-spacing="14">ABSTRACT FIELD</text>';
  }

  function polyRing(cx, cy, r, n, rotDeg) {
    var pts = [];
    for (var i = 0; i < n; i++) {
      var a = (Math.PI * 2 * i) / n + (rotDeg || 0) * Math.PI / 180;
      pts.push((cx + Math.cos(a) * r).toFixed(1) + ',' + (cy + Math.sin(a) * r).toFixed(1));
    }
    return pts.join(' ');
  }

  /* 道路：宽底 + 金铜虚线中心线；线条只落在世界坐标（随缩放 / 平移一起变换） */
  function roadLine(pts, width) {
    var d = 'M' + pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' L');
    return '<path d="' + d + '" fill="none" stroke="#3b3426" stroke-width="' + width + '" stroke-linejoin="round" stroke-linecap="round" opacity="0.5"></path>' +
      '<path d="' + d + '" fill="none" stroke="#6d5a34" stroke-width="1.1" stroke-dasharray="8 11" stroke-linejoin="round" stroke-linecap="round" opacity="0.22"></path>';
  }

  function starRing(cx, cy, rOut, rIn, points) {
    var pts = [];
    for (var i = 0; i < points * 2; i++) {
      var a = (Math.PI * i) / points - Math.PI / 2;
      var r = i % 2 ? rIn : rOut;
      pts.push((cx + Math.cos(a) * r).toFixed(1) + ',' + (cy + Math.sin(a) * r).toFixed(1));
    }
    return pts.join(' ');
  }

  /* 猎龙之城：按纯净参考图（1920×1080）1:1 矢量化的底图。
     坐标全部来自 data/maps.js 的 geometry（世界 unit：1 unit = 2 图像 px，world 960×540）。
     绘制顺序：势力占领色区（纯背景）→ 路网 → 内城地面 → 城墙（四边中点留门洞）→ 中央祭坛 → 石碑地基 → 城堡。
     巢穴·召怪点、传送点、祭坛·召怪点不再落图，也没有任何热区。 */
  function artSiege(md, project) {
    /* 原图模式：整层矢量线稿默认不画（照片已有城墙 / 路网 / 祭坛），只在图层里手动叠回 redraw 时画 */
    if (photoActive(md) && !layerOn('redraw', md)) return '';
    var geo = md.geometry || {};
    var b = md.board || { width: 960, height: 540 };
    var w = geo.walls || {};
    var cit = geo.citadel || { cx: 469, cy: 260, rOut: 34 };
    var out = '' +
      '<rect x="0" y="0" width="' + b.width + '" height="' + b.height + '" rx="4" fill="#0b0e12" stroke="#242b35" stroke-width="1"></rect>' +
      '<rect x="1" y="1" width="' + (b.width - 2) + '" height="' + (b.height - 2) + '" rx="3.5" fill="#14120d"></rect>';

    /* 势力占领色区：不可点、无 hover、无提示，纯背景；先画，路网后画保证道路不被色块糊住 */
    var terr = geo.territories || {};
    Object.keys(terr).forEach(function (fid) {
      var t = terr[fid];
      var color = factionColor(project, fid);
      var pts = (t.points || []).map(function (p) { return p[0] + ',' + p[1]; }).join(' ');
      out += '<polygon points="' + pts + '" fill="' + U.esc(color) + '" fill-opacity="0.13" stroke="' + U.esc(color) + '" stroke-width="0.8" stroke-opacity="0.55" stroke-dasharray="3 2"></polygon>';
    });

    /* 路网：参考图一次性矢量化得到的单条 even-odd 填充路径（96 环 / 3800 顶点，世界 unit） */
    if (geo.roadNet && geo.roadNet.d) {
      out += '<path d="' + geo.roadNet.d + '" fill="#3b3426" fill-rule="evenodd" opacity="0.55"></path>' +
        '<path d="' + geo.roadNet.d + '" fill="none" stroke="#6d5a34" stroke-width="0.5" stroke-opacity="0.25" stroke-linejoin="round"></path>';
    }

    /* 内城地面（城墙以内的暗色地面） */
    if (w.cx !== undefined) {
      var k = w.notch, gh = w.gateHalf || 9;
      var floorPts = [
        [w.cx + w.rx * k, w.cy - w.ry], [w.cx + w.rx, w.cy - w.ry * k], [w.cx + w.rx, w.cy + w.ry * k],
        [w.cx + w.rx * k, w.cy + w.ry], [w.cx - w.rx * k, w.cy + w.ry], [w.cx - w.rx, w.cy + w.ry * k],
        [w.cx - w.rx, w.cy - w.ry * k], [w.cx - w.rx * k, w.cy - w.ry]
      ].map(function (p) { return p[0] + ',' + p[1]; }).join(' ');
      out += '<polygon points="' + floorPts + '" fill="#151a21" stroke="#1c232d" stroke-width="' + (w.thickness || 3.4) + '"></polygon>';

      /* 城墙：八边形 12 段，四边中点按 gateHalf 留门洞；顶点加垛台 */
      var segs = [
        [[w.cx - w.rx * k, w.cy - w.ry], [w.cx - gh, w.cy - w.ry]], [[w.cx + gh, w.cy - w.ry], [w.cx + w.rx * k, w.cy - w.ry]],
        [[w.cx + w.rx * k, w.cy - w.ry], [w.cx + w.rx, w.cy - w.ry * k]],
        [[w.cx + w.rx, w.cy - w.ry * k], [w.cx + w.rx, w.cy - gh]], [[w.cx + w.rx, w.cy + gh], [w.cx + w.rx, w.cy + w.ry * k]],
        [[w.cx + w.rx, w.cy + w.ry * k], [w.cx + w.rx * k, w.cy + w.ry]],
        [[w.cx + w.rx * k, w.cy + w.ry], [w.cx + gh, w.cy + w.ry]], [[w.cx - gh, w.cy + w.ry], [w.cx - w.rx * k, w.cy + w.ry]],
        [[w.cx - w.rx * k, w.cy + w.ry], [w.cx - w.rx, w.cy + w.ry * k]],
        [[w.cx - w.rx, w.cy + w.ry * k], [w.cx - w.rx, w.cy + gh]], [[w.cx - w.rx, w.cy - gh], [w.cx - w.rx, w.cy - w.ry * k]],
        [[w.cx - w.rx, w.cy - w.ry * k], [w.cx - w.rx * k, w.cy - w.ry]]
      ];
      segs.forEach(function (sg) {
        out += wall(sg[0][0], sg[0][1], sg[1][0], sg[1][1], w.thickness || 3.4);
      });
      [[w.cx + w.rx * k, w.cy - w.ry], [w.cx + w.rx, w.cy - w.ry * k], [w.cx + w.rx, w.cy + w.ry * k],
        [w.cx + w.rx * k, w.cy + w.ry], [w.cx - w.rx * k, w.cy + w.ry], [w.cx - w.rx, w.cy + w.ry * k],
        [w.cx - w.rx, w.cy - w.ry * k], [w.cx - w.rx * k, w.cy - w.ry]
      ].forEach(function (p) {
        out += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + (w.bastion || 4.2) + '" fill="#1b232d" stroke="#4a5462" stroke-width="0.6" opacity="0.9"></circle>';
      });
    }

    /* 中央高台 / 祭坛：八角外框 + 八芒星 + 中心判定圆（判定半径由 siege.platform.radius 给出） */
    out += '<polygon points="' + polyRing(cit.cx, cit.cy, cit.rOut, cit.points || 8, 22.5) + '" fill="#232219" stroke="#6d5a34" stroke-width="1"></polygon>' +
      '<polygon points="' + polyRing(cit.cx, cit.cy, cit.rIn, cit.points || 8, 0) + '" fill="none" stroke="#4b4230" stroke-width="0.6" opacity="0.7"></polygon>' +
      '<polygon points="' + starRing(cit.cx, cit.cy, cit.starOut, cit.starIn, cit.points || 8) + '" fill="rgba(201,165,90,0.1)" stroke="#9a7d47" stroke-width="0.8"></polygon>' +
      '<circle cx="' + cit.cx + '" cy="' + cit.cy + '" r="' + ((md.siege && md.siege.platform && md.siege.platform.radius) || cit.rOut) + '" fill="none" stroke="#c9a55a" stroke-width="0.5" stroke-dasharray="2 2" opacity="0.5"></circle>';

    /* 四角石碑地基（名称 / 热区由 objectives 渲染） */
    var sb = geo.steleBase || { outer: 16, inner: 11 };
    ((md.siege && md.siege.steles) || []).forEach(function (s) {
      out += '<circle cx="' + s.x + '" cy="' + s.y + '" r="' + sb.outer + '" fill="rgba(30,26,20,0.6)" stroke="#4b5360" stroke-width="0.6" stroke-dasharray="2 2" opacity="0.7"></circle>' +
        '<circle cx="' + s.x + '" cy="' + s.y + '" r="' + sb.inner + '" fill="none" stroke="#6d5a34" stroke-width="0.5" opacity="0.5"></circle>';
    });

    /* 四城堡基地（固定势力色） */
    (md.spawns || []).forEach(function (s) {
      var color = factionColor(project, s.factionId);
      out += '<polygon points="' + s.x + ',' + (s.y - 14) + ' ' + (s.x + 14) + ',' + s.y + ' ' + s.x + ',' + (s.y + 14) + ' ' + (s.x - 14) + ',' + s.y + '" fill="' + U.esc(color) + '" fill-opacity="0.14" stroke="' + U.esc(color) + '" stroke-width="0.9"></polygon>';
    });

    return out;
  }

  /* 四方战场：参考图矢量化 1:1（19 环 = 1 外轮廓 + 18 墙体洞）。
     rings 数据已经是「直角化」后的横竖线段多边形；渲染时对每个凸角插一段统一半径
     （FILLET_U = 1.75 unit）的圆弧，所以路径里只有直线 L 和圆弧 A，不会出现阶梯。 */
  var FILLET_U = 1.75;
  var fourClubPathCache = {};

  function ringArea(ring) {
    var s = 0;
    for (var i = 0, n = ring.length; i < n; i++) {
      var a = ring[i], b = ring[(i + 1) % n];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return s / 2;
  }

  /* 与离线矢量化管线（build2.js filletSegs/sampleSegs）同源：仅凸角切角，凹角保持直线 */
  function filletRing(ring, rUnits) {
    var n = ring.length, ccw = ringArea(ring) > 0, out = [];
    for (var i = 0; i < n; i++) {
      var prev = ring[(i - 1 + n) % n], cur = ring[i], next = ring[(i + 1) % n];
      var ux = prev[0] - cur[0], uy = prev[1] - cur[1], l1 = Math.sqrt(ux * ux + uy * uy) || 1;
      var vx = next[0] - cur[0], vy = next[1] - cur[1], l2 = Math.sqrt(vx * vx + vy * vy) || 1;
      var u = [ux / l1, uy / l1], v = [vx / l2, vy / l2];
      var cross = u[0] * v[1] - u[1] * v[0];
      var dot = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1]));
      var ang = Math.acos(dot);
      var convex = ccw ? cross > 0 : cross < 0;
      if (!convex || ang < 0.02 || ang > Math.PI - 0.02) { out.push({ p: cur }); continue; }
      var t = rUnits / Math.tan(ang / 2);
      t = Math.min(t, l1 * 0.45, l2 * 0.45);
      var rr = t * Math.tan(ang / 2);
      if (t < 0.3 || rr < 0.25) { out.push({ p: cur }); continue; }
      var bx = u[0] + v[0], by = u[1] + v[1], bl = Math.sqrt(bx * bx + by * by) || 1;
      var d = rr / Math.sin(ang / 2);
      var c = [cur[0] + bx / bl * d, cur[1] + by / bl * d];
      out.push({ p: [cur[0] + u[0] * t, cur[1] + u[1] * t] });
      out.push({ p: [cur[0] + v[0] * t, cur[1] + v[1] * t], arc: [c, rr] });
    }
    return out;
  }

  function fmt(v) { return v.toFixed(2); }

  /* 圆角段 → SVG 路径（只有 M / L / A + Z）。sweep 由圆心到两端的极角差决定，与离线采样同源。 */
  function segsToPath(segs) {
    var d = 'M' + fmt(segs[0].p[0]) + ' ' + fmt(segs[0].p[1]);
    var prev = segs[0].p;
    for (var i = 1; i < segs.length; i++) {
      var s = segs[i];
      if (s.arc) {
        var c = s.arc[0], rr = s.arc[1];
        var a0 = Math.atan2(prev[1] - c[1], prev[0] - c[0]);
        var a1 = Math.atan2(s.p[1] - c[1], s.p[0] - c[0]);
        var da = a1 - a0;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        d += 'A' + fmt(rr) + ' ' + fmt(rr) + ' 0 0 ' + (da > 0 ? 1 : 0) + ' ' + fmt(s.p[0]) + ' ' + fmt(s.p[1]);
      } else {
        d += 'L' + fmt(s.p[0]) + ' ' + fmt(s.p[1]);
      }
      prev = s.p;
    }
    return d + 'Z';
  }

  function fourClubPaths(md) {
    if (fourClubPathCache[md.id]) return fourClubPathCache[md.id];
    var rings = (md.geometry && md.geometry.rings) || [];
    var fillet = (md.geometry && md.geometry.filletUnit) || FILLET_U;
    function ringD(ring) {
      if (!ring || ring.length < 3) return '';
      return segsToPath(filletRing(ring, fillet));
    }
    var res = {
      outer: rings.length ? ringD(rings[0]) : '',
      holes: rings.slice(1).map(ringD).join(' ')
    };
    fourClubPathCache[md.id] = res;
    return res;
  }

  function artFourClub(md, project) {
    var b = md.board;
    var p = fourClubPaths(md);
    var out = '';
    out += '<rect x="0" y="0" width="' + b.width + '" height="' + b.height + '" rx="5" fill="#0a0d12" stroke="#2a313a" stroke-width="0.7"></rect>';
    /* 亮色 = 可行走 / 交战区（外轮廓） */
    out += '<path class="fc-walk" d="' + p.outer + '" fill="#414b58" stroke="#9c8657" stroke-width="0.9"></path>';
    out += '<path d="' + p.outer + '" fill="url(#gridPattern)" opacity="0.7"></path>';
    /* 暗色 = 墙体（18 个洞，1:1 来自阈值分割） */
    out += '<path class="fc-wall" d="' + p.holes + '" fill="#0b0f15" stroke="#2c3742" stroke-width="0.45"></path>';
    /* 保护结界：底图美术层（不可拖动、不进图层对象列表），仅可悬停 / 点选查看说明 */
    (md.barriers || []).forEach(function (br) {
      var color = factionColor(project, br.ownerFactionId) || '#6b93bb';
      var ownName = factionName(project, br.ownerFactionId) || '无归属';
      out += '<g class="obj-hotspot fc-barrier" data-obj="' + U.esc(br.id) + '" data-obj-type="barrier">' +
        '<title>' + U.esc('保护结界：' + br.effect + ' · 归属 ' + ownName) + '</title>' +
        '<circle cx="' + br.x + '" cy="' + br.y + '" r="' + br.radius + '" fill="' + U.esc(color) + '" fill-opacity="0.12" stroke="' + U.esc(color) + '" stroke-width="0.55" stroke-dasharray="1.6 1.1"></circle>' +
        '<circle cx="' + br.x + '" cy="' + br.y + '" r="' + (br.radius - 2.4).toFixed(2) + '" fill="none" stroke="' + U.esc(color) + '" stroke-width="0.25" opacity="0.8"></circle>' +
        '<circle class="obj-hit" cx="' + br.x + '" cy="' + br.y + '" r="' + br.radius + '"></circle>' +
        '<text class="fc-barrier-label" x="' + br.x + '" y="' + (br.y - br.radius - 1.6).toFixed(2) + '" text-anchor="middle" fill="' + U.esc(color) + '" style="font-size:2.6px">' + U.esc(br.name) + '</text>' +
        '</g>';
    });
    out += '<text x="' + (b.width / 2) + '" y="' + (b.height - 2.6) + '" fill="#5d6874" font-size="3" text-anchor="middle" letter-spacing="1">四方战场 · 矢量化 1:1 · 世界 ' + b.width + '×' + b.height + ' unit</text>';
    return out;
  }

  /* 星墓高原：参考图 1920×1080 逐像素量取的底图数据（下方常量全部是图像像素坐标）。
     单位基准与四方战同一套：1 unit = 1 人宽。本图唯一的人数锚点是楼梯——
     实量楼梯净宽 30 px，设定为并排 10 人（单人标记直径 1 unit）→ 1 unit = 30 / 10 = 3 图像像素。
     四段楼梯同宽同深：30 × 18 px = 10 × 6 unit，居中贴台体四边（见 STAR_STAIRS）。
     换算：world = (px − (160,40)) / 3；board = 533.33 × 333.33 unit，
     viewBox 仍是 1600×1000 → 等比铺满后 S = 3.0（画面与参考图 1:1，单人标记 = 1 unit）。
     线宽 / 字号按同一比例换算（11 px 通道 → 3.67 unit，9 px 字 → 3 unit），不是只缩线宽。
     未画 / 遮挡：中央高台被玩家标记覆盖，只按可见轮廓复原最小必要几何（见 README_AI.md 6.4）；
     高台西侧 / 东侧通道被玩家标记遮挡的横段，按两端可见端点直线相连，未外推。 */
  var STAR_PX = 3;
  var STAR_OFF = [160, 40];
  /* 外圈环道：128 个折点，全部按参考图逐像素重描（亮度 ≈ 182 的白色路面 + 连续性约束，
     排除据点 / 广场圆台）。北交汇处 (945,312) 与东交汇处 (1211,520–1220,540) 因两段路合并成宽亮带，
     取合并带中心，见 README_AI.md 逐段核验表。 */
  var STAR_RING = [
    [945, 312], [968, 318], [978, 321], [988, 323], [998, 327], [1008, 331], [1018, 335], [1027, 341],
    [1036, 346], [1044, 353], [1051, 360], [1071, 379], [1077, 387], [1083, 395], [1089, 403], [1095, 411],
    [1102, 419], [1109, 426], [1116, 433], [1124, 438], [1133, 444], [1142, 448], [1151, 453], [1160, 459],
    [1168, 466], [1176, 474], [1183, 481], [1191, 490], [1198, 500], [1205, 509], [1211, 520], [1220, 540],
    [1213, 549], [1206, 557], [1201, 566], [1196, 575], [1191, 584], [1186, 594], [1182, 604], [1178, 614],
    [1174, 624], [1171, 634], [1167, 644], [1161, 655], [1152, 663], [1143, 668], [1132, 672], [1123, 677],
    [1112, 685], [1105, 693], [1096, 702], [1088, 709], [1076, 712], [1067, 718], [1057, 721], [1047, 724],
    [1040, 732], [1032, 741], [1023, 751], [1013, 757], [1003, 762], [994, 766], [983, 769], [974, 774],
    [963, 781], [955, 787], [945, 790], [929, 772], [920, 764], [909, 759], [897, 754], [887, 752],
    [875, 751], [863, 750], [851, 748], [840, 747], [829, 744], [819, 740], [809, 736], [800, 731],
    [792, 724], [784, 715], [777, 704], [772, 695], [766, 686], [759, 678], [753, 669], [739, 658],
    [729, 651], [721, 644], [716, 635], [711, 624], [709, 615], [707, 603], [707, 593], [707, 582],
    [704, 572], [701, 561], [697, 550], [698, 537], [707, 532], [716, 524], [722, 514], [727, 503],
    [730, 493], [734, 480], [738, 470], [743, 459], [750, 449], [758, 442], [766, 434], [775, 428],
    [790, 423], [800, 420], [822, 412], [831, 406], [840, 400], [848, 393], [855, 384], [862, 376],
    [870, 367], [877, 357], [884, 349], [891, 341], [900, 334], [908, 327], [917, 322], [932, 316]
  ];

  /* 四条重生点 → 广场 → 高台通道（逐像素重描，起止点按与据点 / 高台的可见接合处收口）。
     西 / 东通道中段被蓝 / 绿玩家标记压住，按两端可见端点直线相连（README_AI.md 6.4 列出遮挡区间）。 */
  var STAR_ROADS = [
    { name: '北通道', pts: [[952, 277], [951, 287], [951, 298], [953, 307], [950, 330], [945, 380], [937, 425], [938, 435], [939, 445], [941, 455], [943, 504]] },
    { name: '南通道', pts: [[953, 588], [956, 600], [961, 642], [962, 652], [961, 662], [960, 672], [959, 682], [952, 750], [951, 760], [949, 770], [935, 820], [935, 838]] },
    { name: '西通道', pts: [[665, 533], [672, 537], [682, 539], [692, 542], [703, 543], [714, 545], [725, 547], [735, 549], [745, 550], [827, 558], [837, 557], [848, 557], [858, 557], [909, 549]] },
    { name: '东通道', pts: [[997, 546], [1030, 539], [1050, 535], [1060, 534], [1070, 534], [1147, 528], [1157, 528], [1168, 528], [1178, 528], [1188, 529], [1198, 530], [1208, 531], [1218, 531], [1227, 535], [1242, 537]] }
  ];

  /* 四边据点（= 重生点）圆台：改为正圆，半径取实测 rx / ry 均值（图像 px）。 */
  var STAR_OUTPOSTS = [
    { id: 'respawn-n', cx: 948, cy: 207, r: 55 },
    { id: 'respawn-w', cx: 618, cy: 520, r: 47.5 },
    { id: 'respawn-s', cx: 928, cy: 885, r: 52.5 },
    { id: 'respawn-e', cx: 1302, cy: 530, r: 53.5 }
  ];

  var STAR_PLAZAS = [
    { id: 'plaza-n', cx: 945, cy: 380, r: 34 },
    { id: 'plaza-w', cx: 787, cy: 547, r: 26.5 },
    { id: 'plaza-s', cx: 960, cy: 712, r: 28 },
    { id: 'plaza-e', cx: 1114, cy: 521, r: 25.5 }
  ];

  var STAR_PLATFORM = { x0: 909, y0: 504, x1: 997, y1: 588 };
  var STAR_STAIRS = [
    { side: 'N', x0: 938, y0: 486, x1: 968, y1: 504 },
    { side: 'S', x0: 938, y0: 588, x1: 968, y1: 606 },
    { side: 'W', x0: 891, y0: 531, x1: 909, y1: 561 },
    { side: 'E', x0: 997, y0: 531, x1: 1015, y1: 561 }
  ];

  var STAR_RIVER = [
    { w: 16, pts: [[940, 82], [938, 118], [940, 148], [958, 150], [982, 149], [1004, 160], [1014, 186], [1022, 222], [1038, 244], [1060, 252], [1078, 272], [1096, 300]] },
    { w: 13, pts: [[818, 164], [860, 160], [900, 152], [933, 147]] }
  ];

  function starR(v) { return Math.round(v * 100) / 100; }
  function starWorld(p) { return [starR((p[0] - STAR_OFF[0]) / STAR_PX), starR((p[1] - STAR_OFF[1]) / STAR_PX)]; }
  /* 长度 / 线宽 / 字号一律走这里，保证整张图只有 STAR_PX 一个换算系数 */
  function starLen(v) { return starR(v / STAR_PX); }

  /* 据点 / 广场上的城堡图标（俯视三塔剪影，位置与底图图标对齐） */
  function keepGlyph(cx, cy, k, alpha) {
    return '<g fill="#d3cbb6" opacity="' + alpha + '">' +
      '<rect x="' + (cx - 4 * k) + '" y="' + (cy - 1 * k) + '" width="' + (8 * k) + '" height="' + (5 * k) + '"></rect>' +
      '<rect x="' + (cx - 11 * k) + '" y="' + (cy - 6 * k) + '" width="' + (5 * k) + '" height="' + (10 * k) + '"></rect>' +
      '<rect x="' + (cx + 6 * k) + '" y="' + (cy - 6 * k) + '" width="' + (5 * k) + '" height="' + (10 * k) + '"></rect>' +
      '<rect x="' + (cx - 2 * k) + '" y="' + (cy - 12 * k) + '" width="' + (4 * k) + '" height="' + (8 * k) + '"></rect>' +
      '</g>';
  }

  function starStairs() {
    var out = '';
    STAR_STAIRS.forEach(function (s) {
      var a = starWorld([s.x0, s.y0]);
      var b = starWorld([s.x1, s.y1]);
      var x0 = a[0], y0 = a[1], x1 = b[0], y1 = b[1];
      out += '<rect x="' + x0 + '" y="' + y0 + '" width="' + starR(x1 - x0) + '" height="' + starR(y1 - y0) + '" fill="rgba(211,203,182,0.16)" stroke="#b9b09b" stroke-width="' + starLen(1) + '"></rect>';
      var n = 3;
      for (var i = 1; i <= n; i++) {
        if (s.side === 'N' || s.side === 'S') {
          var ty = starR(y0 + (y1 - y0) * i / (n + 1));
          out += '<line x1="' + x0 + '" y1="' + ty + '" x2="' + x1 + '" y2="' + ty + '" stroke="#8f8877" stroke-width="' + starLen(0.8) + '" opacity="0.75"></line>';
        } else {
          var tx = starR(x0 + (x1 - x0) * i / (n + 1));
          out += '<line x1="' + tx + '" y1="' + y0 + '" x2="' + tx + '" y2="' + y1 + '" stroke="#8f8877" stroke-width="' + starLen(0.8) + '" opacity="0.75"></line>';
        }
      }
    });
    return out;
  }

  /* 星墓高原：底图按高程拆成两个互斥的 SVG 组，每次只生成当前层那一组，隐藏层不进 DOM。
     共享地貌（北侧河网 / 外圈环道 / 四条通道 / 四据点圆台 / 四广场圆台 / 四段楼梯）两层都可见：
     这些都在地面之上，从高台俯视同样能看到。
     台上专属：中央高台实体框 + 内虚线回廊 + 标题「二层 · 中央高台」。
     台下专属：高台虚线投影 + 7 条镂空斜纹 + 「台下镂空 · 高台投影」说明 + 标题「地面层 · 台下镂空可穿行」。
     两个组都带 data-level，便于调试与后续按层做 CSS 控制；热区（objective/hotspot）另由
     renderObjectives 按 o.level 过滤，不在这里画。 */
  function artEscort(md, project, level) {
    var upper = level !== 'ground';

    /* 共享层：地面地貌与通路 */
    var base = '';

    /* 外圈地貌：底图只有北侧河网是可辨识地貌，按蓝通道掩膜实测折线绘制；草甸纹理不画 */
    STAR_RIVER.forEach(function (r) {
      var pts = r.pts.map(function (p) { return starWorld(p); });
      base += roadLine(pts, starLen(r.w + 4)).replace(/#3b3426/g, '#1d3a4a').replace(/#6d5a34/g, '#3f6a80');
    });

    /* 外圈环道（闭合，128 折点）+ 四条重生点→广场→高台的通道，线宽按 unit 换算（11 px → 3.67 unit） */
    var ring = STAR_RING.map(starWorld).concat([starWorld(STAR_RING[0])]);
    base += roadLine(ring, starLen(11));
    STAR_ROADS.forEach(function (r) {
      var pts = r.pts.map(starWorld);
      base += roadLine(pts, starLen(11));
    });

    /* 四边据点（重生点）与四广场圆台：统一画正圆（不是实量椭圆），半径按 STAR_PX 换算 */
    STAR_OUTPOSTS.forEach(function (o) {
      var p = starWorld([o.cx, o.cy]);
      var r = starLen(o.r);
      base += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + r + '" fill="rgba(58,72,64,0.55)" stroke="#8e9a8c" stroke-width="' + starLen(1.2) + '"></circle>' +
        '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + starR(r - starLen(7.5)) + '" fill="rgba(198,193,176,0.12)" stroke="#6f7d70" stroke-width="' + starLen(0.8) + '"></circle>' +
        keepGlyph(p[0], starR(p[1] + starLen(4)), starLen(1.4), 0.85);
    });
    STAR_PLAZAS.forEach(function (o) {
      var p = starWorld([o.cx, o.cy]);
      base += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + starLen(o.r) + '" fill="rgba(201,165,90,0.07)" stroke="#9a8a62" stroke-width="' + starLen(1) + '"></circle>' +
        keepGlyph(p[0], starR(p[1] - starLen(6)), starLen(1.1), 0.8);
    });

    /* 四段楼梯连接地面与高台，两层都画 */
    base += starStairs();

    /* 高程专属层：中央高台画法不同。
       文字标注交给 objectiveNode（热区自带名称），底图只画结构，避免两套文字叠在一起。 */
    var pa = starWorld([STAR_PLATFORM.x0, STAR_PLATFORM.y0]);
    var pb = starWorld([STAR_PLATFORM.x1, STAR_PLATFORM.y1]);
    var px0 = pa[0], py0 = pa[1], px1 = pb[0], py1 = pb[1];
    var w = starR(px1 - px0), h = starR(py1 - py0);
    var tier = '';
    if (upper) {
      tier += '<rect x="' + px0 + '" y="' + py0 + '" width="' + w + '" height="' + h + '" fill="rgba(206,199,178,0.14)" stroke="#cfc7b2" stroke-width="' + starLen(1.4) + '"></rect>' +
        '<rect x="' + (px0 + starLen(8)) + '" y="' + (py0 + starLen(8)) + '" width="' + starR(w - starLen(16)) + '" height="' + starR(h - starLen(16)) + '" fill="none" stroke="#8f8877" stroke-width="' + starLen(0.9) + '" stroke-dasharray="' + starLen(5) + ' ' + starLen(5) + '" opacity="0.7"></rect>';
    } else {
      tier += '<rect x="' + px0 + '" y="' + py0 + '" width="' + w + '" height="' + h + '" fill="none" stroke="#7f8b99" stroke-width="' + starLen(1.2) + '" stroke-dasharray="' + starLen(7) + ' ' + starLen(5) + '" opacity="0.85"></rect>';
      for (var i = 0; i < 7; i++) {
        var t = (i + 1) / 8;
        tier += '<line x1="' + px0 + '" y1="' + starR(py0 + h * t) + '" x2="' + starR(px0 + w * t) + '" y2="' + py1 + '" stroke="#4a5563" stroke-width="' + starLen(0.8) + '" opacity="0.5"></line>';
      }
      tier += '<text x="' + starR(px0 + w / 2) + '" y="' + starR(py0 - starLen(4)) + '" fill="#8f99a6" font-size="' + starLen(6) + '" text-anchor="middle" opacity="0.8">台下镂空 · 高台投影</text>';
    }

    var titlePt = starWorld([960, 340]);
    tier += '<text x="' + titlePt[0] + '" y="' + titlePt[1] + '" fill="#2b3542" font-size="' + starLen(10) + '" text-anchor="middle" letter-spacing="' + starLen(4) + '">' + (upper ? '二层 · 中央高台' : '地面层 · 台下镂空可穿行') + '</text>';

    return '<g class="star-tier ' + (upper ? 'star-tier-upper' : 'star-tier-ground') +
      '" data-level="' + (upper ? 'upper' : 'ground') + '">' + base + tier + '</g>';
  }

  /* 霍纳奇斯山脉底图：几何全部来自 data/maps.js 内联矢量（一次性脚本矢量化）。
     图层按 project.layers 的 water / ice / height / points / winds 分别控制显隐；
     高度图为示意色阶，默认关。 */
  function artHornacis(md, project) {
    var gy = md.geometry || {};
    var bw = (md.board || {}).width || 1440;
    var out = '';
    var HC = ['#3d4f5c', '#54695f', '#7d8463', '#b3a97e', '#ddd3b7', '#f7f3e7'];

    if (layerOn('height', md) && gy.heightBands) {
      var bo = '';
      gy.heightBands.forEach(function (bd, i) {
        bo += '<path d="' + bd.d + '" fill="' + HC[Math.min(i, HC.length - 1)] + '" fill-opacity="0.34"></path>';
      });
      bo += '<text x="' + (bw - 10) + '" y="22" fill="#ded6c0" font-size="7" text-anchor="end" opacity="0.7">高度示意图 · 6 层色阶（依据等高线条数 / 间距，非真实高程）</text>';
      out += '<g class="horn-height">' + bo + '</g>';
    }

    if (layerOn('snow', md) && gy.snow) {
      out += '<path class="horn-snow" d="' + gy.snow.d + '" fill="url(#snowHatch)" fill-opacity="0.55" stroke="#c8d4e2" stroke-width="0.25" stroke-opacity="0.3"></path>';
    }
    if (layerOn('water', md) && gy.water) {
      out += '<path class="horn-water" d="' + gy.water.d + '" fill="url(#waterHatch)" fill-opacity="0.9" stroke="#2f6ea8" stroke-width="0.9"></path>';
    }
    if (layerOn('ice', md) && gy.ice) {
      out += '<path class="horn-ice" d="' + gy.ice.d + '" fill="url(#iceHatch)" fill-opacity="0.95" stroke="#9fb8cc" stroke-width="0.8"></path>';
    }
    if (layerOn('road', md) && gy.road) {
      out += '<path class="horn-road" d="' + gy.road.d + '" fill="#cbb987" fill-opacity="0.45" stroke="#9b885c" stroke-width="0.3" stroke-opacity="0.45"></path>';
    }
    if (layerOn('cliff', md) && gy.cliff) {
      out += '<path class="horn-cliff" d="' + gy.cliff.d + '" fill="url(#cliffHatch)" stroke="#a86a24" stroke-width="0.55" stroke-opacity="0.6"></path>';
    }
    if (gy.islands) {
      /* 原图模式：孤岛只留淡轮廓 + 名称，避免矢量色块盖住照片上的孤岛 */
      var photoIsl = photoActive(md);
      out += '<path d="' + gy.islands.d + '" fill="#ded8c5" fill-opacity="' + (photoIsl ? '0.16' : '0.95') + '" stroke="#8d8577" stroke-width="' + (photoIsl ? '0.35' : '0.7') + '"></path>';
      if (gy.islands.p2 && gy.islands.p2.d) {
        out += '<path d="' + gy.islands.p2.d + '" fill="#eae4d0" fill-opacity="' + (photoIsl ? '0.2' : '1') + '" stroke="#e0b45c" stroke-width="1.1"></path>' +
          '<text x="483" y="346" fill="#e6c069" font-size="6.5" text-anchor="middle" opacity="0.95">河中孤岛 · 2</text>';
      }
    }
    var banks = gy.cliffBanks || {};
    if (banks.left && layerOn('cliff', md)) {
      out += '<path d="' + banks.left + '" fill="none" stroke="#e06a3a" stroke-width="2.2" stroke-dasharray="6 4" stroke-opacity="0.9"></path>' +
        '<text x="330" y="386" fill="#f0a070" font-size="6.5" text-anchor="middle">两岸悬崖峭壁 · 西岸</text>';
    }
    if (banks.right && layerOn('cliff', md)) {
      out += '<path d="' + banks.right + '" fill="none" stroke="#e06a3a" stroke-width="2.2" stroke-dasharray="6 4" stroke-opacity="0.9"></path>' +
        '<text x="600" y="476" fill="#f0a070" font-size="6.5" text-anchor="middle">两岸悬崖峭壁 · 东岸</text>';
    }

    var byNo = {};
    (md.points || []).forEach(function (p) { byNo[p.no] = p; });
    var seg = function (a, b, op) {
      if (!a || !b) return '';
      return '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" stroke="#c9a55a" stroke-width="0.7" stroke-dasharray="3 2.4" stroke-opacity="' + op + '"></line>';
    };
    var linkSvg = '';
    (md.links || []).forEach(function (pair) { linkSvg += seg(byNo[pair[0]], byNo[pair[1]], 0.5); });
    if (md.hub) {
      (md.points || []).forEach(function (p) {
        if (p.no !== md.hub) linkSvg += seg(byNo[md.hub], p, 0.28);
      });
    }

    var ptSvg = '';
    (md.points || []).forEach(function (p) {
      ptSvg += '<circle cx="' + p.x + '" cy="' + p.y + '" r="7" fill="#0e1822" fill-opacity="0.92" stroke="#d9a441" stroke-width="1.1"></circle>' +
        '<text x="' + p.x + '" y="' + (p.y + 3) + '" fill="#f4e3b6" font-size="9" text-anchor="middle">' + p.no + '</text>' +
        '<text x="' + p.x + '" y="' + (p.y + 16) + '" fill="#d6cdb4" font-size="6.5" text-anchor="middle">' + U.esc(p.name) + '</text>';
    });

    var tpSvg = '';
    (md.transports || []).forEach(function (t) {
      tpSvg += '<path d="M' + t.x + ',' + (t.y - 6) + ' L' + (t.x + 6) + ',' + t.y + ' L' + t.x + ',' + (t.y + 6) + ' L' + (t.x - 6) + ',' + t.y + ' Z" fill="#0e2430" fill-opacity="0.9" stroke="#6fd0c0" stroke-width="0.9"></path>' +
        '<text x="' + t.x + '" y="' + (t.y + 2.4) + '" fill="#bfeee4" font-size="5.5" text-anchor="middle">传</text>' +
        '<text x="' + t.x + '" y="' + (t.y + 14) + '" fill="#8fc4ba" font-size="5.5" text-anchor="middle">传送复活点 ' + t.no + '</text>';
    });

    /* 风向 chevron：方向来自数据 w.angle（+x 轴为 0°、顺时针为正），
       不能用 ax→bx 推断（wind-a 的端点顺序与图上流向相反）。
       数量按风道长度自动算（3–12 个），沿中心线等距排布，尖端指向流向。 */
    function windChevronsSvg(w) {
      if (!isFinite(w.angle)) return '';
      var dx = w.bx - w.ax, dy = w.by - w.ay;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (!(len > 0)) return '';
      var n = Math.max(3, Math.min(12, Math.round(len / 16)));
      var gap = len / (n + 1);
      var arm = 6, spread = 4;
      var rad = w.angle * Math.PI / 180;
      var ux = Math.cos(rad), uy = Math.sin(rad);
      var mx = (w.ax + w.bx) / 2, my = (w.ay + w.by) / 2;
      var out = '';
      for (var i = 0; i < n; i++) {
        var t = (i - (n - 1) / 2) * gap;
        out += '<g transform="translate(' + (mx + ux * t) + ' ' + (my + uy * t) + ') rotate(' + w.angle + ')">' +
          '<path d="M ' + (-arm) + ' ' + (-spread) + ' L 0 0 L ' + (-arm) + ' ' + spread + '" fill="none" stroke="#79d0e6" stroke-width="1.2" stroke-linecap="round" stroke-opacity="0.95"></path>' +
          '</g>';
      }
      return out;
    }

    var windSvg = '';
    if (layerOn('winds', md)) {
      (md.winds || []).forEach(function (w) {
        var lx = (w.ax + w.bx) / 2, ly = (w.ay + w.by) / 2 - 4;
        if (isFinite(w.angle)) {
          /* 名称沿箭头法线偏移，避免压在 chevron 序列上 */
          var na = (w.angle + 90) * Math.PI / 180;
          lx += Math.cos(na) * 8;
          ly += Math.sin(na) * 8 + 2;
        }
        windSvg += windChevronsSvg(w) +
          '<circle cx="' + w.ax + '" cy="' + w.ay + '" r="4.2" fill="#12303c" fill-opacity="0.9" stroke="#79d0e6" stroke-width="0.9"></circle>' +
          '<circle cx="' + w.bx + '" cy="' + w.by + '" r="4.2" fill="#12303c" fill-opacity="0.9" stroke="#79d0e6" stroke-width="0.9"></circle>' +
          '<text x="' + lx + '" y="' + ly + '" fill="#a9e6f2" font-size="5.5" text-anchor="middle">' + U.esc(w.name) + '</text>';
      });
    }

    /* 原图模式下点位 / 传送 / 风场压在原图上，统一加描边阴影 */
    out += photoWrap(md, linkSvg + (layerOn('points', md) ? ptSvg + tpSvg : '') + windSvg);
    return out;
  }

  /* 俱乐部宣战底图：几何来自 data/maps.js 的 geometry（world unit，upp 0.75）。
     原图模式下整层默认隐藏（PHOTO_VECTOR.redraw），可在图层面板手动叠回；
     屏障层 barriers 独立开关，且只在屏障未消失（两座雕像未全部占领）时绘制。 */
  function artClubWar(md, project) {
    var gy = md.geometry || {};
    var b = md.board || { width: 1440, height: 810 };
    var out = '';

    if (layerOn('redraw', md)) {
      out += '<rect x="0" y="0" width="' + b.width + '" height="' + b.height + '" fill="#0b0f14" stroke="#2a313a" stroke-width="0.7"></rect>';
      /* 岩地基底：斜向细纹，避免大片纯色 */
      var hatch = '';
      for (var hx = -b.height; hx < b.width + b.height; hx += 34) {
        hatch += '<line x1="' + hx + '" y1="0" x2="' + (hx - b.height) + '" y2="' + b.height + '" stroke="#1a212a" stroke-width="0.5" opacity="0.45"></line>';
      }
      out += hatch;

      (gy.plazas || []).forEach(function (p) {
        out += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + p.r + '" fill="#2b3340" stroke="#6b5a3f" stroke-width="1.1"></circle>' +
          '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + (p.r - 2.4) + '" fill="none" stroke="#8a7449" stroke-width="0.35" stroke-dasharray="2 2" opacity="0.55"></circle>';
      });
      (gy.corridors || []).forEach(function (c) {
        out += '<rect x="' + c.x1 + '" y="' + c.y1 + '" width="' + (c.x2 - c.x1) + '" height="' + (c.y2 - c.y1) +
          '" fill="#2b3340" stroke="#6b5a3f" stroke-width="1"></rect>';
      });
      /* 中线：纵向走廊 x=467.5、水平走廊 y=383.5（点位图上的点位均落在两条中线附近） */
      out += '<line x1="467.5" y1="15" x2="467.5" y2="758" stroke="#8a7449" stroke-width="0.5" stroke-dasharray="5 4" opacity="0.55"></line>' +
        '<line x1="120" y1="383.5" x2="1200" y2="383.5" stroke="#8a7449" stroke-width="0.5" stroke-dasharray="5 4" opacity="0.55"></line>';
      out += '<text x="' + (b.width - 10) + '" y="22" fill="#8a8168" font-size="6.5" text-anchor="end" opacity="0.8">俱乐部宣战 · 矢量重绘 · 世界 ' + b.width + '×' + b.height + ' unit</text>';
    }

    /* 屏障：蓝色圆角竖条 + 内侧虚线，明显区别于棕色道路。
       两座战争雕像都「已占领」→ 屏障消失，否则存在。 */
    var plan = GM.activePlan();
    var cw = (plan && plan.clubwar) || {};
    var own = cw.ownership || {};
    var statueIds = (md.clubWar && md.clubWar.statueIds) || [];
    var barrierGone = statueIds.every(function (sid) { return own[sid] === true; });
    if (layerOn('barriers', md) && !barrierGone) {
      var bar = '';
      (md.barriers || []).forEach(function (br) {
        var len = Math.abs(br.y2 - br.y1);
        var th = br.thickness || 10;
        var x0 = ((br.x1 + br.x2) / 2 - th / 2);
        var y0 = Math.min(br.y1, br.y2);
        bar += '<rect class="club-barrier" x="' + x0 + '" y="' + y0 + '" width="' + th + '" height="' + len + '" rx="' + (th / 2) + '" fill="rgba(32,126,214,0.34)" stroke="#49b6ff" stroke-width="0.9"></rect>' +
          '<line x1="' + (x0 + th / 2) + '" y1="' + (y0 + 1.2) + '" x2="' + (x0 + th / 2) + '" y2="' + (y0 + len - 1.2) + '" stroke="#bfe6ff" stroke-width="0.35" stroke-dasharray="2 1.6" opacity="0.85"></line>' +
          '<text class="obj-label" x="' + (x0 - 4) + '" y="' + (y0 + len / 2 + 1.2) + '" text-anchor="end" style="font-size:3.2px;stroke-width:0.5px">屏障 · 攻守均不可通行</text>';
      });
      out += photoWrap(md, bar);
    }
    return out;
  }

  function renderArt(md, project, level) {
    /* 原图底图先铺在底层（世界坐标精确铺满），矢量重绘再叠上去；原图模式下矢量层默认关 */
    var out = commonBackdrop(md, project) + photoImageSvg(md);
    if (md.id === 'four-club') out += artFourClub(md, project);
    else if (md.mode === 'siege-capture') out += artSiege(md, project);
    else if (md.mode === 'escort') out += artEscort(md, project, level);
    else if (md.mode === 'domination') out += artHornacis(md, project);
    else if (md.mode === 'club-war') out += artClubWar(md, project);
    else out += artSandbox(md);
    return out;
  }

  /* ============================ 据点 / 目标渲染 ============================ */

  /* 据点 / 目标：每个可交互对象都包一层热区（data-obj），底图本身不可选中 */
  function objectiveNode(o, md, plan, project) {
    var color = '#98a0ac';
    var shape = '';
    var labelY = 0;
    var sub = '';
    var hitR = 34;
    var type = o.type || (o.boss !== undefined ? 'boss' : 'objective');
    var target = plan ? GM.siegeScoreTarget(plan) : ((md.siege && md.siege.platform && md.siege.platform.scoreTarget) || 100);
    var unitMap = isUnitMap(md);          // unit 地图的图元尺寸直接按世界 unit 给
    var hitFloor = unitMap ? 3.5 : 24;    // 旧地图保留 24px 最小命中半径；unit 地图不能给到 24 unit

    if (type === 'stele') {
      var owner = plan && plan.siege ? plan.siege.steles[o.id] : null;
      color = owner ? factionColor(project, owner) : '#7c8494';
      var sOuter = unitMap ? 9 : 32;
      var sInner = unitMap ? 4.5 : 16;
      var outerPts = [[o.x, o.y - sOuter], [o.x + sOuter, o.y], [o.x, o.y + sOuter], [o.x - sOuter, o.y]].map(function (p) { return p[0] + ',' + p[1]; }).join(' ');
      var innerPts = [[o.x, o.y - sInner], [o.x + sInner, o.y], [o.x, o.y + sInner], [o.x - sInner, o.y]].map(function (p) { return p[0] + ',' + p[1]; }).join(' ');
      shape = '<polygon points="' + outerPts + '" fill="' + U.esc(color) + '" fill-opacity="' + (owner ? 0.22 : 0.06) + '" stroke="' + U.esc(color) + '" stroke-width="' + (unitMap ? 0.7 : 2) + '"' + (owner ? '' : ' stroke-dasharray="' + (unitMap ? '1.4 1.1' : '5 4') + '"') + '></polygon>' +
        '<polygon points="' + innerPts + '" fill="' + U.esc(color) + '" fill-opacity="0.25" stroke="none"></polygon>' +
        '<text x="' + o.x + '" y="' + (o.y + (unitMap ? 1.2 : 4)) + '" fill="#e6ca8a" font-size="' + (unitMap ? 3 : 10) + '" text-anchor="middle" opacity="0.65">碑</text>';
      hitR = unitMap ? 14 : 46;
      labelY = o.y + (unitMap ? 16 : 56);
      sub = owner ? factionName(project, owner) : '未占领 · 点击切换归属';
    } else if (type === 'gate') {
      var gateCfg = null;
      (md.siege.gates || []).forEach(function (g) { if (g.id === o.id) gateCfg = g; });
      var state = gateCfg && plan ? GM.siegeGateState(plan, gateCfg) : 'locked';
      color = state === 'broken' ? '#c35a56' : (state === 'ready' ? '#e6ca8a' : '#6a7280');
      var vertical = gateCfg && (gateCfg.side === '西' || gateCfg.side === '东');
      var gw = unitMap ? (vertical ? 9 : 22) : (vertical ? 26 : 56);
      var gh = unitMap ? (vertical ? 22 : 9) : (vertical ? 56 : 26);
      var inset = unitMap ? 1.8 : 5;
      shape = '<rect x="' + (o.x - gw / 2) + '" y="' + (o.y - gh / 2) + '" width="' + gw + '" height="' + gh + '" rx="' + (unitMap ? 1 : 3) + '" fill="' + U.esc(color) + '" fill-opacity="0.2" stroke="' + U.esc(color) + '" stroke-width="' + (unitMap ? 0.7 : 2) + '"></rect>' +
        '<rect x="' + (o.x - gw / 2 + inset) + '" y="' + (o.y - gh / 2 + inset) + '" width="' + (gw - inset * 2) + '" height="' + (gh - inset * 2) + '" rx="' + (unitMap ? 0.6 : 2) + '" fill="none" stroke="' + U.esc(color) + '" stroke-width="' + (unitMap ? 0.35 : 1) + '" stroke-dasharray="' + (unitMap ? '1 1' : '3 3') + '" opacity="0.6"></rect>' +
        (state === 'broken'
          ? '<line x1="' + (o.x - gw / 2) + '" y1="' + (o.y + gh / 2) + '" x2="' + (o.x + gw / 2) + '" y2="' + (o.y - gh / 2) + '" stroke="#c35a56" stroke-width="' + (unitMap ? 0.4 : 1.2) + '" opacity="0.7"></line>'
          : '');
      hitR = unitMap ? 12 : 42;
      labelY = unitMap
        ? o.y + (gateCfg && gateCfg.side === '北' ? -10 : (vertical ? 16 : 13))
        : o.y + (gateCfg && gateCfg.side === '北' ? -30 : (vertical ? 50 : 44));
      sub = GM.siegeGateLabel(state) + (gateCfg ? ' · ' + factionName(project, gateCfg.factionId) : '');
    } else if (type === 'platform') {
      var r = (md.siege && md.siege.platform && md.siege.platform.radius) || 105;
      shape = '<circle cx="' + o.x + '" cy="' + o.y + '" r="' + r + '" fill="rgba(201,165,90,0.06)" stroke="#b28c46" stroke-width="' + (unitMap ? 0.8 : 1.5) + '" stroke-dasharray="' + (unitMap ? '3 2' : '7 5') + '"></circle>' +
        '<circle cx="' + o.x + '" cy="' + o.y + '" r="' + (r - (unitMap ? 4 : 14)) + '" fill="none" stroke="#7d6538" stroke-width="' + (unitMap ? 0.45 : 1) + '" stroke-dasharray="' + (unitMap ? '1.4 1.6' : '3 4') + '" opacity="0.7"></circle>';
      hitR = r;
      labelY = o.y + r + (unitMap ? 5 : 26);
      sub = '得分区 · 目标 ' + target + '% · 点击查看积分';
      color = '#c9a55a';
    } else if (type === 'capture-circle') {
      /* 星墓高原中央占领圈：中立单位，可拖动、不可删除。
         圆心取方案里的 escort.circle（旧存档缺字段时回退到地图默认圆心）。
         只画判定圆 o.captureRadius（7 unit）；拖动命中与判定圆同半径，不保留第二套视觉半径。 */
      var capPt = (md.id === 'star-tomb' && GM.captureCirclePoint) ? GM.captureCirclePoint(md, plan) : { x: o.x, y: o.y };
      var cr = o.captureRadius || 7;
      var selected = GM.isSelected('objective', o.id);
      color = selected ? '#e6ca8a' : '#c9a55a';
      shape = '<circle cx="' + capPt.x + '" cy="' + capPt.y + '" r="' + cr + '" fill="rgba(201,165,90,0.1)" stroke="#8f7a48" stroke-width="' + (unitMap ? 0.35 : 1) + '" stroke-dasharray="' + (unitMap ? '1.2 1' : '3 4') + '"></circle>';
      hitR = cr;
      labelY = capPt.y + cr + (unitMap ? 4.6 : 26);
      sub = unitMap ? ('判定半径 ' + cr + ' unit · 可拖动') : ('判定半径 ' + cr + ' · 拖动调整位置');
    } else if (type === 'respawn') {
      /* 四边据点 = 玩家重生点：正圆（半径取实测 rx / ry 均值），势力色描边，中间画复活箭头。
         仅作背景装饰：不可点选、无悬浮反馈。 */
      color = factionColor(project, o.factionId);
      var rr = o.radius || 16;
      shape = '<circle cx="' + o.x + '" cy="' + o.y + '" r="' + rr + '" fill="' + U.esc(color) + '" fill-opacity="0.1" stroke="' + U.esc(color) + '" stroke-width="' + (unitMap ? 0.5 : 1.5) + '"></circle>' +
        '<circle cx="' + o.x + '" cy="' + o.y + '" r="' + starR(rr - (unitMap ? 2.4 : 7)) + '" fill="none" stroke="' + U.esc(color) + '" stroke-width="' + (unitMap ? 0.32 : 0.9) + '" stroke-dasharray="' + (unitMap ? '1.4 1.4' : '4 4') + '" opacity="0.7"></circle>' +
        '<path d="M' + starR(o.x - (unitMap ? 2.4 : 7)) + ',' + starR(o.y + (unitMap ? 1.4 : 4)) + ' L' + o.x + ',' + starR(o.y - (unitMap ? 3 : 9)) + ' L' + starR(o.x + (unitMap ? 2.4 : 7)) + ',' + starR(o.y + (unitMap ? 1.4 : 4)) + ' Z" fill="' + U.esc(color) + '" fill-opacity="0.55"></path>';
      hitR = rr;
      labelY = o.y + rr + (unitMap ? 4.6 : 20);
      sub = unitMap ? (factionName(project, o.factionId) || o.factionId || '重生点') : ('重生点 · ' + (factionName(project, o.factionId) || o.factionId || ''));
    } else if (type === 'plaza') {
      /* 广场 = 护送骑士的终点：正圆，半径取实测 rx / ry 均值。仅作背景装饰。 */
      color = '#a08a5c';
      var pr = o.radius || 10;
      shape = '<circle cx="' + o.x + '" cy="' + o.y + '" r="' + pr + '" fill="' + U.esc(color) + '" fill-opacity="0.1" stroke="' + U.esc(color) + '" stroke-width="' + (unitMap ? 0.5 : 1.5) + '"></circle>' +
        '<circle cx="' + o.x + '" cy="' + o.y + '" r="' + starR(pr - (unitMap ? 1.7 : 6)) + '" fill="none" stroke="' + U.esc(color) + '" stroke-width="' + (unitMap ? 0.3 : 0.9) + '" stroke-dasharray="' + (unitMap ? '1.3 1.3' : '3 3') + '" opacity="0.65"></circle>';
      hitR = pr;
      labelY = o.y + pr + (unitMap ? 4.6 : 22);
      sub = unitMap ? '护送终点' : '护送终点 · 骑士交付';
    } else if (type === 'stair') {
      /* 楼梯：净宽实量 30 px = 10 unit（并排 10 人），按 dir 画踏步线。
         纯背景装饰（星墓高原下 pointer-events: none），命中半径按视觉外接圆取，仅保持数值一致。 */
      color = '#8f98a6';
      var sw = o.w || 10, sh = o.h || 6;
      var sx0 = starR(o.x - sw / 2), sy0 = starR(o.y - sh / 2);
      shape = '<rect x="' + sx0 + '" y="' + sy0 + '" width="' + sw + '" height="' + sh + '" fill="#6f7683" fill-opacity="0.14" stroke="' + U.esc(color) + '" stroke-width="' + (unitMap ? 0.4 : 1.5) + '" stroke-dasharray="' + (unitMap ? '1.4 1.1' : '5 4') + '"></rect>';
      var steps = 3;
      for (var si = 1; si <= steps; si++) {
        if (o.dir === 'N' || o.dir === 'S') {
          var sty = starR(sy0 + sh * si / (steps + 1));
          shape += '<line x1="' + sx0 + '" y1="' + sty + '" x2="' + starR(sx0 + sw) + '" y2="' + sty + '" stroke="' + U.esc(color) + '" stroke-width="' + (unitMap ? 0.28 : 1) + '" opacity="0.7"></line>';
        } else {
          var stx = starR(sx0 + sw * si / (steps + 1));
          shape += '<line x1="' + stx + '" y1="' + sy0 + '" x2="' + stx + '" y2="' + starR(sy0 + sh) + '" stroke="' + U.esc(color) + '" stroke-width="' + (unitMap ? 0.28 : 1) + '" opacity="0.7"></line>';
        }
      }
      hitR = Math.max(sw, sh) / 2;
      labelY = o.dir === 'N' ? starR(o.y - sh / 2 - 2.4) : starR(o.y + sh / 2 + (unitMap ? 4.4 : 18));
      sub = unitMap ? '楼梯 · 上下高台' : '楼梯 · 地面 ↔ 高台';
    } else if (type === 'outpost') {
      color = '#a99a76';
      shape = '<path d="M' + o.x + ',' + (o.y - 16) + ' L' + (o.x + 11) + ',' + o.y + ' L' + o.x + ',' + (o.y + 16) + ' L' + (o.x - 11) + ',' + o.y + ' Z" fill="#3b3426" fill-opacity="0.55" stroke="#c0ad7c" stroke-width="1.4"></path>' +
        '<path d="M' + o.x + ',' + (o.y - 8) + ' L' + (o.x + 5) + ',' + o.y + ' L' + o.x + ',' + (o.y + 8) + ' L' + (o.x - 5) + ',' + o.y + ' Z" fill="#c0ad7c" fill-opacity="0.4"></path>';
      hitR = 30;
      labelY = o.y + 40;
      sub = '外圈哨所';
    } else if (type === 'camp') {
      color = '#a48a54';
      shape = '<path d="M' + (o.x - 22) + ',' + (o.y + 14) + ' L' + o.x + ',' + (o.y - 20) + ' L' + (o.x + 22) + ',' + (o.y + 14) + ' Z" fill="#4a3d26" fill-opacity="0.5" stroke="#a48a54" stroke-width="1.2"></path>' +
        '<rect x="' + (o.x - 3) + '" y="' + (o.y + 2) + '" width="6" height="12" fill="#0b0e12"></rect>' +
        '<line x1="' + (o.x - 22) + '" y1="' + (o.y + 14) + '" x2="' + (o.x + 22) + '" y2="' + (o.y + 14) + '" stroke="#a48a54" stroke-width="1" opacity="0.7"></line>';
      hitR = 36;
      labelY = o.y + 44;
      sub = '外圈营地';
    } else if (o.boss !== undefined) {
      var ownerC = o.ownerFactionId ? factionColor(project, o.ownerFactionId) : null;
      if (plan && plan.scoring && plan.scoring.ownership) {
        ownerC = plan.scoring.ownership[o.id] ? factionColor(project, plan.scoring.ownership[o.id]) : ownerC;
      }
      var oc = ownerC || '#88909c';
      var rr = o.radius || 44;
      shape = '<circle cx="' + o.x + '" cy="' + o.y + '" r="' + rr + '" fill="' + U.esc(oc) + '" fill-opacity="0.12" stroke="' + U.esc(oc) + '" stroke-width="2"></circle>' +
        '<circle cx="' + o.x + '" cy="' + o.y + '" r="' + (rr - 9) + '" fill="none" stroke="' + U.esc(oc) + '" stroke-width="1" stroke-dasharray="4 4" opacity="0.75"></circle>' +
        '<text x="' + o.x + '" y="' + (o.y + 7) + '" fill="#d8d2c2" font-size="19" text-anchor="middle" font-family="Georgia,serif">' + U.esc((o.name || '').replace('据点 ', '')) + '</text>';
      if (o.boss) {
        shape += '<path d="M' + (o.x - 10) + ',' + (o.y - rr - 20) + ' L' + (o.x - 6) + ',' + (o.y - rr - 32) + ' L' + (o.x - 2) + ',' + (o.y - rr - 22) + ' L' + (o.x + 3) + ',' + (o.y - rr - 34) + ' L' + (o.x + 7) + ',' + (o.y - rr - 22) + ' L' + (o.x + 12) + ',' + (o.y - rr - 32) + ' L' + (o.x + 14) + ',' + (o.y - rr - 20) + ' Z" fill="#d6b66e" opacity="0.9"></path>';
      }
      hitR = rr;
      labelY = o.y + rr + 20;
      var ownName = null;
      if (plan && plan.scoring && plan.scoring.ownership && plan.scoring.ownership[o.id]) {
        ownName = factionName(project, plan.scoring.ownership[o.id]);
      }
      sub = '守卫 · ' + (ownName || '无归属') + ' · 点击切换';
      color = oc;
    }

    /* unit 地图的标签字号 / 描边也按 unit 给（世界单位里 11px 字会放大 3 倍糊住通道） */
    var labelStyle = unitMap ? ' style="font-size:3.4px;stroke-width:0.55px"' : '';
    var subStyle = unitMap ? ' style="font-size:2.7px;stroke-width:0.45px"' : '';
    var labelText = '<text class="obj-label" x="' + o.x + '" y="' + labelY + '"' + labelStyle + '>' + U.esc(o.name) + '</text>';
    var subText = sub ? '<text class="obj-label obj-sub" x="' + o.x + '" y="' + starR(labelY + (unitMap ? 2.8 : 13)) + '" fill="' + U.esc(color) + '"' + subStyle + '>' + U.esc(sub) + '</text>' : '';

    /* 星墓高原：四据点 / 四广场 / 四楼梯已退化为纯背景装饰 —— 无热区、无 data-obj、
       无 hover 命中圈，因此不可点选、不弹提示、不改归属。 */
    if (md.id === 'star-tomb' && (type === 'respawn' || type === 'plaza' || type === 'stair')) {
      return '<g class="obj-passive" pointer-events="none">' + shape + labelText + subText + '</g>';
    }

    /* 星墓高原中央占领圈：中立单位，可拖动、不可删除；只有它是可命中的对象 */
    if (type === 'capture-circle') {
      var capLabel = '<text class="obj-label" x="' + capPt.x + '" y="' + labelY + '"' + labelStyle + '>' + U.esc(o.name) + '</text>';
      var capSub = sub ? '<text class="obj-label obj-sub" x="' + capPt.x + '" y="' + starR(labelY + (unitMap ? 2.8 : 13)) + '" fill="' + U.esc(color) + '"' + subStyle + '>' + U.esc(sub) + '</text>' : '';
      return '<g class="capture-circle" data-capture="' + U.esc(o.id) + '">' +
        shape +
        '<circle class="obj-hit" cx="' + capPt.x + '" cy="' + capPt.y + '" r="' + starR(hitR) + '"></circle>' +
        capLabel + capSub +
        '</g>';
    }

    return '<g class="obj-hotspot" data-obj="' + U.esc(o.id) + '" data-obj-type="' + U.esc(type) + '">' +
      shape +
      '<circle class="obj-hit" cx="' + o.x + '" cy="' + o.y + '" r="' + starR(Math.max(hitFloor, hitR)) + '"></circle>' +
      labelText + subText +
      '</g>';
  }

  function spawnNode(s, md, project) {
    var color = factionColor(project, s.factionId);
    var unitMap = isUnitMap(md);
    var k = unitMap ? 0.42 : 1;
    var x = s.x;
    var y = s.y;
    var shape = '<path d="M' + (x - 22 * k) + ',' + (y - 18 * k) + ' L' + (x + 22 * k) + ',' + (y - 18 * k) + ' L' + (x + 30 * k) + ',' + (y + 4 * k) + ' L' + (x + 14 * k) + ',' + (y + 22 * k) + ' L' + (x - 14 * k) + ',' + (y + 22 * k) + ' L' + (x - 30 * k) + ',' + (y + 4 * k) + ' Z" fill="' + U.esc(color) + '" fill-opacity="0.13" stroke="' + U.esc(color) + '" stroke-width="' + (unitMap ? 0.7 : 1.5) + '"></path>' +
      '<circle cx="' + x + '" cy="' + y + '" r="' + (unitMap ? 1.7 : 4) + '" fill="' + U.esc(color) + '"></circle>';
    var labelY = y + 42;
    if (md.mode === 'siege-capture') labelY = y + 46;
    if (md.mode === 'capture' && y > 500) labelY = y + 42;
    if (unitMap) labelY = y + 16;
    return shape + '<text class="obj-label" x="' + x + '" y="' + labelY + '"' + (unitMap ? ' style="font-size:3.4px;stroke-width:0.55px"' : '') + '>' + U.esc(s.name) + '</text>';
  }

  /* ---- 四方战场专属要素（世界单位，1 unit = 1 人宽） ---- */

  function fourClubBossNode(o, project, plan) {
    var owner = null;
    if (plan && plan.scoring && plan.scoring.ownership && plan.scoring.ownership[o.id]) {
      owner = plan.scoring.ownership[o.id];
    }
    var oc = owner ? factionColor(project, owner) : '#8f98a4';
    var r = o.radius || 6.4;
    var num = String(o.name || '').replace('守卫 ', '');
    var out = '<g class="obj-hotspot fc-boss" data-obj="' + U.esc(o.id) + '" data-obj-type="boss">';
    /* 只留小黄圈：描边固定金色，圈内填充随归属势力色变化；不再画外扩的归属圈 */
    out += '<circle class="fc-boss-ring" cx="' + o.x + '" cy="' + o.y + '" r="' + r + '" fill="' + U.esc(oc) + '" fill-opacity="0.6"></circle>';
    out += '<text x="' + o.x + '" y="' + (o.y + r * 0.54).toFixed(2) + '" fill="#fff6e6" text-anchor="middle" font-family="Georgia,serif" style="font-size:' + (r * 1.15).toFixed(2) + 'px">' + U.esc(num) + '</text>';
    /* 1 / 5 号守卫上方的王冠装饰（三段锯齿峰，远看像「山」）已按用户要求移除；
       圆圈、文字与命中区都以 o.x / o.y / r 定位，不受影响。 */
    out += '<circle class="obj-hit" cx="' + o.x + '" cy="' + o.y + '" r="' + Math.max(r + 5, 11).toFixed(2) + '"></circle>';
    out += '<text class="obj-label fc-boss-label" x="' + o.x + '" y="' + (o.y + r + 3.4).toFixed(2) + '" style="font-size:3.1px">' + U.esc(o.name) + '</text>';
    out += '<text class="obj-label obj-sub fc-boss-owner" x="' + o.x + '" y="' + (o.y + r + 6.6).toFixed(2) + '" style="font-size:2.5px">' + (owner ? U.esc(factionName(project, owner)) : '无归属') + ' · 点击切换</text>';
    out += '</g>';
    return out;
  }

  function fourClubSpawnNode(s, project) {
    var color = factionColor(project, s.factionId);
    var r = 5;
    return '<g class="fc-spawn" data-spawn="' + U.esc(s.id) + '">' +
      '<circle cx="' + s.x + '" cy="' + s.y + '" r="' + (r + 1.8) + '" fill="' + U.esc(color) + '" fill-opacity="0.07" stroke="' + U.esc(color) + '" stroke-width="0.35" stroke-dasharray="1.1 0.8"></circle>' +
      '<circle cx="' + s.x + '" cy="' + s.y + '" r="' + r + '" fill="' + U.esc(color) + '" fill-opacity="0.2" stroke="' + U.esc(color) + '" stroke-width="0.6"></circle>' +
      '<circle cx="' + s.x + '" cy="' + s.y + '" r="1.6" fill="' + U.esc(color) + '"></circle>' +
      '<text class="fc-spawn-label" x="' + s.x + '" y="' + (s.y + r + 2.8).toFixed(2) + '" text-anchor="middle" fill="' + U.esc(color) + '" style="font-size:2.6px">' + U.esc(s.name) + '</text>' +
      '</g>';
  }

  /* ---- 俱乐部宣战专属点位（红 = 雕像 / 黄 = 重生·传送 / 绿 = 大旗） ---- */
  var CLUB_WAR_COLORS = { red: '#d24b42', yellow: '#e3b63d', green: '#57b26a' };

  function clubWarNode(o, md, project, plan) {
    var cw = (plan && plan.clubwar) || {};
    var own = cw.ownership || {};
    var statueIds = (md.clubWar && md.clubWar.statueIds) || [];
    var bothHeld = statueIds.every(function (sid) { return own[sid] === true; });
    var occupied = own[o.id] === true;
    var color = CLUB_WAR_COLORS[o.colorKey] || '#9aa2ae';
    var shape = '';
    var sub = '';
    var labelY = 0;
    var interactive = false;

    if (o.type === 'statue') {
      shape = '<circle cx="' + o.x + '" cy="' + o.y + '" r="7" fill="' + color + '" fill-opacity="0.34" stroke="#f2ead6" stroke-width="1.1"></circle>' +
        '<circle cx="' + o.x + '" cy="' + o.y + '" r="3.2" fill="' + color + '"></circle>' +
        '<line x1="' + (o.x - 2.6) + '" y1="' + (o.y + 5) + '" x2="' + (o.x + 2.6) + '" y2="' + (o.y + 5) + '" stroke="#f2ead6" stroke-width="0.7" opacity="0.8"></line>';
      labelY = o.y + 13.5;
      sub = (occupied ? '已占领' : '未占领') + ' · 点击切换';
      interactive = true;
    } else if (o.type === 'attacker-spawn') {
      shape = '<circle cx="' + o.x + '" cy="' + o.y + '" r="5.2" fill="' + color + '" fill-opacity="0.22" stroke="#f2ead6" stroke-width="0.9"></circle>' +
        '<path d="M' + (o.x - 2.6) + ',' + o.y + ' L' + o.x + ',' + (o.y - 3.2) + ' L' + (o.x + 2.6) + ',' + o.y + ' Z" fill="' + color + '"></path>';
      labelY = o.y + 10.6;
      sub = '攻方复活点';
    } else if (o.type === 'defender-teleport') {
      shape = '<circle cx="' + o.x + '" cy="' + o.y + '" r="5" fill="' + color + '" fill-opacity="0.18" stroke="#f2ead6" stroke-width="0.9"></circle>' +
        '<circle cx="' + o.x + '" cy="' + o.y + '" r="3.2" fill="none" stroke="' + color + '" stroke-width="0.8" stroke-dasharray="1.2 0.9"></circle>' +
        '<text x="' + o.x + '" y="' + (o.y + 1.5) + '" fill="' + color + '" font-size="2.6" text-anchor="middle">传</text>';
      labelY = o.y + 10.6;
      sub = bothHeld ? '已禁用' : '可传送';
    } else if (o.type === 'defender-spawn') {
      shape = '<circle cx="' + o.x + '" cy="' + o.y + '" r="6" fill="' + color + '" fill-opacity="0.2" stroke="#f2ead6" stroke-width="0.9"></circle>' +
        '<circle cx="' + o.x + '" cy="' + o.y + '" r="4.2" fill="none" stroke="' + color + '" stroke-width="0.7" stroke-dasharray="1.2 0.9"></circle>' +
        '<path d="M' + (o.x - 1.9) + ',' + (o.y + 1.1) + ' L' + o.x + ',' + (o.y - 2) + ' L' + (o.x + 1.9) + ',' + (o.y + 1.1) + ' Z" fill="' + color + '"></path>';
      labelY = o.y + 12.4;
      sub = bothHeld ? '重生点 + 传送点 · 唯一传送目标' : '重生点 + 传送点 · 可传送';
    } else if (o.type === 'flag') {
      shape = '<circle cx="' + o.x + '" cy="' + o.y + '" r="7" fill="' + color + '" fill-opacity="0.3" stroke="#f2ead6" stroke-width="1.1"></circle>' +
        '<line x1="' + (o.x - 2.4) + '" y1="' + (o.y + 5.2) + '" x2="' + (o.x - 2.4) + '" y2="' + (o.y - 5.2) + '" stroke="#f2ead6" stroke-width="0.7"></line>' +
        '<path d="M' + (o.x - 1.8) + ',' + (o.y - 5.2) + ' L' + (o.x + 4.6) + ',' + (o.y - 3.4) + ' L' + (o.x - 1.8) + ',' + (o.y - 1.6) + ' Z" fill="' + color + '"></path>';
      labelY = o.y + 13.5;
      sub = occupied ? '已占领' : (bothHeld ? '未占领 · 可攻' : '未占领 · 不可攻');
      interactive = true;
    }

    var labelStyle = ' style="font-size:3.4px;stroke-width:0.55px"';
    var subStyle = ' style="font-size:2.7px;stroke-width:0.45px"';
    var label = '<text class="obj-label" x="' + o.x + '" y="' + labelY + '"' + labelStyle + '>' + U.esc(o.name) + '</text>';
    var subText = sub ? '<text class="obj-label obj-sub" x="' + o.x + '" y="' + (labelY + 2.8) + '" fill="' + color + '"' + subStyle + '>' + U.esc(sub) + '</text>' : '';
    if (!interactive) return '<g class="obj-passive club-point" pointer-events="none">' + shape + label + subText + '</g>';
    return '<g class="obj-hotspot club-point" data-obj="' + U.esc(o.id) + '" data-obj-type="' + U.esc(o.type) + '">' + shape +
      '<circle class="obj-hit" cx="' + o.x + '" cy="' + o.y + '" r="12"></circle>' + label + subText + '</g>';
  }

  function renderObjectives(md, project, level, layered) {
    var plan = GM.activePlan();
    var out = '';
    var visibleLevel = layered ? level : null;

    if (md.mode === 'club-war') {
      if (!layerOn('points', md)) return '';
      (md.objectives || []).forEach(function (o) {
        if (visibleLevel && (o.level || 'ground') !== visibleLevel) return;
        out += clubWarNode(o, md, project, plan);
      });
      return photoWrap(md, out);
    }

    if (md.id === 'four-club') {
      (md.objectives || []).forEach(function (o) {
        if (visibleLevel && (o.level || 'ground') !== visibleLevel) return;
        out += fourClubBossNode(o, project, plan);
      });
      (md.spawns || []).forEach(function (s) {
        if (visibleLevel && (s.level || 'ground') !== visibleLevel) return;
        out += fourClubSpawnNode(s, project);
      });
      return out;
    }

    (md.objectives || []).forEach(function (o) {
      if (visibleLevel && (o.level || 'ground') !== visibleLevel) return;
      out += objectiveNode(o, md, plan, project);
    });

    (md.spawns || []).forEach(function (s) {
      if (visibleLevel && (s.level || 'ground') !== visibleLevel) return;
      out += spawnNode(s, md, project);
    });

    /* 原图模式下石碑 / 城门 / 平台 / 出生点都压在照片上：白描边 + 深阴影 */
    return photoWrap(md, out);
  }

  /* ============================ 据点热交互 ============================ */

  function findObjective(md, id) {
    var hit = null;
    (md.objectives || []).forEach(function (o) { if (o.id === id) hit = o; });
    return hit;
  }

  function nextFactionId(current, factions) {
    var ids = [null];
    factions.forEach(function (f) { ids.push(f.id); });
    var idx = ids.indexOf(current === undefined ? null : current);
    if (idx < 0) idx = 0;
    return ids[(idx + 1) % ids.length];
  }

  /* 统计占领圈内各势力人数（按标记所属队伍人数累加） */
  function circleCounts(o, level) {
    var phase = GM.activePhase();
    var result = { total: 0, byFaction: {} };
    var r = o.radius || 118;
    (phase ? phase.markers : []).forEach(function (m) {
      if (m.mapLayer !== (o.level || level || 'upper')) return;
      var d = Math.sqrt(Math.pow(m.x - o.x, 2) + Math.pow(m.y - o.y, 2));
      if (d > r) return;
      var team = GM.findTeam(m.teamId);
      var n = team ? GM.teamCount(team) : 0;
      if (!n) return;
      var fid = team.factionId || 'A';
      result.byFaction[fid] = (result.byFaction[fid] || 0) + n;
      result.total += n;
    });
    return result;
  }

  function handleObjective(id) {
    var md = GM.currentMap();
    var project = GM.state.project;
    var plan = GM.activePlan();
    var o = findObjective(md, id);
    if (!md || !project || !plan) return;
    var toast = (GM.ui && GM.ui.toast) ? GM.ui.toast : function () {};

    /* 俱乐部宣战：雕像 / 大旗只有 未占领 / 已占领 两态，点击直接切换；
       任一雕像取消占领 → 大旗一并回落到未占领并重新锁定 */
    if (md.mode === 'club-war') {
      if (!o) return;
      GM.ensurePlanMeta(plan);
      var cw = plan.clubwar;
      var own = cw.ownership;
      var statueIds = (md.clubWar && md.clubWar.statueIds) || ['statue-up', 'statue-down'];
      var flagId = (md.clubWar && md.clubWar.flagId) || 'flag';
      var bothHeld = statueIds.every(function (sid) { return own[sid] === true; });

      if (o.type === 'flag') {
        if (!bothHeld) {
          toast('大旗不可攻：两座战争雕像尚未全部占领', 'error');
          return;
        }
        own[id] = own[id] !== true;
        GM.commit('推演大旗占领');
        toast(o.name + ' → ' + (own[id] ? '已占领' : '未占领') +
          (own[id] ? '（攻方获胜）' : ''), own[id] ? 'success' : '');
        return;
      }

      if (o.type === 'statue') {
        own[id] = own[id] !== true;
        var nowBoth = statueIds.every(function (sid) { return own[sid] === true; });
        /* 雕像失守 → 屏障恢复，大旗回落到未占领 */
        if (!nowBoth) own[flagId] = false;
        GM.commit('推演雕像占领');
        toast(o.name + ' → ' + (own[id] ? '已占领' : '未占领') +
          (nowBoth ? '（两座雕像均已占领，大旗可攻）' : ''), own[id] ? 'success' : '');
        return;
      }

      toast(o.name, 'success');
      return;
    }

    /* 四方战保护结界（底图美术层）：点选仅展示说明与归属，不写入方案、不参与可拖动对象 */
    if (md.id === 'four-club') {
      var br = null;
      (md.barriers || []).forEach(function (x) { if (x.id === id) br = x; });
      if (br) {
        toast('保护结界：' + br.effect + ' · 归属 ' + (factionName(project, br.ownerFactionId) || '无归属') + '（半径 ' + br.radius + ' unit）', 'success');
        return;
      }
    }

    if (!o) return;
    GM.ensurePlanMeta(plan);

    if (o.type === 'stele') {
      var next = nextFactionId(plan.siege.steles[id], project.factions);
      plan.siege.steles[id] = next;
      GM.commit('推演石碑归属');
      var related = (md.siege.gates || []).filter(function (g) { return g.unlocks.indexOf(id) > -1; });
      var stateText = related.map(function (g) { return g.name + ' ' + GM.siegeGateLabel(GM.siegeGateState(plan, g)); }).join(' · ');
      toast(o.name + ' → ' + (next ? factionName(project, next) : '未占领') + '（' + stateText + '）', 'success');
      return;
    }

    if (o.type === 'gate') {
      var gate = null;
      (md.siege.gates || []).forEach(function (g) { if (g.id === id) gate = g; });
      if (!gate) return;
      var state = GM.siegeGateState(plan, gate);
      if (state === 'broken') {
        plan.siege.gates[id] = false;
        GM.commit('撤销破门');
        toast(gate.name + ' → 可攻（已撤销破门）', 'success');
      } else if (state === 'ready') {
        plan.siege.gates[id] = true;
        GM.commit('标记破门');
        toast(gate.name + ' 已破，内城开放', 'success');
      } else {
        var missing = gate.unlocks.map(function (sid) {
          var s = null;
          (md.siege.steles || []).forEach(function (x) { if (x.id === sid) s = x; });
          return (s ? s.name : sid) + (plan.siege.steles[sid] === gate.factionId ? '✓' : '✗');
        }).join(' + ');
        toast(gate.name + ' 未解锁：需 ' + missing + ' 均归本方', 'error');
      }
      return;
    }

    if (o.type === 'platform') {
      var scores = plan.siege.platformScores || {};
      var text = project.factions.slice(0, md.factionCount).map(function (f) {
        return f.name + ' ' + (Number(scores[f.id]) || 0) + '%';
      }).join(' / ');
      toast('中央高台积分：' + text + '（目标 ' + GM.siegeScoreTarget(plan) + '%）', 'success');
      return;
    }

    if (o.type === 'outpost') {
      toast(o.name + ' · 外圈哨所（参考图 8 哨之一）', 'success');
      return;
    }

    if (o.type === 'camp') {
      toast(o.name + ' · 外圈营地（参考图 8 营之一）', 'success');
      return;
    }

    if (o.boss !== undefined) {
      var owner = plan.scoring.ownership[id];
      var nextOwner = nextFactionId(owner, project.factions);
      plan.scoring.ownership[id] = nextOwner;
      GM.commit('推演守卫归属');
      toast(o.name + ' → ' + (nextOwner ? factionName(project, nextOwner) : '无归属') +
        (nextOwner ? '（最后一击夺权，守卫立即重生并归属本方）' : ''), 'success');
      return;
    }

    toast(o.name, 'success');
  }

  board.handleObjective = handleObjective;
  board.circleCounts = circleCounts;

  /* ============================ 标记渲染 ============================ */

  function truncate(str, len) {
    str = String(str || '');
    return str.length > len ? str.slice(0, len) + '…' : str;
  }

  function findPresetMember(node, memberId) {
    if (!node || !memberId) return null;
    var hit = null;
    (node.members || []).forEach(function (m) { if (!hit && m.id === memberId) hit = m; });
    (node.children || []).forEach(function (child) { if (!hit) hit = findPresetMember(child, memberId); });
    return hit;
  }

  function markerFactionId(marker) {
    var team = GM.findTeam(marker.teamId);
    if (team) return team.factionId || 'A';
    return (marker.ref && marker.ref.factionId) || null;
  }

  /* 敌方标记是否落在保护结界内（用于明显提示）；结界固定归属，不看 project 覆盖 */
  function markerInEnemyBarrier(marker, md, project) {
    if (!md || md.id !== 'four-club') return false;
    var fid = markerFactionId(marker);
    if (!fid) return false;
    var hit = false;
    (md.barriers || []).forEach(function (br) {
      if (hit || !br.ownerFactionId || br.ownerFactionId === fid) return;
      var dx = marker.x - br.x, dy = marker.y - br.y;
      if (dx * dx + dy * dy <= br.radius * br.radius) hit = true;
    });
    return hit;
  }

  /* ============================ 标记标签布局 ============================ */

  /* 联盟 / 团队 / 小队 / 个人四级标签做一次顺序化的避让求解（个人级沿用同一套）：
     - 固定 12 个候选位：下方、上方、下方左 / 右各 1~3 步、上方左 / 右各 1 步、更下方、更上方；
       按顺序取第一个不越画布边界、也不与已放置标签相交的候选位，不做全局搜索。
     - 单帧上限：最多求解 60 个标签、最多登记 120 个矩形、最多约 4 万次矩形相交测试；
       超出任一上限后剩余标签退回旧的「下方 / 边缘翻转」排布，外观不变。
     - 标识框被「仅选中时显示」隐藏时不登记、不参与避让。 */
  var LABEL_MAX_SEARCH = 60;
  var LABEL_MAX_BOXES = 120;
  var LABEL_MAX_CHECKS = 40000;

  var labelLayout = { active: false, boxes: [], searched: 0, checks: 0 };

  function beginLabelLayout() {
    labelLayout.active = true;
    labelLayout.boxes = [];
    labelLayout.searched = 0;
    labelLayout.checks = 0;
  }

  function endLabelLayout() {
    labelLayout.active = false;
    labelLayout.boxes = [];
    labelLayout.searched = 0;
    labelLayout.checks = 0;
  }

  function labelRect(marker, shift, top, m) {
    var half = m.width / 2;
    return {
      x1: marker.x + shift - half,
      x2: marker.x + shift + half,
      y1: marker.y + top,
      y2: marker.y + top + m.height
    };
  }

  function registerLabelBox(marker, shift, top, m) {
    if (labelLayout.boxes.length >= LABEL_MAX_BOXES) return;
    labelLayout.boxes.push(labelRect(marker, shift, top, m));
  }

  function hitsAny(rect, boxes, pad) {
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (rect.x1 < b.x2 + pad && rect.x2 > b.x1 - pad &&
          rect.y1 < b.y2 + pad && rect.y2 > b.y1 - pad) return true;
    }
    return false;
  }

  function solveLabelPlacement(m, marker, unit) {
    var belowTop = m.belowTop;
    var aboveTop = m.aboveTop;
    var fallback = { shift: m.edgeShift, top: m.baseTop };

    var canSearch = labelLayout.searched < LABEL_MAX_SEARCH &&
      labelLayout.boxes.length < LABEL_MAX_BOXES &&
      labelLayout.checks < LABEL_MAX_CHECKS;
    if (!canSearch) {
      registerLabelBox(marker, fallback.shift, fallback.top, m);
      return fallback;
    }
    labelLayout.searched += 1;

    var colStep = m.width * 0.5 + (unit ? 1 : 4);
    var rowStep = m.height + m.gap * 0.6;
    var cands = [
      { dx: 0, top: belowTop },
      { dx: 0, top: aboveTop },
      { dx: colStep, top: belowTop },
      { dx: -colStep, top: belowTop },
      { dx: colStep * 2, top: belowTop },
      { dx: -colStep * 2, top: belowTop },
      { dx: colStep * 3, top: belowTop },
      { dx: -colStep * 3, top: belowTop },
      { dx: colStep, top: aboveTop },
      { dx: -colStep, top: aboveTop },
      { dx: 0, top: belowTop + rowStep },
      { dx: 0, top: aboveTop - rowStep }
    ];

    var pad = unit ? 0.35 : 3;
    var bd = m.bd;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      var rect = labelRect(marker, c.dx, c.top, m);
      if (rect.x1 < m.margin || rect.x2 > bd.width - m.margin) continue;
      if (rect.y1 < m.margin || rect.y2 > bd.height - m.margin) continue;
      labelLayout.checks += labelLayout.boxes.length;
      if (labelLayout.checks > LABEL_MAX_CHECKS) break;
      if (hitsAny(rect, labelLayout.boxes, pad)) continue;
      registerLabelBox(marker, c.dx, c.top, m);
      return { shift: c.dx, top: c.top };
    }
    registerLabelBox(marker, fallback.shift, fallback.top, m);
    return fallback;
  }

  /* 标签相对图标位移后，从标记左上角锚点拉一条细线到标签最近的边。
     锚点由标记本体返回（leaderFrom），坐标与标签同为标记局部坐标系。 */
  function markerLeaderSvg(m, from, unit, color, shift, top) {
    var ax = from ? Number(from.x) || 0 : 0;
    var ay = from ? Number(from.y) || 0 : 0;
    var half = m.width / 2;
    var left = shift - half;
    var right = shift + half;
    var boxTop = top;
    var boxBottom = top + m.height;

    /* 点到矩形的最近点：落在框内时再投影到最近的边 */
    var px = Math.min(Math.max(ax, left), right);
    var py = Math.min(Math.max(ay, boxTop), boxBottom);
    if (ax > left && ax < right && ay > boxTop && ay < boxBottom) {
      var dl = ax - left, dr = right - ax, dt = ay - boxTop, db = boxBottom - ay;
      var min = Math.min(dl, dr, dt, db);
      if (min === dt) py = boxTop;
      else if (min === db) py = boxBottom;
      else if (min === dl) px = left;
      else px = right;
    }

    var dx = px - ax;
    var dy = py - ay;
    if (Math.sqrt(dx * dx + dy * dy) < (unit ? 0.5 : 2)) return '';

    var sw = unit ? 0.25 : 1;
    var dash = unit ? '0.9 0.9' : '3 3';
    return '<line class="marker-leader" x1="' + ax.toFixed(2) + '" y1="' + ay.toFixed(2) +
      '" x2="' + px.toFixed(2) + '" y2="' + py.toFixed(2) +
      '" stroke="' + U.esc(color || '#8a919f') + '" stroke-width="' + sw +
      '" stroke-opacity="0.3" stroke-dasharray="' + dash + '" pointer-events="none"></line>';
  }

  /* 标签统一两行：名称在上、人数/状态在下。底板按字符宽度估算，避免固定宽度裁切文字 */
  function estimateTextWidth(text, fontSize) {
    var w = 0;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) w += 1;
      else if (ch === ' ') w += 0.36;
      else w += 0.62;
    }
    return w * fontSize;
  }

  function markerTagMetrics(name, sub, unit, iconBottom, marker, compactGap) {
    var fsName = unit ? 2.3 : 11;
    var fsSub = unit ? 1.8 : 9.5;
    var lineGap = unit ? 3 : 16;
    var padX = unit ? 1.2 : 7;
    var padY = unit ? 1 : 5;
    var rx = unit ? 0.8 : 3.5;
    /* 标签与图标之间的间隙需让开外挪后的方向箭头（任何朝向都不压住箭头）；
       无方向箭头的图标型标记改用紧凑间距 */
    var arrowOut = unit
      ? ARROW_SPEC.unit.pad + ARROW_SPEC.unit.gap + ARROW_SPEC.unit.len
      : ARROW_SPEC.regular.pad + ARROW_SPEC.regular.gap + ARROW_SPEC.regular.len;
    var gap = compactGap ? (unit ? 0.6 : 6) : arrowOut + (unit ? 0.4 : 3);
    var margin = unit ? 1.2 : 6;

    var nameW = estimateTextWidth(name, fsName);
    var subW = sub ? estimateTextWidth(sub, fsSub) : 0;
    var width = Math.max(nameW, subW) + padX * 2;
    var nameBase = padY + fsName * 0.88;
    var height = sub
      ? padY * 2 + fsName * 0.88 + lineGap + fsSub * 0.22
      : padY * 2 + fsName * 1.1;
    var subBase = nameBase + lineGap;

    /* 不避让时的旧排布：默认贴图标下方；靠近底边翻到上方；贴近左右边整体内移 */
    var md = GM.currentMap();
    var bd = (md && md.board) || { width: 1600, height: 1000 };
    var belowTop = iconBottom + gap;
    var aboveTop = -iconBottom - gap - height;
    var baseTop = belowTop;
    if (marker.y + belowTop + height > bd.height - margin) {
      if (marker.y + aboveTop >= margin) baseTop = aboveTop;
      else baseTop = Math.max(aboveTop, margin - marker.y);
    }

    var half = width / 2;
    var edgeShift = 0;
    if (marker.x - half < margin) edgeShift = margin - (marker.x - half);
    else if (marker.x + half > bd.width - margin) edgeShift = (bd.width - margin) - (marker.x + half);

    return {
      fsName: fsName, fsSub: fsSub,
      lineGap: lineGap, padX: padX, padY: padY, rx: rx, gap: gap, margin: margin,
      width: width, height: height, nameBase: nameBase, subBase: subBase,
      belowTop: belowTop, aboveTop: aboveTop, baseTop: baseTop, edgeShift: edgeShift,
      bd: bd
    };
  }

  function markerTagSvg(name, sub, iconBottom, unit, marker, opts) {
    opts = opts || {};
    var m = markerTagMetrics(name, sub, unit, iconBottom, marker, opts.compactGap);
    var shift = m.edgeShift;
    var top = m.baseTop;
    var moved = false;

    if (opts.avoid) {
      if (labelLayout.active) {
        var placed = solveLabelPlacement(m, marker, unit);
        shift = placed.shift;
        top = placed.top;
      }
      moved = Math.abs(top - m.belowTop) > 0.05 || Math.abs(shift) > 0.05;
    }

    var leaderFrom = opts.leaderFrom || { x: 0, y: iconBottom };
    var leader = moved ? markerLeaderSvg(m, leaderFrom, unit, opts.color, shift, top) : '';
    var half = m.width / 2;
    var strokeName = unit ? 0.3 : 1.6;
    var strokeSub = unit ? 0.24 : 1.3;
    return leader +
      '<g class="marker-tag" transform="translate(' + shift.toFixed(2) + ' ' + top.toFixed(2) + ')" pointer-events="none">' +
      '<rect class="marker-tag-bg" x="' + (-half).toFixed(2) + '" y="0" width="' + m.width.toFixed(2) + '" height="' + m.height.toFixed(2) + '" rx="' + m.rx + '" style="stroke-width:' + (unit ? 0.14 : 1) + 'px"></rect>' +
      '<text class="marker-label" x="0" y="' + m.nameBase.toFixed(2) + '" style="font-size:' + m.fsName + 'px;stroke-width:' + strokeName + 'px">' + U.esc(name) + '</text>' +
      (sub ? '<text class="marker-sub" x="0" y="' + m.subBase.toFixed(2) + '" style="font-size:' + m.fsSub + 'px;stroke-width:' + strokeSub + 'px;fill:' + U.esc(opts.subColor || '#9aa1ae') + '">' + U.esc(sub) + '</text>' : '') +
      '</g>';
  }

  /* 标识框显示策略：按级别固定显示，或仅在选中时显示；设置跟随工程持久化 */
  function labelVisible(marker, kind) {
    var project = GM.state.project;
    var pinned = project && project.labels && project.labels.pinned;
    var fixed = pinned && typeof pinned[kind] === 'boolean' ? pinned[kind] : (kind !== 'person');
    return fixed || GM.isSelected('marker', marker.id);
  }

  /* ============================ 标记圆形体系 ============================ */

  /* 外圈只表达状态：五状态统一为实线 + 同一线宽，只换颜色（不再用线宽 / 虚实区分） */
  var STATUS_RING_WIDTH = { regular: 2.2, unit: 0.5 };

  function statusRing(unit) {
    return { width: unit ? STATUS_RING_WIDTH.unit : STATUS_RING_WIDTH.regular };
  }

  /* 联盟 / 团队 / 小队的内圈填充由 marker.fill 决定（不再由敌我关系决定）；
     敌我关系统一写进标识框第二行。个人级内圈仍是职业色。 */
  function markerRelation(marker) {
    return GM.relationById(GM.normRelation(marker && marker.relation));
  }

  /* 半径沿用原有尺寸层级：联盟按人数 30~50（unit 4~8）> 团队 > 小队 > 个人 */
  function markerRadius(kind, count, unit) {
    if (unit) {
      if (kind === 'alliance') {
        var sc = count > 0 ? count : 150;
        return 4 + 4 * Math.sqrt(Math.min(150, sc) / 150);
      }
      if (kind === 'team') return 3.2;
      if (kind === 'squad') return 2;
      return 0.5;
    }
    if (kind === 'alliance') {
      var scale = count > 0 ? count : 150;
      return Math.round(30 + 20 * Math.sqrt(Math.min(150, scale) / 150));
    }
    if (kind === 'team') return 15;
    if (kind === 'squad') return 10;
    return 7;
  }

  /* 朝向箭头：0~360 直接作为 rotate 角度，0 指向正上方。
     箭头整体外挪到最外层环之外（pad 含选中白环半径，gap 为可见空隙），
     四级统一尺寸，只跟随状态色与朝向，不再随标记半径缩放。 */
  var ARROW_SPEC = {
    regular: { pad: 7, gap: 4, len: 8, half: 4.5 },
    unit: { pad: 1.0, gap: 0.7, len: 1.1, half: 0.55 }
  };

  function markerArrow(r, rot, color, unit) {
    var a = unit ? ARROW_SPEC.unit : ARROW_SPEC.regular;
    var base = r + a.pad + a.gap;
    var tip = base + a.len;
    return '<g transform="rotate(' + rot + ')"><path d="M0 ' + (-tip).toFixed(2) +
      ' L' + a.half.toFixed(2) + ' ' + (-base).toFixed(2) +
      ' L' + (-a.half).toFixed(2) + ' ' + (-base).toFixed(2) +
      ' Z" fill="' + U.esc(color) + '"></path></g>';
  }

  function markerCircleBody(kind, innerColor, status, count, rot, unit) {
    var r = markerRadius(kind, count, unit);
    var rs = statusRing(unit);
    var ring = '<circle class="m-select-ring" r="' + (r + (unit ? 0.8 : 6)).toFixed(2) + '"></circle>';
    var halo = '<circle class="m-halo" r="' + (r + (unit ? 0.3 : 2.4)).toFixed(2) + '" fill="none" stroke="' +
      U.esc(status.color) + '" stroke-opacity="0.22" stroke-width="' + (unit ? 0.45 : 2.2) +
      '" pointer-events="none"></circle>';
    var core = '<circle class="m-shape" r="' + r.toFixed(2) + '" fill="' + U.esc(innerColor) +
      '" fill-opacity="0.4" stroke="' + U.esc(status.color) + '" stroke-width="' + rs.width + '"></circle>';
    /* 填充与状态描边之间加一圈深色细环：底色与状态色在深底上更易读，也不让两色糊在一起 */
    var seam = '<circle class="m-seam" r="' + Math.max(r - (unit ? 0.32 : 2), unit ? 0.2 : 2).toFixed(2) +
      '" fill="none" stroke="#070b11" stroke-opacity="0.6" stroke-width="' + (unit ? 0.16 : 1.1) +
      '" pointer-events="none"></circle>';
    var shape = halo + core + seam;
    var ax = -r * 0.72;
    var ay = -r * 0.72;
    var anchor = '<circle class="m-anchor" cx="' + ax.toFixed(2) + '" cy="' + ay.toFixed(2) +
      '" r="' + (unit ? 0.18 : 1.5) + '" fill="' + U.esc(innerColor) +
      '" stroke="#0a0e14" stroke-width="' + (unit ? 0.1 : 0.8) + '"></circle>';
    /* 透明命中圈保留原有点选手感：个人级沿用旧的 12 / 0.62 半径，其余按本体略放大一圈 */
    var hitR = kind === 'person' ? (unit ? 0.62 : 12) : (unit ? r + 0.08 : r + 1.5);
    var hit = '<circle class="m-hit" r="' + hitR.toFixed(2) + '" fill="transparent" pointer-events="all"></circle>';
    var countText = '';
    if (count) {
      var fs = unit ? (kind === 'alliance' ? 1.9 : (kind === 'team' ? 1.5 : 1.3))
        : (kind === 'squad' ? 8.5 : 10);
      var ty = unit ? fs * 0.35 : 4;
      countText = '<text y="' + ty.toFixed(2) + '" text-anchor="middle" font-size="' + fs +
        '" fill="#f0e6d0" font-family="Segoe UI, sans-serif">' + count + '</text>';
    }
    return {
      ring: ring,
      shape: shape,
      anchor: anchor,
      hit: hit,
      countText: countText,
      arrow: markerArrow(r, rot, status.color, unit),
      iconBottom: r,
      leaderFrom: { x: ax, y: ay }
    };
  }

  /* 标识框第二行：三级标记「敌我 / 人数 / 状态」；个人标记（一级）没有人数概念，
     固定为「敌我 / 状态」。这一行始终完整输出，不做截断；
     空间不足时只压第一行名称（见 fitTextWidth）。 */
  function markerSubText(relationName, count, statusName, personOnly) {
    if (personOnly) return (relationName || '敌方(红)') + ' / ' + (statusName || '');
    return (relationName || '敌方(红)') + ' / ' + Math.max(0, Math.round(Number(count) || 0)) + '人 / ' + (statusName || '');
  }

  /* 第一行名称按可用宽度压缩（超出则末尾省略），第二行永远保持完整 */
  function fitTextWidth(text, fontSize, maxWidth) {
    text = String(text || '');
    if (estimateTextWidth(text, fontSize) <= maxWidth) return text;
    var out = text;
    while (out.length > 1 && estimateTextWidth(out + '…', fontSize) > maxWidth) {
      out = out.slice(0, -1);
    }
    return out + '…';
  }

  function personMarkerSvg(marker, ref) {
    var md = GM.currentMap();
    var unit = isUnitMap(md);
    /* 个人级内圈用成员职业色；优先按 classId 读当前职业配色表，快照 classColor 仅作兜底。
       敌我关系改由标识框第二行文字表达。 */
    var cls = U.classById(ref.classId);
    if (cls && cls.id !== ref.classId) cls = null;
    var color = (cls && cls.color) || ref.classColor || '#8a919f';
    var classLabel = (cls && cls.name) || ref.className || '未知职业';
    var relation = markerRelation(marker);
    var status = U.statusById(marker.status);
    var count = GM.markerCount(marker);
    var selected = GM.isSelected('marker', marker.id) ? ' selected' : '';
    var opacity = marker.status === 'dead' ? 0.5 : (marker.status === 'attrition' ? 0.86 : 1);
    var skills = (ref.skills || []).filter(function (s) { return !!s; }).join(' / ');
    var tip = (ref.name || '队员') + ' · ' + classLabel +
      (ref.form ? ' · ' + ref.form : '') + (skills ? ' · 技能：' + skills : '');
    var warn = markerInEnemyBarrier(marker, md, GM.state.project) ? ' in-enemy-barrier' : '';
    var b = markerCircleBody('person', color, status, 0, GM.normAngle(marker.rot, 0), unit);
    var sub = markerSubText(relation.name, count, status.name, true);
    var tag = labelVisible(marker, 'person')
      ? markerTagSvg(fitTextWidth(truncate(ref.name || '队员', 10), unit ? 2.3 : 11, unit ? 54 : 168),
        sub, b.iconBottom, unit, marker,
        { avoid: true, color: relation.color, subColor: relation.color, leaderFrom: b.leaderFrom })
      : '';

    return '<g class="marker kind-person' + selected + warn + '" data-marker-id="' + U.esc(marker.id) + '"' +
      ' transform="translate(' + marker.x + ' ' + marker.y + ')" opacity="' + opacity + '">' +
      '<title>' + U.esc(tip) + '</title>' +
      b.ring + b.shape + b.arrow + b.anchor + b.countText + b.hit +
      tag +
      '</g>';
  }

  /* 第二类标记工具：图标型标记（进攻 / 虚线进攻 / 防守 / 禁止 / 集结）。
     只画图标 + 名称标签，不带敌我色环、人数、状态，也不参与推演。 */
  var ICON_GLYPH = { regular: 14, unit: 2.4 };

  function iconDefById(type) {
    var def = null;
    (window.GM_DATA.iconMarkers || []).forEach(function (d) { if (d.id === type) def = d; });
    return def;
  }

  function iconGlyphSvg(type, color, s, unit, rot) {
    var sw = unit ? 0.22 : 1.8;
    var dash = unit ? '0.8 0.5' : '4 3';
    var body = '';
    var col = U.esc(color);
    if (type === 'attack') {
      body = '<path d="M0 ' + (-s) + ' L' + (s * 0.58) + ' ' + (-s * 0.05) + ' L' + (s * 0.2) + ' ' + (-s * 0.05) +
        ' L' + (s * 0.2) + ' ' + (s * 0.85) + ' L' + (-s * 0.2) + ' ' + (s * 0.85) +
        ' L' + (-s * 0.2) + ' ' + (-s * 0.05) + ' L' + (-s * 0.58) + ' ' + (-s * 0.05) +
        ' Z" fill="' + col + '"></path>';
    } else if (type === 'attackDash') {
      body = '<path d="M0 ' + (-s) + ' L' + (s * 0.58) + ' ' + (-s * 0.05) + ' L' + (-s * 0.58) + ' ' + (-s * 0.05) +
        ' Z" fill="' + col + '"></path>' +
        '<line x1="0" y1="' + (s * 0.05) + '" x2="0" y2="' + (s * 0.85) + '" stroke="' + col +
        '" stroke-width="' + sw + '" stroke-dasharray="' + dash + '"></line>';
    } else if (type === 'defense') {
      body = '<path d="M0 ' + (-s) + ' L' + (s * 0.78) + ' ' + (-s * 0.62) + ' L' + (s * 0.78) + ' ' + (s * 0.1) +
        ' Q0 ' + (s * 1.05) + ' ' + (-s * 0.78) + ' ' + (s * 0.1) + ' L' + (-s * 0.78) + ' ' + (-s * 0.62) +
        ' Z" fill="' + col + '" fill-opacity="0.22" stroke="' + col + '" stroke-width="' + sw + '"></path>';
    } else if (type === 'forbid') {
      body = '<circle r="' + (s * 0.82) + '" fill="none" stroke="' + col + '" stroke-width="' + sw + '"></circle>' +
        '<line x1="' + (-s * 0.58) + '" y1="' + (-s * 0.58) + '" x2="' + (s * 0.58) + '" y2="' + (s * 0.58) +
        '" stroke="' + col + '" stroke-width="' + sw + '"></line>';
    } else if (type === 'rallyFlag') {
      body = '<line x1="0" y1="' + (-s) + '" x2="0" y2="' + s + '" stroke="' + col + '" stroke-width="' + sw + '"></line>' +
        '<path d="M0 ' + (-s) + ' L' + (s * 0.78) + ' ' + (-s * 0.58) + ' L0 ' + (-s * 0.16) +
        ' Z" fill="' + col + '"></path>';
    }
    if (!body) return '';
    return '<g transform="rotate(' + rot + ')">' + body + '</g>';
  }

  function iconMarkerSvg(marker) {
    var md = GM.currentMap();
    var unit = isUnitMap(md);
    var def = iconDefById(marker.iconType);
    var color = marker.iconColor || (def && def.color) || '#c9a55a';
    var name = marker.iconName || (def && def.name) || '标记';
    var selected = GM.isSelected('marker', marker.id) ? ' selected' : '';
    var s = unit ? ICON_GLYPH.unit : ICON_GLYPH.regular;
    var rot = GM.normAngle(marker.rot, 0);
    var glyph = iconGlyphSvg(marker.iconType, color, s, unit, rot);
    var tag = labelVisible(marker, 'icon')
      ? markerTagSvg(fitTextWidth(truncate(name, 10), unit ? 2.3 : 11, unit ? 54 : 168),
        '', s, unit, marker,
        { avoid: true, color: color, subColor: color, compactGap: true, leaderFrom: { x: 0, y: s } })
      : '';
    var ring = '<circle class="m-select-ring" r="' + (s + (unit ? 0.8 : 6)).toFixed(2) + '"></circle>';
    var hit = '<circle class="m-hit" r="' + (s + (unit ? 0.4 : 5)).toFixed(2) + '" fill="transparent" pointer-events="all"></circle>';

    return '<g class="marker marker-icon' + selected + '" data-marker-id="' + U.esc(marker.id) + '"' +
      ' transform="translate(' + marker.x + ' ' + marker.y + ')">' +
      ring + glyph + hit + tag +
      '</g>';
  }

  /* 四个级别统一为半填充圆：联盟 / 团队 / 小队内圈填敌我色（alpha 0.4），
     个人级内圈填职业色；外圈统一实线 + 固定线宽，只换状态色 */
  function markerSvg(marker) {
    var team = GM.findTeam(marker.teamId);
    var ref = marker.ref || null;
    if (!team && marker.iconType) return iconMarkerSvg(marker);
    if (!team && ref && ref.type === 'person') return personMarkerSvg(marker, ref);

    var md = GM.currentMap();
    var unit = isUnitMap(md);
    var kind = team ? team.kind : (ref ? ref.kind : 'squad');
    var relation = markerRelation(marker);
    var status = U.statusById(marker.status);
    var name = team ? team.name : (ref ? ref.name : '（队伍已删除）');
    var count = GM.markerCount(marker);
    var fill = GM.markerFill(marker);
    var selected = GM.isSelected('marker', marker.id) ? ' selected' : '';
    var opacity = marker.status === 'dead' ? 0.5 : (marker.status === 'attrition' ? 0.86 : 1);
    var warn = markerInEnemyBarrier(marker, md, GM.state.project) ? ' in-enemy-barrier' : '';
    var rot = GM.normAngle(marker.rot, 0);
    var tagVisible = labelVisible(marker, kind);
    var b = markerCircleBody(kind, fill, status, count, rot, unit);
    var sub = markerSubText(relation.name, count, status.name);
    var nameCap = unit ? (kind === 'alliance' ? 66 : 58) : (kind === 'alliance' ? 196 : 172);
    var tag = tagVisible
      ? markerTagSvg(fitTextWidth(truncate(name, kind === 'alliance' ? 14 : 11), unit ? 2.3 : 11, nameCap),
        sub, b.iconBottom, unit, marker,
        { avoid: true, color: relation.color, subColor: relation.color, leaderFrom: b.leaderFrom })
      : '';

    return '<g class="marker kind-' + kind + selected + warn + '" data-marker-id="' + U.esc(marker.id) + '" transform="translate(' + marker.x + ' ' + marker.y + ')" opacity="' + opacity + '">' +
      b.ring + b.shape + b.arrow + b.anchor + b.countText + b.hit +
      tag +
      '</g>';
  }


  /* ============================ 绘图对象渲染 ============================ */

  function lineDefById(type) {
    var def = null;
    (window.GM_DATA.lineTools || []).forEach(function (d) { if (d.id === type) def = d; });
    return def;
  }

  function shapeColor(s) {
    if (s.color) return s.color;
    if (s.kind === 'route') return '#d8b26a';
    if (s.kind === 'line') {
      var ld = lineDefById(s.lineType);
      return (ld && ld.color) || '#e0645c';
    }
    if (s.kind === 'rally') return '#c9a55a';
    if (s.kind === 'note') return '#d9d3c4';
    if (s.kind === 'skill') return '#79b6a0';
    return '#b05a55';
  }

  /* 画线组末端图元：箭头随最后一段朝向旋转，盾 / 禁止符保持正立 */
  function lineHeadSvg(type, x, y, angle, color) {
    var c = U.esc(color);
    if (type === 'shield') {
      return '<g transform="translate(' + x + ' ' + y + ')">' +
        '<path d="M0 -9 L7 -6 L7 1 Q0 9.5 -7 1 L-7 -6 Z" fill="' + c + '" fill-opacity="0.25" stroke="' + c + '" stroke-width="1.8"></path></g>';
    }
    if (type === 'forbid') {
      return '<g transform="translate(' + x + ' ' + y + ')">' +
        '<circle r="8" fill="none" stroke="' + c + '" stroke-width="2"></circle>' +
        '<line x1="-5.6" y1="-5.6" x2="5.6" y2="5.6" stroke="' + c + '" stroke-width="2"></line></g>';
    }
    return '<polygon points="0,-7 13,0 0,7" fill="' + c + '" transform="translate(' + x + ' ' + y + ') rotate(' + angle + ')" pointer-events="none"></polygon>';
  }

  function lineSvg(s) {
    if (!s.points || s.points.length < 2) return '';
    var pts = s.points.map(function (p) { return p.x + ',' + p.y; }).join(' ');
    var def = lineDefById(s.lineType);
    var color = shapeColor(s);
    var selected = GM.isSelected('shape', s.id);
    var width = (s.width || 3) + (selected ? 1 : 0);
    var stroke = selected ? '#e6ca8a' : color;
    var dash = s.dashed ? ' stroke-dasharray="8 5"' : '';
    var last = s.points[s.points.length - 1];
    var prev = s.points[s.points.length - 2];
    var angle = Math.atan2(last.y - prev.y, last.x - prev.x) * 180 / Math.PI;
    var head = lineHeadSvg(def ? def.head : 'arrow', last.x, last.y, angle, stroke);

    return '<g class="shape line' + (selected ? ' selected' : '') + '" data-shape="' + U.esc(s.id) + '">' +
      '<polyline class="line-stroke" points="' + pts + '" fill="none" stroke="' + U.esc(stroke) +
      '" stroke-width="' + width + '" stroke-linejoin="round" stroke-linecap="round"' + dash + ' opacity="0.95"></polyline>' +
      head +
      (s.text ? '<text class="rally-label" x="' + last.x + '" y="' + (last.y + 20) + '" fill="' + U.esc(color) + '">' + U.esc(s.text) + '</text>' : '') +
      '</g>';
  }

  function routeSvg(s) {
    if (!s.points || s.points.length < 2) return '';
    var pts = s.points.map(function (p) { return p.x + ',' + p.y; }).join(' ');
    var color = shapeColor(s);
    var selected = GM.isSelected('shape', s.id);
    var width = (s.width || 3) + (selected ? 1 : 0);
    var stroke = selected ? '#e6ca8a' : color;
    var last = s.points[s.points.length - 1];
    var prev = s.points[s.points.length - 2];
    var angle = Math.atan2(last.y - prev.y, last.x - prev.x) * 180 / Math.PI;
    var arrow = '<polygon points="0,-7 13,0 0,7" fill="' + U.esc(stroke) + '" transform="translate(' + last.x + ' ' + last.y + ') rotate(' + angle.toFixed(1) + ')"></polygon>';

    return '<g class="shape route' + (selected ? ' selected' : '') + '" data-shape="' + U.esc(s.id) + '">' +
      '<polyline class="route-line" points="' + pts + '" fill="none" stroke="' + U.esc(stroke) + '" stroke-width="' + width + '" stroke-linejoin="round" stroke-linecap="round" opacity="0.95"></polyline>' +
      arrow +
      (s.text ? '<text class="rally-label" x="' + last.x + '" y="' + (last.y + 20) + '" fill="' + U.esc(color) + '">' + U.esc(s.text) + '</text>' : '') +
      '</g>';
  }

  function zoneSvg(s) {
    var color = shapeColor(s);
    var selected = GM.isSelected('shape', s.id);
    var stroke = selected ? '#e6ca8a' : color;
    var width = (s.width || 2) + (selected ? 1 : 0);
    var body = '';

    if (s.kind === 'zoneRect') {
      body = '<rect class="zone-fill" x="' + Math.min(s.x, s.x + s.w) + '" y="' + Math.min(s.y, s.y + s.h) + '" width="' + Math.abs(s.w) + '" height="' + Math.abs(s.h) + '" rx="2" fill="' + U.esc(color) + '" fill-opacity="0.1" stroke="' + U.esc(stroke) + '" stroke-width="' + width + '" stroke-dasharray="7 4"></rect>';
    } else {
      body = '<circle class="zone-fill" cx="' + s.x + '" cy="' + s.y + '" r="' + Math.max(6, s.r) + '" fill="' + U.esc(color) + '" fill-opacity="0.1" stroke="' + U.esc(stroke) + '" stroke-width="' + width + '" stroke-dasharray="7 4"></circle>';
    }

    var label = s.text ? '<text class="rally-label" x="' + (s.kind === 'zoneRect' ? s.x + s.w / 2 : s.x) + '" y="' + (s.kind === 'zoneRect' ? s.y + s.h / 2 + 4 : s.y - s.r - 10) + '" fill="' + U.esc(color) + '">' + U.esc(s.text) + '</text>' : '';
    return '<g class="shape zone' + (selected ? ' selected' : '') + '" data-shape="' + U.esc(s.id) + '">' + body + label + '</g>';
  }

  function rallySvg(s) {
    var color = shapeColor(s);
    var selected = GM.isSelected('shape', s.id);
    var stroke = selected ? '#e6ca8a' : color;
    return '<g class="shape rally' + (selected ? ' selected' : '') + '" data-shape="' + U.esc(s.id) + '" transform="translate(' + s.x + ' ' + s.y + ')">' +
      '<circle r="10" fill="' + U.esc(color) + '" fill-opacity="0.18" stroke="' + U.esc(stroke) + '" stroke-width="2"' + (selected ? '' : ' stroke-dasharray="3 3"') + '></circle>' +
      '<path d="M0,-14 L0,10 M0,-14 L9,-10 L0,-6" fill="none" stroke="' + U.esc(stroke) + '" stroke-width="2" stroke-linejoin="round"></path>' +
      '<text class="rally-label" y="26" fill="' + U.esc(color) + '">' + U.esc(s.text || '集结点') + '</text>' +
      '</g>';
  }

  function noteSvg(s) {
    var color = shapeColor(s);
    var selected = GM.isSelected('shape', s.id);
    var lines = String(s.text || '').split('\n');
    var tspans = lines.map(function (line, i) {
      return '<tspan x="' + s.x + '" dy="' + (i === 0 ? 0 : 20) + '">' + U.esc(line) + '</tspan>';
    }).join('');

    return '<g class="shape note' + (selected ? ' selected' : '') + '" data-shape="' + U.esc(s.id) + '">' +
      (selected ? '<rect x="' + (s.x - 6) + '" y="' + (s.y - 18) + '" width="' + Math.max(40, String(s.text || '').length * 15) + '" height="' + (lines.length * 20 + 8) + '" fill="none" stroke="#e6ca8a" stroke-width="1" stroke-dasharray="3 3" opacity="0.6"></rect>' : '') +
      '<text class="note-text" x="' + s.x + '" y="' + s.y + '" fill="' + U.esc(color) + '">' + tspans + '</text>' +
      '</g>';
  }

  function skillSvg(s) {
    var color = shapeColor(s);
    var selected = GM.isSelected('shape', s.id);
    var stroke = selected ? '#e6ca8a' : color;
    var width = (s.width || 2) + (selected ? 1 : 0);
    var r = Math.max(1, s.r || 0);
    var dash = s.dashed === false ? '' : ' stroke-dasharray="8 4"';
    var extent = r;
    var body;

    if (s.shapeType === 'sector') {
      var span = Math.max(1, Math.min(360, s.span || 90));
      var a0 = ((s.angle || 0) - span / 2) * Math.PI / 180;
      var a1 = ((s.angle || 0) + span / 2) * Math.PI / 180;
      var x0 = s.x + r * Math.cos(a0);
      var y0 = s.y + r * Math.sin(a0);
      var x1 = s.x + r * Math.cos(a1);
      var y1 = s.y + r * Math.sin(a1);
      var large = span > 180 ? 1 : 0;
      body = '<path class="zone-fill skill-sector" d="M' + s.x + ',' + s.y +
        ' L' + x0.toFixed(2) + ',' + y0.toFixed(2) +
        ' A' + r + ',' + r + ' 0 ' + large + ' 1 ' + x1.toFixed(2) + ',' + y1.toFixed(2) + ' Z"' +
        ' fill="' + U.esc(color) + '" fill-opacity="0.12" stroke="' + U.esc(stroke) +
        '" stroke-width="' + width + '"' + dash + ' stroke-linejoin="round"></path>' +
        '<line x1="' + s.x + '" y1="' + s.y + '" x2="' + x1.toFixed(2) + '" y2="' + y1.toFixed(2) +
        '" stroke="' + U.esc(color) + '" stroke-width="' + width + '" stroke-dasharray="3 3" opacity="0.55"></line>';
    } else if (s.shapeType === 'rect') {
      /* 矩形范围：x / y 为中心点，len 沿 angle 方向、wid 为垂直线宽（1 米 = 1 unit） */
      var len = Math.max(1, s.len || 20);
      var wid = Math.max(0.2, s.wid || 3);
      extent = Math.max(len, wid) / 2;
      body = '<g class="zone-fill skill-rect" transform="translate(' + s.x + ' ' + s.y + ') rotate(' + (s.angle || 0) + ')">' +
        '<rect x="' + (-len / 2) + '" y="' + (-wid / 2) + '" width="' + len + '" height="' + wid + '" rx="2"' +
        ' fill="' + U.esc(color) + '" fill-opacity="0.12" stroke="' + U.esc(stroke) +
        '" stroke-width="' + width + '"' + dash + '></rect></g>' +
        '<circle cx="' + s.x + '" cy="' + s.y + '" r="3" fill="' + U.esc(color) + '" opacity="0.8"></circle>';
    } else {
      body = '<circle class="zone-fill skill-circle" cx="' + s.x + '" cy="' + s.y + '" r="' + r +
        '" fill="' + U.esc(color) + '" fill-opacity="0.12" stroke="' + U.esc(stroke) +
        '" stroke-width="' + width + '"' + dash + '></circle>' +
        '<circle cx="' + s.x + '" cy="' + s.y + '" r="3" fill="' + U.esc(color) + '" opacity="0.8"></circle>';
    }

    var label = s.text
      ? '<text class="rally-label" x="' + s.x + '" y="' + (s.y - extent - 10) + '" fill="' + U.esc(color) + '">' + U.esc(s.text) + '</text>'
      : '';
    return '<g class="shape skill' + (selected ? ' selected' : '') + '" data-shape="' + U.esc(s.id) + '">' + body + label + '</g>';
  }

  function renderShapes(project, level, layered) {
    var phase = GM.activePhase();
    var out = { zones: '', routes: '', notes: '' };
    if (!phase) return out;

    phase.shapes.forEach(function (s) {
      if (layered && s.mapLayer !== level) return;
      if (s.layer === 'zones' && (s.kind === 'zoneRect' || s.kind === 'zoneCircle')) out.zones += zoneSvg(s);
      else if (s.layer === 'zones' && s.kind === 'skill') out.zones += skillSvg(s);
      else if (s.layer === 'routes' && s.kind === 'route') out.routes += routeSvg(s);
      else if (s.layer === 'routes' && s.kind === 'line') out.routes += lineSvg(s);
      else if (s.layer === 'notes' && s.kind === 'rally') out.notes += rallySvg(s);
      else if (s.layer === 'notes' && s.kind === 'note') out.notes += noteSvg(s);
    });
    return out;
  }

  /* ============================ 阶段差异 ============================ */

  function diffData() {
    var plan = GM.activePlan();
    var idx = GM.phaseIndex();
    if (!plan || idx <= 0) return null;
    var prev = plan.phases[idx - 1];
    var cur = plan.phases[idx];
    if (!prev || !cur) return null;

    var md = GM.currentMap();
    var layered = md.layers && md.layers.length > 1;
    var level = GM.state.project.mapLevel;
    var prevMap = {};
    var curMap = {};
    prev.markers.forEach(function (m) {
      if (!layered || m.mapLayer === level) prevMap[m.id] = m;
    });
    cur.markers.forEach(function (m) {
      if (!layered || m.mapLayer === level) curMap[m.id] = m;
    });

    var moved = [];
    var added = [];
    var removed = [];

    Object.keys(curMap).forEach(function (id) {
      var c = curMap[id];
      var p = prevMap[id];
      if (!p) { added.push(c); return; }
      var dist = Math.sqrt(Math.pow(c.x - p.x, 2) + Math.pow(c.y - p.y, 2));
      if (dist > 3) moved.push({ from: p, to: c, dist: dist });
    });
    Object.keys(prevMap).forEach(function (id) {
      if (!curMap[id]) removed.push(prevMap[id]);
    });

    return { plan: plan, prev: prev, cur: cur, moved: moved, added: added, removed: removed };
  }

  function renderDiffSvg() {
    if (!GM.state.ui.diff) return '';
    var data = diffData();
    if (!data) return '';

    var out = '<g class="overlay-diff">';
    out += '<text class="diff-caption" x="800" y="36">阶段对比：' + U.esc(data.prev.name) + ' → ' + U.esc(data.cur.name) +
      ' · 位移 ' + data.moved.length + ' · 新增 ' + data.added.length + ' · 消失 ' + data.removed.length + '</text>';

    data.moved.forEach(function (item) {
      out += '<line x1="' + item.from.x + '" y1="' + item.from.y + '" x2="' + item.to.x + '" y2="' + item.to.y + '" stroke="#79b6a0" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#diffHead)" opacity="0.9"></line>';
      out += '<circle cx="' + item.from.x + '" cy="' + item.from.y + '" r="3" fill="#79b6a0" opacity="0.6"></circle>';
      out += '<text x="' + ((item.from.x + item.to.x) / 2) + '" y="' + ((item.from.y + item.to.y) / 2 - 6) + '" fill="#79b6a0" font-size="10" text-anchor="middle" opacity="0.85">' + Math.round(item.dist) + '</text>';
    });

    data.added.forEach(function (m) {
      out += '<circle cx="' + m.x + '" cy="' + m.y + '" r="22" fill="none" stroke="#79b6a0" stroke-width="1.5" stroke-dasharray="4 3"></circle>';
    });

    data.removed.forEach(function (m) {
      out += '<g transform="translate(' + m.x + ' ' + m.y + ')" opacity="0.85">' +
        '<circle r="18" fill="none" stroke="#c35a56" stroke-width="1.2" stroke-dasharray="4 3"></circle>' +
        '<path d="M-7,-7 L7,7 M7,-7 L-7,7" stroke="#c35a56" stroke-width="2"></path>' +
        '</g>';
    });

    out += '</g>';
    return out;
  }

  board.diffStats = function () {
    var data = diffData();
    if (!data) return null;
    return {
      moved: data.moved.length,
      added: data.added.length,
      removed: data.removed.length
    };
  };

  /* ============================ 主渲染 ============================ */

  function updateGridPattern() {
    var md = GM.currentMap();
    var size = (md && md.gridDisplay) || (GM.state.project && GM.state.project.grid.size) || 32;
    var pattern = q('#gridPattern');
    var line = q('#gridLine');
    if (pattern) {
      pattern.setAttribute('width', size);
      pattern.setAttribute('height', size);
    }
    if (line) line.setAttribute('d', 'M' + size + ' 0H0V' + size);
  }

  /* 只重绘标记层：拖拽时标记坐标每帧变化，标签避让与引线必须跟着重算 */
  function renderMarkers() {
    if (!board.layers.markers) return;
    var project = GM.state.project;
    if (!project) return;
    var md = GM.currentMap();
    var layered = md.layers && md.layers.length > 1;
    var level = layered ? (project.mapLevel || GM.defaultMapLevel(md)) : 'ground';
    var phase = GM.activePhase();
    var teamOn = project.layers.markers !== false;
    var personalOn = project.layers.personal !== false;
    var list = (phase ? phase.markers : []).filter(function (m) {
      if (layered && m.mapLayer !== level) return false;
      var isPerson = !!(m.ref && m.ref.type === 'person' && !GM.findTeam(m.teamId));
      return isPerson ? personalOn : teamOn;
    });
    beginLabelLayout();
    board.layers.markers.innerHTML = list.map(markerSvg).join('');
    endLabelLayout();
  }

  board.render = function () {
    var project = GM.state.project;
    if (!project || !board.layers.base) return;
    var md = GM.currentMap();
    var layered = md.layers && md.layers.length > 1;
    var level = layered ? (project.mapLevel || GM.defaultMapLevel(md)) : 'ground';

    updateGridPattern();

    board.layers.base.innerHTML = renderArt(md, project, level) + renderObjectives(md, project, level, layered);

    var shapes = renderShapes(project, level, layered);
    board.layers.zones.innerHTML = shapes.zones;
    board.layers.routes.innerHTML = shapes.routes;
    board.layers.notes.innerHTML = shapes.notes;

    renderMarkers();

    board.layers.overlayDiff.innerHTML = renderDiffSvg();

    applyVisibility(project);
    updateHud(md, layered, level);
    board.applyCursor();
  };

  function applyVisibility(project) {
    board.layers.base.style.display = project.layers.base ? '' : 'none';
    board.layers.zones.style.display = project.layers.zones ? '' : 'none';
    board.layers.routes.style.display = project.layers.routes ? '' : 'none';
    board.layers.markers.style.display = '';
    board.layers.notes.style.display = project.layers.notes ? '' : 'none';
  }

  function updateHud(md, layered, level) {
    var hudMap = q('#hudMap');
    if (hudMap) hudMap.textContent = md.name + ' · ' + md.modeLabel + (layered ? ' · 双层地图' : '');
    var hudWidth = q('#hudWidth');
    if (hudWidth) {
      if (isUnitMap(md)) hudWidth.classList.remove('hidden');
      else {
        hudWidth.classList.add('hidden');
        hudWidth.textContent = '';
      }
    }
    var hudScale = q('#hudScale');
    if (hudScale) hudScale.classList.toggle('hidden', !isUnitMap(md));
    var hudLevel = q('#hudLevel');
    if (hudLevel) {
      if (layered) {
        var lv = null;
        (md.layers || []).forEach(function (l) { if (l.id === level) lv = l; });
        hudLevel.classList.remove('hidden');
        hudLevel.textContent = lv ? lv.name : level;
      } else {
        hudLevel.classList.add('hidden');
      }
    }
  }

  board.applyCursor = function () {
    if (!board.svg) return;
    var ui = GM.state.ui;
    var hand = ui.tool === 'hand';
    board.svg.style.cursor = hand ? 'grab' : (ui.tool === 'select' ? 'default' : 'crosshair');
  };

  board.worldPoint = function (clientX, clientY) {
    return viewToWorld(screenToView(clientX, clientY));
  };

  board.fitView = function () {
    GM.state.view = { x: 0, y: 0, k: 1 };
    applyTransform();
  };

  function centerOnBoard(md, k) {
    var mk = mapMetrics(md);
    var cx = mk.ox + (md.board.width * mk.S) / 2;
    var cy = mk.oy + (md.board.height * mk.S) / 2;
    return { x: 800 - cx * k, y: 500 - cy * k, k: k };
  }

  /* 战术缩放：默认让 1 unit ≈ 6 屏幕像素（单人标记直径 6px 可点中）。
     四方战整图 328×438 unit，全图铺满时 1 unit 只有约 2px，必然做不到 6px，
     因此 unit 地图默认用战术缩放，整图概览请用滚轮缩小。 */
  board.tacticalView = function () {
    var md = GM.currentMap();
    if (!isUnitMap(md) || !md.board) {
      board.fitView();
      return;
    }
    var mk = mapMetrics(md);
    var k = U.clamp(6 / (mk.S * screenScale()), MIN_K, MAX_K);
    GM.state.view = centerOnBoard(md, k);
    applyTransform();
  };

  board.defaultView = function () {
    if (isUnitMap(GM.currentMap())) board.tacticalView();
    else board.fitView();
  };

  board.zoomBy = function (factor) {
    var v = GM.state.view;
    var anchor = { x: 800, y: 500 };
    var nextK = U.clamp(v.k * factor, MIN_K, MAX_K);
    if (Math.abs(nextK - v.k) < 0.0001) return;
    var world = { x: (anchor.x - v.x) / v.k, y: (anchor.y - v.y) / v.k };
    v.x = anchor.x - world.x * nextK;
    v.y = anchor.y - world.y * nextK;
    v.k = nextK;
    applyTransform();
  };

  board.previewGroup = function () {
    return q('#overlayDraw');
  };

  board.refreshMarkerElement = function (marker) {
    var el = board.svg && board.svg.querySelector('[data-marker-id="' + marker.id + '"]');
    if (el) el.setAttribute('transform', 'translate(' + marker.x + ' ' + marker.y + ')');
  };

  /* 拖拽时按动画帧节流重排标记层：只重算一次标签避让 / 引线，避免每个 pointermove 都全量重排 */
  var markerRelayoutRaf = 0;
  function scheduleMarkerRelayout() {
    if (markerRelayoutRaf) return;
    markerRelayoutRaf = window.requestAnimationFrame(function () {
      markerRelayoutRaf = 0;
      renderMarkers();
      if (board.drag) {
        var el = board.svg && board.svg.querySelector('[data-marker-id="' + board.drag.marker.id + '"]');
        if (el) el.classList.add('dragging');
      }
    });
  }

  /* ============================ 交互 ============================ */

  function bindEvents() {
    var svg = board.svg;

    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = screenToView(e.clientX, e.clientY);
      var v = GM.state.view;
      var factor = Math.exp(-e.deltaY * 0.0016);
      var nextK = U.clamp(v.k * factor, MIN_K, MAX_K);
      if (Math.abs(nextK - v.k) < 0.0001) return;
      var world = { x: (p.x - v.x) / v.k, y: (p.y - v.y) / v.k };
      v.x = p.x - world.x * nextK;
      v.y = p.y - world.y * nextK;
      v.k = nextK;
      applyTransform();
    }, { passive: false });

    svg.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 && e.button !== 1) return;

      var tool = GM.state.ui.tool;
      var handMode = tool === 'hand' || e.button === 1;

      if (handMode) {
        startPan(e);
        return;
      }

      if (tool !== 'select' && GM.draw && GM.draw.isDrawTool(tool)) {
        GM.draw.onPointerDown(eventWorld(e), e);
        return;
      }

      if (tool === 'teamPlace') {
        placeTeamAt(e);
        return;
      }

      var markerEl = e.target.closest ? e.target.closest('.marker') : null;
      if (tool === 'select' && markerEl) {
        var markerId = markerEl.getAttribute('data-marker-id');
        var phase = GM.activePhase();
        var marker = null;
        if (phase) {
          for (var i = 0; i < phase.markers.length; i++) {
            if (phase.markers[i].id === markerId) { marker = phase.markers[i]; break; }
          }
        }
        if (!marker) return;
        GM.select('marker', marker.id);
        startMarkerDrag(marker, e);
        return;
      }

      var shapeEl = e.target.closest ? e.target.closest('[data-shape]') : null;
      if (tool === 'select' && shapeEl) {
        var shapeId = shapeEl.getAttribute('data-shape');
        GM.select('shape', shapeId);
        var shape = findShape(shapeId);
        /* 技能范围与画线组图元选中后可拖动；其它绘图对象保持原行为（只选中） */
        if (shape && (shape.kind === 'skill' || shape.kind === 'line')) startSkillDrag(shape, e);
        return;
      }

      var capEl = e.target.closest ? e.target.closest('[data-capture]') : null;
      if (tool === 'select' && capEl) {
        startCaptureDrag(capEl.getAttribute('data-capture'), e);
        return;
      }

      var objEl = e.target.closest ? e.target.closest('[data-obj]') : null;
      if (tool === 'select' && objEl) {
        handleObjective(objEl.getAttribute('data-obj'));
        if (GM.engine && GM.engine.renderResult) GM.engine.renderResult();
        return;
      }

      startPan(e);
    });

    svg.addEventListener('pointermove', function (e) {
      var world = eventWorld(e);
      var coord = q('#hudCoord');
      if (coord) coord.textContent = 'x ' + Math.round(world.x) + ' · y ' + Math.round(world.y);
      if (!board.drag && !board.pan) updateWidthChip(GM.currentMap(), world);
      if (GM.draw && GM.draw.isDrawTool(GM.state.ui.tool) && !board.drag && !board.pan) {
        GM.draw.onPointerMove(world, e);
      }
    });

    svg.addEventListener('pointerup', function (e) {
      if (GM.draw && GM.draw.isDrawTool(GM.state.ui.tool)) {
        GM.draw.onPointerUp(eventWorld(e), e);
      }
    });

    svg.addEventListener('pointerleave', function (e) {
      if (board.drag || board.pan) return;
      if (GM.draw && GM.draw.isDrawTool(GM.state.ui.tool)) GM.draw.onPointerLeave();
    });

    svg.addEventListener('dblclick', function (e) {
      if (GM.draw) GM.draw.onDoubleClick(eventWorld(e), e);
    });

    /* 从主界面预设阵列 / 单个色块拖入沙盘（也可接收旧的队伍节点拖放） */
    svg.addEventListener('dragover', function (e) {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch (err) { /* noop */ }
    });

    svg.addEventListener('drop', function (e) {
      var raw = '';
      try {
        raw = e.dataTransfer.getData('application/x-gm-node') ||
          e.dataTransfer.getData('application/x-gm-person') ||
          e.dataTransfer.getData('text/plain');
      } catch (err) { raw = ''; }
      if (!raw) return;

      var drag = null;
      try { drag = JSON.parse(raw); } catch (err) { drag = null; }
      if (!drag || !drag.type) return;
      if (drag.type === 'slot') return; // 配置窗口内部排序，不落沙盘

      e.preventDefault();
      var world = eventWorld(e);
      var md = GM.currentMap();
      var mk = mapMetrics(md);
      var pos = snapPoint(world);
      pos.x = U.clamp(pos.x, 0.5, mk.width - 0.5);
      pos.y = U.clamp(pos.y, 0.5, mk.height - 0.5);
      var toastFn = (GM.ui && GM.ui.toast) ? GM.ui.toast : function () {};

      /* 墙体只是美术层：任何位置（含墙内、地图外沿以内）都可以落标记，不做拒放/吸附 */
      function afterDrop(marker) {
        if (marker && markerInEnemyBarrier(marker, md, GM.state.project)) {
          toastFn('敌方标记进入保护结界：非本方成员进入受增减伤', 'error');
        }
      }

      if (drag.type === 'person') {
        /* 实时编成（live）没有预设 id，用伪预设包装当前团队节点 */
        var preset2 = null;
        if (drag.liveId) {
          var liveNode = GM.findTeam(drag.liveId);
          if (liveNode) preset2 = { id: 'live', name: liveNode.name, kind: liveNode.kind, node: liveNode };
        }
        if (!preset2) return;
        var member = findPresetMember(preset2.node, drag.memberId);
        if (!member) return;
        var mm = GM.addPersonMarker(preset2, member, pos.x, pos.y);
        if (!mm) return;
        GM.select('marker', mm.id);
        GM.commit('引用单个队员');
        afterDrop(mm);
        if (GM.ui && GM.ui.toast) {
          GM.ui.toast('已引用队员「' + (member.name || '队员') + '」', 'success');
        }
        return;
      }

      if (drag.type === 'squad') {
        var squad = GM.findTeam(drag.squadId);
        var count = squad ? GM.teamCount(squad) : Number(drag.count || 0);
        if (!count) {
          toastFn('该小队暂无成员，无法拖到沙盘', 'error');
          return;
        }
        var squadMarker = GM.addSquadMarker(drag, pos.x, pos.y);
        if (!squadMarker) return;
        GM.select('marker', squadMarker.id);
        GM.commit('引用整个小队');
        afterDrop(squadMarker);
        if (GM.ui && GM.ui.toast) {
          GM.ui.toast('已引用小队「' + (squadMarker.ref.name || '小队') + '」（' + count + ' 人）', 'success');
        }
        return;
      }

      var teamId = drag.id || (drag.type === 'team' ? drag.teamId : '');
      if (!teamId) return;
      var team = GM.findTeam(teamId);
      if (!team) return;
      var marker = GM.addMarker(team.id, pos.x, pos.y);
      if (!marker) return;
      GM.select('marker', marker.id);
      GM.commit('放置队伍标记');
      afterDrop(marker);
      if (GM.ui && GM.ui.toast) GM.ui.toast('已将「' + team.name + '」放置到沙盘', 'success');
    });
  }

  function startPan(e) {
    if (board.drag) return;
    var v = GM.state.view;
    var start = screenToView(e.clientX, e.clientY);
    board.pan = {
      startView: { x: v.x, y: v.y },
      startPoint: start,
      moved: false,
      tool: GM.state.ui.tool
    };
    board.svg.style.cursor = 'grabbing';

    window.addEventListener('pointermove', onPanMove);
    window.addEventListener('pointerup', onPanUp, { once: true });
  }

  function onPanMove(e) {
    if (!board.pan) return;
    var p = screenToView(e.clientX, e.clientY);
    var dx = p.x - board.pan.startPoint.x;
    var dy = p.y - board.pan.startPoint.y;
    if (!board.pan.moved && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) board.pan.moved = true;
    GM.state.view.x = board.pan.startView.x + dx;
    GM.state.view.y = board.pan.startView.y + dy;
    applyTransform();
  }

  function onPanUp() {
    window.removeEventListener('pointermove', onPanMove);
    if (!board.pan) return;
    var wasMoved = board.pan.moved;
    var tool = board.pan.tool;
    board.pan = null;
    board.applyCursor();
    if (!wasMoved && tool === 'select') GM.clearSelection();
  }

  /* 工具栏「团队」落点：级别 / 颜色来自工具栏二级选项（GM.state.ui.teamTool） */
  function placeTeamAt(e) {
    var tt = GM.state.ui.teamTool || { kind: 'squad', relation: 'enemy-red' };
    var world = eventWorld(e);
    var pos = snapPoint(world);
    var marker = GM.placeTeamMarker(tt.kind, tt.relation, pos.x, pos.y, tt.count);
    if (!marker) return;
    GM.select('marker', marker.id);
    GM.commit('放置团队标记');
    if (GM.ui && GM.ui.toast) {
      var kindLabel = U.teamKindInit(tt.kind).label;
      var rel = GM.relationById(marker.relation);
      GM.ui.toast('已放置' + kindLabel + '标记（' + rel.name + '）', 'success');
    }
  }

  function findShape(id) {
    var phase = GM.activePhase();
    if (!phase) return null;
    for (var i = 0; i < phase.shapes.length; i++) {
      if (phase.shapes[i].id === id) return phase.shapes[i];
    }
    return null;
  }

  /* 只重绘绘图层（技能范围拖动时逐帧调用，避免整盘重排） */
  function renderShapeLayers() {
    var project = GM.state.project;
    if (!project) return;
    var md = GM.currentMap();
    var layered = md.layers && md.layers.length > 1;
    var level = layered ? (project.mapLevel || GM.defaultMapLevel(md)) : 'ground';
    var shapes = renderShapes(project, level, layered);
    if (board.layers.zones) board.layers.zones.innerHTML = shapes.zones;
    if (board.layers.routes) board.layers.routes.innerHTML = shapes.routes;
    if (board.layers.notes) board.layers.notes.innerHTML = shapes.notes;
  }

  function startSkillDrag(shape, e) {
    var world = eventWorld(e);
    board.shapeDrag = {
      shape: shape,
      offset: { x: world.x - shape.x, y: world.y - shape.y },
      moved: false
    };
    window.addEventListener('pointermove', onSkillDragMove);
    window.addEventListener('pointerup', onSkillDragUp, { once: true });
  }

  function onSkillDragMove(e) {
    var d = board.shapeDrag;
    if (!d) return;
    var mk = mapMetrics(GM.currentMap());
    var world = eventWorld(e);
    var pos = {
      x: U.clamp(world.x - d.offset.x, 0, mk.width),
      y: U.clamp(world.y - d.offset.y, 0, mk.height)
    };
    if (Math.abs(pos.x - d.shape.x) > 0.05 || Math.abs(pos.y - d.shape.y) > 0.05) d.moved = true;
    var dx = pos.x - d.shape.x;
    var dy = pos.y - d.shape.y;
    d.shape.x = pos.x;
    d.shape.y = pos.y;
    /* 画线图元的路径点跟着中心平移 */
    if (d.shape.kind === 'line' && d.shape.points) {
      d.shape.points.forEach(function (p) { p.x += dx; p.y += dy; });
    }
    renderShapeLayers();
    var coord = q('#hudCoord');
    if (coord) coord.textContent = 'x ' + Math.round(pos.x) + ' · y ' + Math.round(pos.y);
  }

  function onSkillDragUp() {
    window.removeEventListener('pointermove', onSkillDragMove);
    var d = board.shapeDrag;
    board.shapeDrag = null;
    if (d && d.moved) GM.commit(d.shape.kind === 'line' ? '移动画线' : '移动技能范围');
  }

  function startMarkerDrag(marker, e) {
    var world = eventWorld(e);
    board.drag = {
      marker: marker,
      offset: { x: world.x - marker.x, y: world.y - marker.y },
      moved: false,
      blocked: false,
      startX: marker.x,
      startY: marker.y
    };
    var el = e.target.closest ? e.target.closest('.marker') : null;
    if (el) el.classList.add('dragging');

    window.addEventListener('pointermove', onMarkerDragMove);
    window.addEventListener('pointerup', onMarkerDragUp, { once: true });
  }

  function onMarkerDragMove(e) {
    if (!board.drag) return;
    var md = GM.currentMap();
    var mk = mapMetrics(md);
    var world = eventWorld(e);
    var raw = { x: world.x - board.drag.offset.x, y: world.y - board.drag.offset.y };
    var pos = snapPoint(raw);
    pos.x = U.clamp(pos.x, 0.5, mk.width - 0.5);
    pos.y = U.clamp(pos.y, 0.5, mk.height - 0.5);

    /* 墙体不拦放置：标记中心可以落在任意位置（含墙内），这里不再做拦截 */
    if (!board.drag.moved && (Math.abs(pos.x - board.drag.startX) > 1 || Math.abs(pos.y - board.drag.startY) > 1)) {
      board.drag.moved = true;
    }
    board.drag.marker.x = pos.x;
    board.drag.marker.y = pos.y;
    board.refreshMarkerElement(board.drag.marker);
    scheduleMarkerRelayout();
    var coord = q('#hudCoord');
    if (coord) coord.textContent = 'x ' + Math.round(pos.x) + ' · y ' + Math.round(pos.y);
    var widthChip = q('#hudWidth');
    if (widthChip && isUnitMap(md)) widthChip.textContent = '此处约 ' + Math.round(board.corridorWidth(pos.x, pos.y)) + ' 人并排';
  }

  function onMarkerDragUp() {
    window.removeEventListener('pointermove', onMarkerDragMove);
    if (!board.drag) return;
    var drag = board.drag;
    var moved = drag.moved;
    var marker = drag.marker;
    board.drag = null;

    var md = GM.currentMap();
    var toast = (GM.ui && GM.ui.toast) ? GM.ui.toast : function () {};

    /* 墙体不再拦放置，也不再提示「部分压在墙体上」；只保留敌方结界的纯视觉提示 */
    if (markerInEnemyBarrier(marker, md, GM.state.project)) {
      toast('敌方标记进入保护结界：非本方成员进入受增减伤', 'error');
    }

    if (moved) GM.commit('移动标记');
  }

  /* 星墓高原中央占领圈：拖动改圆心。移动时用 transform 跟手，松手才写回方案并重算一次人数。
     该对象不可删除：没有删除按钮，Delete / 右键都不会走到这里。 */
  function startCaptureDrag(id, e) {
    var md = GM.currentMap();
    var plan = GM.activePlan();
    if (!md || !plan || md.id !== 'star-tomb') return;
    GM.ensurePlanMeta(plan);
    GM.select('objective', id);   // 触发重绘，需要重新取节点
    var el = board.layers.base ? board.layers.base.querySelector('[data-capture="' + id + '"]') : null;
    if (!el) return;
    board.captureDrag = {
      id: id,
      el: el,
      md: md,
      plan: plan,
      start: GM.captureCirclePoint(md, plan),
      from: eventWorld(e),
      current: null,
      moved: false
    };
    el.classList.add('dragging');
    window.addEventListener('pointermove', onCaptureDragMove);
    window.addEventListener('pointerup', onCaptureDragUp, { once: true });
  }

  function onCaptureDragMove(e) {
    var d = board.captureDrag;
    if (!d) return;
    var mk = mapMetrics(d.md);
    var world = eventWorld(e);
    var x = U.clamp(d.start.x + (world.x - d.from.x), 0, mk.width);
    var y = U.clamp(d.start.y + (world.y - d.from.y), 0, mk.height);
    d.current = { x: x, y: y };
    if (Math.abs(x - d.start.x) > 0.05 || Math.abs(y - d.start.y) > 0.05) d.moved = true;
    if (d.el) d.el.setAttribute('transform', 'translate(' + starR(x - d.start.x) + ' ' + starR(y - d.start.y) + ')');
    var coord = q('#hudCoord');
    if (coord) coord.textContent = 'x ' + Math.round(x) + ' · y ' + Math.round(y);
  }

  function onCaptureDragUp() {
    window.removeEventListener('pointermove', onCaptureDragMove);
    var d = board.captureDrag;
    board.captureDrag = null;
    if (!d) return;
    if (d.el) {
      d.el.classList.remove('dragging');
      d.el.removeAttribute('transform');
    }
    if (!d.moved || !d.current) { board.render(); return; }
    d.plan.escort.circle = { x: starR(d.current.x), y: starR(d.current.y) };
    GM.commit('移动占领圈');
    /* 拖动结束只重算一次圈内人数与归属 */
    if (GM.engine && GM.engine.syncEscortCircle) GM.engine.syncEscortCircle();
    board.render();
  }

  /* ============================ 初始化 ============================ */

  GM.board = board;

  board.init = function () {
    board.svg = q('#board');
    board.viewport = q('#viewport');
    if (!board.svg || !board.viewport) return;

    board.layers = {
      base: q('#layer-base'),
      zones: q('#layer-zones'),
      routes: q('#layer-routes'),
      markers: q('#layer-markers'),
      notes: q('#layer-notes'),
      overlayDiff: null
    };

    var overlay = q('#layer-overlay');
    if (overlay) {
      overlay.innerHTML = '<g id="overlayDiff"></g><g id="overlayDraw"></g>';
      board.layers.overlayDiff = q('#overlayDiff');
      board.layers.overlayDraw = q('#overlayDraw');
    }

    bindEvents();
    applyTransform();
    board.render();

    GM.bus.on('change', function () { board.render(); });
    GM.bus.on('selection', function () { board.render(); });
    GM.bus.on('map:changed', function () {
      board.defaultView();
      board.render();
    });

    /* 三栏宽度按比例缩放后：容器尺寸变了，重算 viewBox 铺满比例 / LOD / HUD 缩放标签。
       不改用户的缩放 k（只做实测换算），保持当前视角。 */
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (!board.svg) return;
        applyTransform();
        var md = GM.currentMap();
        var project = GM.state.project;
        var layered = !!(md.layers && md.layers.length > 1);
        var level = layered ? ((project && project.mapLevel) || GM.defaultMapLevel(md)) : 'ground';
        updateHud(md, layered, level);
      }, 120);
    });
  };
})();
