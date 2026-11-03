/* 诡秘之主 · GvG 战术板
 * 统一模板导入：只接受 assets/templates/成员导入模板.xlsx（工作表「成员导入模板」）。
 *
 * 真实版式（已按上传文件逐格核对，1-based 行号）：
 *   每个联盟 46 行 = 1 行联盟行 + 5 个团队块（每块 9 行）：
 *     联盟行    A:T 合并，值「联盟1…联盟5」（行 1 / 47 / 93 / 139 / 185）
 *     团队行    A:T 合并，值「团队1…团队25」
 *     小队列头  A:D / E:H / I:L / M:P / Q:T 五段合并，值「小队1…小队125」（全局编号）
 *     字段行    A–T 依次 名字 / 技能 / 人脉 / 密偶 ×5
 *     成员行    6 行，每小队 6 格自上而下（模板里名字格已按行预填职业色）
 *   A–T 为数据区，U 列：
 *     U1「图例」；U2–U7 六个职业格（填充色 + 职业名 = 唯一权威色板）
 *     U8 空；U9「候补人员」；U10 起为候补名单
 *   表尾 A231 = %END%
 *
 * 职业只由「名字格填充色」对照 U2–U7 图例判定；图例缺失/颜色缺失直接报偏差。
 * 结构不对就报第一处偏差，绝不猜。
 */
(function () {
  'use strict';

  window.GM = window.GM || {};
  var GM = window.GM;

  var SPEC = {
    sheetName: '成员导入模板',
    alliances: 5,
    teamsPerAlliance: 5,
    teamCount: 25,
    squadsPerTeam: 5,
    squadCount: 125,
    rowsPerSquad: 6,
    colsPerSquad: 4,
    fields: ['名字', '技能', '人脉', '密偶'],
    teamSpanCols: 20,          // 一个团队覆盖 5 小队 × 4 列（A–T）
    allianceStride: 46,        // 每个联盟占 46 行
    teamBlockRows: 9,          // 每个团队块占 9 行
    allianceRow: 0,            // 0-based
    teamRowOffset: 1,          // 相对联盟行：团队行 +1
    squadRowOffset: 1,         // 相对团队行：小队列头 +1
    headerRowOffset: 2,        // 相对团队行：字段行 +2
    memberRowOffset: 3,        // 相对团队行：成员行 +3（第 5 行起 6 行）
    memberStartRow: 4,         // 仅用于文案：每块成员行 第5–10 行
    memberEndRow: 9,
    legendCol: 20,             // U
    legendTitleRow: 0,
    legendRows: [1, 2, 3, 4, 5, 6],   // U2–U7
    poolCol: 20,
    poolStartRow: 8,           // U9 起
    poolTitle: '候补人员',
    endMark: '%END%',
    emptyFill: '#FFFFFF'
  };

  function s(v) { return v == null ? '' : String(v).trim(); }

  function colLetter(index) {
    var n = Number(index) + 1;
    var out = '';
    while (n > 0) {
      var r = (n - 1) % 26;
      out = String.fromCharCode(65 + r) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  }

  function classesOf(project) {
    return (project && project.classes) || (window.GM_DATA && window.GM_DATA.classes) || [];
  }

  function classByName(project, text) {
    var name = s(text);
    if (!name) return null;
    var list = classesOf(project);
    for (var i = 0; i < list.length; i++) {
      if (s(list[i].name) === name) return list[i];
    }
    return null;
  }

  function cellText(rows, r, c) {
    var row = rows[r] || [];
    return s(row[c]);
  }

  function cellColor(colors, r, c) {
    var row = (colors || [])[r] || [];
    return s(row[c]).toUpperCase();
  }

  /* 颜色容差：Excel 的 theme+tint 换算、不同生成器与 WPS 重存都会带来几阶偏差。
     六职业色两两相距很远（最小约 150 的加权距离），阈值取 40 不会串色。 */
  var COLOR_TOLERANCE = 40;

  function rgbParts(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    if (h.length !== 6 || !/^[0-9A-Fa-f]{6}$/.test(h)) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  /* 加权 RGB 距离（redmean 近似）：肉眼接近的近似色距离小，不同色相距离大 */
  function colorDistance(a, b) {
    var pa = rgbParts(a);
    var pb = rgbParts(b);
    if (!pa || !pb) return Infinity;
    var rmean = (pa[0] + pb[0]) / 2;
    var dr = pa[0] - pb[0];
    var dg = pa[1] - pb[1];
    var db = pa[2] - pb[2];
    return Math.sqrt((2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db);
  }

  function findMerge(merges, r, c) {
    for (var i = 0; i < (merges || []).length; i++) {
      var g = merges[i];
      if (g && g.r1 === r && g.c1 === c) return g;
    }
    return null;
  }

  function mergeText(g) {
    if (!g) return '无合并';
    return colLetter(g.c1) + (g.r1 + 1) + ':' + colLetter(g.c2) + (g.r2 + 1) +
      '（' + (g.c2 - g.c1 + 1) + ' 列）';
  }

  function labelNo(text, prefix) {
    var m = s(text).match(new RegExp('^' + prefix + '\\s*([0-9]+)'));
    return m ? parseInt(m[1], 10) : 0;
  }

  function fail(code, message, where) {
    return { ok: false, error: { code: code, message: message, where: where || null } };
  }

  /* 读取诊断：告诉用户是「格子里确实没色」还是「文件里的颜色定义解析不了」 */
  function colorDiag(sheet) {
    var ci = sheet && sheet.colorInfo;
    if (!ci) return '';
    return '（读取情况：' + (ci.styles ? '样式表已读到' : '找不到样式表') +
      ' / ' + (ci.themeColors ? '主题色 ' + ci.themeColors + ' 个' : '主题色表缺失或为空') + '）';
  }

  /* ============================ 锚点校验 ============================ */

  function checkMerge(merges, r, c, cols, label, code) {
    var g = findMerge(merges, r, c);
    if (!g || (g.c2 - g.c1 + 1) !== cols || g.r2 !== r) {
      return fail(code,
        label + '合并宽度不对：第' + (r + 1) + '行 ' + colLetter(c) + ' 列应合并 ' + cols +
        ' 列（' + colLetter(c) + (r + 1) + ':' + colLetter(c + cols - 1) + (r + 1) + '），实际 ' + mergeText(g) + '。',
        { row: r + 1, col: c + 1 });
    }
    return null;
  }

  function checkLayout(sheet, opts) {
    var rows = sheet.rows || [];
    var merges = sheet.merges || [];
    var hasColors = !!(sheet.colors && sheet.colors.length);
    var requireMerges = opts && opts.requireMerges !== false;

    if (!rows.length) return fail('empty', '工作表是空的：没有找到模板表头。请下载并使用导入模板。');

    var a1 = cellText(rows, 0, 0);
    if (/^团队/.test(a1)) {
      return fail('old-template',
        '检测到旧版模板：第1行 A 列是「' + a1 + '」，缺少联盟行。请重新下载模板后再导入。',
        { row: 1, col: 1 });
    }
    if (labelNo(a1, '联盟') <= 0) {
      return fail('alliance-row',
        '第1行 A 列应为「联盟1」，实际是「' + (a1 || '空') + '」。请使用模板格式。',
        { row: 1, col: 1 });
    }
    if (labelNo(a1, '联盟') !== 1) {
      return fail('alliance-no', '第1行 A 列联盟编号应为 1，实际是「' + a1 + '」。', { row: 1, col: 1 });
    }

    var legendTitle = cellText(rows, SPEC.legendTitleRow, SPEC.legendCol);
    if (legendTitle !== '图例') {
      return fail('legend-title',
        'U1 应为「图例」，实际是「' + (legendTitle || '空') + '」。模板的 U2–U7 就是职业色板。',
        { row: 1, col: SPEC.legendCol + 1 });
    }

    for (var g = 0; g < SPEC.legendRows.length; g++) {
      var lr = SPEC.legendRows[g];
      var lname = cellText(rows, lr, SPEC.legendCol);
      var lcolor = cellColor(sheet.colors, lr, SPEC.legendCol);
      if (!lname) {
        return fail('legend-name',
          'U' + (lr + 1) + ' 缺少职业名：图例 U2–U7 必须填 战士 / 歌颂 / 占卜 / 学徒 / 窥秘 / 观众。',
          { row: lr + 1, col: SPEC.legendCol + 1 });
      }
      if (hasColors && (!lcolor || lcolor === SPEC.emptyFill)) {
        var why = lcolor
          ? '是白色填充（等同于没涂）'
          : '读不到填充色：这一格可能没涂，也可能是文件里的主题色/自定义色无法解析';
        return fail('legend-color',
          'U' + (lr + 1) + '「' + lname + '」' + why +
          '。图例格必须像模板那样整块实心填色，并保留模板里的职业底色。' + colorDiag(sheet),
          { row: lr + 1, col: SPEC.legendCol + 1 });
      }
      if (!classByName(null, lname)) {
        return fail('legend-class',
          'U' + (lr + 1) + ' 的职业名「' + lname + '」不在本战术板职业里（战士 / 歌颂 / 占卜 / 学徒 / 窥秘 / 观众）。',
          { row: lr + 1, col: SPEC.legendCol + 1 });
      }
    }

    for (var a = 0; a < SPEC.alliances; a++) {
      var ar = a * SPEC.allianceStride;
      var ally = cellText(rows, ar, 0);
      if (labelNo(ally, '联盟') !== a + 1) {
        return fail('alliance-row',
          '第' + (ar + 1) + '行 A 列应为「联盟' + (a + 1) + '」，实际是「' + (ally || '空') + '」。' +
          '模板固定 5 联盟纵向排列，请不要增删联盟。',
          { row: ar + 1, col: 1 });
      }
      if (requireMerges) {
        var mAlly = checkMerge(merges, ar, 0, SPEC.teamSpanCols, '联盟行', 'alliance-merge');
        if (mAlly) return mAlly;
      }

      for (var t = 0; t < SPEC.teamsPerAlliance; t++) {
        var r0 = ar + SPEC.teamRowOffset + t * SPEC.teamBlockRows;
        var teamNo = a * SPEC.teamsPerAlliance + t + 1;
        var team = cellText(rows, r0, 0);
        if (labelNo(team, '团队') !== teamNo) {
          return fail('team-row',
            '第' + (r0 + 1) + '行 A 列应为「团队' + teamNo + '」，实际是「' + (team || '空') + '」。请使用模板格式。',
            { row: r0 + 1, col: 1 });
        }
        if (requireMerges) {
          var mTeam = checkMerge(merges, r0, 0, SPEC.teamSpanCols, '团队行', 'team-merge');
          if (mTeam) return mTeam;
        }

        var sr = r0 + SPEC.squadRowOffset;
        for (var q = 0; q < SPEC.squadsPerTeam; q++) {
          var col = q * SPEC.colsPerSquad;
          var globalSquad = teamNo * SPEC.squadsPerTeam - SPEC.squadsPerTeam + q + 1;
          var label = cellText(rows, sr, col);
          if (labelNo(label, '小队') !== globalSquad) {
            return fail('squad-row',
              '第' + (sr + 1) + '行 ' + colLetter(col) + ' 列应为「小队' + globalSquad + '」，实际是「' + (label || '空') + '」。' +
              '小队号按全表连续编号（1–125）。',
              { row: sr + 1, col: col + 1 });
          }
          if (requireMerges) {
            var mSquad = checkMerge(merges, sr, col, SPEC.colsPerSquad, '小队表头', 'squad-merge');
            if (mSquad) return mSquad;
          }
        }

        var hr = r0 + SPEC.headerRowOffset;
        for (var q2 = 0; q2 < SPEC.squadsPerTeam; q2++) {
          for (var f = 0; f < SPEC.fields.length; f++) {
            var c2 = q2 * SPEC.colsPerSquad + f;
            var got = cellText(rows, hr, c2);
            if (got !== SPEC.fields[f]) {
              return fail('header-row',
                '第' + (hr + 1) + '行 ' + colLetter(c2) + ' 列应为「' + SPEC.fields[f] +
                '」，实际是「' + (got || '空') + '」。列序必须按 名字 / 技能 / 人脉 / 密偶 排列。',
                { row: hr + 1, col: c2 + 1 });
            }
          }
        }
      }
    }

    var tail = cellText(rows, SPEC.alliances * SPEC.allianceStride, 0);
    if (labelNo(tail, '联盟') > 0) {
      return fail('alliance-extra',
        '第' + (SPEC.alliances * SPEC.allianceStride + 1) + '行出现了「' + tail + '」：模板只支持 5 个联盟。',
        { row: SPEC.alliances * SPEC.allianceStride + 1, col: 1 });
    }

    return { ok: true };
  }

  /* ============================ 图例（颜色 → 职业） ============================ */

  function readLegend(sheet, project) {
    var rows = sheet.rows || [];
    var colors = sheet.colors || [];
    var list = [];
    var map = {};
    var conflicts = [];
    SPEC.legendRows.forEach(function (r) {
      var name = cellText(rows, r, SPEC.legendCol);
      var color = cellColor(colors, r, SPEC.legendCol);
      var cls = classByName(project, name);
      var item = {
        row: r + 1,
        color: color,
        className: name,
        classId: cls ? cls.id : ''
      };
      list.push(item);
      if (!cls) { conflicts.push(item); return; }
      if (color) map[color] = cls.id;
    });
    return { list: list, map: map, conflicts: conflicts };
  }

  /* 图例颜色 → 职业：先精确匹配，未命中再找色差容差内最接近的图例色 */
  function legendMatch(legend, color) {
    if (!color || color === SPEC.emptyFill) return '';
    if (legend.map[color]) return legend.map[color];
    var best = '';
    var bestD = COLOR_TOLERANCE;
    (legend.list || []).forEach(function (it) {
      if (!it.classId || !it.color || it.color === SPEC.emptyFill) return;
      var d = colorDistance(it.color, color);
      if (d <= bestD) { bestD = d; best = it.classId; }
    });
    return best;
  }

  /* ============================ 解析成员 ============================ */

  function parse(sheet, project, options) {
    var opts = options || {};
    var layout = checkLayout(sheet, opts);
    if (!layout.ok) return layout;

    var rows = sheet.rows || [];
    var colors = sheet.colors || [];
    var legend = readLegend(sheet, project);
    var entries = [];
    var colorHits = 0;
    var defaultHits = 0;
    var unknownMap = {};
    var unknownList = [];
    var arena = [];

    for (var a = 0; a < SPEC.alliances; a++) {
      var ar = a * SPEC.allianceStride;
      for (var t = 0; t < SPEC.teamsPerAlliance; t++) {
        var r0 = ar + SPEC.teamRowOffset + t * SPEC.teamBlockRows;
        var teamNo = a * SPEC.teamsPerAlliance + t + 1;
        var memberStart = r0 + SPEC.memberRowOffset;
        for (var q = 0; q < SPEC.squadsPerTeam; q++) {
          var col = q * SPEC.colsPerSquad;
          var globalSquad = (teamNo - 1) * SPEC.squadsPerTeam + q + 1;
          for (var slot = 0; slot < SPEC.rowsPerSquad; slot++) {
            var r = memberStart + slot;
            var name = cellText(rows, r, col);
            if (!name) continue;

            var color = cellColor(colors, r, col);
            var classId = legendMatch(legend, color);
            var miss = !!(color && color !== SPEC.emptyFill && !classId);
            if (classId) colorHits++; else defaultHits++;

            if (miss) {
              var key = color;
              if (!unknownMap[key]) {
                unknownMap[key] = { color: key, count: 0, cells: [], names: [] };
                unknownList.push(unknownMap[key]);
              }
              unknownMap[key].count++;
              unknownMap[key].cells.push(colLetter(col) + (r + 1));
              unknownMap[key].names.push(name);
            }

            entries.push({
              row: r + 1,
              allianceNo: a + 1,
              teamNo: teamNo,
              teamCustom: '',
              squadNo: globalSquad,
              squadCustom: '',
              slot: slot,
              name: name,
              slots: {
                skill: cellText(rows, r, col + 1),
                connection: cellText(rows, r, col + 2),
                puppet: cellText(rows, r, col + 3),
                note: ''
              },
              skillsRaw: '',
              classRaw: '',
              formRaw: '',
              classId: classId,
              classOrigin: classId ? 'color' : 'default',
              color: color,
              colorMiss: miss,
              source: { sheet: sheet.name || SPEC.sheetName, column: colLetter(col), row: r + 1 }
            });
            arena.push({ name: name, teamNo: teamNo, squadNo: globalSquad, slot: slot });
          }
        }
      }
    }

    /* U9 起：候补名单（不占编制）。跳过标题 / 空行 / 「…」/ 表尾标记 */
    var pool = [];
    var poolSkipped = 0;
    var lastRow = Math.max(rows.length, SPEC.poolStartRow);
    for (var pr = SPEC.poolStartRow; pr < lastRow; pr++) {
      var raw = cellText(rows, pr, SPEC.poolCol);
      if (!raw) continue;
      if (raw === SPEC.poolTitle || raw === SPEC.endMark) { poolSkipped++; continue; }
      if (/^候补(人员)?[0-9０-９]*$/.test(raw)) { poolSkipped++; continue; }
      if (/^[…⋯\.]|^（|^\(|^说明|^注[：:]|^%|^#/.test(raw)) { poolSkipped++; continue; }

      var pColor = cellColor(colors, pr, SPEC.poolCol);
      var pClassId = legendMatch(legend, pColor);
      pool.push({
        row: pr + 1,
        allianceNo: 0,
        teamNo: 0,
        squadNo: 0,
        slot: 0,
        name: raw,
        slots: { skill: '', connection: '', puppet: '', note: '' },
        skillsRaw: '',
        classRaw: '',
        formRaw: '',
        classId: pClassId,
        classOrigin: pClassId ? 'color' : 'default',
        color: pColor,
        colorMiss: false,
        source: { sheet: sheet.name || SPEC.sheetName, column: 'U', row: pr + 1 }
      });
    }

    var rec = {
      entries: entries,
      pool: pool,
      skipped: [],
      nameCells: entries.length + pool.length,
      teamCount: SPEC.teamCount,
      squadCount: SPEC.squadCount,
      teams: [],
      sheetSummaries: [{
        name: sheet.name || SPEC.sheetName,
        recognized: true,
        teams: SPEC.teamCount,
        squads: SPEC.squadCount,
        members: entries.length,
        rowStart: 1,
        rowEnd: rows.length,
        pool: pool.length,
        trailing: 0,
        ignoredRows: poolSkipped
      }],
      legend: legend.list,
      legendConflicts: legend.conflicts,
      stats: { color: colorHits, defaultInferred: defaultHits, text: 0, roworder: 0 },
      unknownColors: unknownList,
      template: {
        version: 3,
        layout: '联盟行 → 团队行 → 小队行 → 字段行 → 6 成员行（5 联盟 × 5 团队纵向）',
        allianceNo: 1,
        teams: SPEC.teamCount,
        squads: SPEC.squadCount,
        rowsPerSquad: SPEC.rowsPerSquad,
        colsPerSquad: SPEC.colsPerSquad
      }
    };
    if (!entries.length && !pool.length) rec.empty = true;
    return { ok: true, rec: rec, arena: arena };
  }

  /* ============================ 对外接口 ============================ */

  var TEMPLATE_URL = 'assets/templates/成员导入模板.xlsx';
  var TEMPLATE_FILE = '成员导入模板.xlsx';

  function copyTemplateViaBridge(targetPath) {
    /* Electron 预留：宿主注入 window.GMHost.copyFile(src, dest) 后即可直接「复制文件到指定目录」。
       浏览器环境没有该 bridge，返回 null，由调用方回落 showSaveFilePicker / <a download>。 */
    var host = window.GMHost || null;
    if (!host || typeof host.copyFile !== 'function') return null;
    return host.copyFile(TEMPLATE_URL, targetPath || '');
  }

  GM.templateImport = {
    SPEC: SPEC,
    parse: parse,
    checkLayout: checkLayout,
    classByName: classByName,
    colLetter: colLetter,
    copyTemplateViaBridge: copyTemplateViaBridge,
    templateUrl: TEMPLATE_URL,
    templateFileName: TEMPLATE_FILE
  };
})();
