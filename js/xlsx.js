(function () {
  'use strict';

  window.GM = window.GM || {};
  var GM = window.GM;

  var decoder = new TextDecoder('utf-8');

  function u16(u8, p) { return u8[p] | (u8[p + 1] << 8); }
  function u32(u8, p) {
    return (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0;
  }

  function textAt(u8, p, len) {
    return decoder.decode(u8.subarray(p, p + len));
  }

  /* ============ 最小 ZIP 读取（中央目录 + local header + deflate-raw） ============ */

  function readZip(buffer) {
    var u8 = new Uint8Array(buffer);
    var eocd = -1;
    var min = Math.max(0, u8.length - 22 - 65535);
    for (var i = u8.length - 22; i >= min; i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('不是有效的 xlsx 文件（找不到 ZIP 目录结尾）');

    var count = u16(u8, eocd + 10);
    var cdOffset = u32(u8, eocd + 16);
    var entries = {};
    var p = cdOffset;

    for (var k = 0; k < count; k++) {
      if (p + 46 > u8.length || u32(u8, p) !== 0x02014b50) break;
      var method = u16(u8, p + 10);
      var compSize = u32(u8, p + 20);
      var uncompSize = u32(u8, p + 24);
      var nameLen = u16(u8, p + 28);
      var extraLen = u16(u8, p + 30);
      var commentLen = u16(u8, p + 32);
      var localOff = u32(u8, p + 42);
      var name = textAt(u8, p + 46, nameLen);
      entries[name] = {
        name: name,
        method: method,
        compSize: compSize,
        uncompSize: uncompSize,
        localOff: localOff
      };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { u8: u8, entries: entries };
  }

  function entryBytes(zip, entry) {
    var u8 = zip.u8;
    var off = entry.localOff;
    if (off + 30 > u8.length || u32(u8, off) !== 0x04034b50) {
      throw new Error('ZIP 条目损坏：' + entry.name);
    }
    var nameLen = u16(u8, off + 26);
    var extraLen = u16(u8, off + 28);
    var start = off + 30 + nameLen + extraLen;
    var size = entry.compSize;
    if (entry.compSize === 0xffffffff || entry.compSize === 0) size = entry.uncompSize;
    return u8.subarray(start, start + size);
  }

  function inflateRaw(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  }

  function readText(zip, name) {
    var entry = zip.entries[name];
    if (!entry) return Promise.resolve(null);
    var bytes = entryBytes(zip, entry);
    if (entry.method === 0) return Promise.resolve(decoder.decode(bytes));
    if (entry.method !== 8) return Promise.resolve(null);
    return inflateRaw(bytes);
  }

  /* ============ XML 小工具（命名空间无关） ============ */

  function parseXml(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('XML 解析失败');
    }
    return doc;
  }

  function attrLocal(el, local) {
    if (!el || !el.attributes) return null;
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (a.localName === local || a.name === local) return a.value;
    }
    return null;
  }

  function firstTag(root, tag) {
    if (!root) return null;
    var list = root.getElementsByTagName(tag);
    if (list.length) return list[0];
    /* theme1.xml 里的标签带命名空间前缀（<a:clrScheme>），按限定名查不到，
       回退按 localName 匹配（getElementsByTagName('*') 会返回所有命名空间的元素） */
    var all = root.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      if (all[i].localName === tag) return all[i];
    }
    return null;
  }

  function colIndex(ref) {
    var letters = String(ref || '').replace(/[^A-Za-z]/g, '').toUpperCase();
    if (!letters) return -1;
    var n = 0;
    for (var i = 0; i < letters.length; i++) {
      n = n * 26 + (letters.charCodeAt(i) - 64);
    }
    return n - 1;
  }

  function rowIndex(ref) {
    var digits = String(ref || '').replace(/[^0-9]/g, '');
    return digits ? parseInt(digits, 10) - 1 : -1;
  }

  /* 合并单元格 → [{ref,r1,c1,r2,c2}]，行列都是 0-based（与 template.js 的锚点一致） */
  function parseMerges(doc) {
    var out = [];
    var els = doc.getElementsByTagName('mergeCell');
    for (var i = 0; i < els.length; i++) {
      var ref = attrLocal(els[i], 'ref') || '';
      var parts = String(ref).split(':');
      if (parts.length !== 2) continue;
      var r1 = rowIndex(parts[0]);
      var c1 = colIndex(parts[0]);
      var r2 = rowIndex(parts[1]);
      var c2 = colIndex(parts[1]);
      if (r1 < 0 || c1 < 0 || r2 < 0 || c2 < 0) continue;
      out.push({ ref: ref, r1: r1, c1: c1, r2: r2, c2: c2 });
    }
    return out;
  }

  function cellText(c) {
    var v = firstTag(c, 'v');
    return v ? v.textContent : '';
  }

  function inlineText(c) {
    var is = firstTag(c, 'is');
    if (!is) return '';
    var out = '';
    var ts = is.getElementsByTagName('t');
    for (var i = 0; i < ts.length; i++) out += ts[i].textContent;
    return out;
  }

  function cellValue(c, shared) {
    var t = attrLocal(c, 't');
    if (t === 's') {
      var idx = parseInt(cellText(c), 10);
      return shared[idx] == null ? '' : shared[idx];
    }
    if (t === 'inlineStr') return inlineText(c);
    if (t === 'str') return cellText(c);
    if (t === 'b') return cellText(c) === '1' ? 'TRUE' : 'FALSE';
    if (t === 'e') return '';
    var raw = cellText(c);
    if (raw === '') return '';
    var n = Number(raw);
    return isFinite(n) ? n : raw;
  }

  function parseSharedStrings(text) {
    if (!text) return [];
    var doc = parseXml(text);
    var out = [];
    var sis = doc.getElementsByTagName('si');
    for (var i = 0; i < sis.length; i++) {
      var body = '';
      var ts = sis[i].getElementsByTagName('t');
      for (var j = 0; j < ts.length; j++) body += ts[j].textContent;
      out.push(body);
    }
    return out;
  }

  function parseSheet(text, shared, fillOfStyle) {
    var doc = parseXml(text);
    var dimEl = firstTag(doc, 'dimension');
    var dimension = dimEl ? (attrLocal(dimEl, 'ref') || '') : '';
    var rows = [];
    var colors = [];
    var rowEls = doc.getElementsByTagName('row');
    var maxCol = -1;

    for (var r = 0; r < rowEls.length; r++) {
      var rowEl = rowEls[r];
      var rowNo = parseInt(attrLocal(rowEl, 'r'), 10);
      if (!isFinite(rowNo) || rowNo < 1) rowNo = rows.length + 1;
      var arr = rows[rowNo - 1] || [];
      var carr = colors[rowNo - 1] || [];
      var auto = 0;
      var cellEls = rowEl.getElementsByTagName('c');
      for (var c = 0; c < cellEls.length; c++) {
        var cell = cellEls[c];
        var ref = attrLocal(cell, 'r');
        var col = ref ? colIndex(ref) : auto;
        if (col < 0) col = auto;
        auto = col + 1;
        arr[col] = cellValue(cell, shared);
        var sIdx = attrLocal(cell, 's');
        carr[col] = fillOfStyle && sIdx != null ? (fillOfStyle[parseInt(sIdx, 10)] || '') : '';
        if (col > maxCol) maxCol = col;
      }
      rows[rowNo - 1] = arr;
      colors[rowNo - 1] = carr;
    }

    for (var i = 0; i < rows.length; i++) {
      if (!rows[i]) rows[i] = [];
      if (!colors[i]) colors[i] = [];
      for (var j = 0; j <= maxCol; j++) {
        if (rows[i][j] === undefined) rows[i][j] = '';
        if (colors[i][j] === undefined) colors[i][j] = '';
      }
    }

    return { dimension: dimension, rows: rows, colors: colors, merges: parseMerges(doc), maxCol: maxCol };
  }

  /* ============ 样式 / 填充色（styles.xml + theme1.xml） ============ */

  var STANDARD_PALETTE = ('000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF ' +
    '000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF ' +
    '800000 008000 000080 808000 800080 008080 C0C0C0 808080 ' +
    '9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF ' +
    '000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF ' +
    '00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 ' +
    '3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 ' +
    '003366 339966 003300 333300 993300 993366 333399 333333').split(/\s+/);

  function hexFromRgb(rgb) {
    var t = String(rgb || '').replace(/[^0-9a-fA-F]/g, '');
    if (t.length === 8) t = t.slice(2);
    if (t.length !== 6) return '';
    return '#' + t.toUpperCase();
  }

  function rgbParts(hex) {
    var h = String(hex || '').replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function hexFromParts(r, g, b) {
    function pad(v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? '0' : '') + v.toString(16); }
    return ('#' + pad(r) + pad(g) + pad(b)).toUpperCase();
  }

  /* Excel tint：在 HSL 亮度上向白 / 向黑推，比 RGB 线性近似更接近 Excel 显示 */
  function applyTint(hex, tint) {
    if (!hex || !tint) return hex;
    var c = rgbParts(hex);
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var d = max - min;
    var s = 0;
    if (d) s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    var h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    var t = parseFloat(tint);
    l = t > 0 ? l + (1 - l) * t : l * (1 + t);
    l = Math.max(0, Math.min(1, l));
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    function hue(pv, qv, tv) {
      if (tv < 0) tv += 1;
      if (tv > 1) tv -= 1;
      if (tv < 1 / 6) return pv + (qv - pv) * 6 * tv;
      if (tv < 1 / 2) return qv;
      if (tv < 2 / 3) return pv + (qv - pv) * (2 / 3 - tv) * 6;
      return pv;
    }
    return hexFromParts(hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255);
  }

  /* Excel 的 theme 索引和 theme1.xml 里 clrScheme 的子元素书写顺序并不一致：
     单元格 theme="0" 是 lt1、1 是 dk1、2 是 lt2、3 是 dk2，4 起才轮到 accent1–6；
     clrScheme 里的书写顺序是 dk1 / lt1 / dk2 / lt2 / accent1…，必须按标签名重排。 */
  var THEME_ORDER = ['lt1', 'dk1', 'lt2', 'dk2',
    'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

  function themeColorOf(node) {
    if (!node) return '';
    var srgb = firstTag(node, 'srgbClr');
    var sys = firstTag(node, 'sysClr');
    var val = '';
    if (srgb) val = attrLocal(srgb, 'val') || '';
    else if (sys) val = attrLocal(sys, 'lastClr') || '';
    return val ? '#' + String(val).toUpperCase() : '';
  }

  function parseThemeColors(text) {
    if (!text) return [];
    var doc;
    try { doc = parseXml(text); } catch (err) { return []; }
    var scheme = firstTag(doc, 'clrScheme');
    if (!scheme) return [];
    var kids = scheme.children || [];
    var byName = {};
    for (var i = 0; i < kids.length; i++) {
      var nm = String(kids[i].localName || kids[i].nodeName || '').replace(/^.*:/, '');
      if (nm) byName[nm] = kids[i];
    }
    var out = [];
    for (var k = 0; k < THEME_ORDER.length; k++) {
      var node = byName[THEME_ORDER[k]] || null;
      if (!node && kids.length >= 4) {
        /* 兜底：拿不到标签名时按 clrScheme 的书写顺序 dk1/lt1/dk2/lt2 换回视觉索引 */
        node = kids[[1, 0, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11][k]] || null;
      }
      out.push(themeColorOf(node));
    }
    return out;
  }

  /* 返回 styleIndex → 填充色（无填充为 ''） */
  function buildFillLookup(stylesText, themeText) {
    if (!stylesText) return [];
    var doc;
    try { doc = parseXml(stylesText); } catch (err) { return []; }
    var theme = parseThemeColors(themeText);
    var indexed = [];
    var indexedBlock = firstTag(doc, 'indexedColors');
    if (indexedBlock) {
      var rgbs = indexedBlock.getElementsByTagName('rgbColor');
      for (var i = 0; i < rgbs.length; i++) indexed.push(hexFromRgb(attrLocal(rgbs[i], 'rgb')));
    }
    if (!indexed.length) indexed = STANDARD_PALETTE.map(function (h) { return '#' + h; });

    function resolveColor(el) {
      if (!el) return '';
      var tint = attrLocal(el, 'tint');
      var hex = '';
      var rgb = attrLocal(el, 'rgb');
      if (rgb) hex = hexFromRgb(rgb);
      if (!hex) {
        var idx = attrLocal(el, 'indexed');
        if (idx != null) {
          var i = parseInt(idx, 10);
          /* 0–63 才是调色板色；64/65 是「系统前景/背景」（自动色），不能当填充 */
          if (i >= 0 && i < 64) hex = indexed[i] || '';
        }
      }
      if (!hex) {
        var th = attrLocal(el, 'theme');
        if (th != null) {
          var t = parseInt(th, 10);
          if (t >= 0) hex = theme[t] || '';
        }
      }
      if (hex && tint != null) hex = applyTint(hex, tint);
      return hex;
    }

    var fills = [];
    var fillsBlock = firstTag(doc, 'fills');
    if (fillsBlock) {
      var fillEls = fillsBlock.getElementsByTagName('fill');
      for (var f = 0; f < fillEls.length; f++) {
        var fillEl = fillEls[f];
        var pattern = firstTag(fillEl, 'patternFill');
        var pType = pattern ? (attrLocal(pattern, 'patternType') || '') : '';
        if (pType === 'none') { fills.push(''); continue; }
        /* 实心填充按规范写在 fgColor；但部分第三方生成器把实色写进 bgColor，
           且 fgColor 只剩 indexed="64"（自动色），所以两侧都认、fg 优先 */
        var hex = resolveColor(firstTag(fillEl, 'fgColor'));
        if (!hex) hex = resolveColor(firstTag(fillEl, 'bgColor'));
        fills.push(hex || '');
      }
    }

    var lookup = [];
    var xfsBlock = firstTag(doc, 'cellXfs');
    if (xfsBlock) {
      var xfs = xfsBlock.getElementsByTagName('xf');
      for (var x = 0; x < xfs.length; x++) {
        var fillId = attrLocal(xfs[x], 'fillId');
        lookup.push(fillId == null ? '' : (fills[parseInt(fillId, 10)] || ''));
      }
    }
    return lookup;
  }

  /* ============ 表名 / 路径解析 ============ */

  function normTarget(target) {
    var t = String(target || '');
    if (t.charAt(0) === '/') return t.slice(1);
    if (t.indexOf('xl/') === 0) return t;
    return 'xl/' + t;
  }

  async function readWorkbook(zip) {
    var wbName = 'xl/workbook.xml';
    if (!zip.entries[wbName]) {
      var names = Object.keys(zip.entries);
      for (var i = 0; i < names.length; i++) {
        if (/workbook\.xml$/.test(names[i])) { wbName = names[i]; break; }
      }
    }
    var wbText = await readText(zip, wbName);
    if (!wbText) throw new Error('xlsx 缺少 workbook.xml');
    var doc = parseXml(wbText);
    var sheetEls = doc.getElementsByTagName('sheet');
    if (!sheetEls.length) throw new Error('xlsx 未包含任何工作表');

    var relsName = wbName.replace(/workbook\.xml$/, '_rels/workbook.xml.rels');
    var relsText = await readText(zip, relsName);
    var relMap = {};
    if (relsText) {
      var relDoc = parseXml(relsText);
      var rels = relDoc.getElementsByTagName('Relationship');
      for (var j = 0; j < rels.length; j++) {
        var rid = attrLocal(rels[j], 'Id');
        var target = attrLocal(rels[j], 'Target');
        if (rid && target) relMap[rid] = normTarget(target);
      }
    }

    var sheets = [];
    for (var k = 0; k < sheetEls.length; k++) {
      var rId = attrLocal(sheetEls[k], 'id');
      var name = attrLocal(sheetEls[k], 'name') || ('Sheet' + (k + 1));
      var path = relMap[rId] || ('xl/worksheets/sheet' + (k + 1) + '.xml');
      sheets.push({ name: name, path: path });
    }
    return {
      sheets: sheets,
      sharedPath: 'xl/sharedStrings.xml',
      fallbackShared: findShared(zip),
      stylesPath: findPart(zip, /(^|\/)styles\.xml$/)
    };
  }

  function findShared(zip) {
    var names = Object.keys(zip.entries);
    for (var i = 0; i < names.length; i++) {
      if (/sharedStrings\.xml$/.test(names[i])) return names[i];
    }
    return 'xl/sharedStrings.xml';
  }

  /* 按后缀找包内部件（styles.xml / theme1.xml 可能不在固定目录） */
  function findPart(zip, re) {
    var names = Object.keys(zip.entries);
    for (var i = 0; i < names.length; i++) {
      if (re.test(names[i])) return names[i];
    }
    return '';
  }

  async function loadFillLookup(zip, wb) {
    if (!wb.stylesPath) return { lookup: [], info: { styles: false, themeColors: 0 } };
    var stylesText = await readText(zip, wb.stylesPath);
    var themePath = findPart(zip, /(^|\/)theme1?\.xml$/) || findPart(zip, /(^|\/)theme(\d+)?\.xml$/);
    var themeText = themePath ? await readText(zip, themePath) : null;
    var theme = parseThemeColors(themeText);
    return {
      lookup: buildFillLookup(stylesText, themeText),
      info: { styles: !!stylesText, themeColors: theme.length }
    };
  }

  /* ============ 对外接口 ============ */

  function supported() {
    return typeof window.DecompressionStream === 'function';
  }

  function trimCell(v) {
    if (v == null) return '';
    if (typeof v === 'number') return v;
    return String(v).trim();
  }

  function buildTable(rows) {
    var headerRow = null;
    for (var i = 0; i < rows.length; i++) {
      var has = false;
      var arr = rows[i] || [];
      for (var j = 0; j < arr.length; j++) {
        if (String(arr[j] == null ? '' : arr[j]).trim() !== '') { has = true; break; }
      }
      if (has) { headerRow = i; break; }
    }
    if (headerRow === null) return { headers: [], rows: [], headerRow: -1, totalRows: 0 };

    var rawHeader = rows[headerRow] || [];
    var maxCol = 0;
    for (var c = 0; c < rawHeader.length; c++) {
      if (String(rawHeader[c] == null ? '' : rawHeader[c]).trim() !== '') maxCol = c + 1;
    }
    if (maxCol === 0) maxCol = rawHeader.length;

    var headers = [];
    var seen = {};
    for (var h = 0; h < maxCol; h++) {
      var name = String(trimCell(rawHeader[h]) || '').trim();
      if (!name) name = '列' + (h + 1);
      if (seen[name]) {
        seen[name] += 1;
        name = name + ' (' + seen[name] + ')';
      } else {
        seen[name] = 1;
      }
      headers.push(name);
    }

    var out = [];
    for (var r = headerRow + 1; r < rows.length; r++) {
      var src = rows[r] || [];
      var line = [];
      var empty = true;
      for (var x = 0; x < maxCol; x++) {
        var v = trimCell(src[x]);
        line.push(v);
        if (v !== '') empty = false;
      }
      if (!empty) out.push(line);
    }

    return {
      headers: headers,
      rows: out,
      headerRow: headerRow,
      totalRows: rows.length,
      maxCol: maxCol
    };
  }

  async function listSheets(buffer) {
    if (!supported()) {
      throw new Error('当前浏览器不支持 DecompressionStream，无法解压 xlsx。请改用 CSV 导入，或换用最新版 Chrome / Edge。');
    }
    var zip = readZip(buffer);
    var wb = await readWorkbook(zip);
    return wb.sheets.map(function (s) { return s.name; });
  }

  async function readSheet(buffer, sheetName) {
    if (!supported()) {
      throw new Error('当前浏览器不支持 DecompressionStream，无法解压 xlsx。请改用 CSV 导入，或换用最新版 Chrome / Edge。');
    }
    var zip = readZip(buffer);
    var wb = await readWorkbook(zip);
    var target = null;
    for (var i = 0; i < wb.sheets.length; i++) {
      if (wb.sheets[i].name === sheetName) { target = wb.sheets[i]; break; }
    }
    if (!target) target = wb.sheets[0];

    var sharedText = await readText(zip, wb.sharedPath);
    if (!sharedText) sharedText = await readText(zip, wb.fallbackShared);
    var shared = parseSharedStrings(sharedText);
    var fillRes = await loadFillLookup(zip, wb);
    var fillOf = fillRes.lookup;

    var sheetText = await readText(zip, target.path);
    if (!sheetText) throw new Error('找不到工作表数据：' + target.path);

    var parsed = parseSheet(sheetText, shared, fillOf);
    var table = buildTable(parsed.rows);
    table.sheetName = target.name;
    table.sheetNames = wb.sheets.map(function (s) { return s.name; });
    table.dimension = parsed.dimension;
    table.colorInfo = fillRes.info;
    /* 花名册导入要用原始行（保留空行与合并表头），不能用 buildTable 裁掉的行 */
    table.rawRows = parsed.rows;
    table.colors = parsed.colors;
    table.merges = parsed.merges;
    return table;
  }

  /* 一次读完整本：所有工作表（含原始行、每格填充色、行数、首行预览）。
     导入界面用来列全部工作表；只解压一次，避免每张表重读 ZIP。 */
  async function readBook(buffer) {
    if (!supported()) {
      throw new Error('当前浏览器不支持 DecompressionStream，无法解压 xlsx。请改用 CSV 导入，或换用最新版 Chrome / Edge。');
    }
    var zip = readZip(buffer);
    var wb = await readWorkbook(zip);
    if (!wb.sheets.length) throw new Error('xlsx 未包含任何工作表');

    var sharedText = await readText(zip, wb.sharedPath);
    if (!sharedText) sharedText = await readText(zip, wb.fallbackShared);
    var shared = parseSharedStrings(sharedText);
    var fillRes = await loadFillLookup(zip, wb);
    var fillOf = fillRes.lookup;

    var out = [];
    for (var i = 0; i < wb.sheets.length; i++) {
      var s = wb.sheets[i];
      var text = await readText(zip, s.path);
      if (!text) {
        out.push({ name: s.name, rows: [], colors: [], merges: [], rowCount: 0, preview: '', maxCol: 0, dimension: '', colorInfo: fillRes.info });
        continue;
      }
      var parsed = parseSheet(text, shared, fillOf);
      out.push({
        name: s.name,
        rows: parsed.rows,
        colors: parsed.colors,
        merges: parsed.merges,
        rowCount: parsed.rows.length,
        maxCol: parsed.maxCol,
        dimension: parsed.dimension,
        colorInfo: fillRes.info,
        preview: previewOf(parsed.rows)
      });
    }
    return { sheets: out, names: out.map(function (x) { return x.name; }) };
  }

  /* 首行预览：取前 8 个非空单元格文本，长文本截断 */
  function previewOf(rows) {
    for (var i = 0; i < rows.length; i++) {
      var arr = rows[i] || [];
      var parts = [];
      for (var j = 0; j < arr.length && parts.length < 8; j++) {
        var v = arr[j];
        if (v == null || String(v).trim() === '') continue;
        var t = String(v).trim();
        parts.push(t.length > 16 ? t.slice(0, 15) + '…' : t);
      }
      if (parts.length) return parts.join(' · ');
    }
    return '';
  }

  function parseCsv(text) {
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

    var nonEmpty = rows.filter(function (r) {
      return (r || []).some(function (v) { return String(v).trim() !== ''; });
    });
    var table = buildTable(nonEmpty);
    table.sheetName = 'CSV';
    table.sheetNames = ['CSV'];
    table.dimension = '';
    return table;
  }

  GM.xlsx = {
    supported: supported,
    listSheets: listSheets,
    readSheet: readSheet,
    readBook: readBook,
    parseCsv: parseCsv,
    buildFillLookup: buildFillLookup,
    colorUtils: { hexFromRgb: hexFromRgb, applyTint: applyTint }
  };
})();
