(function () {
  'use strict';

  window.GM = window.GM || {};
  var GM = window.GM;
  var U = GM.util;

  var MIME_NODE = 'application/x-gm-node';       // 整支队伍 / 小队拖到沙盘
  var MIME_PERSON = 'application/x-gm-person';   // 实时编成里的单个色块拖到沙盘
  var MIME_SLOT = 'application/x-gm-slot';       // 配置窗口内色块换位 / 交换

  /* 空槽位点击生成队员时，按行（0-5）决定默认职业 */
  var ROW_CLASSES = ['战士', '歌颂', '学徒', '占卜', '窥秘', '观众'];

  function q(sel, root) {
    return (root || document).querySelector(sel);
  }

  function qa(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  /* ============================ 通用小工具 ============================ */

  function classById(id) {
    return U.classById(id);
  }

  function className(id) {
    var c = classById(id);
    return c ? c.name : '未知职业';
  }

  function classColor(id) {
    var c = classById(id);
    return (c && c.color) || '#8a919f';
  }

  /* WCAG 相对亮度 / 对比度：用于给职业色块挑正文色（取深/浅中对比度更高的一侧） */
  function channel(v) {
    v = v / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function luminance(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    if (h.length !== 6) return 0.5;
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    if (!isFinite(r) || !isFinite(g) || !isFinite(b)) return 0.5;
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  function contrast(a, b) {
    var la = luminance(a);
    var lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  function textOn(color) {
    return contrast('#141008', color) >= contrast('#f7f2e6', color) ? '#141008' : '#f7f2e6';
  }

  function nameFont(name, box) {
    var len = String(name || '').length;
    if (box === 'mini') return 8.5;
    if (box === 'tight') {
      if (len <= 4) return 15;
      if (len <= 6) return 13.5;
      if (len <= 8) return 11.5;
      return 10;
    }
    if (len <= 3) return 14;
    if (len <= 5) return 12;
    if (len <= 7) return 10.5;
    return 9;
  }

  /* 形态按职业联动，以 data/classes.js 的 forms 为唯一来源（第一项即默认）：
     战士 坦克/输出、歌颂 输出/辅助、观众 治疗/输出、占卜/学徒/窥秘 只有输出。
     这里不再维护第二份职业形态清单，数据缺失时只回落为输出。 */
  function formOptions(classId) {
    var cls = classById(classId);
    return cls && cls.forms && cls.forms.length ? cls.forms.slice() : ['输出'];
  }

  function defaultForm(classId) {
    return formOptions(classId)[0] || '输出';
  }

  function normalizeForm(classId, form) {
    var opts = formOptions(classId);
    return opts.indexOf(form) >= 0 ? form : defaultForm(classId);
  }

  function nameOf(member) {
    return String((member && member.name) || '未命名');
  }

  function memberTitle(member) {
    var cls = classById(member.classId);
    var parts = [cls ? cls.name : '未知职业'];
    if (member.form) parts.push('形态：' + member.form);
    var slots = GM.roster.slotsOf(member);
    var carry = [];
    if (slots.connection) carry.push('人脉：' + slots.connection);
    if (slots.puppet) carry.push('密偶：' + slots.puppet);
    if (slots.skill) carry.push('技能：' + slots.skill);
    parts.push(carry.length ? carry.join(' / ') : '技能：空');
    if (slots.note) parts.push('备注：' + slots.note);
    return nameOf(member) + ' · ' + parts.join(' · ');
  }

  function setDragData(e, mime, payload) {
    var text = JSON.stringify(payload);
    try {
      e.dataTransfer.setData(mime, text);
      e.dataTransfer.setData('text/plain', text);
      e.dataTransfer.effectAllowed = 'copyMove';
    } catch (err) {
      /* file:// 下个别浏览器限制自定义 MIME，text/plain 兜底 */
    }
  }

  function readDrag(e, mime) {
    var raw = '';
    try {
      raw = e.dataTransfer.getData(mime) || e.dataTransfer.getData('text/plain');
    } catch (err) {
      raw = '';
    }
    if (!raw) return null;
    try {
      var data = JSON.parse(raw);
      if (!data || !data.type) return null;
      return data;
    } catch (err) {
      return null;
    }
  }

  /* 预设规模标识：只用于「编成预设列表」弹窗的每一行 */
  function scaleBadge(preset) {
    var info = U.teamKindInit(preset.kind);
    var count = GM.presetCount(preset);
    return '<span class="scale-badge scale-' + U.esc(preset.kind) + '">' + U.esc(info.label) + ' · ' + count + '/' + info.max + '</span>';
  }

  /* 职业构成统计（联盟 / 团队折叠时显示人数与小色条） */
  function classCounts(node) {
    var counts = {};
    (function walk(n) {
      if (!n) return;
      if (n.kind === 'squad') {
        (n.members || []).forEach(function (m) {
          counts[m.classId] = (counts[m.classId] || 0) + 1;
        });
      }
      (n.children || []).forEach(walk);
    })(node);
    return counts;
  }

  function compositionBar(node) {
    var counts = classCounts(node);
    var total = GM.teamCount(node);
    if (!total) return '<span class="comp-bar is-empty" title="暂无成员"></span>';
    var segs = ((GM.state.project && GM.state.project.classes) || []).map(function (c) {
      var n = counts[c.id] || 0;
      if (!n) return '';
      return '<span class="comp-seg" style="width:' + (n / total * 100).toFixed(2) + '%;background:' + U.esc(c.color) + '"' +
        ' title="' + U.esc(c.name) + ' ' + n + ' 人"></span>';
    }).join('');
    return '<span class="comp-bar" title="职业构成">' + segs + '</span>';
  }

  function compositionText(node) {
    var counts = classCounts(node);
    return ((GM.state.project && GM.state.project.classes) || []).filter(function (c) {
      return counts[c.id];
    }).map(function (c) { return c.name + counts[c.id]; }).join(' ') || '无成员';
  }

  /* 纵向缩略格：职业色底 + 小字游戏名（名字短时补技能首字）。
     只服务主界面「当前编成 · 实时」：整块 / 小队 / 单人拖到沙盘由 bindLive 处理。 */
  function miniMemberCell(member) {
    if (!member) return '<div class="mini-tile empty"></div>';
    var color = classColor(member.classId);
    var firstSkill = '';
    (member.skills || []).forEach(function (s) {
      if (!firstSkill && String(s || '').trim()) firstSkill = String(s).trim();
    });
    var name = nameOf(member);
    var showSkill = firstSkill && name.length <= 3;
    return '<div class="mini-tile filled" draggable="true" data-member-id="' + U.esc(member.id) + '"' +
      ' style="background-color:' + U.esc(color) + ';color:' + U.esc(textOn(color)) + '"' +
      ' title="' + U.esc(memberTitle(member)) + '（拖到沙盘 = 单人标记）">' +
      '<span class="mini-name">' + U.esc(name) + '</span>' +
      (showSkill ? '<span class="mini-skill">' + U.esc(firstSkill.slice(0, 1)) + '</span>' : '') +
      '</div>';
  }

  /* 一列 = 一个小队（列 1..5 = 小队1..5）；列内固定 6 行成员，自上而下。
     列头 = 小队拖拽抓手：整列/列头拖出 = 小队建制标记；单格仍是个人标记。 */
  function miniSquadColumn(squad, ownerId, index) {
    var cells = '';
    for (var i = 0; i < 6; i++) {
      cells += miniMemberCell(squad ? (squad.members || [])[i] : null);
    }
    var label = '小队' + (index + 1);
    var sub = squad && String(squad.name || '').trim() && String(squad.name).trim() !== label
      ? String(squad.name).trim() : '';
    var count = squad ? (squad.members || []).length : 0;
    var title = squad
      ? (label + (sub ? '（' + sub + '）' : '') + ' · ' + count + '/6 人' + (count ? '（拖动整个小队）' : '（空小队，无成员）'))
      : (label + ' · 空小队位');

    var headAttrs;
    if (squad && count > 0) {
      headAttrs = ' draggable="true" data-squad-live="' + U.esc(ownerId) + '"' +
        ' data-squad-id="' + U.esc(squad.id) + '"' +
        ' data-squad-name="' + U.esc(String(squad.name || label)) + '"' +
        ' data-squad-index="' + index + '" data-squad-count="' + count + '"';
    } else {
      headAttrs = ' data-squad-empty="1"';
    }

    return '<div class="mini-col' + (squad ? '' : ' is-empty') + '">' +
      '<div class="mini-col-head" title="' + U.esc(title) + '"' + headAttrs + '>' +
        '<span class="mini-col-grip" aria-hidden="true">⠿</span>' + U.esc(label) +
      '</div>' +
      '<div class="mini-col-body">' + cells + '</div>' +
      '</div>';
  }

  function miniTeamColumns(teamNode) {
    var squads = (teamNode.children || []).filter(function (n) { return n.kind === 'squad'; });
    /* 固定 5 列 × 6 行（= 游戏内一个团队的排布），列次序即小队次序 */
    var html = '';
    for (var c = 0; c < 5; c++) {
      html += miniSquadColumn(squads[c] || null, teamNode.id, c);
    }
    return '<div class="mini-cols">' + html + '</div>';
  }

  function miniGrid(node) {
    if (!node) return '';
    if (node.kind === 'squad') {
      return '<div class="mini-cols">' + miniSquadColumn(node, node.id, 0) + '</div>';
    }
    if (node.kind === 'team') return miniTeamColumns(node);
    return '';
  }

  /* ============================ 主界面左栏：实时编成（live） ============================ */

  /* 5×5×5×6 固定骨架：联盟 5 槽 × 团队 5 槽 × 小队 5 槽 × 6 人，缺哪个补哪个 */
  function ensureSkeleton() {
    var project = GM.state.project;
    if (!project) return false;
    if (!Array.isArray(project.teams)) project.teams = [];
    var changed = false;

    function pad(node, kind, prefix, count) {
      if (!Array.isArray(node.children)) node.children = [];
      var existing = node.children.filter(function (n) { return n.kind === kind; });
      for (var i = existing.length; i < count; i++) {
        var child = GM.newTeam(kind, prefix + (i + 1));
        child.factionId = node.factionId || 'A';
        node.children.push(child);
        changed = true;
      }
    }

    var alliances = project.teams.filter(function (n) { return n.kind === 'alliance'; });
    for (var i = alliances.length; i < 5; i++) {
      var node = GM.newTeam('alliance', '联盟' + (i + 1));
      project.teams.push(node);
      alliances.push(node);
      changed = true;
    }
    alliances.forEach(function (a) {
      pad(a, 'team', '团队', 5);
      a.children.forEach(function (t) {
        if (t.kind === 'team') pad(t, 'squad', '小队', 5);
      });
    });
    project.teams.forEach(function (t) {
      if (t.kind === 'team') pad(t, 'squad', '小队', 5);
    });
    return changed;
  }

  /* 折叠状态只存浏览器本地（不写入工程存档，避免导入导出互相污染） */
  var COLLAPSE_KEY = 'gm.tactical.ui.v1';

  function loadCollapseState() {
    var out = {};
    try {
      var raw = window.localStorage.getItem(COLLAPSE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') out = parsed;
      }
    } catch (err) {
      out = {};
    }
    GM.state.ui.collapsedTeams = out;
  }

  function persistCollapseState() {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(GM.state.ui.collapsedTeams || {}));
    } catch (err) {
      /* localStorage 不可用时仅内存生效，不打断操作 */
    }
  }

  function isCollapsed(id) {
    return !!(id && GM.state.ui.collapsedTeams && GM.state.ui.collapsedTeams[id]);
  }

  function toggleCollapsed(id) {
    if (!id) return;
    var map = GM.state.ui.collapsedTeams || (GM.state.ui.collapsedTeams = {});
    if (map[id]) delete map[id];
    else map[id] = true;
    persistCollapseState();
    renderLive();
  }

  function liveTeamCard(node) {
    var collapsed = isCollapsed(node.id);
    var count = GM.teamCount(node);
    return '<div class="preset-card live-card' + (collapsed ? ' is-collapsed' : '') + '" draggable="true" data-live-id="' + U.esc(node.id) + '"' +
      ' title="拖到沙盘 = 生成整支队伍标记；点标题行 = 折叠 / 展开">' +
      '<div class="preset-card-top live-card-head" data-live-head="' + U.esc(node.id) + '" title="点击折叠 / 展开下级缩略图">' +
        '<span class="live-caret">' + (collapsed ? '▸' : '▾') + '</span>' +
        '<span class="preset-name" title="' + U.esc(node.name) + '">' + U.esc(node.name) + '</span>' +
        '<span class="live-team-count">' + count + '/' + U.teamKindInit('team').max + '</span>' +
        '<button type="button" class="live-edit" data-live-edit="' + U.esc(node.id) + '" draggable="false" title="打开编队配置">编</button>' +
      '</div>' +
      (collapsed
        ? '<div class="live-collapsed">' + compositionBar(node) +
            '<div class="live-collapsed-line">' + count + ' 人 · ' + U.esc(compositionText(node)) + '</div></div>'
        : miniGrid(node)) +
      '</div>';
  }

  function liveAllianceBlock(node) {
    var collapsed = isCollapsed(node.id);
    var count = GM.teamCount(node);
    var teams = (node.children || []).filter(function (n) { return n.kind === 'team'; });
    var max = U.teamKindInit('alliance').max;
    return '<div class="live-alliance">' +
      '<div class="live-group' + (collapsed ? ' collapsed' : '') + '" draggable="true" data-live-alliance="' + U.esc(node.id) + '"' +
        ' data-live-head="' + U.esc(node.id) + '"' +
        ' title="点击折叠 / 展开；拖到沙盘 = 按 ' + (count || max) + ' 人生成联盟大圈标记">' +
        '<span class="live-caret">' + (collapsed ? '▸' : '▾') + '</span>' +
        '<span class="live-group-name">' + U.esc(node.name) + '</span>' +
        '<span class="live-group-count">' + count + '/' + max + ' 人</span>' +
        (collapsed ? '' : compositionBar(node)) +
      '</div>' +
      (collapsed
        ? '<div class="live-collapsed">' + compositionBar(node) +
            '<div class="live-collapsed-line">' + count + ' 人 · ' + U.esc(compositionText(node)) + '</div></div>'
        : teams.map(liveTeamCard).join('')) +
      '</div>';
  }

  function renderLive() {
    var host = q('#liveList');
    if (!host) return;
    var project = GM.state.project;
    if (!project) { host.innerHTML = ''; return; }

    var teamCount = 0;
    var html = '';
    var alliances = (project.teams || []).filter(function (n) { return n.kind === 'alliance'; });
    alliances.forEach(function (a) {
      teamCount += (a.children || []).filter(function (n) { return n.kind === 'team'; }).length;
      html += liveAllianceBlock(a);
    });

    var orphans = (project.teams || []).filter(function (n) { return n.kind === 'team' || n.kind === 'squad'; });
    if (orphans.length) {
      teamCount += orphans.length;
      html += '<div class="live-alliance"><div class="live-group"><span class="live-group-name">未归属编队</span></div>' +
        orphans.map(liveTeamCard).join('') + '</div>';
    }

    var tag = q('#liveCount');
    if (tag) tag.textContent = String(teamCount);
    host.innerHTML = html || '<div class="preset-empty">尚未有编队</div>';
  }

  function focusLiveNode(node) {
    if (!node) return;
    var tabs = configAlliances();
    if (node.kind === 'alliance') {
      configState.allianceId = node.id;
      var firstTeam = (node.children || []).filter(function (n) { return n.kind === 'team'; })[0];
      configState.teamId = firstTeam ? firstTeam.id : null;
    } else {
      var hitTab = null;
      var hitWrapper = null;
      tabs.forEach(function (tab) {
        tab.teams.forEach(function (w) {
          if (hitWrapper) return;
          if (w.id === node.id) { hitWrapper = w; hitTab = tab; return; }
          if (w.squadOnly && w.squadOnly.id === node.id) { hitWrapper = w; hitTab = tab; }
          if (w.squads && w.squads.some(function (s) { return s.id === node.id; })) { hitWrapper = w; hitTab = tab; }
        });
      });
      if (hitWrapper) {
        configState.allianceId = hitTab.id;
        configState.teamId = hitWrapper.id;
      }
    }
    configState.drawer = null;
    openConfig();
  }

  /* ============================ 配置窗口：层级模型 ============================ */

  var configState = {
    allianceId: null,
    teamId: null,
    drawer: null
  };

  /* 配置面板批量选择模式（与导入预览共用 roster.batchMembers 底层） */
  var configBatch = { on: false, sel: {}, lastId: '', lastSquadId: '', classId: '', form: '' };

  function pseudoTeamOfSquad(squad) {
    return {
      id: '__pt_' + squad.id,
      node: null,
      squadOnly: squad,
      name: squad.name,
      synthetic: true,
      squads: [squad]
    };
  }

  function teamWrapper(node) {
    return {
      id: node.id,
      node: node,
      squadOnly: null,
      name: node.name,
      synthetic: false,
      squads: (node.children || []).filter(function (n) { return n.kind === 'squad'; })
    };
  }

  function configAlliances() {
    var project = GM.state.project;
    if (!project) return [];
    var roots = project.teams;
    var tabs = [];

    roots.forEach(function (node) {
      if (node.kind !== 'alliance') return;
      tabs.push({
        id: node.id,
        node: node,
        name: node.name,
        synthetic: false,
        teams: (node.children || []).filter(function (n) { return n.kind === 'team'; }).map(teamWrapper)
      });
    });

    var orphanTeams = roots.filter(function (n) { return n.kind === 'team'; });
    var orphanSquads = roots.filter(function (n) { return n.kind === 'squad'; });
    if (orphanTeams.length || orphanSquads.length) {
      var teams = orphanTeams.map(teamWrapper);
      orphanSquads.forEach(function (s) { teams.push(pseudoTeamOfSquad(s)); });
      tabs.push({ id: '__orphan__', node: null, name: '未归属编队', synthetic: true, teams: teams });
    }
    return tabs;
  }

  function ensureConfigSelection(tabs) {
    tabs = tabs || configAlliances();
    var hasAlliance = tabs.some(function (t) { return t.id === configState.allianceId; });
    if (!hasAlliance) configState.allianceId = tabs.length ? tabs[0].id : null;

    var tab = activeAllianceTab(tabs);
    var teams = tab ? tab.teams : [];
    var hasTeam = teams.some(function (t) { return t.id === configState.teamId; });
    if (!hasTeam) configState.teamId = teams.length ? teams[0].id : null;
    return tabs;
  }

  function activeAllianceTab(tabs) {
    tabs = tabs || configAlliances();
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].id === configState.allianceId) return tabs[i];
    }
    return null;
  }

  function activeTeamWrapper(tabs) {
    var tab = activeAllianceTab(tabs);
    if (!tab) return null;
    for (var i = 0; i < tab.teams.length; i++) {
      if (tab.teams[i].id === configState.teamId) return tab.teams[i];
    }
    return null;
  }

  function teamTotal(node) {
    if (!node) return 0;
    return GM.teamCount(node);
  }

  function wrapperTotal(w) {
    if (!w) return 0;
    if (w.squadOnly) return (w.squadOnly.members || []).length;
    return teamTotal(w.node);
  }

  function tabTotal(tab) {
    if (!tab) return 0;
    if (tab.node) return GM.teamCount(tab.node);
    return tab.teams.reduce(function (sum, w) { return sum + wrapperTotal(w); }, 0);
  }

  /* ============================ 配置窗口：渲染 ============================ */

  function allianceTabsHtml(tabs) {
    var html = tabs.map(function (tab) {
      var count = tabTotal(tab);
      var max = U.teamKindInit('alliance').max;
      return '<button type="button" class="config-tab' + (tab.id === configState.allianceId ? ' active' : '') + (tab.synthetic ? ' synthetic' : '') + '"' +
        ' data-alliance-id="' + U.esc(tab.id) + '" title="点击切换联盟；双击重命名">' +
        '<span class="tab-name">' + U.esc(tab.name) + '</span>' +
        '<span class="tab-count">' + count + '/' + max + '</span>' +
        '</button>';
    }).join('');

    var active = activeAllianceTab(tabs);
    if (active && !active.synthetic) {
      html += '<div class="config-level-actions">' +
        '<button type="button" class="squad-act" data-alliance-rename title="重命名联盟">✎</button>' +
        '</div>';
    }
    return html;
  }

  function teamTabsHtml(tab) {
    if (!tab) return '<span class="config-hint">先新建联盟</span>';
    var html = tab.teams.map(function (w) {
      var count = wrapperTotal(w);
      var max = U.teamKindInit('team').max;
      return '<button type="button" class="config-tab' + (w.id === configState.teamId ? ' active' : '') + (w.synthetic ? ' synthetic' : '') + '"' +
        ' data-team-id="' + U.esc(w.id) + '" title="点击切换团队；双击重命名">' +
        '<span class="tab-name">' + U.esc(w.name) + '</span>' +
        '<span class="tab-count">' + count + '/' + max + '</span>' +
        '</button>';
    }).join('');

    var active = activeTeamWrapper();
    if (active && active.node) {
      html += '<div class="config-level-actions">' +
        '<button type="button" class="squad-act" data-team-rename title="重命名团队">✎</button>' +
        '</div>';
    }
    return html;
  }

  function slotTileHtml(squad, index) {
    var member = squad && squad.members[index];
    if (!member) {
      var rowClass = ROW_CLASSES[index] || ROW_CLASSES[index % 6];
      return '<div class="slot-tile empty" data-squad-id="' + U.esc(squad ? squad.id : '') + '" data-slot-index="' + index + '"' +
        ' title="空位 · 点击生成队员（默认 ' + U.esc(rowClass) + '）">' +
        '<span class="slot-empty-plus">＋</span>' +
        '<span class="slot-empty-hint">' + U.esc(rowClass) + '</span>' +
        '</div>';
    }
    var color = classColor(member.classId);
    var form = normalizeForm(member.classId, member.form || '');
    var selected = configState.drawer && configState.drawer.memberId === member.id ? ' selected' : '';
    var batchSel = configBatch.on && configBatch.sel[member.id] ? ' is-sel' : '';
    var batchMark = configBatch.on ? '<span class="batch-mark">' + (configBatch.sel[member.id] ? '✓' : '') + '</span>' : '';
    var formClass = form === '坦克' ? ' form-tank' : (form === '治疗' ? ' form-heal' : (form === '辅助' ? ' form-support' : ''));
    var slots = GM.roster.slotsOf(member);
    var skills = '';
    ['connection', 'puppet', 'skill'].forEach(function (k) {
      var sv = String(slots[k] || '').trim();
      skills += '<span class="slot-skill-row' + (sv ? '' : ' is-empty') + '">' + U.esc(sv || '—') + '</span>';
    });
    var noteBadge = slots.note ? '<span class="slot-note-badge" title="备注：' + U.esc(slots.note) + '">注</span>' : '';
    return '<div class="slot-tile filled' + selected + batchSel + formClass + '" draggable="' + (configBatch.on ? 'false' : 'true') + '"' +
      ' data-squad-id="' + U.esc(squad.id) + '" data-slot-index="' + index + '" data-member-id="' + U.esc(member.id) + '"' +
      (configBatch.on ? ' data-batch-id="' + U.esc(member.id) + '"' : '') +
      ' style="background-color:' + U.esc(color) + ';color:' + U.esc(textOn(color)) + '"' +
      ' title="' + U.esc(memberTitle(member)) + (configBatch.on ? '（批量模式：点选 / Shift 连选 / 拖框多选）' : '（拖到其他格子换位 / 交换）') + '">' +
      batchMark +
      '<span class="slot-badge">' + U.esc(className(member.classId) + '·' + form) + '</span>' +
      noteBadge +
      '<span class="slot-name" style="font-size:clamp(12px, calc(' + nameFont(member.name, 'tight') + 'px * var(--rv-scale, 1)), 17px)">' + U.esc(nameOf(member)) + '</span>' +
      '<span class="slot-skills">' + skills + '</span>' +
      '</div>';
  }

  function isDefaultSquadName(name, index) {
    var s = String(name || '').trim();
    if (!s) return true;
    if (s === '小队 ' + (index + 1) || s === '小队' + (index + 1)) return true;
    return new RegExp('^小队\\s*' + (index + 1) + '$').test(s);
  }

  /* 一列 = 一个小队：列头 + 6 个色块，五列合成一整块 30 格面板 */
  function squadColumnHtml(wrapper, squad, index) {
    var empty = !squad;
    var count = squad ? (squad.members || []).length : 0;
    var custom = squad && !isDefaultSquadName(squad.name, index);

    var head = '<div class="squad-col-head' + (empty ? ' is-empty' : '') + '"' +
      (squad ? ' data-col-rename="' + U.esc(squad.id) + '" title="双击重命名小队 · ' + count + '/6 人"' : ' title="该列还没有小队"') + '>' +
      '<span class="squad-index">小队' + (index + 1) + '</span>' +
      (custom ? '<span class="squad-name">' + U.esc(squad.name) + '</span>' : '') +
      '</div>';

    var cells = '';
    for (var i = 0; i < 6; i++) {
      cells += empty
        ? '<div class="slot-tile empty" data-squad-id="" data-slot-index="' + i + '" title="该列还没有小队">' +
          '<span class="slot-empty-plus">＋</span><span class="slot-empty-hint">' + (ROW_CLASSES[i] || '') + '</span></div>'
        : slotTileHtml(squad, i);
    }

    return '<div class="squad-col' + (empty ? ' is-empty' : '') + '">' +
      head +
      '<div class="squad-col-body">' + cells + '</div>' +
      '</div>';
  }

  function squadStackHtml(tabs) {
    var tab = activeAllianceTab(tabs);
    if (!tab) {
      return '<div class="preset-empty">还没有任何联盟 / 团队。固定骨架会在初始化时自动补齐。</div>';
    }
    var w = activeTeamWrapper(tabs);
    if (!w) {
      return '<div class="preset-empty">「' + U.esc(tab.name) + '」下还没有团队。固定骨架（联盟1-5 × 团队1-5 × 小队1-5）会在初始化时自动补齐。</div>';
    }

    var count = wrapperTotal(w);
    var teamMax = U.teamKindInit('team').max;
    var summary = '<div class="team-summary">' +
      '<h3>' + U.esc(w.name) + '</h3>' +
      '<span class="team-count">' + count + '/' + teamMax + ' 人</span>' +
      '<div class="spacer"></div>' +
      '</div>';

    var squads = w.squads || [];
    var cols = Math.max(5, squads.length);
    var html = summary + '<div class="team-panel">';
    for (var i = 0; i < cols; i++) {
      html += squadColumnHtml(w, squads[i] || null, i);
    }
    html += '</div>';

    if (w.node && squads.length > 5) {
      html += '<div class="gate-hint">该团队已超过 5 个小队，超出部分的色块仍可编辑，但团队人数上限仍是 30。</div>';
    }
    if (w.squadOnly) {
      html += '<div class="gate-hint">这支小队直接挂在顶层（未归属团队）。保存预设后建议也建立团队层级。</div>';
    }
    return html;
  }

  function renderConfig() {
    var overlay = q('#teamOverlay');
    if (!overlay) return;
    var tabs = ensureConfigSelection();
    var at = q('#allianceTabs');
    var tt = q('#teamTabs');
    var stack = q('#squadStack');
    if (at) at.innerHTML = allianceTabsHtml(tabs);
    if (tt) tt.innerHTML = teamTabsHtml(activeAllianceTab(tabs));
    if (stack) stack.innerHTML = squadStackHtml(tabs);
    var tag = q('#configScopeTag');
    if (tag) {
      var tab = activeAllianceTab(tabs);
      var w = activeTeamWrapper(tabs);
      tag.textContent = (tab ? tab.name : '无联盟') + ' → ' + (w ? w.name : '无团队') + ' → 5 小队';
    }
    syncDrawer();
    renderPool();
    renderOverview();
    renderBatchBar();
  }

  /* ============================ 配置面板批量选择 ============================ */

  function configMemberTotal() {
    var n = 0;
    (GM.state.project.teams || []).forEach(function walk(node) {
      (node.members || []).forEach(function () { n++; });
      (node.children || []).forEach(walk);
    });
    return n + ((GM.state.project.pool || []).length);
  }

  function batchIds() {
    return Object.keys(configBatch.sel).filter(function (k) { return configBatch.sel[k]; });
  }

  function setBatchSel(ids, additive) {
    if (!additive) configBatch.sel = {};
    (ids || []).forEach(function (id) { if (id) configBatch.sel[id] = true; });
  }

  function allMembersInSquad(squadId) {
    var squad = GM.findTeam(squadId);
    if (!squad) return [];
    return (squad.members || []).map(function (m) { return m.id; });
  }

  function allMembersInCurrentTeam() {
    var w = activeTeamWrapper();
    if (!w) return [];
    var ids = [];
    (w.squads || []).forEach(function (sq) {
      (sq.members || []).forEach(function (m) { ids.push(m.id); });
    });
    return ids;
  }

  function membersByClass(classId, form) {
    var ids = [];
    (GM.state.project.teams || []).forEach(function walk(node) {
      (node.members || []).forEach(function (m) {
        if (!classId || m.classId !== classId) return;
        if (form && normalizeForm(m.classId, m.form || '') !== form) return;
        ids.push(m.id);
      });
      (node.children || []).forEach(walk);
    });
    return ids;
  }

  function batchFlatTeams() {
    var out = [];
    var project = GM.state.project || {};
    (project.teams || []).forEach(function (a) {
      if (a.kind !== 'alliance') return;
      (a.children || []).forEach(function (t) {
        if (t.kind === 'team') out.push({ alliance: a, team: t });
      });
    });
    (project.teams || []).forEach(function (t) {
      if (t.kind === 'team') out.push({ alliance: null, team: t });
    });
    return out;
  }

  /* 「当前小队」= 最近点过的色块所在小队；没点过就取当前团队的第一个小队 */
  function currentBatchSquad() {
    if (configBatch.lastSquadId) {
      var hit = GM.findTeam(configBatch.lastSquadId);
      if (hit) return hit;
    }
    var w = activeTeamWrapper();
    return (w && (w.squads || [])[0]) || null;
  }

  function batchVisibleIds() {
    return qa('#squadStack .slot-tile.filled[data-batch-id]').map(function (el) {
      return el.getAttribute('data-batch-id');
    });
  }

  /* 批量模式点击色块：普通点选切换；Shift 连选按 DOM 顺序取区间 */
  function toggleBatchPick(memberId, squadId, shiftKey) {
    if (!memberId) return;
    if (shiftKey && configBatch.lastId) {
      var ids = batchVisibleIds();
      var a = ids.indexOf(configBatch.lastId);
      var b = ids.indexOf(memberId);
      if (a >= 0 && b >= 0) {
        var lo = Math.min(a, b);
        var hi = Math.max(a, b);
        for (var i = lo; i <= hi; i++) configBatch.sel[ids[i]] = true;
        configBatch.lastId = memberId;
        if (squadId) configBatch.lastSquadId = squadId;
        renderConfig();
        return;
      }
    }
    if (configBatch.sel[memberId]) delete configBatch.sel[memberId];
    else configBatch.sel[memberId] = true;
    configBatch.lastId = memberId;
    if (squadId) configBatch.lastSquadId = squadId;
    renderConfig();
  }

  /* 拖框选择：返回框内命中的成员 id（不渲染，交给调用方合并） */
  function batchHitsInRect(x0, y0, x1, y1) {
    var left = Math.min(x0, x1);
    var right = Math.max(x0, x1);
    var top = Math.min(y0, y1);
    var bottom = Math.max(y0, y1);
    var ids = [];
    qa('#squadStack .slot-tile.filled[data-batch-id]').forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.right >= left && r.left <= right && r.bottom >= top && r.top <= bottom) {
        ids.push(el.getAttribute('data-batch-id'));
      }
    });
    return ids;
  }

  function renderBatchBar() {
    var bar = q('#batchBar');
    var btn = q('#btnBatchSelect');
    if (btn) {
      btn.classList.toggle('active', configBatch.on);
      btn.textContent = configBatch.on ? '退出批量' : '批量操作';
    }
    if (!bar) return;
    if (!configBatch.on) {
      bar.classList.add('hidden');
      bar.innerHTML = '';
      return;
    }
    bar.classList.remove('hidden');
    var picked = batchIds().length;
    var classes = (GM.state.project && GM.state.project.classes) || [];
    var classOpts = classes.map(function (c) { return '<option value="' + U.esc(c.id) + '">' + U.esc(c.name) + '</option>'; }).join('');
    /* 批量改职业/形态：职业与形态的选择跨重绘保留，形态按职业收窄（数据源 data/classes.js 的 forms） */
    var batchClassId = configBatch.classId && classById(configBatch.classId)
      ? configBatch.classId
      : (classes.length ? classes[0].id : '');
    var batchForm = normalizeForm(batchClassId, configBatch.form || '');
    configBatch.classId = batchClassId;
    configBatch.form = batchForm;
    var targetClassOpts = classes.map(function (c) {
      return '<option value="' + U.esc(c.id) + '"' + (c.id === batchClassId ? ' selected' : '') + '>' + U.esc(c.name) + '</option>';
    }).join('');
    var formOpts = formOptsSelHtml(batchClassId, batchForm);
    var squadOpts = '';
    batchFlatTeams().forEach(function (hit, ti) {
      (hit.team.children || []).filter(function (x) { return x.kind === 'squad'; }).forEach(function (sq, si) {
        var label = (hit.alliance ? hit.alliance.name + ' / ' : '') + hit.team.name + ' / ' + (sq.name || ('小队' + (si + 1)));
        squadOpts += '<option value="' + (ti + 1) + '|' + (si + 1) + '">' + U.esc(label) + '</option>';
      });
    });
    var cur = currentBatchSquad();
    bar.innerHTML = '<span class="batch-count">已选 <b>' + picked + '</b> 人</span>' +
      '<span class="batch-cur">当前小队：' + U.esc(cur ? cur.name : '—') + '</span>' +
      '<button type="button" class="btn mini ghost" data-batch-all>' + (picked ? '取消本团队全选' : '全选本团队') + '</button>' +
      '<button type="button" class="btn mini ghost" data-batch-squad-all>全选当前小队</button>' +
      '<select data-batch-class-filter>' + '<option value="">按职业筛选…</option>' + classOpts + '</select>' +
      '<button type="button" class="btn mini ghost" data-batch-class-all>按职业全选</button>' +
      '<span class="batch-sep"></span>' +
      '<select data-batch-class>' + targetClassOpts + '</select>' +
      '<select data-batch-form>' + formOpts + '</select>' +
      '<button type="button" class="btn mini" data-batch-apply-class>改职业/形态</button>' +
      '<button type="button" class="btn mini" data-batch-pool>移入候补池</button>' +
      '<select data-batch-squad>' + squadOpts + '</select>' +
      '<button type="button" class="btn mini" data-batch-move>移到该小队</button>' +
      '<button type="button" class="btn mini ghost" data-batch-clear>清空技能槽</button>' +
      '<button type="button" class="btn mini ghost warn" data-batch-del>删除</button>' +
      '<button type="button" class="btn mini ghost" data-batch-exit>退出（Esc）</button>';
  }

  function exitBatch() {
    configBatch.on = false;
    configBatch.sel = {};
    renderConfig();
  }

  function toggleBatch() {
    configBatch.on = !configBatch.on;
    configBatch.sel = {};
    configBatch.lastId = '';
    renderConfig();
    GM.ui.toast(configBatch.on
      ? '批量模式：点色块 / Shift 连选 / 拖框多选；Esc 退出'
      : '已退出批量模式', configBatch.on ? 'success' : '');
  }

  function applyConfigBatch(action, data) {
    var ids = batchIds();
    if (!ids.length) { GM.ui.toast('先选人：点色块 / Shift 连选 / 拖框', 'error'); return; }
    var before = configMemberTotal();
    var label = '';
    var changed = 0;
    if (action === 'class-form') {
      var members = ids.map(function (id) {
        var f = GM.findMember(id);
        return f ? f.member : null;
      }).filter(Boolean);
      changed = GM.roster.batchMembers(members, 'class-form', data).changed;
      label = '批量改职业/形态 ' + changed + ' 人';
    } else if (action === 'clear-slots') {
      var members2 = ids.map(function (id) { var f = GM.findMember(id); return f ? f.member : null; }).filter(Boolean);
      changed = GM.roster.batchMembers(members2, 'clear-slots', {}).changed;
      label = '批量清空技能槽 ' + changed + ' 人';
    } else if (action === 'pool') {
      changed = GM.roster.moveMembersToPool(GM.state.project, ids);
      label = '批量移入候补池 ' + changed + ' 人';
    } else if (action === 'move') {
      var res = GM.roster.moveMembersTo(GM.state.project, ids, data.teamNo, data.squadNo);
      changed = res.moved;
      label = '批量移动 ' + changed + ' 人' + (res.reason ? '（' + res.reason + '）' : '');
    } else if (action === 'delete') {
      changed = GM.roster.removeMembers(GM.state.project, ids);
      label = '批量删除 ' + changed + ' 人';
    }
    var after = configMemberTotal();
    /* 删除会让总人数按预期减少；其余动作（改职业 / 移池 / 移队 / 清槽）人数必须守恒 */
    var expect = action === 'delete' ? before - changed : before;
    var balanced = after === expect;
    GM.commit(label || '批量操作');
    GM.ui.toast(label + '；人数 ' + before + ' → ' + after +
      (action === 'delete' ? (balanced ? ' ✓ 与删除数一致' : ' ✗ 与删除数不一致') : (balanced ? ' ✓ 守恒' : ' ✗ 不守恒')),
      balanced ? 'success' : 'error');
    configBatch.sel = {};
    renderConfig();
  }

  /* ============================ 候补池（C） ============================ */

  var poolState = { classFilter: '', search: '' };

  function poolMembers() {
    return GM.pool ? GM.pool() : [];
  }

  function poolFiltered() {
    var filter = poolState.classFilter;
    var qtext = String(poolState.search || '').trim().toLowerCase();
    return poolMembers().filter(function (m) {
      if (filter) {
        var parts = filter.split('|');
        if (m.classId !== parts[0]) return false;
        if (parts[1] && normalizeForm(m.classId, m.form || '') !== parts[1]) return false;
      }
      if (qtext && String(m.name || '').toLowerCase().indexOf(qtext) < 0) return false;
      return true;
    });
  }

  function fillPoolFilters() {
    var sel = q('#poolClassFilter');
    if (!sel) return;
    var project = GM.state.project || {};
    var html = '<option value="">全部职业</option>';
    (project.classes || []).forEach(function (c) {
      html += '<option value="' + U.esc(c.id) + '">' + U.esc(c.name) + '（全部形态）</option>';
      formOptions(c.id).forEach(function (f) {
        html += '<option value="' + U.esc(c.id + '|' + f) + '">' + U.esc(c.name + '·' + f) + '</option>';
      });
    });
    sel.innerHTML = html;
    sel.value = poolState.classFilter || '';
    if (!sel.value) poolState.classFilter = '';
  }

  function poolTileHtml(m) {
    var color = classColor(m.classId);
    var form = normalizeForm(m.classId, m.form || '');
    var slots = GM.roster.slotsOf(m);
    var skills = ['connection', 'puppet', 'skill'].map(function (k) { return String(slots[k] || '').trim(); })
      .filter(function (x) { return !!x; }).join('·');
    var noteBadge = slots.note ? '<span class="slot-note-badge" title="备注：' + U.esc(slots.note) + '">注</span>' : '';
    var srcParts = [];
    if (m.source && m.source.sheet) srcParts.push('『' + m.source.sheet + '』');
    if (m.source && m.source.column) srcParts.push(m.source.column);
    if (m.source && m.source.row) srcParts.push('第' + m.source.row + '行');
    var src = srcParts.length ? '<span class="pool-tile-src">来源 ' + U.esc(srcParts.join(' ')) + '</span>' : '';
    var title = memberTitle(m) + (srcParts.length ? ' · 来源 ' + srcParts.join(' ') : '');
    return '<div class="pool-tile filled" draggable="true" data-pool-member-id="' + U.esc(m.id) + '"' +
      ' style="background-color:' + U.esc(color) + ';color:' + U.esc(textOn(color)) + '"' +
      ' title="' + U.esc(title) + '">' +
      '<button type="button" class="pool-tile-del" data-pool-remove="' + U.esc(m.id) + '" title="移出候补池">✕</button>' +
      '<span class="pool-tile-name">' + U.esc(nameOf(m)) + '</span>' +
      '<span class="pool-tile-meta">' + U.esc(className(m.classId) + '·' + form) + '</span>' +
      noteBadge +
      (skills ? '<span class="pool-tile-skills">' + U.esc(skills) + '</span>' : '') +
      src +
      '</div>';
  }

  function renderPool() {
    var panel = q('#poolPanel');
    if (!panel) return;
    var all = poolMembers();
    var total = q('#poolTotal');
    if (total) total.textContent = all.length + ' 人 · 不占编制';
    var grid = q('#poolGrid');
    if (!grid) return;
    var list = poolFiltered();
    var note = q('#poolFilterNote');
    if (note) {
      note.textContent = (poolState.classFilter || poolState.search)
        ? '筛选后 ' + list.length + ' / 共 ' + all.length + ' 人'
        : '共 ' + all.length + ' 人';
    }
    var html = '';
    if (!all.length) html += '<p class="pool-empty">候补池还是空的：点「＋ 添加」，或把正式小队的色块拖进来。</p>';
    else if (!list.length) html += '<p class="pool-empty">当前筛选没有匹配的候补成员。</p>';
    html += list.map(poolTileHtml).join('');
    html += '<button type="button" class="pool-tile add" data-pool-add="1"><span>＋</span><i>添加候补</i></button>';
    grid.innerHTML = html;
  }

  /* ============================ 编队一体视图：开合状态 ============================ */

  /* 编队已合并为单一视图：三栏常驻，只记「上次是否打开」一个本地键 */
  var OPEN_KEY = 'gm.raidView.open';

  function loadOpenState() {
    try { return window.localStorage.getItem(OPEN_KEY) === '1'; }
    catch (err) { return false; }
  }

  function saveOpenState() {
    try { window.localStorage.setItem(OPEN_KEY, isConfigOpen() ? '1' : '0'); }
    catch (err) { /* localStorage 不可用时只是不记忆开合 */ }
  }

  /* 左栏「编队配置」按钮 = 编队一体视图的唯一入口；用 aria-pressed / data-open 反映开合 */
  function syncWinButtons() {
    var open = isConfigOpen();
    var btn = q('#btnTeamConfig');
    if (!btn) return;
    btn.setAttribute('aria-pressed', open ? 'true' : 'false');
    btn.setAttribute('data-open', open ? '1' : '0');
  }

  function isTypingTarget(t) {
    if (!t) return false;
    var tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t.isContentEditable;
  }

  function restoreWinState() {
    if (loadOpenState()) openConfig();
    syncWinButtons();
  }

  /* ============================ 编成概览（只读） ============================ */

  /* 固定骨架的编制上限：5 联盟 × 5 团队 × 5 小队 × 6 格；进度条分母固定用它 */
  var OV_CAP = { alliances: 5, teams: 25, squads: 125, slots: 750 };

  function overviewStats() {
    var project = GM.state.project || {};
    var stats = { alliances: [], teams: [], squads: [], teamParent: {} };
    function walk(node) {
      if (!node) return;
      if (node.kind === 'squad') stats.squads.push(node);
      else if (node.kind === 'team') stats.teams.push(node);
      else if (node.kind === 'alliance') stats.alliances.push(node);
      (node.children || []).forEach(walk);
    }
    (project.teams || []).forEach(walk);
    (project.teams || []).forEach(function (top) {
      if (top.kind !== 'alliance') return;
      (top.children || []).forEach(function (t) {
        if (t.kind === 'team') stats.teamParent[t.id] = top.name;
      });
    });
    stats.members = [];
    stats.squads.forEach(function (sq) {
      stats.members = stats.members.concat(sq.members || []);
    });
    return stats;
  }

  /* 总览的 KPI 与团队明细只统计「已占用层级」：联盟 / 团队按子树至少 1 人，小队按已填成员 > 0。
     进度条分母仍由 renderOverview 用固定骨架上限（5 / 25 / 125 × 6 格）。 */
  function overviewOccupancy(st) {
    var alliances = st.alliances.filter(function (a) { return GM.teamCount(a) > 0; });
    var teams = st.teams.filter(function (t) { return GM.teamCount(t) > 0; });
    var squads = st.squads.filter(function (s) { return (s.members || []).length > 0; });
    return {
      alliances: alliances,
      teams: teams,
      squads: squads,
      memberCount: st.members.length
    };
  }

  function ovFillRow(label, filled, total) {
    var p = total ? Math.min(100, filled / total * 100) : 0;
    return '<div class="ov-fillrow"><span>' + U.esc(label) + '</span>' +
      '<div class="ov-fillbar"><i style="width:' + p.toFixed(1) + '%"></i></div>' +
      '<em>' + filled + ' / ' + total + '</em></div>';
  }

  function renderOverview() {
    var body = q('#overviewBody');
    if (!body) return;
    var project = GM.state.project;
    if (!project) {
      body.innerHTML = '<p class="ov-empty">尚未加载工程。</p>';
      return;
    }
    var st = overviewStats();
    var occ = overviewOccupancy(st);
    var classes = project.classes || (window.GM_DATA && window.GM_DATA.classes) || [];
    var members = st.members;
    var total = occ.memberCount;
    /* 进度条分母仍用编制上限（固定骨架 5/25/125 × 6 格）；KPI 与团队明细才用已占用口径 */
    var slots = OV_CAP.slots;
    var poolCount = GM.pool ? GM.pool().length : 0;
    var fmtPct = function (n, t) { return t ? (n / t * 100).toFixed(1) + '%' : '0.0%'; };

    /* —— 编制规模（只列已占用的团队） —— */
    var gapsHtml = occ.teams.map(function (t) {
      var n = GM.teamCount(t);
      var gap = Math.max(0, 30 - n);
      var parent = st.teamParent[t.id];
      var label = parent ? parent + ' › ' + t.name : t.name;
      return '<div class="ov-team-row' + (n ? '' : ' is-empty') + '">' +
        '<span class="ov-team-name" title="' + U.esc(label) + '">' + U.esc(label) + '</span>' +
        '<span class="ov-team-count">' + n + '/30</span>' +
        '<span class="ov-team-gap' + (gap ? '' : ' is-ok') + '">' + (gap ? '缺 ' + gap : '满') + '</span></div>';
    }).join('') || '<p class="ov-empty">暂无团队。</p>';

    var scaleHtml = '<div class="ov-sec">' +
      '<div class="ov-sec-head"><h4>编制规模</h4><span>占用 / 上限</span></div>' +
      '<div class="ov-kpis">' +
        '<div class="ov-kpi"><b>' + occ.alliances.length + '</b><span>联盟</span></div>' +
        '<div class="ov-kpi"><b>' + occ.teams.length + '</b><span>团队</span></div>' +
        '<div class="ov-kpi"><b>' + occ.squads.length + '</b><span>小队</span></div>' +
        '<div class="ov-kpi"><b>' + total + '</b><span>正式成员</span></div>' +
      '</div>' +
      ovFillRow('联盟', occ.alliances.length, OV_CAP.alliances) +
      ovFillRow('团队', occ.teams.length, OV_CAP.teams) +
      ovFillRow('小队', occ.squads.length, OV_CAP.squads) +
      ovFillRow('格位', total, slots) +
      '<div class="ov-teamgaps">' + gapsHtml + '</div>' +
      '</div>';

    /* —— 职业占比（沿用工程职业配色） —— */
    var counts = {};
    members.forEach(function (m) { counts[m.classId] = (counts[m.classId] || 0) + 1; });
    var barSegs = classes.map(function (c) {
      var n = counts[c.id] || 0;
      if (!n || !total) return '';
      return '<i style="width:' + (n / total * 100).toFixed(2) + '%;background:' + U.esc(c.color) + '" title="' +
        U.esc(c.name) + ' ' + n + ' 人"></i>';
    }).join('');
    var classRows = classes.map(function (c) {
      var n = counts[c.id] || 0;
      /* 条宽按「占全会社总人数」的比例（与 comp-bar / 顶部汇总条同口径）；
         0 人不画填充段，只留空轨道，避免出现 4px 的假彩条 */
      var fill = (n && total)
        ? '<i style="width:' + (n / total * 100).toFixed(2) + '%;background:' + U.esc(c.color) + '"></i>'
        : '';
      return '<div class="ov-classrow' + (n ? '' : ' is-empty') + '">' +
        '<span class="ov-class-name">' + U.esc(c.name) + '</span>' +
        '<span class="ov-class-bar">' + fill + '</span>' +
        '<span class="ov-class-num">' + n + ' · ' + fmtPct(n, total) + '</span></div>';
    }).join('');
    var classHtml = '<div class="ov-sec">' +
      '<div class="ov-sec-head"><h4>职业占比</h4><span>' + total + ' 人</span></div>' +
      '<div class="ov-classbar">' + (barSegs || '') + '</div>' +
      classRows +
      '</div>';

    /* —— 技能携带统计：只统计 人脉 / 密偶 / 技能 三类；备注不是技能，不入统计 —— */
    var SLOT_DEFS = [
      { key: 'connection', label: '人脉' },
      { key: 'puppet', label: '密偶' },
      { key: 'skill', label: '技能' }
    ];
    var slotStats = {};
    SLOT_DEFS.forEach(function (d) { slotStats[d.key] = {}; });
    st.squads.forEach(function (sq) {
      (sq.members || []).forEach(function (m) {
        var slots = GM.roster.slotsOf(m);
        SLOT_DEFS.forEach(function (d) {
          var name = String(slots[d.key] || '').trim();
          if (!name) return;
          var map = slotStats[d.key];
          var rec = map[name] || (map[name] = { name: name, count: 0, squads: {} });
          rec.count++;
          rec.squads[sq.id] = true;
        });
      });
    });
    function slotRowsOf(key) {
      var map = slotStats[key];
      var list = Object.keys(map).map(function (k) { return map[k]; })
        .sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name, 'zh'); });
      return list.map(function (rec) {
        var squads = Object.keys(rec.squads).length;
        return '<div class="ov-skill-row' + (squads > 1 ? ' is-cross' : '') + '">' +
          '<span class="ov-skill-name" title="' + U.esc(rec.name) + '">' + U.esc(rec.name) + '</span>' +
          '<span class="ov-skill-bar"><i style="width:' + (total ? (rec.count / total * 100).toFixed(2) : 0) + '%"></i></span>' +
          '<span class="ov-skill-num">' + rec.count + ' 人 · ' + fmtPct(rec.count, total) + '</span>' +
          (squads > 1 ? '<span class="ov-skill-cross">跨 ' + squads + ' 队</span>' : '') +
          '</div>';
      }).join('');
    }
    var slotGroupHtml = SLOT_DEFS.map(function (d) {
      var kinds = Object.keys(slotStats[d.key]).length;
      var rows = slotRowsOf(d.key);
      return '<div class="ov-slot-group">' +
        '<div class="ov-slot-head"><b>' + d.label + '</b><span>' + kinds + ' 种 · ' +
        Object.keys(slotStats[d.key]).reduce(function (n, k) { return n + slotStats[d.key][k].count; }, 0) + ' 人次</span></div>' +
        (rows || '<p class="ov-empty">暂无「' + d.label + '」数据。</p>') + '</div>';
    }).join('');
    var skillHtml = '<div class="ov-sec">' +
      '<div class="ov-sec-head"><h4>技能携带统计</h4><span>人脉 / 密偶 / 技能 三类</span></div>' +
      '<div class="ov-skill-list">' + slotGroupHtml + '</div>' +
      '<div class="ov-note">金色左边条 = 跨小队重复携带。备注不计入技能统计，也不参与技能冲突提示。候补池 ' + poolCount + ' 人，不占编制、未计入以上统计。</div>' +
      '</div>';

    body.innerHTML = scaleHtml + classHtml + skillHtml;

    var sub = q('#overviewSub');
    if (sub) sub.textContent = '只读 · ' + total + ' / ' + slots + ' 格';
  }

  function addPoolMember(name) {
    var member = GM.newMember(name || ('候补 ' + (poolMembers().length + 1)));
    member.form = normalizeForm(member.classId, member.form);
    GM.pool().push(member);
    GM.commit('候补池新增');
    renderPool();
    return member;
  }

  function bindPool() {
    var panel = q('#poolPanel');
    if (!panel) return;

    panel.addEventListener('click', function (e) {
      e.stopPropagation();
      var del = e.target.closest('[data-pool-remove]');
      if (del) {
        var id = del.getAttribute('data-pool-remove');
        var found = GM.findMember(id);
        var nm = found ? nameOf(found.member) : '该成员';
        if (configState.drawer && configState.drawer.memberId === id) configState.drawer = null;
        GM.removePoolMember(id);
        GM.commit('候补池移出');
        GM.ui.toast('已从候补池移出「' + nm + '」（Ctrl+Z 可撤销）', 'success');
        renderPool();
        return;
      }
      if (e.target.closest('[data-pool-add]')) {
        var m = addPoolMember();
        renderConfig();
        openDrawer(m.id);
        return;
      }
      var tile = e.target.closest('[data-pool-member-id]');
      if (tile) openDrawer(tile.getAttribute('data-pool-member-id'));
    });

    var addBtn = q('#btnPoolAdd');
    if (addBtn) addBtn.addEventListener('click', function () {
      var m = addPoolMember();
      renderConfig();
      openDrawer(m.id);
    });

    var filterSel = q('#poolClassFilter');
    if (filterSel) filterSel.addEventListener('change', function () {
      poolState.classFilter = filterSel.value;
      renderPool();
    });
    var search = q('#poolSearch');
    if (search) search.addEventListener('input', function () {
      poolState.search = search.value;
      renderPool();
    });

    /* 候补池 ↔ 正式小队：池内色块拖到格子 = 调入；正式色块拖回池 = 调出 */
    panel.addEventListener('dragstart', function (e) {
      var tile = e.target.closest('[data-pool-member-id]');
      if (!tile) return;
      var found = GM.findMember(tile.getAttribute('data-pool-member-id'));
      if (!found || !found.pool) return;
      poolDrag = { memberId: found.member.id, el: tile };
      /* dragover 阶段读不到 dataTransfer，必须同步维护 slotDrag，正式格才能接住池色块 */
      slotDrag = { memberId: found.member.id, fromSquadId: '', fromPool: true, el: tile };
      dropConsumed = false;
      setDragData(e, MIME_SLOT, { type: 'slot', memberId: found.member.id, from: 'pool' });
      makeDragGhost(e, found.member);
      tile.classList.add('dragging');
      showDragHint('拖到正式小队格子 = 调入（目标有人则交换）');
    });
    panel.addEventListener('dragend', function () {
      poolDrag = null;
      resetSlotDrag();
    });
    panel.addEventListener('dragover', function (e) {
      var drag = slotDrag || readDrag(e, MIME_SLOT);
      if (!drag || !drag.memberId || drag.from === 'pool') return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* noop */ }
      panel.classList.add('pool-drop-ok');
      var found = GM.findMember(drag.memberId);
      showDragHint('松手 = 把「' + (found ? nameOf(found.member) : '该队员') + '」调出到候补池');
    });
    panel.addEventListener('dragleave', function (e) {
      if (!panel.contains(e.relatedTarget)) panel.classList.remove('pool-drop-ok');
    });
    panel.addEventListener('drop', function (e) {
      var drag = slotDrag || readDrag(e, MIME_SLOT);
      panel.classList.remove('pool-drop-ok');
      if (!drag || !drag.memberId || drag.from === 'pool') return;
      e.preventDefault();
      e.stopPropagation();
      dropConsumed = true;
      var found = GM.findMember(drag.memberId);
      if (!found || !found.squad) { resetSlotDrag(); return; }
      var moved = found.list.splice(found.index, 1)[0];
      GM.pool().push(moved);
      if (configState.drawer && configState.drawer.memberId === moved.id) configState.drawer = null;
      resetSlotDrag();
      GM.commit('队员调出到候补池');
      GM.ui.toast('已把「' + nameOf(moved) + '」调出到候补池', 'success');
      renderConfig();
      renderPool();
    });
  }

  /* ============================ 成员编辑抽屉 ============================ */

  /* 定位成员所在层级：联盟 → 团队 → 小队 → 列（列号 = 小队在团队里的次序） */
  function locateMember(memberId) {
    var project = GM.state.project;
    var hit = null;

    function scanSquad(squad, alliance, team) {
      if (hit || !squad || squad.kind !== 'squad') return;
      if ((squad.members || []).some(function (m) { return m.id === memberId; })) {
        hit = { alliance: alliance, team: team, squad: squad };
      }
    }

    function scanTeam(team, alliance) {
      if (hit || !team || team.kind !== 'team') return;
      (team.children || []).forEach(function (child) { scanSquad(child, alliance, team); });
    }

    (project.teams || []).forEach(function (node) {
      if (node.kind === 'alliance') {
        (node.children || []).forEach(function (child) { scanTeam(child, node); });
      } else if (node.kind === 'team') {
        scanTeam(node, null);
      } else {
        scanSquad(node, null, null);
      }
    });
    return hit;
  }

  function memberPathText(memberId) {
    var loc = locateMember(memberId);
    if (!loc) {
      var pool = poolMembers();
      for (var i = 0; i < pool.length; i++) {
        if (pool[i].id === memberId) return '候补池 · 第 ' + (i + 1) + ' 位（不占编制）';
      }
      return '';
    }
    var parts = [];
    if (loc.alliance) parts.push(loc.alliance.name);
    if (loc.team) parts.push(loc.team.name);

    var squads = loc.team
      ? (loc.team.children || []).filter(function (n) { return n.kind === 'squad'; })
      : [loc.squad];
    var col = squads.indexOf(loc.squad) + 1;
    if (col < 1) col = 1;
    var squadName = String(loc.squad.name || '').trim() || ('小队' + col);
    parts.push(squadName + ' · 第' + col + '列');
    return parts.join(' › ');
  }

  function drawerMember() {
    if (!configState.drawer) return null;
    var found = GM.findMember(configState.drawer.memberId);
    return found ? found.member : null;
  }

  function formOptionsHtml(classId, form) {
    var current = normalizeForm(classId, form);
    return formOptions(classId).map(function (f) {
      return '<option value="' + U.esc(f) + '"' + (f === current ? ' selected' : '') + '>' + U.esc(f) + '</option>';
    }).join('');
  }

  /* 抽屉里的形态说明由 forms 生成，避免把职业/形态清单写死在提示文案里 */
  function formHintText() {
    var classes = (GM.state.project && GM.state.project.classes && GM.state.project.classes.length)
      ? GM.state.project.classes
      : ((window.GM_DATA && window.GM_DATA.classes) || []);
    var multi = [];
    var single = [];
    var singleForms = [];
    classes.forEach(function (c) {
      var opts = formOptions(c.id);
      if (opts.length > 1) multi.push(c.name + '默认' + opts[0] + '（可选' + opts.slice(1).join(' / ') + '）');
      else if (opts.length) { single.push(c.name); singleForms.push(opts[0]); }
    });
    var text = '形态随职业联动：' + multi.join('；') + '。';
    if (single.length) {
      var only = singleForms.filter(function (f, i) { return singleForms.indexOf(f) === i; }).join(' / ');
      text += single.join(' / ') + '只有' + only + '。';
    }
    return text + '换职业时形态会自动校正。';
  }

  function drawerHtml(member) {
    var cls = classById(member.classId);
    var color = classColor(member.classId);
    var options = (GM.state.project.classes || []).map(function (c) {
      return '<option value="' + U.esc(c.id) + '"' + (c.id === member.classId ? ' selected' : '') + '>' +
        U.esc(c.name) + (c.role ? '（' + U.esc(c.role) + '）' : '') + '</option>';
    }).join('');

    var SK = GM.roster.SLOT_KEYS || ['connection', 'puppet', 'skill', 'note'];
    var SL = GM.roster.SLOT_LABEL || { connection: '人脉', puppet: '密偶', skill: '技能', note: '备注' };
    var MX = GM.roster.SLOT_MAX || { connection: 20, puppet: 20, skill: 20, note: 60 };
    var slots = GM.roster.slotsOf(member);
    var skills = '';
    SK.forEach(function (k, i) {
      var ph = k === 'note' ? '备注（不计入技能统计，最长 60 字）' : (SL[k] + '（可留空）');
      skills += '<div class="skill-item"><span class="skill-slot skill-slot-' + k + '">' + SL[k] + '</span>' +
        '<input type="text" maxlength="' + MX[k] + '" data-drawer-field="skill" data-skill-index="' + i + '"' +
        ' value="' + U.esc(slots[k] || '') + '" spellcheck="false" placeholder="' + U.esc(ph) + '"></div>';
    });

    var preview = '<div class="drawer-preview" style="background:' + U.esc(color) + ';color:' + U.esc(textOn(color)) + '">' +
      U.esc(nameOf(member)) + '</div>';

    return '<div class="drawer-head">' +
        '<div class="drawer-title">' +
          '<h3>' + U.esc(nameOf(member)) + ' · 编辑</h3>' +
          '<div class="drawer-path" title="当前编辑对象所在层级">' + U.esc(memberPathText(member.id)) + '</div>' +
        '</div>' +
        '<button type="button" class="squad-act" data-drawer="close" title="关闭（视为取消）">✕</button>' +
      '</div>' +
      '<div class="drawer-body">' +
        preview +
        '<div class="field"><label>游戏名称</label>' +
        '<input type="text" maxlength="24" data-drawer-field="name" value="' + U.esc(nameOf(member)) + '" spellcheck="false"></div>' +
        '<div class="field"><label>职业</label>' +
        '<select data-drawer-field="class">' + options + '</select></div>' +
        '<div class="field"><label>形态</label>' +
        '<select data-drawer-field="form">' + formOptionsHtml(member.classId, member.form) + '</select>' +
        '<div class="field-hint">' + U.esc(formHintText()) + '</div></div>' +
        '<div class="field"><label>四个语义位（人脉 / 密偶 / 技能 / 备注）</label>' +
        '<div class="skill-list">' + skills + '</div>' +
        '<div class="field-hint">备注不是技能：不计入概览的技能统计，也不参与技能冲突提示；色块上只显示小角标。</div></div>' +
        '<div class="drawer-note">改动实时写回色块并即时保存（约 0.4 秒防抖）。点其他色块 = 直接切换成员（上一个成员的改动已保存）；点空白区域 = 关闭抽屉。点「确认」关闭抽屉；点「取消」回滚本次抽屉内尚未确认的改动。</div>' +
      '</div>' +
      '<div class="drawer-foot">' +
        '<button type="button" class="btn mini danger" data-drawer="remove">' + (locateMember(member.id) ? '移出队伍' : '移出候补池') + '</button>' +
        '<button type="button" class="btn mini ghost" data-drawer="cancel">取消（回滚）</button>' +
        '<button type="button" class="btn mini gold" data-drawer="save">确认</button>' +
      '</div>';
  }

  function syncDrawer() {
    var drawerEl = q('#memberDrawer');
    if (!drawerEl) return;
    if (!configState.drawer) {
      drawerEl.classList.add('hidden');
      drawerEl.innerHTML = '';
      drawerEl.removeAttribute('data-member-id');
      return;
    }
    var member = drawerMember();
    if (!member) {
      configState.drawer = null;
      drawerEl.classList.add('hidden');
      drawerEl.innerHTML = '';
      drawerEl.removeAttribute('data-member-id');
      return;
    }
    /* 已渲染同一成员时保持原 DOM，避免实时保存刷新把输入焦点冲掉 */
    if (!drawerEl.classList.contains('hidden') && drawerEl.getAttribute('data-member-id') === member.id) {
      return;
    }
    drawerEl.classList.remove('hidden');
    drawerEl.setAttribute('data-member-id', member.id);
    drawerEl.innerHTML = drawerHtml(member);
  }

  var drawerTimer = null;

  function scheduleDrawerCommit(label) {
    clearTimeout(drawerTimer);
    drawerTimer = setTimeout(function () {
      drawerTimer = null;
      if (!configState.drawer) return;
      GM.commit(label || '编辑队员');
    }, 400);
  }

  /* 实时保存语义：切换 / 关闭前把防抖中的改动立即落盘，绝不回滚上一个成员 */
  function flushDrawer() {
    clearTimeout(drawerTimer);
    drawerTimer = null;
    var d = configState.drawer;
    if (d && d.dirty) GM.commit('编辑队员');
    configState.drawer = null;
  }

  function openDrawer(memberId) {
    if (!memberId) return;
    var found = GM.findMember(memberId);
    if (!found) return;
    /* 点到正在编辑的同一人：保持抽屉不动，避免输入焦点被刷新打断 */
    if (configState.drawer && configState.drawer.memberId === memberId) {
      if (!found.pool) GM.select('member', memberId);
      return;
    }
    /* 再点另一个色块 = 直接切换：上一个人的改动已实时写回，只提交待落盘的防抖 */
    flushDrawer();
    var member = found.member;
    configState.drawer = {
      memberId: member.id,
      original: U.clone(member),
      dirty: false
    };
    renderConfig();
    GM.select('member', member.id);
  }

  function closeDrawer() {
    configState.drawer = null;
    var el = q('#memberDrawer');
    if (el) {
      el.classList.add('hidden');
      el.innerHTML = '';
    }
    renderConfig();
  }

  function restoreDrawerMember() {
    var d = configState.drawer;
    if (!d) return;
    var found = GM.findMember(d.memberId);
    if (found) {
      var dst = found.member;
      var src = d.original;
      Object.keys(src).forEach(function (k) {
        dst[k] = (k === 'skills') ? src.skills.slice() : src[k];
      });
    }
    configState.drawer = null;
    var el = q('#memberDrawer');
    if (el) {
      el.classList.add('hidden');
      el.innerHTML = '';
    }
  }

  function cancelDrawer(silent) {
    clearTimeout(drawerTimer);
    drawerTimer = null;
    var wasDirty = configState.drawer && configState.drawer.dirty;
    restoreDrawerMember();
    if (wasDirty) GM.commit('取消本次队员编辑');
    else renderConfig();
    if (!silent && wasDirty) GM.ui.toast('已回滚本次抽屉内的改动', 'success');
  }

  function saveDrawer() {
    var d = configState.drawer;
    if (!d) return;
    clearTimeout(drawerTimer);
    drawerTimer = null;
    var found = GM.findMember(d.memberId);
    if (!found) { closeDrawer(); return; }
    var member = found.member;
    if (!String(member.name || '').trim()) member.name = '未命名成员';
    var dirty = d.dirty;
    configState.drawer = null;
    var el = q('#memberDrawer');
    if (el) {
      el.classList.add('hidden');
      el.innerHTML = '';
      el.removeAttribute('data-member-id');
    }
    if (dirty) {
      GM.commit('编辑队员');
      GM.ui.toast('已确认「' + nameOf(member) + '」，改动已实时保存', 'success');
    }
    renderConfig();
  }

  function handleDrawerInput(e) {
    var d = configState.drawer;
    if (!d) return;
    var found = GM.findMember(d.memberId);
    if (!found) return;
    var member = found.member;
    var fieldEl = e.target.closest('[data-drawer-field]');
    if (!fieldEl) return;
    var field = fieldEl.getAttribute('data-drawer-field');

    if (field === 'name') {
      member.name = fieldEl.value;
    } else if (field === 'class') {
      member.classId = fieldEl.value;
      member.form = normalizeForm(member.classId, member.form);
      var formSel = q('#memberDrawer [data-drawer-field="form"]');
      if (formSel) formSel.innerHTML = formOptionsHtml(member.classId, member.form);
    } else if (field === 'form') {
      member.form = normalizeForm(member.classId, fieldEl.value);
    } else if (field === 'skill') {
      var idx = Number(fieldEl.getAttribute('data-skill-index'));
      var keys = GM.roster.SLOT_KEYS;
      if (!Array.isArray(member.skills)) member.skills = [];
      member.skills[idx] = fieldEl.value;
      if (!member.slots || typeof member.slots !== 'object') member.slots = {};
      member.slots[keys[idx]] = fieldEl.value;
    }
    d.dirty = true;
    scheduleDrawerCommit('编辑队员');

    var preview = q('#memberDrawer .drawer-preview');
    if (preview) {
      var color = classColor(member.classId);
      preview.style.background = color;
      preview.style.color = textOn(color);
      preview.textContent = nameOf(member);
    }
    var stack = q('#squadStack');
    if (stack) {
      var tabs = configAlliances();
      stack.innerHTML = squadStackHtml(tabs);
    }
  }

  /* ============================ 配置窗口：增删改 ============================ */

  function setConfigAlliance(id) {
    flushDrawer();
    configState.allianceId = id;
    configState.teamId = null;
    renderConfig();
  }

  function addAlliance() {
    GM.ui.promptText('新建联盟', '联盟名称', '联盟 ' + (GM.state.project.teams.length + 1)).then(function (name) {
      if (name == null) return;
      var node = GM.newTeam('alliance', String(name).trim() || '联盟 未命名');
      GM.state.project.teams.push(node);
      configState.allianceId = node.id;
      configState.teamId = null;
      GM.commit('新增联盟');
      GM.ui.toast('已创建联盟「' + node.name + '」', 'success');
    });
  }

  function addTeam() {
    var tabs = configAlliances();
    var tab = activeAllianceTab(tabs);
    if (!tab) { addAlliance(); return; }
    GM.ui.promptText('新建团队', '团队名称', '团队 ' + (tab.teams.length + 1)).then(function (name) {
      if (name == null) return;
      var node = GM.newTeam('team', String(name).trim() || '团队 未命名');
      if (tab.node) {
        node.factionId = tab.node.factionId || 'A';
        tab.node.children.push(node);
      } else {
        GM.state.project.teams.push(node);
      }
      configState.allianceId = tab.id;
      configState.teamId = node.id;
      GM.commit('新增团队');
      GM.ui.toast('已创建团队「' + node.name + '」', 'success');
    });
  }

  function addSquad(teamId) {
    var team = GM.findTeam(teamId);
    if (!team || team.kind !== 'team') {
      GM.ui.toast('该行没有可挂载的团队', 'error');
      return;
    }
    var squads = (team.children || []).filter(function (n) { return n.kind === 'squad'; });
    if (squads.length >= 5) {
      GM.ui.toast('团队最多 5 个小队（30 格）', 'error');
      return;
    }
    var name = '小队 ' + (squads.length + 1);
    var child = GM.newTeam('squad', name);
    child.factionId = team.factionId || 'A';
    child.color = team.color;
    team.children.push(child);
    configState.teamId = team.id;
    GM.commit('新增小队');
    GM.ui.toast('已创建「' + child.name + '」', 'success');
  }

  function renameTeamNode(node) {
    GM.ui.promptText('重命名' + U.teamKindInit(node.kind).label, '名称', node.name).then(function (name) {
      if (name == null || !String(name).trim()) return;
      node.name = String(name).trim();
      GM.commit('重命名编队');
    });
  }

  function deleteTeamNode(node) {
    GM.ui.confirm('删除' + U.teamKindInit(node.kind).label,
      '确定删除「' + node.name + '」及其下级？相关沙盘标记会一并移除。', '删除').then(function (ok) {
      if (!ok) return;
      GM.deleteTeam(node.id);
      configState.drawer = null;
      GM.commit('删除编队');
      GM.ui.toast('已删除「' + node.name + '」', 'success');
    });
  }

  function findClassByName(name) {
    var lists = [(GM.state.project && GM.state.project.classes) || [], window.GM_DATA.classes || []];
    for (var li = 0; li < lists.length; li++) {
      for (var i = 0; i < lists[li].length; i++) {
        if (lists[li][i].name === name) return lists[li][i];
      }
    }
    return null;
  }

  function memberNameFor(cls) {
    var used = {};
    GM.eachTeam(function (node) {
      if (node.kind !== 'squad') return;
      (node.members || []).forEach(function (m) { used[String(m.name || '')] = true; });
    });
    var base = cls ? cls.name : '队员';
    var n = 1;
    while (used[base + n]) n++;
    return base + n;
  }

  /* 点空格 = 直接按行生成队员（第1行战士…第6行观众），不弹输入框 */
  function createMemberAt(squad, index) {
    if (!squad || squad.kind !== 'squad') return null;
    var check = GM.canAddMember(squad.id);
    if (!check.ok) {
      GM.ui.toast(check.msg, 'error');
      return null;
    }
    var cls = findClassByName(ROW_CLASSES[index] || ROW_CLASSES[index % 6]) ||
      (GM.state.project.classes[0] || {});
    var member = GM.newMember(memberNameFor(cls));
    member.classId = cls.id;
    member.form = defaultForm(cls.id);
    member.sequence = '';
    var at = Math.min(Math.max(0, index), squad.members.length);
    squad.members.splice(at, 0, member);
    GM.commit('新增队员');
    GM.ui.toast('已生成「' + member.name + '」（' + (cls.name || '职业') + '·' + member.form + '）', 'success');
    return member;
  }

  function addMemberToSquad(squad) {
    if (!squad) return null;
    return createMemberAt(squad, squad.members.length);
  }

  /* ============================ 配置窗口：拖动换位 / 交换 / 移出 ============================ */

  /* 浏览器在 dragover 阶段不允许读 dataTransfer.getData()（返回空串），
     这是原来「拖到格子不交换、拖出去删不掉」的根因。
     修复后：拖动源一律记在模块级 slotDrag；dataTransfer 只在 drop 时兜底读取。 */
  var slotDrag = null;              // { memberId, fromSquadId, el }
  var poolDrag = null;              // { memberId, el }（候补池内色块拖动）
  var dragPointer = { x: 0, y: 0 }; // 最后一次 dragover 的指针位置（移出判定用）
  var dropConsumed = false;         // 本次拖动是否已被某个落点消费

  function configShell() {
    return q('#teamOverlay .config-shell');
  }

  function pointInRect(x, y, rect) {
    return !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  /* 三栏都在同一个 shell 内：落在 shell 任何位置都不算「拖出」 */
  function pointerInsideShell() {
    var shell = configShell();
    return !!shell && pointInRect(dragPointer.x, dragPointer.y, shell.getBoundingClientRect());
  }

  function showDragHint(text, bad) {
    var el = q('#dragHint');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
    el.classList.toggle('is-bad', !!bad);
  }

  function hideDragHint() {
    var el = q('#dragHint');
    if (!el) return;
    el.classList.add('hidden');
    el.classList.remove('is-bad');
    el.textContent = '';
  }

  /* 拖影：用职业色 + 名字生成一块小色块交给 setDragImage */
  function makeDragGhost(e, member) {
    if (!e.dataTransfer) return;
    var color = classColor(member.classId);
    var ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.style.background = color;
    ghost.style.color = textOn(color);
    ghost.textContent = nameOf(member);
    document.body.appendChild(ghost);
    try { e.dataTransfer.setDragImage(ghost, 22, 14); } catch (err) { /* noop */ }
    window.setTimeout(function () {
      if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
    }, 80);
  }

  function targetSquadOf(el) {
    var tile = el.closest('.slot-tile');
    if (!tile) return null;
    var squadId = tile.getAttribute('data-squad-id');
    var index = Number(tile.getAttribute('data-slot-index'));
    if (!squadId || !isFinite(index)) return null;
    return { squad: GM.findTeam(squadId), index: index, tile: tile };
  }

  function canMoveTo(memberId, targetSquad, targetIndex) {
    var found = GM.findMember(memberId);
    if (!found || !targetSquad || targetSquad.kind !== 'squad') return { ok: false, msg: '目标不是小队' };
    if (!found.pool && found.squad.id === targetSquad.id && found.index === targetIndex) return { ok: false, msg: '' };

    var occupied = targetIndex < targetSquad.members.length && targetSquad.members[targetIndex] &&
      targetSquad.members[targetIndex].id !== memberId;
    /* 目标格有人：候补池 → 格子 = 与现有队员交换（对方回到池里），不静默覆盖 */
    if (occupied) return { ok: true, action: 'swap' };

    if (!found.pool && found.squad.id === targetSquad.id) return { ok: true, action: 'move' };

    if (targetSquad.members.length >= U.teamKindInit('squad').max && targetIndex >= targetSquad.members.length) {
      return { ok: false, msg: '目标小队已满（6 人）' };
    }

    var path = GM.teamPath(targetSquad.id);
    for (var i = 0; i < path.length - 1; i++) {
      var n = path[i];
      var info = U.teamKindInit(n.kind);
      if (GM.teamCount(n) >= info.max) {
        return { ok: false, msg: info.label + '「' + n.name + '」人数已达上限（' + info.max + ' 人）' };
      }
    }
    return { ok: true, action: 'move' };
  }

  function performMove(memberId, targetSquad, targetIndex) {
    var check = canMoveTo(memberId, targetSquad, targetIndex);
    if (!check.ok) return check;

    var found = GM.findMember(memberId);
    if (!found) return { ok: false, msg: '找不到该队员' };

    /* 候补池 → 正式格：调入；目标有人则与对方交换（对方回到池里） */
    if (found.pool) {
      var pool = found.list;
      if (targetIndex < targetSquad.members.length) {
        var otherP = targetSquad.members[targetIndex];
        targetSquad.members[targetIndex] = found.member;
        pool[found.index] = otherP;
        return { ok: true, action: 'swap' };
      }
      var movedP = pool.splice(found.index, 1)[0];
      targetSquad.members.splice(Math.min(targetIndex, targetSquad.members.length), 0, movedP);
      return { ok: true, action: 'move' };
    }

    if (found.squad.id === targetSquad.id) {
      var arr = targetSquad.members;
      var moving = arr[found.index];
      var occupied = targetIndex < arr.length ? arr[targetIndex] : null;
      /* 同小队：拖到已占用格 = 交换；拖到空格 / 末尾 = 移动 */
      if (occupied && occupied.id !== moving.id) {
        arr[found.index] = occupied;
        arr[targetIndex] = moving;
        return { ok: true, action: 'swap' };
      }
      arr.splice(found.index, 1);
      arr.splice(Math.min(targetIndex, arr.length), 0, moving);
      return { ok: true, action: 'move' };
    }

    if (targetIndex < targetSquad.members.length) {
      var other = targetSquad.members[targetIndex];
      targetSquad.members[targetIndex] = found.member;
      found.list[found.index] = other;
      return { ok: true, action: 'swap' };
    }

    var moved = found.list.splice(found.index, 1)[0];
    targetSquad.members.splice(Math.min(targetIndex, targetSquad.members.length), 0, moved);
    return { ok: true, action: 'move' };
  }

  /* 团队 / 联盟页签作为落点：落到该节点下第一个还有空位的小队 */
  function dropNodeOf(el) {
    var tab = el.closest('[data-alliance-id], [data-team-id]');
    if (!tab) return null;
    var allId = tab.getAttribute('data-alliance-id');
    if (allId) {
      var all = GM.findTeam(allId);
      if (all) return { kind: 'alliance', id: allId, node: all, el: tab, label: '联盟「' + all.name + '」' };
    }
    var teamId = tab.getAttribute('data-team-id');
    if (!teamId) return null;
    var team = GM.findTeam(teamId);
    if (!team) return null;
    return { kind: 'team', id: teamId, node: team, el: tab, label: '团队「' + team.name + '」' };
  }

  function firstEmptySlot(node) {
    if (!node) return null;
    if (node.kind === 'squad') {
      if ((node.members || []).length >= U.teamKindInit('squad').max) return null;
      return { squad: node, index: (node.members || []).length };
    }
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].kind === 'alliance') continue;
      var hit = firstEmptySlot(kids[i]);
      if (hit) return hit;
    }
    return null;
  }

  /* 落位后把配置窗口切到目标小队所在团队，让落点可见 */
  function focusSquadInConfig(squadId) {
    var tabs = configAlliances();
    var hitTab = null;
    var hitWrap = null;
    tabs.forEach(function (tab) {
      if (hitWrap) return;
      tab.teams.forEach(function (w) {
        if (hitWrap) return;
        if (w.squadOnly && w.squadOnly.id === squadId) { hitWrap = w; hitTab = tab; return; }
        if ((w.squads || []).some(function (s) { return s.id === squadId; })) { hitWrap = w; hitTab = tab; }
      });
    });
    if (hitTab) {
      configState.allianceId = hitTab.id;
      configState.teamId = hitWrap.id;
      configState.drawer = null;
    }
  }

  function clearDropHint() {
    qa('.slot-tile').forEach(function (t) { t.classList.remove('drop-ok', 'drop-bad'); });
    qa('.squad-col-head').forEach(function (h) { h.classList.remove('drop-ok', 'drop-bad'); });
    qa('.config-tab').forEach(function (t) { t.classList.remove('drop-ok', 'drop-bad'); });
    var trash = q('#configTrash');
    if (trash) trash.classList.remove('drop-ok', 'drop-bad');
    var overlay = q('#teamOverlay');
    if (overlay) overlay.classList.remove('drag-outside');
    hideDragHint();
  }

  function resetSlotDrag() {
    slotDrag = null;
    dropConsumed = false;
    clearDropHint();
    qa('.slot-tile.dragging').forEach(function (el) { el.classList.remove('dragging'); });
    var overlay = q('#teamOverlay');
    if (overlay) overlay.classList.remove('dragging');
  }

  /* 拖出面板 / 拖到「移出」区域：直接移除，写入撤销栈，可 Ctrl+Z 找回 */
  function removeMemberNow(memberId, reason) {
    var found = GM.findMember(memberId);
    if (!found) return false;
    var name = nameOf(found.member);
    if (configState.drawer && configState.drawer.memberId === memberId) configState.drawer = null;
    var sel = GM.state.ui.selected;
    if (sel && sel.type === 'member' && sel.id === memberId) {
      GM.state.ui.selected = null;
      GM.bus.emit('selection');
    }
    var isPool = !!found.pool;
    if (isPool) GM.removePoolMember(found.member.id);
    else GM.deleteMember(found.squad.id, found.member.id);
    GM.commit(isPool ? '移出候补池' : '移出队员');
    if (isPool) renderPool();
    if (GM.ui && GM.ui.toast) {
      GM.ui.toast('已移出「' + name + '」（' + (reason || '拖出面板') + '），Ctrl+Z 可撤销', 'success');
    }
    return true;
  }

  /* ============================ 预设：存 / 载 / 覆盖 / 复制 / 删 ============================ */

  function snapshotNode(node) {
    if (!node) return null;
    var clone = U.clone(node);
    return clone;
  }

  function regenerateIds(node) {
    node.id = U.uid('team');
    (node.children || []).forEach(regenerateIds);
    (node.members || []).forEach(function (m) {
      m.id = U.uid('member');
      if (!Array.isArray(m.skills)) m.skills = [];
    });
  }

  function presetScopeNodes() {
    var tabs = configAlliances();
    var tab = activeAllianceTab(tabs);
    var w = activeTeamWrapper(tabs);
    var squads = w ? (w.squads || []) : [];
    return {
      alliance: tab && !tab.synthetic ? tab.node : null,
      team: w && w.node ? w.node : null,
      squads: squads,
      teamName: w ? w.name : ''
    };
  }

  function openPresetSave() {
    var scopes = presetScopeNodes();
    var squadOpts = scopes.squads.map(function (s, i) {
      return '<option value="' + U.esc(s.id) + '">小队 ' + (i + 1) + ' · ' + U.esc(s.name) + '（' + (s.members || []).length + '/6）</option>';
    }).join('');

    var body = '<div class="field"><label>保存范围</label><select id="presetScopeSelect">' +
        '<option value="team">当前团队（5×6，最多 30 人）</option>' +
        '<option value="alliance">当前联盟（全部团队）</option>' +
        '<option value="squad">指定小队（6 人）</option>' +
      '</select></div>' +
      '<div class="field" id="presetSquadField" style="display:none"><label>选择小队</label><select id="presetSquadSelect">' +
        (squadOpts || '<option value="">（当前团队没有小队）</option>') +
      '</select></div>' +
      '<div class="field"><label>预设名称</label><input type="text" id="presetNameInput" maxlength="40" spellcheck="false" value="' +
        U.esc(scopes.teamName || '编成预设') + '"></div>' +
      '<div class="modal-hint">预设记录每个格子的角色名、职业、形态与位置；随工程写入 localStorage 与导出的 JSON。</div>';

    var foot = '<button type="button" class="btn ghost" data-modal-cancel>取消</button>' +
      '<button type="button" class="btn gold" data-modal-ok>保存预设</button>';

    var root = q('#modalRoot');
    if (!root) return;
    root.innerHTML = '<div class="modal" role="dialog" aria-modal="true">' +
      '<div class="modal-head"><div><h3>保存编成预设</h3><div class="modal-sub">快照当前配置窗口里的编成</div></div></div>' +
      '<div class="modal-body">' + body + '</div>' +
      '<div class="modal-foot">' + foot + '</div>' +
      '</div>';
    root.classList.remove('hidden');

    function close() {
      root.classList.add('hidden');
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    }
    document.addEventListener('keydown', onKey);

    var scopeSel = root.querySelector('#presetScopeSelect');
    var squadField = root.querySelector('#presetSquadField');
    var nameInput = root.querySelector('#presetNameInput');
    scopeSel.addEventListener('change', function () {
      squadField.style.display = scopeSel.value === 'squad' ? '' : 'none';
    });
    root.querySelector('[data-modal-cancel]').addEventListener('click', close);
    root.addEventListener('mousedown', function (e) { if (e.target === root) close(); });

    root.querySelector('[data-modal-ok]').addEventListener('click', function () {
      var scope = scopeSel.value;
      var node = null;
      if (scope === 'team') node = scopes.team;
      else if (scope === 'alliance') node = scopes.alliance;
      else {
        var sid = root.querySelector('#presetSquadSelect').value;
        scopes.squads.forEach(function (s) { if (s.id === sid) node = s; });
      }
      if (!node) {
        GM.ui.toast(scope === 'alliance' ? '当前没有可保存的联盟（顶层散编无法存为联盟预设）' : '当前没有可保存的对象', 'error');
        return;
      }
      var name = String(nameInput.value || '').trim() || node.name;
      var preset = {
        id: U.uid('preset'),
        name: name,
        kind: node.kind,
        node: snapshotNode(node),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      GM.state.project.presets.push(preset);
      close();
      GM.commit('保存编成预设');
      GM.ui.toast('已保存预设「' + name + '」（' + U.teamKindInit(node.kind).label + '）', 'success');
    });

    setTimeout(function () { nameInput.focus(); nameInput.select(); }, 30);
  }

  function applyPresetAsLive(preset, silent) {
    var node = U.clone(preset.node);
    node.name = preset.name;
    regenerateIds(node);
    var project = GM.state.project;
    var alliance = null;
    var team = null;

    if (node.kind === 'alliance') {
      project.teams = [node];
      alliance = node;
      var teams0 = (node.children || []).filter(function (n) { return n.kind === 'team'; });
      team = teams0[0] || null;
    } else if (node.kind === 'team') {
      alliance = GM.newTeam('alliance', '联盟1');
      node.factionId = node.factionId || alliance.factionId || 'A';
      alliance.children.push(node);
      project.teams = [alliance];
      team = node;
    } else {
      alliance = GM.newTeam('alliance', '联盟1');
      team = GM.newTeam('team', '团队1');
      node.factionId = node.factionId || 'A';
      team.children.push(node);
      alliance.children.push(team);
      project.teams = [alliance];
    }

    ensureSkeleton();
    configState.allianceId = alliance.id;
    configState.teamId = team ? team.id : null;
    configState.drawer = null;
    GM.state.ui.selected = null;
    GM.commit('载入编成预设（覆盖实时编成）');
    openConfig();
    if (!silent) {
      GM.ui.toast('已用预设「' + preset.name + '」覆盖当前实时编成（Ctrl+Z 可撤销）', 'success');
    }
    return true;
  }

  function loadPresetToConfig(preset, silent) {
    if (!preset || !preset.node) return false;
    if (silent) return applyPresetAsLive(preset, true);
    GM.ui.confirm('载入预设将覆盖当前编成',
      '当前实时编成会被预设「' + preset.name + '」替换（' + GM.presetCount(preset) + ' 个成员）。\n载入后可用 Ctrl+Z 撤销。',
      '载入并覆盖').then(function (ok) {
        if (ok) applyPresetAsLive(preset);
      });
    return true;
  }

  function overwritePreset(preset) {
    var scopes = presetScopeNodes();
    var node = null;
    if (preset.kind === 'team') node = scopes.team;
    else if (preset.kind === 'alliance') node = scopes.alliance;
    else node = scopes.squads.length ? scopes.squads[0] : null;

    if (!node || node.kind !== preset.kind) {
      GM.ui.toast('当前配置窗口里没有同层级的编成可覆盖（' + U.teamKindInit(preset.kind).label + '）', 'error');
      return;
    }
    GM.ui.confirm('覆盖预设', '用当前' + U.teamKindInit(preset.kind).label + '「' + node.name + '」覆盖预设「' + preset.name + '」？', '覆盖').then(function (ok) {
      if (!ok) return;
      preset.node = snapshotNode(node);
      preset.name = preset.name;
      preset.updatedAt = new Date().toISOString();
      GM.commit('覆盖编成预设');
      GM.ui.toast('已覆盖预设「' + preset.name + '」', 'success');
    });
  }

  function copyPreset(preset) {
    var copy = U.clone(preset);
    copy.id = U.uid('preset');
    copy.name = preset.name + ' 副本';
    copy.createdAt = new Date().toISOString();
    copy.updatedAt = copy.createdAt;
    GM.state.project.presets.push(copy);
    GM.commit('复制编成预设');
    GM.ui.toast('已复制预设「' + preset.name + '」', 'success');
    return copy;
  }

  function renamePreset(preset) {
    GM.ui.promptText('重命名预设', '预设名称', preset.name).then(function (name) {
      if (name == null || !String(name).trim()) return;
      preset.name = String(name).trim();
      GM.commit('重命名编成预设');
    });
  }

  function deletePreset(preset, after) {
    GM.ui.confirm('删除预设', '确定删除预设「' + preset.name + '」？沙盘上已生成的标记不会自动删除。', '删除').then(function (ok) {
      if (!ok) return;
      var list = GM.state.project.presets;
      var idx = list.indexOf(preset);
      if (idx > -1) list.splice(idx, 1);
      GM.commit('删除编成预设');
      GM.ui.toast('已删除预设「' + preset.name + '」', 'success');
      if (after) after();
    });
  }

  function openPresetList() {
    var presets = GM.presets();
    var body;
    if (!presets.length) {
      body = '<div class="modal-hint">还没有任何预设。先在编队配置里点「保存预设」。</div>';
    } else {
      body = '<div class="modal-hint">预设按创建顺序排列。载入会用预设替换当前实时编成（Ctrl+Z 可撤销），并打开编队配置。</div>' +
        '<div class="preset-manage-list">' + presets.map(function (p) {
          return '<div class="preset-manage-row" data-manage-id="' + U.esc(p.id) + '">' +
            scaleBadge(p) +
            '<span class="preset-manage-name" title="' + U.esc(p.name) + '">' + U.esc(p.name) + '</span>' +
            '<span class="preset-manage-meta">' + U.esc(U.dateStamp(new Date(p.createdAt))) + '</span>' +
            '<div class="preset-manage-actions">' +
              '<button type="button" class="btn mini gold" data-manage-act="load">载入</button>' +
              '<button type="button" class="btn mini" data-manage-act="overwrite" title="用当前窗口中的同层级编成覆盖">覆盖</button>' +
              '<button type="button" class="btn mini" data-manage-act="copy">复制</button>' +
              '<button type="button" class="btn mini" data-manage-act="rename">改名</button>' +
              '<button type="button" class="btn mini danger" data-manage-act="delete">删除</button>' +
            '</div>' +
            '</div>';
        }).join('') + '</div>';
    }
    var foot = '<button type="button" class="btn ghost" data-modal-cancel>关闭</button>' +
      '<button type="button" class="btn gold" data-modal-ok>保存当前团队为新预设</button>';

    var root = q('#modalRoot');
    root.innerHTML = '<div class="modal" role="dialog" aria-modal="true">' +
      '<div class="modal-head"><div><h3>编成预设列表</h3><div class="modal-sub">共 ' + presets.length + ' 个预设</div></div></div>' +
      '<div class="modal-body">' + body + '</div>' +
      '<div class="modal-foot">' + foot + '</div>' +
      '</div>';
    root.classList.remove('hidden');

    function close() {
      root.classList.add('hidden');
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    }
    document.addEventListener('keydown', onKey);

    root.querySelector('[data-modal-cancel]').addEventListener('click', close);
    root.addEventListener('mousedown', function (e) { if (e.target === root) close(); });
    root.querySelector('[data-modal-ok]').addEventListener('click', function () {
      close();
      openPresetSave();
    });

    root.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-manage-act]');
      if (!btn) return;
      var row = e.target.closest('[data-manage-id]');
      if (!row) return;
      var preset = GM.findPreset(row.getAttribute('data-manage-id'));
      if (!preset) return;
      var act = btn.getAttribute('data-manage-act');
      if (act === 'load') { close(); loadPresetToConfig(preset); }
      else if (act === 'overwrite') { overwritePreset(preset); }
      else if (act === 'copy') { copyPreset(preset); close(); }
      else if (act === 'rename') { renamePreset(preset); close(); }
      else if (act === 'delete') { deletePreset(preset, function () { close(); openPresetList(); }); }
    });
  }

  /* ============================ 打开 / 关闭配置窗口 ============================ */

  function openConfig() {
    var overlay = q('#teamOverlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    overlay.classList.remove('dragging');
    ensureConfigSelection();
    fillPoolFilters();
    var search = q('#poolSearch');
    if (search) search.value = poolState.search || '';
    renderConfig();
    syncWinButtons();
    saveOpenState();
    var body = q('#overviewBody');
    if (body) body.scrollTop = 0;
  }

  function closeConfig() {
    var overlay = q('#teamOverlay');
    if (!overlay) return;
    if (configState.drawer) {
      /* 实时保存语义：关闭窗口视为确认，抽屉内改动落盘 */
      saveDrawer();
    }
    overlay.classList.add('hidden');
    overlay.classList.remove('dragging', 'drag-outside', 'is-focused');
    rosterPending = null;
    rosterModal('rosterPreview', false);
    rosterModal('rosterExport', false);
    rosterModal('rosterTemplateHint', false);
    clearDropHint();
    syncWinButtons();
    saveOpenState();
  }

  function isConfigOpen() {
    var overlay = q('#teamOverlay');
    return !!overlay && !overlay.classList.contains('hidden');
  }

  /* ============================ 事件绑定：配置窗口 ============================ */

  function bindConfig() {
    var overlay = q('#teamOverlay');
    if (!overlay) return;

    q('#btnTeamConfig').addEventListener('click', openConfig);
    q('#btnConfigClose').addEventListener('click', closeConfig);
    q('#btnPresetSave').addEventListener('click', openPresetSave);
    q('#btnPresetList').addEventListener('click', openPresetList);

    /* 配置面板批量：进入/退出 + 批量操作条 */
    var batchBtn = q('#btnBatchSelect');
    if (batchBtn) batchBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleBatch(); });

    var batchBarEl = q('#batchBar');
    if (batchBarEl) {
      /* 批量改职业/形态：切换职业即时收窄形态下拉，并把当前选择记到 configBatch（跨重绘保留） */
      batchBarEl.addEventListener('change', function (e) {
        var t = e.target;
        if (!t || !t.getAttribute) return;
        if (t.hasAttribute('data-batch-class')) {
          configBatch.classId = t.value;
          configBatch.form = defaultForm(t.value);
          var formSel = q('[data-batch-form]', batchBarEl);
          if (formSel) formSel.innerHTML = formOptsSelHtml(configBatch.classId, configBatch.form);
          return;
        }
        if (t.hasAttribute('data-batch-form')) configBatch.form = t.value;
      });
      batchBarEl.addEventListener('click', function (e) {
        var btn = e.target.closest('button');
        if (!btn) return;
        var act = btn.hasAttribute('data-batch-all') ? 'all'
          : btn.hasAttribute('data-batch-squad-all') ? 'squad-all'
          : btn.hasAttribute('data-batch-class-all') ? 'class-all'
          : btn.hasAttribute('data-batch-apply-class') ? 'apply-class'
          : btn.hasAttribute('data-batch-pool') ? 'pool'
          : btn.hasAttribute('data-batch-move') ? 'move'
          : btn.hasAttribute('data-batch-clear') ? 'clear'
          : btn.hasAttribute('data-batch-del') ? 'del'
          : btn.hasAttribute('data-batch-exit') ? 'exit' : '';
        if (!act) return;
        e.preventDefault();
        e.stopPropagation();

        if (act === 'exit') { exitBatch(); return; }
        if (act === 'all') {
          var teamIds = allMembersInCurrentTeam();
          var allPicked = teamIds.length > 0 && teamIds.every(function (id) { return !!configBatch.sel[id]; });
          if (allPicked) configBatch.sel = {};
          else setBatchSel(teamIds, false);
          renderConfig();
          return;
        }
        if (act === 'squad-all') {
          var sq = currentBatchSquad();
          if (!sq) { GM.ui.toast('当前没有小队', 'error'); return; }
          setBatchSel(allMembersInSquad(sq.id), false);
          configBatch.lastSquadId = sq.id;
          renderConfig();
          return;
        }
        if (act === 'class-all') {
          var fsel = q('[data-batch-class-filter]', batchBarEl);
          var classId = fsel ? fsel.value : '';
          if (!classId) { GM.ui.toast('先在左侧下拉里选职业再「按职业全选」', 'error'); return; }
          setBatchSel(membersByClass(classId), false);
          renderConfig();
          return;
        }
        if (act === 'apply-class') {
          var csel = q('[data-batch-class]', batchBarEl);
          var msel = q('[data-batch-form]', batchBarEl);
          if (!csel || !csel.value) { GM.ui.toast('先选目标职业', 'error'); return; }
          /* 先记住下拉当前选择：应用后面板重绘仍保持该职业/形态，不跳回默认第一项 */
          configBatch.classId = csel.value;
          configBatch.form = normalizeForm(csel.value, msel ? msel.value : '');
          applyConfigBatch('class-form', { classId: configBatch.classId, form: configBatch.form });
          return;
        }
        if (act === 'pool') { applyConfigBatch('pool'); return; }
        if (act === 'move') {
          var ssel = q('[data-batch-squad]', batchBarEl);
          if (!ssel || !ssel.value) { GM.ui.toast('先选目标小队', 'error'); return; }
          var parts = ssel.value.split('|');
          applyConfigBatch('move', { teamNo: Number(parts[0]), squadNo: Number(parts[1]) });
          return;
        }
        if (act === 'clear') { applyConfigBatch('clear-slots'); return; }
        if (act === 'del') {
          var n = batchIds().length;
          GM.ui.confirm('批量删除', '确定删除选中的 ' + n + ' 人？（可用 Ctrl+Z 撤销）', '删除')
            .then(function (ok) { if (ok) applyConfigBatch('delete'); });
        }
      });
    }

    /* 批量模式：面板空白处按下拖出矩形框选 */
    var batchDrag = null;
    var batchBoxEl = null;

    overlay.addEventListener('click', function (e) {
      var target = e.target;

      var tabA = target.closest('[data-alliance-id]');
      if (tabA) { setConfigAlliance(tabA.getAttribute('data-alliance-id')); return; }
      if (target.closest('[data-alliance-add]')) { addAlliance(); return; }
      if (target.closest('[data-alliance-rename]')) {
        var at = activeAllianceTab();
        if (at && at.node) renameTeamNode(at.node);
        return;
      }
      if (target.closest('[data-alliance-delete]')) {
        var at2 = activeAllianceTab();
        if (at2 && at2.node) {
          deleteTeamNode(at2.node);
          configState.allianceId = null;
          configState.teamId = null;
        }
        return;
      }

      var tabT = target.closest('[data-team-id]');
      if (tabT) {
        flushDrawer();
        configState.teamId = tabT.getAttribute('data-team-id');
        renderConfig();
        return;
      }
      if (target.closest('[data-team-add]')) { addTeam(); return; }
      if (target.closest('[data-team-rename]')) {
        var w = activeTeamWrapper();
        if (w && w.node) renameTeamNode(w.node);
        return;
      }
      if (target.closest('[data-team-delete]')) {
        var w2 = activeTeamWrapper();
        if (w2 && w2.node) {
          deleteTeamNode(w2.node);
          configState.teamId = null;
        }
        return;
      }

      var renameSquad = target.closest('[data-squad-rename]');
      if (renameSquad) {
        var sq1 = GM.findTeam(renameSquad.getAttribute('data-squad-rename'));
        if (sq1) renameTeamNode(sq1);
        return;
      }
      var delSquad = target.closest('[data-squad-delete]');
      if (delSquad) {
        var sq2 = GM.findTeam(delSquad.getAttribute('data-squad-delete'));
        if (sq2) {
          deleteTeamNode(sq2);
          configState.drawer = null;
        }
        return;
      }
      var addSq = target.closest('[data-squad-add]');
      if (addSq) { addSquad(addSq.getAttribute('data-squad-add')); return; }

      var tile = target.closest('.slot-tile');
      if (tile) {
        var memberId = tile.getAttribute('data-member-id');
        if (configBatch.on) {
          if (memberId) toggleBatchPick(memberId, tile.getAttribute('data-squad-id'), e.shiftKey);
          return;
        }
        if (memberId) { openDrawer(memberId); return; }
        /* 点空格生成队员前先落盘上一个成员的改动，再收起抽屉 */
        if (configState.drawer) { flushDrawer(); renderConfig(); }
        var squadId = tile.getAttribute('data-squad-id');
        var slotIndex = Number(tile.getAttribute('data-slot-index')) || 0;
        if (squadId) {
          var squad3 = GM.findTeam(squadId);
          createMemberAt(squad3, slotIndex);
        } else {
          GM.ui.toast('该列还没有小队，刷新后会自动补齐固定骨架', 'error');
        }
        return;
      }

      /* 点色块以外的空白区域 = 关闭抽屉，回到「显示全部团员」的整体视图；
         上一个成员的改动已实时写回（只提交待落盘的防抖，不回滚） */
      if (configState.drawer && !target.closest('#memberDrawer')) {
        flushDrawer();
        renderConfig();
      }
    });

    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') e.stopPropagation();
    });

    /* 抽屉输入：实时写回色块 */
    var drawerEl = q('#memberDrawer');
    if (drawerEl) {
      drawerEl.addEventListener('input', handleDrawerInput);
      drawerEl.addEventListener('change', handleDrawerInput);
      drawerEl.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-drawer]');
        if (!btn) return;
        var act = btn.getAttribute('data-drawer');
        if (act === 'save') saveDrawer();
        else if (act === 'cancel' || act === 'close') cancelDrawer(false);
        else if (act === 'remove') {
          var d = configState.drawer;
          if (!d) return;
          var found = GM.findMember(d.memberId);
          if (!found) { closeDrawer(); return; }
          var isPoolMember = !!found.pool;
          GM.ui.confirm(isPoolMember ? '移出候补池' : '移出队伍',
            '确定把「' + nameOf(found.member) + '」' + (isPoolMember ? '移出候补池' : '移出队伍') + '？可用撤销恢复。',
            '移出').then(function (ok) {
            if (!ok) return;
            configState.drawer = null;
            if (isPoolMember) GM.removePoolMember(found.member.id);
            else GM.deleteMember(found.squad.id, found.member.id);
            GM.commit(isPoolMember ? '移出候补池' : '移出队员');
            GM.ui.toast('已移出「' + nameOf(found.member) + '」', 'success');
            renderConfig();
          });
        }
      });
    }

    /* 配置内拖动：换位 / 交换 / 移出 */
    var stack = q('#squadStack');

    /* 批量框选：空白处按下拖矩形，松手选中相交的色块 */
    stack.addEventListener('mousedown', function (e) {
      if (!configBatch.on || e.button !== 0) return;
      if (e.target.closest('.slot-tile') || e.target.closest('.squad-col-head') ||
        e.target.closest('button') || e.target.closest('select')) return;
      batchDrag = { x0: e.clientX, y0: e.clientY, moved: false, additive: e.shiftKey };
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!batchDrag) return;
      var dx = Math.abs(e.clientX - batchDrag.x0);
      var dy = Math.abs(e.clientY - batchDrag.y0);
      if (!batchDrag.moved && dx < 5 && dy < 5) return;
      batchDrag.moved = true;
      if (!batchBoxEl) {
        batchBoxEl = document.createElement('div');
        batchBoxEl.className = 'batch-box';
        document.body.appendChild(batchBoxEl);
      }
      batchBoxEl.style.left = Math.min(batchDrag.x0, e.clientX) + 'px';
      batchBoxEl.style.top = Math.min(batchDrag.y0, e.clientY) + 'px';
      batchBoxEl.style.width = dx + 'px';
      batchBoxEl.style.height = dy + 'px';
    });
    document.addEventListener('mouseup', function (e) {
      if (!batchDrag) return;
      var d = batchDrag;
      batchDrag = null;
      if (batchBoxEl) {
        if (batchBoxEl.parentNode) batchBoxEl.parentNode.removeChild(batchBoxEl);
        batchBoxEl = null;
      }
      if (!d.moved || !configBatch.on) return;
      var ids = batchHitsInRect(d.x0, d.y0, e.clientX, e.clientY);
      if (!ids.length) return;
      setBatchSel(ids, d.additive);
      var last = ids[ids.length - 1];
      configBatch.lastId = last;
      var lastEl = q('[data-batch-id="' + last + '"]');
      if (lastEl) configBatch.lastSquadId = lastEl.getAttribute('data-squad-id') || configBatch.lastSquadId;
      renderConfig();
    });

    /* 双击列头重命名小队 */
    stack.addEventListener('dblclick', function (e) {
      if (e.target.closest('[data-squad-delete]')) return;
      var head = e.target.closest('[data-col-rename]');
      if (!head) return;
      var sq = GM.findTeam(head.getAttribute('data-col-rename'));
      if (sq) renameTeamNode(sq);
    });

    stack.addEventListener('dragstart', function (e) {
      var tile = e.target.closest('.slot-tile.filled');
      if (!tile) return;
      var memberId = tile.getAttribute('data-member-id');
      var found = GM.findMember(memberId);
      if (!memberId || !found) return;
      slotDrag = { memberId: memberId, fromSquadId: found.squad ? found.squad.id : '', el: tile };
      dropConsumed = false;
      setDragData(e, MIME_SLOT, { type: 'slot', memberId: memberId, squadId: found.squad ? found.squad.id : '' });
      makeDragGhost(e, found.member);
      tile.classList.add('dragging');
      overlay.classList.add('dragging');
      if (configState.drawer) flushDrawer();
      showDragHint('拖到格子 = 换位 / 交换 · 拖到团队或联盟页签 = 换团队 · 拖出面板 = 移出');
    });

    stack.addEventListener('dragend', function () {
      var drag = slotDrag;
      var outside = !!drag && !dropConsumed && isConfigOpen() && !pointerInsideShell();
      resetSlotDrag();
      if (outside) removeMemberNow(drag.memberId, '拖出面板');
    });

    stack.addEventListener('dragover', function (e) {
      var drag = slotDrag || readDrag(e, MIME_SLOT);
      if (!drag || !drag.memberId) return;
      var t = targetSquadOf(e.target);
      clearDropHint();
      if (!t || !t.squad) {
        showDragHint('拖到格子、团队页签或联盟页签上；拖出面板 = 移出队员');
        return;
      }
      var check = canMoveTo(drag.memberId, t.squad, t.index);
      t.tile.classList.add(check.ok ? 'drop-ok' : 'drop-bad');
      var col = t.tile.closest('.squad-col');
      if (col) {
        var colHead = col.querySelector('.squad-col-head');
        if (colHead) colHead.classList.add(check.ok ? 'drop-ok' : 'drop-bad');
      }
      if (check.ok) {
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* noop */ }
        showDragHint((check.action === 'swap' ? '交换到' : '移到') + t.squad.name + ' 第 ' + (t.index + 1) + ' 格');
      } else if (check.msg) {
        showDragHint(check.msg, true);
      }
    });

    stack.addEventListener('dragleave', function (e) {
      if (!stack.contains(e.relatedTarget)) clearDropHint();
    });

    stack.addEventListener('drop', function (e) {
      var drag = slotDrag || readDrag(e, MIME_SLOT);
      if (!drag || !drag.memberId) { clearDropHint(); return; }
      var t = targetSquadOf(e.target);
      if (!t || !t.squad) { clearDropHint(); return; }
      e.preventDefault();
      e.stopPropagation();
      dropConsumed = true;
      var result = performMove(drag.memberId, t.squad, t.index);
      resetSlotDrag();
      if (!result.ok) {
        if (result.msg) GM.ui.toast(result.msg, 'error');
        return;
      }
      var fromPool = !!drag.fromPool;
      GM.commit(fromPool
        ? (result.action === 'swap' ? '候补池调入并交换' : '候补池调入正式队')
        : (result.action === 'swap' ? '交换队员位置' : '调整队员位置'));
      GM.ui.toast(fromPool
        ? (result.action === 'swap' ? '已调入并交换（原队员回到候补池）' : '已从候补池调入')
        : (result.action === 'swap' ? '已交换两名队员' : '已调整队员位置'), 'success');
    });

    /* 联盟页签 / 团队页签 = 跨联盟、跨团队移动，自动落到目标下第一个空位 */
    [q('#allianceTabs'), q('#teamTabs')].forEach(function (row) {
      if (!row) return;

      row.addEventListener('dragover', function (e) {
        if (!slotDrag) return;
        var drop = dropNodeOf(e.target);
        if (!drop) return;
        clearDropHint();
        var slot = firstEmptySlot(drop.node);
        if (!slot) {
          drop.el.classList.add('drop-bad');
          showDragHint(drop.label + ' 已无空位（小队上限 6 人）', true);
          return;
        }
        var check = canMoveTo(slotDrag.memberId, slot.squad, slot.index);
        if (!check.ok) {
          drop.el.classList.add('drop-bad');
          showDragHint(check.msg || '无法移动到该页签', true);
          return;
        }
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* noop */ }
        drop.el.classList.add('drop-ok');
        showDragHint('移到' + drop.label + ' · ' + slot.squad.name + ' 第 ' + (slot.index + 1) + ' 格');
      });

      row.addEventListener('dragleave', function (e) {
        if (!row.contains(e.relatedTarget)) clearDropHint();
      });

      row.addEventListener('drop', function (e) {
        if (!slotDrag) return;
        var drop = dropNodeOf(e.target);
        if (!drop) return;
        var slot = firstEmptySlot(drop.node);
        e.preventDefault();
        e.stopPropagation();
        if (!slot) {
          clearDropHint();
          GM.ui.toast(drop.label + ' 已无空位（小队上限 6 人）', 'error');
          resetSlotDrag();
          return;
        }
        var memberId = slotDrag.memberId;
        var result = performMove(memberId, slot.squad, slot.index);
        dropConsumed = true;
        resetSlotDrag();
        if (!result.ok) {
          if (result.msg) GM.ui.toast(result.msg, 'error');
          return;
        }
        focusSquadInConfig(slot.squad.id);
        GM.commit(drop.kind === 'alliance' ? '跨联盟移动队员' : '跨团队移动队员');
        GM.ui.toast('已移到' + drop.label + ' · ' + slot.squad.name + ' 第 ' + (slot.index + 1) + ' 格', 'success');
      });
    });

    /* 「移出」区域：拖动松手 = 直接移出（可撤销） */
    var trash = q('#configTrash');
    if (trash) {
      trash.addEventListener('dragover', function (e) {
        if (!slotDrag) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* noop */ }
        trash.classList.add('drop-ok');
        var found = GM.findMember(slotDrag.memberId);
        showDragHint('松手移出「' + (found ? nameOf(found.member) : '该队员') + '」（可撤销）', true);
      });
      trash.addEventListener('dragleave', function () {
        trash.classList.remove('drop-ok');
        hideDragHint();
      });
      trash.addEventListener('drop', function (e) {
        if (!slotDrag) return;
        e.preventDefault();
        e.stopPropagation();
        var memberId = slotDrag.memberId;
        dropConsumed = true;
        resetSlotDrag();
        removeMemberNow(memberId, '拖到移出区域');
      });
    }

    /* 拖出配置面板（含拖到浏览器窗口外）：松手即移出；dragover 用指针位置判定 */
    document.addEventListener('dragover', function (e) {
      if (!slotDrag) return;
      dragPointer.x = e.clientX;
      dragPointer.y = e.clientY;
      if (!isConfigOpen()) return;
      if (pointerInsideShell()) {
        overlay.classList.remove('drag-outside');
        return;
      }
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* noop */ }
      overlay.classList.add('drag-outside');
      var found = GM.findMember(slotDrag.memberId);
      showDragHint('松手移出「' + (found ? nameOf(found.member) : '该队员') + '」（可撤销）', true);
    });

    document.addEventListener('drop', function (e) {
      if (!dropConsumed && slotDrag && isConfigOpen() && !pointerInsideShell()) {
        e.preventDefault();
        var memberId = slotDrag.memberId;
        dropConsumed = true;
        resetSlotDrag();
        removeMemberNow(memberId, '拖出面板');
      }
    });

    /* 编队视图快捷键：Esc 一次关闭整窗；Ctrl+Z / Ctrl+Shift+Z 编成撤销 / 重做
       （捕获阶段，避免被主界面快捷键吃掉） */
    document.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey;

      if (!isConfigOpen()) return;

      if (mod && !e.altKey && e.key.toLowerCase() === 'z') {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) GM.redo(); else GM.undo();
        return;
      }

      if (e.key !== 'Escape') return;
      /* Esc 先退出配置面板的批量选择模式，再按窗口层级关闭 */
      if (configBatch.on && isConfigOpen()) {
        e.preventDefault();
        e.stopPropagation();
        exitBatch();
        GM.ui.toast('已退出批量模式');
        return;
      }
      if (anyRosterModalOpen()) {
        e.preventDefault();
        e.stopPropagation();
        rosterPending = null;
        rosterModal('rosterImport', false);
        rosterModal('rosterPreview', false);
        rosterModal('rosterExport', false);
        rosterModal('rosterTemplateHint', false);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (configState.drawer) { cancelDrawer(false); return; }
      closeConfig();
    }, true);
  }

  /* ============================ 一键导入 / 一键导出 ============================ */

  var rosterPending = null;       // buildPlan 结果
  var rosterFileName = '';
  var rosterRecognized = null;    // GM.templateImport.parse 结果

  function rosterModal(id, open) {
    var el = q('#' + id);
    if (!el) return;
    if (open) el.classList.remove('hidden');
    else el.classList.add('hidden');
  }

  function anyRosterModalOpen() {
    return ['rosterImport', 'rosterPreview', 'rosterExport', 'rosterTemplateHint'].some(function (id) {
      var el = q('#' + id);
      return !!(el && !el.classList.contains('hidden'));
    });
  }

  function rosterPosition(it) {
    var parts = [];
    if (it.alliance) parts.push(it.alliance.name);
    if (it.team) parts.push(it.team.name);
    if (it.squad) parts.push(it.squad.name);
    parts.push('第 ' + (it.slot + 1) + ' 格');
    return U.esc(parts.join(' / '));
  }

  function memberBrief(member) {
    if (!member) return '—';
    var cls = className(member.classId) || '职业';
    var form = normalizeForm(member.classId, member.form || '');
    return U.esc(member.name + ' · ' + cls + '·' + form);
  }

  function sourceText(source) {
    if (!source) return '—';
    var parts = [];
    if (source.sheet) parts.push('『' + source.sheet + '』');
    if (source.column) parts.push(source.column);
    if (source.row) parts.push('第 ' + source.row + ' 行');
    return U.esc(parts.join(' ') || '—');
  }

  /* 预览态：直接画成编队面板的色块网格（半透明「即将落地」块），现有编成与预览结果左右分栏 */
  var previewEdit = {         // 预览内编辑状态（不影响工程撤销栈）
    sel: {}, editing: '', undo: [], redo: [],
    batchClass: '', batchForm: '',   /* 批量改职业/形态下拉的选择，跨重绘保留 */
    opts: { overflowMode: 'pool' }
  };

  function pvSquads(team) {
    return (team.children || []).filter(function (n) { return n.kind === 'squad'; });
  }

  function pvCellHtml(item, squad, slot) {
    var color = classColor(item.member.classId);
    var form = item.member.form || normalizeForm(item.member.classId, '');
    var picked = !!previewEdit.sel[item.uid];
    var cls = 'pv-cell ghost' + (item.existing ? ' is-conflict' : '') + (item.inferred ? ' is-inferred' : '') +
      (picked ? ' is-selected' : '');
    var tag = '';
    if (item.existing) tag = '<i class="pv-tag is-over">覆盖 ' + U.esc(item.existing.name) + '</i>';
    else if (item.colorMiss) tag = '<i class="pv-tag is-unknown" title="未识别颜色 ' + U.esc(item.unknownColor || item.color || '') + '：按行序默认回落">色?</i>';
    else if (item.classOrigin === 'default') tag = '<i class="pv-tag is-default" title="无职业线索：按行序常识默认填充">默</i>';
    else if (item.classOrigin === 'manual') tag = '<i class="pv-tag is-manual" title="预览内手动改判">改</i>';
    var originText = item.colorMiss ? ' · 未识别颜色 ' + (item.unknownColor || item.color || '') + '，按行序默认填充' :
      item.classOrigin === 'default' ? ' · 无线索，按行序默认填充' :
        item.classOrigin === 'manual' ? ' · 手动改判' :
          item.classOrigin === 'text' ? ' · 文字识别' : ' · 颜色识别';
    var title = item.member.name + ' · ' + className(item.member.classId) + '·' + form +
      ' · 来源 ' + (item.source && item.source.sheet ? '『' + item.source.sheet + '』' : '') +
      (item.source && item.source.column ? item.source.column : '') +
      (item.source && item.source.row ? ' 第' + item.source.row + '行' : '') + originText;
    return '<div class="' + cls + '" style="background-color:' + U.esc(color) + ';color:' + U.esc(textOn(color)) + '"' +
      ' data-pv-uid="' + U.esc(item.uid) + '"' +
      ' data-squad-id="' + U.esc(squad ? squad.id : '') + '" data-slot="' + (slot == null ? '' : slot) + '"' +
      ' title="' + U.esc(title) + '">' +
      '<input type="checkbox" class="pv-check" data-pv-check="' + U.esc(item.uid) + '"' + (picked ? ' checked' : '') + ' title="勾选以批量操作">' +
      '<button type="button" class="pv-del" data-pv-del="' + U.esc(item.uid) + '" title="删除这一块">✕</button>' +
      '<span class="pv-name">' + U.esc(item.member.name) + '</span>' +
      '<span class="pv-sub">' + U.esc(className(item.member.classId) + '·' + form) + '</span>' + tag +
      '</div>';
  }

  /* 现有编成格：只读展示；空位不给新增按钮（新增只在右侧预览结果栏） */
  function pvExistingCellHtml(existing, rowHint, squad, slot, withAdd) {
    if (existing) {
      var color = classColor(existing.classId);
      return '<div class="pv-cell current" style="background-color:' + U.esc(color) + ';color:' + U.esc(textOn(color)) + '"' +
        ' data-squad-id="' + U.esc(squad ? squad.id : '') + '" data-slot="' + (slot == null ? '' : slot) + '"' +
        ' title="' + U.esc(memberTitle(existing)) + ' · 现有成员">' +
        '<span class="pv-name">' + U.esc(nameOf(existing)) + '</span>' +
        '<span class="pv-sub">' + U.esc(className(existing.classId) + '·' + normalizeForm(existing.classId, existing.form || '')) + '</span>' +
        '</div>';
    }
    return '<div class="pv-cell empty" data-squad-id="' + U.esc(squad ? squad.id : '') + '" data-slot="' + (slot == null ? '' : slot) + '">' +
      '<span class="pv-row-hint">' + U.esc(rowHint || '') + '</span>' +
      (withAdd && squad ? '<button type="button" class="pv-add" data-pv-add="' + U.esc(squad.id) + '" data-pv-add-slot="' + slot + '" title="在这个空格新增成员">＋</button>' : '') +
      '</div>';
  }

  function pvTeamSideHtml(g, side) {
    var squads = pvSquads(g.team);
    var cols = Math.max(5, squads.length);
    var colsHtml = '';
    for (var i = 0; i < cols; i++) {
      var sq = squads[i] || null;
      var cells = '';
      var count = 0;
      for (var slot = 0; slot < 6; slot++) {
        var it = sq ? g.cells[sq.id + '#' + slot] : null;
        var ex = sq && sq.members[slot] ? sq.members[slot] : null;
        if (side === 'preview') {
          if (it || ex) count++;
          if (it) cells += pvCellHtml(it, sq, slot);
          else cells += pvExistingCellHtml(ex, ROW_CLASSES[slot] || '', sq, slot, true);
        } else {
          if (ex) count++;
          cells += pvExistingCellHtml(ex, ROW_CLASSES[slot] || '', sq, slot, false);
        }
      }
      colsHtml += '<div class="pv-col' + (sq ? '' : ' is-empty') + '">' +
        '<div class="pv-col-head" title="小队第 ' + (i + 1) + ' 列">' +
        '<span>' + U.esc(sq ? String(sq.name || '').trim() || ('小队' + (i + 1)) : '小队' + (i + 1)) + '</span>' +
        '<i>' + count + '/6</i></div>' +
        '<div class="pv-col-body">' + cells + '</div></div>';
    }

    var existingCount = 0;
    squads.forEach(function (s) { existingCount += (s.members || []).length; });
    var conflictCount = 0;
    if (side === 'preview') {
      Object.keys(g.cells).forEach(function (k) { if (g.cells[k].existing) conflictCount++; });
    }
    var countText = side === 'preview'
      ? ('导入后 ' + (existingCount + countNew(g)) + ' 人' + (conflictCount ? ' · 冲突 ' + conflictCount : ''))
      : ('现有 ' + existingCount + ' 人');

    return '<section class="pv-team">' +
      '<header class="pv-team-head">' +
      '<h4>' + U.esc(g.team.name) + (g.alliance ? '<span class="pv-alliance">' + U.esc(g.alliance.name) + '</span>' : '') + '</h4>' +
      '<span class="pv-team-count">' + countText + '</span>' +
      '</header>' +
      '<div class="pv-cols" style="grid-template-columns:repeat(' + cols + ',minmax(0,1fr))">' + colsHtml + '</div></section>';
  }

  /* 右侧「导入后」人数 = 现有 + 落在空位上的新条目（覆盖不算新增一人） */
  function countNew(g) {
    var n = 0;
    (g.team.children || []).forEach(function (sq) {
      if (!sq || sq.kind !== 'squad') return;
      for (var slot = 0; slot < 6; slot++) {
        var it = g.cells[sq.id + '#' + slot];
        var ex = sq.members[slot];
        if (it && !ex) n++;
      }
    });
    return n;
  }

  /* 成员核对区：左=现有编成，右=预览结果（导入后），两栏共用同一团队/小队骨架 */
  function previewCompareHtml(plan) {
    var byTeam = {};
    var order = [];
    plan.items.forEach(function (it) {
      if (!it.team || !it.squad) return;   /* 单条缺团队信息的脏条目不能把整个预览渲染拖垮 */
      var key = it.team.id;
      if (!byTeam[key]) byTeam[key] = { team: it.team, alliance: it.alliance, cells: {} };
      byTeam[key].cells[it.squad.id + '#' + it.slot] = it;
    });

    function walk(node, alliance) {
      if (!node) return;
      if (node.kind === 'team') {
        var hasMembers = (node.children || []).some(function (sq) {
          return sq.kind === 'squad' && (sq.members || []).length;
        });
        if (hasMembers || byTeam[node.id]) {
          if (!byTeam[node.id]) byTeam[node.id] = { team: node, alliance: alliance, cells: {} };
          else if (!byTeam[node.id].alliance) byTeam[node.id].alliance = alliance;
          order.push(byTeam[node.id]);
        }
        return;
      }
      if (node.kind === 'alliance') {
        (node.children || []).forEach(function (c) { walk(c, node); });
      }
    }
    (GM.state.project.teams || []).forEach(function (n) { walk(n, null); });
    /* 计划里引用了但工程树里找不到的团队（脏数据）也要能看见 */
    Object.keys(byTeam).forEach(function (k) {
      if (order.indexOf(byTeam[k]) < 0) order.push(byTeam[k]);
    });

    if (!order.length) return '<p class="roster-empty">没有可落地的成员。</p>';

    var existingTotal = 0;
    var conflictTotal = 0;
    order.forEach(function (g) {
      pvSquads(g.team).forEach(function (sq) { existingTotal += (sq.members || []).length; });
      conflictTotal += Object.keys(g.cells).filter(function (k) { return !!g.cells[k].existing; }).length;
    });

    function board(side) { return order.map(function (g) { return pvTeamSideHtml(g, side); }).join(''); }

    return '<div class="pv-compare">' +
      '<div class="pv-side"><div class="pv-side-head"><b>现有编成</b>' +
      '<span>当前工程 · ' + existingTotal + ' 人</span></div>' +
      '<div class="pv-side-body"><div class="pv-board">' + board('existing') + '</div></div></div>' +
      '<div class="pv-side"><div class="pv-side-head"><b>预览结果</b>' +
      '<span>导入后 · ' + (existingTotal + countAllNew(order)) + ' 人' +
      (conflictTotal ? ' · 冲突 ' + conflictTotal : '') + '</span></div>' +
      '<div class="pv-side-body"><div class="pv-board">' + board('preview') + '</div></div></div>' +
      '</div>';
  }

  function countAllNew(order) {
    var n = 0;
    order.forEach(function (g) { n += countNew(g); });
    return n;
  }

  function previewPoolHtml(plan) {
    if (!plan.poolItems || !plan.poolItems.length) return '';
    return '<div class="pv-pool"><h4>候补池 · ' + plan.poolItems.length + ' 人 <span class="dim">（不占 30 人编制，应用后写入候补池）</span></h4>' +
      '<div class="pv-pool-list">' + plan.poolItems.map(function (pi) {
        var color = classColor(pi.member.classId);
        return '<span class="pv-pool-tile" style="background-color:' + U.esc(color) + ';color:' + U.esc(textOn(color)) + '"' +
          ' title="' + U.esc(pi.member.name + ' · ' + className(pi.member.classId) + ' · 来源 ' + sourceText(pi.source).replace(/&quot;/g, '"')) + '">' +
          U.esc(pi.member.name) +
          (pi.inferred ? '<i class="pv-tag">默认推断</i>' : '') + '</span>';
      }).join('') + '</div></div>';
  }

  /* ---- 预览编辑：守恒账 / 单块编辑 / 批量 / 预览内撤销 ---- */

  function locateSquad(squadId) {
    var out = { squad: null, team: null, alliance: null };
    if (!squadId || !GM.state.project) return out;
    function walk(node, alliance) {
      if (!node) return;
      if (node.id === squadId) { out.squad = node; return; }
      if (node.kind === 'team') {
        (node.children || []).forEach(function (c) {
          if (c.id === squadId) { out.squad = c; out.team = node; out.alliance = alliance; }
        });
        return;
      }
      (node.children || []).forEach(function (c) { walk(c, node.kind === 'alliance' ? node : alliance); });
    }
    (GM.state.project.teams || []).forEach(function (n) { walk(n, null); });
    return out;
  }

  function snapPlan(plan) {
    function ser(it) {
      return {
        uid: it.uid, squadId: it.squad ? it.squad.id : '', slot: it.slot,
        member: JSON.parse(JSON.stringify(it.member)),
        hasExisting: !!it.existing, classOrigin: it.classOrigin, classSource: it.classSource,
        inferred: !!it.inferred, color: it.color || '', source: it.source || null, pair: !!it.pair,
        manual: !!it.manual
      };
    }
    return {
      items: (plan.items || []).map(ser),
      poolItems: (plan.poolItems || []).map(ser),
      deleted: (plan.deleted || []).slice(),
      unlanded: (plan.unlanded || []).slice()
    };
  }

  function restorePlan(plan, snap) {
    function back(s) {
      var loc = locateSquad(s.squadId);
      return {
        entry: {}, uid: s.uid, squad: loc.squad, team: loc.team, alliance: loc.alliance,
        slot: s.slot, existing: loc.squad && loc.squad.members[s.slot] ? loc.squad.members[s.slot] : null,
        classOrigin: s.classOrigin, classSource: s.classSource, inferred: s.inferred,
        color: s.color, source: s.source, member: JSON.parse(JSON.stringify(s.member)), pair: s.pair,
        manual: !!s.manual
      };
    }
    plan.items = snap.items.map(back).filter(function (it) { return !!it.squad; });
    plan.poolItems = snap.poolItems.map(function (s) {
      var copy = back(s);
      copy.squad = null; copy.team = null; copy.alliance = null;
      return copy;
    });
    plan.deleted = (snap.deleted || []).slice();
    plan.unlanded = (snap.unlanded || []).slice();
    GM.roster.recountPlan(plan);
  }

  function pushPlanUndo() {
    if (!rosterPending) return;
    previewEdit.undo.push(snapPlan(rosterPending));
    if (previewEdit.undo.length > 40) previewEdit.undo.shift();
    previewEdit.redo = [];
  }

  function undoPlan() {
    if (!rosterPending || !previewEdit.undo.length) { GM.ui.toast('预览没有可撤销的编辑', 'error'); return; }
    previewEdit.redo.push(snapPlan(rosterPending));
    restorePlan(rosterPending, previewEdit.undo.pop());
    renderPreviewBody();
  }

  function redoPlan() {
    if (!rosterPending || !previewEdit.redo.length) { GM.ui.toast('预览没有可重做的编辑', 'error'); return; }
    previewEdit.undo.push(snapPlan(rosterPending));
    restorePlan(rosterPending, previewEdit.redo.pop());
    renderPreviewBody();
  }

  function renderPreviewBody() {
    var body = q('#rosterPreviewBody');
    if (!body || !rosterPending) return;
    body.innerHTML = previewHtml(rosterPending, rosterRecognized);
  }

  function pvPickedUids() {
    return Object.keys(previewEdit.sel).filter(function (k) { return previewEdit.sel[k]; });
  }

  function pvFindItem(uidVal) {
    if (!rosterPending || !uidVal) return null;
    var hit = null;
    (rosterPending.items || []).concat(rosterPending.poolItems || []).forEach(function (it) {
      if (it.uid === uidVal) hit = it;
    });
    return hit;
  }

  function conservationHtml(plan) {
    var c = plan.conservation || {};
    var html = '<div class="pv-ledger ' + (c.balanced ? 'ok' : 'warn') + '">' +
      '表内识别 <b>' + (c.nameCells || 0) + '</b> 人 = 将落地 <b>' + (c.landed || 0) + '</b>' +
      ' + 进池 <b>' + (c.pool || 0) + '</b>' +
      ' + 未落地 <b>' + (c.unlanded || 0) + '</b>' +
      ((c.deleted || 0) ? ' + 已删除 <b>' + c.deleted + '</b>' : '') +
      ((c.duplicate || 0) ? ' + 同名去重 <b>' + c.duplicate + '</b>' : '') +
      ' <span class="ledger-flag">' + (c.balanced ? '✓ 守恒' : '✗ 差 ' + c.diff) + '</span>' +
      (plan.unlanded && plan.unlanded.length ? ' <button type="button" class="btn mini ghost" data-pv-unlanded>未落地 ' + plan.unlanded.length + ' 人，展开清单</button>' : '') +
      '</div>';
    if (plan.unlanded && plan.unlanded.length) {
      html += '<details class="pv-unlanded"><summary>未落地 ' + plan.unlanded.length + ' 人（逐条列出，绝不静默丢弃）</summary>' +
        '<table class="roster-table"><thead><tr><th>名字</th><th>原表位置</th><th>原因</th></tr></thead><tbody>' +
        plan.unlanded.map(function (u) {
          return '<tr><td>' + U.esc(u.name) + '</td><td>' + U.esc((u.sheet ? '『' + u.sheet + '』' : '') + (u.column || '') + (u.row ? ' 第' + u.row + '行' : '')) + '</td><td class="warn">' + U.esc(u.reason) + '</td></tr>';
        }).join('') + '</tbody></table></details>';
    }
    if (plan.deleted && plan.deleted.length) {
      html += '<p class="roster-line dim">已删除 ' + plan.deleted.length + ' 人：' +
        U.esc(plan.deleted.map(function (d) { return d.name; }).join('、')) + '（预览内删除，可撤销）</p>';
    }
    return html;
  }

  /* 形态下拉：按职业可选形态生成，选中项跟随用户上次选择（跨重绘不重置） */
  function formOptsSelHtml(classId, form) {
    var cur = normalizeForm(classId, form);
    return formOptions(classId).map(function (f) {
      return '<option value="' + U.esc(f) + '"' + (f === cur ? ' selected' : '') + '>' + U.esc(f) + '</option>';
    }).join('');
  }

  function pvToolbarHtml(plan) {
    var picked = pvPickedUids().length;
    var classes = (GM.state.project && GM.state.project.classes) || [];
    var batchClassId = previewEdit.batchClass && classById(previewEdit.batchClass)
      ? previewEdit.batchClass
      : (classes.length ? classes[0].id : '');
    var batchForm = normalizeForm(batchClassId, previewEdit.batchForm || '');
    previewEdit.batchClass = batchClassId;
    previewEdit.batchForm = batchForm;
    var classOpts = classes.map(function (c) {
      return '<option value="' + U.esc(c.id) + '"' + (c.id === batchClassId ? ' selected' : '') + '>' + U.esc(c.name) + '</option>';
    }).join('');
    var formOpts = formOptsSelHtml(batchClassId, batchForm);
    var teams = (GM.state.project.teams || []).filter(function (n) { return n.kind === 'team'; });
    var squadOpts = '';
    (GM.state.project.teams || []).forEach(function (n) { if (n.kind === 'alliance') teams = teams.concat((n.children || []).filter(function (t) { return t.kind === 'team'; })); });
    teams.forEach(function (t) {
      pvSquads(t).forEach(function (sq, i) {
        squadOpts += '<option value="' + U.esc(sq.id) + '">' + U.esc(t.name + ' / ' + (sq.name || ('小队' + (i + 1)))) + '</option>';
      });
    });
    return '<div class="pv-toolbar">' +
      '<span class="pv-picked">已选 <b>' + picked + '</b> 人</span>' +
      '<button type="button" class="btn mini ghost" data-pv-all>全选</button>' +
      '<button type="button" class="btn mini ghost" data-pv-none>清空选择</button>' +
      '<select data-pv-class-sel>' + classOpts + '</select>' +
      '<select data-pv-form-sel>' + formOpts + '</select>' +
      '<button type="button" class="btn mini" data-pv-batch-class>批量改职业/形态</button>' +
      '<button type="button" class="btn mini" data-pv-batch-pool>移入候补池</button>' +
      '<select data-pv-squad-sel>' + squadOpts + '</select>' +
      '<button type="button" class="btn mini" data-pv-batch-move>批量移到小队</button>' +
      '<button type="button" class="btn mini ghost" data-pv-batch-clear>清空技能槽</button>' +
      '<button type="button" class="btn mini ghost warn" data-pv-batch-del>删除所选</button>' +
      '<span class="spacer"></span>' +
      '<button type="button" class="btn mini ghost" data-pv-undo title="预览内撤销（不影响工程 Ctrl+Z）">↶ 撤销</button>' +
      '<button type="button" class="btn mini ghost" data-pv-redo>↷ 重做</button>' +
      '</div>';
  }

  function pvEditorHtml(plan) {
    if (!previewEdit.editing) return '';
    var all = (plan.items || []).concat(plan.poolItems || []);
    var item = null;
    all.forEach(function (it) { if (it.uid === previewEdit.editing) item = it; });
    if (!item) return '';
    var classes = (GM.state.project && GM.state.project.classes) || [];
    var slots = GM.roster.slotsOf(item.member);
    var fields = [['connection', '人脉'], ['puppet', '密偶'], ['skill', '技能'], ['note', '备注']].map(function (f) {
      return '<label class="pv-field"><span>' + f[1] + '</span><input type="text" maxlength="' + (GM.roster.SLOT_MAX[f[0]]) + '"' +
        ' data-pv-slot="' + f[0] + '" value="' + U.esc(slots[f[0]]) + '"></label>';
    }).join('');
    var classOpts = classes.map(function (c) {
      return '<option value="' + U.esc(c.id) + '"' + (c.id === item.member.classId ? ' selected' : '') + '>' + U.esc(c.name) + '</option>';
    }).join('');
    var formOpts = formOptsSelHtml(item.member.classId, item.member.form || '');
    return '<div class="pv-editor"><div class="pv-editor-head"><b>编辑成员</b>' +
      '<span class="dim">' + U.esc(rosterPosition(item)) + '</span><span class="spacer"></span>' +
      '<button type="button" class="btn mini ghost" data-pv-editor-close>✕</button></div>' +
      '<div class="pv-editor-body">' +
      '<label class="pv-field"><span>名字</span><input type="text" maxlength="24" data-pv-field="name" value="' + U.esc(item.member.name) + '"></label>' +
      '<label class="pv-field"><span>职业</span><select data-pv-field="classId">' + classOpts + '</select></label>' +
      '<label class="pv-field"><span>形态</span><select data-pv-field="form">' + formOpts + '</select></label>' +
      fields +
      '</div></div>';
  }

  /* 未识别颜色报告：模板里名字格的灰/粉等底色不算职业，按行序回落，逐条列出 */
  function unknownColorsHtml(rec) {
    var list = (rec && rec.unknownColors) || [];
    if (!list.length) {
      return '<p class="roster-line dim">未识别颜色：0 种（名字格要么无填充、要么命中职业色板）。</p>';
    }
    return '<div class="roster-section"><h4>未识别颜色 ' + list.length + ' 种（不当作职业，按行序默认回落）</h4>' +
      '<table class="roster-table"><thead><tr><th>填充色</th><th>格数</th><th>位置</th><th>成员</th><th>处理</th></tr></thead><tbody>' +
      list.map(function (x) {
        return '<tr><td><i class="pv-color-dot" style="background:' + U.esc(x.color) + '"></i>' + U.esc(x.color) + '</td>' +
          '<td>' + (x.count || 0) + '</td>' +
          '<td>' + U.esc((x.cells || []).slice(0, 8).join('、') + ((x.cells || []).length > 8 ? '…' : '')) + '</td>' +
          '<td>' + U.esc((x.names || []).slice(0, 8).join('、') + ((x.names || []).length > 8 ? '…' : '')) + '</td>' +
          '<td class="warn">标「色?」，职业按该行默认</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* 图例：优先用模板 U2–U7 的实际填充色（颜色 → 职业的唯一权威），没读到再退回项目职业色 */
  function legendHtml(rec) {
    var legend = (rec && rec.legend) || [];
    var items;
    if (legend.length) {
      items = legend.filter(function (x) { return !!x.color; }).map(function (x) {
        return '<span class="pv-legend-item"><i style="background:' + U.esc(x.color) + '"></i>' +
          U.esc(x.className) + ' <em>' + U.esc(x.color) + '</em></span>';
      }).join('');
    } else {
      items = ((GM.state.project && GM.state.project.classes) || []).map(function (c) {
        return '<span class="pv-legend-item"><i style="background:' + U.esc(c.color) + '"></i>' +
          U.esc(c.name) + ' <em>' + U.esc(c.color) + '</em></span>';
      }).join('');
    }
    return '<div class="roster-section"><h4>职业图例（模板 U2–U7：只看名字格填充色）</h4>' +
      '<div class="pv-legend">' + items + '</div></div>';
  }

  function previewRecognitionHtml(plan) {
    var st = plan.stats || {};
    var pending = 0;
    (plan.items || []).concat(plan.poolItems || []).forEach(function (it) {
      if (it.classOrigin === 'default' || it.colorMiss) pending++;
    });
    var total = (plan.conservation && plan.conservation.nameCells) || st.nameCells || 0;
    var ok = Math.max(0, total - pending);
    return '<p class="roster-line">识别成功 <b>' + ok + '</b> 人 · 待定 <b>' + pending +
      '</b> 人（默认回落 / 颜色未识别） · 跳过 <b>' + (st.skippedCount || 0) + '</b> 行 · 总计 <b>' + total + '</b> 人' +
      (st.unlandedCount ? ' · 未落地 <b>' + st.unlandedCount + '</b> 人' : '') + '</p>';
  }

  function previewHtml(plan, rec) {
    var st = plan.stats;
    var html = '<div class="pv-sum">' +
      '<span class="pv-pill is-add">新增 <b>' + st.newCount + '</b></span>' +
      '<span class="pv-pill is-over">覆盖 <b>' + st.conflictCount + '</b></span>' +
      '<span class="pv-pill">跳过 <b>' + st.skippedCount + '</b></span>' +
      '<span class="pv-pill is-conflict">冲突 <b>' + st.conflictCount + '</b></span>' +
      '<span class="pv-pill">候补 <b>' + st.poolCount + '</b></span></div>';

    var SPEC = (GM.templateImport && GM.templateImport.SPEC) || {};
    var memberCount = (rec && rec.entries) ? rec.entries.length : 0;
    var poolCount = (rec && rec.pool) ? rec.pool.length : 0;
    html += '<div class="roster-sheet-summary"><p class="roster-line"><b>统一模板导入</b>：' +
      U.esc(rosterFileName || '成员导入模板') + ' · 联盟1–5 / 团队1–25 / 小队1–125 · 每块成员行 第' +
      ((SPEC.memberStartRow == null ? 4 : SPEC.memberStartRow) + 1) + '–' +
      ((SPEC.memberEndRow == null ? 9 : SPEC.memberEndRow) + 1) + ' 行 · 名字格 ' + memberCount +
      ' 个 · 候补 ' + poolCount + ' 人</p></div>';

    html += conservationHtml(plan);
    html += previewRecognitionHtml(plan);

    var recStats = (rec && rec.stats) || null;
    var colorHits = recStats ? (recStats.color || 0) : st.colorClassCount;
    var defaultHits = recStats ? (recStats.defaultInferred || 0) : st.defaultClassCount;
    html += '<p class="roster-line dim">职业来源：颜色命中 <b>' + colorHits + '</b> 人 / 默认回落 <b>' + defaultHits +
      '</b> 人（默认回落含无填充与未识别颜色，色块右上角标「色?」/「默」）。</p>';
    html += unknownColorsHtml(rec);

    html += pvToolbarHtml(plan);
    html += pvEditorHtml(plan);
    if (!plan.items.length && !(plan.poolItems || []).length) {
      html += '<p class="roster-empty">模板里没有成员：空模板可以正常导入（应用后无变化）。</p>';
    } else {
      html += '<div id="previewBoard">' + previewCompareHtml(plan) + '</div>';
      html += previewPoolHtml(plan);
    }

    if (plan.poolOmitted.length) {
      html += '<p class="roster-line warn">有 ' + plan.poolOmitted.length + ' 人同时出现在正式队与候选列，已按正式队为准：' +
        U.esc(plan.poolOmitted.slice(0, 6).map(function (x) { return x.name; }).join('、')) +
        (plan.poolOmitted.length > 6 ? '…' : '') + '</p>';
    }

    html += legendHtml(rec);

    var details = '';
    if (st.conflictCount) {
      details += '<div class="roster-section"><h4>冲突清单（目标格已有人，不会静默覆盖）</h4>' +
        '<table class="roster-table"><thead><tr><th>位置</th><th>现有成员</th><th>待导入成员</th><th>来源</th></tr></thead><tbody>' +
        plan.conflicts.slice(0, 40).map(function (it) {
          return '<tr><td>' + rosterPosition(it) + '</td><td class="now">' + memberBrief(it.existing) + '</td><td class="warn">' + memberBrief(it.member) + '</td><td>' + sourceText(it.source) + '</td></tr>';
        }).join('') +
        '</tbody></table>' +
        (plan.conflicts.length > 40 ? '<p class="roster-empty">还有 ' + (plan.conflicts.length - 40) + ' 条冲突未列出</p>' : '') +
        '</div>';
    }

    if (st.defaultClassCount || plan.corrections.length) {
      var corr = plan.corrections.slice(0, 12);
      details += '<div class="roster-section"><h4>自动补全 / 回落</h4>';
      if (st.defaultClassCount) {
        details += '<p class="roster-line dim">' + st.defaultClassCount + ' 人没有命中图例颜色：按行序默认补全（第5行战士 / 6 歌颂 / 7 占卜 / 8 学徒 / 9 窥秘 / 10 观众），形态按职业默认。</p>';
      }
      if (corr.length) {
        details += '<table class="roster-table"><thead><tr><th>来源</th><th>成员</th><th>字段</th><th>原值 → 修正值</th><th>原因</th></tr></thead><tbody>' +
          corr.map(function (c) {
            return '<tr><td>' + sourceText({ sheet: '', row: c.row }) + '</td><td>' + U.esc(c.name) + '</td><td>' + U.esc(c.field) + '</td><td class="warn">' + U.esc(c.from + ' → ' + c.to) + '</td><td>' + U.esc(c.reason) + '</td></tr>';
          }).join('') + '</tbody></table>';
        if (plan.corrections.length > 12) details += '<p class="roster-empty">还有 ' + (plan.corrections.length - 12) + ' 条修正未列出</p>';
      }
      details += '</div>';
    }

    if (plan.skipped.length) {
      details += '<div class="roster-section"><h4>跳过的行</h4><table class="roster-table"><thead><tr><th>来源</th><th>原因</th></tr></thead><tbody>' +
        plan.skipped.slice(0, 12).map(function (x) {
          return '<tr><td>' + U.esc((x.sheet ? '『' + x.sheet + '』· ' : '') + '第 ' + x.row + ' 行') + '</td><td>' + U.esc(x.reason) + '</td></tr>';
        }).join('') + '</tbody></table>';
      if (plan.skipped.length > 12) details += '<p class="roster-empty">还有 ' + (plan.skipped.length - 12) + ' 行未列出</p>';
      details += '</div>';
    }

    if (details) {
      html += '<details class="pv-details"><summary>导入报告（冲突 / 回落 / 跳过）</summary>' + details + '</details>';
    }
    return html;
  }

  /* 模板提示弹窗：导入不符合模板时只报第一处偏差，绝不静默猜 */
  function showTemplateHint(err, label) {
    var body = q('#rosterTemplateHintBody');
    if (body) {
      var where = err && err.where ? ('（第 ' + err.where.row + ' 行 / 第 ' + err.where.col + ' 列）') : '';
      body.innerHTML =
        '<p class="roster-line"><b>这个文件不符合导入模板' + (label ? '：' + U.esc(label) : '') + '</b></p>' +
        '<p class="roster-line warn">' + U.esc((err && err.message) || '未知错误') + U.esc(where) + '</p>' +
        '<p class="roster-line dim">错误码：<code>' + U.esc((err && err.code) || 'unknown') + '</code>' +
        (err && err.code === 'old-template' ? ' · 旧版模板请重新下载模板后再导入' : '') + '</p>' +
        '<p class="roster-line dim">模板固定：联盟行 → 团队行 → 小队行 → 字段行 → 6 成员行（5 联盟 × 5 团队纵向）。' +
        '只接受 assets/templates/成员导入模板.xlsx 的「成员导入模板」表，旧版模板不再支持。</p>';
    }
    rosterModal('rosterTemplateHint', true);
    GM.ui.toast('导入失败：' + ((err && err.message) || '文件不符合模板'), 'error');
  }

  function openRosterPreview(rec, label) {
    rosterRecognized = rec;
    rosterFileName = label || '';
    rosterPending = GM.roster.buildPlan(GM.state.project, rec, { overflowMode: previewEdit.opts.overflowMode || 'pool' });
    previewEdit.sel = {};
    previewEdit.editing = '';
    previewEdit.undo = [];
    previewEdit.redo = [];
    var src = q('#rosterSource');
    if (src) src.textContent = label || '';
    renderPreviewBody();
    rosterModal('rosterImport', false);
    rosterModal('rosterPreview', true);
  }

  function handleRosterSheet(sheet, label, requireMerges) {
    var res = GM.templateImport.parse(sheet, GM.state.project, { requireMerges: requireMerges !== false });
    if (!res.ok) {
      showTemplateHint(res.error, label);
      return;
    }
    openRosterPreview(res.rec, label);
  }

  function handleRosterFile(file) {
    if (!file) return;
    var name = String(file.name || '').toLowerCase();
    if (!file.size) {
      showTemplateHint({ code: 'empty-file', message: '文件是空的（0 字节）。请重新下载模板后再填写。' }, file.name);
      return;
    }

    if (/\.csv$/.test(name)) {
      var reader = new FileReader();
      reader.onload = function () {
        var rows = GM.roster.parseCsvRows(reader.result);
        handleRosterSheet({ name: 'CSV', rows: rows, colors: [], merges: [] }, file.name + '（CSV）', false);
      };
      reader.onerror = function () { GM.ui.toast('读取 CSV 失败', 'error'); };
      reader.readAsText(file, 'utf-8');
      return;
    }

    if (!/\.(xlsx|xlsm)$/.test(name)) {
      showTemplateHint({ code: 'file-type', message: '只支持 .xlsx / .xlsm / .csv。' }, file.name);
      return;
    }
    if (!GM.xlsx || !GM.xlsx.supported()) {
      showTemplateHint({ code: 'unsupported', message: '当前浏览器不支持解压 xlsx（需要 DecompressionStream），请改用模板另存 CSV。' }, file.name);
      return;
    }

    var fr = new FileReader();
    fr.onload = function () {
      GM.xlsx.readBook(fr.result).then(function (book) {
        var sheets = (book && book.sheets) || [];
        if (!sheets.length) {
          showTemplateHint({ code: 'empty-book', message: '这个工作簿里没有工作表。' }, file.name);
          return;
        }
        var target = null;
        for (var i = 0; i < sheets.length; i++) {
          if (String(sheets[i].name || '').trim() === '成员导入模板') { target = sheets[i]; break; }
        }
        if (!target) target = sheets[0];
        handleRosterSheet(target, file.name + '（' + target.name + '）', true);
      }).catch(function (err) {
        showTemplateHint({ code: 'read-error', message: '读取 xlsx 失败：' + (err && err.message ? err.message : err) }, file.name);
      });
    };
    fr.onerror = function () { showTemplateHint({ code: 'read-error', message: '读取文件失败。' }, file.name); };
    fr.readAsArrayBuffer(file);
  }

  /* 模板下载：把 assets/templates 下那份模板复制到指定目录。
   * 顺序：Electron bridge（现在空转）→ showSaveFilePicker（能取到字节时）→ <a download> 默认下载目录。 */
  function downloadTemplate() {
    var T = GM.templateImport;
    if (!T) return;
    var file = T.templateFileName || '成员导入模板.xlsx';
    var url = T.templateUrl || 'assets/templates/成员导入模板.xlsx';

    var bridge = null;
    try { bridge = T.copyTemplateViaBridge(''); } catch (err) { bridge = null; }
    if (bridge) {
      GM.ui.toast('模板已通过宿主复制到：' + (bridge.dest || bridge.path || '指定目录'), 'success');
      return;
    }

    function anchorFallback(note) {
      var a = document.createElement('a');
      a.href = url;
      a.download = file;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { document.body.removeChild(a); }, 120);
      GM.ui.toast(note || ('模板已保存到浏览器默认下载目录：' + file + '（完整路径见下载记录）'), 'success');
    }

    if (typeof window.showSaveFilePicker === 'function' && typeof window.fetch === 'function') {
      window.fetch(url).then(function (res) { return res.arrayBuffer(); }).then(function (buf) {
        return window.showSaveFilePicker({
          suggestedName: file,
          types: [{
            description: 'Excel 工作簿 (.xlsx)',
            accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] }
          }]
        }).then(function (handle) {
          return handle.createWritable().then(function (w) {
            return w.write(buf).then(function () { return w.close(); });
          });
        });
      }).then(function () {
        GM.ui.toast('模板已保存到你选择的目录：' + file, 'success');
      }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        anchorFallback('（无法直接写入指定目录，已改存到浏览器默认下载目录：' + file + '）');
      });
      return;
    }
    anchorFallback();
  }

  function applyRoster(mode) {
    if (!rosterPending) return;
    var plan = rosterPending;
    var res = GM.roster.applyPlan(GM.state.project, plan, mode);
    var check = GM.roster.assertApplied(GM.state.project, plan, mode);
    GM.commit(mode === 'overwrite' ? '一键导入（全部覆盖）' : '一键导入（只填空位）');
    GM.ui.toast(
      '已导入 ' + res.added + ' 人，覆盖 ' + res.overwritten + ' 人，跳过冲突 ' + res.skippedSlots + ' 格' +
      (res.poolAdded ? '；候补池 +' + res.poolAdded + ' 人' : '') +
      (res.poolSkipped ? '（池内重名跳过 ' + res.poolSkipped + '）' : '') +
      '；应用即所见：逐块比对 ' + check.checked + ' 块，差异 ' + check.diffs.length +
      (check.diffs.length ? '（有差异，请看控制台）' : '（0 差异）') +
      '（Ctrl+Z 可撤销）',
      check.diffs.length ? 'error' : 'success'
    );
    rosterPending = null;
    rosterRecognized = null;
    rosterModal('rosterPreview', false);

    var first = plan.items[0];
    if (first && first.team) {
      configState.allianceId = first.alliance ? first.alliance.id : configState.allianceId;
      configState.teamId = first.team.id;
    }
    renderConfig();
  }

  function downloadRoster(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
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
  }

  function exportRoster(fmt) {
    var project = GM.state.project;
    if (!project) return;
    var base = '诡秘之主_编成_' + U.dateStamp();
    if (fmt === 'csv') {
      var rows = GM.roster.exportTemplateRows(project);
      downloadRoster(base + '.csv', '\uFEFF' + GM.roster.toCsv(rows), 'text/csv;charset=utf-8');
      GM.ui.toast('已导出 CSV（模板列序：联盟1–5 / 团队1–25 × 5 小队 × 6 行 × 4 列 + U 列图例/候补，可直接贴回模板）', 'success');
    } else {
      downloadRoster(base + '.json', JSON.stringify(GM.roster.toJson(project), null, 2), 'application/json;charset=utf-8');
      GM.ui.toast('已导出 JSON（全量 25 团队 + 候补池，含空槽与元数据）', 'success');
    }
    rosterModal('rosterExport', false);
  }

  function bindRoster() {
    var btnImp = q('#btnRosterImport');
    var fileEl = q('#rosterFile');
    var fileLabel = q('#rosterImportFile');
    var dropEl = q('#rosterDrop');

    function showChosenFile(file) {
      if (!fileLabel || !file) return;
      fileLabel.textContent = '已选择：' + file.name + '（' + Math.round((file.size || 0) / 1024) + ' KB）';
      fileLabel.classList.add('has-file');
    }

    function resetChosenFile() {
      if (fileEl) fileEl.value = '';
      if (fileLabel) {
        fileLabel.textContent = '尚未选择文件';
        fileLabel.classList.remove('has-file');
      }
    }

    /* 一级入口只打开二级导入面板，不再直接弹系统文件选择框 */
    if (btnImp) btnImp.addEventListener('click', function () {
      resetChosenFile();
      rosterModal('rosterImport', true);
    });
    var importClose = q('#rosterImportClose');
    if (importClose) importClose.addEventListener('click', function () { rosterModal('rosterImport', false); });

    if (fileEl) {
      fileEl.addEventListener('change', function (e) {
        var file = e.target.files && e.target.files[0];
        showChosenFile(file);
        handleRosterFile(file);
        fileEl.value = '';
      });
    }
    if (dropEl) {
      dropEl.addEventListener('click', function (e) {
        if (e.target === fileEl) return;
        if (fileEl) fileEl.click();
      });
      dropEl.addEventListener('dragover', function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropEl.classList.add('is-over');
      });
      dropEl.addEventListener('dragleave', function () { dropEl.classList.remove('is-over'); });
      dropEl.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropEl.classList.remove('is-over');
        var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!file) return;
        showChosenFile(file);
        handleRosterFile(file);
      });
    }

    var btnTpl = q('#btnRosterTemplate');
    if (btnTpl) btnTpl.addEventListener('click', function () { downloadTemplate(); });

    var hintDl = q('#rosterHintDownload');
    if (hintDl) hintDl.addEventListener('click', function () { downloadTemplate(); });
    var hintClose = q('#rosterHintClose');
    if (hintClose) hintClose.addEventListener('click', function () { rosterModal('rosterTemplateHint', false); });
    var hintOk = q('#rosterHintOk');
    if (hintOk) hintOk.addEventListener('click', function () { rosterModal('rosterTemplateHint', false); });

    var previewBody = q('#rosterPreviewBody');
    if (previewBody) {
      previewBody.addEventListener('click', function (e) {
        if (!rosterPending) return;
        var t = e.target;

        /* ---- 预览编辑 ---- */
        var delBtn = t.closest('[data-pv-del]');
        if (delBtn) {
          pushPlanUndo();
          GM.roster.batchPlan(rosterPending, [delBtn.getAttribute('data-pv-del')], 'delete');
          delete previewEdit.sel[delBtn.getAttribute('data-pv-del')];
          previewEdit.editing = '';
          renderPreviewBody();
          return;
        }
        var addBtn = t.closest('[data-pv-add]');
        if (addBtn) {
          var addSquad = GM.findTeam(addBtn.getAttribute('data-pv-add'));
          var addSlot = Number(addBtn.getAttribute('data-pv-add-slot'));
          GM.ui.promptText('新增成员', '名字', '', '把名字填进来，职业默认按该行常识填充（第' + (addSlot + 1) + '格）').then(function (name) {
            if (!name) return;
            pushPlanUndo();
            GM.roster.addPlanMember(rosterPending, GM.state.project, addSquad, addSlot, { name: name });
            renderPreviewBody();
          });
          return;
        }
        if (t.closest('[data-pv-editor-close]')) {
          previewEdit.editing = '';
          renderPreviewBody();
          return;
        }
        var cellBtn = t.closest('[data-pv-uid]');
        if (cellBtn && !t.closest('.pv-check')) {
          previewEdit.editing = cellBtn.getAttribute('data-pv-uid');
          renderPreviewBody();
          return;
        }

        /* ---- 批量工具条 ---- */
        if (t.closest('[data-pv-all]')) {
          previewEdit.sel = {};
          (rosterPending.items || []).forEach(function (it) { previewEdit.sel[it.uid] = true; });
          renderPreviewBody();
          return;
        }
        if (t.closest('[data-pv-none]')) {
          previewEdit.sel = {};
          renderPreviewBody();
          return;
        }
        if (t.closest('[data-pv-batch-class]')) {
          var clsSel = q('[data-pv-class-sel]', previewBody);
          var formSel = q('[data-pv-form-sel]', previewBody);
          var uids = pvPickedUids();
          if (!uids.length) { GM.ui.toast('先勾选要改的块', 'error'); return; }
          /* 应用后保留用户选的职业/形态，只清空多选 */
          if (clsSel) previewEdit.batchClass = clsSel.value;
          if (formSel) previewEdit.batchForm = formSel.value;
          pushPlanUndo();
          var r1 = GM.roster.batchPlan(rosterPending, uids, 'class-form', {
            classId: previewEdit.batchClass, form: previewEdit.batchForm
          });
          previewEdit.sel = {};
          GM.ui.toast('已批量改职业/形态：' + r1.changed + ' 人（预览内，可撤销）', 'success');
          renderPreviewBody();
          return;
        }
        if (t.closest('[data-pv-batch-pool]')) {
          var uids2 = pvPickedUids();
          if (!uids2.length) { GM.ui.toast('先勾选要移入池的块', 'error'); return; }
          pushPlanUndo();
          var r2 = GM.roster.batchPlan(rosterPending, uids2, 'to-pool');
          previewEdit.sel = {};
          GM.ui.toast('已移入候补池：' + r2.changed + ' 人', 'success');
          renderPreviewBody();
          return;
        }
        if (t.closest('[data-pv-batch-move]')) {
          var sqSel = q('[data-pv-squad-sel]', previewBody);
          var target = sqSel ? GM.findTeam(sqSel.value) : null;
          var uids3 = pvPickedUids();
          if (!target || !uids3.length) { GM.ui.toast('先勾选成员并选目标小队', 'error'); return; }
          pushPlanUndo();
          var loc = locateSquad(target.id);
          var r3 = GM.roster.batchPlan(rosterPending, uids3, 'to-squad', { squad: target, team: loc.team, alliance: loc.alliance });
          previewEdit.sel = {};
          GM.ui.toast('已移动到「' + target.name + '」：' + r3.changed + ' 人', 'success');
          renderPreviewBody();
          return;
        }
        if (t.closest('[data-pv-batch-clear]')) {
          var uids4 = pvPickedUids();
          if (!uids4.length) { GM.ui.toast('先勾选要清空技能槽的块', 'error'); return; }
          pushPlanUndo();
          var r4 = GM.roster.batchPlan(rosterPending, uids4, 'clear-slots');
          GM.ui.toast('已清空技能槽：' + r4.changed + ' 人', 'success');
          renderPreviewBody();
          return;
        }
        if (t.closest('[data-pv-batch-del]')) {
          var uids5 = pvPickedUids();
          if (!uids5.length) { GM.ui.toast('先勾选要删除的块', 'error'); return; }
          pushPlanUndo();
          GM.roster.batchPlan(rosterPending, uids5, 'delete');
          previewEdit.sel = {};
          renderPreviewBody();
          return;
        }
        if (t.closest('[data-pv-undo]')) { undoPlan(); return; }
        if (t.closest('[data-pv-redo]')) { redoPlan(); return; }
        if (t.closest('[data-pv-unlanded]')) {
          var un = q('.pv-unlanded', previewBody);
          if (un) un.open = !un.open;
          return;
        }

      });
      previewBody.addEventListener('input', function (e) {
        var t = e.target;
        var opt = t.closest('[data-opt]');
        if (opt) {
          previewEdit.opts[opt.getAttribute('data-opt')] = opt.value;
          return;
        }
        var item = pvFindItem(previewEdit.editing);
        if (!item) return;
        var nameField = t.closest('[data-pv-field="name"]');
        if (nameField) { item.member.name = String(nameField.value || '').trim(); return; }
        var slotField = t.closest('[data-pv-slot]');
        if (slotField) {
          var k = slotField.getAttribute('data-pv-slot');
          var max = GM.roster.SLOT_MAX[k] || 20;
          item.member.slots = GM.roster.slotsOf(item.member);
          item.member.slots[k] = String(slotField.value || '').slice(0, max);
          item.member.skills = GM.roster.SLOT_KEYS.map(function (kk) { return item.member.slots[kk] || ''; });
        }
      });
      previewBody.addEventListener('change', function (e) {
        var t = e.target;

        /* 预览：勾选 / 单块字段 / 批量 */
        var box = t.closest('input[data-pv-check]');
        if (box) {
          var cuid = box.getAttribute('data-pv-check');
          if (box.checked) previewEdit.sel[cuid] = true;
          else delete previewEdit.sel[cuid];
          var cell = box.closest('.pv-cell');
          if (cell) cell.classList.toggle('is-selected', box.checked);
          var picked = q('.pv-picked b', previewBody);
          if (picked) picked.textContent = String(pvPickedUids().length);
          return;
        }
        var field = t.closest('[data-pv-field]');
        if (field) {
          var item = pvFindItem(previewEdit.editing);
          if (!item) return;
          pushPlanUndo();
          var key = field.getAttribute('data-pv-field');
          if (key === 'classId') {
            item.member.classId = field.value;
            item.member.form = normalizeForm(item.member.classId, item.member.form || '');
            item.classOrigin = 'manual'; item.classSource = 'manual';
          } else if (key === 'form') item.member.form = field.value;
          else if (key === 'name') item.member.name = String(field.value || '').trim();
          renderPreviewBody();
          return;
        }
        /* 批量改职业/形态：切职业时把形态下拉收窄到该职业可选形态，并记住选择 */
        var pvClassSel = t.closest('[data-pv-class-sel]');
        if (pvClassSel) {
          previewEdit.batchClass = pvClassSel.value;
          previewEdit.batchForm = defaultForm(previewEdit.batchClass);
          var pvFormSel = q('[data-pv-form-sel]', previewBody);
          if (pvFormSel) pvFormSel.innerHTML = formOptsSelHtml(previewEdit.batchClass, previewEdit.batchForm);
          return;
        }
        var pvFormPick = t.closest('[data-pv-form-sel]');
        if (pvFormPick) {
          previewEdit.batchForm = pvFormPick.value;
          return;
        }
        var slotField = t.closest('[data-pv-slot]');
        if (slotField) {
          var item2 = pvFindItem(previewEdit.editing);
          if (!item2) return;
          pushPlanUndo();
          var k = slotField.getAttribute('data-pv-slot');
          var max = GM.roster.SLOT_MAX[k] || 20;
          item2.member.slots = GM.roster.slotsOf(item2.member);
          item2.member.slots[k] = String(slotField.value || '').slice(0, max);
          item2.member.skills = GM.roster.SLOT_KEYS.map(function (kk) { return item2.member.slots[kk] || ''; });
          return;
        }
        var opt = t.closest('[data-opt]');
        if (opt) {
          previewEdit.opts[opt.getAttribute('data-opt')] = opt.value;
        }
      });
    }

    var btnExp = q('#btnRosterExport');
    if (btnExp) btnExp.addEventListener('click', function () { rosterModal('rosterExport', true); });

    var closeExport = q('#rosterExportClose');
    if (closeExport) closeExport.addEventListener('click', function () { rosterModal('rosterExport', false); });
    var expCsv = q('#rosterExportCsv');
    if (expCsv) expCsv.addEventListener('click', function () { exportRoster('csv'); });
    var expJson = q('#rosterExportJson');
    if (expJson) expJson.addEventListener('click', function () { exportRoster('json'); });

    function cancelImport() {
      rosterPending = null;
      rosterRecognized = null;
      rosterModal('rosterPreview', false);
    }
    var pc = q('#rosterPreviewClose');
    if (pc) pc.addEventListener('click', cancelImport);
    var cancelBtn = q('#rosterCancel');
    if (cancelBtn) cancelBtn.addEventListener('click', cancelImport);
    var over = q('#rosterModeOverwrite');
    if (over) over.addEventListener('click', function () { applyRoster('overwrite'); });
    var empty = q('#rosterModeEmpty');
    if (empty) empty.addEventListener('click', function () { applyRoster('empty'); });
  }

  /* ============================ 对外 API ============================ */

  function addRoot(kind) {
    if (kind === 'alliance') { addAlliance(); return; }
    var tabs = configAlliances();
    if (kind === 'team') { addTeam(); return; }
    // squad：挂在当前团队
    var w = activeTeamWrapper(tabs);
    if (w && w.node) addSquad(w.node.id);
    else GM.ui.toast('先在编队配置里创建团队，再新建小队', 'error');
  }

  function addChild(node) {
    if (!node) return;
    if (node.kind === 'alliance') {
      GM.ui.promptText('新建团队', '团队名称', '团队 ' + (node.children.length + 1)).then(function (name) {
        if (name == null) return;
        var child = GM.newTeam('team', String(name).trim() || '团队 未命名');
        child.factionId = node.factionId;
        node.children.push(child);
        configState.allianceId = node.id;
        configState.teamId = child.id;
        GM.commit('新增团队');
      });
    } else if (node.kind === 'team') {
      addSquad(node.id);
    } else if (node.kind === 'squad') {
      addMemberToSquad(node);
    }
  }

  function render() {
    /* 旧存档槽位迁移（技能1–4 → 人脉/密偶/技能/备注），只跑一次 */
    var proj = GM.state.project;
    if (proj && (!proj.slotSemanticsVersion || proj.slotSemanticsVersion < 2)) {
      GM.roster.migrateProject(proj);
    }
    renderLive();
    if (isConfigOpen()) renderConfig();
    if (isConfigOpen()) renderOverview();
  }

  function bindLive() {
    var host = q('#liveList');
    if (!host) return;

    host.addEventListener('click', function (e) {
      var editBtn = e.target.closest('[data-live-edit]');
      if (editBtn) {
        e.stopPropagation();
        var editNode = GM.findTeam(editBtn.getAttribute('data-live-edit'));
        if (editNode) focusLiveNode(editNode);
        return;
      }

      /* 小队列头 = 拖动抓手；点击不触发折叠（团队折叠仍由团队头点击负责） */
      var squadHead = e.target.closest('.mini-col-head');
      if (squadHead) {
        e.stopPropagation();
        if (squadHead.hasAttribute('data-squad-empty')) GM.ui.toast('该小队暂无成员，无法拖到沙盘', 'error');
        return;
      }

      var tile = e.target.closest('.mini-tile.filled');
      if (tile) {
        e.stopPropagation();
        var memberId = tile.getAttribute('data-member-id');
        if (memberId) GM.select('member', memberId);
        return;
      }

      var head = e.target.closest('[data-live-head]');
      if (head) {
        e.stopPropagation();
        toggleCollapsed(head.getAttribute('data-live-head'));
        return;
      }

      var card = e.target.closest('[data-live-id]');
      if (!card) return;
      var node = GM.findTeam(card.getAttribute('data-live-id'));
      if (node) focusLiveNode(node);
    });

    host.addEventListener('dragstart', function (e) {
      var squadHead = e.target.closest('.mini-col-head[data-squad-live]');
      if (squadHead) {
        var squadId = squadHead.getAttribute('data-squad-id');
        if (!squadId || !GM.findTeam(squadId)) return;
        setDragData(e, MIME_NODE, {
          type: 'squad',
          liveId: squadHead.getAttribute('data-squad-live'),
          squadId: squadId,
          name: squadHead.getAttribute('data-squad-name') || '',
          index: Number(squadHead.getAttribute('data-squad-index') || 0),
          count: Number(squadHead.getAttribute('data-squad-count') || 0)
        });
        squadHead.classList.add('dragging');
        return;
      }

      var tile = e.target.closest('.mini-tile.filled');
      if (tile) {
        var card = tile.closest('[data-live-id]');
        if (!card) return;
        setDragData(e, MIME_PERSON, {
          type: 'person',
          liveId: card.getAttribute('data-live-id'),
          memberId: tile.getAttribute('data-member-id')
        });
        tile.classList.add('dragging');
        return;
      }

      /* 联盟整块可拖入沙盘：按实际人数生成大圈标记 */
      var group = e.target.closest('[data-live-alliance]');
      if (group) {
        var allId = group.getAttribute('data-live-alliance');
        if (!GM.findTeam(allId)) return;
        setDragData(e, MIME_NODE, { type: 'team', id: allId });
        group.classList.add('dragging');
        return;
      }

      var teamCard = e.target.closest('[data-live-id]');
      if (!teamCard) return;
      var node = GM.findTeam(teamCard.getAttribute('data-live-id'));
      if (!node) return;
      setDragData(e, MIME_NODE, { type: 'team', id: node.id });
      teamCard.classList.add('dragging');
    });

    host.addEventListener('dragend', function () {
      qa('.live-card.dragging, .live-group.dragging, .mini-tile.dragging, .mini-col-head.dragging').forEach(function (el) {
        el.classList.remove('dragging');
      });
    });
  }

  function updateConfigSaveStatus(payload) {
    var el = q('#configSaveStatus');
    if (!el) return;
    var status = payload && payload.status;
    var now = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    var stamp = p(now.getHours()) + ':' + p(now.getMinutes()) + ':' + p(now.getSeconds());
    el.classList.remove('is-saved', 'is-pending', 'is-error');
    if (status === 'saved') {
      el.textContent = '已自动保存 · ' + stamp;
      el.classList.add('is-saved');
      el.removeAttribute('title');
    } else if (status === 'pending') {
      el.textContent = '保存中…';
      el.classList.add('is-pending');
    } else if (status === 'error' || status === 'unavailable') {
      el.textContent = '保存失败';
      el.classList.add('is-error');
      el.title = (payload && payload.detail) || '本地存储不可用或空间不足';
    } else if (status === 'restored') {
      el.textContent = '已恢复本地实时编成';
      el.classList.add('is-saved');
    } else {
      el.textContent = '实时保存已启用';
    }
  }

  function init() {
    var created = ensureSkeleton();
    loadCollapseState();
    bindLive();
    bindConfig();
    bindRoster();
    bindPool();
    GM.bus.on('change', function (payload) {
      var label = (payload && payload.label) || '';
      if (configState.drawer && (label === 'undo' || label === 'redo' || label === 'import')) {
        clearTimeout(drawerTimer);
        drawerTimer = null;
        configState.drawer = null;
        var el0 = q('#memberDrawer');
        if (el0) {
          el0.classList.add('hidden');
          el0.innerHTML = '';
          el0.removeAttribute('data-member-id');
        }
      }
      render();
    });
    GM.bus.on('imported', function () {
      configState.allianceId = null;
      configState.teamId = null;
      configState.drawer = null;
      closeConfig();
      ensureSkeleton();
      GM.commit('初始化编队骨架');
      render();
    });
    GM.bus.on('save', updateConfigSaveStatus);
    if (created) GM.commit('初始化编队骨架');
    renderLive();
    restoreWinState();
    updateConfigSaveStatus({ status: GM.state.ui.saveStatus });
  }

  GM.teams = {
    MIME_NODE: MIME_NODE,
    MIME_PERSON: MIME_PERSON,
    MIME_SLOT: MIME_SLOT,
    init: init,
    render: render,
    renderConfig: renderConfig,
    openConfig: openConfig,
    closeConfig: closeConfig,
    isConfigOpen: isConfigOpen,
    renderOverview: renderOverview,
    openPresetSave: openPresetSave,
    openPresetList: openPresetList,
    loadPresetToConfig: loadPresetToConfig,
    savePresetSnapshot: snapshotNode,
    addRoot: addRoot,
    addChild: addChild,
    addSquad: addSquad,
    addMemberToSquad: addMemberToSquad,
    performMove: performMove,
    canMoveTo: canMoveTo,
    createMemberAt: createMemberAt,
    ensureSkeleton: ensureSkeleton,
    renderLive: renderLive,
    focusLiveNode: focusLiveNode,
    defaultForm: defaultForm,
    formOptions: formOptions,
    normalizeForm: normalizeForm,
    state: configState
  };
})();
