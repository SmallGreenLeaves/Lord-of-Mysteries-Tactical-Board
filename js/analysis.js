(function () {
  'use strict';

  window.GM = window.GM || {};
  var GM = window.GM;
  var U = GM.util;

  var MAP_KEY = 'gm.analysis.mapping.v1';
  var SETTINGS_KEY = 'gm.analysis.settings.v1';
  var SHEET_KEY = 'gm.analysis.sheet.v1';

  /* 列映射：只保留分析真正用到的列。
   * 旧的形态与时长维度已移除（编队配置里的形态不受影响）。 */
  var FIELDS = [
    { key: 'player', label: '玩家名', required: true, desc: '每行的玩家标识（必填）',
      aliases: ['玩家名字', '玩家名', '游戏名', '角色名', '姓名', 'name', 'player'] },
    { key: 'class', label: '职业', desc: '按职业分组、取同职业中位数与四分位',
      aliases: ['职业', '职业名', '门派', 'class'] },
    { key: 'win', label: '击败', desc: '击杀次数（数值）',
      aliases: ['击败', '击杀', '击杀数', 'kills', 'kill'] },
    { key: 'assist', label: '助攻', desc: '助攻次数（数值）',
      aliases: ['助攻', '助杀', 'assists', 'assist'] },
    { key: 'damage', label: '对玩家伤害', desc: '输出量；空白 = 该职业不做此指标',
      aliases: ['对玩家伤害', '伤害', '输出', '输出量', 'damage', 'dmg'] },
    { key: 'taken', label: '承受伤害', desc: '承伤量；空白 = 不适用',
      aliases: ['承受伤害', '承伤', '受到伤害', '被伤害', 'taken'] },
    { key: 'heal', label: '治疗', desc: '治疗量；仅治疗职业有值',
      aliases: ['治疗', '治疗量', 'heal', 'healing'] },
    { key: 'death', label: '死亡数', desc: '可选；映射后作为附加维度',
      aliases: ['死亡', '死亡数', '阵亡', 'deaths', 'death'] }
  ];

  /* 统计用到的原始指标（全部来自表格） */
  var METRICS = ['damage', 'taken', 'heal', 'ka', 'deaths'];

  /* 派生指标（由原始值计算） */
  var DERIVED = ['ratio', 'outEff', 'takenEff', 'takenRatio', 'killConv', 'healEff'];

  /* 维度定义（README_AI.md 中同表）：每条疑点按这些维度归一化后加权求和 */
  var DIMENSIONS = [
    { key: 'share', label: '输出占比', weightKey: 'wShare', thresholdKey: 'shareLow',
      formula: '伤害 / 同职业伤害中位数；低于 shareLow 时记异常（仅输出口径）',
      norm: '异常度 = (shareLow − 本人比值) / shareLow，截断到 0–1' },
    { key: 'eff', label: '输出效率', weightKey: 'wEff', thresholdKey: 'effLow',
      formula: '伤害 / (击败 + 助攻)（仅输出口径）',
      norm: '异常度 = (effLow − 本人值/同职业中位) / effLow，截断到 0–1' },
    { key: 'taken', label: '承伤合理性', weightKey: 'wTaken', thresholdKey: 'takenHigh',
      formula: '承伤 / 同职业承伤中位数；输出口径另看 承伤 / 伤害',
      norm: '异常度 = max(承伤倍数/takenHigh − 1, 承伤伤害比倍数/takenRatioHigh − 1)，截断到 0–1；坦克口径另含「过低」' },
    { key: 'conv', label: '击杀转化', weightKey: 'wConv', thresholdKey: 'convLow',
      formula: '击败 / (击败 + 助攻)（仅输出口径）',
      norm: '异常度 = (convLow − 本人转化率) / convLow，截断到 0–1' },
    { key: 'contrib', label: '团队贡献', weightKey: 'wContrib', thresholdKey: 'contribQ1',
      formula: '击败 + 助攻 与同职业下四分位的比较（仅输出口径）',
      norm: '异常度 = (下四分位×contribQ1 − 本人值) / (下四分位×contribQ1)，截断到 0–1' },
    { key: 'heal', label: '治疗量', weightKey: 'wHeal', thresholdKey: 'healLow',
      formula: '治疗量 / 同职业治疗中位数；以及 治疗量 / (击败 + 助攻)（治疗口径）',
      norm: '异常度 = max(治疗倍数阈值缺口, 治疗效率阈值缺口)，截断到 0–1' },
    { key: 'death', label: '死亡偏高', weightKey: 'wDeath', thresholdKey: 'deathHigh',
      formula: '死亡 / 同职业死亡中位数（需映射死亡列）',
      norm: '异常度 = 死亡倍数/deathHigh − 1，截断到 0–1' },
    { key: 'assist', label: '助攻参与度', weightKey: 'wAssist', thresholdKey: 'assistLow',
      formula: '助攻 / (击败 + 助攻)（坦克口径；无助攻列则不适用）',
      norm: '异常度 = (assistLow − 助攻占比) / assistLow，截断到 0–1' }
  ];

  /* 默认值全部是假设值，不是官方规则；界面上可改，改动即时保存并重算 */
  var DEFAULT_SETTINGS = {
    profilePreset: 'standard',
    minGroup: 3,
    shareLow: 0.6,
    effLow: 0.7,
    takenHigh: 1.4,
    takenRatioHigh: 1.2,
    takenLow: 0.6,
    convLow: 0.3,
    contribQ1: 1.0,
    healLow: 0.5,
    healEffLow: 0.7,
    deathHigh: 1.5,
    assistLow: 0.35,
    scoreLow: 0.18,
    scoreMid: 0.32,
    scoreHigh: 0.55,
    wShare: 0.25,
    wEff: 0.2,
    wTaken: 0.15,
    wConv: 0.15,
    wContrib: 0.15,
    wHeal: 0.1,
    wDeath: 0.1,
    wAssist: 0.1,
    zeroRulesOn: true,
    zeroIdleOn: true,
    zeroSuppressedOn: true,
    zeroKillOn: true,
    tankTakenZeroOn: true,
    zeroTakenRatio: 0.5,
    exemptionOn: true
  };

  var SETTING_SPECS = [
    { group: 'sample', key: 'minGroup', label: '同职业最少人数', min: 2, max: 10, step: 1, unit: '人',
      desc: '少于这个人数，该职业不做中位数/分位比较，例：3 人' },
    { group: 'bands', key: 'scoreLow', label: '低档线', min: 0.05, max: 0.5, step: 0.01, unit: '分',
      desc: '综合异常分达到这个值才进疑点清单，例：0.18' },
    { group: 'bands', key: 'scoreMid', label: '中档线', min: 0.1, max: 0.8, step: 0.01, unit: '分',
      desc: '综合异常分 ≥ 这个值判「中」，例：0.32' },
    { group: 'bands', key: 'scoreHigh', label: '高档线', min: 0.2, max: 1, step: 0.01, unit: '分',
      desc: '综合异常分 ≥ 这个值判「高」，例：0.55' },
    { group: 'threshold', key: 'shareLow', label: '输出占比低位线', min: 0.1, max: 1.5, step: 0.05, unit: '×中位',
      desc: '伤害低于同职业中位数的百分比，例：0.6 = 中位的 60%' },
    { group: 'threshold', key: 'effLow', label: '输出效率低位线', min: 0.1, max: 1.5, step: 0.05, unit: '×中位',
      desc: '伤害/(击败+助攻) 低于同职业中位的百分比，例：0.7' },
    { group: 'threshold', key: 'takenHigh', label: '承伤偏高线', min: 0.5, max: 3, step: 0.05, unit: '×中位',
      desc: '承伤高于同职业中位的倍数，例：1.4 = 中位的 1.4 倍' },
    { group: 'threshold', key: 'takenRatioHigh', label: '承伤/伤害偏高线', min: 0.5, max: 4, step: 0.05, unit: '×中位',
      desc: '承伤÷伤害 高于同职业中位的倍数（仅输出口径），例：1.2' },
    { group: 'threshold', key: 'takenLow', label: '承伤偏低线（坦克）', min: 0.1, max: 1.5, step: 0.05, unit: '×中位',
      desc: '坦克承伤低于同职业中位的百分比即提示「可能没进场」，例：0.6' },
    { group: 'threshold', key: 'convLow', label: '击杀转化低位线', min: 0.05, max: 1, step: 0.01, unit: '%',
      desc: '击败/(击败+助攻) 低于这个比例时提示，例：0.30 = 30%' },
    { group: 'threshold', key: 'contribQ1', label: '团队贡献线', min: 0.3, max: 2, step: 0.05, unit: '×下四分位',
      desc: '击败+助攻 低于同职业下四分位的倍数，例：1.0' },
    { group: 'threshold', key: 'healLow', label: '治疗量低位线', min: 0.1, max: 1.5, step: 0.05, unit: '×中位',
      desc: '治疗量低于同职业中位数的百分比，例：0.5 = 只到中位的一半才提示' },
    { group: 'threshold', key: 'healEffLow', label: '治疗效率低位线', min: 0.1, max: 1.5, step: 0.05, unit: '×中位',
      desc: '治疗/(击败+助攻) 低于同职业中位的百分比，例：0.7' },
    { group: 'threshold', key: 'deathHigh', label: '死亡偏高线', min: 0.5, max: 4, step: 0.1, unit: '×中位',
      desc: '死亡高于同职业中位的倍数；仅在映射了死亡列时生效，例：1.5' },
    { group: 'threshold', key: 'assistLow', label: '助攻参与底线（坦克）', min: 0.05, max: 1, step: 0.01, unit: '%',
      desc: '助攻占击败+助攻 的最低比例，例：0.35 = 35%' },
    { group: 'weight', key: 'wShare', label: '权重 · 输出占比', min: 0, max: 1, step: 0.05, unit: '权重',
      desc: '基准权重，再乘口径系数后按适用维度归一化' },
    { group: 'weight', key: 'wEff', label: '权重 · 输出效率', min: 0, max: 1, step: 0.05, unit: '权重',
      desc: '基准权重，再乘口径系数后按适用维度归一化' },
    { group: 'weight', key: 'wTaken', label: '权重 · 承伤合理性', min: 0, max: 1, step: 0.05, unit: '权重',
      desc: '坦克口径会被放大，成为主维度' },
    { group: 'weight', key: 'wConv', label: '权重 · 击杀转化', min: 0, max: 1, step: 0.05, unit: '权重',
      desc: '仅输出口径适用；治疗口径有伤害时减半' },
    { group: 'weight', key: 'wContrib', label: '权重 · 团队贡献', min: 0, max: 1, step: 0.05, unit: '权重',
      desc: '仅输出口径适用；治疗口径有伤害时减半' },
    { group: 'weight', key: 'wHeal', label: '权重 · 治疗量', min: 0, max: 1, step: 0.05, unit: '权重',
      desc: '治疗口径会被放大，成为主维度' },
    { group: 'weight', key: 'wDeath', label: '权重 · 死亡偏高', min: 0, max: 1, step: 0.05, unit: '权重',
      desc: '仅在映射了死亡列时参与加权' },
    { group: 'weight', key: 'wAssist', label: '权重 · 助攻参与度', min: 0, max: 1, step: 0.05, unit: '权重',
      desc: '仅坦克口径适用' },
    { group: 'rule', key: 'zeroRulesOn', label: '零值规则总开关', type: 'bool', unit: '',
      desc: '关闭后不再产出零值专门疑点；口径判定仍生效' },
    { group: 'rule', key: 'zeroIdleOn', label: '零值 · 疑似未参战', type: 'bool', unit: '',
      desc: '仅输出口径：伤害=0 且 承伤=0 且 击败+助攻=0' },
    { group: 'rule', key: 'zeroSuppressedOn', label: '零值 · 被压制/无输出', type: 'bool', unit: '',
      desc: '仅输出口径：伤害=0 但承伤 > 0' },
    { group: 'rule', key: 'zeroKillOn', label: '零值 · 零输出但参与击杀', type: 'bool', unit: '',
      desc: '仅输出口径：伤害=0 但击败+助攻 > 0' },
    { group: 'rule', key: 'tankTakenZeroOn', label: '零值 · 坦克承伤为 0', type: 'bool', unit: '',
      desc: '仅坦克口径：承伤=0 提示可能没进场/没吃到伤害' },
    { group: 'rule', key: 'zeroTakenRatio', label: '零值 · 承伤“明显”线', min: 0.1, max: 2, step: 0.05, unit: '×中位',
      desc: '伤害=0 时，承伤达到同职业中位的该倍数才算「被压制」，例：0.5' },
    { group: 'rule', key: 'exemptionOn', label: '反向豁免', type: 'bool', unit: '',
      desc: '低输出但极低承伤且高击杀转化 → 豁免；治疗偏低但击败助攻高 → 降级' }
  ];

  var GROUP_TITLES = {
    sample: '样本与分档',
    threshold: '维度阈值（全部为假设值）',
    weight: '维度权重（0–1，按适用维度归一化）',
    rule: '零值与反向豁免'
  };

  /* ============================ 角色口径 ============================ */

  /* 职业 → 口径：观众 = 治疗，战士 = 坦克，歌颂 / 学徒 / 占卜 / 窥秘 = 输出 */
  var PROFILE_LABELS = { output: '输出口径', heal: '治疗口径', tank: '坦克口径' };
  var PROFILE_DESC = {
    output: '歌颂 / 学徒 / 占卜 / 窥秘：评输出占比、输出效率、承伤合理性、击杀转化、团队贡献',
    heal: '观众：只评治疗量、治疗效率与承伤生存提示；不评伤害、输出效率、击杀转化、击败+助攻',
    tank: '战士：只评承伤合理性（过高 / 过低）与助攻参与；不评伤害、输出效率、击杀转化'
  };

  /* 口径允许的维度；数据缺列时再按「本场无数据」置灰 */
  var PROFILE_ALLOW = {
    output: { share: 1, eff: 1, taken: 1, conv: 1, contrib: 1, heal: 1, death: 1 },
    heal: { heal: 1, taken: 1, death: 1, share: 1, eff: 1, conv: 1, contrib: 1 },
    tank: { taken: 1, assist: 1, death: 1 }
  };

  /* 口径内的相对权重系数（再乘默认 wXxx，最后按适用维度归一化） */
  var PROFILE_WEIGHT = {
    output: { share: 1.6, eff: 1.4, taken: 1.0, conv: 1.0, contrib: 1.0, heal: 1.0, death: 0.7 },
    heal: { heal: 3.0, taken: 0.8, death: 0.6, share: 0.8, eff: 0.7, conv: 0.5, contrib: 0.5 },
    tank: { taken: 3.0, assist: 2.5, death: 0.6 }
  };

  /* 治疗口径只在有伤害值时「附加」评估这几项，且不单独判「高」 */
  var OUTPUT_CORE_KEYS = ['share', 'eff', 'conv', 'contrib'];

  function profileOf(className) {
    var name = String(className || '');
    if (name.indexOf('观众') >= 0) return 'heal';
    if (name.indexOf('战士') >= 0) return 'tank';
    return 'output';
  }

  /* ---------------- 三档预设：倍数叠加在原始阈值上，不改动原始值 ---------------- */
  var PRESETS = {
    loose: { label: '宽松', lowMul: 0.8, highMul: 1.2, barMul: 0.9, bandMul: 1.15 },
    standard: { label: '标准', lowMul: 1, highMul: 1, barMul: 1, bandMul: 1 },
    strict: { label: '严格', lowMul: 1.2, highMul: 0.85, barMul: 1.1, bandMul: 0.9 }
  };
  var LOW_KEYS = ['shareLow', 'effLow', 'convLow', 'healLow', 'healEffLow', 'assistLow', 'takenLow'];
  var HIGH_KEYS = ['takenHigh', 'takenRatioHigh', 'deathHigh'];
  var BAR_KEYS = ['contribQ1'];
  var BAND_KEYS = ['scoreLow', 'scoreMid', 'scoreHigh'];

  function round3(n) { return Math.round(Number(n) * 1000) / 1000; }

  function applyPreset(raw) {
    var out = U.clone(raw || {});
    var preset = PRESETS[out.profilePreset] || PRESETS.standard;
    LOW_KEYS.forEach(function (k) { out[k] = round3(Number(raw[k]) * preset.lowMul); });
    HIGH_KEYS.forEach(function (k) { out[k] = round3(Number(raw[k]) * preset.highMul); });
    BAR_KEYS.forEach(function (k) { out[k] = round3(Number(raw[k]) * preset.barMul); });
    BAND_KEYS.forEach(function (k) { out[k] = round3(Number(raw[k]) * preset.bandMul); });
    out.profilePreset = raw.profilePreset;
    return out;
  }

  function presetOf(raw) {
    return PRESETS[(raw && raw.profilePreset) || 'standard'] || PRESETS.standard;
  }

  function presetSummary() {
    var eff = state.effective || state.settings;
    var preset = presetOf(state.settings);
    return '当前：' + preset.label + '（治疗量低于同职业中位 ' + pct(eff.healLow) +
      ' 才提示；承伤高于中位 ' + eff.takenHigh.toFixed(2) + ' 倍才提示；综合异常分 ≥ ' +
      eff.scoreLow.toFixed(2) + ' 计入疑点）';
  }

  function effSettings() { return state.effective || state.settings; }

  var state = {
    buffer: null,
    fileName: '',
    fileSize: 0,
    sheetNames: [],
    sheetName: '',
    headers: [],
    rows: [],
    mapping: {},
    players: [],
    groups: [],
    overall: null,
    issues: [],
    settings: {},
    effective: null,
    advancedOpen: false,
    activeTab: 'import',
    highlightIndex: null,
    search: '',
    issueBand: 'all',
    issueMinScore: 0,
    importedAt: null
  };

  var els = {};

  function q(sel, root) { return (root || document).querySelector(sel); }
  function qa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) { return U.esc(s); }

  function readStore(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (err) {
      return fallback;
    }
  }

  function writeStore(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      return false;
    }
  }

  /* ============================ 数值工具 ============================ */

  /* 0 = 真实 0；空白 / — / - / N/A = null（该职业不做这项指标） */
  function num(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v).trim();
    if (!s) return null;
    if (s === '-' || s === '—' || s === '--' || s === 'N/A' || s === 'n/a' || s === 'NA' || s === '不适用') return null;
    var n = Number(s.replace(/,/g, ''));
    return isFinite(n) ? n : null;
  }

  function numAt(row, idx) {
    if (idx == null || idx < 0) return null;
    return num(row[idx]);
  }

  function cellStr(v) {
    if (v == null) return '';
    return String(v).trim();
  }

  function clamp01(n) {
    if (!isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
  }

  function fmtNum(n) {
    if (n == null || !isFinite(n)) return '—';
    var abs = Math.abs(n);
    if (abs >= 1000) return n.toFixed(0);
    if (abs >= 10) return n.toFixed(1);
    return Number(n.toFixed(2)).toString();
  }

  function pct(r) {
    if (r == null || !isFinite(r)) return '—';
    return (r * 100).toFixed(r < 0.1 ? 1 : 0) + '%';
  }

  function median(list) {
    var arr = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] != null && isFinite(list[i])) arr.push(list[i]);
    }
    if (!arr.length) return null;
    arr.sort(function (a, b) { return a - b; });
    var mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }

  /* 线性插值分位：q=0.25 下四分位、q=0.75 上四分位 */
  function quantile(list, q) {
    var arr = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] != null && isFinite(list[i])) arr.push(list[i]);
    }
    if (!arr.length) return null;
    arr.sort(function (a, b) { return a - b; });
    if (arr.length === 1) return arr[0];
    var pos = (arr.length - 1) * q;
    var lo = Math.floor(pos);
    var hi = Math.ceil(pos);
    return arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
  }

  function valuesOf(list, key) {
    var out = [];
    list.forEach(function (p) {
      if (p[key] != null && isFinite(p[key])) out.push(p[key]);
    });
    return out;
  }

  function sumOf(list) {
    var s = 0;
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i] != null && isFinite(list[i])) { s += list[i]; n++; }
    }
    return { sum: s, n: n, value: n ? s : null };
  }

  /* ============================ 职业 ============================ */

  function classByName(name) {
    var list = (window.GM_DATA && window.GM_DATA.classes) || [];
    var target = String(name || '').trim();
    if (!target) return null;
    for (var i = 0; i < list.length; i++) if (list[i].name === target) return list[i];
    for (var j = 0; j < list.length; j++) {
      if (target.indexOf(list[j].name) >= 0 || list[j].name.indexOf(target) >= 0) return list[j];
    }
    return null;
  }

  function classNameOf(classId) {
    var cls = U.classById(classId);
    return cls ? cls.name : '';
  }

  /* ============================ 列映射 ============================ */

  function normHeader(s) {
    return String(s || '').toLowerCase().replace(/[\s_\-·:：/()（）]/g, '');
  }

  function autoDetectField(field, headers) {
    var exact = -1;
    var loose = -1;
    for (var i = 0; i < headers.length; i++) {
      var h = normHeader(headers[i]);
      for (var a = 0; a < field.aliases.length; a++) {
        var alias = normHeader(field.aliases[a]);
        if (!alias) continue;
        if (h === alias && exact < 0) exact = i;
        if (h.indexOf(alias) >= 0 && loose < 0) loose = i;
      }
    }
    var idx = exact >= 0 ? exact : loose;
    return idx >= 0 ? headers[idx] : '';
  }

  function resolveMapping(headers) {
    var saved = readStore(MAP_KEY, {});
    var savedFields = (saved && saved.fields) || {};
    var map = {};
    FIELDS.forEach(function (f) {
      var h = savedFields[f.key];
      if (h && headers.indexOf(h) >= 0) map[f.key] = h;
      else map[f.key] = autoDetectField(f, headers);
    });
    if (!map.player) map.player = headers[0] || '';
    return map;
  }

  function persistMapping() {
    var fields = {};
    FIELDS.forEach(function (f) {
      if (state.mapping[f.key]) fields[f.key] = state.mapping[f.key];
    });
    writeStore(MAP_KEY, { fields: fields, headers: state.headers.slice(), updatedAt: new Date().toISOString() });
  }

  function colOf(key) {
    var h = state.mapping[key];
    return h ? state.headers.indexOf(h) : -1;
  }

  /* ============================ 分析计算 ============================ */

  function buildPlayers() {
    var idx = {};
    FIELDS.forEach(function (f) { idx[f.key] = colOf(f.key); });
    var players = [];

    for (var i = 0; i < state.rows.length; i++) {
      var row = state.rows[i] || [];
      var name = cellStr(row[idx.player]);
      if (!name) continue;

      var cls = classByName(cellStr(row[idx.class]));
      var className = cls ? cls.name : (cellStr(row[idx.class]) || '未知');

      var wins = numAt(row, idx.win);
      var assists = numAt(row, idx.assist);
      var damage = numAt(row, idx.damage);
      var taken = numAt(row, idx.taken);
      var heal = numAt(row, idx.heal);
      var deaths = numAt(row, idx.death);

      var ka = (wins != null && assists != null) ? wins + assists : null;
      var ratio = (damage != null && taken != null && taken > 0) ? damage / taken : null;
      var outEff = (damage != null && ka != null && ka > 0) ? damage / ka : null;
      var takenEff = (taken != null && ka != null && ka > 0) ? taken / ka : null;
      var takenRatio = (taken != null && damage != null && damage > 0) ? taken / damage : null;
      var killConv = (wins != null && ka != null && ka > 0) ? wins / ka : (ka === 0 ? 0 : null);
      var healEff = (heal != null && ka != null && ka > 0) ? heal / ka : null;
      var profile = profileOf(className);

      players.push({
        rowIndex: i,
        name: name,
        className: className,
        classId: cls ? cls.id : '',
        color: cls ? cls.color : '#8a919f',
        profile: profile,
        profileLabel: PROFILE_LABELS[profile],
        wins: wins,
        assists: assists,
        ka: ka,
        damage: damage,
        taken: taken,
        heal: heal,
        deaths: deaths,
        ratio: ratio,
        outEff: outEff,
        takenEff: takenEff,
        takenRatio: takenRatio,
        killConv: killConv,
        healEff: healEff,
        groupKey: className,
        group: null,
        match: null,
        dims: [],
        composite: null,
        band: '',
        smallGroup: false,
        exemptText: '',
        downgradeText: ''
      });
    }

    return players;
  }

  function buildGroups(players) {
    var bucket = {};
    players.forEach(function (p) {
      if (!bucket[p.groupKey]) bucket[p.groupKey] = [];
      bucket[p.groupKey].push(p);
    });

    var groups = Object.keys(bucket).map(function (key) {
      var list = bucket[key];
      var g = {
        key: key,
        className: list[0].className,
        color: list[0].color,
        count: list.length,
        players: list,
        medians: {},
        q1: {},
        q3: {},
        denoms: {},
        totals: {}
      };
      METRICS.concat(DERIVED).forEach(function (m) {
        var values = valuesOf(list, m);
        g.medians[m] = median(values);
        g.q1[m] = quantile(values, 0.25);
        g.q3[m] = quantile(values, 0.75);
        g.denoms[m] = values.length;
      });
      METRICS.forEach(function (m) {
        g.totals[m] = sumOf(list.map(function (p) { return p[m]; }));
      });
      list.forEach(function (p) { p.group = g; });
      return g;
    });

    groups.sort(function (a, b) { return b.count - a.count; });
    return groups;
  }

  /* --------- 编成匹配 --------- */

  function walkRoster(node, path, bucket, source, label) {
    if (!node) return;
    var next = path.concat([node.name || '']);
    if (node.kind === 'squad') {
      (node.members || []).forEach(function (m) {
        var key = cellStr(m.name);
        if (!key || bucket[key]) return;
        bucket[key] = {
          alliance: path[0] || '',
          team: path[1] || '',
          squad: node.name || '',
          className: classNameOf(m.classId),
          source: source,
          label: label
        };
      });
      return;
    }
    (node.children || []).forEach(function (c) { walkRoster(c, next, bucket, source, label); });
  }

  function buildRosterIndex() {
    var live = {};
    var presets = {};
    var project = GM.state && GM.state.project;
    if (!project) return { live: live, presets: presets };
    (project.teams || []).forEach(function (n) { walkRoster(n, [], live, 'live', '当前编成'); });
    (project.presets || []).forEach(function (pr) { walkRoster(pr.node, [], presets, 'preset', '预设「' + (pr.name || '') + '」'); });
    return { live: live, presets: presets };
  }

  function attachRoster(players) {
    var roster = buildRosterIndex();
    var matchedLive = 0;
    var matchedPreset = 0;
    players.forEach(function (p) {
      var hit = roster.live[cellStr(p.name)] || roster.presets[cellStr(p.name)] || null;
      if (!hit) return;
      p.match = hit;
      if (hit.source === 'live') matchedLive++;
      else matchedPreset++;
    });
    return { matchedLive: matchedLive, matchedPreset: matchedPreset };
  }

  /* --------- 多维度归一化 --------- */

  function bandOf(score, S) {
    if (score == null || !isFinite(score)) return '';
    if (score >= S.scoreHigh) return '高';
    if (score >= S.scoreMid) return '中';
    if (score >= S.scoreLow) return '低';
    return '';
  }

  function bandLevel(band) {
    return band === '高' ? 3 : (band === '中' ? 2 : (band === '低' ? 1 : 0));
  }

  function dimWeight(S, key, profile) {
    var def = null;
    DIMENSIONS.forEach(function (d) { if (d.key === key) def = d; });
    if (!def) return 0;
    var base = S[def.weightKey] || 0;
    var factor = (PROFILE_WEIGHT[profile] || {})[key];
    return base * (factor == null ? 1 : factor);
  }

  function makeDimObj(def, profile, S) {
    return {
      key: def.key,
      label: def.label,
      applicable: true,
      naText: '',
      actual: null,
      ref: null,
      ratio: null,
      anomaly: 0,
      weight: dimWeight(S, def.key, profile),
      triggered: false,
      exempt: false,
      hint: false,
      text: ''
    };
  }

  function dimAvailable(p, key) {
    if (key === 'share') return p.damage != null;
    if (key === 'eff') return p.damage != null && p.ka != null;
    if (key === 'taken') return p.taken != null;
    if (key === 'conv' || key === 'contrib') return p.ka != null;
    if (key === 'heal') return p.heal != null;
    if (key === 'death') return p.deaths != null;
    if (key === 'assist') return p.assists != null;
    return false;
  }

  /* 口径是否允许该维度：治疗口径只有在伤害列确有输出时才附加评估输出类维度 */
  function profileAllows(p, key) {
    var allow = (PROFILE_ALLOW[p.profile] || {})[key];
    if (!allow) return false;
    if (p.profile === 'heal' && OUTPUT_CORE_KEYS.indexOf(key) >= 0) {
      return p.damage != null && p.damage > 0;
    }
    return true;
  }

  function naTextOf(p, key) {
    var allow = (PROFILE_ALLOW[p.profile] || {})[key];
    if (!allow) return PROFILE_LABELS[p.profile] + '不评这项指标';
    if (p.profile === 'heal' && OUTPUT_CORE_KEYS.indexOf(key) >= 0 && !(p.damage != null && p.damage > 0)) {
      return '伤害列无输出，治疗口径不评这项';
    }
    if (key === 'death') return '未映射死亡列';
    if (key === 'heal') return '本场无治疗数据';
    if (key === 'taken') return '本场无承伤数据';
    if (key === 'assist') return '本场无助攻数据';
    if (key === 'share') return '本场无伤害数据';
    return '本场缺少击败 / 助攻数据';
  }

  function computeDim(p, g, S, def) {
    var med = g.medians;
    var d = makeDimObj(def, p.profile, S);
    var key = def.key;

    if (key === 'share') {
      d.actual = p.damage;
      d.ref = med.damage;
      if (med.damage == null || med.damage <= 0) { d.text = '同职业无有效伤害中位数，未比较'; return d; }
      var rs = p.damage / med.damage;
      d.ratio = rs;
      d.anomaly = clamp01((S.shareLow - rs) / S.shareLow);
      d.text = '伤害 ' + fmtNum(p.damage) + '，同职业中位 ' + fmtNum(med.damage) + '（' + pct(rs) + '）';
      return d;
    }

    if (key === 'eff') {
      d.actual = p.outEff;
      d.ref = med.outEff;
      if (med.outEff == null || med.outEff <= 0) { d.text = '同职业无有效输出效率中位数，未比较'; return d; }
      var re = p.outEff / med.outEff;
      d.ratio = re;
      d.anomaly = clamp01((S.effLow - re) / S.effLow);
      d.text = '输出效率 ' + fmtNum(p.outEff) + '，同职业中位 ' + fmtNum(med.outEff) + '（' + pct(re) + '）';
      return d;
    }

    if (key === 'taken') {
      d.actual = p.taken;
      d.ref = med.taken;
      if (med.taken == null || med.taken <= 0) { d.text = '同职业无有效承伤中位数，未比较'; return d; }
      var rt = p.taken / med.taken;
      d.ratio = rt;
      var atHigh = clamp01(rt / S.takenHigh - 1);
      var txt = '承伤 ' + fmtNum(p.taken) + '，同职业中位 ' + fmtNum(med.taken) + '（' + pct(rt) + '）';
      if (p.profile === 'tank') {
        var atLow = S.takenLow > 0 ? clamp01((S.takenLow - rt) / S.takenLow) : 0;
        d.anomaly = Math.max(atHigh, atLow);
        if (atLow > atHigh) {
          txt += ' · 偏低：低于中位 ' + pct(S.takenLow) + ' 线，可能没进场 / 没吃到伤害';
        } else if (atHigh > 0) {
          txt += ' · 偏高：超过中位 ' + S.takenHigh.toFixed(2) + ' 倍，可能被集火 / 站位问题';
        }
        d.text = txt;
        return d;
      }
      if (p.profile === 'heal') {
        d.anomaly = atHigh;
        d.hint = true;
        if (atHigh > 0) txt += ' · 偏高（仅作生存风险提示，不判高）';
        d.text = txt;
        return d;
      }
      var extra = '';
      if (p.damage != null && med.takenRatio != null && med.takenRatio > 0) {
        var rr = p.damage > 0 ? (p.taken / p.damage) / med.takenRatio : Infinity;
        var ar = p.damage > 0 ? clamp01(rr / S.takenRatioHigh - 1) : 1;
        if (ar > atHigh) atHigh = ar;
        extra = '；承伤/伤害 ' + (p.takenRatio == null ? '—' : p.takenRatio.toFixed(2)) +
          '（同职业中位 ' + med.takenRatio.toFixed(2) + '，' +
          (isFinite(rr) ? pct(rr) + '）' : '伤害为 0，比值无界）');
      }
      d.anomaly = atHigh;
      d.text = txt + extra;
      return d;
    }

    if (key === 'conv') {
      var conv = p.ka > 0 ? (p.wins || 0) / p.ka : 0;
      d.actual = conv;
      d.ref = S.convLow;
      d.ratio = S.convLow > 0 ? conv / S.convLow : null;
      d.anomaly = clamp01((S.convLow - conv) / S.convLow);
      d.text = '击杀转化 ' + pct(conv) + '（击败 ' + fmtNum(p.wins) + ' / 参与 ' + fmtNum(p.ka) +
        '，底线 ' + pct(S.convLow) + '）';
      return d;
    }

    if (key === 'contrib') {
      d.actual = p.ka;
      d.ref = g.q1.ka;
      if (g.q1.ka == null || g.q1.ka <= 0) { d.text = '同职业无有效下四分位，未比较'; return d; }
      var bar = g.q1.ka * S.contribQ1;
      d.ratio = bar > 0 ? p.ka / bar : null;
      d.anomaly = clamp01((bar - p.ka) / bar);
      d.text = '击败+助攻 ' + fmtNum(p.ka) + '，同职业下四分位 ' + fmtNum(g.q1.ka) +
        '（贡献线 ' + fmtNum(bar) + '）';
      return d;
    }

    if (key === 'heal') {
      d.actual = p.heal;
      d.ref = med.heal;
      if (med.heal == null || med.heal <= 0) { d.text = '同职业无有效治疗中位数，未比较'; return d; }
      var rh = p.heal / med.heal;
      d.ratio = rh;
      d.anomaly = clamp01((S.healLow - rh) / S.healLow);
      var htxt = '治疗 ' + fmtNum(p.heal) + '，同职业中位 ' + fmtNum(med.heal) + '（' + pct(rh) + '）';
      if (p.healEff != null && med.healEff != null && med.healEff > 0) {
        var rhe = p.healEff / med.healEff;
        var ahe = clamp01((S.healEffLow - rhe) / S.healEffLow);
        if (ahe > d.anomaly) d.anomaly = ahe;
        htxt += '；治疗效率 ' + fmtNum(p.healEff) + '，同职业中位 ' + fmtNum(med.healEff) + '（' + pct(rhe) + '）';
      }
      d.text = htxt;
      return d;
    }

    if (key === 'death') {
      d.actual = p.deaths;
      d.ref = med.deaths;
      if (med.deaths == null || med.deaths <= 0) { d.text = '同职业死亡中位为 0，未比较'; return d; }
      var rd = p.deaths / med.deaths;
      d.ratio = rd;
      d.anomaly = clamp01(rd / S.deathHigh - 1);
      d.text = '死亡 ' + fmtNum(p.deaths) + '，同职业中位 ' + fmtNum(med.deaths) + '（' + pct(rd) + '）';
      return d;
    }

    if (key === 'assist') {
      var ashare = p.ka != null && p.ka > 0 ? (p.assists || 0) / p.ka : 0;
      d.actual = p.assists;
      d.ref = S.assistLow;
      d.ratio = S.assistLow > 0 ? ashare / S.assistLow : null;
      d.anomaly = S.assistLow > 0 ? clamp01((S.assistLow - ashare) / S.assistLow) : 0;
      d.text = '助攻 ' + fmtNum(p.assists) + '（占击败+助攻 ' + pct(ashare) + '，底线 ' +
        pct(S.assistLow) + '）';
      return d;
    }

    return d;
  }

  /* 每个口径都返回全部维度：不适用的标 applicable:false 并给出原因，不参与打分 */
  function evalDimensions(p, g, S) {
    var dims = [];
    DIMENSIONS.forEach(function (def) {
      if (!profileAllows(p, def.key) || !dimAvailable(p, def.key)) {
        dims.push({
          key: def.key,
          label: def.label,
          applicable: false,
          naText: naTextOf(p, def.key),
          actual: null,
          ref: null,
          ratio: null,
          anomaly: 0,
          weight: 0,
          triggered: false,
          exempt: false,
          hint: false,
          text: ''
        });
        return;
      }
      dims.push(computeDim(p, g, S, def));
    });

    if (p.smallGroup) {
      dims.forEach(function (d) {
        if (!d.applicable) return;
        d.anomaly = 0;
        d.text = (d.text ? d.text + ' · ' : '') + '同职业人数不足，未比较';
      });
    }
    dims.forEach(function (d) { d.triggered = d.applicable && d.anomaly > 0; });
    return dims;
  }

  /* 反向豁免：低输出但低承伤且高击杀转化，按控场/游走不判低输出 */
  function applyExemptions(p, g, S, dims) {
    p.exemptText = '';
    p.downgradeText = '';
    if (!S.exemptionOn) return;

    var med = g.medians;
    if (p.damage != null && med.damage != null && med.damage > 0 &&
        p.damage < med.damage * S.shareLow &&
        p.taken != null && med.taken != null && med.taken > 0 &&
        p.taken <= med.taken * 0.75 &&
        p.killConv != null && p.killConv >= Math.max(S.convLow, med.killConv || 0)) {
      var touched = false;
      dims.forEach(function (d) {
        if (!d.applicable) return;
        if (d.key === 'share' || d.key === 'eff') {
          if (d.triggered) touched = true;
          d.anomaly = 0;
          d.exempt = true;
          d.triggered = false;
        }
      });
      if (touched) {
        p.exemptText = '反向豁免：伤害仅为同职业中位的 ' + pct(p.damage / med.damage) +
          '，但承伤仅为中位的 ' + pct(p.taken / med.taken) +
          '、击杀转化 ' + pct(p.killConv) + '，按控场/游走不判低输出。';
      }
    }
  }

  function compositeOf(dims) {
    var w = 0;
    var s = 0;
    dims.forEach(function (d) {
      if (!d.applicable || d.exempt) return;
      w += d.weight;
      s += d.anomaly * d.weight;
    });
    return w > 0 ? s / w : 0;
  }

  function evaluateAll(players, groups) {
    var S = effSettings();
    players.forEach(function (p) {
      var g = p.group;
      if (!g) {
        p.dims = [];
        p.composite = null;
        p.band = '';
        return;
      }
      p.smallGroup = g.count < S.minGroup;
      p.dims = evalDimensions(p, g, S);
      if (!p.smallGroup) applyExemptions(p, g, S, p.dims);
      p.composite = p.smallGroup ? null : Number(compositeOf(p.dims).toFixed(3));
      p.band = p.smallGroup ? '' : bandOf(p.composite, S);
    });
  }

  /* --------- 疑点规则 --------- */

  function makeIssue(p, code, title, reason, detail, score, dims, bandOverride) {
    var S = effSettings();
    var band = bandOverride || bandOf(score, S) || '低';
    return {
      code: code,
      title: title,
      reason: reason || '',
      detail: detail,
      playerName: p.name,
      className: p.className,
      groupKey: p.groupKey,
      profile: p.profile,
      profileLabel: p.profileLabel,
      rowIndex: p.rowIndex,
      score: Number(score.toFixed(3)),
      band: band,
      level: bandLevel(band),
      dims: dims || [],
      exemptText: p.exemptText || '',
      downgradeText: p.downgradeText || ''
    };
  }

  function zeroIssue(p, S) {
    if (!S.zeroRulesOn) return null;

    /* 治疗口径不跑零值规则：观众伤害 0、击败 / 助攻 0 都属于正常 */
    if (p.profile === 'heal') return null;

    /* 坦克口径只关心「承伤 0」：可能没进场 / 没吃到伤害 */
    if (p.profile === 'tank') {
      if (S.tankTakenZeroOn && p.taken === 0) {
        return makeIssue(p, 'tank-taken-zero', '坦克承伤为 0',
          '承伤 = 0，与坦克职责不符',
          '坦克口径下承伤为 0，说明可能整场没进场、没吃到伤害，或数据口径有误；建议核对站位与参战情况。',
          0.42, (p.dims || []).slice(), '中');
      }
      return null;
    }

    /* 输出口径：原有零值三规则 */
    if (p.damage === 0 && p.heal != null && p.heal > 0) return null;

    if (S.zeroIdleOn && p.damage === 0 && p.taken === 0 && p.ka === 0) {
      return makeIssue(p, 'zero-idle', '疑似未参战', '伤害 / 承伤 / 击败+助攻 三项均为 0',
        '伤害 = 0、承伤 = 0、击败+助攻 = 0，三项均为表格里的真实 0；建议核对是否漏打或整场未参战。',
        0.55, (p.dims || []).slice(), '高');
    }
    if (S.zeroSuppressedOn && p.damage === 0 && p.taken != null && p.taken > 0) {
      var medTaken = p.group ? p.group.medians.taken : null;
      if (medTaken == null || p.taken >= medTaken * S.zeroTakenRatio) {
        return makeIssue(p, 'zero-suppressed', '被压制 / 无输出',
          '伤害 = 0，但承伤 ' + fmtNum(p.taken),
          '伤害 = 0 但承伤 ' + fmtNum(p.taken) + '（达到同职业中位的 ' +
          (medTaken ? pct(p.taken / medTaken) : '—') + '），符合“被压制/无输出”的零值规则。',
          0.72, (p.dims || []).slice(), '高');
      }
    }
    if (S.zeroKillOn && p.damage === 0 && p.ka != null && p.ka > 0) {
      return makeIssue(p, 'zero-kill', '零输出但参与击杀',
        '伤害 = 0，击败+助攻 = ' + fmtNum(p.ka),
        '伤害 = 0，但击败+助攻 = ' + fmtNum(p.ka) + '；可能是数据口径问题，也可能是纯功能位。',
        0.42, (p.dims || []).slice(), '中');
    }
    return null;
  }

  /* 取异常度×权重最高的一条作「主因」 */
  function pickPrimary(triggered) {
    var best = null;
    triggered.forEach(function (d) {
      if (!best) { best = d; return; }
      if (d.anomaly * d.weight > best.anomaly * best.weight) best = d;
    });
    return best;
  }

  /* 治疗口径：附加的输出维度不单独判「高」；承伤提示也不判「高」 */
  function capBand(p, triggered, band) {
    var lv = bandLevel(band);
    if (!lv) return band;
    if (p.profile === 'heal') {
      var onlyOutput = triggered.every(function (d) { return OUTPUT_CORE_KEYS.indexOf(d.key) >= 0; });
      var onlyHint = triggered.every(function (d) { return d.hint; });
      if (onlyOutput || onlyHint) lv = Math.min(lv, 2);
    }
    return lv === 3 ? '高' : (lv === 2 ? '中' : '低');
  }

  function computeIssues(players) {
    var S = effSettings();
    var issues = [];

    players.forEach(function (p) {
      var zero = zeroIssue(p, S);
      if (zero) {
        issues.push(zero);
        p.band = zero.band;
        if (p.composite == null || zero.score > p.composite) p.composite = zero.score;
        return;
      }
      if (!p.band || !p.dims.length) return;

      var triggered = p.dims.filter(function (d) {
        return d.applicable && d.triggered && !d.exempt;
      });
      if (!triggered.length) return;

      /* 观众治疗偏低但击败助攻极高：在这条口径下本来就少打伤害，降一级 */
      var band = p.band;
      if (S.exemptionOn && p.profile === 'heal' && p.heal != null &&
          triggered.some(function (d) { return d.key === 'heal'; }) &&
          p.ka != null && p.group.medians.ka != null && p.ka >= p.group.medians.ka * 1.5) {
        p.downgradeText = '降级：治疗偏低但击败+助攻 ' + fmtNum(p.ka) + ' 为同职业中位的 ' +
          pct(p.ka / p.group.medians.ka) + '，按高参与功能位降一级。';
        if (band === '高') band = '中';
        else if (band === '中') band = '低';
        else if (band === '低') band = '';
      }
      band = capBand(p, triggered, band);
      p.band = band;
      if (!band) return;

      var primary = pickPrimary(triggered);
      var parts = triggered.map(function (d) {
        return d.label + '（异常 ' + d.anomaly.toFixed(2) + '，权重 ' + d.weight.toFixed(2) + '）';
      });
      var applicable = p.dims.filter(function (d) { return d.applicable; }).length;
      var detail = '触发 ' + triggered.length + ' / 适用 ' + applicable + ' 个维度：' + parts.join('、') +
        '；综合异常分 ' + p.composite.toFixed(2) + '，判「' + band + '」。';
      issues.push(makeIssue(p, 'multi', primary ? primary.label + '异常' : '多维异常',
        primary ? primary.text : '', detail, p.composite, p.dims.slice(), band));
    });

    issues.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.rowIndex - b.rowIndex;
    });
    return issues;
  }

  /* --------- 整体分析 --------- */

  function buildOverall(players, groups, matchInfo) {
    var totals = {};
    var counts = {};
    METRICS.forEach(function (m) {
      var s = sumOf(players.map(function (p) { return p[m]; }));
      totals[m] = s.value;
      counts[m] = s.n;
    });

    var overallMed = {};
    METRICS.concat(DERIVED).forEach(function (m) {
      overallMed[m] = median(players.map(function (p) { return p[m]; }));
    });

    var classBucket = {};
    players.forEach(function (p) {
      classBucket[p.className] = (classBucket[p.className] || 0) + 1;
    });

    var classStats = groups.map(function (g) {
      var bands = { '高': 0, '中': 0, '低': 0 };
      var scoreSum = 0;
      var scoreN = 0;
      g.players.forEach(function (p) {
        if (p.band && bands[p.band] != null) bands[p.band]++;
        if (p.composite != null) { scoreSum += p.composite; scoreN++; }
      });
      var c = {
        name: g.className,
        color: g.color,
        count: g.count,
        medians: g.medians,
        q1: g.q1,
        q3: g.q3,
        denoms: g.denoms,
        bands: bands,
        avgScore: scoreN ? scoreSum / scoreN : null,
        damageRel: (g.medians.damage != null && overallMed.damage) ? g.medians.damage / overallMed.damage : null,
        takenRel: (g.medians.taken != null && overallMed.taken) ? g.medians.taken / overallMed.taken : null,
        healRel: (g.medians.heal != null && overallMed.heal) ? g.medians.heal / overallMed.heal : null,
        flags: []
      };
      if (c.damageRel != null && c.damageRel < 0.75) c.flags.push('输出整体偏低（全场中位 ' + pct(c.damageRel) + '）');
      if (c.takenRel != null && c.takenRel > 1.3) c.flags.push('承伤整体偏高（全场中位 ' + pct(c.takenRel) + '）');
      if (c.healRel != null && c.healRel < 0.8) c.flags.push('治疗整体偏低（全场中位 ' + pct(c.healRel) + '）');
      if (bands['高'] >= 2) c.flags.push('高档疑点 ' + bands['高'] + ' 人');
      return c;
    }).sort(function (a, b) {
      if (b.avgScore !== a.avgScore) return (b.avgScore || 0) - (a.avgScore || 0);
      return b.count - a.count;
    });

    var squads = {};
    players.forEach(function (p) {
      if (!p.match) return;
      var m = p.match;
      var key = (m.source === 'live' ? 'live|' : 'preset|') + m.alliance + '/' + m.team + '/' + m.squad;
      var entry = squads[key];
      if (!entry) {
        entry = squads[key] = {
          key: key,
          source: m.source,
          label: m.source === 'live'
            ? [m.alliance, m.team, m.squad].filter(Boolean).join(' / ')
            : m.label + ' / ' + [m.alliance, m.team, m.squad].filter(Boolean).join(' / '),
          count: 0,
          sums: {},
          scoreSum: 0,
          scoreN: 0,
          bands: { '高': 0, '中': 0, '低': 0 }
        };
        ['damage', 'taken', 'heal', 'ka'].forEach(function (k) { entry.sums[k] = { sum: 0, n: 0 }; });
      }
      entry.count++;
      ['damage', 'taken', 'heal', 'ka'].forEach(function (k) {
        if (p[k] != null) { entry.sums[k].sum += p[k]; entry.sums[k].n++; }
      });
      if (p.composite != null) { entry.scoreSum += p.composite; entry.scoreN++; }
      if (p.band && entry.bands[p.band] != null) entry.bands[p.band]++;
    });

    var squadList = Object.keys(squads).map(function (key) {
      var e = squads[key];
      var out = { key: key, source: e.source, label: e.label, count: e.count, metrics: {}, bands: e.bands };
      ['damage', 'taken', 'heal', 'ka'].forEach(function (k) {
        out.metrics[k] = e.sums[k].n ? e.sums[k].sum : null;
      });
      out.takenShare = (out.metrics.taken != null && totals.taken) ? out.metrics.taken / totals.taken : null;
      out.playerShare = players.length ? e.count / players.length : null;
      out.avgScore = e.scoreN ? e.scoreSum / e.scoreN : null;
      return out;
    }).sort(function (a, b) { return b.count - a.count; });

    var notes = [];
    if (!matchInfo.matchedLive && !matchInfo.matchedPreset) {
      notes.push({ level: 'warn', text: '未匹配到编成：表格里的玩家名与当前实时编成、预设快照都没对上，无法标注所属小队，也无法做小队对比。' });
    } else {
      notes.push({
        level: 'ok',
        text: '已匹配 ' + (matchInfo.matchedLive + matchInfo.matchedPreset) + ' / ' + players.length +
          ' 名玩家（当前编成 ' + matchInfo.matchedLive + ' 名，预设 ' + matchInfo.matchedPreset + ' 名）。'
      });
    }

    var idle = players.filter(function (p) {
      return p.profile === 'output' && p.damage === 0 && p.taken === 0 && p.ka === 0;
    });
    if (idle.length) {
      notes.push({ level: 'warn', text: '有 ' + idle.length + ' 人伤害、承伤、击败+助攻三项均为 0（疑似未参战）：' +
        idle.slice(0, 5).map(function (p) { return p.name; }).join('、') + (idle.length > 5 ? ' 等' : '') + '。' });
    }

    var zeros = players.filter(function (p) {
      return p.profile === 'output' && p.damage === 0 && p.ka != null && p.ka > 0;
    });
    if (zeros.length) {
      notes.push({ level: 'warn', text: '有 ' + zeros.length + ' 人伤害为 0 但仍有击败/助攻：' +
        zeros.slice(0, 5).map(function (p) { return p.name; }).join('、') + (zeros.length > 5 ? ' 等' : '') + '。' });
    }

    squadList.forEach(function (s) {
      if (s.takenShare != null && s.playerShare != null && s.takenShare > s.playerShare * 1.8 && s.takenShare >= 0.2) {
        notes.push({
          level: 'warn',
          text: '小队「' + s.label + '」承伤占全场 ' + pct(s.takenShare) + '，但人数只占 ' + pct(s.playerShare) +
            '（约为人数占比的 ' + (s.takenShare / s.playerShare).toFixed(1) + ' 倍），承伤分布异常。'
        });
      }
    });

    var flagged = classStats.filter(function (c) { return c.flags.length; });
    if (flagged.length) {
      notes.push({ level: 'info', text: '职业整体分布：' + flagged.map(function (c) {
        return c.name + '（' + c.flags.join('；') + '）';
      }).join('；') + '。' });
    }

    var minGroup = effSettings().minGroup;
    var small = groups.filter(function (g) { return g.count < minGroup; });
    if (small.length) {
      notes.push({ level: 'info', text: small.length + ' 个职业人数少于 ' + minGroup +
        ' 人，未做中位数/分位判定：' + small.map(function (g) { return g.key + '(' + g.count + ')'; }).join('、') + '。' });
    }

    var profileCounts = { output: 0, heal: 0, tank: 0 };
    players.forEach(function (p) { if (profileCounts[p.profile] != null) profileCounts[p.profile]++; });

    return {
      playerCount: players.length,
      totals: totals,
      counts: counts,
      overallMedians: overallMed,
      profileCounts: profileCounts,
      profileLabels: PROFILE_LABELS,
      classes: Object.keys(classBucket).map(function (k) {
        var cls = classByName(k);
        return { name: k, count: classBucket[k], color: cls ? cls.color : '#8a919f' };
      }),
      classStats: classStats,
      squads: squadList,
      notes: notes,
      matchInfo: matchInfo,
      issueCounts: issuesBandCounts(state.issues),
      unmatched: players.filter(function (p) { return !p.match; }).length
    };
  }

  function issuesBandCounts(list) {
    var c = { '高': 0, '中': 0, '低': 0 };
    list.forEach(function (i) { if (c[i.band] != null) c[i.band]++; });
    return c;
  }

  function computeAll() {
    state.effective = applyPreset(state.settings);
    if (!state.headers.length) {
      state.players = [];
      state.groups = [];
      state.issues = [];
      state.overall = null;
      return;
    }
    state.players = buildPlayers();
    state.groups = buildGroups(state.players);
    var matchInfo = attachRoster(state.players);
    evaluateAll(state.players, state.groups);
    state.issues = computeIssues(state.players);
    state.overall = buildOverall(state.players, state.groups, matchInfo);
  }

  /* ============================ 渲染 ============================ */

  function setStatus(text, type) {
    var el = q('#analysisStatus') || els.status;
    if (!el) return;
    el.textContent = text || '';
    el.className = 'analysis-status ' + (type || '');
  }

  function renderHeader() {
    if (!els.scopeTag) return;
    if (!state.importedAt) {
      els.scopeTag.textContent = '未导入';
      return;
    }
    els.scopeTag.textContent = state.sheetName + ' · ' + state.players.length + ' 人 · 疑点 ' + state.issues.length;
  }

  function renderImport() {
    if (!els.importPanel) return;

    var sheetRow = '';
    if (state.sheetNames.length > 1) {
      sheetRow = '<div class="an-sheet-row"><label>工作表</label><select id="analysisSheet">' +
        state.sheetNames.map(function (n) {
          return '<option value="' + esc(n) + '"' + (n === state.sheetName ? ' selected' : '') + '>' + esc(n) + '</option>';
        }).join('') + '</select><span class="an-hint">选择会记住，下次自动套用</span></div>';
    }

    var preview = '';
    if (state.headers.length) {
      var cols = state.headers.slice(0, 8);
      preview = '<div class="an-preview-wrap"><div class="an-preview-title">数据预览 · 前 3 行（原始值）</div>' +
        '<table class="an-table"><thead><tr><th>#</th>' +
        cols.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
        '</tr></thead><tbody>' +
        state.rows.slice(0, 3).map(function (r, i) {
          return '<tr><td class="dim">' + (i + 2) + '</td>' + cols.map(function (h, c) {
            var v = r[c];
            return '<td>' + esc(v == null ? '' : (typeof v === 'number' ? fmtNum(v) : v)) + '</td>';
          }).join('') + '</tr>';
        }).join('') +
        '</tbody></table><div class="an-hint">共 ' + state.rows.length + ' 行数据 × ' + state.headers.length + ' 列；完整列名见「列映射」。</div></div>';
    }

    els.importPanel.innerHTML =
      '<div class="an-import-hero">' +
        '<div class="an-drop" id="analysisDrop">' +
          '<div class="an-drop-title">拖入 .xlsx / .csv，或点击选择文件</div>' +
          '<div class="an-drop-sub">只读解析，不联网、不上传、不改原文件</div>' +
          '<input type="file" id="analysisFile" accept=".xlsx,.csv" hidden>' +
        '</div>' +
        sheetRow +
        '<div class="analysis-status" id="analysisStatus"></div>' +
        (state.fileName ? '<div class="an-file">当前文件：' + esc(state.fileName) + '（' + Math.round((state.fileSize || 0) / 1024) + ' KB）' +
          (state.sheetName ? ' · 工作表：' + esc(state.sheetName) : '') + '</div>' : '') +
      '</div>' + preview;

    var input = q('#analysisFile');
    if (input) input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      if (f) handleFile(f);
      input.value = '';
    });
    var drop = q('#analysisDrop');
    if (drop) {
      drop.addEventListener('click', function () { var i2 = q('#analysisFile'); if (i2) i2.click(); });
      drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('is-over'); });
      drop.addEventListener('dragleave', function () { drop.classList.remove('is-over'); });
      drop.addEventListener('drop', function (e) {
        e.preventDefault();
        drop.classList.remove('is-over');
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) handleFile(f);
      });
    }
    var sheetSel = q('#analysisSheet');
    if (sheetSel) {
      sheetSel.addEventListener('change', function () { loadSheet(sheetSel.value); });
    }
  }

  function renderMapping() {
    if (!els.mappingPanel) return;
    if (!state.headers.length) {
      els.mappingPanel.innerHTML = '<div class="an-empty">还没有导入数据。先到「1 导入」选择 xlsx 或 CSV。</div>';
      return;
    }

    var opts = function (current) {
      var out = '<option value="">（未映射）</option>';
      state.headers.forEach(function (h) {
        out += '<option value="' + esc(h) + '"' + (h === current ? ' selected' : '') + '>' + esc(h) + '</option>';
      });
      return out;
    };

    var rows = FIELDS.map(function (f) {
      var current = state.mapping[f.key] || '';
      return '<div class="map-row' + (f.required ? ' required' : '') + '">' +
        '<div class="map-label">' + esc(f.label) + (f.required ? '<b>必填</b>' : '') + '</div>' +
        '<select data-map-field="' + f.key + '">' + opts(current) + '</select>' +
        '<div class="map-desc">' + esc(f.desc) + '</div>' +
        '</div>';
    }).join('');

    var mapped = FIELDS.filter(function (f) { return state.mapping[f.key]; }).length;
    els.mappingPanel.innerHTML =
      '<div class="an-toolbar">' +
        '<span class="an-chip">已映射 ' + mapped + ' / ' + FIELDS.length + ' 项</span>' +
        '<span class="an-chip">映射按表头名记忆，下次自动套用</span>' +
        '<button type="button" class="btn mini" id="btnMapAuto">重新自动识别</button>' +
        '<button type="button" class="btn mini" id="btnMapClear">全部清空</button>' +
      '</div>' +
      '<div class="map-grid">' + rows + '</div>' +
      '<div class="an-hint">值语义：<b>填 0 = 真实的 0</b>（参与统计、中位数与排名，也可能判疑点）；' +
      '<b>空白 = 该职业不做这项指标</b>（进不了分母、不进中位数、不排秩、不产生任何告警）。' +
      '空字符串、纯空格、<code>—</code>、<code>-</code> 都按空白处理；字符串 "0" 按 0 处理。' +
      '映射结果保存在 localStorage 键 <code>' + MAP_KEY + '</code>。</div>';

    qa('[data-map-field]', els.mappingPanel).forEach(function (sel) {
      sel.addEventListener('change', function () {
        state.mapping[sel.getAttribute('data-map-field')] = sel.value;
        persistMapping();
        refreshAll();
      });
    });

    var autoBtn = q('#btnMapAuto', els.mappingPanel);
    if (autoBtn) autoBtn.addEventListener('click', function () {
      FIELDS.forEach(function (f) {
        var h = autoDetectField(f, state.headers);
        if (h) state.mapping[f.key] = h;
      });
      if (!state.mapping.player) state.mapping.player = state.headers[0] || '';
      persistMapping();
      refreshAll();
      GM.ui.toast('已按表头重新识别列映射', 'success');
    });
    var clearBtn = q('#btnMapClear', els.mappingPanel);
    if (clearBtn) clearBtn.addEventListener('click', function () {
      FIELDS.forEach(function (f) { state.mapping[f.key] = ''; });
      state.mapping.player = state.headers[0] || '';
      persistMapping();
      refreshAll();
    });
  }

  function refreshAll() {
    computeAll();
    renderHeader();
    renderPlayers();
    renderTeam();
    renderIssues();
    renderImport();
  }

  function cellValue(p, key, kind) {
    var v = p[key];
    if (v == null) {
      return '<span class="an-na" title="空白 = 该职业不做这项指标（不适用），不计入分母、不告警">—</span>';
    }
    if (kind === 'pct') return pct(v);
    if (kind === 'ratio') return v.toFixed(2);
    return fmtNum(v);
  }

  function scoreCell(p) {
    if (p.composite == null) return '<span class="an-na">—</span>';
    var band = p.band || '';
    var chip = band ? '<span class="sev sev-' + bandLevel(band) + '">' + band + '</span> ' : '';
    return chip + '<span class="dim">' + p.composite.toFixed(2) + '</span>';
  }

  function renderPlayers() {
    if (!els.playersPanel) return;
    if (!state.players.length) {
      els.playersPanel.innerHTML = '<div class="an-empty">还没有选手数据。先导入并完成列映射（至少需要玩家名）。</div>';
      return;
    }

    var keyword = state.search.trim().toLowerCase();
    var list = state.players.filter(function (p) {
      if (!keyword) return true;
      return p.name.toLowerCase().indexOf(keyword) >= 0 || p.className.toLowerCase().indexOf(keyword) >= 0;
    });

    var head = '<tr><th>#</th><th>玩家</th><th>职业</th><th>口径</th><th>编成匹配</th>' +
      '<th>击败</th><th>助攻</th><th>死亡</th><th>输出</th><th>承伤</th><th>治疗</th>' +
      '<th>输出效率</th><th>承伤效率</th><th>击杀转化</th><th>DP/TD</th><th>异常分 / 分档</th><th>疑点</th></tr>';

    var body = list.map(function (p) {
      var matchCell = p.match
        ? '<span class="an-chip ' + (p.match.source === 'live' ? 'ok' : '') + '">' +
            esc([p.match.alliance, p.match.team, p.match.squad].filter(Boolean).join(' / ') || p.match.label) +
            (p.match.source === 'live' ? ' · 实时' : ' · ' + esc(p.match.label)) + '</span>'
        : '<span class="an-na">未匹配到编成</span>';

      var issueCell = p.band
        ? '<span class="sev sev-' + bandLevel(p.band) + '">' + esc(p.band) + '</span>'
        : (p.smallGroup ? '<span class="an-na" title="同职业人数不足">样本不足</span>' : '<span class="dim">—</span>');

      return '<tr data-player-index="' + p.rowIndex + '"' + (state.highlightIndex === p.rowIndex ? ' class="is-highlight"' : '') + '>' +
        '<td class="dim">' + (p.rowIndex + 2) + '</td>' +
        '<td class="an-name"><span class="an-dot" style="background:' + esc(p.color) + '"></span>' + esc(p.name) + '</td>' +
        '<td>' + esc(p.className) + '</td>' +
        '<td><span class="an-chip profile">' + esc(p.profileLabel) + '</span></td>' +
        '<td>' + matchCell + '</td>' +
        '<td>' + (p.wins == null ? '<span class="an-na">—</span>' : fmtNum(p.wins)) + '</td>' +
        '<td>' + (p.assists == null ? '<span class="an-na">—</span>' : fmtNum(p.assists)) + '</td>' +
        '<td>' + (colOf('death') < 0 ? '<span class="an-na">未映射</span>' : cellValue(p, 'deaths')) + '</td>' +
        '<td>' + cellValue(p, 'damage') + '</td>' +
        '<td>' + cellValue(p, 'taken') + '</td>' +
        '<td>' + cellValue(p, 'heal') + '</td>' +
        '<td>' + cellValue(p, 'outEff') + '</td>' +
        '<td>' + cellValue(p, 'takenEff') + '</td>' +
        '<td>' + cellValue(p, 'killConv', 'pct') + '</td>' +
        '<td>' + cellValue(p, 'ratio', 'ratio') + '</td>' +
        '<td>' + scoreCell(p) + '</td>' +
        '<td>' + issueCell + '</td>' +
        '</tr>';
    }).join('');

    els.playersPanel.innerHTML =
      '<div class="an-toolbar">' +
        '<input type="search" id="analysisSearch" placeholder="搜索玩家名 / 职业" value="' + esc(state.search) + '">' +
        '<span class="an-chip">' + list.length + ' / ' + state.players.length + ' 人</span>' +
        '<span class="an-chip">口径：观众=治疗 · 战士=坦克 · 其余=输出</span>' +
        '<span class="an-chip">0 = 真实 0；空白 = 不适用（不进分母、不告警）</span>' +
        '<span class="an-hint">派生指标：输出效率=伤害/(击败+助攻)；承伤效率=承伤/(击败+助攻)；击杀转化=击败/(击败+助攻)；DP/TD=伤害/承伤</span>' +
      '</div>' +
      '<div class="an-table-wrap"><table class="an-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';

    var search = q('#analysisSearch', els.playersPanel);
    if (search) {
      search.addEventListener('input', function () {
        state.search = search.value;
        renderPlayers();
      });
    }
    qa('[data-player-index]', els.playersPanel).forEach(function (tr) {
      tr.addEventListener('click', function () { jumpToPlayer(Number(tr.getAttribute('data-player-index'))); });
    });
  }

  function quantileCell(med, q1, q3) {
    if (med == null) return '<span class="an-na">—</span>';
    return fmtNum(med) + ' <span class="dim">(' + fmtNum(q1) + '–' + fmtNum(q3) + ')</span>';
  }

  function renderTeam() {
    if (!els.teamPanel) return;
    if (!state.overall) {
      els.teamPanel.innerHTML = '<div class="an-empty">导入后这里会给出队伍总量、职业构成、职业分位、小队对比与异常分布。</div>';
      return;
    }

    var o = state.overall;
    var kpi = [
      ['参战人数', o.playerCount, '人'],
      ['总输出', o.totals.damage, '有值 ' + o.counts.damage + ' 人'],
      ['总承伤', o.totals.taken, '有值 ' + o.counts.taken + ' 人'],
      ['总治疗', o.totals.heal, '有值 ' + o.counts.heal + ' 人'],
      ['击杀+助攻', o.totals.ka, '有值 ' + o.counts.ka + ' 人'],
      ['疑点人数', state.issues.length, '高 ' + o.issueCounts['高'] + ' / 中 ' + o.issueCounts['中'] + ' / 低 ' + o.issueCounts['低']]
    ].map(function (k) {
      return '<div class="an-kpi"><span class="an-kpi-label">' + k[0] + '</span>' +
        '<span class="an-kpi-value">' + (k[1] == null ? '—' : fmtNum(k[1])) + '</span>' +
        '<span class="an-kpi-sub">' + esc(k[2]) + '</span></div>';
    }).join('');

    var classes = o.classes.map(function (c) {
      var share = o.playerCount ? c.count / o.playerCount : 0;
      return '<div class="comp-row"><span class="an-dot" style="background:' + esc(c.color) + '"></span>' +
        '<span class="comp-name">' + esc(c.name) + '</span>' +
        '<span class="comp-bar"><i style="width:' + (share * 100).toFixed(1) + '%;background:' + esc(c.color) + '"></i></span>' +
        '<span class="comp-num">' + c.count + ' 人 · ' + pct(share) + '</span></div>';
    }).join('');

    var groupRows = o.classStats.map(function (g) {
      return '<tr>' +
        '<td><span class="an-dot" style="background:' + esc(g.color) + '"></span>' + esc(g.name) + '</td>' +
        '<td>' + g.count + '</td>' +
        '<td>' + quantileCell(g.medians.damage, g.q1.damage, g.q3.damage) + ' <span class="dim">(' + g.denoms.damage + ')</span></td>' +
        '<td>' + quantileCell(g.medians.taken, g.q1.taken, g.q3.taken) + ' <span class="dim">(' + g.denoms.taken + ')</span></td>' +
        '<td>' + quantileCell(g.medians.heal, g.q1.heal, g.q3.heal) + ' <span class="dim">(' + g.denoms.heal + ')</span></td>' +
        '<td>' + quantileCell(g.medians.ka, g.q1.ka, g.q3.ka) + ' <span class="dim">(' + g.denoms.ka + ')</span></td>' +
        '<td>' + (g.medians.outEff == null ? '<span class="an-na">—</span>' : fmtNum(g.medians.outEff)) + '</td>' +
        '</tr>';
    }).join('');

    var anomalyRows = o.classStats.map(function (g) {
      return '<tr>' +
        '<td><span class="an-dot" style="background:' + esc(g.color) + '"></span>' + esc(g.name) + '</td>' +
        '<td>' + g.count + '</td>' +
        '<td><span class="sev sev-3">' + g.bands['高'] + '</span></td>' +
        '<td><span class="sev sev-2">' + g.bands['中'] + '</span></td>' +
        '<td><span class="sev sev-1">' + g.bands['低'] + '</span></td>' +
        '<td>' + (g.avgScore == null ? '—' : g.avgScore.toFixed(2)) + '</td>' +
        '<td>' + (g.damageRel == null ? '—' : pct(g.damageRel)) + '</td>' +
        '<td>' + (g.takenRel == null ? '—' : pct(g.takenRel)) + '</td>' +
        '<td class="dim">' + (g.flags.length ? esc(g.flags.join('；')) : '—') + '</td>' +
        '</tr>';
    }).join('');

    var squadBlock = '';
    if (o.squads.length) {
      squadBlock = '<div class="an-sub-title">小队对比（按编成匹配聚合）</div>' +
        '<div class="an-table-wrap"><table class="an-table"><thead><tr>' +
        '<th>小队 / 来源</th><th>人数</th><th>输出合计</th><th>承伤合计</th><th>治疗合计</th><th>击杀+助攻</th>' +
        '<th>平均异常分</th><th>高/中/低</th><th>承伤占比</th><th>人数占比</th>' +
        '</tr></thead><tbody>' +
        o.squads.map(function (s) {
          return '<tr><td>' + esc(s.label) + '</td><td>' + s.count + '</td>' +
            '<td>' + fmtNum(s.metrics.damage) + '</td><td>' + fmtNum(s.metrics.taken) + '</td>' +
            '<td>' + fmtNum(s.metrics.heal) + '</td><td>' + fmtNum(s.metrics.ka) + '</td>' +
            '<td>' + (s.avgScore == null ? '—' : s.avgScore.toFixed(2)) + '</td>' +
            '<td>' + s.bands['高'] + ' / ' + s.bands['中'] + ' / ' + s.bands['低'] + '</td>' +
            '<td>' + pct(s.takenShare) + '</td><td>' + pct(s.playerShare) + '</td></tr>';
        }).join('') +
        '</tbody></table></div>';
    } else {
      squadBlock = '<div class="an-sub-title">小队对比</div><div class="an-empty small">未匹配到编成，无法做小队对比；可在编队配置里把这些玩家名填进小队后重新分析。</div>';
    }

    var notes = o.notes.map(function (n) {
      return '<li class="an-note ' + n.level + '">' + esc(n.text) + '</li>';
    }).join('');

    els.teamPanel.innerHTML =
      '<div class="an-kpis">' + kpi + '</div>' +
      '<div class="an-sub-title">职业构成</div><div class="comp-list">' + classes + '</div>' +
      '<div class="an-sub-title">职业分位（中位数（下四分位–上四分位）；括号为该指标参与计算的人数）</div>' +
      '<div class="an-table-wrap"><table class="an-table"><thead><tr>' +
      '<th>职业</th><th>人数</th><th>输出中位</th><th>承伤中位</th><th>治疗中位</th><th>击杀+助攻中位</th><th>输出效率中位</th>' +
      '</tr></thead><tbody>' + groupRows + '</tbody></table></div>' +
      '<div class="an-sub-title">异常分布（哪些职业整体偏低）</div>' +
      '<div class="an-table-wrap"><table class="an-table"><thead><tr>' +
      '<th>职业</th><th>人数</th><th>高</th><th>中</th><th>低</th><th>平均异常分</th><th>输出中位/全场</th><th>承伤中位/全场</th><th>整体判断</th>' +
      '</tr></thead><tbody>' + anomalyRows + '</tbody></table></div>' +
      squadBlock +
      '<div class="an-sub-title">分布与异常提示</div><ul class="an-notes">' + notes + '</ul>';
  }

  function issueFilterLabel(band) {
    return band === 'all' ? '全部' : band;
  }

  function dimChip(d) {
    if (!d.applicable) {
      return '<span class="issue-dim is-na" title="' + esc(d.naText) + '">' + esc(d.label) +
        '<b>不适用</b><i>' + esc(d.naText) + '</i></span>';
    }
    var cls = 'issue-dim' + (d.triggered ? ' is-hit' : '') + (d.exempt ? ' is-exempt' : '') +
      (d.hint ? ' is-hint' : '');
    return '<span class="' + cls + '">' + esc(d.label) +
      '<b>' + (d.ratio == null ? '' : pct(d.ratio) + ' 基准') + '</b>' +
      '<i>异常 ' + d.anomaly.toFixed(2) + ' · 权重 ' + d.weight.toFixed(2) + '</i>' +
      '<em>' + esc(d.text || '未比较') + '</em></span>';
  }

  function renderIssues() {
    if (!els.issuesPanel) return;
    if (!state.issues.length) {
      els.issuesPanel.innerHTML = '<div class="an-empty">' +
        (state.players.length
          ? '当前档位下没有触发疑点。可以到「设置」页切换宽松档，或展开高级设置把判定线调松（全部为假设值）。'
          : '导入数据后，这里会按「职业 → 口径 → 维度」列出疑似有问题人员。') + '</div>';
      return;
    }

    var list = state.issues.filter(function (it) {
      if (state.issueBand !== 'all' && it.band !== state.issueBand) return false;
      return it.score >= (state.issueMinScore || 0);
    });
    var count = issuesBandCounts(state.issues);

    var filters = ['all', '高', '中', '低'].map(function (b) {
      return '<button type="button" class="btn mini' + (state.issueBand === b ? ' gold' : '') +
        '" data-issue-band="' + b + '">' + issueFilterLabel(b) +
        (b === 'all' ? ' ' + state.issues.length : ' ' + count[b]) + '</button>';
    }).join('');

    els.issuesPanel.innerHTML =
      '<div class="an-toolbar">' +
        '<span class="an-chip">共 ' + state.issues.length + ' 条 · 当前显示 ' + list.length + ' 条</span>' +
        filters +
        '<label class="an-score-filter">最低分 <input type="number" id="issueScoreMin" min="0" max="1" step="0.05" value="' +
          (state.issueMinScore || 0) + '"></label>' +
        '<span class="an-hint">分档：高 = 红 / 橙（立即核查）· 中 = 黄（关注）· 低 = 灰绿（提示）</span>' +
        '<button type="button" class="btn mini" id="btnGoSettings">调整档位 / 阈值</button>' +
      '</div>' +
      '<ol class="issue-list">' + list.map(function (it, i) {
        var applicable = it.dims.filter(function (d) { return d.applicable; }).length;
        var hit = it.dims.filter(function (d) { return d.applicable && d.triggered; }).length;
        var detailBlock = it.dims.length
          ? '<details class="issue-details">' +
              '<summary>维度明细（适用 ' + applicable + ' / 共 ' + it.dims.length + '，触发 ' + hit + '）</summary>' +
              '<div class="issue-dims">' + it.dims.map(dimChip).join('') + '</div>' +
              '<div class="issue-detail">' + esc(it.detail) + '</div>' +
              (it.exemptText ? '<div class="issue-detail exempt">' + esc(it.exemptText) + '</div>' : '') +
              (it.downgradeText ? '<div class="issue-detail exempt">' + esc(it.downgradeText) + '</div>' : '') +
            '</details>'
          : '';
        return '<li class="issue-item" data-player-index="' + it.rowIndex + '">' +
          '<span class="issue-no">' + (i + 1) + '</span>' +
          '<span class="sev sev-' + it.level + '">' + it.band + '</span>' +
          '<div class="issue-main">' +
            '<div class="issue-head"><strong>' + esc(it.playerName) + '</strong>' +
            '<span class="an-chip">' + esc(it.className) + '</span>' +
            (it.profileLabel ? '<span class="an-chip profile">' + esc(it.profileLabel) + '</span>' : '') +
            '<span class="issue-score">综合异常分 ' + it.score.toFixed(2) + '</span>' +
            '<span class="issue-code">' + esc(it.title) + '</span></div>' +
            '<div class="issue-reason">' + esc(it.reason || it.detail) + '</div>' +
            detailBlock +
          '</div>' +
          '</li>';
      }).join('') + '</ol>';

    qa('.issue-item', els.issuesPanel).forEach(function (li) {
      li.addEventListener('click', function (e) {
        if (e.target && e.target.closest && e.target.closest('.issue-details')) return;
        jumpToPlayer(Number(li.getAttribute('data-player-index')));
      });
    });
    qa('[data-issue-band]', els.issuesPanel).forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.issueBand = btn.getAttribute('data-issue-band');
        renderIssues();
      });
    });
    var scoreMin = q('#issueScoreMin', els.issuesPanel);
    if (scoreMin) scoreMin.addEventListener('change', function () {
      var v = Number(scoreMin.value);
      state.issueMinScore = isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
      renderIssues();
    });
    var goSet = q('#btnGoSettings', els.issuesPanel);
    if (goSet) goSet.addEventListener('click', function () { switchTab('settings'); });
  }

  function renderSettings() {
    if (!els.settingsPanel) return;
    var S = state.settings;

    var presetBtns = ['loose', 'standard', 'strict'].map(function (key) {
      var p = PRESETS[key];
      return '<button type="button" class="btn set-preset' + (S.profilePreset === key ? ' gold' : '') +
        '" data-preset="' + key + '">' + p.label + '</button>';
    }).join('');

    var html = '';
    ['sample', 'bands', 'threshold', 'weight', 'rule'].forEach(function (group) {
      var specs = SETTING_SPECS.filter(function (s) { return s.group === group; });
      if (!specs.length) return;
      html += '<div class="an-sub-title">' + GROUP_TITLES[group] + '</div><div class="set-grid">' +
        specs.map(function (spec) {
          if (spec.type === 'bool') {
            return '<label class="set-row"><span class="set-label">' + esc(spec.label) + '</span>' +
              '<input type="checkbox" data-set-key="' + spec.key + '"' + (S[spec.key] ? ' checked' : '') + '>' +
              '<span class="set-unit"></span><span class="set-desc">' + esc(spec.desc) + '</span></label>';
          }
          return '<label class="set-row"><span class="set-label">' + esc(spec.label) + '</span>' +
            '<input type="number" data-set-key="' + spec.key + '" min="' + spec.min + '" max="' + spec.max +
            '" step="' + spec.step + '" value="' + S[spec.key] + '">' +
            '<span class="set-unit">' + esc(spec.unit) + '</span>' +
            '<span class="set-desc">' + esc(spec.desc) + '</span></label>';
        }).join('') + '</div>';
    });

    els.settingsPanel.innerHTML =
      '<div class="set-preset-row"><span class="set-preset-title">判定档位</span>' + presetBtns + '</div>' +
      '<div class="set-preset-desc">' + esc(presetSummary()) + '</div>' +
      '<div class="set-note">档位只把下面的原始阈值乘上不同倍数：宽松更少报，严格更多报。' +
      '职业按口径分维度 —— 观众只评治疗与生存、战士只评承伤与助攻，其余输出职业才评伤害 / 击杀转化类；' +
      '不适用的维度在明细里置灰、不参与打分。改动即时保存到 <code>' + SETTINGS_KEY + '</code> 并重算。</div>' +
      '<details class="set-advanced"' + (state.advancedOpen ? ' open' : '') + '>' +
        '<summary>高级设置 · 逐项阈值与权重（原始值，档位倍数会叠加）</summary>' +
        html +
      '</details>' +
      '<div class="set-actions"><button type="button" class="btn" id="btnSetReset">恢复默认假设值</button>' +
      '<button type="button" class="btn" id="btnSetClearStorage">清空本地映射 / 阈值 / 工作表记忆</button></div>';

    qa('[data-preset]', els.settingsPanel).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-preset');
        if (!PRESETS[key]) return;
        state.settings.profilePreset = key;
        writeStore(SETTINGS_KEY, state.settings);
        computeAll();
        renderHeader();
        renderPlayers();
        renderTeam();
        renderIssues();
        renderSettings();
        GM.ui.toast('判定档位已切换为「' + PRESETS[key].label + '」', 'success');
      });
    });

    var adv = q('.set-advanced', els.settingsPanel);
    if (adv) adv.addEventListener('toggle', function () { state.advancedOpen = adv.open; });

    qa('[data-set-key]', els.settingsPanel).forEach(function (input) {
      input.addEventListener('change', function () {
        var key = input.getAttribute('data-set-key');
        var spec = null;
        SETTING_SPECS.forEach(function (s) { if (s.key === key) spec = s; });
        if (!spec) return;
        if (spec.type === 'bool') {
          state.settings[key] = !!input.checked;
        } else {
          var v = Number(input.value);
          if (!isFinite(v)) v = DEFAULT_SETTINGS[key];
          v = Math.min(spec.max, Math.max(spec.min, v));
          /* 分档线必须保持 低 < 中 < 高 */
          if (key === 'scoreLow') state.settings.scoreMid = Math.max(state.settings.scoreMid, v + 0.01);
          if (key === 'scoreMid') {
            v = Math.max(v, state.settings.scoreLow + 0.01);
            state.settings.scoreHigh = Math.max(state.settings.scoreHigh, v + 0.01);
          }
          if (key === 'scoreHigh') v = Math.max(v, state.settings.scoreMid + 0.01);
          state.settings[key] = v;
          input.value = v;
        }
        writeStore(SETTINGS_KEY, state.settings);
        computeAll();
        renderHeader();
        renderPlayers();
        renderTeam();
        renderIssues();
        renderSettings();
      });
    });

    var reset = q('#btnSetReset', els.settingsPanel);
    if (reset) reset.addEventListener('click', function () {
      state.settings = U.clone(DEFAULT_SETTINGS);
      writeStore(SETTINGS_KEY, state.settings);
      computeAll();
      renderAll();
      GM.ui.toast('阈值与权重已恢复默认假设值', 'success');
    });
    var clear = q('#btnSetClearStorage', els.settingsPanel);
    if (clear) clear.addEventListener('click', function () {
      try {
        window.localStorage.removeItem(MAP_KEY);
        window.localStorage.removeItem(SETTINGS_KEY);
        window.localStorage.removeItem(SHEET_KEY);
      } catch (err) {}
      GM.ui.toast('已清空本地映射、阈值与工作表记忆', 'success');
    });
  }

  function renderAll() {
    renderHeader();
    renderImport();
    renderMapping();
    renderPlayers();
    renderTeam();
    renderIssues();
    renderSettings();
    updateTabs();
  }

  function updateTabs() {
    qa('#analysisTabs [data-tab]').forEach(function (btn) {
      var tab = btn.getAttribute('data-tab');
      btn.classList.toggle('active', tab === state.activeTab);
      if (tab === 'issues') btn.setAttribute('data-count', state.issues.length || '');
    });
    qa('[data-panel]').forEach(function (panel) {
      var on = panel.getAttribute('data-panel') === state.activeTab;
      panel.classList.toggle('active', on);
      panel.hidden = !on;
    });
  }

  function switchTab(tab) {
    state.activeTab = tab;
    updateTabs();
    if (tab === 'players') renderPlayers();
    if (tab === 'issues') renderIssues();
    if (tab === 'team') renderTeam();
    if (tab === 'settings') renderSettings();
  }

  function jumpToPlayer(rowIndex) {
    state.highlightIndex = rowIndex;
    state.search = '';
    switchTab('players');
    renderPlayers();
    var row = q('[data-player-index="' + rowIndex + '"]', els.playersPanel);
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /* ============================ 导入流程 ============================ */

  function handleFile(file) {
    if (!file) return;
    var name = file.name || '';
    state.fileName = name;
    state.fileSize = file.size || 0;

    if (/\.csv$/i.test(name)) {
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var table = GM.xlsx.parseCsv(e.target.result);
          state.buffer = null;
          state.sheetNames = ['CSV'];
          setTable(table, 'CSV');
        } catch (err) {
          setStatus('CSV 解析失败：' + (err && err.message || err), 'error');
        }
      };
      reader.onerror = function () { setStatus('文件读取失败', 'error'); };
      reader.readAsText(file, 'utf-8');
      return;
    }

    if (!/\.xlsx$/i.test(name)) {
      setStatus('只支持 .xlsx 或 .csv 文件', 'error');
      return;
    }

    if (!GM.xlsx.supported()) {
      setStatus('当前浏览器不支持 DecompressionStream，无法解压 xlsx。请改用 CSV 导入，或换用最新版 Chrome / Edge（不要静默失败）。', 'error');
      GM.ui.toast('浏览器不支持 DecompressionStream：请改用 CSV 导入', 'error');
      return;
    }

    setStatus('正在读取 xlsx…', 'pending');
    var reader2 = new FileReader();
    reader2.onload = function (e) {
      state.buffer = e.target.result;
      GM.xlsx.listSheets(state.buffer).then(function (names) {
        state.sheetNames = names;
        var remembered = readStore(SHEET_KEY, '');
        var chosen;
        if (remembered && names.indexOf(remembered) >= 0) chosen = remembered;
        else if (names.indexOf('10.17四方数据') >= 0) chosen = '10.17四方数据';
        else chosen = names[0];
        setStatus('已识别 ' + names.length + ' 张工作表：' + names.join(' / ') + '；正在读取「' + chosen + '」…', 'pending');
        return loadSheet(chosen);
      }).catch(function (err) {
        console.error('[GM] xlsx 解析失败', err);
        setStatus('xlsx 解析失败：' + (err && err.message || err) + '（可改用 CSV 导入）', 'error');
      });
    };
    reader2.onerror = function () { setStatus('文件读取失败', 'error'); };
    reader2.readAsArrayBuffer(file);
  }

  function loadSheet(sheetName) {
    if (!state.buffer) {
      state.sheetName = sheetName;
      renderImport();
      return;
    }
    var wanted = sheetName;
    setStatus('正在解压工作表「' + wanted + '」…', 'pending');
    GM.xlsx.readSheet(state.buffer, wanted).then(function (table) {
      state.sheetNames = table.sheetNames || state.sheetNames;
      setTable(table, state.fileName);
    }).catch(function (err) {
      console.error('[GM] 工作表解析失败', err);
      setStatus('工作表「' + wanted + '」解析失败：' + (err && err.message || err), 'error');
    });
  }

  function setTable(table, source) {
    state.headers = table.headers.slice();
    state.rows = table.rows.slice();
    state.sheetName = table.sheetName || 'CSV';
    state.sheetNames = table.sheetNames || state.sheetNames;
    state.mapping = resolveMapping(state.headers);
    state.settings = mergeSettings(readStore(SETTINGS_KEY, {}));
    state.importedAt = new Date();
    state.highlightIndex = null;
    state.search = '';
    state.issueBand = 'all';
    persistMapping();
    writeStore(SHEET_KEY, state.sheetName);
    computeAll();
    renderAll();
    setStatus('已导入「' + state.sheetName + '」：' + state.rows.length + ' 行数据 × ' + state.headers.length + ' 列' +
      (source ? '（' + source + '）' : '') + '。请核对列映射。', 'ok');
    switchTab('mapping');
  }

  function mergeSettings(saved) {
    var out = U.clone(DEFAULT_SETTINGS);
    if (saved && typeof saved === 'object') {
      Object.keys(out).forEach(function (k) {
        if (k === 'profilePreset') {
          if (typeof saved[k] === 'string' && PRESETS[saved[k]]) out[k] = saved[k];
          return;
        }
        if (typeof saved[k] === (typeof out[k]) && isFinite(Number(saved[k]))) out[k] = saved[k];
      });
    }
    return out;
  }

  /* ============================ 导出 ============================ */

  function buildExport() {
    return {
      app: '诡秘之主 · 战后分析',
      exportedAt: new Date().toISOString(),
      source: {
        fileName: state.fileName,
        sheetName: state.sheetName,
        sheetNames: state.sheetNames.slice(),
        headers: state.headers.slice(),
        rowCount: state.rows.length,
        importedAt: state.importedAt ? state.importedAt.toISOString() : null
      },
      mapping: U.clone(state.mapping),
      settings: U.clone(state.settings),
      effectiveSettings: U.clone(state.effective || applyPreset(state.settings)),
      profiles: {
        labels: PROFILE_LABELS,
        desc: PROFILE_DESC,
        allow: PROFILE_ALLOW,
        weightFactor: PROFILE_WEIGHT,
        classMap: {
          '观众': 'heal', '战士': 'tank', '歌颂': 'output',
          '学徒': 'output', '占卜': 'output', '窥秘': 'output'
        },
        presets: PRESETS,
        current: state.settings.profilePreset
      },
      valueSemantics: {
        zero: '表格填 0 = 真实的 0，参与统计、中位数、排名与疑点判定',
        blank: '空白 / 纯空格 / — / - / N/A = 该职业不做这项指标（不适用），不进分母、不排秩、不告警',
        note: '数据结构上 0 与 null 严格区分；null 只表示不适用'
      },
      dimensions: DIMENSIONS.map(function (d) {
        var eff = state.effective || state.settings;
        return {
          key: d.key, label: d.label, formula: d.formula, norm: d.norm,
          weight: eff[d.weightKey], threshold: eff[d.thresholdKey],
          baseWeight: state.settings[d.weightKey], baseThreshold: state.settings[d.thresholdKey]
        };
      }),
      formulas: {
        ka: '击败 + 助攻（两列任一为空白则为 null）',
        ratio: '对玩家伤害 / 承受伤害（承伤为 0 或空白时不计算）',
        outEff: '对玩家伤害 / (击败 + 助攻)',
        takenEff: '承受伤害 / (击败 + 助攻)',
        takenRatio: '承受伤害 / 对玩家伤害',
        killConv: '击败 / (击败 + 助攻)',
        healEff: '治疗 / (击败 + 助攻)',
        median: '同职业内、仅取该指标非空白成员求中位数（0 参与）',
        quartile: '同职业内线性插值分位：Q1=0.25、Q3=0.75',
        composite: '各维度异常度（0–1）按权重求和 / 适用维度权重之和'
      },
      overall: state.overall,
      groups: state.groups.map(function (g) {
        return {
          key: g.key, className: g.className, count: g.count,
          medians: g.medians, q1: g.q1, q3: g.q3, denoms: g.denoms
        };
      }),
      players: state.players.map(function (p) {
        return {
          rowIndex: p.rowIndex,
          name: p.name,
          className: p.className,
          profile: p.profile,
          profileLabel: p.profileLabel,
          wins: p.wins, assists: p.assists, ka: p.ka,
          damage: p.damage, taken: p.taken, heal: p.heal, deaths: p.deaths,
          ratio: p.ratio, outEff: p.outEff, takenEff: p.takenEff,
          takenRatio: p.takenRatio, killConv: p.killConv, healEff: p.healEff,
          composite: p.composite, band: p.band,
          dims: p.dims.map(function (d) {
            return {
              key: d.key, label: d.label, applicable: d.applicable, naText: d.naText,
              actual: d.actual, ref: d.ref,
              ratio: d.ratio, anomaly: d.anomaly, weight: d.weight,
              thresholdTriggered: d.triggered, exempt: d.exempt, hint: d.hint, detail: d.text
            };
          }),
          exemptText: p.exemptText, downgradeText: p.downgradeText,
          match: p.match ? {
            source: p.match.source, alliance: p.match.alliance,
            team: p.match.team, squad: p.match.squad, label: p.match.label
          } : null
        };
      }),
      issues: state.issues.map(function (i) {
        return {
          code: i.code, title: i.title, reason: i.reason, playerName: i.playerName,
          className: i.className, profile: i.profile, profileLabel: i.profileLabel,
          rowIndex: i.rowIndex, score: i.score, band: i.band, level: i.level,
          detail: i.detail,
          dims: i.dims.map(function (d) {
            return {
              key: d.key, label: d.label, applicable: d.applicable, naText: d.naText,
              actual: d.actual, ref: d.ref,
              ratio: d.ratio, anomaly: d.anomaly, weight: d.weight,
              thresholdTriggered: d.triggered, exempt: d.exempt, hint: d.hint, detail: d.text
            };
          }),
          exemptText: i.exemptText, downgradeText: i.downgradeText
        };
      })
    };
  }

  function downloadCsv(filename, text) {
    var blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
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

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportJson() {
    if (!state.players.length) {
      GM.ui.toast('请先导入数据并完成列映射', 'error');
      return;
    }
    var data = buildExport();
    var filename = '战后分析_' + (state.sheetName || '数据') + '_' + U.dateStamp() + '.json';
    U.download(filename, JSON.stringify(data, null, 2));
    GM.ui.toast('已导出分析 JSON：' + filename, 'success');
  }

  function exportCsv() {
    if (!state.players.length) {
      GM.ui.toast('请先导入数据并完成列映射', 'error');
      return;
    }
    var issuesByRow = {};
    state.issues.forEach(function (i) {
      if (!issuesByRow[i.rowIndex]) issuesByRow[i.rowIndex] = [];
      issuesByRow[i.rowIndex].push(i.band + '·' + i.score.toFixed(2) + '·' + i.title);
    });

    var head = ['玩家', '职业', '口径', '编成', '击败', '助攻', '死亡', '输出', '承伤', '治疗',
      'DP/TD', '输出效率', '承伤效率', '击杀转化', '综合异常分', '分档', '触发维度', '疑点'];
    var lines = [head.map(csvCell).join(',')];

    state.players.forEach(function (p) {
      var matchLabel = p.match
        ? (p.match.source === 'live' ? '实时' : p.match.label) + ':' + [p.match.alliance, p.match.team, p.match.squad].filter(Boolean).join('/')
        : '';
      var dims = p.dims.filter(function (d) { return d.applicable && d.triggered; }).map(function (d) {
        return d.label + '(' + d.anomaly.toFixed(2) + '/w' + d.weight.toFixed(2) + ')';
      }).join('；');
      lines.push([
        p.name, p.className, p.profileLabel, matchLabel,
        p.wins, p.assists, p.deaths, p.damage, p.taken, p.heal,
        p.ratio == null ? null : p.ratio.toFixed(2),
        p.outEff, p.takenEff,
        p.killConv == null ? null : p.killConv.toFixed(3),
        p.composite == null ? null : p.composite.toFixed(3),
        p.band,
        dims,
        (issuesByRow[p.rowIndex] || []).join('；')
      ].map(csvCell).join(','));
    });

    var filename = '战后分析_' + (state.sheetName || '数据') + '_' + U.dateStamp() + '.csv';
    downloadCsv(filename, lines.join('\r\n'));
    GM.ui.toast('已导出分析 CSV：' + filename, 'success');
  }

  /* ============================ 开关与事件 ============================ */

  function open() {
    if (!els.overlay) return;
    els.overlay.classList.remove('hidden');
    renderAll();
    if (!state.importedAt) switchTab('import');
    else switchTab(state.activeTab === 'import' ? 'players' : state.activeTab);
    if (document.body) document.body.classList.add('analysis-open');
  }

  function close() {
    if (!els.overlay) return;
    els.overlay.classList.add('hidden');
    document.body.classList.remove('analysis-open');
  }

  function isOpen() {
    return els.overlay && !els.overlay.classList.contains('hidden');
  }

  function init() {
    els.overlay = q('#analysisOverlay');
    els.importPanel = q('[data-panel="import"]');
    els.mappingPanel = q('[data-panel="mapping"]');
    els.playersPanel = q('[data-panel="players"]');
    els.teamPanel = q('[data-panel="team"]');
    els.issuesPanel = q('[data-panel="issues"]');
    els.settingsPanel = q('[data-panel="settings"]');
    els.scopeTag = q('#analysisScopeTag');
    els.status = q('#analysisStatus');

    state.settings = mergeSettings(readStore(SETTINGS_KEY, {}));
    state.effective = applyPreset(state.settings);

    var openBtn = q('#btnAnalysis');
    if (openBtn) openBtn.addEventListener('click', open);
    var closeBtn = q('#analysisClose');
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (els.overlay) {
      els.overlay.addEventListener('click', function (e) {
        if (e.target === els.overlay) close();
      });
    }

    qa('#analysisTabs [data-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.getAttribute('data-tab')); });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) {
        close();
        e.stopPropagation();
      }
    }, true);

    var exJson = q('#analysisExportJson');
    if (exJson) exJson.addEventListener('click', exportJson);
    var exCsv = q('#analysisExportCsv');
    if (exCsv) exCsv.addEventListener('click', exportCsv);

    renderAll();
  }

  GM.analysis = {
    init: init,
    open: open,
    close: close,
    isOpen: isOpen,
    state: state,
    computeAll: computeAll,
    buildExport: buildExport,
    setTable: setTable,
    loadSheet: loadSheet,
    dimensions: DIMENSIONS,
    defaults: DEFAULT_SETTINGS,
    bandOf: bandOf,
    profiles: PROFILE_LABELS,
    profileAllow: PROFILE_ALLOW,
    profileWeight: PROFILE_WEIGHT,
    presets: PRESETS,
    applyPreset: applyPreset
  };
})();
