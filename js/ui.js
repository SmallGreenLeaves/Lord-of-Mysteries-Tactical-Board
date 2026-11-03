(function () {
  'use strict';

  window.GM = window.GM || {};
  var GM = window.GM;
  var U = GM.util;

  function q(sel) { return document.querySelector(sel); }
  function qa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  var SHAPE_LABELS = {
    route: '推进路线',
    rally: '集结点',
    zoneRect: '矩形区域',
    zoneCircle: '圆形区域',
    note: '文字标注',
    skill: '技能范围'
  };

  function skillPresetById(id) {
    var found = null;
    (window.GM_DATA.skillPresets || []).forEach(function (p) { if (p.id === id) found = p; });
    return found;
  }

  var TOOL_HINTS = {
    select: '选择模式：拖动标记调整位置；在空白处拖动可平移沙盘。',
    hand: '抓手模式：拖动平移沙盘，滚轮缩放。',
    route: '路线：单击添加路径点，双击或 Enter 结束，Esc 取消。',
    attack: '进攻：单击添加路径点，双击或 Enter 结束，绘制实线进攻箭头（可选中 / 拖动 / 删除，不参与推演）。',
    attackDash: '虚线进攻：单击添加路径点，双击或 Enter 结束，绘制虚线进攻箭头（可选中 / 拖动 / 删除，不参与推演）。',
    defense: '防守：单击添加路径点，双击或 Enter 结束，绘制防守线（末端盾标，可选中 / 拖动 / 删除，不参与推演）。',
    forbid: '禁止：单击添加路径点，双击或 Enter 结束，绘制禁止线（末端禁止符，可选中 / 拖动 / 删除，不参与推演）。',
    rallyFlag: '集结：单击落点放置集结旗号（图标标记，可拖动 / 选中 / 删除，不参与推演）。',
    zoneRect: '矩形：按住拖动生成矩形框。',
    zoneCircle: '圆形：按住拖动生成圆形范围。',
    note: '标注：单击位置后输入文字。',
    skill: '技能：按住拖动绘制扇形 / 圆形 / 矩形范围（1 米 = 1 unit；仅示意，可选中、拖动、删除，不参与推演）。',
    teamPlace: '团队：先选择级别、颜色与人数（个人级按职业色、无人数），再单击沙盘落点。'
  };

  /* 工具栏图标：内联 SVG（零外链），颜色走 currentColor，不用新增暗灰 */
  var TOOL_ICON_SVG = {
    attack: '<svg class="tool-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1 L13.5 14 L8 11 L2.5 14 Z" fill="currentColor"></path></svg>',
    attackDash: '<svg class="tool-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1 L12.5 7 L3.5 7 Z" fill="currentColor"></path><line x1="8" y1="8" x2="8" y2="15" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2 2"></line></svg>',
    defense: '<svg class="tool-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1 L14 3.5 L14 8 Q14 13 8 15 Q2 13 2 8 L2 3.5 Z" fill="currentColor" fill-opacity="0.22" stroke="currentColor" stroke-width="1.3"></path></svg>',
    forbid: '<svg class="tool-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"></circle><line x1="3.8" y1="3.8" x2="12.2" y2="12.2" stroke="currentColor" stroke-width="1.4"></line></svg>',
    rallyFlag: '<svg class="tool-icon" viewBox="0 0 16 16" aria-hidden="true"><line x1="4" y1="1.5" x2="4" y2="15" stroke="currentColor" stroke-width="1.4"></line><path d="M4 1.5 L12.5 4 L4 6.5 Z" fill="currentColor"></path></svg>',
    zoneRect: '<svg class="tool-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="4" width="12" height="8" fill="none" stroke="currentColor" stroke-width="1.4"></rect></svg>',
    zoneCircle: '<svg class="tool-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"></circle></svg>',
    note: '<svg class="tool-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5 H14 M2 8 H12 M2 12.5 H9" stroke="currentColor" stroke-width="1.4" fill="none"></path></svg>'
  };

  function decorateToolIcons() {
    qa('#toolButtons .tool').forEach(function (btn) {
      if (btn.querySelector('.tool-icon')) return;
      var svg = TOOL_ICON_SVG[btn.getAttribute('data-tool')];
      if (svg) btn.insertAdjacentHTML('afterbegin', svg);
    });
  }

  /* ---------- 画线工具组（进攻 / 虚线进攻 / 防守 / 禁止）：单个按钮 + 右键切换 ---------- */
  var LINE_TOOL_IDS = ['attack', 'attackDash', 'defense', 'forbid'];

  function lineToolById(id) {
    var found = null;
    (window.GM_DATA.lineTools || []).forEach(function (d) { if (d.id === id) found = d; });
    return found;
  }

  function currentLineToolId() {
    var id = GM.state.ui.lineTool;
    return LINE_TOOL_IDS.indexOf(id) > -1 ? id : 'attack';
  }

  function renderLineGroupButton() {
    var btn = q('#btnLineGroup');
    if (!btn) return;
    var id = currentLineToolId();
    var def = lineToolById(id);
    btn.setAttribute('data-tool', id);
    btn.innerHTML = (TOOL_ICON_SVG[id] || '') + '<span>' + U.esc((def && def.name) || '进攻') + '</span>';
  }

  function closeLineToolMenu() {
    var menu = q('#lineToolFlyout');
    if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
  }

  function openLineToolMenu(anchor) {
    closeLineToolMenu();
    var menu = document.createElement('div');
    menu.className = 'tool-flyout';
    menu.id = 'lineToolFlyout';
    LINE_TOOL_IDS.forEach(function (id) {
      var def = lineToolById(id) || { id: id, name: id };
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'tool-flyout-item' + (id === currentLineToolId() ? ' active' : '');
      item.innerHTML = (TOOL_ICON_SVG[id] || '') + '<span>' + U.esc(def.name) + '</span>';
      item.addEventListener('click', function () {
        GM.state.ui.lineTool = id;
        closeLineToolMenu();
        setTool(id);
      });
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    var rect = anchor.getBoundingClientRect();
    var left = Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8));
    menu.style.left = left + 'px';
    menu.style.top = (rect.bottom + 4) + 'px';
  }

  /* ============================ 弹窗 ============================ */

  function modalFrame(title, sub, bodyHtml, footHtml) {
    return '<div class="modal" role="dialog" aria-modal="true">' +
      '<div class="modal-head"><div><h3>' + U.esc(title) + '</h3>' +
      (sub ? '<div class="modal-sub">' + U.esc(sub) + '</div>' : '') + '</div></div>' +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      '<div class="modal-foot">' + footHtml + '</div>' +
      '</div>';
  }

  function openModal(html, onMount) {
    var root = q('#modalRoot');
    root.innerHTML = html;
    root.classList.remove('hidden');
    if (onMount) onMount(root);
    return root;
  }

  function closeModal() {
    var root = q('#modalRoot');
    if (!root) return;
    root.classList.add('hidden');
    root.innerHTML = '';
  }

  function promptText(title, label, defaultValue, hint) {
    return new Promise(function (resolve) {
      var body = '<div class="field"><label>' + U.esc(label || '内容') + '</label>' +
        '<input type="text" id="modalInput" value="' + U.esc(defaultValue || '') + '" spellcheck="false" maxlength="60"></div>' +
        (hint ? '<div class="modal-hint">' + U.esc(hint) + '</div>' : '');
      var foot = '<button type="button" class="btn ghost" data-modal-cancel>取消</button>' +
        '<button type="button" class="btn gold" data-modal-ok>确定</button>';

      var root = openModal(modalFrame(title, '', body, foot), function (rootEl) {
        var input = rootEl.querySelector('#modalInput');
        setTimeout(function () {
          input.focus();
          input.select();
        }, 30);

        function done(value) {
          document.removeEventListener('keydown', onKey);
          closeModal();
          resolve(value);
        }
        function onKey(e) {
          if (e.key === 'Escape') { e.preventDefault(); done(null); }
          else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); done(input.value); }
        }
        document.addEventListener('keydown', onKey);
        rootEl.querySelector('[data-modal-ok]').addEventListener('click', function () { done(input.value); });
        rootEl.querySelector('[data-modal-cancel]').addEventListener('click', function () { done(null); });
        rootEl.addEventListener('mousedown', function (e) {
          if (e.target === rootEl) done(null);
        });
        rootEl._cleanup = function () { document.removeEventListener('keydown', onKey); };
      });
      void root;
    });
  }

  function confirmDialog(title, message, confirmText) {
    return new Promise(function (resolve) {
      var body = '<div class="modal-hint" style="font-size:12px;line-height:1.7">' + U.esc(message).replace(/\n/g, '<br>') + '</div>';
      var foot = '<button type="button" class="btn ghost" data-modal-cancel>取消</button>' +
        '<button type="button" class="btn gold" data-modal-ok>' + U.esc(confirmText || '确定') + '</button>';

      var root = openModal(modalFrame(title, '', body, foot), function (rootEl) {
        function done(value) {
          document.removeEventListener('keydown', onKey);
          closeModal();
          resolve(value);
        }
        function onKey(e) {
          if (e.key === 'Escape') { e.preventDefault(); done(false); }
          else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); done(true); }
        }
        document.addEventListener('keydown', onKey);
        rootEl.querySelector('[data-modal-ok]').addEventListener('click', function () { done(true); });
        rootEl.querySelector('[data-modal-cancel]').addEventListener('click', function () { done(false); });
        rootEl.addEventListener('mousedown', function (e) {
          if (e.target === rootEl) done(false);
        });
        setTimeout(function () {
          var btn = rootEl.querySelector('[data-modal-ok]');
          if (btn) btn.focus();
        }, 30);
      });
      void root;
    });
  }

  /* ============================ Toast / 状态 ============================ */

  var toastTimers = [];

  function toast(message, type) {
    var root = q('#toastRoot');
    if (!root) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = message;
    root.appendChild(el);
    var timer = setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 2800);
    toastTimers.push(timer);
  }

  var lastSavedAt = null;

  function clockText(d) {
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function applySaveStatus(status, silent, detail, fresh) {
    var el = q('#saveStatus');
    if (!el) return;
    el.classList.remove('saved', 'error');
    el.removeAttribute('title');
    if (status === 'saved') {
      if (fresh || !lastSavedAt) lastSavedAt = new Date();
      el.textContent = '已自动保存 · ' + clockText(lastSavedAt);
      el.title = '编成与沙盘改动已写入 localStorage';
      el.classList.add('saved');
    } else if (status === 'restored') {
      el.textContent = '已恢复本地存档';
      el.classList.add('saved');
    } else if (status === 'pending') {
      el.textContent = '保存中…';
    } else if (status === 'unavailable') {
      el.textContent = '本地存储不可用';
      el.title = detail || '浏览器禁用了 localStorage（无痕模式 / 站点设置）';
      el.classList.add('error');
      if (detail) toast('本地存储不可用：' + detail, 'error');
    } else if (status === 'error') {
      el.textContent = '保存失败';
      el.title = detail || '写入 localStorage 失败';
      el.classList.add('error');
      if (detail) toast('保存失败：' + detail, 'error');
    } else if (status === 'new') {
      el.textContent = '新工程 · 自动保存';
    }
    void silent;
  }

  /* ============================ 工具 / 顶栏 ============================ */

  function setTool(tool, silent) {
    if (!TOOL_HINTS[tool]) return;
    GM.state.ui.tool = tool;
    if (GM.draw) GM.draw.cancel();
    renderToolbar();
    if (GM.board) GM.board.applyCursor();
    updateHint();
    if (!silent) GM.bus.emit('tool:changed', tool);
  }

  function renderToolbar() {
    renderLineGroupButton();
    qa('#toolButtons .tool').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-tool') === GM.state.ui.tool);
    });
    var snapBtn = q('#btnSnap');
    if (snapBtn) {
      var on = GM.state.project && GM.state.project.grid.enabled;
      snapBtn.innerHTML = '吸附网格 <b>' + (on ? '开' : '关') + '</b>';
      snapBtn.classList.toggle('gold', !!on);
    }

    var undoBtn = q('#btnUndo');
    var redoBtn = q('#btnRedo');
    if (undoBtn) undoBtn.disabled = !GM.canUndo();
    if (redoBtn) redoBtn.disabled = !GM.canRedo();
    var delBtn = q('#btnDelete');
    /* 地图对象（中央占领圈）不可删除：选中时禁用删除按钮 */
    if (delBtn) {
      var sel = GM.state.ui.selected;
      delBtn.disabled = !sel || sel.type === 'objective';
    }
    syncToolPanels();
  }

  /* 工具栏二级选项：只随当前工具显隐，不写存档 */
  function syncToolPanels() {
    var tool = GM.state.ui.tool;
    var teamPanel = q('#teamToolPanel');
    var skillPanel = q('#skillToolPanel');
    if (teamPanel) teamPanel.classList.toggle('hidden', tool !== 'teamPlace');
    if (skillPanel) skillPanel.classList.toggle('hidden', tool !== 'skill');

    var tt = GM.state.ui.teamTool || { kind: 'squad', relation: 'enemy-red', count: 0 };
    var kindSel = q('#teamToolKind');
    if (kindSel) kindSel.value = tt.kind;
    var colorSel = q('#teamToolColor');
    if (colorSel) {
      colorSel.value = tt.relation;
      /* 个人级按职业色，不显示颜色下拉 */
      colorSel.classList.toggle('hidden', tt.kind === 'person');
    }
    var countInput = q('#teamToolCount');
    if (countInput) {
      countInput.value = String(Math.max(0, Math.min(150, Math.round(Number(tt.count) || 0))));
      /* 个人标记没有人数概念：隐藏人数输入，避免误以为会影响第二行 */
      countInput.classList.toggle('hidden', tt.kind === 'person');
    }
    var skillSel = q('#skillToolType');
    if (skillSel) skillSel.value = GM.state.ui.skillShape || 'circle';
  }

  function updateHint() {
    var hint = q('#boardHint');
    if (!hint) return;
    if (GM.state.ui.diff) {
      hint.textContent = '差异模式：绿色连线为标记位移，绿圈为新增，红叉为消失。';
    } else {
      hint.textContent = TOOL_HINTS[GM.state.ui.tool] || '';
    }
  }

  function syncTopFields() {
    var project = GM.state.project;
    if (!project) return;
    var nameInput = q('#projectName');
    if (nameInput && document.activeElement !== nameInput) nameInput.value = project.name;

    var mapSelect = q('#mapSelect');
    if (mapSelect && document.activeElement !== mapSelect) mapSelect.value = project.mapId;
  }

  function switchMap(mapId) {
    var project = GM.state.project;
    if (!project || project.mapId === mapId) return;
    var md = window.GM_DATA.mapById(mapId);
    if (!md) return;

    GM.plans.stopPlayback();
    project.mapId = md.id;
    project.mapLevel = GM.defaultMapLevel(md);
    /* 星墓高原首次进入即算「已使用默认高程」，之后玩家手动选地面层不会被归一化改回去 */
    if (md.id === 'star-tomb') project.starLevelDefaulted = true;
    /* 新建工程切到地图时记录当前版本，避免下次载入被当成 v1 旧坐标再仿射一次 */
    project.mapVersions = project.mapVersions || {};
    if (!project.mapVersions[md.id]) project.mapVersions[md.id] = md.mapVersion || 1;
    GM.ensureActivePlan();
    GM.state.ui.selected = null;
    GM.state.ui.diff = false;
    GM.commit('切换地图');
    GM.bus.emit('map:changed');
    GM.bus.emit('selection');
    GM.ui.toast('已切换到「' + md.name + '」', 'success');
  }

  /* ============================ 地图态势 ============================ */

  function renderMapMeta() {
    var host = q('#mapMeta');
    var tag = q('#mapModeTag');
    if (!host) return;
    var project = GM.state.project;
    var md = GM.currentMap();
    if (!project || !md) return;

    if (tag) tag.textContent = md.modeLabel;

    var factions = project.factions.slice(0, md.factionCount);
    var legend = factions.map(function (f) {
      return '<span class="legend-item"><span class="legend-swatch" style="background:' + U.esc(f.color) + '"></span>' + U.esc(f.name) + '</span>';
    }).join('');

    var rules = (md.rules || []).map(function (r) { return '<li>' + U.esc(r) + '</li>'; }).join('');

    var refLine = '';
    if (md.refImage) {
      refLine = '<div class="map-desc">参考原图：<a href="' + U.esc(md.refImage) + '" target="_blank" rel="noopener" style="color:#c9a55a">' + U.esc(md.refImage.split('/').pop()) + '</a>' +
        (md.refAlt ? ' / ' + U.esc(md.refAlt.split('/').pop()) : '') +
        '（已按参考图 1:1 矢量化，内嵌 SVG path，不贴位图）</div>';
    }

    /* 原图 / 重绘 两态切换：只在猎龙之城与霍纳奇斯显示；选择按地图存 localStorage（独立键，不写工程） */
    var baseMode = '';
    if (GM.photo && GM.photo.supported(md.id)) {
      var isPhoto = GM.photo.mode() === 'photo';
      var ph = GM.photo.image() || {};
      baseMode = '<div class="base-mode" role="group" aria-label="底图模式">' +
        '<span class="base-mode-label">底图</span>' +
        '<button type="button" class="base-mode-btn' + (isPhoto ? ' active' : '') + '" data-base-mode="photo" title="原图铺满 0,0 → ' + (ph.w || 0) + '×' + (ph.h || 0) + '；矢量重绘层默认隐藏">原图</button>' +
        '<button type="button" class="base-mode-btn' + (!isPhoto ? ' active' : '') + '" data-base-mode="redraw" title="矢量重绘（全部语义层按图层面板显示）">重绘</button>' +
        '</div>' +
        '<div class="map-desc base-mode-note">' + (isPhoto
          ? (md.mode === 'club-war'
            ? '当前为原图底图：矢量地形 / 道路默认隐藏，可在下方图层手动叠回；特殊点位与屏障按各自图层开关显示。'
            : '当前为原图底图：道路 / 崖壁 / 水域 / 冰湖 / 雪地 / 高度图默认隐藏，可在下方图层手动叠回。')
          : '当前为矢量重绘：全部语义层按图层开关显示。') + '</div>';
    }

    var reserved = '';
    if (md.mode === 'capture') {
      var sc = md.scoring || {};
      reserved = '<div class="map-desc">积分规则：首占 +' + (sc.firstCapturePoints || 0) + '；每 ' + (sc.bigTickSeconds || 0) +
        ' 秒统一结算一次，每个守卫 +' + (sc.bigPointsPerGuard || 0) + '；结算点落在高倍窗口内时按刷新守卫位置 ×4 = ' +
        (4 * (sc.bigPointsPerGuard || 0)) + ' / ×6 = ' + (6 * (sc.bigPointsPerGuard || 0)) + '；率先 ' +
        (sc.targetScore || 0) + ' 分锁胜，单局 ' + (sc.durationSeconds || 0) + ' 秒。归属只由沙盘守卫热区或「推演」面板修改。</div>';
    } else if (md.mode === 'escort') {
      reserved = '<div class="map-desc">双层图层（ground / upper）与方案级 <b style="color:#b9b3a5">escort</b> 字段已启用：占领圈按圈内人数判定，骑士推进见「推演」面板。</div>';
    } else if (md.mode === 'siege-capture') {
      reserved = '<div class="map-desc">下方攻城态势与沙盘热区均可推演石碑归属、城门解锁与中央高台积分。</div>';
    }

    /* 三行关键信息 + 势力色点常驻；说明 / 规则 / 参考图收进「玩法规则」折叠，不再占面板高度 */
    var briefHtml = md.briefing ? '<div class="map-desc">' + U.esc(md.briefing) + '</div>' : '';
    var rulesHtml = rules ? '<ul>' + rules + '</ul>' : '';
    var rulesBlock = (briefHtml || rulesHtml || refLine)
      ? '<details class="map-rules"><summary>玩法规则</summary>' + briefHtml + rulesHtml + refLine + reserved + '</details>'
      : '';

    host.innerHTML = '' +
      '<div class="map-line"><span>地图</span><b>' + U.esc(md.name) + '</b></div>' +
      '<div class="map-line"><span>模式</span><b>' + U.esc(md.modeLabel) + '</b></div>' +
      '<div class="map-line"><span>势力 · 目标</span><b>' + md.factionCount + ' 方 · ' + md.objectiveCount + ' 个目标</b></div>' +
      baseMode +
      '<div class="faction-legend">' + legend + '</div>' +
      rulesBlock;
  }

  /* 原图 / 重绘 切换按钮（地图态势卡内，委托到稳定的 #mapMeta 容器） */
  function bindBaseMode() {
    var host = q('#mapMeta');
    if (!host) return;
    host.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-base-mode]');
      if (!btn || !GM.photo) return;
      var mode = btn.getAttribute('data-base-mode');
      if (GM.photo.mode() === mode) return;
      GM.photo.setMode(mode);
      /* 模式只存 localStorage：不写工程、不进撤销栈，缩放 / 标记 / 绘制对象保持不动 */
      if (GM.board) GM.board.render();
      renderAll();
      toast(mode === 'photo' ? '已切换到原图底图（矢量层默认隐藏）' : '已切换到矢量重绘', 'success');
    });
  }

  function renderSiege() {
    var host = q('#siegeCard');
    if (!host) return;
    var project = GM.state.project;
    var md = GM.currentMap();
    if (!project || !md || md.mode !== 'siege-capture' || !md.siege) {
      host.innerHTML = '';
      return;
    }

    var plan = GM.activePlan();
    if (!plan) { host.innerHTML = ''; return; }
    GM.ensurePlanMeta(plan);

    var factionOpts = '<option value="">未占领</option>' + project.factions.map(function (f) {
      return '<option value="' + U.esc(f.id) + '">' + U.esc(f.name) + '</option>';
    }).join('');

    var steleHtml = md.siege.steles.map(function (s) {
      var owner = plan.siege.steles[s.id] || '';
      var options = factionOpts.replace('value="' + U.esc(owner) + '"', 'value="' + U.esc(owner) + '" selected');
      return '<div class="stele-item"><span>' + U.esc(s.name) + '</span>' +
        '<select data-stele-id="' + U.esc(s.id) + '">' + options + '</select></div>';
    }).join('');

    var gateHtml = md.siege.gates.map(function (g) {
      var state = GM.siegeGateState(plan, g);
      var label = GM.siegeGateLabel(state);
      var reqNames = g.unlocks.map(function (sid) {
        var stele = null;
        md.siege.steles.forEach(function (s) { if (s.id === sid) stele = s; });
        return stele ? stele.name : sid;
      }).join(' + ');

      var action = '';
      if (state === 'ready') {
        action = '<button type="button" class="btn mini gate-btn" data-gate-id="' + U.esc(g.id) + '" data-gate-action="break">标记破门</button>';
      } else if (state === 'broken') {
        action = '<button type="button" class="btn mini gate-btn ghost" data-gate-id="' + U.esc(g.id) + '" data-gate-action="unbreak">撤销</button>';
      }

      return '<div class="gate-row" title="解锁条件：' + U.esc(reqNames) + '">' +
        '<span class="gate-name">' + U.esc(g.name) + ' · ' + U.esc(U.factionById(g.factionId).name) + '</span>' +
        '<span class="gate-state ' + state + '">' + label + '</span>' +
        action +
        '</div>';
    }).join('');

    var scores = plan.siege.platformScores || {};
    var target = GM.siegeScoreTarget(plan);
    var winner = GM.siegeWinner(plan);

    var scoreHtml = project.factions.map(function (f) {
      var val = U.clamp(Number(scores[f.id]) || 0, 0, 100);
      return '<div class="score-row">' +
        '<span class="score-name" title="' + U.esc(f.name) + '"><span class="legend-swatch" style="display:inline-block;background:' + U.esc(f.color) + '"></span> ' + U.esc(f.name) + '</span>' +
        '<span class="score-bar"><span class="score-fill" style="width:' + val + '%;background:linear-gradient(90deg, ' + U.esc(f.color) + '55, ' + U.esc(f.color) + ')"></span></span>' +
        '<input class="score-input" type="number" min="0" max="100" step="1" value="' + val + '" data-score-fid="' + U.esc(f.id) + '">' +
        (Number(scores[f.id]) >= target ? '<span class="score-win">胜</span>' : '') +
        '</div>';
    }).join('');

    var gateHelp = '<div class="gate-hint">未解锁 = 尚未同时占领对应两座石碑；可攻 = 两碑均归该门所属势力；已破 = 已进入内城。</div>';
    var winLine = winner ? '<div class="gate-hint" style="color:#e6ca8a">当前胜者：' + U.esc(U.factionById(winner).name) + '（已达 ' + target + '%）</div>' : '';

    host.innerHTML = '' +
      '<div class="siege-title"><span>攻城态势 · 当前方案</span><span>' + U.esc(plan.name) + '</span></div>' +
      '<div class="stele-grid">' + steleHtml + '</div>' +
      '<div class="gate-list">' + gateHtml + '</div>' +
      gateHelp +
      '<div class="siege-title" style="margin-top:9px"><span>中央高台积分</span><span>目标 ' + target + '%</span></div>' +
      '<div class="score-list">' + scoreHtml + '</div>' +
      '<div class="gate-hint">推演：台上人数 × 每人每秒贡献在「推演」面板设定（默认值为假设值）。</div>' +
      winLine;
  }

  /* 地图态势的「模式补充卡」：星墓高原填护送态势；攻城图由 siegeCard 承担。
     四方战（capture）不再提供「守卫归属」下拉——归属只能点沙盘守卫或走推演面板修改。 */
  function renderModeStatus() {
    var host = q('#modeStatus');
    if (!host) return;
    var project = GM.state.project;
    var md = GM.currentMap();
    var plan = GM.activePlan();
    if (!project || !md || !plan) { host.innerHTML = ''; return; }
    GM.ensurePlanMeta(plan);

    if (md.mode === 'escort') {
      var escort = plan.escort;
      var circle = (md.objectives || []).filter(function (o) { return o.type === 'capture-circle'; })[0];
      var carrierOpts = '<option value="">未归属</option>' + project.factions.map(function (f) {
        return '<option value="' + U.esc(f.id) + '"' + (f.id === escort.carrierFactionId ? ' selected' : '') + '>' + U.esc(f.name) + '</option>';
      }).join('');
      var targets = (md.escort && md.escort.returnTargets) || [];
      var targetNames = targets.map(function (id) {
        var o = (md.objectives || []).filter(function (x) { return x.id === id; })[0];
        return o ? o.name : id;
      }).join(' · ');
      var scoreRows = project.factions.map(function (f) {
        var v = Number((escort.scoreByFaction || {})[f.id]) || 0;
        return '<div class="map-line"><span><span class="legend-swatch" style="background:' + U.esc(f.color) + '"></span> ' + U.esc(f.name) + '</span><b>' + v + ' 分</b></div>';
      }).join('');

      host.innerHTML = '' +
        '<div class="siege-title"><span>护送态势 · 当前方案</span><span>' + U.esc(plan.name) + '</span></div>' +
        '<div class="stele-item"><span>骑士归属</span><select data-escort-carrier>' + carrierOpts + '</select></div>' +
        '<div class="stele-item"><span>护送进度</span><input class="score-input" type="number" min="0" max="100" step="5" value="' +
          U.clamp(Number(escort.progress) || 0, 0, 100) + '" data-escort-progress></div>' +
        '<div class="map-line"><span>占领圈</span><b>' + U.esc(circle ? circle.name : '—') + '</b></div>' +
        '<div class="map-line"><span>已交付</span><b>' + (escort.delivered || []).length + ' 次 · 每次 ' +
          U.esc(String((md.scoring && md.scoring.deliveryPoints) || 1200)) + ' 分</b></div>' +
        '<div class="gate-hint">返回目标：' + U.esc(targetNames || '—') + '</div>' +
        '<div class="score-list">' + scoreRows + '</div>';
      return;
    }

    host.innerHTML = '';
  }

  function bindModeStatus() {
    var host = q('#modeStatus');
    if (!host) return;

    host.addEventListener('change', function (e) {
      var plan = GM.activePlan();
      if (!plan) return;
      GM.ensurePlanMeta(plan);

      var carrier = e.target.closest('[data-escort-carrier]');
      if (carrier) {
        plan.escort.carrierFactionId = carrier.value || null;
        GM.commit('推演骑士归属');
        return;
      }
      var progress = e.target.closest('[data-escort-progress]');
      if (progress) {
        plan.escort.progress = U.clamp(Number(progress.value) || 0, 0, 100);
        GM.commit('推演护送进度');
      }
    });
  }

  /* ============================ 右栏：按选中状态切换（图层区常驻） ============================ */

  function updateRightPanel() {
    var sel = GM.state.ui.selected;
    var situation = q('#rightSituation');
    var inspector = q('#inspector');
    var title = q('#rightTitle');
    if (situation) situation.classList.toggle('hidden', !!sel);
    if (inspector) inspector.classList.toggle('hidden', !sel);
    if (title) title.textContent = sel ? '属性检查器' : '地图态势';
  }

  /* ============================ 图层 ============================ */

  function layerCounts() {
    var project = GM.state.project;
    var md = GM.currentMap();
    var level = project.mapLevel;
    var layered = md.layers && md.layers.length > 1;
    var phase = GM.activePhase();
    var counts = { zones: 0, routes: 0, notes: 0, markers: 0, personal: 0 };
    if (!phase) return counts;

    phase.shapes.forEach(function (s) {
      if (layered && s.mapLayer !== level) return;
      if (s.layer in counts) counts[s.layer]++;
    });
    phase.markers.forEach(function (m) {
      if (layered && m.mapLayer !== level) return;
      if (m.ref && m.ref.type === 'person') counts.personal++;
      else counts.markers++;
    });
    return counts;
  }

  function renderLayers() {
    var host = q('#layersPanel');
    if (!host) return;
    var project = GM.state.project;
    var md = GM.currentMap();
    if (!project) return;

    var layered = md.layers && md.layers.length > 1;
    var levelTag = q('#layerLevelTag');
    var currentLayer = null;
    if (layered) {
      md.layers.forEach(function (l) { if (l.id === project.mapLevel) currentLayer = l; });
    }
    /* 面板标题右侧只写当前高程的短名（「地面层 · 台下镂空区」→「地面层」），不硬编码层级文案 */
    if (levelTag) levelTag.textContent = currentLayer ? String(currentLayer.name || '').split('·')[0].trim() : '单层';

    var levelHtml = '';
    if (layered) {
      levelHtml = '<div class="level-caption">高程</div>' +
        '<div class="level-switch">' + md.layers.map(function (l) {
        return '<button type="button" class="level-btn' + (project.mapLevel === l.id ? ' active' : '') + '" data-level="' + U.esc(l.id) + '" title="' + U.esc(l.name) + '">' + U.esc(String(l.name || '').split('·')[0].trim()) + '</button>';
      }).join('') + '</div>';
    }

    var counts = layerCounts();
    /* 底图 / 据点计数也按当前高程过滤：星墓高原 13 个热区都在二层，地面层应显示 0 */
    var baseCount = (md.objectives || []).filter(function (o) {
      return !layered || !o.level || o.level === project.mapLevel;
    }).length + (md.spawns || []).filter(function (s) {
      return !layered || !s.level || s.level === project.mapLevel;
    }).length;
    var rows = [
      { id: 'base', name: '底图 / 目标', color: '#3a4556', count: baseCount },
      { id: 'zones', name: '区域', color: '#b05a55', count: counts.zones, clear: true },
      { id: 'routes', name: '路线', color: '#d8b26a', count: counts.routes, clear: true },
      { id: 'markers', name: '标记（队伍）', color: '#c9a55a', count: counts.markers },
      { id: 'personal', name: '└ 个人标记', color: '#7EC8E3', count: counts.personal, sub: true },
      { id: 'notes', name: '标注', color: '#d9d3c4', count: counts.notes, clear: true }
    ];
    /* 霍纳奇斯山脉：地形语义层单独开关（水域可游泳 / 冰湖可行走 / 雪地 / 高度示意图 / 实际点位 / 风场点位） */
    if (md.mode === 'domination') {
      var gy = md.geometry || {};
      rows.splice(1, 0,
        { id: 'water', name: '水域 · 可游泳', color: '#5aa0d8', count: ((gy.water && gy.water.rings) || 0) + ' 块', sub: true },
        { id: 'ice', name: '冰湖 · 可行走', color: '#2a4f86', count: ((gy.ice && gy.ice.rings) || 0) + ' 块', sub: true },
        { id: 'snow', name: '雪地 · 可行走', color: '#c2ccd8', count: ((gy.snow && gy.snow.rings) || 0) + ' 块', sub: true },
        { id: 'road', name: '道路 / 滩地', color: '#cbb987', count: '矢量', sub: true },
        { id: 'cliff', name: '崖壁 / 悬崖', color: '#a86a24', count: '矢量', sub: true },
        { id: 'height', name: '高度图（示意）', color: '#c3b78a', count: ((gy.heightBands && gy.heightBands.length) || 0) + ' 层', sub: true },
        { id: 'points', name: '实际点位', color: '#d9a441', count: (md.points || []).length + ' 点', sub: true },
        { id: 'winds', name: '风场点位（风道）', color: '#79d0e6', count: (md.winds || []).length + ' 条', sub: true }
      );
    }

    /* 猎龙之城：原图模式下多一行「重绘线稿叠加」，用于手动把矢量线稿叠回照片 */
    if (md.mode === 'siege-capture' && GM.photo && GM.photo.active()) {
      rows.splice(1, 0, { id: 'redraw', name: '重绘线稿叠加', color: '#6d5a34', count: '矢量', sub: true });
    }

    /* 俱乐部宣战：矢量地形 / 特殊点位 / 屏障三行独立开关 */
    if (md.mode === 'club-war') {
      rows.splice(1, 0,
        { id: 'redraw', name: '地形 / 道路（矢量重绘）', color: '#6b5a3f', count: '矢量', sub: true },
        { id: 'points', name: '特殊点位（雕像 / 传送 / 大旗）', color: '#d24b42', count: (md.objectives || []).length + ' 点', sub: true },
        { id: 'barriers', name: '屏障（蓝线 · 不可通行）', color: '#49b6ff', count: (md.barriers || []).length + ' 段', sub: true }
      );
    }

    var pinRows = [
      { id: 'alliance', name: '联盟标识框' },
      { id: 'team', name: '团队标识框' },
      { id: 'squad', name: '小队标识框' },
      { id: 'person', name: '个人标识框' }
    ];
    var pinned = (project.labels && project.labels.pinned) || {};
    var pinHtml = '<div class="layer-pin-title">标识框显示</div>' + pinRows.map(function (row) {
      var fixed = typeof pinned[row.id] === 'boolean' ? pinned[row.id] : (row.id !== 'person');
      return '<div class="layer-row layer-pin-row">' +
        '<span class="layer-name">' + row.name + '</span>' +
        '<span class="layer-count">' + (fixed ? '固定显示' : '仅选中时') + '</span>' +
        '<button type="button" class="layer-toggle' + (fixed ? ' on' : '') + '" data-label-pin="' + row.id + '" title="固定显示 / 仅选中时显示（选中后显示并参与避让与引线）"></button>' +
        '</div>';
    }).join('');

    host.innerHTML = levelHtml + rows.map(function (row) {
      /* 原图模式下矢量层按「原图默认隐藏 + 手动叠加」取有效显隐，其余仍读工程图层开关 */
      var on = GM.photo ? GM.photo.vectorOn(row.id) : project.layers[row.id] !== false;
      return '<div class="layer-row' + (row.sub ? ' layer-sub' : '') + '">' +
        '<span class="layer-swatch" style="background:' + row.color + '"></span>' +
        '<span class="layer-name">' + row.name + '</span>' +
        '<span class="layer-count">' + row.count + '</span>' +
        (row.clear ? '<button type="button" class="layer-clear" data-layer-clear="' + row.id + '" title="清除该层当前地图层级的对象">清空</button>' : '') +
        '<button type="button" class="layer-toggle' + (on ? ' on' : '') + '" data-layer-toggle="' + row.id + '" title="显示 / 隐藏"></button>' +
        '</div>';
    }).join('') +
      pinHtml +
      '<div class="layer-note">标识框：固定显示时始终绘制；仅选中时只在该标记选中后显示，并参与避让与引线。</div>' +
      '<div class="layer-note">' + (layered
        ? '当前为双层地图：默认显示二层（台上），地面层（台下镂空）需手动切换；两层各自保存标记与绘图对象，切层后只显示、只响应本层对象。'
        : '单层地图。图层显隐与清空操作仅作用于当前地图层级。') +
      '</div>';
  }

  function clearLayer(layerId) {
    var project = GM.state.project;
    var md = GM.currentMap();
    var level = project.mapLevel;
    var layered = md.layers && md.layers.length > 1;
    var phase = GM.activePhase();
    if (!phase) return;

    var targets = phase.shapes.filter(function (s) {
      return s.layer === layerId && (!layered || s.mapLayer === level);
    });

    if (!targets.length) {
      toast('该图层当前没有可清除的对象', 'error');
      return;
    }

    confirmDialog('清除图层', '确定清除当前层级的 ' + targets.length + ' 个对象？此操作可撤销。', '清除').then(function (ok) {
      if (!ok) return;
      var ids = {};
      targets.forEach(function (s) { ids[s.id] = true; });
      phase.shapes = phase.shapes.filter(function (s) { return !ids[s.id]; });
      if (GM.state.ui.selected && ids[GM.state.ui.selected.id]) GM.state.ui.selected = null;
      GM.commit('清除图层');
      GM.bus.emit('selection');
    });
  }

  function bindLayers() {
    var host = q('#layersPanel');
    if (!host) return;

    host.addEventListener('click', function (e) {
      var levelBtn = e.target.closest('[data-level]');
      if (levelBtn) {
        var level = levelBtn.getAttribute('data-level');
        if (GM.state.project.mapLevel === level) return;
        GM.state.project.mapLevel = level;
        /* 手动切层后标记为已选择，归一化不再把高程改回默认二层 */
        GM.state.project.starLevelDefaulted = true;
        GM.state.ui.selected = null;
        GM.refresh('切换地图层级');
        GM.bus.emit('selection');
        return;
      }

      var toggle = e.target.closest('[data-layer-toggle]');
      if (toggle) {
        var id = toggle.getAttribute('data-layer-toggle');
        /* 原图模式下的矢量层：只在内存里叠回 / 收起，不写工程、不进撤销栈 */
        if (GM.photo && GM.photo.active() && GM.photo.vectorLayer(id)) {
          GM.photo.toggleVector(id);
          if (GM.board) GM.board.render();
          renderAll();
          return;
        }
        GM.state.project.layers[id] = GM.state.project.layers[id] === false;
        GM.refresh('切换图层可见性');
        return;
      }

      var pinToggle = e.target.closest('[data-label-pin]');
      if (pinToggle) {
        var kind = pinToggle.getAttribute('data-label-pin');
        var project = GM.state.project;
        if (!project.labels || !project.labels.pinned) {
          project.labels = { pinned: {} };
        }
        var pinned = project.labels.pinned;
        var fixed = typeof pinned[kind] === 'boolean' ? pinned[kind] : (kind !== 'person');
        pinned[kind] = !fixed;
        GM.refresh('切换标识框显示');
        return;
      }

      var clearBtn = e.target.closest('[data-layer-clear]');
      if (clearBtn) {
        clearLayer(clearBtn.getAttribute('data-layer-clear'));
      }
    });
  }

  /* ============================ 属性检查器 ============================ */

  function field(label, inner, hint) {
    return '<div class="field"><label>' + U.esc(label) + '</label>' + inner +
      (hint ? '<div class="field-hint">' + U.esc(hint) + '</div>' : '') + '</div>';
  }

  function kindLabel(kind) {
    return U.teamKindInit(kind).label;
  }

  function renderInspector() {
    var host = q('#inspector');
    var kindTag = q('#inspectorKind');
    if (!host) return;

    var sel = GM.state.ui.selected;
    if (!sel) {
      if (kindTag) kindTag.textContent = '未选择';
      /* 未选中时右栏由「地图态势」承接，检查器本身清空 */
      host.innerHTML = '';
      return;
    }

    var project = GM.state.project;

    if (sel.type === 'team') {
      var node = GM.findTeam(sel.id);
      if (!node) { GM.clearSelection(); return; }
      if (kindTag) kindTag.textContent = kindLabel(node.kind);
      var count = GM.teamCount(node);
      var capacity = GM.teamCapacity(node);
      var path = GM.teamPath(node.id);
      var parent = path.length > 1 ? path[path.length - 2] : null;
      var childLabel = node.kind === 'alliance' ? '新建团队' : (node.kind === 'team' ? '新建小队' : '添加成员');

      host.innerHTML = '' +
        '<div class="insp-title"><span>' + U.esc(node.name) + '</span><span class="tag">' + kindLabel(node.kind) + '</span></div>' +
        field('名称', '<input type="text" data-field="team-name" value="' + U.esc(node.name) + '" maxlength="40">') +
        '<div class="field-pair">' +
          field('所属势力', '<select data-field="team-faction">' + project.factions.map(function (f) {
            return '<option value="' + U.esc(f.id) + '"' + (f.id === node.factionId ? ' selected' : '') + '>' + U.esc(f.name) + '</option>';
          }).join('') + '</select>') +
          field('代表色', '<input type="color" data-field="team-color" value="' + U.esc(GM.teamColor(node)) + '">') +
        '</div>' +
        field('备注', '<textarea data-field="team-note" maxlength="300" placeholder="战术定位、职责、注意事项…">' + U.esc(node.note || '') + '</textarea>') +
        '<div class="map-line"><span>编制人数</span><b>' + count + ' / ' + capacity + ' 人</b></div>' +
        '<div class="map-line"><span>上级</span><b>' + U.esc(parent ? parent.name : '（顶层）') + '</b></div>' +
        '<div class="insp-actions">' +
          '<button type="button" class="btn mini" data-action="team-add-child">＋ ' + childLabel + '</button>' +
          '<button type="button" class="btn mini" data-action="team-color-reset">跟随势力色</button>' +
          '<button type="button" class="btn mini danger" data-action="team-delete">删除</button>' +
        '</div>' +
        '<div class="insp-note">把该队伍行拖到沙盘可生成标记；联盟 / 团队 / 小队均可下钻编辑。</div>';
      return;
    }

    if (sel.type === 'member') {
      var foundMember = GM.findMember(sel.id);
      if (!foundMember) { GM.clearSelection(); return; }
      var member = foundMember.member;
      var squad = foundMember.squad;
      var squadLabel = squad ? squad.name : '候补池（不占编制）';
      if (kindTag) kindTag.textContent = '成员';

      var classSelect = project.classes.map(function (c) {
        return '<option value="' + U.esc(c.id) + '"' + (c.id === member.classId ? ' selected' : '') + '>' + U.esc(c.name) + '</option>';
      }).join('');
      var cls = U.classById(member.classId);
      var skillHtml = '';
      for (var i = 0; i < (window.GM_DATA.skillSlotCount || 4); i++) {
        var suggest = cls && cls.skills && cls.skills[i] ? '（' + cls.skills[i] + '）' : '';
        skillHtml += '<div class="skill-item"><span class="skill-slot">' + (i + 1) + '</span>' +
          '<input type="text" data-field="member-skill" data-skill-index="' + i + '" value="' + U.esc(member.skills[i] || '') + '" maxlength="20" placeholder="携带技能' + U.esc(suggest) + '"></div>';
      }

      host.innerHTML = '' +
        '<div class="insp-title"><span>' + U.esc(member.name) + '</span><span class="tag">成员</span></div>' +
        field('名称 / 编号', '<input type="text" data-field="member-name" value="' + U.esc(member.name) + '" maxlength="40">') +
        field('职业（形态）', '<select data-field="member-class">' + classSelect + '</select>', '职业决定编队色块与沙盘标记的配色') +
        '<div class="field-pair">' +
          field('序列', '<input type="text" data-field="member-sequence" value="' + U.esc(member.sequence || '') + '" maxlength="8" placeholder="如 9 / 5 / 0">') +
          field('等级', '<input type="text" data-field="member-level" value="' + U.esc(member.level || '') + '" maxlength="8" placeholder="如 1 / 60">') +
        '</div>' +
        '<div class="field"><label>携带技能（可留空）</label><div class="skill-list">' + skillHtml + '</div></div>' +
        field('备注', '<textarea data-field="member-note" maxlength="200" placeholder="个人职责、装备、注意事项…">' + U.esc(member.note || '') + '</textarea>') +
        '<div class="map-line"><span>所属小队</span><b>' + U.esc(squadLabel) + '</b></div>' +
        '<div class="insp-actions">' +
          '<button type="button" class="btn mini" data-action="member-select-squad">选中所属小队</button>' +
          '<button type="button" class="btn mini danger" data-action="member-delete">删除成员</button>' +
        '</div>' +
        '<div class="insp-note">拖动成员行到其他小队可直接换组；小队上限 6 人。</div>';
      return;
    }

    if (sel.type === 'marker') {
      var phase = GM.activePhase();
      var marker = null;
      if (phase) {
        for (var mi = 0; mi < phase.markers.length; mi++) {
          if (phase.markers[mi].id === sel.id) { marker = phase.markers[mi]; break; }
        }
      }
      if (!marker) { GM.clearSelection(); return; }
      if (kindTag) kindTag.textContent = '标记';

      /* 第二类标记工具（图标型）：只有名称 / 颜色 / 朝向 / 坐标 / 备注，无状态与人数 */
      if (marker.iconType) {
        var iconDef = null;
        (window.GM_DATA.iconMarkers || []).forEach(function (d) { if (d.id === marker.iconType) iconDef = d; });
        var iconName = marker.iconName || (iconDef && iconDef.name) || '标记';
        var iconColor = /^#[0-9a-f]{6}$/i.test(String(marker.iconColor || ''))
          ? marker.iconColor
          : ((iconDef && iconDef.color) || '#c9a55a');
        var iconRot = GM.normAngle(marker.rot, 0);
        if (kindTag) kindTag.textContent = '图标标记';
        host.innerHTML = '' +
          '<div class="insp-title"><span>' + U.esc(iconName) + '</span><span class="tag">图标标记</span></div>' +
          field('名称', '<input type="text" data-field="marker-icon-name" value="' + U.esc(iconName) + '" maxlength="20">') +
          field('颜色', '<input type="color" data-field="marker-icon-color" value="' + U.esc(iconColor) + '">') +
          field('朝向（旋转）', '<div class="range-row"><input type="range" min="0" max="360" step="1" data-field="marker-rot" value="' + iconRot + '">' +
            '<input type="number" min="0" max="360" step="1" data-field="marker-rot-num" value="' + iconRot + '"></div>',
            marker.iconType === 'defense' || marker.iconType === 'forbid' || marker.iconType === 'rallyFlag' ? '图标本身无方向，旋转只影响标签避让' : '') +
          '<div class="field-pair">' +
            field('坐标 X', '<input type="number" data-field="marker-x" value="' + Math.round(marker.x) + '" step="1">') +
            field('坐标 Y', '<input type="number" data-field="marker-y" value="' + Math.round(marker.y) + '" step="1">') +
          '</div>' +
          field('备注', '<textarea data-field="marker-note" maxlength="160" placeholder="该图标在此位置的战术含义…">' + U.esc(marker.note || '') + '</textarea>') +
          '<div class="insp-actions"><button type="button" class="btn mini danger" data-action="marker-delete">删除标记</button></div>' +
          '<div class="insp-note">图标标记只作图元：可拖动、选中、删除，不参与推演与编成。</div>';
        return;
      }

      var team = GM.findTeam(marker.teamId);
      var ref = marker.ref || null;

      var titleName = team ? team.name : (ref ? ref.name : '队伍已删除');
      var titleTag = team ? kindLabel(team.kind) : (ref ? (ref.type === 'person' ? '个人' : kindLabel(ref.kind)) : '标记');
      var count = GM.markerCount(marker);
      var canRelink = GM.markerCanRelink(marker);
      var isPerson = !team && ref && ref.type === 'person';
      var fill = GM.markerFill(marker);
      var refLines = '';
      if (ref && ref.type === 'person') {
        refLines = '<div class="map-line"><span>职业形态</span><b>' + U.esc(ref.className || '—') + (ref.form ? ' · ' + U.esc(ref.form) : '') + '</b></div>' +
          '<div class="map-line"><span>携带技能</span><b>' + U.esc((ref.skills || []).filter(function (s) { return !!s; }).join(' / ') || '—') + '</b></div>';
      }
      var refSource = '';
      if (ref && ref.presetId) {
        var srcPreset = GM.findPreset(ref.presetId);
        refSource = '<div class="map-line"><span>来源编成</span><b>' + U.esc(srcPreset ? srcPreset.name : (ref.presetName || '（预设已删除）')) + '</b></div>';
      }

      var statusOpts = window.GM_DATA.statuses.map(function (s) {
        return '<option value="' + U.esc(s.id) + '"' + (s.id === marker.status ? ' selected' : '') + '>' + U.esc(s.name) + '</option>';
      }).join('');
      var relationId = GM.normRelation(marker.relation);
      var relationOpts = window.GM_DATA.relations.map(function (r) {
        return '<option value="' + U.esc(r.id) + '"' + (r.id === relationId ? ' selected' : '') + '>' + U.esc(r.name) + '</option>';
      }).join('');
      var rotVal = GM.normAngle(marker.rot, 0);

      /* 填充色：三级标记可自定义（色值 + 快捷色板）；个人标记只读，始终职业色 */
      var fillField;
      if (isPerson) {
        fillField = '<div class="field"><label>填充色</label><div class="insp-static">职业色 · ' +
          U.esc(ref.className || '未知职业') + '（个人标记不可改色）</div></div>';
      } else {
        var swatchColors = ['#ffffff', '#c9a55a', '#cf4f45', '#d9a63c', '#4a86d8', '#46a86b'];
        var fillSafe = /^#[0-9a-f]{6}$/i.test(String(fill)) ? fill : '#ffffff';
        fillField = field('填充色',
          '<div class="insp-fill-row"><input type="color" data-field="marker-fill" value="' + U.esc(fillSafe) + '">' +
          '<span class="field-hint">与敌我关系无关</span></div>' +
          '<div class="insp-swatches">' + swatchColors.map(function (c) {
            return '<button type="button" class="insp-swatch" data-fill-swatch="' + c + '" title="' + c + '" style="background:' + c + '"></button>';
          }).join('') + '</div>');
      }

      var countHint = marker.countLink
        ? '随编成实时更新；手动修改后转为固定值'
        : (canRelink ? '当前为手动值，可重新链接编成' : '工具栏新建的标记，可手动填写');
      var countField = isPerson ? '' : field('人数',
        '<div class="range-row"><input type="number" min="0" max="150" step="1" data-field="marker-count" value="' + count + '">' +
        '<span class="tag">' + (marker.countLink ? '链接编成' : '手动值') + '</span></div>', countHint);

      /* 个人标记（一级）：名称与职业都可改；职业色由 classId 推导，改职业即换填充色 */
      var personFields = '';
      if (isPerson) {
        var personClassOpts = project.classes.map(function (c) {
          return '<option value="' + U.esc(c.id) + '"' + (c.id === ref.classId ? ' selected' : '') + '>' + U.esc(c.name) + '</option>';
        }).join('');
        personFields = field('名称', '<input type="text" data-field="marker-person-name" value="' + U.esc(ref.name || '') + '" maxlength="20">') +
          field('职业', '<select data-field="marker-person-class">' + personClassOpts + '</select>', '个人标记始终使用职业色，不可自定义填充色');
      }

      host.innerHTML = '' +
        '<div class="insp-title"><span>' + U.esc(titleName) + '</span><span class="tag">' + U.esc(titleTag) + '</span></div>' +
        personFields +
        field('状态（外圈）', '<select data-field="marker-status">' + statusOpts + '</select>') +
        field('敌我关系', '<select data-field="marker-relation">' + relationOpts + '</select>') +
        fillField +
        countField +
        field('朝向（旋转）', '<div class="range-row"><input type="range" min="0" max="360" step="1" data-field="marker-rot" value="' + rotVal + '">' +
          '<input type="number" min="0" max="360" step="1" data-field="marker-rot-num" value="' + rotVal + '"></div>') +
        '<div class="field-pair">' +
          field('坐标 X', '<input type="number" data-field="marker-x" value="' + Math.round(marker.x) + '" step="1">') +
          field('坐标 Y', '<input type="number" data-field="marker-y" value="' + Math.round(marker.y) + '" step="1">') +
        '</div>' +
        field('备注', '<textarea data-field="marker-note" maxlength="160" placeholder="该队在此位置的战术任务…">' + U.esc(marker.note || '') + '</textarea>') +
        refLines +
        refSource +
        (GM.currentMap().layers && GM.currentMap().layers.length > 1 ? '<div class="map-line"><span>地图层级</span><b>' + (marker.mapLayer === 'upper' ? '二层' : '地面层') + '</b></div>' : '') +
        '<div class="insp-actions">' +
          (canRelink ? '<button type="button" class="btn mini" data-action="marker-relink">重新链接编成</button>' : '') +
          (team ? '<button type="button" class="btn mini" data-action="marker-select-team">选中队伍</button>' : '') +
          '<button type="button" class="btn mini danger" data-action="marker-delete">删除标记</button>' +
        '</div>' +
        '<div class="insp-note">直接拖动标记可调整位置；吸附网格开启时会自动对齐。标识框第二行' +
          (isPerson ? '固定显示「敌我 / 状态」。' : '固定显示「敌我 / 人数 / 状态」。') + '</div>';
      return;
    }

    if (sel.type === 'objective') {
      /* 星墓高原中央占领圈：只读属性（圆心 / 半径），不可删除 */
      var omd = GM.currentMap();
      var obj = null;
      (omd && omd.objectives ? omd.objectives : []).forEach(function (o) { if (o.id === sel.id) obj = o; });
      if (!obj || obj.type !== 'capture-circle') { GM.clearSelection(); return; }
      var pt = GM.captureCirclePoint(omd, GM.activePlan());
      var cr = obj.captureRadius || 7;
      if (kindTag) kindTag.textContent = '地图对象';
      host.innerHTML = '' +
        '<div class="insp-title"><span>' + U.esc(obj.name) + '</span><span class="tag">中立单位</span></div>' +
        '<div class="map-line"><span>圆心 X</span><b>' + Math.round(pt.x * 100) / 100 + ' unit</b></div>' +
        '<div class="map-line"><span>圆心 Y</span><b>' + Math.round(pt.y * 100) / 100 + ' unit</b></div>' +
        '<div class="map-line"><span>判定半径</span><b>' + cr + ' unit</b></div>' +
        '<div class="map-line"><span>地图层级</span><b>' + (obj.level === 'ground' ? '地面层' : '二层') + '</b></div>' +
        '<div class="insp-note">画面上只画判定圆（半径 ' + cr + ' unit），拖动起手也按同一半径。判定圆用于统计圈内人数与归属。该对象为中立单位，不可删除。</div>';
      return;
    }

    if (sel.type === 'shape') {
      var phase2 = GM.activePhase();
      var shape = null;
      if (phase2) {
        for (var si = 0; si < phase2.shapes.length; si++) {
          if (phase2.shapes[si].id === sel.id) { shape = phase2.shapes[si]; break; }
        }
      }
      if (!shape) { GM.clearSelection(); return; }
      if (kindTag) kindTag.textContent = SHAPE_LABELS[shape.kind] || '绘图';
      /* 技能范围：预设 / 形态 / 范围参数 / 颜色 / 线种；1 米 = 1 unit，不跟地图像素比例 */
      if (shape.kind === 'skill') {
        var presetId = ['yuxin', 'dagou', 'zuxian'].indexOf(shape.preset) > -1 ? shape.preset : 'custom';
        var presetOpts = '<option value="custom"' + (presetId === 'custom' ? ' selected' : '') + '>自定义</option>' +
          (window.GM_DATA.skillPresets || []).map(function (p) {
            return '<option value="' + U.esc(p.id) + '"' + (p.id === presetId ? ' selected' : '') + '>' + U.esc(p.name) + '</option>';
          }).join('');
        var shapeType = (shape.shapeType === 'sector' || shape.shapeType === 'rect') ? shape.shapeType : 'circle';
        var shapeOpts = [['sector', '扇形'], ['circle', '圆形'], ['rect', '矩形']].map(function (pair) {
          return '<option value="' + pair[0] + '"' + (pair[0] === shapeType ? ' selected' : '') + '>' + pair[1] + '</option>';
        }).join('');
        var sr = Math.round((shape.r || 25) * 10) / 10;
        var paramFields;
        if (shapeType === 'sector') {
          paramFields = '<div class="field-pair">' +
            field('半径（unit）', '<input type="number" min="1" max="800" step="0.5" data-field="skill-r" value="' + sr + '">') +
            field('角度（°）', '<input type="number" min="1" max="360" step="1" data-field="skill-span" value="' + Math.round(shape.span || 90) + '">') +
            '</div>';
        } else if (shapeType === 'rect') {
          paramFields = '<div class="field-pair">' +
            field('长（unit）', '<input type="number" min="1" max="800" step="0.5" data-field="skill-len" value="' + (Math.round((shape.len || 20) * 10) / 10) + '">') +
            field('宽（unit）', '<input type="number" min="0.2" max="800" step="0.1" data-field="skill-wid" value="' + (Math.round((shape.wid || 3) * 10) / 10) + '">') +
            '</div>';
        } else {
          paramFields = field('半径（unit）', '<input type="number" min="1" max="800" step="0.5" data-field="skill-r" value="' + sr + '">');
        }
        var skillColor = /^#[0-9a-f]{6}$/i.test(String(shape.color || '')) ? shape.color : '#79b6a0';
        var lineOpts = '<option value="dashed"' + (shape.dashed === false ? '' : ' selected') + '>虚线</option>' +
          '<option value="solid"' + (shape.dashed === false ? ' selected' : '') + '>实线</option>';
        host.innerHTML = '' +
          '<div class="insp-title"><span>技能范围</span><span class="tag">图元</span></div>' +
          field('预设技能', '<select data-field="skill-preset">' + presetOpts + '</select>', '套用预设会整体改写形态 / 尺寸 / 颜色 / 线种') +
          field('形态', '<select data-field="skill-shape">' + shapeOpts + '</select>', '切换形态会保留合理的尺寸参数') +
          paramFields +
          '<div class="field-pair">' +
            field('颜色', '<input type="color" data-field="skill-color" value="' + U.esc(skillColor) + '">') +
            field('线种', '<select data-field="skill-line">' + lineOpts + '</select>') +
          '</div>' +
          '<div class="insp-actions"><button type="button" class="btn mini danger" data-action="shape-delete">删除对象</button></div>' +
          '<div class="insp-note">1 米 = 1 unit，落图固定按世界单位，不跟各图像素比例换算。技能范围只作图元：可选中、拖动、删除，不参与推演结算。</div>';
        return;
      }

      var geom = '';
      var shapeTitle = SHAPE_LABELS[shape.kind] || '绘图对象';
      if (shape.kind === 'line') {
        var ldef = lineToolById(shape.lineType);
        shapeTitle = ((ldef && ldef.name) || '进攻') + '线';
        geom = '<div class="map-line"><span>路径点</span><b>' + shape.points.length + ' 个</b></div>' +
          '<div class="map-line"><span>线型</span><b>' + (shape.dashed ? '虚线' : '实线') + '</b></div>';
      } else if (shape.kind === 'route') {
        geom = '<div class="map-line"><span>路径点</span><b>' + shape.points.length + ' 个</b></div>';
      } else if (shape.kind === 'zoneRect') {
        geom = '<div class="map-line"><span>尺寸</span><b>' + Math.round(shape.w) + ' × ' + Math.round(shape.h) + '</b></div>';
      } else if (shape.kind === 'zoneCircle') {
        geom = '<div class="map-line"><span>半径</span><b>' + Math.round(shape.r) + '</b></div>';
      }
      if (kindTag) kindTag.textContent = shapeTitle;

      host.innerHTML = '' +
        '<div class="insp-title"><span>' + U.esc(shapeTitle) + '</span><span class="tag">' + U.esc(shape.layer) + '</span></div>' +
        (shape.kind === 'route' || shape.kind === 'note' || shape.kind === 'line'
          ? field('文字', shape.kind === 'note'
            ? '<textarea data-field="shape-text" maxlength="200">' + U.esc(shape.text || '') + '</textarea>'
            : '<input type="text" data-field="shape-text" value="' + U.esc(shape.text || '') + '" maxlength="60" placeholder="' + (shape.kind === 'line' ? '线条备注（可留空）' : '路线备注（可留空）') + '">')
          : field('标签文字', '<input type="text" data-field="shape-text" value="' + U.esc(shape.text || '') + '" maxlength="60" placeholder="区域 / 集结名称">')) +
        '<div class="field-pair">' +
          field('颜色', '<input type="color" data-field="shape-color" value="' + U.esc(shape.color || '#c9a55a') + '">') +
          field('线宽', '<input type="number" data-field="shape-width" min="1" max="12" step="1" value="' + (shape.width || 2) + '">') +
        '</div>' +
        geom +
        '<div class="insp-actions"><button type="button" class="btn mini danger" data-action="shape-delete">删除对象</button></div>' +
        '<div class="insp-note">绘图对象保存在当前阶段快照中，切换阶段可保留不同布置。</div>';
    }
  }

  function handleInspectorChange(e) {
    var el = e.target.closest('[data-field]');
    if (!el) return;
    var fieldName = el.getAttribute('data-field');
    var sel = GM.state.ui.selected;
    if (!sel) return;

    if (sel.type === 'team') {
      var node = GM.findTeam(sel.id);
      if (!node) return;
      if (fieldName === 'team-name') {
        var name = String(el.value || '').trim();
        node.name = name || node.name;
        GM.commit('编辑队伍');
      } else if (fieldName === 'team-faction') {
        node.factionId = el.value;
        GM.commit('编辑队伍势力');
      } else if (fieldName === 'team-color') {
        node.color = el.value;
        GM.commit('编辑队伍颜色');
      } else if (fieldName === 'team-note') {
        node.note = el.value;
        GM.commit('编辑队伍备注');
      }
      return;
    }

    if (sel.type === 'member') {
      var fm = GM.findMember(sel.id);
      if (!fm) return;
      var member = fm.member;
      if (fieldName === 'member-name') {
        var mname = String(el.value || '').trim();
        member.name = mname || member.name;
        GM.commit('编辑成员');
      } else if (fieldName === 'member-class') {
        member.classId = el.value;
        if (GM.teams && GM.teams.normalizeForm) member.form = GM.teams.normalizeForm(member.classId, member.form);
        GM.commit('切换成员职业');
      } else if (fieldName === 'member-sequence') {
        member.sequence = el.value;
        GM.commit('编辑成员序列');
      } else if (fieldName === 'member-level') {
        member.level = el.value;
        GM.commit('编辑成员等级');
      } else if (fieldName === 'member-skill') {
        var skillIndex = Number(el.getAttribute('data-skill-index'));
        member.skills[skillIndex] = el.value;
        GM.commit('编辑成员技能位');
      } else if (fieldName === 'member-note') {
        member.note = el.value;
        GM.commit('编辑成员备注');
      }
      return;
    }

    if (sel.type === 'marker') {
      var phase = GM.activePhase();
      var marker = null;
      if (phase) phase.markers.forEach(function (m) { if (m.id === sel.id) marker = m; });
      if (!marker) return;

      if (fieldName === 'marker-icon-name') {
        var iname = String(el.value || '').trim();
        if (iname) {
          marker.iconName = iname;
          GM.commit('编辑图标标记名称');
        }
      } else if (fieldName === 'marker-icon-color') {
        if (/^#[0-9a-f]{6}$/i.test(String(el.value || ''))) {
          marker.iconColor = String(el.value);
          GM.commit('修改图标标记颜色');
        }
      } else if (fieldName === 'marker-person-name') {
        var pname = String(el.value || '').trim();
        if (pname && marker.ref && marker.ref.type === 'person') {
          marker.ref.name = pname;
          GM.commit('编辑个人标记名称');
        }
      } else if (fieldName === 'marker-person-class') {
        if (marker.ref && marker.ref.type === 'person') {
          var cls = U.classById(el.value);
          if (cls && cls.id === el.value) {
            marker.ref.classId = String(cls.id);
            marker.ref.classColor = String(cls.color || '#8a919f');
            marker.ref.className = String(cls.name || '');
            if (GM.teams && GM.teams.normalizeForm) marker.ref.form = GM.teams.normalizeForm(marker.ref.classId, marker.ref.form);
            GM.commit('切换个人标记职业');
          }
        }
      } else if (fieldName === 'marker-status') {
        marker.status = el.value;
        GM.commit('修改标记状态');
      } else if (fieldName === 'marker-relation') {
        marker.relation = GM.normRelation(el.value);
        GM.commit('修改敌我关系');
      } else if (fieldName === 'marker-fill') {
        /* 个人标记的填充固定为职业色，忽略改色入口（渲染层也不读 fill） */
        if (!(marker.ref && marker.ref.type === 'person' && !marker.teamId)) {
          marker.fill = String(el.value || '#ffffff');
          GM.commit('修改标记填充色');
        }
      } else if (fieldName === 'marker-count') {
        marker.count = Math.max(0, Math.min(150, Math.round(Number(el.value) || 0)));
        marker.countLink = false;
        GM.commit('修改标记人数');
      } else if (fieldName === 'marker-rot' || fieldName === 'marker-rot-num') {
        marker.rot = GM.normAngle(el.value, marker.rot);
        GM.commit('旋转标记');
      } else if (fieldName === 'marker-x') {
        marker.x = Math.round(U.clamp(Number(el.value) || 0, 0, 1600));
        GM.commit('调整标记坐标');
      } else if (fieldName === 'marker-y') {
        marker.y = Math.round(U.clamp(Number(el.value) || 0, 0, 1000));
        GM.commit('调整标记坐标');
      } else if (fieldName === 'marker-note') {
        marker.note = el.value;
        GM.commit('编辑标记备注');
      }
      return;
    }

    if (sel.type === 'shape') {
      var phase2 = GM.activePhase();
      var shape = null;
      if (phase2) phase2.shapes.forEach(function (s) { if (s.id === sel.id) shape = s; });
      if (!shape) return;

      if (fieldName === 'skill-preset') {
        var preset = skillPresetById(el.value);
        if (preset) {
          shape.preset = preset.id;
          shape.shapeType = preset.shapeType;
          if (preset.r != null) shape.r = preset.r;
          if (preset.len != null) shape.len = preset.len;
          if (preset.wid != null) shape.wid = preset.wid;
          shape.color = preset.color;
          shape.dashed = !!preset.dashed;
          GM.commit('套用技能预设');
        } else {
          shape.preset = 'custom';
          GM.commit('技能范围切换为自定义');
        }
      } else if (fieldName === 'skill-shape') {
        var nextShape = (el.value === 'sector' || el.value === 'rect') ? el.value : 'circle';
        if (nextShape !== shape.shapeType) {
          var prevShape = shape.shapeType;
          if (nextShape === 'rect') {
            /* 圆形 / 扇形 → 矩形：直径作为长，宽度沿用或默认 3 unit */
            var prevR = Math.max(1, Number(shape.r) || 25);
            shape.len = Math.round((prevShape === 'rect' ? (shape.len || prevR * 2) : prevR * 2) * 10) / 10;
            shape.wid = Math.round(Math.max(0.2, Number(shape.wid) || 3) * 10) / 10;
          } else {
            /* 矩形 → 圆形 / 扇形：半长作为半径；扇形保留原张角或默认 90° */
            var baseLen = Math.max(1, Number(shape.len) || 20);
            shape.r = Math.round((prevShape === 'rect' ? baseLen / 2 : Math.max(1, Number(shape.r) || 25)) * 10) / 10;
            if (nextShape === 'sector') shape.span = Math.max(1, Math.min(360, Number(shape.span) || 90));
          }
          shape.shapeType = nextShape;
          shape.preset = 'custom';
          GM.commit('切换技能形态');
        }
      } else if (fieldName === 'skill-r') {
        shape.r = U.clamp(Number(el.value) || 1, 1, 800);
        shape.preset = 'custom';
        GM.commit('修改技能范围半径');
      } else if (fieldName === 'skill-span') {
        shape.span = U.clamp(Number(el.value) || 90, 1, 360);
        shape.preset = 'custom';
        GM.commit('修改技能扇形角度');
      } else if (fieldName === 'skill-len') {
        shape.len = U.clamp(Number(el.value) || 1, 1, 800);
        shape.preset = 'custom';
        GM.commit('修改技能范围长度');
      } else if (fieldName === 'skill-wid') {
        shape.wid = U.clamp(Number(el.value) || 0.2, 0.2, 800);
        shape.preset = 'custom';
        GM.commit('修改技能范围宽度');
      } else if (fieldName === 'skill-color') {
        if (/^#[0-9a-f]{6}$/i.test(String(el.value || ''))) {
          shape.color = String(el.value);
          shape.preset = 'custom';
          GM.commit('修改技能范围颜色');
        }
      } else if (fieldName === 'skill-line') {
        shape.dashed = el.value !== 'solid';
        shape.preset = 'custom';
        GM.commit('修改技能范围线种');
      } else if (fieldName === 'shape-text') {
        shape.text = el.value;
        GM.commit('编辑绘图文字');
      } else if (fieldName === 'shape-color') {
        shape.color = el.value;
        GM.commit('修改绘图颜色');
      } else if (fieldName === 'shape-width') {
        shape.width = U.clamp(Number(el.value) || 2, 1, 12);
        GM.commit('修改绘图线宽');
      }
    }
  }

  function bindInspector() {
    var host = q('#inspector');
    if (!host) return;

    host.addEventListener('change', handleInspectorChange);

    host.addEventListener('input', function (e) {
      var rot = e.target.closest('[data-field="marker-rot"]');
      if (rot) {
        var num = host.querySelector('[data-field="marker-rot-num"]');
        if (num) num.value = rot.value;
      }
    });

    host.addEventListener('click', function (e) {
      /* 快捷色板：单击直接改填充色（一次操作一条撤销记录） */
      var swatch = e.target.closest('[data-fill-swatch]');
      if (swatch) {
        var selS = GM.state.ui.selected;
        if (!selS || selS.type !== 'marker') return;
        var phaseS = GM.activePhase();
        var markerS = null;
        if (phaseS) phaseS.markers.forEach(function (m) { if (m.id === selS.id) markerS = m; });
        if (!markerS || (markerS.ref && markerS.ref.type === 'person' && !markerS.teamId)) return;
        markerS.fill = swatch.getAttribute('data-fill-swatch') || '#ffffff';
        GM.commit('修改标记填充色');
        return;
      }

      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.getAttribute('data-action');
      var sel = GM.state.ui.selected;
      if (!sel) return;

      if (action === 'team-add-child') {
        var node = GM.findTeam(sel.id);
        if (node) GM.teams.addChild(node);
      } else if (action === 'team-color-reset') {
        var node2 = GM.findTeam(sel.id);
        if (node2) {
          node2.color = '';
          GM.commit('重置队伍颜色');
        }
      } else if (action === 'team-delete') {
        var node3 = GM.findTeam(sel.id);
        if (!node3) return;
        confirmDialog('删除队伍', '确定删除「' + node3.name + '」及其子队伍？相关沙盘标记会一并移除。', '删除').then(function (ok) {
          if (!ok) return;
          GM.deleteTeam(node3.id);
          GM.state.ui.selected = null;
          GM.commit('删除队伍');
          GM.bus.emit('selection');
          toast('已删除「' + node3.name + '」', 'success');
        });
      } else if (action === 'member-select-squad') {
        var fm = GM.findMember(sel.id);
        if (fm) GM.select('team', fm.squad.id);
      } else if (action === 'member-delete') {
        var fm2 = GM.findMember(sel.id);
        if (!fm2) return;
        confirmDialog('删除成员', '确定删除成员「' + fm2.member.name + '」？', '删除').then(function (ok) {
          if (!ok) return;
          GM.deleteMember(fm2.squad.id, fm2.member.id);
          GM.state.ui.selected = null;
          GM.commit('删除成员');
          GM.bus.emit('selection');
        });
      } else if (action === 'marker-delete') {
        GM.deleteMarker(sel.id);
        GM.state.ui.selected = null;
        GM.commit('删除标记');
        GM.bus.emit('selection');
      } else if (action === 'marker-relink') {
        var phaseR = GM.activePhase();
        var markerR = null;
        if (phaseR) phaseR.markers.forEach(function (m) { if (m.id === sel.id) markerR = m; });
        if (!markerR) return;
        markerR.countLink = true;
        markerR.count = GM.markerCount(markerR);
        GM.commit('重新链接编成人数');
        toast('人数已重新链接编成', 'success');
      } else if (action === 'marker-select-team') {
        var phase = GM.activePhase();
        var marker = null;
        if (phase) phase.markers.forEach(function (m) { if (m.id === sel.id) marker = m; });
        if (marker && GM.findTeam(marker.teamId)) GM.select('team', marker.teamId);
      } else if (action === 'shape-delete') {
        GM.deleteShape(sel.id);
        GM.state.ui.selected = null;
        GM.commit('删除绘图对象');
        GM.bus.emit('selection');
      }
    });
  }

  /* ============================ 删除 / 快捷键 ============================ */

  function deleteSelected() {
    var sel = GM.state.ui.selected;
    if (!sel) {
      toast('当前没有选中对象', 'error');
      return;
    }

    if (sel.type === 'objective') {
      toast('地图对象为中立单位，不可删除', 'error');
      return;
    }

    if (sel.type === 'marker') {
      GM.deleteMarker(sel.id);
      GM.state.ui.selected = null;
      GM.commit('删除标记');
      GM.bus.emit('selection');
      return;
    }
    if (sel.type === 'shape') {
      GM.deleteShape(sel.id);
      GM.state.ui.selected = null;
      GM.commit('删除绘图对象');
      GM.bus.emit('selection');
      return;
    }
    if (sel.type === 'member') {
      var fm = GM.findMember(sel.id);
      if (!fm) return;
      confirmDialog('删除成员', '确定删除成员「' + fm.member.name + '」？', '删除').then(function (ok) {
        if (!ok) return;
        GM.deleteMember(fm.squad.id, fm.member.id);
        GM.state.ui.selected = null;
        GM.commit('删除成员');
        GM.bus.emit('selection');
      });
      return;
    }
    if (sel.type === 'team') {
      var node = GM.findTeam(sel.id);
      if (!node) return;
      confirmDialog('删除队伍', '确定删除「' + node.name + '」及其子队伍？相关沙盘标记会一并移除。', '删除').then(function (ok) {
        if (!ok) return;
        GM.deleteTeam(node.id);
        GM.state.ui.selected = null;
        GM.commit('删除队伍');
        GM.bus.emit('selection');
      });
    }
  }

  function isEditableTarget(target) {
    if (!target) return false;
    var tag = target.tagName ? target.tagName.toLowerCase() : '';
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
  }

  function bindKeyboard() {
    document.addEventListener('keydown', function (e) {
      if (!q('#modalRoot').classList.contains('hidden')) return;
      if (GM.teams && GM.teams.isConfigOpen && GM.teams.isConfigOpen()) return;
      if (GM.analysis && GM.analysis.isOpen && GM.analysis.isOpen()) return;
      if (isEditableTarget(e.target)) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) GM.redo(); else GM.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        GM.redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        GM.storage.exportProject();
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelected();
        return;
      }
      if (e.key === 'Escape') {
        if (GM.draw) GM.draw.cancel();
        GM.clearSelection();
        return;
      }
      if (e.key === 'Enter' && GM.draw) {
        if (GM.draw.finishRoute() || GM.draw.finishLine()) e.preventDefault();
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        if (e.repeat) return;
        setTool(GM.state.ui.tool === 'hand' ? 'select' : 'hand');
        return;
      }

      var map = { v: 'select', h: 'hand', r: 'route', g: 'rallyFlag', b: 'zoneRect', c: 'zoneCircle', t: 'note' };
      var key = e.key.toLowerCase();
      if (map[key] && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setTool(map[key]);
      }
    });
  }

  /* ============================ 清除 / 导入导出 ============================ */

  function clearCurrentLevel() {
    var project = GM.state.project;
    var md = GM.currentMap();
    var phase = GM.activePhase();
    if (!phase) return;
    var layered = md.layers && md.layers.length > 1;
    var targets = phase.shapes.filter(function (s) { return !layered || s.mapLayer === project.mapLevel; });

    if (!targets.length) {
      toast('当前层级没有绘图对象可清除', 'error');
      return;
    }
    confirmDialog('清除本层绘图', '将清除当前地图层级的 ' + targets.length + ' 个绘图对象（区域 / 路线 / 标注），标记不会受影响。', '清除').then(function (ok) {
      if (!ok) return;
      var ids = {};
      targets.forEach(function (s) { ids[s.id] = true; });
      phase.shapes = phase.shapes.filter(function (s) { return !ids[s.id]; });
      if (GM.state.ui.selected && ids[GM.state.ui.selected.id]) GM.state.ui.selected = null;
      GM.commit('清除本层');
      GM.bus.emit('selection');
      toast('已清除当前层级的绘图对象', 'success');
    });
  }

  /* ============================ 初始化 ============================ */

  function populateMapSelect() {
    var select = q('#mapSelect');
    if (!select) return;
    select.innerHTML = window.GM_DATA.maps.map(function (md) {
      return '<option value="' + U.esc(md.id) + '">' + U.esc(md.name) + ' · ' + U.esc(md.modeLabel) + '</option>';
    }).join('');
    select.value = GM.state.project.mapId;
  }

  function renderAll() {
    syncTopFields();
    renderToolbar();
    renderMapMeta();
    renderSiege();
    renderModeStatus();
    renderLayers();
    renderInspector();
    updateRightPanel();
    updateHint();
    applySaveStatus(GM.state.ui.saveStatus === 'saved' ? 'saved' : GM.state.ui.saveStatus);
  }

  function bindTopbar() {
    var nameInput = q('#projectName');
    nameInput.addEventListener('change', function () {
      var name = String(nameInput.value || '').trim();
      GM.state.project.name = name || '未命名战役';
      nameInput.value = GM.state.project.name;
      GM.commit('重命名工程');
    });

    q('#mapSelect').addEventListener('change', function (e) {
      switchMap(e.target.value);
    });

    q('#btnExport').addEventListener('click', function () {
      GM.storage.exportProject();
    });

    q('#btnImport').addEventListener('click', function () {
      q('#importFile').click();
    });

    q('#importFile').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      GM.storage.importProject(file, function (err, parsed) {
        e.target.value = '';
        if (err) {
          toast('导入失败：文件不是有效的战术板 JSON', 'error');
          return;
        }
        populateMapSelect();
        GM.board.fitView();
        GM.state.ui.diff = false;
        GM.state.ui.selected = null;
        GM.plans.stopPlayback();
        renderAll();
        GM.bus.emit('selection');
        toast('已导入工程「' + (parsed && parsed.name ? parsed.name : '未命名') + '」', 'success');
      });
    });

  }

  /* ⓘ 说明按钮：浮层挂在 body 上（position: fixed），不会被面板 overflow 裁掉；
     悬停 / 点击 / 键盘焦点都显示，Esc 或移出隐藏。 */
  function bindInfoTips() {
    var triggers = qa('[data-info-tip]');
    if (!triggers.length) return;

    var tip = document.createElement('div');
    tip.className = 'info-tip hidden';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
    var active = null;

    function place(el) {
      var r = el.getBoundingClientRect();
      tip.classList.remove('hidden');
      var w = tip.offsetWidth;
      var h = tip.offsetHeight;
      var left = U.clamp(r.left - 6, 8, Math.max(8, window.innerWidth - w - 8));
      var top = r.bottom + 8;
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    }

    function show(el) {
      active = el;
      tip.textContent = el.getAttribute('data-info-tip') || '';
      el.setAttribute('aria-expanded', 'true');
      place(el);
    }

    function hide() {
      active = null;
      tip.classList.add('hidden');
      triggers.forEach(function (el) { el.setAttribute('aria-expanded', 'false'); });
    }

    triggers.forEach(function (el) {
      el.setAttribute('aria-expanded', 'false');
      el.addEventListener('mouseenter', function () { show(el); });
      el.addEventListener('mouseleave', hide);
      el.addEventListener('focus', function () { show(el); });
      el.addEventListener('blur', hide);
      el.addEventListener('click', function (e) {
        e.preventDefault();
        if (active === el) hide();
        else show(el);
      });
    });

    window.addEventListener('resize', function () { if (active) place(active); });
    window.addEventListener('scroll', function () { if (active) place(active); }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && active) hide();
    });
  }

  function bindToolbar() {
    q('#toolButtons').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-tool]');
      if (!btn) return;
      setTool(btn.getAttribute('data-tool'));
    });
    /* Photoshop 式工具组：右键画线按钮弹出四个画线工具，左键仍使用当前工具 */
    q('#toolButtons').addEventListener('contextmenu', function (e) {
      var btn = e.target.closest('#btnLineGroup');
      if (!btn) return;
      e.preventDefault();
      openLineToolMenu(btn);
    });
    document.addEventListener('pointerdown', function (e) {
      if (e.target.closest && e.target.closest('#lineToolFlyout')) return;
      closeLineToolMenu();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeLineToolMenu();
    });

    q('#btnSnap').addEventListener('click', function () {
      GM.state.project.grid.enabled = !GM.state.project.grid.enabled;
      GM.commit('切换吸附网格');
      toast('吸附网格已' + (GM.state.project.grid.enabled ? '开启' : '关闭'), 'success');
    });

    q('#btnUndo').addEventListener('click', function () {
      if (!GM.undo()) toast('没有可撤销的操作', 'error');
      GM.bus.emit('selection');
    });

    q('#btnRedo').addEventListener('click', function () {
      if (!GM.redo()) toast('没有可重做的操作', 'error');
      GM.bus.emit('selection');
    });

    q('#btnClear').addEventListener('click', clearCurrentLevel);
    q('#btnDelete').addEventListener('click', deleteSelected);

    /* 「技能 / 团队」二级选项：级别、敌方颜色、技能范围形状 */
    var kindSel = q('#teamToolKind');
    var colorSel = q('#teamToolColor');
    if (kindSel) {
      kindSel.innerHTML = [['alliance', '联盟'], ['team', '团队'], ['squad', '小队'], ['person', '个人']].map(function (pair) {
        return '<option value="' + pair[0] + '">' + pair[1] + '</option>';
      }).join('');
      kindSel.addEventListener('change', function () {
        GM.state.ui.teamTool.kind = kindSel.value;
        syncToolPanels();
      });
    }
    if (colorSel) {
      colorSel.innerHTML = (window.GM_DATA.enemyRelations || []).map(function (id) {
        var rel = GM.relationById(id);
        return '<option value="' + U.esc(rel.id) + '">' + U.esc(rel.name) + '</option>';
      }).join('');
      colorSel.addEventListener('change', function () {
        GM.state.ui.teamTool.relation = GM.normRelation(colorSel.value);
      });
    }
    /* 团队工具落点前的人数：只刷新 UI 状态，落点时写入标记，不链接编成 */
    var teamCount = q('#teamToolCount');
    if (teamCount) {
      var syncTeamCount = function () {
        var n = Math.max(0, Math.min(150, Math.round(Number(teamCount.value) || 0)));
        GM.state.ui.teamTool.count = n;
        teamCount.value = String(n);
      };
      teamCount.addEventListener('input', syncTeamCount);
      teamCount.addEventListener('change', syncTeamCount);
    }
    var skillSel = q('#skillToolType');
    if (skillSel) {
      skillSel.addEventListener('change', function () {
        var v = skillSel.value;
        GM.state.ui.skillShape = (v === 'sector' || v === 'rect') ? v : 'circle';
      });
    }
    syncToolPanels();
  }

  function bindSiege() {
    var host = q('#siegeCard');
    if (!host) return;

    host.addEventListener('change', function (e) {
      var plan = GM.activePlan();
      if (!plan) return;
      GM.ensurePlanMeta(plan);

      var steleSelect = e.target.closest('[data-stele-id]');
      if (steleSelect) {
        var sid = steleSelect.getAttribute('data-stele-id');
        plan.siege.steles[sid] = steleSelect.value || null;
        GM.commit('推演石碑归属');
        return;
      }

      var scoreInput = e.target.closest('[data-score-fid]');
      if (scoreInput) {
        var fid = scoreInput.getAttribute('data-score-fid');
        plan.siege.platformScores[fid] = U.clamp(Number(scoreInput.value) || 0, 0, 100);
        GM.commit('推演高台积分');
      }
    });

    host.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-gate-id]');
      if (!btn) return;
      var plan = GM.activePlan();
      if (!plan) return;
      var gateId = btn.getAttribute('data-gate-id');
      var action = btn.getAttribute('data-gate-action');
      var md = GM.currentMap();
      var gate = null;
      (md.siege.gates || []).forEach(function (g) { if (g.id === gateId) gate = g; });
      if (!gate) return;

      if (action === 'break') {
        var state = GM.siegeGateState(plan, gate);
        if (state !== 'ready') {
          toast('该城门尚未解锁，需要先占领对应两座石碑', 'error');
          return;
        }
        plan.siege.gates[gateId] = true;
        GM.commit('标记破门');
        toast(gate.name + '已被攻破', 'success');
      } else if (action === 'unbreak') {
        plan.siege.gates[gateId] = false;
        GM.commit('撤销破门');
      }
    });
  }

  function showMigrationNotice() {
    var n = GM.migrationNotice;
    if (!n) return;
    GM.migrationNotice = null;
    toast('已按新版地图重投影：' + n.map + ' 的 ' + n.count + ' 个标记已换算到「1 unit = 1 人宽」坐标系', 'success');
  }

  function init() {
    populateMapSelect();
    bindTopbar();
    bindInfoTips();
    decorateToolIcons();
    bindToolbar();
    bindInspector();
    bindLayers();
    bindBaseMode();
    bindSiege();
    bindModeStatus();
    bindKeyboard();

    GM.bus.on('change', function () {
      if (GM.state.ui.saveStatus !== 'pending') {
        GM.state.ui.saveStatus = 'pending';
        applySaveStatus('pending');
      }
      renderAll();
    });
    GM.bus.on('selection', function () {
      renderInspector();
      updateRightPanel();
      renderToolbar();
      updateHint();
    });
    GM.bus.on('save', function (payload) {
      applySaveStatus(payload && payload.status, payload && payload.silent, payload && payload.detail, true);
    });
    GM.bus.on('tool:changed', function () {
      renderToolbar();
      updateHint();
      if (GM.board) GM.board.applyCursor();
    });
    GM.bus.on('imported', function () {
      populateMapSelect();
      renderAll();
      showMigrationNotice();
    });

    GM.ensureActivePlan();
    setTool('select', true);
    renderAll();
    applySaveStatus(GM.state.ui.saveStatus);
    updateHint();
    showMigrationNotice();
  }

  GM.ui = {
    init: init,
    toast: toast,
    promptText: promptText,
    confirm: confirmDialog,
    modal: openModal,
    closeModal: closeModal,
    renderInspector: renderInspector,
    renderAll: renderAll,
    setTool: setTool
  };

  function boot() {
    GM.storage.init();
    GM.board.init();
    GM.teams.init();
    GM.draw.init();
    GM.plans.init();
    if (GM.engine) GM.engine.init();
    GM.ui.init();
    if (GM.analysis) GM.analysis.init();
    GM.board.defaultView();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
