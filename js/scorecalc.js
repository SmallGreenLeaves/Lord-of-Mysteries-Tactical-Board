(function () {
  'use strict';

  /* 战略服筛选积分 · 联表计算器
   * 主视图是可编辑联表：俱乐部 | 当前分 | 常规1 | 常规2 | 小计 | 附加1 | 总计
   * 小计 = 当前分 + 常规1 + 常规2；总计 = 小计 + 附加1。
   * 本表不使用「每轮 100 / 两轮 200」封顶；封顶只作为原文保留在「规则数值表」页签。
   * 不读工程存档、不改推演引擎；草稿只写独立 localStorage 键 STORE_KEY。
   */

  var STORE_KEY = 'gm.scorecalc.draft.v1';

  var RULE_P1 = [10, 8, 6, 4];
  var RULE_P2 = [40, 35, 30, 25, 20, 15, 10, 5];
  var RULE_PLAYOFF = [
    [50, 47, 44, 41],
    [45, 42, 39, 36],
    [40, 37, 34, 31],
    [35, 32, 29, 26],
    [30, 27, 24, 21],
    [25, 22, 19, 16],
    [20, 17, 14, 11],
    [15, 12, 9, 6]
  ];
  var RULE_ROUND_CAP = 100;
  var RULE_TOTAL_CAP = 200;

  var state = {
    tab: 'season',
    rows: []
  };
  var els = {};
  var uidSeed = 0;

  /* ============================ 工具函数 ============================ */

  function q(sel) { return document.querySelector(sel); }
  function qa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function uid() {
    uidSeed++;
    return 'row' + Date.now().toString(36) + '-' + uidSeed;
  }
  function fmtNum(n) {
    var v = Math.round((Number(n) || 0) * 100) / 100;
    return String(v);
  }

  /* 当前分仍是手填数字；非数字按 0 计（不再做标红解析） */
  function parseDirect(raw) {
    var t = String(raw == null ? '' : raw).trim();
    if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
    return 0;
  }

  /* 行序分组：第 1–4 行为 A 组，第 5–8 行为 B 组，第 9 行起不参与常规赛 */
  function groupOf(index) {
    if (index < 4) return 'A';
    if (index < 8) return 'B';
    return '';
  }

  function validRank(v, max) {
    var n = Number(v);
    return !!v && isFinite(n) && n >= 1 && n <= max;
  }

  /* 常规1 各组全部选完才锁定分组；第 1、2 名 = 胜者组，第 3、4 名 = 败者组 */
  function buildGroups() {
    var members = { A: [], B: [] };
    state.rows.forEach(function (row, i) {
      var g = groupOf(i);
      if (g) members[g].push(row);
    });
    var complete = {};
    var bucket = {};
    ['A', 'B'].forEach(function (g) {
      var list = members[g];
      complete[g] = list.length > 0 && list.every(function (row) { return validRank(row.r1, 4); });
      if (complete[g]) {
        list.forEach(function (row) {
          bucket[row.id] = Number(row.r1) <= 2 ? 'winner' : 'loser';
        });
      }
    });
    return { complete: complete, bucket: bucket };
  }

  function groupRows(g) {
    return state.rows.filter(function (row, i) { return groupOf(i) === g; });
  }

  /* 常规1 组内名次互斥：旧草稿若有重复，保留行序靠前者，其余置未选 */
  function dedupeGroupR1() {
    ['A', 'B'].forEach(function (g) {
      var seen = {};
      groupRows(g).forEach(function (row) {
        if (!row.r1) return;
        if (seen[row.r1]) row.r1 = '';
        else seen[row.r1] = true;
      });
    });
  }

  function r2Allowed(bucket, rank) {
    if (!bucket || !rank) return false;
    var n = Number(rank);
    if (bucket === 'winner') return n >= 1 && n <= 4;
    return n >= 5 && n <= 8;
  }

  /* 分组变化后清掉不合法的常规2 / 附加名次，并保证胜者组 / 败者组内名次互斥 */
  function normalizeGroups(ctx) {
    var seenR2 = { winner: {}, loser: {} };
    state.rows.forEach(function (row) {
      var b = ctx.bucket[row.id];
      if (!r2Allowed(b, row.r2)) {
        row.r2 = '';
        row.exRank = '';
      } else if (seenR2[b][row.r2]) {
        row.r2 = '';
        row.exRank = '';
      } else {
        seenR2[b][row.r2] = true;
      }
      if (!validRank(row.exRank, 4)) row.exRank = '';
    });
  }

  /* 顶掉：目标名次已被同组（常规1）/ 同组别（常规2）其他俱乐部占用时，占用者回到未选 */
  function takeOverRank(row, field, value) {
    if (!value) return '';
    var ctx = field === 'r2' ? buildGroups() : null;
    var index = state.rows.indexOf(row);
    for (var i = 0; i < state.rows.length; i++) {
      if (i === index) continue;
      var peer = state.rows[i];
      if (field === 'r1') {
        if (groupOf(i) !== groupOf(index)) continue;
      } else {
        if (!ctx.bucket[row.id] || ctx.bucket[peer.id] !== ctx.bucket[row.id]) continue;
      }
      if (String(peer[field] || '') !== String(value)) continue;
      peer[field] = '';
      if (field === 'r2') peer.exRank = '';
      return peer.name || '（未命名）';
    }
    return '';
  }

  function calcRow(row, ctx, index) {
    var base = parseDirect(row.cur);
    var bucket = ctx.bucket[row.id] || '';
    var group = groupOf(index);
    var v1 = validRank(row.r1, 4) ? RULE_P1[Number(row.r1) - 1] : 0;
    var v2 = r2Allowed(bucket, row.r2) ? RULE_P2[Number(row.r2) - 1] : 0;
    var tier = r2Allowed(bucket, row.r2) ? Number(row.r2) : 0;
    var exRank = (tier && validRank(row.exRank, 4)) ? Number(row.exRank) : 0;
    var exScore = (tier && exRank) ? RULE_PLAYOFF[tier - 1][exRank - 1] : 0;
    var s1 = base + v1;
    var s2 = s1 + v2;
    return {
      row: row,
      group: group,
      bucket: bucket,
      cur: base,
      v1: v1,
      v2: v2,
      tier: tier,
      exRank: exRank,
      exReady: !!(tier && exRank),
      exScore: exScore,
      s1: s1,
      s2: s2,
      sub: s2,
      total: s2 + exScore
    };
  }

  /* ============================ 默认数据 ============================ */

  function defaultRows() {
    /* r1/r2 存名次；组内名次互斥，默认 A/B 组各为 1、2、3、4 的不重复名次 */
    function r(name, cur, r1, r2, exRank) {
      return {
        id: uid(), name: name, cur: cur,
        r1: r1, r2: r2, exRank: exRank || ''
      };
    }
    return [
      r('旋云之巅', '100', '1', '1'),
      r('星河', '90', '2', '2'),
      r('为欢', '69', '3', '6'),
      r('双树辉光', '62', '4', '5', '4'),
      r('萝卜', '45', '2', '4'),
      r('追光', '43', '1', '3', '3'),
      r('瑰月', '0', '3', '7'),
      r('玲珑阁', '0', '4', '8'),
      r('啾咪', '25', '', ''),
      r('麦当劳', '20', '', '')
    ];
  }

  /* ============================ 草稿 ============================ */

  function cleanRank(v, max) {
    var n = Number(v);
    if (!v || !isFinite(n) || n < 1 || n > max) return '';
    return String(Math.round(n));
  }

  /* 旧草稿存的是分值：按表反查名次 / 附加名次，仅用于迁移 */
  function scoreToRank(v, table) {
    var n = Number(v);
    if (!v || !isFinite(n)) return '';
    var idx = table.indexOf(n);
    return idx >= 0 ? String(idx + 1) : '';
  }

  function scoreToExtraRank(v) {
    var n = Number(v);
    if (!v || !isFinite(n)) return '';
    for (var t = 0; t < RULE_PLAYOFF.length; t++) {
      var idx = RULE_PLAYOFF[t].indexOf(n);
      if (idx >= 0) return String(idx + 1);
    }
    return '';
  }

  function sanitizeRows(raw) {
    if (!Array.isArray(raw) || !raw.length) return defaultRows();
    var out = [];
    raw.slice(0, 200).forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var oldFormat = !('exRank' in item);
      out.push({
        id: String(item.id || uid()).slice(0, 40),
        name: String(item.name == null ? '' : item.name).slice(0, 40),
        cur: String(item.cur == null ? '' : item.cur).slice(0, 12),
        r1: oldFormat ? scoreToRank(item.r1, RULE_P1) : cleanRank(item.r1, 4),
        r2: oldFormat ? scoreToRank(item.r2, RULE_P2) : cleanRank(item.r2, 8),
        exRank: oldFormat ? scoreToExtraRank(item.ex) : cleanRank(item.exRank, 4)
      });
    });
    return out.length ? out : defaultRows();
  }

  function saveDraft() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({
        tab: state.tab,
        rows: state.rows
      }));
    } catch (err) { /* 存储不可用时只留内存 */ }
  }

  function loadDraft() {
    state.rows = defaultRows();
    state.tab = 'season';
    var legacy = false;
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') {
        if (parsed.tab === 'rules') state.tab = 'rules';
        if (Array.isArray(parsed.rows)) {
          state.rows = sanitizeRows(parsed.rows);
        } else if (parsed.season || parsed.match) {
          /* 旧版「两轮表单 / 局内」草稿：换成本版默认联表，并覆盖写回清掉旧字段 */
          legacy = true;
        }
      }
    } catch (err) { /* 忽略损坏草稿 */ }
    if (legacy) saveDraft();
  }

  /* ============================ 渲染：联表 ============================ */

  function inputCell(row, field, value, cls) {
    var mode = field === 'cur' ? ' inputmode="numeric"' : '';
    return '<input class="sc-input' + (cls ? ' ' + cls : '') + '" data-row="' + esc(row.id) + '" data-field="' + field +
      '" value="' + esc(value) + '" spellcheck="false"' + mode + '>';
  }

  function selectCell(row, field, options, disabled, cls) {
    var cur = String(row[field] == null ? '' : row[field]);
    var html = '<select class="sc-select' + (cls ? ' ' + cls : '') + '" data-row="' + esc(row.id) + '" data-field="' + field + '"' +
      (disabled ? ' disabled' : '') + '>';
    options.forEach(function (opt) {
      html += '<option value="' + esc(opt.v) + '"' + (cur === String(opt.v) ? ' selected' : '') +
        (opt.disabled ? ' disabled' : '') + '>' + esc(opt.label) + '</option>';
    });
    return html + '</select>';
  }

  function rankOptions(max, table, emptyLabel, taken) {
    var opts = [{ v: '', label: emptyLabel || '未选' }];
    for (var i = 1; i <= max; i++) {
      var owner = taken && taken[String(i)];
      opts.push({
        v: String(i),
        label: '第 ' + i + ' 名（' + table[i - 1] + '）' + (owner ? ' · 已被' + owner + '占用' : ''),
        disabled: !!owner
      });
    }
    return opts;
  }

  /* 常规2 下拉：胜者组只给 1–4，败者组只给 5–8；同组别内名次互斥 */
  function r2Options(bucket, taken) {
    if (!bucket) return [{ v: '', label: '待常规1选完' }];
    var from = bucket === 'winner' ? 1 : 5;
    var to = bucket === 'winner' ? 4 : 8;
    var opts = [{ v: '', label: '未选' }];
    for (var i = from; i <= to; i++) {
      var owner = taken && taken[String(i)];
      opts.push({
        v: String(i),
        label: '第 ' + i + ' 名（' + RULE_P2[i - 1] + '）' + (owner ? ' · 已被' + owner + '占用' : ''),
        disabled: !!owner
      });
    }
    return opts;
  }

  function extraRankOptions() {
    var opts = [{ v: '', label: '未附加' }];
    for (var i = 1; i <= 4; i++) opts.push({ v: String(i), label: '第 ' + i + ' 名' });
    return opts;
  }

  function renderMain() {
    var host = q('#scSeasonBody');
    if (!host) return;
    dedupeGroupR1();
    var ctx = buildGroups();
    normalizeGroups(ctx);
    var html = '<div class="sc-section">' +
      '<div class="sc-section-title">俱乐部累计分联表 <span class="sc-tag">本表不使用封顶</span></div>' +
      '<div class="sc-hint">第 1–4 行 = A 组，第 5–8 行 = B 组，第 9 行起不参与常规赛。' +
      '常规1 同组名次互斥（已被占用的名次置灰）；选完后每组第 1、2 名进胜者组（常规2 只给 1–4 → 40/35/30/25），' +
      '第 3、4 名进败者组（常规2 只给 5–8 → 20/15/10/5），胜者组 / 败者组内同样名次互斥。' +
      '附加1 只选本场名次，档位随常规2 名次自动取。封顶规则（每轮 100 / 两轮 200）只在「规则数值表」页签保留，本表不套用。</div>' +
      '<div class="sc-table-wrap"><table class="sc-table sc-league"><thead><tr>' +
      '<th>俱乐部</th><th>当前分</th><th>常规1</th><th>常规2</th><th>小计</th><th>附加1</th><th>总计</th>' +
      '</tr></thead><tbody>';

    state.rows.forEach(function (row, index) {
      var gid = groupOf(index);
      var bucket = ctx.bucket[row.id];
      var r2Dis = !bucket;
      var exDis = !r2Allowed(bucket, row.r2);
      var takenR1 = {};
      var takenR2 = {};
      state.rows.forEach(function (peer, pi) {
        if (peer.id === row.id) return;
        if (gid && groupOf(pi) === gid && peer.r1) takenR1[peer.r1] = peer.name || '（未命名）';
        if (bucket && ctx.bucket[peer.id] === bucket && peer.r2) takenR2[peer.r2] = peer.name || '（未命名）';
      });
      html += '<tr>' +
        '<td class="sc-name-cell">' + inputCell(row, 'name', row.name, 'sc-name') +
        '<button type="button" class="sc-del" data-del="' + esc(row.id) + '" title="删除此行">✕</button></td>' +
        '<td>' + inputCell(row, 'cur', row.cur, 'sc-num') + '</td>' +
        '<td>' + selectCell(row, 'r1', rankOptions(4, RULE_P1, gid ? '未选' : '不参与', takenR1), !gid) +
        '<span class="sc-resolve" id="scHint-r1-' + esc(row.id) + '"></span></td>' +
        '<td>' + selectCell(row, 'r2', r2Options(bucket, takenR2), r2Dis) +
        '<span class="sc-resolve" id="scHint-r2-' + esc(row.id) + '"></span></td>' +
        '<td class="sc-strong" id="scSub-' + esc(row.id) + '">0</td>' +
        '<td class="sc-ex-cell">' + selectCell(row, 'exRank', extraRankOptions(), exDis) +
        '<span class="sc-resolve" id="scHint-ex-' + esc(row.id) + '"></span></td>' +
        '<td class="sc-strong" id="scTot-' + esc(row.id) + '">0</td>' +
        '</tr>';
    });

    html += '</tbody></table></div>' +
      '<div class="sc-notice hidden" id="scNotice"></div>' +
      '<div class="sc-actions">' +
      '<button type="button" class="btn mini" data-sc-action="addRow">＋ 添加俱乐部</button>' +
      '<button type="button" class="btn mini ghost" data-sc-action="resetTable">恢复默认</button>' +
      '</div>' +
      '<div class="sc-hint">默认数据备注：麦当劳 = 假设第三，然后第一（小组第五）。</div></div>';

    host.innerHTML = html;
    updateComputed();
  }

  function showNotice(text) {
    var nt = q('#scNotice');
    if (!nt) return;
    nt.textContent = text;
    nt.classList.remove('hidden');
  }

  function setHint(id, text) {
    var el = q('#' + id);
    if (el) el.textContent = text;
  }

  function updateComputed() {
    var ctx = buildGroups();
    var calcs = state.rows.map(function (row, index) { return calcRow(row, ctx, index); });

    calcs.forEach(function (c) {
      var id = c.row.id;
      var r1Text;
      if (!c.group) r1Text = '不参与常规1';
      else if (validRank(c.row.r1, 4)) r1Text = '= ' + fmtNum(c.v1) + ' 分（' + c.group + '组）';
      else r1Text = '未选（按 0 计）';

      var r2Text;
      if (!c.bucket) r2Text = c.group ? '常规1 未选完（置灰）' : '不参与常规2';
      else if (!r2Allowed(c.bucket, c.row.r2)) r2Text = '未选（按 0 计）';
      else r2Text = '= ' + fmtNum(c.v2) + ' 分（' + (c.bucket === 'winner' ? '胜者组' : '败者组') + '）';

      var exText;
      if (!c.tier) exText = c.bucket ? '未附加（按 0 计）' : '不可选';
      else if (!c.exRank) exText = '未附加（按 0 计）';
      else exText = '= ' + fmtNum(c.exScore) + ' 分（档 ' + c.tier + ' · 第 ' + c.exRank + ' 名）';

      setHint('scHint-r1-' + id, r1Text);
      setHint('scHint-r2-' + id, r2Text);
      setHint('scHint-ex-' + id, exText);
      var sub = q('#scSub-' + id);
      var tot = q('#scTot-' + id);
      if (sub) sub.textContent = fmtNum(c.sub);
      if (tot) tot.textContent = fmtNum(c.total);
    });

    renderRankPanel(calcs);
  }

  /* ============================ 渲染：三阶段名次 ============================ */

  function rankPhase(calcs, getScore) {
    var list = calcs.map(function (c) {
      return { id: c.row.id, name: c.row.name || '（未命名）', score: getScore(c), bucket: c.bucket };
    }).sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return 0;
    });
    list.forEach(function (item, i) {
      if (i > 0 && item.score === list[i - 1].score) item.rank = list[i - 1].rank;
      else item.rank = i + 1;
    });
    var byId = {};
    list.forEach(function (item) { byId[item.id] = item; });
    return { list: list, byId: byId };
  }

  function moveText(fromRank, toRank) {
    if (fromRank == null || toRank == null) return '';
    var d = fromRank - toRank;
    if (d === 0) return '<span class="sc-move sc-move-flat">=</span>';
    return d > 0
      ? '<span class="sc-move sc-move-up">↑' + d + '</span>'
      : '<span class="sc-move sc-move-down">↓' + (-d) + '</span>';
  }

  function bucketTag(bucket) {
    if (!bucket) return '';
    return bucket === 'winner'
      ? '<span class="sc-bucket sc-bucket-win">胜者组</span>'
      : '<span class="sc-bucket sc-bucket-lose">败者组</span>';
  }

  function renderRankPanel(calcs) {
    var host = q('#scSeasonResult');
    if (!host) return;

    var pA = rankPhase(calcs.filter(function (c) { return c.group === 'A'; }), function (c) { return c.s1; });
    var pB = rankPhase(calcs.filter(function (c) { return c.group === 'B'; }), function (c) { return c.s1; });
    var participants = calcs.filter(function (c) { return !!c.bucket; });
    var p2 = rankPhase(participants, function (c) { return c.s2; });
    var p3 = rankPhase(participants, function (c) { return c.total; });

    var rankNos = {};
    [pA, pB, p2, p3].forEach(function (phase) {
      phase.list.forEach(function (item) { rankNos[item.rank] = true; });
    });
    var rankList = Object.keys(rankNos).map(Number).sort(function (a, b) { return a - b; });
    if (!rankList.length) rankList = [1];

    function cell(phase, prev, rankNo, showMove, showBucket) {
      var members = phase.list.filter(function (item) { return item.rank === rankNo; });
      if (!members.length) return '<td class="sc-rank-empty">—</td>';
      var names = members.map(function (item) {
        var mv = (showMove && prev) ? moveText(prev.byId[item.id] ? prev.byId[item.id].rank : null, item.rank) : '';
        return esc(item.name) + (showBucket ? bucketTag(item.bucket) : '') + mv;
      }).join(' / ');
      var tie = members.length > 1 ? '<span class="sc-tie">并列 ' + members.length + ' 家</span>' : '';
      return '<td>' + names + tie + '</td>';
    }

    var html = '<div class="sc-section">' +
      '<div class="sc-section-title">三阶段名次 <span class="sc-tag">同分并列 · 只展示，不改分数</span></div>' +
      '<div class="sc-table-wrap"><table class="sc-table sc-rank"><thead><tr>' +
      '<th>名次</th><th>常规1 · A组</th><th>常规1 · B组</th><th>常规2 · 合并总分</th><th>附加赛 · 总计</th>' +
      '</tr></thead><tbody>';
    for (var i = 0; i < rankList.length; i++) {
      var k = rankList[i];
      html += '<tr><td>第 ' + k + ' 名</td>' +
        cell(pA, null, k, false, false) +
        cell(pB, null, k, false, false) +
        cell(p2, null, k, false, true) +
        cell(p3, p2, k, true, false) +
        '</tr>';
    }
    html += '</tbody></table></div>' +
      '<div class="sc-hint">常规1 只在组内排名（A 组 = 第 1–4 行，B 组 = 第 5–8 行）；常规2 起由两组的前 2 名（胜者组）与后 2 名（败者组）合并按总分排名；附加赛按总计排名。' +
      '第 9 行起未参与常规赛，不进入阶段排名。同分共享名次、下一名次顺延（1、2、2、4）；↑/↓ 为相对常规2 结算后的名次变化。排名只展示，不回写输入。</div></div>';

    host.innerHTML = html;
  }

  /* ============================ 渲染：规则数值表 ============================ */

  function renderRules() {
    var host = q('#scRules');
    if (!host) return;

    function oneTable(title, labels, values) {
      var html = '<div class="sc-table-wrap"><table class="sc-table sc-matrix"><thead><tr><th>' + title + '</th>';
      labels.forEach(function (l) { html += '<th>' + esc(l) + '</th>'; });
      html += '</tr></thead><tbody><tr><td>得分</td>';
      values.forEach(function (v) { html += '<td>' + v + '</td>'; });
      html += '</tr></tbody></table></div>';
      return html;
    }

    var labels1 = [1, 2, 3, 4].map(function (n) { return '第 ' + n + ' 名'; });
    var labels2 = [1, 2, 3, 4, 5, 6, 7, 8].map(function (n) { return '第 ' + n + ' 名'; });

    var html = '<div class="sc-section">' +
      '<div class="sc-section-title">规则图原文 <span class="sc-tag">战略服筛选积分</span></div>' +
      '<div class="sc-hint">仅联赛新赛季前两轮的神话组俱乐部可获得筛选积分；筛选积分与决定对局胜负的局内积分相互独立；' +
      '第一轮、第二轮使用相同积分表，第二轮不额外加分。</div>' +
      '<div class="sc-sub-title">常规1（四方对局第 1–4 名）</div>' + oneTable('常规1', labels1, RULE_P1) +
      '<div class="sc-sub-title">常规2（本轮最终第 1–8 名）</div>' + oneTable('常规2', labels2, RULE_P2) +
      '</div>';

    html += '<div class="sc-section">' +
      '<div class="sc-section-title">附加赛 8 档 × 4 名次 <span class="sc-tag">规则图原文</span></div>' +
      '<div class="sc-hint">档位 = 本赛区神话组常规赛最终排名；具体得分 = 本场附加赛第 1–4 名。</div>' +
      '<div class="sc-table-wrap"><table class="sc-table sc-matrix"><thead><tr>' +
      '<th>常规赛档位</th><th>附加赛第 1</th><th>第 2</th><th>第 3</th><th>第 4</th></tr></thead><tbody>';
    RULE_PLAYOFF.forEach(function (row, i) {
      html += '<tr><td>第 ' + (i + 1) + ' 名</td>';
      row.forEach(function (v) { html += '<td>' + v + '</td>'; });
      html += '</tr>';
    });
    html += '</tbody></table></div></div>';

    html += '<div class="sc-section">' +
      '<div class="sc-section-title">封顶与叠加规则 <span class="sc-tag">原文保留 · 本联表不使用</span></div>' +
      '<div class="sc-hint">原文：每轮积分 = 第1场积分 + 第2场积分 + 附加赛积分；每轮最高 ' + RULE_ROUND_CAP +
      ' 分，两轮合计最高 ' + RULE_TOTAL_CAP + ' 分；不再叠加原有单场名次积分及第一轮、第二轮最终排名加分。' +
      '本页主视图是「当前分 + 常规 + 附加」的累计联表，按用户口径不套用该封顶，允许小计超过 100。</div></div>';

    host.innerHTML = html;
  }

  /* ============================ 页签与事件 ============================ */

  function render() {
    if (!els.shell) return;
    qa('#scTabs [data-tab]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === state.tab);
    });
    qa('.sc-panel').forEach(function (panel) {
      panel.hidden = panel.getAttribute('data-panel') !== state.tab;
    });

    if (state.tab === 'rules') {
      renderRules();
      q('#scScopeTag').textContent = '规则数值表';
    } else {
      renderMain();
      q('#scScopeTag').textContent = '联表 · 不使用封顶';
    }
  }

  function findRow(id) {
    for (var i = 0; i < state.rows.length; i++) {
      if (state.rows[i].id === id) return state.rows[i];
    }
    return null;
  }

  function onInput(e) {
    var el = e.target;
    if (!el || !el.getAttribute) return;
    var rowId = el.getAttribute('data-row');
    var field = el.getAttribute('data-field');
    if (!rowId || !field) return;
    var row = findRow(rowId);
    if (!row) return;
    var value = el.value;
    row[field] = value;
    if (field === 'r1' || field === 'r2') {
      /* 名次变动会改变分组 / 附加赛可选状态，整表重绘并顺带清理不合法值 */
      var bumped = value ? takeOverRank(row, field, value) : '';
      renderMain();
      saveDraft();
      if (bumped) {
        showNotice('已将「' + bumped + '」从 ' + (field === 'r1' ? '常规1' : '常规2') + ' 第 ' + value + ' 名顶掉，改为未选。');
      }
      return;
    }
    saveDraft();
    updateComputed();
  }

  function onAction(e) {
    var del = e.target.closest('[data-del]');
    if (del) {
      var id = del.getAttribute('data-del');
      state.rows = state.rows.filter(function (r) { return r.id !== id; });
      if (!state.rows.length) state.rows = defaultRows();
      renderMain();
      saveDraft();
      return;
    }
    var btn = e.target.closest('[data-sc-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-sc-action');
    if (action === 'addRow') {
      state.rows.push({ id: uid(), name: '新俱乐部', cur: '0', r1: '', r2: '', exRank: '' });
      renderMain();
      saveDraft();
    } else if (action === 'resetTable') {
      state.rows = defaultRows();
      renderMain();
      saveDraft();
    }
  }

  function switchTab(tab) {
    if (tab !== 'season' && tab !== 'rules') return;
    state.tab = tab;
    saveDraft();
    render();
  }

  function open() {
    if (!els.overlay) return;
    els.overlay.classList.remove('hidden');
    render();
  }

  function close() {
    if (!els.overlay) return;
    els.overlay.classList.add('hidden');
  }

  function isOpen() {
    return els.overlay && !els.overlay.classList.contains('hidden');
  }

  function init() {
    els.overlay = q('#scoreCalcOverlay');
    els.shell = q('#scoreCalcShell');

    loadDraft();

    if (els.shell) {
      els.shell.addEventListener('input', onInput);
      els.shell.addEventListener('click', onAction);
    }

    var openBtn = q('#btnScoreCalc');
    if (openBtn) openBtn.addEventListener('click', open);
    var closeBtn = q('#scClose');
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (els.overlay) {
      els.overlay.addEventListener('click', function (e) {
        if (e.target === els.overlay) close();
      });
    }
    qa('#scTabs [data-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.getAttribute('data-tab')); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) {
        close();
        e.stopPropagation();
      }
    }, true);

    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
