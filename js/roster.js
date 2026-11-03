/* 诡秘之主 · GvG 战术板
 * 编成花名册：一键导入 / 一键导出（统一模板：js/template.js 固定锚点解析）
 *
 * 只接受 assets/templates/成员导入模板.xlsx（工作表「成员导入模板」）的版式：
 *   每个联盟 46 行：联盟行（A:T 合并）→ 5 个团队块（每块 9 行）
 *   团队块：团队行（A:T 合并）→ 小队列头（5 段 × 4 列合并，小队号全表连续 1–125）
 *           → 字段行（名字 / 技能 / 人脉 / 密偶 ×5）→ 6 行成员
 *   U 列：U1 图例 / U2–U7 职业格（填充色 + 职业名）/ U9 候补人员 / U10 起候补名单
 *
 * 成员四个槽位是游戏语义位：人脉 / 密偶 / 技能 / 备注（不是「技能1–4」）。
 * 数据模型：member.skills 仍是 4 字符串数组（其它模块沿用），member.slots 是对应的语义视图；
 * 两者始终同步。备注不是技能，不参与技能统计，上限 60 字。
 * 导出按模板列序：5 联盟 × 5 团队 × 5 小队 × 6 行 × 4 列 + U 列图例/候补，可直接贴回模板。
 * 候补池不占正式队编制，导出时写在 U9 起。
 */
(function () {
  'use strict';

  window.GM = window.GM || {};
  var GM = window.GM;

  var SLOT_KEYS = ['connection', 'puppet', 'skill', 'note'];
  var SLOT_LABEL = { connection: '人脉', puppet: '密偶', skill: '技能', note: '备注' };
  var SLOT_MAX = { connection: 20, puppet: 20, skill: 20, note: 60 };
  var SLOT_VERSION = 2;                       // 1 = 旧「技能1–4」，2 = 语义位

  /* 与模板成员行 第5–10 行的预填底色一致（战士 / 歌颂 / 占卜 / 学徒 / 窥秘 / 观众） */
  var ROW_CLASS_NAMES = ['战士', '歌颂', '占卜', '学徒', '窥秘', '观众'];
  var MAX_SKILLS = (window.GM_DATA && window.GM_DATA.skillSlotCount) || 4;
  var MAX_SLOTS = 6;

  function s(v) { return v == null ? '' : String(v).trim(); }

  function uid(prefix) {
    if (GM.util && GM.util.uid) return GM.util.uid(prefix);
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function classesOf(project) {
    return (project && project.classes) || (window.GM_DATA && window.GM_DATA.classes) || [];
  }

  function classIdByName(project, name) {
    var list = classesOf(project);
    var t = s(name);
    if (!t) return '';
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === t) return list[i].id;
    }
    return '';
  }

  /* 「战士·坦克」这类合成文本也认：取点号/空格前的职业名 */
  function classByText(project, text) {
    var t = s(text);
    if (!t) return null;
    var list = classesOf(project);
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === t || (list[i].abbr && list[i].abbr === t)) return list[i];
    }
    var head = t.split(/[·\s\/]+/)[0];
    for (var j = 0; j < list.length; j++) {
      if (list[j].name === head || (list[j].abbr && list[j].abbr === head)) return list[j];
    }
    return null;
  }

  /* 形态以 data/classes.js 的 forms 为准（第一项即默认）；不再维护第二份职业形态清单 */
  function allowedForms(project, classId) {
    var list = classesOf(project);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === classId) {
        if (list[i].forms && list[i].forms.length) return list[i].forms.slice();
        return ['输出'];
      }
    }
    return ['输出'];
  }

  function defaultFormOf(project, classId) {
    var forms = allowedForms(project, classId);
    return forms[0] || '输出';
  }

  function normalizeForm(project, classId, raw) {
    var form = s(raw);
    var allowed = allowedForms(project, classId);
    if (allowed.indexOf(form) >= 0) return form;
    return defaultFormOf(project, classId);
  }

  function defaultClassBySlot(project, slot) {
    var name = ROW_CLASS_NAMES[slot] || ROW_CLASS_NAMES[slot % 6];
    var list = classesOf(project);
    for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
    return list[0] || { id: 'class-1', name: name };
  }

  function classById(project, id) {
    var list = classesOf(project);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function parseSkills(raw) {
    var t = s(raw);
    if (!t) return [];
    return t.split(/[、,，;；\/|]+/).map(s).filter(function (x) { return !!x; }).slice(0, MAX_SKILLS);
  }

  function emptySkills() {
    var out = [];
    for (var i = 0; i < MAX_SKILLS; i++) out.push('');
    return out;
  }

  function padSkills(list) {
    var out = emptySkills();
    (list || []).forEach(function (v, i) { if (i < out.length) out[i] = v; });
    return out;
  }

  /* 语义位 → 4 字符串数组（旧模块仍读 member.skills） */
  function slotsToSkills(slots) {
    var out = emptySkills();
    SLOT_KEYS.forEach(function (k, i) { out[i] = String((slots && slots[k]) || '').slice(0, SLOT_MAX[k]); });
    return out;
  }

  function skillsToSlots(list) {
    var arr = padSkills(list);
    var out = {};
    SLOT_KEYS.forEach(function (k, i) { out[k] = String(arr[i] || ''); });
    return out;
  }

  function slotsOf(member) {
    if (member && member.slots && typeof member.slots === 'object') {
      var out = {};
      SLOT_KEYS.forEach(function (k) { out[k] = String(member.slots[k] || ''); });
      return out;
    }
    return skillsToSlots(member && member.skills);
  }

  /* 把 member.slots 与 member.skills 双向对齐 */
  function syncMember(member) {
    if (!member) return member;
    if (member.slots && typeof member.slots === 'object') {
      member.skills = slotsToSkills(member.slots);
    } else {
      member.slots = skillsToSlots(member.skills);
      member.skills = slotsToSkills(member.slots);
    }
    return member;
  }

  /* 旧存档迁移：旧 4 个字符串按现有顺序迁到 人脉/密偶/技能/备注 */
  function migrateProject(project) {
    if (!project) return { migrated: false, members: 0 };
    var count = 0;
    function walk(n) {
      (n.members || []).forEach(function (m) {
        if (!m.slots || typeof m.slots !== 'object') m.slots = skillsToSlots(m.skills);
        m.skills = slotsToSkills(m.slots);
        count++;
      });
      (n.children || []).forEach(walk);
    }
    (project.teams || []).forEach(walk);
    (project.pool || []).forEach(function (m) {
      if (!m.slots || typeof m.slots !== 'object') m.slots = skillsToSlots(m.skills);
      m.skills = slotsToSkills(m.slots);
      count++;
    });
    var changed = !project.slotSemanticsVersion || project.slotSemanticsVersion < SLOT_VERSION;
    project.slotSemanticsVersion = SLOT_VERSION;
    return { migrated: changed, members: count };
  }

  function slotsFromEntry(e) {
    if (e && e.slots && typeof e.slots === 'object') {
      var out = {};
      SLOT_KEYS.forEach(function (k) { out[k] = String(e.slots[k] || ''); });
      return out;
    }
    if (e && e.skills && e.skills.length) return skillsToSlots(e.skills);
    /* 旧表只有一列「技能」：按物理顺序填 人脉→密偶→技能→备注 */
    var parts = parseSkills(e && e.skillsRaw);
    return skillsToSlots(parts);
  }

  /* ============================ 导入：生成落位计划 ============================ */

  function flatTeams(project) {
    var out = [];
    var alliances = (project.teams || []).filter(function (n) { return n.kind === 'alliance'; });
    alliances.forEach(function (a) {
      (a.children || []).forEach(function (t) {
        if (t.kind === 'team') out.push({ alliance: a, team: t });
      });
    });
    (project.teams || []).forEach(function (t) {
      if (t.kind === 'team') out.push({ alliance: null, team: t });
    });
    return out;
  }

  function squadsOf(team) {
    return (team.children || []).filter(function (n) { return n.kind === 'squad'; });
  }

  function buildPlan(project, parsed, opts) {
    opts = opts || {};
    var overflowMode = opts.overflowMode || 'pool';   // pool / keep / truncate
    var flat = flatTeams(project);
    var items = [];
    var skipped = (parsed.skipped || []).slice();
    var corrections = [];
    var names = [];
    var defaultClassCount = 0;
    var colorClassCount = 0;
    var claimed = {};        // teamNo-squadNo-slot → 先占位（跨表/同表重复落位）

    var unlanded = [];
    var overflowList = [];
    var skippedEntries = 0;

    /* 逐条落位：模板直接给出「联盟 / 团队 / 全局小队号」，
     *   flat 索引 = (联盟-1)*5 + (团队-1)，队内小队序号 = (全局小队号-1)%5+1。
     * 模板是 5 联盟 × 5 团队 × 5 小队 × 6 格，锚点由 template.js 校验过，这里不再猜。 */
    function placeOf(e) {
      var an = Math.min(5, Math.max(1, e.allianceNo || 1));
      var tn = e.teamNo || 0;
      if (!tn && e.squadNo) tn = Math.floor((e.squadNo - 1) / 5) + 1;
      tn = Math.min(25, Math.max(1, tn));
      var sq = e.squadNo || 1;
      return {
        teamIdx: (an - 1) * 5 + (tn - 1),
        squadIdx: (sq - 1) % 5 + 1,
        globalSquad: sq
      };
    }

    parsed.entries.forEach(function (e) {
      var pl = placeOf(e);
      var hit = flat[pl.teamIdx];
      if (!hit) {
        unlanded.push({
          name: e.name, row: e.row, column: e.source && e.source.column,
          sheet: e.source && e.source.sheet,
          reason: '超出当前骨架（目标团队槽位 ' + (pl.teamIdx + 1) + '，骨架只有 ' + flat.length + ' 个团队）'
        });
        return;
      }
      /* 超编（同小队第 7 人及以后）：保留记录，绝不丢 */
      if (e.overflow || (e.slot || 0) >= 6) {
        if (overflowMode === 'truncate') {
          unlanded.push({
            name: e.name, row: e.row, column: e.source && e.source.column,
            sheet: e.source && e.source.sheet,
            reason: '小队 ' + pl.squadIdx + '（团队 ' + (pl.teamIdx + 1) + '）超编，按设置截断'
          });
          return;
        }
        overflowList.push({
          entry: e, name: e.name, teamNo: pl.teamIdx + 1, squadNo: pl.squadIdx,
          slot: (e.slot || 0) + 1, row: e.row, column: e.source && e.source.column,
          sheet: e.source && e.source.sheet, keep: overflowMode === 'keep'
        });
        return;
      }
      var squads = squadsOf(hit.team);
      var squad = squads[pl.squadIdx - 1];
      if (!squad) {
        unlanded.push({
          name: e.name, row: e.row, column: e.source && e.source.column,
          sheet: e.source && e.source.sheet,
          reason: '小队' + pl.squadIdx + ' 在团队「' + hit.team.name + '」里不存在'
        });
        return;
      }

      var key = (pl.teamIdx + 1) + '-' + pl.squadIdx + '-' + e.slot;
      if (claimed[key]) {
        var prev = claimed[key];
        skippedEntries++;
        unlanded.push({
          name: e.name, row: e.row, column: e.source && e.source.column,
          sheet: e.source && e.source.sheet,
          reason: '与' + (prev.source && prev.source.sheet ? '『' + prev.source.sheet + '』' : '') +
            '第 ' + (prev.source && prev.source.row ? prev.source.row : '?') + ' 行的「' + prev.name + '」重复落位，已保留先到者'
        });
        return;
      }
      claimed[key] = e;

      /* 职业优先级：单元格填充色（图例匹配）> 表内职业文本 > 按行默认推断 */
      var cls = null;
      var classSource = '';
      if (e.classId) {
        cls = classById(project, e.classId);
        if (cls) classSource = e.classOrigin || 'color';
      }
      if (!cls) {
        cls = classByText(project, e.classRaw);
        if (cls) classSource = 'text';
      }
      if (!cls && e.classRaw) {
        var fb = defaultClassBySlot(project, e.slot);
        corrections.push({
          row: e.row, name: e.name, field: '职业',
          from: e.classRaw, to: fb.name, reason: '未知职业，按行默认回落'
        });
        cls = fb;
        classSource = 'default';
        defaultClassCount++;
      } else if (!cls) {
        cls = defaultClassBySlot(project, e.slot);
        classSource = 'default';
        defaultClassCount++;
      }
      if (classSource === 'color') colorClassCount++;

      var form = normalizeForm(project, cls.id, e.formRaw);
      if (e.formRaw && form !== e.formRaw) {
        corrections.push({
          row: e.row, name: e.name, field: '形态',
          from: e.formRaw, to: form, reason: '形态与职业不匹配，按职业默认回落'
        });
      }

      if (e.teamCustom) names.push({ node: hit.team, name: e.teamCustom, kind: '团队' });
      if (e.squadCustom) names.push({ node: squad, name: e.squadCustom, kind: '小队' });

      var slot = e.slot;
      var existing = slot < squad.members.length ? squad.members[slot] : null;
      var slots = slotsFromEntry(e);
      var origin = e.classOrigin || classSource;
      items.push({
        entry: e,
        uid: uid('plan'),
        alliance: hit.alliance,
        team: hit.team,
        squad: squad,
        slot: slot,
        existing: existing || null,
        classSource: classSource,
        classOrigin: origin,
        inferred: classSource === 'default',
        color: e.color || '',
        colorMiss: !!e.colorMiss,
        unknownColor: e.colorMiss ? (e.color || '') : '',
        source: e.source || { sheet: '', row: e.row, column: '' },
        member: {
          name: e.name,
          classId: cls.id,
          form: form,
          slots: slots,
          skills: slotsToSkills(slots),
          classOrigin: origin
        }
      });
    });

    var poolItems = (parsed.pool || []).map(function (e) {
      var cls = null;
      var classSource = '';
      if (e.classId) {
        cls = classById(project, e.classId);
        if (cls) classSource = e.classOrigin || 'color';
      }
      if (!cls) {
        cls = classByText(project, e.classRaw);
        if (cls) classSource = 'text';
      }
      if (!cls) {
        cls = defaultClassBySlot(project, 0);
        classSource = 'default';
      }
      var form = normalizeForm(project, cls.id, e.formRaw);
      var slots = slotsFromEntry(e);
      return {
        entry: e,
        uid: uid('plan-pool'),
        classSource: classSource,
        classOrigin: e.classOrigin || classSource,
        inferred: classSource === 'default',
        color: e.color || '',
        source: e.source || { sheet: '', row: e.row, column: '' },
        member: { name: e.name, classId: cls.id, form: form, slots: slots, skills: slotsToSkills(slots) }
      };
    });

    /* 超编成员（同小队第 7 人及以后）：进候补池并标注来源，绝不静默丢弃 */
    overflowList.forEach(function (o) {
      var e = o.entry;
      var cls = classById(project, e.classId) || classByText(project, e.classRaw) || defaultClassBySlot(project, e.slot || 0);
      var slots = slotsFromEntry(e);
      poolItems.push({
        entry: e,
        overflow: true,
        classSource: e.classOrigin || 'color',
        classOrigin: e.classOrigin || 'color',
        inferred: false,
        color: e.color || '',
        source: { sheet: o.sheet, column: o.column, row: o.row, overflowSquad: o.squadNo, overflowTeam: o.teamNo },
        member: {
          name: e.name, classId: cls.id,
          form: normalizeForm(project, cls.id, e.formRaw),
          slots: slots, skills: slotsToSkills(slots),
          classOrigin: e.classOrigin || 'color'
        }
      });
    });

    /* 同一个人同时出现在正式队与候选列：以正式队为准（C1） */
    var officialNames = {};
    items.forEach(function (it) { officialNames[it.member.name] = it; });
    var poolOmitted = [];
    var poolKept = [];
    poolItems.forEach(function (pi) {
      if (officialNames[pi.member.name]) {
        poolOmitted.push({
          name: pi.member.name,
          official: officialNames[pi.member.name].source,
          pool: pi.source
        });
        return;
      }
      poolKept.push(pi);
    });

    var conflicts = items.filter(function (it) { return !!it.existing; });

    var ledger = ledgerOf({
      nameCells: parsed.nameCells || parsed.entries.length,
      landed: items.length,
      pool: poolKept.length,
      unlanded: unlanded.length,
      deleted: 0,
      duplicate: poolOmitted.length
    });

    return {
      items: items,
      conflicts: conflicts,
      skipped: skipped,
      corrections: corrections,
      defaultClassCount: defaultClassCount,
      colorClassCount: colorClassCount,
      names: names,
      parsed: parsed,
      poolItems: poolKept,
      poolOmitted: poolOmitted,
      unlanded: unlanded,
      overflow: overflowList,
      deleted: [],
      conservation: ledger,
      legend: parsed.legend || [],
      legendConflicts: parsed.legendConflicts || [],
      sheetSummaries: parsed.sheetSummaries || [],
      stats: {
        total: items.length,
        newCount: items.length - conflicts.length,
        conflictCount: conflicts.length,
        skippedCount: skipped.length,
        trailingRows: parsed.trailingRows || 0,
        defaultClassCount: defaultClassCount,
        colorClassCount: colorClassCount,
        poolCount: poolKept.length,
        poolOmittedCount: poolOmitted.length,
        overflowCount: overflowList.length,
        unlandedCount: unlanded.length,
        nameCells: parsed.nameCells || parsed.entries.length
      }
    };
  }

  /* ============================ 守恒账 / 预览编辑 / 批量 ============================ */

  function ledgerOf(x) {
    x = x || {};
    var nameCells = Number(x.nameCells) || 0;
    var landed = Number(x.landed) || 0;
    var pool = Number(x.pool) || 0;
    var unlanded = Number(x.unlanded) || 0;
    var deleted = Number(x.deleted) || 0;
    var duplicate = Number(x.duplicate) || 0;
    var sum = landed + pool + unlanded + deleted + duplicate;
    return {
      nameCells: nameCells,
      recognized: nameCells,
      landed: landed,
      pool: pool,
      unlanded: unlanded,
      deleted: deleted,
      duplicate: duplicate,
      sum: sum,
      balanced: sum === nameCells,
      diff: nameCells - sum
    };
  }

  /* 预览里编辑/删除/添加之后重算：守恒账 + 冲突清单 + 顶部统计（三项都随编辑变化） */
  function recountPlan(plan) {
    if (!plan) return null;
    var cur = plan.conservation || {};
    plan.items = plan.items || [];
    plan.poolItems = plan.poolItems || [];
    plan.skipped = plan.skipped || [];
    plan.deleted = plan.deleted || [];
    if (plan.baseNameCells == null) {
      plan.baseNameCells = cur.nameCells || (plan.stats && plan.stats.nameCells) || 0;
    }
    /* 预览里手动新增的人原本不在表内，也计入「名格」，否则守恒账会永远差负数 */
    var manualAdds = 0;
    plan.items.concat(plan.poolItems).forEach(function (it) { if (it && it.manual) manualAdds++; });
    plan.deleted.forEach(function (x) { if (x && x.manual) manualAdds++; });
    /* 冲突=目标格已有成员（编辑/移动后可能出现新的冲突），统计与清单必须同步重算 */
    plan.conflicts = plan.items.filter(function (it) { return !!it.existing; });
    plan.conservation = ledgerOf({
      nameCells: plan.baseNameCells + manualAdds,
      landed: plan.items.length,
      pool: plan.poolItems.length,
      unlanded: (plan.unlanded || []).length,
      deleted: plan.deleted.length,
      duplicate: (plan.poolOmitted || []).length
    });
    plan.stats = plan.stats || {};
    plan.stats.total = plan.items.length;
    plan.stats.newCount = plan.items.length - plan.conflicts.length;
    plan.stats.conflictCount = plan.conflicts.length;
    plan.stats.skippedCount = plan.skipped.length;
    plan.stats.poolCount = plan.conservation.pool;
    plan.stats.unlandedCount = plan.conservation.unlanded;
    plan.stats.nameCells = plan.conservation.nameCells;
    return plan.conservation;
  }

  /* 批量改字段：预览的 plan.items 与队伍配置的 project 成员共用这一套 */
  function batchMembers(members, action, data) {
    var list = (members || []).filter(Boolean);
    var changed = 0;
    list.forEach(function (m) {
      if (!m) return;
      if (action === 'class-form') {
        if (data && data.className) {
          var byName = classIdByName(null, data.className);
          if (byName) data.classId = byName;
        }
        if (data && data.classId && classById(null, data.classId)) {
          m.classId = data.classId;
          m.form = normalizeForm(null, m.classId, data.form || m.form || '');
          m.classOrigin = 'manual';
          changed++;
        }
        return;
      }
      if (action === 'clear-slots') {
        var slots = slotsOf(m);
        slots.connection = '';
        slots.puppet = '';
        slots.skill = '';
        m.slots = slots;
        m.skills = slotsToSkills(slots);
        changed++;
        return;
      }
      if (action === 'name') {
        if (data && data.name) { m.name = String(data.name).trim(); changed++; }
      }
    });
    return { changed: changed, members: list };
  }

  /* 预览：按 uid 批量动作（class-form / clear-slots / delete / to-pool / to-squad / add） */
  function batchPlan(plan, uids, action, data) {
    if (!plan) return { changed: 0 };
    data = data || {};
    var set = {};
    (uids || []).forEach(function (x) { set[x] = true; });
    var picked = (plan.items || []).filter(function (it) { return set[it.uid]; });
    var pickedPool = (plan.poolItems || []).filter(function (it) { return set[it.uid]; });
    var changed = 0;

    if (action === 'class-form') {
      var res = batchMembers(picked.concat(pickedPool).map(function (it) { return it.member; }), 'class-form', data);
      picked.forEach(function (it) { it.classOrigin = 'manual'; it.classSource = 'manual'; it.inferred = false; });
      pickedPool.forEach(function (it) { it.classOrigin = 'manual'; it.classSource = 'manual'; it.inferred = false; });
      changed = res.changed;
    } else if (action === 'clear-slots') {
      changed = batchMembers(picked.concat(pickedPool).map(function (it) { return it.member; }), 'clear-slots', {}).changed;
    } else if (action === 'delete') {
      plan.deleted = plan.deleted || [];
      picked.forEach(function (it) {
        plan.deleted.push({ name: it.member.name, reason: '预览内手动删除', source: it.source, manual: !!it.manual });
        changed++;
      });
      var drop = {};
      picked.forEach(function (it) { drop[it.uid] = true; });
      plan.items = (plan.items || []).filter(function (it) { return !drop[it.uid]; });
      plan.poolItems = (plan.poolItems || []).filter(function (it) { return !drop[it.uid]; });
      plan.conflicts = (plan.conflicts || []).filter(function (it) { return !drop[it.uid]; });
    } else if (action === 'to-pool') {
      plan.poolItems = plan.poolItems || [];
      picked.forEach(function (it) {
        var copy = {
          entry: it.entry, uid: uid('plan-pool'), pair: true,
          classSource: it.classSource || it.classOrigin || 'text',
          classOrigin: it.classOrigin || 'text',
          inferred: !!it.inferred, color: it.color || '',
          manual: !!it.manual,
          source: { sheet: it.source && it.source.sheet, column: it.source && it.source.column, row: it.source && it.source.row },
          member: it.member
        };
        plan.poolItems.push(copy);
        changed++;
      });
      var drop2 = {};
      picked.forEach(function (it) { drop2[it.uid] = true; });
      plan.items = (plan.items || []).filter(function (it) { return !drop2[it.uid]; });
      plan.conflicts = (plan.conflicts || []).filter(function (it) { return !drop2[it.uid]; });
      /* 腾出的格位：后面的成员不动（导入按格位落位，空位保留） */
    } else if (action === 'to-squad') {
      var sq = data.squad;
      if (!sq) return { changed: 0, reason: '目标小队不存在' };
      var limit = data.limit == null ? 6 : data.limit;
      picked.forEach(function (it) {
        if (it.squad === sq && it.slot === (Number(data.slot) || 0)) return;
        var slot = data.slot == null ? nextFreeSlot(plan, sq, limit) : Number(data.slot);
        if (slot == null || slot < 0) return;
        it.squad = sq;
        it.alliance = data.alliance || it.alliance;
        it.team = data.team || it.team;
        it.slot = slot;
        it.existing = slot < (sq.members || []).length ? sq.members[slot] : null;
        changed++;
      });
    }
    recountPlan(plan);
    return { changed: changed, conservation: plan.conservation };
  }

  function nextFreeSlot(plan, squad, limit) {
    var used = {};
    (plan.items || []).forEach(function (it) {
      if (it.squad === squad) used[it.slot] = true;
    });
    for (var i = 0; i < (limit || 6); i++) if (!used[i]) return i;
    return -1;
  }

  /* 预览：新增成员到指定格位 */
  function addPlanMember(plan, project, squad, slot, member) {
    if (!plan || !squad) return null;
    var slotNo = Number(slot);
    if (!(slotNo >= 0 && slotNo < 6)) return null;
    var occupied = (plan.items || []).some(function (it) { return it.squad === squad && it.slot === slotNo; });
    if (occupied) return null;
    var cls = classById(project, member && member.classId) ||
      classByText(project, member && member.classRaw) || defaultClassBySlot(project, slotNo);
    var slots = slotsFromEntry(member || {});
    var loc = locateSquadIn(project, squad);
    var item = {
      entry: {},
      uid: uid('plan-add'),
      pair: true,
      squad: squad,
      team: loc.team,
      alliance: loc.alliance,
      slot: slotNo,
      existing: slotNo < (squad.members || []).length ? squad.members[slotNo] : null,
      classSource: 'manual', classOrigin: 'manual', inferred: false, color: '',
      manual: true,
      source: { sheet: '预览新增', column: '', row: 0 },
      member: {
        name: s(member && member.name),
        classId: cls.id,
        form: normalizeForm(project, cls.id, (member && member.form) || ''),
        slots: slots,
        skills: slotsToSkills(slots),
        classOrigin: 'manual'
      }
    };
    plan.items.push(item);
    recountPlan(plan);
    return item;
  }

  /* 按小队节点回查所属团队 / 联盟（预览新增成员必须带上，否则预览分组建卡会拿不到团队） */
  function locateSquadIn(project, squad) {
    var out = { team: null, alliance: null };
    if (!squad) return out;
    function has(node) {
      return (node.children || []).some(function (c) { return c && c.id === squad.id; });
    }
    (project && project.teams || []).forEach(function (n) {
      if (!n || out.team) return;
      if (n.kind === 'alliance') {
        (n.children || []).forEach(function (t) {
          if (!out.team && t && t.kind === 'team' && has(t)) { out.team = t; out.alliance = n; }
        });
      } else if (n.kind === 'team' && has(n)) {
        out.team = n;
      }
    });
    return out;
  }

  function removeMembers(project, ids) {
    var n = 0;
    (ids || []).forEach(function (id) {
      var found = GM.findMember && GM.findMember(id);
      if (!found) return;
      if (found.pool) GM.removePoolMember(id);
      else GM.deleteMember(found.squad.id, id);
      n++;
    });
    return n;
  }

  function moveMembersToPool(project, ids) {
    if (!Array.isArray(project.pool)) project.pool = [];
    var n = 0;
    (ids || []).forEach(function (id) {
      var found = GM.findMember && GM.findMember(id);
      if (!found || found.pool) return;
      var m = found.member;
      m.slots = slotsOf(m);
      m.skills = slotsToSkills(m.slots);
      GM.deleteMember(found.squad.id, id);
      project.pool.push(m);
      n++;
    });
    return n;
  }

  function moveMembersTo(project, ids, teamNo, squadNo) {
    var flat = flatTeams(project);
    var hit = flat[(Number(teamNo) || 0) - 1];
    if (!hit) return { moved: 0, reason: '目标团队不存在' };
    var squad = squadsOf(hit.team)[(Number(squadNo) || 0) - 1];
    if (!squad) return { moved: 0, reason: '目标小队不存在' };
    var moved = 0;
    var full = 0;
    (ids || []).forEach(function (id) {
      var found = GM.findMember && GM.findMember(id);
      if (!found) return;
      if ((squad.members || []).length >= 6) { full++; return; }
      var m = found.member;
      if (found.pool) {
        project.pool = (project.pool || []).filter(function (x) { return x.id !== id; });
      } else {
        GM.deleteMember(found.squad.id, id);
      }
      squad.members.push(m);
      moved++;
    });
    return { moved: moved, squad: squad, team: hit.team, reason: full ? (moved ? '有 ' + full + ' 人因目标小队满员未移入' : '目标小队已满（6 人）') : '' };
  }

  /* 应用即所见：逐块断言落地成员与预览计划一致 */
  function assertApplied(project, plan, mode) {
    var diffs = [];
    var checked = 0;
    (plan.items || []).forEach(function (it) {
      var squad = it.squad;
      if (!squad) return;
      var member = (squad.members || [])[it.slot];
      if (!member) {
        diffs.push({ uid: it.uid, name: it.member.name, field: 'position', expected: it.slot, actual: '空位' });
        return;
      }
      checked++;
      if (member.name !== it.member.name) diffs.push({ uid: it.uid, name: it.member.name, field: 'name', expected: it.member.name, actual: member.name });
      if (member.classId !== it.member.classId) diffs.push({ uid: it.uid, name: it.member.name, field: 'classId', expected: it.member.classId, actual: member.classId });
      if ((member.form || '') !== (it.member.form || '')) diffs.push({ uid: it.uid, name: it.member.name, field: 'form', expected: it.member.form, actual: member.form });
      var want = slotsOf(it.member);
      var got = slotsOf(member);
      SLOT_KEYS.forEach(function (k) {
        if ((want[k] || '') !== (got[k] || '')) diffs.push({ uid: it.uid, name: it.member.name, field: 'slots.' + k, expected: want[k], actual: got[k] });
      });
    });
    return { checked: checked, diffs: diffs, ok: diffs.length === 0, mode: mode };
  }

  function makeMember(project, spec) {
    var slots = slotsFromEntry(spec);
    var member = {
      id: uid('member'),
      name: spec.name,
      classId: spec.classId,
      sequence: '',
      form: spec.form,
      level: '',
      skills: slotsToSkills(slots),
      slots: slots,
      note: ''
    };
    if (spec.classOrigin) member.classOrigin = spec.classOrigin;
    if (spec.source) member.source = spec.source;
    return member;
  }

  /* mode: 'overwrite' | 'empty' */
  function applyPlan(project, plan, mode) {
    var added = 0;
    var overwritten = 0;
    var skippedSlots = 0;
    var poolAdded = 0;
    var poolSkipped = 0;

    plan.items.forEach(function (it) {
      var squad = it.squad;
      if (it.existing) {
        if (mode !== 'overwrite') { skippedSlots++; return; }
        it.existing.name = it.member.name;
        it.existing.classId = it.member.classId;
        it.existing.form = it.member.form;
        it.existing.slots = slotsFromEntry(it.member);
        it.existing.skills = slotsToSkills(it.existing.slots);
        if (it.member.classOrigin) it.existing.classOrigin = it.member.classOrigin;
        overwritten++;
        return;
      }
      var member = makeMember(project, it.member);
      var at = Math.min(it.slot, squad.members.length);
      squad.members.splice(at, 0, member);
      added++;
    });

    /* 候补池：不占正式编制，按名字去重（正式队优先，已在 buildPlan 里剔除） */
    if (!Array.isArray(project.pool)) project.pool = [];
    var officialNames = {};
    var walk = function (n) {
      (n.members || []).forEach(function (m) { officialNames[m.name] = true; });
      (n.children || []).forEach(walk);
    };
    (project.teams || []).forEach(walk);
    var poolNames = {};
    project.pool.forEach(function (m) { poolNames[m.name] = true; });

    (plan.poolItems || []).forEach(function (pi) {
      if (officialNames[pi.member.name] || poolNames[pi.member.name]) { poolSkipped++; return; }
      var member = makeMember(project, pi.member);
      member.source = {
        sheet: pi.source.sheet || '',
        column: pi.source.column || '',
        row: pi.source.row || 0
      };
      project.pool.push(member);
      poolNames[member.name] = true;
      poolAdded++;
    });

    var seen = [];
    (plan.names || []).forEach(function (n) {
      if (!n || !n.node || !n.name) return;
      var key = n.node.id + '|' + n.name;
      if (seen.indexOf(key) >= 0) return;
      seen.push(key);
      n.node.name = n.name;
    });

    return {
      added: added,
      overwritten: overwritten,
      skippedSlots: skippedSlots,
      poolAdded: poolAdded,
      poolSkipped: poolSkipped
    };
  }

  /* ============================ 导出：模板列序 ============================ */

  /* 联盟1–5 / 团队1–25 × 5 小队 × 6 行 × 4 列（名字/技能/人脉/密偶），行锚点与模板 1:1：
   *   联盟行 → 团队行 → 小队行 → 字段行 → 6 成员行；U1 图例 / U2–U7 职业 / U9 起候补；表尾 %END%。
   * 候补池写在 U9 起（不占编制）。 */
  function exportTemplateRows(project) {
    var SPEC = (GM.templateImport && GM.templateImport.SPEC) || {
      alliances: 5, teamsPerAlliance: 5, allianceStride: 46, teamBlockRows: 9,
      squadsPerTeam: 5, rowsPerSquad: 6, colsPerSquad: 4,
      fields: ['名字', '技能', '人脉', '密偶'], legendCol: 20, legendRows: [1, 2, 3, 4, 5, 6],
      poolStartRow: 8, poolTitle: '候补人员', endMark: '%END%'
    };
    var flat = flatTeams(project);
    var fields = SPEC.fields || ['名字', '技能', '人脉', '密偶'];
    var stride = SPEC.allianceStride || 46;
    var total = (SPEC.alliances || 5) * stride;
    var u = SPEC.legendCol == null ? 20 : SPEC.legendCol;
    var rows = [];
    for (var i = 0; i < total; i++) rows.push([]);

    /* U 列：图例（U1–U7）+ 候补名单（U9 起） */
    rows[0][u] = '图例';
    (SPEC.legendRows || [1, 2, 3, 4, 5, 6]).forEach(function (r, idx) {
      rows[r][u] = ROW_CLASS_NAMES[idx] || '';
    });
    var poolStart = SPEC.poolStartRow == null ? 8 : SPEC.poolStartRow;
    rows[poolStart][u] = SPEC.poolTitle || '候补人员';
    (project.pool || []).forEach(function (m, idx) {
      var r = poolStart + 1 + idx;
      if (r < total) rows[r][u] = m.name;
    });

    for (var a = 0; a < (SPEC.alliances || 5); a++) {
      var ar = a * stride;
      rows[ar][0] = '联盟' + (a + 1);
      for (var t = 0; t < (SPEC.teamsPerAlliance || 5); t++) {
        var teamNo = a * 5 + t + 1;
        var r0 = ar + 1 + t * (SPEC.teamBlockRows || 9);
        rows[r0][0] = '团队' + teamNo;

        var sr = r0 + 1;
        var hr = r0 + 2;
        for (var q = 0; q < (SPEC.squadsPerTeam || 5); q++) {
          var col = q * (SPEC.colsPerSquad || 4);
          rows[sr][col] = '小队' + ((teamNo - 1) * 5 + q + 1);
          for (var f = 0; f < fields.length; f++) rows[hr][col + f] = fields[f];
        }

        var hit = flat[teamNo - 1];
        var team = hit ? hit.team : null;
        var squads = team ? squadsOf(team) : [];
        for (var slot = 0; slot < (SPEC.rowsPerSquad || 6); slot++) {
          var line = rows[r0 + 3 + slot];
          for (var q2 = 0; q2 < 5; q2++) {
            var squad = squads[q2];
            var mem = squad ? (squad.members || [])[slot] : null;
            if (!mem) continue;
            var slots = slotsOf(mem);
            var base = q2 * 4;
            line[base] = mem.name;
            line[base + 1] = slots.skill;
            line[base + 2] = slots.connection;
            line[base + 3] = slots.puppet;
          }
        }
      }
    }

    rows[total] = [SPEC.endMark || '%END%'];
    return rows;
  }

  function defaultTeamName(teamNo) {
    return '团队' + ((teamNo - 1) % 5 + 1);
  }

  function defaultSquadName(localIndex) {
    return '小队' + (localIndex + 1);
  }

  function csvCell(v) {
    var t = v == null ? '' : String(v);
    if (/[",\r\n]/.test(t)) return '"' + t.replace(/"/g, '""') + '"';
    return t;
  }

  function toCsv(rows) {
    var width = 0;
    (rows || []).forEach(function (row) {
      width = Math.max(width, row ? row.length : 0);
    });
    return (rows || []).map(function (row) {
      var line = [];
      for (var i = 0; i < width; i++) line.push(csvCell(row && row[i]));
      return line.join(',');
    }).join('\r\n');
  }

  function toJson(project) {
    var flat = flatTeams(project);
    var teams = [];
    for (var ti = 0; ti < 25; ti++) {
      var hit = flat[ti];
      var team = hit ? hit.team : null;
      var squadsOut = [];
      for (var sb = 0; sb < 5; sb++) {
        var squad = team ? squadsOf(team)[sb] : null;
        var members = [];
        for (var slot = 0; slot < MAX_SLOTS; slot++) {
          var mem = squad && squad.members[slot];
          if (!mem) { members.push(null); continue; }
          var clsName = '';
          var list = classesOf(project);
          for (var ci = 0; ci < list.length; ci++) if (list[ci].id === mem.classId) { clsName = list[ci].name; break; }
          members.push({
            slot: slot, name: mem.name, className: clsName,
            form: mem.form || '', skills: padSkills(mem.skills || []),
            slots: slotsOf(mem),
            classOrigin: mem.classOrigin || ''
          });
        }
        squadsOut.push({
          index: sb + 1,
          name: squad ? squad.name : defaultSquadName(sb),
          members: members
        });
      }
      teams.push({
        index: ti + 1,
        alliance: hit && hit.alliance ? hit.alliance.name : '',
        team: team ? team.name : defaultTeamName(ti + 1),
        squads: squadsOut
      });
    }
    var pool = ((project && project.pool) || []).map(function (m) {
      var clsName = '';
      var list = classesOf(project);
      for (var ci = 0; ci < list.length; ci++) if (list[ci].id === m.classId) { clsName = list[ci].name; break; }
      return {
        name: m.name,
        className: clsName,
        form: m.form || '',
        skills: padSkills(m.skills || []),
        slots: slotsOf(m),
        classOrigin: m.classOrigin || '',
        source: {
          sheet: (m.source && m.source.sheet) || '',
          column: (m.source && m.source.column) || '',
          row: (m.source && m.source.row) || 0
        }
      };
    });

    return {
      app: 'gm-tactical-board',
      kind: 'roster',
      version: 2,
      slotSemanticsVersion: SLOT_VERSION,
      exportedAt: new Date().toISOString(),
      schema: '联盟N / 团队N / 小队(全局编号) / 名字·技能·人脉·密偶',
      teams: teams,
      pool: pool
    };
  }

  /* ============================ CSV 解析（保留空行，供回导） ============================ */

  function parseCsvRows(text) {
    var src = String(text || '').replace(/^\uFEFF/, '');
    var rows = [];
    var line = [];
    var field = '';
    var inQuote = false;

    for (var i = 0; i < src.length; i++) {
      var ch = src.charAt(i);
      if (inQuote) {
        if (ch === '"') {
          if (src.charAt(i + 1) === '"') { field += '"'; i++; }
          else inQuote = false;
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuote = true;
      } else if (ch === ',') {
        line.push(field);
        field = '';
      } else if (ch === '\n') {
        line.push(field);
        rows.push(line);
        line = [];
        field = '';
      } else if (ch !== '\r') {
        field += ch;
      }
    }
    if (field !== '' || line.length) {
      line.push(field);
      rows.push(line);
    }
    return rows;
  }

  GM.roster = {
    buildPlan: buildPlan,
    applyPlan: applyPlan,
    exportTemplateRows: exportTemplateRows,
    toCsv: toCsv,
    toJson: toJson,
    parseCsvRows: parseCsvRows,
    classByText: classByText,
    normalizeForm: normalizeForm,
    defaultFormOf: defaultFormOf,
    SLOT_KEYS: SLOT_KEYS,
    SLOT_LABEL: SLOT_LABEL,
    SLOT_MAX: SLOT_MAX,
    slotsOf: slotsOf,
    syncMember: syncMember,
    migrateProject: migrateProject,
    uid: uid,
    ledgerOf: ledgerOf,
    recountPlan: recountPlan,
    batchMembers: batchMembers,
    batchPlan: batchPlan,
    addPlanMember: addPlanMember,
    removeMembers: removeMembers,
    moveMembersToPool: moveMembersToPool,
    moveMembersTo: moveMembersTo,
    assertApplied: assertApplied
  };
})();
