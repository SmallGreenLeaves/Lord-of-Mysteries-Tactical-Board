/* 诡秘之主 · GvG 战术板
 * 六大职业与配色（固定配色，用于编队色块）。
 * 职业名 / 职责 / 颜色都是战术板内的编队设定；技能槽默认留空，不编造数值。
 */
window.GM_DATA = window.GM_DATA || {};

/* 配色 v2：按 assets/maps/reference/four-post.png 左上角队伍血条取样
 * （#D5772F 橙 / #97C9B4 绿 / #2E80AF 蓝 / #53589D 靛蓝 / #A165BB 紫）后调整明度与饱和度，
 * 保证色块内正文对比度 ≥ 4.5:1、次要文字 ≥ 3:1，同时保留「职业→色系」映射。 */
/* forms = 该职业允许的形态，第一项即默认形态：
 * 战士 坦克/输出、歌颂 输出/辅助、观众 治疗/输出、占卜/学徒/窥秘 只有输出。 */
window.GM_DATA.classes = [
  { id: 'class-1', name: '战士', abbr: '战', color: '#C96E22', role: '近战输出 / 坦克', forms: ['坦克', '输出'], placeholder: false, note: '', skills: [] },
  { id: 'class-2', name: '歌颂', abbr: '歌', color: '#D9B53A', role: '近战输出', forms: ['输出', '辅助'], placeholder: false, note: '', skills: [] },
  { id: 'class-3', name: '学徒', abbr: '学', color: '#8FC9E6', role: '近战袭扰', forms: ['输出'], placeholder: false, note: '', skills: [] },
  { id: 'class-4', name: '占卜', abbr: '卜', color: '#1B2A5E', role: '远程输出', forms: ['输出'], placeholder: false, note: '', skills: [] },
  { id: 'class-5', name: '窥秘', abbr: '秘', color: '#AC72C4', role: '远程控制', forms: ['输出'], placeholder: false, note: '', skills: [] },
  { id: 'class-6', name: '观众', abbr: '观', color: '#6FBF8C', role: '远程输出 / 治疗', forms: ['治疗', '输出'], placeholder: false, note: '', skills: [] }
];

/* 每个成员预留的技能槽数量 */
window.GM_DATA.skillSlotCount = 4;

/* 标记状态：id 写入存档，name 显示在界面。外圈描边只表达状态，五状态统一实线同宽，仅颜色不同 */
window.GM_DATA.statuses = [
  { id: 'idle', name: '待命', color: '#8ea3b8' },
  { id: 'advance', name: '推进', color: '#d4af5f' },
  { id: 'engage', name: '交战', color: '#ef5350' },
  { id: 'attrition', name: '减员', color: '#a86a2f' },
  { id: 'dead', name: '阵亡', color: '#6a6f7a' }
];

/* 敌我关系：8 项固定顺序，独立于填充色 fill；色值只用于标识框第二行文字与色板，不再决定标记内圈填充。
   对比度口径：以下 8 色对标识框深底（#080b10 + 0.82 不透明度）均 ≥4.5:1。 */
window.GM_DATA.relations = [
  { id: 'own', name: '我方', color: '#5fae8a' },
  { id: 'ally1', name: '友方(1)', color: '#5b93c9' },
  { id: 'ally2', name: '友方(2)', color: '#5fb9c6' },
  { id: 'ally3', name: '友方(3)', color: '#9f9ad8' },
  { id: 'enemy-red', name: '敌方(红)', color: '#e0645c' },
  { id: 'enemy-yellow', name: '敌方(黄)', color: '#d9a63c' },
  { id: 'enemy-blue', name: '敌方(蓝)', color: '#5f9ae0' },
  { id: 'enemy-green', name: '敌方(绿)', color: '#55b877' }
];

/* 工具栏「团队」二级选项只用这四项敌方色 */
window.GM_DATA.enemyRelations = ['enemy-red', 'enemy-yellow', 'enemy-blue', 'enemy-green'];

/* 旧存档敌我字段兼容映射：旧内部值 / 旧中文名 / 旧颜色串都归一到 8 项新 id。
   旧 enemy 是红色，因此旧 enemy、缺省、非法值统一落到 enemy-red。 */
window.GM_DATA.relationAliases = {
  own: 'own', 'ally': 'ally1', enemy: 'enemy-red',
  'ally-1': 'ally1', 'ally-2': 'ally2', 'ally-3': 'ally3',
  red: 'enemy-red', yellow: 'enemy-yellow', blue: 'enemy-blue', green: 'enemy-green',
  'enemy-r': 'enemy-red', 'enemy-y': 'enemy-yellow', 'enemy-b': 'enemy-blue', 'enemy-g': 'enemy-green',
  '我方': 'own', '友方': 'ally1', '敌方': 'enemy-red',
  '友方(1)': 'ally1', '友方(2)': 'ally2', '友方(3)': 'ally3',
  '敌方(红)': 'enemy-red', '敌方(黄)': 'enemy-yellow', '敌方(蓝)': 'enemy-blue', '敌方(绿)': 'enemy-green'
};

/* 旧颜色型敌我字段 → 新 relation（只在 relation 值无法按 id / 名称解析时兜底） */
window.GM_DATA.relationLegacyColors = {
  '#5fae8a': 'own',
  '#5b93c9': 'ally1',
  '#cf4f45': 'enemy-red',
  '#e0533f': 'enemy-red',
  '#d9a63c': 'enemy-yellow',
  '#4a86d8': 'enemy-blue',
  '#46a86b': 'enemy-green'
};

window.GM_DATA.teamKinds = {
  alliance: { label: '联盟', short: '联', max: 150 },
  team: { label: '团队', short: '团', max: 30 },
  squad: { label: '小队', short: '队', max: 6 }
};

/* 四势力：GvG 地图统一使用的名称与配色（与六职业配色是两套独立色板）。
 * 配色要求：深色底上作为文字 / 描边可读（对 --panel #10151d 正文对比度 ≥ 4.5:1），
 * 四色互相可区分；血皇帝红刻意避开战后分析高风险语义红（#ffb3ae / #8e2f3c）。
 * 顺序对应旧存档的 A / B / C / D 位，只换显示名与颜色，id 不变。 */
window.GM_DATA.defaultFactions = [
  { id: 'A', name: '夜枭', color: '#F0CE45' },
  { id: 'B', name: '黑皇帝', color: '#4A86D8' },
  { id: 'C', name: '血皇帝', color: '#DC5A55' },
  { id: 'D', name: '冥皇', color: '#46A86B' }
];

/* 旧存档势力 id 别名：历史上势力 id 可能写成英文名或 club-a 等形态。
 * 载入时先按下表解析回 A–D，再套用当前四势力名称与颜色，保证旧据点 / 结界 /
 * 标记归属不丢。键统一小写比较。 */
window.GM_DATA.factionAliases = {
  ash: 'A', ember: 'A', 'club-a': 'A', 'a': 'A',
  storm: 'B', tempest: 'B', 'club-b': 'B', 'b': 'B',
  night: 'C', dark: 'C', 'club-c': 'C', 'c': 'C',
  earth: 'D', land: 'D', 'club-d': 'D', 'd': 'D'
};

/* 原「画线」工具组：进攻 / 虚线进攻 / 防守 / 禁止。
 * 这四个共用同一套画线交互（单击路径点、双击结束），按 id 切换线条样式与末端图元。
 * dashed 表示线体是否虚线；head 决定线末端画箭头 / 盾 / 禁止符。 */
window.GM_DATA.lineTools = [
  { id: 'attack', name: '进攻', color: '#e0645c', dashed: false, head: 'arrow' },
  { id: 'attackDash', name: '虚线进攻', color: '#e0645c', dashed: true, head: 'arrow' },
  { id: 'defense', name: '防守', color: '#5f9ae0', dashed: false, head: 'shield' },
  { id: 'forbid', name: '禁止', color: '#d9a63c', dashed: false, head: 'forbid' }
];

/* 第二类标记工具：图标型标记（只作图元，不参与推演）。
 * id 即工具内部枚举，name / color 是放置时的默认值，之后可在属性检查器改。 */
window.GM_DATA.iconMarkers = [
  { id: 'attack', name: '进攻', color: '#e0645c' },
  { id: 'attackDash', name: '虚线进攻', color: '#e0645c' },
  { id: 'defense', name: '防守', color: '#5f9ae0' },
  { id: 'forbid', name: '禁止', color: '#d9a63c' },
  { id: 'rallyFlag', name: '集结', color: '#c9a55a' }
];

/* 技能范围预设：1 米 = 1 unit，落图固定用世界单位，不按各图像素比例换算。
 * 套用时把 shapeType / r / len / wid / color / dashed 六个字段整体写入图元。 */
window.GM_DATA.skillPresets = [
  { id: 'yuxin', name: '愈心', shapeType: 'circle', r: 25, color: '#5f9ae0', dashed: true },
  { id: 'dagou', name: '大狗', shapeType: 'rect', len: 20, wid: 3, color: '#e0645c', dashed: false },
  { id: 'zuxian', name: '先祖', shapeType: 'circle', r: 25, color: '#d9a63c', dashed: true }
];
