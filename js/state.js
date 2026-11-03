(function () {
  'use strict';

  window.GM = window.GM || {};
  var GM = window.GM;
  var U = GM.util;

  GM.SCHEMA_VERSION = 1;

  GM.state = {
    project: null,
    ui: {
      tool: 'select',
      selected: null,          // { type: 'team'|'member'|'marker'|'shape', id }
      diff: false,
      playing: null,
      saveStatus: 'new',
      collapsedTeams: {},       // 仅 UI 状态，不写入存档
      /* 工具栏二级选项：不写工程存档，切工具/刷新不重置 */
      skillShape: 'circle',     // circle | sector | rect
      /* 画线工具组当前项：attack | attackDash | defense | forbid */
      lineTool: 'attack',
      /* 团队工具落点前的人数（0–150），只影响新建的三级标记，不链接编成 */
      teamTool: { kind: 'squad', relation: 'enemy-red', count: 0 }
    },
    view: { x: 0, y: 0, k: 1 }
  };

  /* ============================ 势力 id 解析 ============================ */

  /* 把旧存档里的势力 id（A–D、大小写、ash/night 等英文别名）统一解析回 A–D。
     解析不了返回空串，由调用方决定兜底值。 */
  function factionAliasId(id) {
    var raw = String(id == null ? '' : id).trim();
    if (!raw) return '';
    var up = raw.toUpperCase();
    if (['A', 'B', 'C', 'D'].indexOf(up) > -1) return up;
    var aliases = (window.GM_DATA && window.GM_DATA.factionAliases) || {};
    var key = raw.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(aliases, key)) return aliases[key];
    if (Object.prototype.hasOwnProperty.call(aliases, raw)) return aliases[raw];
    return '';
  }

  /* 对象 key 重映射（方案里的 platformScores / scoreByFaction 以势力 id 为键） */
  function remapFactionKeys(obj) {
    var out = {};
    if (!obj || typeof obj !== 'object') return out;
    Object.keys(obj).forEach(function (k) {
      var next = factionAliasId(k) || k;
      if (!(next in out)) out[next] = obj[k];
    });
    return out;
  }

  /* ============================ 数据构造 ============================ */

  GM.newTeam = function (kind, name) {
    var info = U.teamKindInit(kind);
    return {
      id: U.uid('team'),
      kind: kind,
      name: name || (info.label + ' 未命名'),
      color: '',
      factionId: 'A',
      note: '',
      members: [],
      children: []
    };
  };

  /* 形态默认口径：以 data/classes.js 的 forms 为准（第一项即默认），不再维护第二份清单 */
  function defaultFormOf(classId) {
    var list = (window.GM_DATA && window.GM_DATA.classes) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === classId) {
        if (list[i].forms && list[i].forms.length) return String(list[i].forms[0] || '输出');
        break;
      }
    }
    return '输出';
  }

  GM.newMember = function (name) {
    var skills = [];
    for (var i = 0; i < (window.GM_DATA.skillSlotCount || 4); i++) skills.push('');
    var classId = (window.GM_DATA.classes[0] || {}).id || 'class-1';
    return {
      id: U.uid('member'),
      name: name || '未命名成员',
      classId: classId,
      sequence: '',
      form: defaultFormOf(classId),
      level: '',
      skills: skills,
      note: ''
    };
  };

  GM.newPhase = function (name) {
    return {
      id: U.uid('phase'),
      name: name || '新阶段',
      markers: [],
      shapes: [],
      note: ''
    };
  };

  GM.newPlan = function (mapId, name) {
    var plan = {
      id: U.uid('plan'),
      name: name || '新方案',
      mapId: mapId || (GM.state.project ? GM.state.project.mapId : window.GM_DATA.maps[0].id),
      activePhaseId: null,
      phases: [],
      note: ''
    };
    var phase = GM.newPhase('接敌前');
    plan.phases.push(phase);
    plan.activePhaseId = phase.id;
    GM.ensurePlanMeta(plan);
    return plan;
  };

  /* 方案级预留字段：不同地图模式在这里补默认值，不额外堆 UI */
  GM.ensurePlanMeta = function (plan) {
    if (!plan) return plan;
    var md = window.GM_DATA.mapById(plan.mapId);

    if (md.mode === 'siege-capture' && md.siege) {
      if (!plan.siege || typeof plan.siege !== 'object') plan.siege = {};
      if (!plan.siege.steles || typeof plan.siege.steles !== 'object') plan.siege.steles = {};
      if (!plan.siege.gates || typeof plan.siege.gates !== 'object') plan.siege.gates = {};
      if (!plan.siege.platformScores || typeof plan.siege.platformScores !== 'object') plan.siege.platformScores = {};

      md.siege.steles.forEach(function (s) {
        if (!(s.id in plan.siege.steles)) plan.siege.steles[s.id] = null;
      });
      md.siege.gates.forEach(function (g) {
        if (!(g.id in plan.siege.gates)) plan.siege.gates[g.id] = false;
      });
      var factions = (GM.state.project && GM.state.project.factions) || window.GM_DATA.defaultFactions;
      factions.forEach(function (f) {
        if (!(f.id in plan.siege.platformScores)) plan.siege.platformScores[f.id] = 0;
      });
    }

    if (md.mode === 'capture') {
      if (!plan.scoring || typeof plan.scoring !== 'object') plan.scoring = {};
      if (!plan.scoring.type) plan.scoring.type = 'capture-hold';
      /* 计分参数全部来自 md.scoring（官方规则），方案里只保留守卫归属 */
      if (!plan.scoring.ownership || typeof plan.scoring.ownership !== 'object') plan.scoring.ownership = {};
      md.objectives.forEach(function (o) {
        if (!(o.id in plan.scoring.ownership)) plan.scoring.ownership[o.id] = o.ownerFactionId || null;
      });
    }

    if (md.mode === 'escort') {
      if (!plan.escort || typeof plan.escort !== 'object') plan.escort = {};
      if (!('carrierFactionId' in plan.escort)) plan.escort.carrierFactionId = null;
      if (typeof plan.escort.progress !== 'number') plan.escort.progress = 0;
      if (!plan.escort.scoreByFaction || typeof plan.escort.scoreByFaction !== 'object') plan.escort.scoreByFaction = {};
      if (!Array.isArray(plan.escort.delivered)) plan.escort.delivered = [];
      /* 中央占领圈圆心：旧存档没有该字段（或值非法）时回退到地图默认圆心 */
      var capDefault = null;
      (md.objectives || []).forEach(function (o) { if (!capDefault && o.type === 'capture-circle') capDefault = o; });
      var capSaved = plan.escort.circle;
      if (!capSaved || typeof capSaved !== 'object' ||
          !isFinite(Number(capSaved.x)) || !isFinite(Number(capSaved.y))) {
        plan.escort.circle = { x: capDefault ? capDefault.x : 0, y: capDefault ? capDefault.y : 0 };
      } else {
        plan.escort.circle = { x: Number(capSaved.x), y: Number(capSaved.y) };
      }
      var factions2 = (GM.state.project && GM.state.project.factions) || window.GM_DATA.defaultFactions;
      factions2.forEach(function (f) {
        if (!(f.id in plan.escort.scoreByFaction)) plan.escort.scoreByFaction[f.id] = 0;
      });
    }

    if (md.mode === 'club-war' && md.clubWar) {
      if (!plan.clubwar || typeof plan.clubwar !== 'object') plan.clubwar = {};
      /* 旧存档里的阶段 / 占领耗时 / 时间参数一律静默丢弃，只保留 未占领 / 已占领 两态 */
      Object.keys(plan.clubwar).forEach(function (k) {
        if (k !== 'ownership') delete plan.clubwar[k];
      });
      if (plan.sim && typeof plan.sim === 'object') delete plan.sim['club-war'];
      if (!plan.clubwar.ownership || typeof plan.clubwar.ownership !== 'object') plan.clubwar.ownership = {};
      var own = plan.clubwar.ownership;
      var atk = md.clubWar.attacker;
      (md.objectives || []).forEach(function (o) {
        var v = own[o.id];
        own[o.id] = (v === true || v === atk || v === 'attacker') ? true : false;
      });
      /* 两座雕像未全部占领时，大旗不允许保持已占领（旧存档可能残留大旗的旧归属） */
      var statuesHeld = (md.clubWar.statueIds || []).every(function (sid) { return own[sid] === true; });
      if (!statuesHeld) own[md.clubWar.flagId || 'flag'] = false;
    }

    return plan;
  };

  /* 星墓高原中央占领圈的实际圆心：优先方案里拖动后的 escort.circle，
     旧存档缺字段或值非法时回退到地图数据里的 capture-circle 默认圆心。 */
  GM.captureCirclePoint = function (md, plan) {
    var def = null;
    (md && md.objectives ? md.objectives : []).forEach(function (o) {
      if (!def && o.type === 'capture-circle') def = o;
    });
    var fallback = { x: def ? def.x : 0, y: def ? def.y : 0 };
    var c = plan && plan.escort ? plan.escort.circle : null;
    if (!c || typeof c !== 'object') return fallback;
    var x = Number(c.x), y = Number(c.y);
    if (!isFinite(x) || !isFinite(y)) return fallback;
    return { x: x, y: y };
  };

  GM.createProject = function () {
    var firstMap = window.GM_DATA.maps[0];
    var project = {
      schemaVersion: GM.SCHEMA_VERSION,
      id: U.uid('project'),
      name: '未命名战役',
      mapId: firstMap.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      grid: { enabled: true, size: 32 },
      mapVersions: {},
      markerFieldVersion: 2,
      layers: { base: true, zones: true, routes: true, markers: true, personal: true, notes: true, water: true, ice: true, snow: true, height: false, road: true, cliff: true, points: true, winds: true, objectives: true, barriers: true, redraw: true },
      labels: { pinned: { alliance: true, team: true, squad: true, person: false } },
      mapLevel: GM.defaultMapLevel(firstMap),
      factions: U.clone(window.GM_DATA.defaultFactions),
      classes: U.clone(window.GM_DATA.classes),
      teams: [],
      pool: [],
      presets: [],
      plans: [],
      activePlanId: null
    };

    project.mapVersions[firstMap.id] = firstMap.mapVersion || 1;

    var plan = GM.newPlan(firstMap.id, '方案 1');
    project.plans.push(plan);
    project.activePlanId = plan.id;
    GM.ensurePlanMeta(plan);

    return project;
  };

  /* ============================ 查询 ============================ */

  GM.currentMap = function () {
    return window.GM_DATA.mapById(GM.state.project ? GM.state.project.mapId : null);
  };

  /* 默认高程：星墓高原默认二层（台下需要用户自己选），其余多层地图仍用 layers[0] */
  GM.defaultMapLevel = function (md) {
    md = md || GM.currentMap();
    if (!md || !md.layers || !md.layers.length) return 'ground';
    if (md.id === 'star-tomb') {
      for (var i = 0; i < md.layers.length; i++) {
        if (md.layers[i].id === 'upper') return 'upper';
      }
    }
    return md.layers[0].id || 'ground';
  };

  GM.plansForMap = function () {
    var project = GM.state.project;
    if (!project) return [];
    return project.plans.filter(function (p) { return p.mapId === project.mapId; });
  };

  GM.activePlan = function () {
    var project = GM.state.project;
    if (!project) return null;
    for (var i = 0; i < project.plans.length; i++) {
      if (project.plans[i].id === project.activePlanId) return project.plans[i];
    }
    return null;
  };

  GM.activePhase = function () {
    var plan = GM.activePlan();
    if (!plan || !plan.phases || !plan.phases.length) return null;
    for (var i = 0; i < plan.phases.length; i++) {
      if (plan.phases[i].id === plan.activePhaseId) return plan.phases[i];
    }
    return plan.phases[0];
  };

  GM.phaseIndex = function () {
    var plan = GM.activePlan();
    var phase = GM.activePhase();
    if (!plan || !phase) return -1;
    return plan.phases.indexOf(phase);
  };

  GM.ensureActivePlan = function () {
    var project = GM.state.project;
    if (!project) return null;
    var list = GM.plansForMap();

    if (!list.length) {
      var plan = GM.newPlan(project.mapId, '方案 ' + (project.plans.length + 1));
      GM.ensurePlanMeta(plan);
      project.plans.push(plan);
      project.activePlanId = plan.id;
      list = [plan];
    } else {
      var found = list.some(function (p) { return p.id === project.activePlanId; });
      if (!found) project.activePlanId = list[0].id;
    }

    var active = GM.activePlan();
    if (!active) return null;
    GM.ensurePlanMeta(active);
    if (!Array.isArray(active.phases) || !active.phases.length) {
      var phase = GM.newPhase('接敌前');
      active.phases = [phase];
      active.activePhaseId = phase.id;
    }
    var phaseFound = active.phases.some(function (p) { return p.id === active.activePhaseId; });
    if (!phaseFound) active.activePhaseId = active.phases[0].id;
    return active;
  };

  GM.eachTeam = function (cb) {
    var project = GM.state.project;
    if (!project) return;
    var roots = project.teams;

    function rec(list, parent, depth) {
      for (var i = 0; i < list.length; i++) {
        var node = list[i];
        cb(node, { list: list, index: i, parent: parent, depth: depth });
        if (node.children && node.children.length) rec(node.children, node, depth + 1);
      }
    }
    rec(roots, null, 0);
  };

  GM.findTeam = function (id) {
    var found = null;
    GM.eachTeam(function (node) {
      if (!found && node.id === id) found = node;
    });
    return found;
  };

  GM.findTeamContext = function (id) {
    var found = null;
    GM.eachTeam(function (node, ctx) {
      if (!found && node.id === id) found = { node: node, list: ctx.list, index: ctx.index, parent: ctx.parent, depth: ctx.depth };
    });
    return found;
  };

  GM.teamPath = function (id) {
    var project = GM.state.project;
    if (!project) return [];
    var path = [];

    function rec(list, trail) {
      for (var i = 0; i < list.length; i++) {
        var node = list[i];
        var next = trail.concat(node);
        if (node.id === id) { path = next; return true; }
        if (node.children && rec(node.children, next)) return true;
      }
      return false;
    }
    rec(project.teams, []);
    return path;
  };

  GM.findMember = function (memberId) {
    var found = null;
    GM.eachTeam(function (node) {
      if (found || node.kind !== 'squad') return;
      for (var i = 0; i < node.members.length; i++) {
        if (node.members[i].id === memberId) {
          found = { member: node.members[i], squad: node, list: node.members, index: i };
          return;
        }
      }
    });
    if (!found) {
      var pool = (GM.state.project && GM.state.project.pool) || [];
      for (var j = 0; j < pool.length; j++) {
        if (pool[j].id === memberId) {
          found = { member: pool[j], squad: null, list: pool, index: j, pool: true };
          break;
        }
      }
    }
    return found;
  };

  /* 候补池：不占 30 人编制，独立于联盟 → 团队 → 小队 树 */
  GM.pool = function () {
    var project = GM.state.project;
    if (!project) return [];
    if (!Array.isArray(project.pool)) project.pool = [];
    return project.pool;
  };

  GM.removePoolMember = function (memberId) {
    var pool = GM.pool();
    for (var i = 0; i < pool.length; i++) {
      if (pool[i].id === memberId) {
        pool.splice(i, 1);
        var sel = GM.state.ui.selected;
        if (sel && sel.type === 'member' && sel.id === memberId) GM.state.ui.selected = null;
        return true;
      }
    }
    return false;
  };

  GM.teamCount = function (node) {
    if (!node) return 0;
    if (node.kind === 'squad') return (node.members || []).length;
    var total = 0;
    (node.children || []).forEach(function (child) { total += GM.teamCount(child); });
    return total;
  };

  GM.teamCapacity = function (node) {
    return U.teamKindInit(node && node.kind).max;
  };

  GM.teamColor = function (node) {
    if (!node) return '#c9a55a';
    if (node.color) return node.color;
    var faction = U.factionById(node.factionId);
    return (faction && faction.color) || '#c9a55a';
  };

  /* ============================ 标记人数 / 填充 / 敌我 ============================ */

  /* 标记显示人数：countLink=true 时实时读编成（teamId / 小队 / 个人），否则读固定值 count */
  GM.markerCount = function (marker) {
    if (!marker) return 0;
    if (marker.countLink) {
      var live = null;
      if (marker.teamId) live = GM.findTeam(marker.teamId);
      else if (marker.ref && marker.ref.type === 'squad' && marker.ref.squadId) live = GM.findTeam(marker.ref.squadId);
      if (live) return GM.teamCount(live);
      if (marker.ref && marker.ref.type === 'person') return 1;
      if (marker.ref && marker.ref.type === 'squad') return Number(marker.ref.count || 0);
    }
    return Math.max(0, Math.round(Number(marker.count) || 0));
  };

  /* 是否能「重新链接编成」：只对确实来自实时编成的标记开放（工具栏新建的标记没有来源） */
  GM.markerCanRelink = function (marker) {
    if (!marker) return false;
    if (marker.teamId) return true;
    var ref = marker.ref;
    if (!ref) return false;
    if (ref.type === 'person') return !!(ref.memberId || ref.liveId);
    if (ref.type === 'squad') return !!(ref.squadId || ref.liveId);
    return false;
  };

  /* 三级标记（联盟 / 团队 / 小队）的填充色：自定义 fill 优先，缺省白色；个人标记始终职业色 */
  GM.markerFill = function (marker) {
    var ref = marker && marker.ref;
    if (ref && ref.type === 'person' && !marker.teamId) {
      var cls = U.classById(ref.classId);
      return (cls && cls.color) || ref.classColor || '#8a919f';
    }
    return String((marker && marker.fill) || '#ffffff');
  };

  /* 工具栏「团队」落点：三级标记填充 = 所选敌方色，relation 对应敌方项；个人级按职业色 */
  GM.placeTeamMarker = function (kind, relationId, x, y, count) {
    var phase = GM.activePhase();
    var project = GM.state.project;
    if (!phase || !project) return null;
    if (['alliance', 'team', 'squad', 'person'].indexOf(kind) < 0) return null;
    var fixedCount = Math.max(0, Math.min(150, Math.round(Number(count) || 0)));

    var md = GM.currentMap();
    var bd = (md && md.board) || { width: 1600, height: 1000 };
    var level = md && md.layers && md.layers.length > 1
      ? (project.mapLevel || GM.defaultMapLevel(md)) : 'ground';
    var rel = GM.relationById(GM.normRelation(relationId));
    var pos = {
      x: U.clamp(Math.round(x), 0.5, bd.width - 0.5),
      y: U.clamp(Math.round(y), 0.5, bd.height - 0.5)
    };

    var marker;
    if (kind === 'person') {
      var classes = project.classes || window.GM_DATA.classes || [];
      var cls = classes[0] || { id: 'class-1', name: '未知职业', color: '#8a919f' };
      marker = {
        id: U.uid('marker'),
        teamId: '',
        ref: {
          type: 'person',
          presetId: '',
          liveId: '',
          teamId: '',
          squadId: '',
          factionId: '',
          memberId: '',
          name: '个人标记',
          classId: String(cls.id || 'class-1'),
          classColor: String(cls.color || '#8a919f'),
          className: String(cls.name || ''),
          form: '',
          skills: []
        },
        x: pos.x,
        y: pos.y,
        rot: 0,
        relation: 'enemy-red',
        fill: '',
        count: 0,
        countLink: false,
        status: 'idle',
        note: '',
        mapLayer: level
      };
    } else {
      marker = {
        id: U.uid('marker'),
        teamId: '',
        ref: {
          type: 'preset',
          presetId: '',
          liveId: '',
          teamId: '',
          squadId: '',
          factionId: '',
          kind: kind,
          presetKind: kind,
          name: U.teamKindInit(kind).label + '标记',
          count: fixedCount,
          color: rel.color
        },
        x: pos.x,
        y: pos.y,
        rot: 0,
        relation: rel.id,
        fill: rel.color,
        count: fixedCount,
        countLink: false,
        status: 'idle',
        note: '',
        mapLayer: level
      };
    }
    phase.markers.push(marker);
    return marker;
  };

  /* 图标型标记：目前只有集结旗号走这条路；旧存档里的进攻 / 防守等图标标记仍按
     iconType / iconName / iconColor 渲染。缺少 ref / teamId，因此不参与编成与推演。 */
  GM.placeIconMarker = function (type, x, y) {
    var phase = GM.activePhase();
    var project = GM.state.project;
    if (!phase || !project) return null;
    var defs = window.GM_DATA.iconMarkers || [];
    var def = null;
    defs.forEach(function (d) { if (d.id === type) def = d; });
    if (!def) return null;

    var md = GM.currentMap();
    var bd = (md && md.board) || { width: 1600, height: 1000 };
    var level = md && md.layers && md.layers.length > 1
      ? (project.mapLevel || GM.defaultMapLevel(md)) : 'ground';

    var marker = {
      id: U.uid('marker'),
      teamId: '',
      ref: null,
      x: U.clamp(Math.round(x), 0.5, bd.width - 0.5),
      y: U.clamp(Math.round(y), 0.5, bd.height - 0.5),
      rot: 0,
      relation: 'own',
      fill: '',
      count: 0,
      countLink: false,
      status: 'idle',
      note: '',
      mapLayer: level,
      iconType: def.id,
      iconName: def.name,
      iconColor: def.color
    };
    phase.markers.push(marker);
    return marker;
  };

  GM.canAddMember = function (squadId) {
    var squad = GM.findTeam(squadId);
    if (!squad) return { ok: false, msg: '找不到该小队' };
    if (squad.kind !== 'squad') return { ok: false, msg: '只有小队可以添加成员' };

    if (squad.members.length >= U.teamKindInit('squad').max) {
      return { ok: false, msg: '小队人数已达上限（6 人）' };
    }

    var path = GM.teamPath(squadId);
    for (var i = 0; i < path.length - 1; i++) {
      var node = path[i];
      var kindInfo = U.teamKindInit(node.kind);
      if (GM.teamCount(node) >= kindInfo.max) {
        return { ok: false, msg: kindInfo.label + '「' + node.name + '」人数已达上限（' + kindInfo.max + ' 人）' };
      }
    }
    return { ok: true };
  };

  /* ============================ 编成预设（只读快照） ============================ */

  GM.findPreset = function (id) {
    var list = (GM.state.project && GM.state.project.presets) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  };

  GM.presetCount = function (preset) {
    if (!preset || !preset.node) return 0;
    return GM.teamCount(preset.node);
  };

  GM.presets = function () {
    return (GM.state.project && GM.state.project.presets) || [];
  };

  /* 每张地图自己的世界尺寸（旧图 1600×1000，四方战 328.23×437.9 unit） */
  function mapBoardOf(mapId) {
    var md = window.GM_DATA.mapById(mapId);
    return (md && md.board) || { width: 1600, height: 1000 };
  }

  /* 四方战 v1 旧坐标 → v2 坐标（主通道锚点拟合的仿射 + 最近可行走点吸附） */
  GM.reprojectFourClub = function (x, y) {
    var md = window.GM_DATA.mapById('four-club');
    var b = md.board || { width: 1600, height: 1000 };
    var nx = 0.2753 * Number(x || 0) - 55.5;
    var ny = 0.3891 * Number(y || 0) + 35.9;
    var snap = U.nearestWalkable(md, nx, ny, 30);
    return {
      x: U.clamp(snap.x, 0.5, b.width - 0.5),
      y: U.clamp(snap.y, 0.5, b.height - 0.5),
      snapped: snap.snapped
    };
  };

  /* v2 → v3：坐标口径不变（1 unit = 1 人宽），只按新轮廓吸附到可行走面内 */
  GM.snapFourClub = function (x, y) {
    var md = window.GM_DATA.mapById('four-club');
    var b = md.board || { width: 1600, height: 1000 };
    var snap = U.nearestWalkable(md, Number(x || 0), Number(y || 0), 30);
    return {
      x: U.clamp(snap.x, 0.5, b.width - 0.5),
      y: U.clamp(snap.y, 0.5, b.height - 0.5),
      snapped: snap.snapped
    };
  };

  /* 小队建制标记：拖「小队列头 / 整列」到沙盘时生成，source 保留 presetId/teamId/squadId */
  GM.addSquadMarker = function (drag, x, y) {
    var phase = GM.activePhase();
    var project = GM.state.project;
    if (!phase || !project || !drag) return null;

    var md = GM.currentMap();
    var board = (md && md.board) || { width: 1600, height: 1000 };
    var level = md.layers && md.layers.length > 1 ? (project.mapLevel || GM.defaultMapLevel(md)) : 'ground';

    var squad = drag.squadId ? GM.findTeam(drag.squadId) : null;
    var count = squad ? GM.teamCount(squad) : Number(drag.count || 0);
    if (!count) return null;

    var path = squad ? GM.teamPath(squad.id) : [];
    var teamNode = path.length >= 2 ? path[path.length - 2] : null;
    var teamName = String(drag.teamName || (teamNode && teamNode.name) || '');
    var squadName = String(drag.name || (squad && squad.name) || ('小队' + (Number(drag.index || 0) + 1)));
    var name = teamName ? teamName + '/' + squadName : squadName;
    var color = teamNode ? GM.teamColor(teamNode) : (drag.color || '#7EC8E3');
    var factionId = (teamNode && teamNode.factionId) || drag.factionId || 'A';

    var marker = {
      id: U.uid('marker'),
      teamId: '',
      ref: {
        type: 'squad',
        kind: 'squad',
        presetId: String(drag.presetId || ''),
        liveId: String(drag.liveId || ''),
        teamId: String(drag.teamId || (teamNode && teamNode.id) || ''),
        squadId: String(drag.squadId || ''),
        name: name,
        count: count,
        color: color,
        factionId: factionId
      },
      x: Math.round(U.clamp(x, 0.5, board.width - 0.5)),
      y: Math.round(U.clamp(y, 0.5, board.height - 0.5)),
      rot: 0,
      relation: 'own',
      fill: '#ffffff',
      count: count,
      countLink: true,
      status: 'idle',
      note: '',
      mapLayer: level
    };
    phase.markers.push(marker);
    return marker;
  };

  /* 单人标记：拖动预设里的单个色块生成 */
  GM.addPersonMarker = function (preset, member, x, y) {
    var phase = GM.activePhase();
    var project = GM.state.project;
    if (!phase || !project || !preset || !member) return null;

    var md = GM.currentMap();
    var board = (md && md.board) || { width: 1600, height: 1000 };
    var level = md.layers && md.layers.length > 1 ? (project.mapLevel || GM.defaultMapLevel(md)) : 'ground';
    var cls = null;
    (project.classes || []).forEach(function (c) { if (c.id === member.classId) cls = c; });
    if (!cls) {
      (window.GM_DATA.classes || []).forEach(function (c) { if (c.id === member.classId) cls = c; });
    }

    /* 记录来源链路（团队 / 小队），供「点标记回到编成」使用 */
    var squadInfo = { squad: null, team: null };
    (function rec(node, team) {
      if (!node) return;
      if (node.kind === 'squad') {
        (node.members || []).forEach(function (m) {
          if (m.id === member.id) squadInfo = { squad: node, team: team };
        });
        return;
      }
      (node.children || []).forEach(function (child) {
        rec(child, node.kind === 'team' ? node : team);
      });
    })(preset.node, null);

    var factionId = (squadInfo.team && squadInfo.team.factionId) ||
      (preset.node && preset.node.factionId) || 'A';

    var marker = {
      id: U.uid('marker'),
      teamId: '',
      ref: {
        type: 'person',
        presetId: preset.id,
        presetName: preset.name,
        liveId: preset.id === 'live' ? String(preset.node && preset.node.id || '') : '',
        teamId: String(squadInfo.team && squadInfo.team.id || ''),
        squadId: String(squadInfo.squad && squadInfo.squad.id || ''),
        factionId: String(factionId),
        memberId: member.id,
        name: member.name,
        classId: member.classId,
        classColor: (cls && cls.color) || '#8a919f',
        className: (cls && cls.name) || '',
        form: member.form || member.sequence || '',
        skills: (member.skills || []).map(function (s) { return String(s || ''); })
      },
      x: Math.round(U.clamp(x, 0.5, board.width - 0.5)),
      y: Math.round(U.clamp(y, 0.5, board.height - 0.5)),
      rot: 0,
      relation: 'own',
      fill: '',
      count: 1,
      countLink: true,
      status: 'idle',
      note: '',
      mapLayer: level
    };
    phase.markers.push(marker);
    return marker;
  };

  /* ============================ 选择 ============================ */

  GM.select = function (type, id) {
    GM.state.ui.selected = type ? { type: type, id: id } : null;
    GM.bus.emit('selection');
  };

  GM.clearSelection = function () {
    if (!GM.state.ui.selected) return;
    GM.state.ui.selected = null;
    GM.bus.emit('selection');
  };

  GM.isSelected = function (type, id) {
    var sel = GM.state.ui.selected;
    return !!sel && sel.type === type && sel.id === id;
  };

  /* ============================ 撤销栈 ============================ */

  GM.history = {
    stack: [],
    index: -1,
    limit: 60
  };

  GM.serialize = function () {
    return JSON.stringify(GM.state.project);
  };

  GM.resetHistory = function () {
    var snap = GM.serialize();
    GM.history.stack = [snap];
    GM.history.index = 0;
  };

  GM.commit = function (label) {
    var project = GM.state.project;
    if (!project) return;
    project.updatedAt = new Date().toISOString();

    var snap = GM.serialize();
    var h = GM.history;
    if (h.index < h.stack.length - 1) h.stack = h.stack.slice(0, h.index + 1);

    if (h.stack[h.index] !== snap) {
      h.stack.push(snap);
      h.index++;
      if (h.stack.length > h.limit) {
        h.stack.shift();
        h.index--;
      }
    }

    GM.bus.emit('change', { label: label || '' });
    if (GM.saveSoon) GM.saveSoon();
  };

  /* 不写入撤销栈的刷新（切换阶段、图层显隐、折叠面板等视图状态） */
  GM.refresh = function (label) {
    var project = GM.state.project;
    if (project) project.updatedAt = new Date().toISOString();
    GM.bus.emit('change', { label: label || '', noHistory: true });
    if (GM.saveSoon) GM.saveSoon();
  };

  GM.undo = function () {
    var h = GM.history;
    if (h.index <= 0) return false;
    h.index--;
    GM.state.project = JSON.parse(h.stack[h.index]);
    GM.state.ui.selected = null;
    GM.state.ui.diff = false;
    GM.ensureActivePlan();
    GM.bus.emit('change', { label: 'undo' });
    GM.bus.emit('selection');
    if (GM.saveSoon) GM.saveSoon();
    return true;
  };

  GM.redo = function () {
    var h = GM.history;
    if (h.index >= h.stack.length - 1) return false;
    h.index++;
    GM.state.project = JSON.parse(h.stack[h.index]);
    GM.state.ui.selected = null;
    GM.state.ui.diff = false;
    GM.ensureActivePlan();
    GM.bus.emit('change', { label: 'redo' });
    GM.bus.emit('selection');
    if (GM.saveSoon) GM.saveSoon();
    return true;
  };

  GM.canUndo = function () { return GM.history.index > 0; };
  GM.canRedo = function () { return GM.history.index < GM.history.stack.length - 1; };

  /* ============================ 队伍 / 标记 变更辅助 ============================ */

  GM.deleteTeam = function (teamId) {
    var ctx = GM.findTeamContext(teamId);
    if (!ctx) return false;

    var removedIds = {};
    (function collect(node) {
      removedIds[node.id] = true;
      (node.children || []).forEach(collect);
    })(ctx.node);

    ctx.list.splice(ctx.index, 1);

    var project = GM.state.project;
    project.plans.forEach(function (plan) {
      plan.phases.forEach(function (phase) {
        phase.markers = phase.markers.filter(function (m) { return !removedIds[m.teamId]; });
      });
    });

    var sel = GM.state.ui.selected;
    if (sel && (removedIds[sel.id] || (sel.type === 'team' && removedIds[sel.id]))) {
      GM.state.ui.selected = null;
    }
    return true;
  };

  GM.deleteMember = function (squadId, memberId) {
    var squad = GM.findTeam(squadId);
    if (!squad || squad.kind !== 'squad') return false;
    for (var i = 0; i < squad.members.length; i++) {
      if (squad.members[i].id === memberId) {
        squad.members.splice(i, 1);
        var sel = GM.state.ui.selected;
        if (sel && sel.type === 'member' && sel.id === memberId) GM.state.ui.selected = null;
        return true;
      }
    }
    return false;
  };

  GM.deleteMarker = function (markerId) {
    var phase = GM.activePhase();
    if (!phase) return false;
    for (var i = 0; i < phase.markers.length; i++) {
      if (phase.markers[i].id === markerId) {
        phase.markers.splice(i, 1);
        return true;
      }
    }
    return false;
  };

  GM.deleteShape = function (shapeId) {
    var phase = GM.activePhase();
    if (!phase) return false;
    for (var i = 0; i < phase.shapes.length; i++) {
      if (phase.shapes[i].id === shapeId) {
        phase.shapes.splice(i, 1);
        return true;
      }
    }
    return false;
  };

  GM.addMarker = function (teamId, x, y) {
    var phase = GM.activePhase();
    var team = GM.findTeam(teamId);
    if (!phase || !team) return null;

    var md = GM.currentMap();
    var board = (md && md.board) || { width: 1600, height: 1000 };
    var level = md.layers && md.layers.length > 1 ? (GM.state.project.mapLevel || GM.defaultMapLevel(md)) : 'ground';

    var marker = {
      id: U.uid('marker'),
      teamId: team.id,
      x: Math.round(U.clamp(x, 0.5, board.width - 0.5)),
      y: Math.round(U.clamp(y, 0.5, board.height - 0.5)),
      rot: 0,
      relation: 'own',
      fill: '#ffffff',
      count: GM.teamCount(team),
      countLink: true,
      status: 'idle',
      note: '',
      mapLayer: level
    };
    phase.markers.push(marker);
    return marker;
  };

  /* ============================ 攻城态势 ============================ */

  GM.siegeGateState = function (plan, gate) {
    var md = window.GM_DATA.mapById(plan.mapId);
    if (!plan || !plan.siege) return 'locked';
    if (plan.siege.gates && plan.siege.gates[gate.id]) return 'broken';
    var steles = plan.siege.steles || {};
    var ok = gate.unlocks.every(function (steleId) { return steles[steleId] === gate.factionId; });
    return ok ? 'ready' : 'locked';
  };

  GM.siegeGateLabel = function (state) {
    return state === 'broken' ? '已破' : (state === 'ready' ? '可攻' : '未解锁');
  };

  GM.siegeScoreTarget = function (plan) {
    var md = window.GM_DATA.mapById(plan.mapId);
    return (md.siege && md.siege.platform && md.siege.platform.scoreTarget) || 100;
  };

  GM.siegeWinner = function (plan) {
    if (!plan || !plan.siege) return null;
    var target = GM.siegeScoreTarget(plan);
    var scores = plan.siege.platformScores || {};
    var winner = null;
    Object.keys(scores).forEach(function (fid) {
      if (Number(scores[fid]) >= target) {
        if (!winner || Number(scores[fid]) > Number(scores[winner])) winner = fid;
      }
    });
    return winner;
  };

  /* ============================ 导入 / 规范化 ============================ */

  function validMapId(id) {
    var maps = window.GM_DATA.maps;
    for (var i = 0; i < maps.length; i++) if (maps[i].id === id) return true;
    return false;
  }

  function normNumber(value, fallback, min, max) {
    var n = Number(value);
    if (!isFinite(n)) n = fallback;
    if (typeof min === 'number') n = Math.max(min, n);
    if (typeof max === 'number') n = Math.min(max, n);
    return n;
  }

  /* 朝向归一化：0~360 取模（不要把超出值截断），-180 等旧值会自然落到 180 */
  GM.normAngle = function (value, fallback) {
    var n = Number(value);
    if (!isFinite(n)) n = Number(fallback) || 0;
    n = Math.round(n) % 360;
    if (n < 0) n += 360;
    return n;
  };

  /* 敌我关系 8 值：id / 名称 / 旧颜色串 / 旧内部值都能解析；缺省与非法值按旧 enemy 语义落到 enemy-red */
  GM.relationById = function (id) {
    var list = window.GM_DATA.relations || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return { id: 'enemy-red', name: '敌方(红)', color: '#e0645c' };
  };

  GM.normRelation = function (value) {
    var raw = String(value == null ? '' : value).trim();
    if (!raw) return 'enemy-red';

    var list = window.GM_DATA.relations || [];
    var i;
    for (i = 0; i < list.length; i++) if (list[i].id === raw) return raw;
    for (i = 0; i < list.length; i++) if (list[i].name === raw) return list[i].id;

    var aliases = window.GM_DATA.relationAliases || {};
    if (Object.prototype.hasOwnProperty.call(aliases, raw)) return aliases[raw];
    var low = raw.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(aliases, low)) return aliases[low];

    /* 旧存档把颜色直接写进敌我字段时的兜底 */
    var hex = low.charAt(0) === '#' ? low : ('#' + low);
    for (i = 0; i < list.length; i++) {
      if (String(list[i].color).toLowerCase() === hex) return list[i].id;
    }
    var legacy = window.GM_DATA.relationLegacyColors || {};
    if (Object.prototype.hasOwnProperty.call(legacy, hex)) return legacy[hex];

    return 'enemy-red';
  };

  function normClass(c, index) {
    var def = window.GM_DATA.classes[index % window.GM_DATA.classes.length] || {};
    c = c || {};
    var name = String(c.name || def.name || ('职业 ' + (index + 1)));
    return {
      id: String(c.id || def.id || U.uid('class')),
      name: name,
      abbr: String(c.abbr || def.abbr || name.slice(0, 1)),
      role: String(c.role || def.role || ''),
      color: String(c.color || def.color || '#c9a55a'),
      placeholder: c.placeholder === true,
      note: String(c.note || def.note || ''),
      skills: Array.isArray(c.skills) ? c.skills.map(function (s) { return String(s || ''); }) : [],
      /* 形态白名单（首项为默认）来自 data/classes.js，存档归一化时不能丢 */
      forms: Array.isArray(c.forms) && c.forms.length
        ? c.forms.map(function (f) { return String(f || ''); })
        : (Array.isArray(def.forms) ? def.forms.slice() : [])
    };
  }

  /* 形态以 data/classes.js 的 forms 为准（第一项即默认）；非法值回落该职业默认形态 */
  function normForm(classId, form) {
    var d = defaultFormOf(classId);
    var opts = [d];
    var lists = (window.GM_DATA && window.GM_DATA.classes) || [];
    for (var i = 0; i < lists.length; i++) {
      if (lists[i].id === classId && lists[i].forms && lists[i].forms.length) {
        opts = lists[i].forms.slice();
        d = opts[0];
        break;
      }
    }
    var f = String(form == null ? '' : form);
    return opts.indexOf(f) >= 0 ? f : d;
  }

  function normMember(m) {
    m = m || {};
    var skills = [];
    var count = window.GM_DATA.skillSlotCount || 4;
    for (var i = 0; i < count; i++) {
      skills.push(String((m.skills && m.skills[i]) || ''));
    }
    var classId = String(m.classId || 'class-1');
    var out = {
      id: String(m.id || U.uid('member')),
      name: String(m.name || '未命名成员'),
      classId: classId,
      sequence: String(m.sequence == null ? '' : m.sequence),
      /* 旧存档把「序列」塞进 form：非法值统一按职业默认形态校正 */
      form: normForm(classId, m.form),
      level: String(m.level == null ? '' : m.level),
      skills: skills,
      note: String(m.note || '')
    };
    /* 候补池来源标记（表名 / 列名 / 行号）随成员一起存档 */
    if (m.source && typeof m.source === 'object') {
      out.source = {
        sheet: String(m.source.sheet || ''),
        column: String(m.source.column || ''),
        row: Number(m.source.row) || 0
      };
    }
    return out;
  }

  function normTeam(node, depth) {
    node = node || {};
    var kind = ['alliance', 'team', 'squad'].indexOf(node.kind) > -1 ? node.kind : (depth === 0 ? 'team' : 'squad');
    node.id = String(node.id || U.uid('team'));
    node.kind = kind;
    node.name = String(node.name || U.teamKindInit(kind).label + ' 未命名');
    node.color = String(node.color || '');
    node.factionId = factionAliasId(node.factionId) || 'A';
    node.note = String(node.note || '');
    node.members = Array.isArray(node.members) ? node.members.map(normMember) : [];
    node.children = Array.isArray(node.children) ? node.children.map(function (child) { return normTeam(child, depth + 1); }) : [];

    if (kind === 'squad') node.children = [];
    if (kind !== 'squad') node.members = [];
    return node;
  }

  function normRef(ref) {
    if (!ref || typeof ref !== 'object') return null;
    var source = {
      presetId: String(ref.presetId || ''),
      liveId: String(ref.liveId || ''),
      teamId: String(ref.teamId || ''),
      squadId: String(ref.squadId || ''),
      factionId: factionAliasId(ref.factionId) || String(ref.factionId || '')
    };
    if (ref.type === 'person') {
      return {
        type: 'person',
        presetId: source.presetId,
        memberId: String(ref.memberId || ''),
        name: String(ref.name || '队员'),
        classId: String(ref.classId || 'class-1'),
        classColor: String(ref.classColor || '#8a919f'),
        className: String(ref.className || ''),
        form: String(ref.form || ''),
        skills: Array.isArray(ref.skills) ? ref.skills.map(function (s) { return String(s || ''); }) : [],
        presetName: String(ref.presetName || ''),
        liveId: source.liveId,
        teamId: source.teamId,
        squadId: source.squadId,
        factionId: source.factionId
      };
    }
    if (ref.type === 'preset') {
      return {
        type: 'preset',
        presetId: source.presetId,
        kind: ['squad', 'team', 'alliance'].indexOf(ref.kind) > -1 ? ref.kind : 'team',
        name: String(ref.name || '编成预设'),
        count: normNumber(ref.count, 0, 0, 150),
        color: String(ref.color || '#c9a55a'),
        presetKind: ['squad', 'team', 'alliance'].indexOf(ref.presetKind) > -1 ? ref.presetKind : 'team',
        liveId: source.liveId,
        teamId: source.teamId,
        squadId: source.squadId,
        factionId: source.factionId
      };
    }
    if (ref.type === 'squad') {
      return {
        type: 'squad',
        kind: 'squad',
        presetId: source.presetId,
        liveId: source.liveId,
        teamId: source.teamId,
        squadId: source.squadId,
        factionId: source.factionId,
        name: String(ref.name || '小队'),
        count: normNumber(ref.count, 0, 0, 6),
        color: String(ref.color || '#7EC8E3')
      };
    }
    return null;
  }

  function normMarker(m) {
    m = m || {};
    var statusIds = (window.GM_DATA.statuses || []).map(function (s) { return s.id; });
    var ref = normRef(m.ref);
    var relationId = GM.normRelation(m.relation);

    /* 人数：count 为固定值；countLink=true 时实时读编成。
       旧存档没有这两个字段时按来源推断（团队 / 小队 / 个人默认链接，其它默认固定）。 */
    var canLink = false;
    if (m.teamId) canLink = true;
    else if (ref && ref.type === 'person') canLink = !!(ref.memberId || ref.liveId);
    else if (ref && ref.type === 'squad') canLink = !!(ref.squadId || ref.liveId);
    var countLink = typeof m.countLink === 'boolean' ? m.countLink : canLink;
    var rawCount = Number(m.count);
    if (!isFinite(rawCount)) {
      if (ref && ref.type === 'person') rawCount = 1;
      else if (ref && (ref.type === 'squad' || ref.type === 'preset')) rawCount = Number(ref.count || 0);
      else rawCount = 0;
    }
    rawCount = Math.max(0, Math.min(150, Math.round(rawCount)));

    /* 填充色：新字段 fill 独立于敌我。旧存档缺 fill 时用旧敌我色补一次，保持原视觉；
       个人标记不落 fill（渲染始终按职业色）。 */
    var fill = String(m.fill || '');
    if (!fill && !(ref && ref.type === 'person' && !m.teamId)) {
      fill = GM.relationById(relationId).color;
    }

    var out = {
      id: String(m.id || U.uid('marker')),
      teamId: String(m.teamId || ''),
      ref: ref,
      x: Math.round(normNumber(m.x, 0, 0, 1600)),
      y: Math.round(normNumber(m.y, 0, 0, 1000)),
      rot: GM.normAngle(m.rot, 0),
      relation: relationId,
      fill: fill,
      count: rawCount,
      countLink: countLink,
      status: statusIds.indexOf(m.status) > -1 ? m.status : 'idle',
      note: String(m.note || ''),
      /* 缺省按二层：旧存档没有 mapLayer 时不会因默认高程切到 upper 而消失 */
      mapLayer: m.mapLayer === 'ground' ? 'ground' : 'upper'
    };

    /* 第二类标记工具（图标型）：只保存图元本身，不写 relation / count 之外的推演字段 */
    var iconIds = (window.GM_DATA.iconMarkers || []).map(function (d) { return d.id; });
    if (iconIds.indexOf(m.iconType) > -1) {
      var iconDef = null;
      (window.GM_DATA.iconMarkers || []).forEach(function (d) { if (d.id === m.iconType) iconDef = d; });
      out.iconType = m.iconType;
      out.iconName = String(m.iconName || (iconDef && iconDef.name) || '标记');
      out.iconColor = /^#[0-9a-fA-F]{6}$/.test(String(m.iconColor || ''))
        ? String(m.iconColor)
        : ((iconDef && iconDef.color) || '#c9a55a');
    }
    return out;
  }

  function normShape(s) {
    s = s || {};
    var kinds = ['route', 'rally', 'zoneRect', 'zoneCircle', 'note', 'skill', 'line'];
    var kind = kinds.indexOf(s.kind) > -1 ? s.kind : 'note';
    var layer = ['zones', 'routes', 'notes'].indexOf(s.layer) > -1 ? s.layer :
      (kind === 'route' || kind === 'line' ? 'routes' : (kind === 'rally' || kind === 'note' ? 'notes' : 'zones'));

    var points = [];
    if (Array.isArray(s.points)) {
      s.points.forEach(function (p) {
        if (!p) return;
        points.push({ x: normNumber(p.x, 0, 0, 1600), y: normNumber(p.y, 0, 0, 1000) });
      });
    }

    var out = {
      id: String(s.id || U.uid('shape')),
      kind: kind,
      layer: layer,
      mapLayer: s.mapLayer === 'ground' ? 'ground' : 'upper',
      x: normNumber(s.x, 0, 0, 1600),
      y: normNumber(s.y, 0, 0, 1000),
      w: normNumber(s.w, 0, 0, 1600),
      h: normNumber(s.h, 0, 0, 1000),
      r: normNumber(s.r, 0, 0, 800),
      points: points,
      text: String(s.text || ''),
      color: String(s.color || ''),
      width: normNumber(s.width, 3, 1, 12)
    };

    if (kind === 'line') {
      /* 原画线组：lineType 决定末端图元与默认线型；dashed 允许检查器/绘线时保留 */
      var lineIds = (window.GM_DATA.lineTools || []).map(function (d) { return d.id; });
      out.lineType = lineIds.indexOf(s.lineType) > -1 ? s.lineType : 'attack';
      out.dashed = s.dashed === true;
    }

    if (kind === 'skill') {
      /* 技能范围：圆形 / 扇形 / 矩形；angle 为朝向，span 为扇形张角，
         len / wid 为矩形长宽（1 米 = 1 unit，不跟地图像素比例） */
      out.shapeType = (s.shapeType === 'sector' || s.shapeType === 'rect') ? s.shapeType : 'circle';
      out.angle = normNumber(s.angle, 0, -360, 360);
      out.span = normNumber(s.span, 90, 1, 360);
      out.len = normNumber(s.len, 20, 1, 1600);
      out.wid = normNumber(s.wid, 3, 0.2, 1600);
      /* 旧存档的技能范围一直是虚线，缺 dashed 时按虚线补 */
      out.dashed = s.dashed === false ? false : true;
      out.preset = ['yuxin', 'dagou', 'zuxian', 'custom'].indexOf(s.preset) > -1 ? s.preset : 'custom';
    }
    return out;
  }

  function normPhase(ph, index) {
    ph = ph || {};
    ph.id = String(ph.id || U.uid('phase'));
    ph.name = String(ph.name || ('阶段 ' + (index + 1)));
    ph.markers = Array.isArray(ph.markers) ? ph.markers.map(normMarker) : [];
    ph.shapes = Array.isArray(ph.shapes) ? ph.shapes.map(normShape) : [];
    ph.note = String(ph.note || '');
    return ph;
  }

  function normPlan(plan) {
    plan = plan || {};
    plan.id = String(plan.id || U.uid('plan'));
    plan.name = String(plan.name || '新方案');
    plan.mapId = validMapId(plan.mapId) ? plan.mapId : 'test-ground';
    plan.note = String(plan.note || '');
    plan.phases = Array.isArray(plan.phases) && plan.phases.length
      ? plan.phases.map(normPhase)
      : [normPhase(GM.newPhase('接敌前'), 0)];

    var hasPhase = plan.phases.some(function (p) { return p.id === plan.activePhaseId; });
    if (!hasPhase) plan.activePhaseId = plan.phases[0].id;
    GM.ensurePlanMeta(plan);
    return plan;
  }

  function normPreset(p, index) {
    p = p || {};
    var node = normTeam(p.node || p.team || {}, 0);
    var kind = node.kind;
    return {
      id: String(p.id || U.uid('preset')),
      name: String(p.name || ('预设 ' + (index + 1))),
      kind: kind,
      node: node,
      createdAt: String(p.createdAt || new Date().toISOString()),
      updatedAt: String(p.updatedAt || p.createdAt || new Date().toISOString())
    };
  }

  GM.normalizeProject = function (raw) {
    if (!raw || typeof raw !== 'object') throw new Error('文件内容不是对象');
    if (!Array.isArray(raw.teams)) throw new Error('缺少 teams 队伍数据');
    if (!Array.isArray(raw.plans)) throw new Error('缺少 plans 方案数据');

    var p = raw;
    p.schemaVersion = GM.SCHEMA_VERSION;
    p.id = String(p.id || U.uid('project'));
    p.name = String(p.name || '未命名战役');
    p.mapId = validMapId(p.mapId) ? p.mapId : 'test-ground';
    p.createdAt = String(p.createdAt || new Date().toISOString());
    p.updatedAt = String(p.updatedAt || new Date().toISOString());
    p.grid = {
      enabled: p.grid && p.grid.enabled !== false,
      size: normNumber(p.grid && p.grid.size, 32, 8, 200)
    };
    /* 旧版「严格墙体判定」开关已移除：墙体只作美术层，任何位置都能放标记 */
    if ('wallStrict' in p) delete p.wallStrict;
    /* 旧版四方战结界对象已移除（结界改画在底图四角），静默清理遗留字段 */
    if ('barrier' in p) delete p.barrier;
    p.mapVersions = p.mapVersions && typeof p.mapVersions === 'object' ? p.mapVersions : {};
    p.layers = {
      base: p.layers && p.layers.base !== false,
      zones: p.layers && p.layers.zones !== false,
      routes: p.layers && p.layers.routes !== false,
      markers: p.layers && p.layers.markers !== false,
      personal: p.layers && p.layers.personal !== false,
      notes: p.layers && p.layers.notes !== false,
      /* 地形底图的语义层（霍纳奇斯山脉用；其它地图渲染时忽略）。高度图为示意，默认关 */
      water: p.layers && p.layers.water !== false,
      ice: p.layers && p.layers.ice !== false,
      snow: p.layers && p.layers.snow !== false,
      height: p.layers && p.layers.height === true,
      road: p.layers && p.layers.road !== false,
      cliff: p.layers && p.layers.cliff !== false,
      points: p.layers && p.layers.points !== false,
      winds: p.layers && p.layers.winds !== false
    };

    /* 标识框显示策略：联盟 / 团队 / 小队默认固定显示，个人默认仅选中时显示；
       旧工程没有该字段时按默认值补齐，显式 false / true 的玩家选择保留 */
    var pinRaw = p.labels && p.labels.pinned;
    p.labels = {
      pinned: {
        alliance: pinRaw && pinRaw.alliance === false ? false : true,
        team: pinRaw && pinRaw.team === false ? false : true,
        squad: pinRaw && pinRaw.squad === false ? false : true,
        person: pinRaw && pinRaw.person === true
      }
    };

    var md = window.GM_DATA.mapById(p.mapId);
    var layerIds = (md.layers || [{ id: 'ground' }]).map(function (l) { return l.id; });
    p.mapLevel = layerIds.indexOf(p.mapLevel) > -1 ? p.mapLevel : GM.defaultMapLevel(md);
    /* 旧工程一次性切到星墓高原的默认二层；之后玩家手动选地面层会被保留。
       旧存档里没有层级概念，标记 / 绘图对象都在地面层；这批对象下面一并迁到二层，
       避免默认切到二层后已有布置「凭空消失」。 */
    var starLegacy = !!(md && md.id === 'star-tomb' && !p.starLevelDefaulted);
    if (starLegacy) {
      p.mapLevel = 'upper';
      p.starLevelDefaulted = true;
    }

    /* 四势力统一：内置 A–D 一律使用 data/classes.js 的当前名称与配色，
       旧存档里的旧名 / 旧色不再保留；不属于 A–D 的自定义势力原样保留，避免丢数据。 */
    var factionDefs = window.GM_DATA.defaultFactions || [];
    var savedFactions = Array.isArray(p.factions) ? p.factions : [];
    p.factions = factionDefs.map(function (def) {
      return { id: def.id, name: def.name, color: def.color };
    });
    savedFactions.forEach(function (f) {
      if (!f || typeof f !== 'object') return;
      var fid = factionAliasId(f.id);
      var builtIn = factionDefs.some(function (def) { return def.id === fid; });
      if (builtIn) return;
      var id = String(f.id || '');
      if (!id || p.factions.some(function (x) { return x.id === id; })) return;
      p.factions.push({
        id: id,
        name: String(f.name || id || '自定义势力'),
        color: String(f.color || '#8a919f')
      });
    });
    p.factionColorsVersion = 3;

    p.classes = Array.isArray(p.classes) && p.classes.length
      ? p.classes.map(normClass)
      : U.clone(window.GM_DATA.classes);

    /* 配色 v2 迁移：旧存档里的六职业色值一次性升级为新血条色系（自定义职业不受影响） */
    if (p.classColorsVersion !== 2) {
      p.classes.forEach(function (c) {
        (window.GM_DATA.classes || []).forEach(function (def) {
          if (def.name === c.name) c.color = def.color;
        });
      });
      p.classColorsVersion = 2;
    }

    /* 旧存档里是「占位职业」，自动迁移为六个真实职业（member.classId 仍按 class-1..6 对齐） */
    var legacy = p.classes.filter(function (c) { return /占位/.test(c.name) || c.placeholder === true; });
    if (legacy.length >= p.classes.length - 1) {
      p.classes = U.clone(window.GM_DATA.classes).map(function (def, i) {
        var old = p.classes[i] || {};
        def.id = old.id || def.id;
        if (Array.isArray(old.skills) && old.skills.some(function (s) { return !!s; })) def.skills = old.skills;
        return def;
      });
    }

    /* 形态清单以 data/classes.js 为唯一来源：每次载入都把内置职业的 forms 同步为当前数据，
       避免旧存档里写死的 forms（例如歌颂只有输出）把新形态挡在下拉与导入之外。自定义职业保持原样。 */
    p.classes.forEach(function (c) {
      (window.GM_DATA.classes || []).forEach(function (def) {
        if (def.id === c.id || def.name === c.name) {
          if (Array.isArray(def.forms) && def.forms.length) c.forms = def.forms.slice();
        }
      });
    });

    p.teams = p.teams.map(function (t) { return normTeam(t, 0); });
    p.pool = Array.isArray(p.pool) ? p.pool.map(normMember) : [];
    p.presets = Array.isArray(p.presets) ? p.presets.map(normPreset).filter(function (pr) {
      return pr && pr.node && pr.node.kind;
    }) : [];
    p.plans = p.plans.map(normPlan);

    /* 势力归属引用迁移：方案里的石碑归属、守卫归属、高台积分、护送归属与分值
       都可能存着旧势力 id / 别名，统一解析回 A–D；无法解析的值原样保留。 */
    p.plans.forEach(function (plan) {
      if (plan.siege) {
        var steles = plan.siege.steles || {};
        Object.keys(steles).forEach(function (k) {
          var v = steles[k];
          if (v) steles[k] = factionAliasId(v) || v;
        });
        plan.siege.platformScores = remapFactionKeys(plan.siege.platformScores);
      }
      if (plan.scoring && plan.scoring.ownership) {
        Object.keys(plan.scoring.ownership).forEach(function (k) {
          var v = plan.scoring.ownership[k];
          if (v) plan.scoring.ownership[k] = factionAliasId(v) || v;
        });
      }
      if (plan.escort) {
        if (plan.escort.carrierFactionId) {
          plan.escort.carrierFactionId = factionAliasId(plan.escort.carrierFactionId) || plan.escort.carrierFactionId;
        }
        plan.escort.scoreByFaction = remapFactionKeys(plan.escort.scoreByFaction);
      }
    });

    /* 星墓高原旧存档的层级迁移：旧版本没有高程概念，所有对象都被记成地面层；
       首次载入时统一改记二层，与新默认高程（二层）对齐。仅执行一次，之后玩家在
       地面层新建的对象保持 ground，不会再被改走。 */
    if (starLegacy) {
      p.plans.forEach(function (plan) {
        if (plan.mapId !== 'star-tomb') return;
        plan.phases.forEach(function (ph) {
          ph.markers.forEach(function (m) { if (m.mapLayer === 'ground') m.mapLayer = 'upper'; });
          ph.shapes.forEach(function (s) { if (s.mapLayer === 'ground') s.mapLayer = 'upper'; });
        });
      });
    }

    /* 标记字段版本：v3 起 marker 带 relation（8 值敌我）、fill（三级填充色）、count / countLink（人数）；
       旧存档由 normMarker 逐条补齐，不需要额外遍历改写 */
    p.markerFieldVersion = 3;

    /* 地图版本迁移：v1（1600×1000 视口坐标）→ v2（1 unit = 1 人宽）用仿射 + 吸附；
       v2 → v3（新轮廓）坐标口径不变，只按新墙体轮廓吸附。
       v3 → v4 → v5（边界直角化 + 圆角 / 上半镜像重绘，均为纯重绘）：坐标系不变、
       墙体也不再拦放置，所以旧标记一律原样保留，不做吸附、不做重投影。 */
    var migratedCount = 0;
    var fourVersion = (window.GM_DATA.mapById('four-club') || {}).mapVersion || 1;
    var fromVersion = p.mapVersions['four-club'] || 1;
    if (fromVersion < fourVersion) {
      if (fromVersion < 3) {
        var reproj = fromVersion < 2 ? GM.reprojectFourClub : GM.snapFourClub;
        p.plans.forEach(function (plan) {
          if (plan.mapId !== 'four-club') return;
          plan.phases.forEach(function (ph) {
            ph.markers.forEach(function (m) {
              var r = reproj(m.x, m.y);
              m.x = Math.round(r.x * 100) / 100;
              m.y = Math.round(r.y * 100) / 100;
              migratedCount++;
            });
            ph.shapes.forEach(function (s) {
              var r = reproj(s.x, s.y);
              s.x = Math.round(r.x * 100) / 100;
              s.y = Math.round(r.y * 100) / 100;
              if (fromVersion < 2) {
                s.w = Math.round(s.w * 0.2753 * 100) / 100;
                s.h = Math.round(s.h * 0.3891 * 100) / 100;
                s.r = Math.round(s.r * 0.33 * 100) / 100;
              }
              (s.points || []).forEach(function (pt) {
                var q = reproj(pt.x, pt.y);
                pt.x = Math.round(q.x * 100) / 100;
                pt.y = Math.round(q.y * 100) / 100;
              });
            });
          });
        });
      }
      p.mapVersions['four-club'] = fourVersion;
      if (migratedCount) {
        GM.migrationNotice = { map: '四方战场', count: migratedCount, version: fourVersion };
      }
    }

    /* 星墓高原 v1 → v2：v1 用旧视口坐标（1600×1000，world = px − (160,40)），
       v2 改用 unit（1 unit = 1 人宽 = 3 px，world = (px − (160,40)) / 3）。
       两者只差 1/3 系数（offset 在换算中约掉），所以坐标 / 宽高 / 半径 / 折点一律 / 3。 */
    var starVersion = (window.GM_DATA.mapById('star-tomb') || {}).mapVersion || 1;
    var starFromVersion = p.mapVersions['star-tomb'] || 1;
    var starMoved = 0;
    if (starFromVersion < starVersion) {
      p.plans.forEach(function (plan) {
        if (plan.mapId !== 'star-tomb') return;
        plan.phases.forEach(function (ph) {
          ph.markers.forEach(function (m) {
            m.x = Math.round(m.x / 3 * 100) / 100;
            m.y = Math.round(m.y / 3 * 100) / 100;
            starMoved++;
          });
          ph.shapes.forEach(function (s) {
            s.x = Math.round(s.x / 3 * 100) / 100;
            s.y = Math.round(s.y / 3 * 100) / 100;
            s.w = Math.round((s.w || 0) / 3 * 100) / 100;
            s.h = Math.round((s.h || 0) / 3 * 100) / 100;
            s.r = Math.round((s.r || 0) / 3 * 100) / 100;
            (s.points || []).forEach(function (pt) {
              pt.x = Math.round(pt.x / 3 * 100) / 100;
              pt.y = Math.round(pt.y / 3 * 100) / 100;
            });
          });
        });
      });
      p.mapVersions['star-tomb'] = starVersion;
      if (starMoved) {
        GM.migrationNotice = GM.migrationNotice
          ? { map: GM.migrationNotice.map + ' / 星墓高原', count: GM.migrationNotice.count + starMoved, version: starVersion }
          : { map: '星墓高原', count: starMoved, version: starVersion };
      }
    }

    /* 猎龙之城 v1 → v2：v1 是旧 1600×1000 占位视口，v2 按 1920×1080 参考图 1:1 重绘为
       960×540 unit（1 unit = 2 图像 px）。重投影 = 以旧图心 (800,500) 为原点等比 0.54
       （= min(960/1600, 540/1000)）放大到新图心 (480,270)：
       newX = (oldX − 800) × 0.54 + 480，newY = (oldY − 500) × 0.54 + 270。
       宽高 / 半径 / 折点用同一系数，之后由统一 clamp 收进 0..960 / 0..540。
       v2 → v3 只换路网几何（矢量化重绘），world 尺寸与单位不变，标记坐标原样保留、不做重投影。 */
    var huntVersion = (window.GM_DATA.mapById('hunt-city') || {}).mapVersion || 1;
    var huntFromVersion = p.mapVersions['hunt-city'] || 1;
    var huntMoved = 0;
    if (huntFromVersion < 2) {
      var HUNT_K = 0.54;
      var huntX = function (v) { return Math.round(((v - 800) * HUNT_K + 480) * 100) / 100; };
      var huntY = function (v) { return Math.round(((v - 500) * HUNT_K + 270) * 100) / 100; };
      p.plans.forEach(function (plan) {
        if (plan.mapId !== 'hunt-city') return;
        plan.phases.forEach(function (ph) {
          ph.markers.forEach(function (m) {
            m.x = huntX(m.x);
            m.y = huntY(m.y);
            huntMoved++;
          });
          ph.shapes.forEach(function (s) {
            s.x = huntX(s.x);
            s.y = huntY(s.y);
            s.w = Math.round((s.w || 0) * HUNT_K * 100) / 100;
            s.h = Math.round((s.h || 0) * HUNT_K * 100) / 100;
            s.r = Math.round((s.r || 0) * HUNT_K * 100) / 100;
            (s.points || []).forEach(function (pt) {
              pt.x = huntX(pt.x);
              pt.y = huntY(pt.y);
            });
          });
        });
      });
      if (huntMoved) {
        GM.migrationNotice = GM.migrationNotice
          ? { map: GM.migrationNotice.map + ' / 猎龙之城', count: GM.migrationNotice.count + huntMoved, version: huntVersion }
          : { map: '猎龙之城', count: huntMoved, version: huntVersion };
      }
    }
    if (huntFromVersion < huntVersion) p.mapVersions['hunt-city'] = huntVersion;

    /* 坐标统一夹到各自地图的世界尺寸（旧图 1600×1000，四方战 328×438 unit，星墓高原 533×333 unit，猎龙之城 960×540 unit） */
    p.plans.forEach(function (plan) {
      var b = mapBoardOf(plan.mapId);
      plan.phases.forEach(function (ph) {
        ph.markers.forEach(function (m) {
          m.x = U.clamp(m.x, 0.5, b.width - 0.5);
          m.y = U.clamp(m.y, 0.5, b.height - 0.5);
        });
        ph.shapes.forEach(function (s) {
          s.x = U.clamp(s.x, 0, b.width);
          s.y = U.clamp(s.y, 0, b.height);
        });
      });
    });

    if (!p.plans.length) {
      var plan = GM.newPlan(p.mapId, '方案 1');
      p.plans.push(plan);
    }

    var hasActive = p.plans.some(function (plan) { return plan.id === p.activePlanId; });
    if (!hasActive) {
      var forMap = p.plans.filter(function (plan) { return plan.mapId === p.mapId; });
      p.activePlanId = (forMap[0] || p.plans[0]).id;
    }

    GM.state.project = p;
    GM.ensureActivePlan();
    return p;
  };
})();
