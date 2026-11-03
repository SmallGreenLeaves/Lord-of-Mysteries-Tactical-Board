(function () {
  'use strict';

  window.GM = window.GM || {};

  var GM = window.GM;

  GM.util = {
    uid: function (prefix) {
      return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    },

    clone: function (obj) {
      return JSON.parse(JSON.stringify(obj));
    },

    esc: function (str) {
      return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    },

    clamp: function (n, min, max) {
      n = Number(n);
      if (!isFinite(n)) n = min;
      return Math.min(max, Math.max(min, n));
    },

    debounce: function (fn, wait) {
      var timer = null;
      return function () {
        var args = arguments;
        var ctx = this;
        clearTimeout(timer);
        timer = setTimeout(function () { fn.apply(ctx, args); }, wait);
      };
    },

    download: function (filename, text) {
      var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 120);
    },

    dateStamp: function (d) {
      d = d || new Date();
      var p = function (n) { return String(n).padStart(2, '0'); };
      return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
    },

    statusById: function (id) {
      var list = (window.GM_DATA && window.GM_DATA.statuses) || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) return list[i];
      }
      return list[0] || { id: 'idle', name: '待命', color: '#8ea3b8' };
    },

    classById: function (id) {
      var project = GM.state && GM.state.project;
      var list = (project && project.classes) || (window.GM_DATA && window.GM_DATA.classes) || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) return list[i];
      }
      return list[0] || null;
    },

    factionById: function (id) {
      var project = GM.state && GM.state.project;
      var list = (project && project.factions) || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) return list[i];
      }
      return { id: id || 'A', name: id || 'A', color: '#8a919f' };
    },

    teamKindInit: function (kind) {
      return ((window.GM_DATA && window.GM_DATA.teamKinds) || {})[kind] || { label: '队伍', short: '?', max: 999 };
    },

    /* 点是否在多边形内（射线法）；环数据格式 [[x,y],...] */
    pointInRing: function (x, y, ring) {
      if (!ring || ring.length < 3) return false;
      var inside = false;
      for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var xi = ring[i][0], yi = ring[i][1];
        var xj = ring[j][0], yj = ring[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
      }
      return inside;
    },

    /* 矢量化墙体判定：在外轮廓内、且不在任何墙体洞里 = 可行走。
       不做据点 / 结界豁免：据点与出生点已全部落在可行走面内，判定结果必须是真实轮廓。 */
    isWalkable: function (md, x, y) {
      var rings = (md && md.geometry && md.geometry.rings) || [];
      if (!rings.length) return true;
      if (!this.pointInRing(x, y, rings[0])) return false;
      for (var i = 1; i < rings.length; i++) {
        if (this.pointInRing(x, y, rings[i])) return false;
      }
      return true;
    },

    /* 投影到最近的可行走点：重投影迁移与越墙修正都用它 */
    nearestWalkable: function (md, x, y, maxR) {
      if (this.isWalkable(md, x, y)) return { x: x, y: y, snapped: false };
      maxR = maxR || 60;
      for (var r = 0.5; r <= maxR; r += 0.5) {
        var steps = Math.max(10, Math.round(r * 6));
        for (var i = 0; i < steps; i++) {
          var a = (i / steps) * Math.PI * 2;
          var px = x + Math.cos(a) * r;
          var py = y + Math.sin(a) * r;
          if (this.isWalkable(md, px, py)) return { x: px, y: py, snapped: true };
        }
      }
      return { x: x, y: y, snapped: false };
    }
  };

  /* 极简事件总线：所有模块通过它解耦刷新 */
  GM.bus = {
    _handlers: {},
    on: function (name, fn) {
      (this._handlers[name] = this._handlers[name] || []).push(fn);
    },
    emit: function (name, payload) {
      var list = (this._handlers[name] || []).slice();
      for (var i = 0; i < list.length; i++) {
        try {
          list[i](payload);
        } catch (err) {
          console.error('[GM] 事件处理失败:', name, err);
        }
      }
    }
  };
})();
