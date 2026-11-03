(function () {
  'use strict';

  window.GM = window.GM || {};
  var GM = window.GM;
  var U = GM.util;

  /* 原「画线」组：进攻 / 虚线进攻 / 防守 / 禁止，共用多点画线交互 */
  var LINE_TOOLS = ['attack', 'attackDash', 'defense', 'forbid'];
  var TOOLS = ['route', 'rallyFlag', 'zoneRect', 'zoneCircle', 'note', 'skill'].concat(LINE_TOOLS);
  /* 图标型标记：单击落点即完成（目前只剩集结旗号） */
  var ICON_TOOLS = ['rallyFlag'];

  var draft = null; // { tool, points, start, current, lineType }

  var COLORS = {
    route: '#d8b26a',
    zone: '#b05a55',
    note: '#d9d3c4',
    skill: '#79b6a0'
  };

  function iconDef(type) {
    var def = null;
    (window.GM_DATA.iconMarkers || []).forEach(function (d) { if (d.id === type) def = d; });
    return def;
  }

  function lineDef(type) {
    var def = null;
    (window.GM_DATA.lineTools || []).forEach(function (d) { if (d.id === type) def = d; });
    return def || (window.GM_DATA.lineTools || [])[0];
  }

  /* 线末端图元：箭头 / 盾 / 禁止符，坐标在末端点，angle 仅箭头旋转 */
  function lineHeadSvg(type, x, y, angle, color) {
    var c = U.esc(color);
    if (type === 'defense') {
      return '<g transform="translate(' + x + ' ' + y + ')">' +
        '<path d="M0 -9 L7 -6 L7 1 Q0 9.5 -7 1 L-7 -6 Z" fill="' + c + '" fill-opacity="0.25" stroke="' + c + '" stroke-width="1.8"></path></g>';
    }
    if (type === 'forbid') {
      return '<g transform="translate(' + x + ' ' + y + ')">' +
        '<circle r="8" fill="none" stroke="' + c + '" stroke-width="2"></circle>' +
        '<line x1="-5.6" y1="-5.6" x2="5.6" y2="5.6" stroke="' + c + '" stroke-width="2"></line></g>';
    }
    return '<polygon points="0,-7 13,0 0,7" fill="' + c + '" transform="translate(' + x + ' ' + y + ') rotate(' + angle + ')"></polygon>';
  }

  function currentLevel() {
    var md = GM.currentMap();
    if (!md || !md.layers || md.layers.length < 2) return 'ground';
    return GM.state.project.mapLevel || md.layers[0].id;
  }

  function startShape(kind, layer) {
    return {
      id: U.uid('shape'),
      kind: kind,
      layer: layer,
      mapLayer: currentLevel(),
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      r: 0,
      points: [],
      text: '',
      color: '',
      width: 3,
      shapeType: 'circle',
      angle: 0,
      span: 90,
      len: 20,
      wid: 3,
      dashed: true,
      preset: 'custom',
      lineType: ''
    };
  }

  function addShape(shape) {
    var phase = GM.activePhase();
    if (!phase) return null;
    phase.shapes.push(shape);
    return shape;
  }

  function resetDraft() {
    draft = null;
    var g = GM.board && GM.board.previewGroup && GM.board.previewGroup();
    if (g) g.innerHTML = '';
  }

  function drawPreview() {
    var g = GM.board && GM.board.previewGroup && GM.board.previewGroup();
    if (!g) return;
    if (!draft) { g.innerHTML = ''; return; }

    var html = '';
    if (draft.tool === 'route') {
      var pts = draft.points.map(function (p) { return p.x + ',' + p.y; });
      if (draft.current) pts.push(draft.current.x + ',' + draft.current.y);
      if (draft.points.length) {
        html += '<circle cx="' + draft.points[0].x + '" cy="' + draft.points[0].y + '" r="4" fill="#d8b26a" opacity="0.8"></circle>';
        html += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#e6ca8a" stroke-width="2" stroke-dasharray="6 5" opacity="0.9"></polyline>';
      }
      html += '<text x="' + ((draft.current ? draft.current.x : 0) + 14) + '" y="' + ((draft.current ? draft.current.y : 0) - 10) + '" fill="#e6ca8a" font-size="10" opacity="0.8">双击结束 · Esc 取消</text>';
    } else if (draft.tool === 'line') {
      var ldef = lineDef(draft.lineType);
      var lpts = draft.points.map(function (p) { return p.x + ',' + p.y; });
      if (draft.current) lpts.push(draft.current.x + ',' + draft.current.y);
      if (draft.points.length) {
        var ldash = ldef.dashed ? ' stroke-dasharray="8 5"' : '';
        html += '<polyline points="' + lpts.join(' ') + '" fill="none" stroke="' + U.esc(ldef.color) + '" stroke-width="3"' + ldash + ' stroke-linejoin="round" stroke-linecap="round" opacity="0.9"></polyline>';
        var lend = draft.current || draft.points[draft.points.length - 1];
        var lprev = draft.points[draft.points.length - 1];
        var lang = Math.atan2(lend.y - lprev.y, lend.x - lprev.x) * 180 / Math.PI;
        html += lineHeadSvg(ldef.head, lend.x, lend.y, lang, ldef.color);
      }
      html += '<text x="' + ((draft.current ? draft.current.x : 0) + 14) + '" y="' + ((draft.current ? draft.current.y : 0) - 10) + '" fill="#e6ca8a" font-size="10" opacity="0.8">双击结束 · Esc 取消</text>';
    } else if (draft.tool === 'zoneRect' && draft.start && draft.current) {
      var x = Math.min(draft.start.x, draft.current.x);
      var y = Math.min(draft.start.y, draft.current.y);
      var w = Math.abs(draft.current.x - draft.start.x);
      var h = Math.abs(draft.current.y - draft.start.y);
      html += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="rgba(176,90,85,0.12)" stroke="#e6ca8a" stroke-width="1.5" stroke-dasharray="6 4"></rect>';
    } else if (draft.tool === 'zoneCircle' && draft.start && draft.current) {
      var r = Math.sqrt(Math.pow(draft.current.x - draft.start.x, 2) + Math.pow(draft.current.y - draft.start.y, 2));
      html += '<circle cx="' + draft.start.x + '" cy="' + draft.start.y + '" r="' + r + '" fill="rgba(176,90,85,0.12)" stroke="#e6ca8a" stroke-width="1.5" stroke-dasharray="6 4"></circle>';
    } else if (draft.tool === 'skill' && draft.start && draft.current) {
      var sr = Math.sqrt(Math.pow(draft.current.x - draft.start.x, 2) + Math.pow(draft.current.y - draft.start.y, 2));
      var sType = GM.state.ui.skillShape || 'circle';
      var sAng = Math.atan2(draft.current.y - draft.start.y, draft.current.x - draft.start.x) * 180 / Math.PI;
      if (sType === 'sector') {
        var a0 = (sAng - 45) * Math.PI / 180;
        var a1 = (sAng + 45) * Math.PI / 180;
        var sx0 = draft.start.x + sr * Math.cos(a0);
        var sy0 = draft.start.y + sr * Math.sin(a0);
        var sx1 = draft.start.x + sr * Math.cos(a1);
        var sy1 = draft.start.y + sr * Math.sin(a1);
        html += '<path d="M' + draft.start.x + ',' + draft.start.y +
          ' L' + sx0.toFixed(2) + ',' + sy0.toFixed(2) +
          ' A' + sr + ',' + sr + ' 0 0 1 ' + sx1.toFixed(2) + ',' + sy1.toFixed(2) + ' Z"' +
          ' fill="rgba(121,182,160,0.14)" stroke="#e6ca8a" stroke-width="1.5" stroke-dasharray="6 4"></path>';
      } else if (sType === 'rect') {
        var len = sr * 2;
        html += '<g transform="translate(' + draft.start.x + ' ' + draft.start.y + ') rotate(' + sAng + ')">' +
          '<rect x="' + (-sr) + '" y="-1.5" width="' + len + '" height="3"' +
          ' fill="rgba(121,182,160,0.14)" stroke="#e6ca8a" stroke-width="1.5" stroke-dasharray="6 4"></rect></g>';
      } else {
        html += '<circle cx="' + draft.start.x + '" cy="' + draft.start.y + '" r="' + sr + '" fill="rgba(121,182,160,0.14)" stroke="#e6ca8a" stroke-width="1.5" stroke-dasharray="6 4"></circle>';
      }
    }

    g.innerHTML = html;
  }

  var draw = {
    TOOLS: TOOLS,

    isDrawTool: function (tool) {
      return TOOLS.indexOf(tool) > -1;
    },

    init: function () {
      GM.bus.on('change', function (payload) {
        if (payload && payload.label && draft) resetDraft();
      });
      GM.bus.on('map:changed', resetDraft);
      GM.bus.on('tool:changed', function (tool) {
        if (draft && draft.tool !== tool) resetDraft();
      });
    },

    cancel: resetDraft,

    finishRoute: function () {
      if (!draft || draft.tool !== 'route') return false;
      var points = draft.points.slice();
      var cleaned = [];
      points.forEach(function (p) {
        var last = cleaned[cleaned.length - 1];
        if (!last || Math.abs(last.x - p.x) > 4 || Math.abs(last.y - p.y) > 4) cleaned.push(p);
      });
      if (cleaned.length < 2) {
        resetDraft();
        return false;
      }

      var shape = startShape('route', 'routes');
      shape.points = cleaned;
      shape.color = COLORS.route;
      shape.width = 3;
      shape.x = cleaned[0].x;
      shape.y = cleaned[0].y;
      addShape(shape);
      resetDraft();
      GM.select('shape', shape.id);
      GM.commit('绘制推进路线');
      return true;
    },

    /* 进攻 / 虚线进攻 / 防守 / 禁止：同一套多点画线，双击结束 */
    finishLine: function () {
      if (!draft || draft.tool !== 'line') return false;
      var def = lineDef(draft.lineType);
      var cleaned = [];
      draft.points.forEach(function (p) {
        var last = cleaned[cleaned.length - 1];
        if (!last || Math.abs(last.x - p.x) > 4 || Math.abs(last.y - p.y) > 4) cleaned.push(p);
      });
      if (cleaned.length < 2) {
        resetDraft();
        return false;
      }

      var shape = startShape('line', 'routes');
      shape.points = cleaned;
      shape.lineType = def.id;
      shape.dashed = !!def.dashed;
      shape.color = def.color;
      shape.width = 3;
      shape.x = cleaned[0].x;
      shape.y = cleaned[0].y;
      addShape(shape);
      resetDraft();
      GM.select('shape', shape.id);
      GM.commit('绘制' + def.name + '线');
      return true;
    },

    onPointerDown: function (world, e) {
      var tool = GM.state.ui.tool;

      if (tool === 'route') {
        if (!draft) draft = { tool: 'route', points: [], current: world };
        var last = draft.points[draft.points.length - 1];
        if (!last || Math.abs(last.x - world.x) > 4 || Math.abs(last.y - world.y) > 4) {
          draft.points.push({ x: world.x, y: world.y });
        }
        drawPreview();
        return;
      }

      if (LINE_TOOLS.indexOf(tool) > -1) {
        if (!world) return;
        if (!draft || draft.tool !== 'line' || draft.lineType !== tool) {
          draft = { tool: 'line', lineType: tool, points: [], current: world };
        }
        var lastPoint = draft.points[draft.points.length - 1];
        if (!lastPoint || Math.abs(lastPoint.x - world.x) > 4 || Math.abs(lastPoint.y - world.y) > 4) {
          draft.points.push({ x: world.x, y: world.y });
        }
        drawPreview();
        return;
      }

      if (ICON_TOOLS.indexOf(tool) > -1) {
        if (!world) return;
        var icon = GM.placeIconMarker(tool, world.x, world.y);
        if (!icon) return;
        var def = iconDef(tool);
        GM.select('marker', icon.id);
        GM.commit('放置' + ((def && def.name) || '图标') + '标记');
        return;
      }

      if (tool === 'zoneRect' || tool === 'zoneCircle' || tool === 'skill') {
        draft = { tool: tool, start: { x: world.x, y: world.y }, current: world };
        drawPreview();
        return;
      }

      if (tool === 'note') {
        if (!world) return;
        var point = { x: Math.round(world.x), y: Math.round(world.y) };
        GM.ui.promptText('文字标注', '输入标注内容', '').then(function (text) {
          if (text == null || !String(text).trim()) return;
          var note = startShape('note', 'notes');
          note.x = point.x;
          note.y = point.y;
          note.text = String(text).trim();
          note.color = COLORS.note;
          addShape(note);
          GM.select('shape', note.id);
          GM.commit('添加文字标注');
        });
      }
    },

    onPointerMove: function (world) {
      if (!draft) return;
      if (draft.tool === 'route' || draft.tool === 'line') {
        draft.current = { x: world.x, y: world.y };
        drawPreview();
      } else if (draft.tool === 'zoneRect' || draft.tool === 'zoneCircle' || draft.tool === 'skill') {
        draft.current = { x: world.x, y: world.y };
        drawPreview();
      }
    },

    onPointerUp: function (world) {
      if (!draft) return;
      if (draft.tool === 'zoneRect') {
        var sx = draft.start.x;
        var sy = draft.start.y;
        var w = world.x - sx;
        var h = world.y - sy;
        resetDraft();
        if (Math.abs(w) < 6 || Math.abs(h) < 6) return;
        var rect = startShape('zoneRect', 'zones');
        rect.x = Math.min(sx, sx + w);
        rect.y = Math.min(sy, sy + h);
        rect.w = Math.abs(w);
        rect.h = Math.abs(h);
        rect.color = COLORS.zone;
        rect.width = 2;
        addShape(rect);
        GM.select('shape', rect.id);
        GM.commit('绘制矩形区域');
      } else if (draft.tool === 'zoneCircle') {
        var r = Math.sqrt(Math.pow(world.x - draft.start.x, 2) + Math.pow(world.y - draft.start.y, 2));
        var cx = draft.start.x;
        var cy = draft.start.y;
        resetDraft();
        if (r < 6) return;
        var circle = startShape('zoneCircle', 'zones');
        circle.x = cx;
        circle.y = cy;
        circle.r = r;
        circle.color = COLORS.zone;
        circle.width = 2;
        addShape(circle);
        GM.select('shape', circle.id);
        GM.commit('绘制圆形区域');
      } else if (draft.tool === 'skill') {
        var sr = Math.sqrt(Math.pow(world.x - draft.start.x, 2) + Math.pow(world.y - draft.start.y, 2));
        var skx = draft.start.x;
        var sky = draft.start.y;
        var shapeType = GM.state.ui.skillShape || 'circle';
        if (shapeType !== 'sector' && shapeType !== 'rect') shapeType = 'circle';
        var dir = Math.atan2(world.y - draft.start.y, world.x - draft.start.x) * 180 / Math.PI;
        resetDraft();
        /* 技能范围只做入口与落点：图元可选中 / 拖动 / 删除，不参与推演结算 */
        if (sr < 6) return;
        var skill = startShape('skill', 'zones');
        skill.x = skx;
        skill.y = sky;
        skill.r = sr;
        skill.shapeType = shapeType;
        skill.angle = dir;
        skill.span = 90;
        /* 矩形按拖拽半径定长（长 = 2 × 半径），宽度默认 3 unit；之后可在检查器改 */
        if (shapeType === 'rect') {
          skill.len = Math.max(2, sr * 2);
          skill.wid = 3;
        }
        skill.text = '技能范围';
        skill.color = COLORS.skill;
        skill.width = 2;
        skill.dashed = true;
        skill.preset = 'custom';
        addShape(skill);
        GM.select('shape', skill.id);
        GM.commit('绘制技能范围');
      }
    },

    onPointerLeave: function () {
      if (draft && (draft.tool === 'route' || draft.tool === 'line')) {
        drawPreview();
      }
    },

    onDoubleClick: function (world, e) {
      if (!draft) return;
      if (draft.tool !== 'route' && draft.tool !== 'line') return;
      if (e) e.preventDefault();
      if (draft.tool === 'line') draw.finishLine();
      else draw.finishRoute();
    }
  };

  GM.draw = draw;
})();
