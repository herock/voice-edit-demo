/*
 * voice-edit-demo 口令解析与执行模块（纯函数 + 一个轻量 Editor 状态机）
 * 浏览器：window.VoiceCmd；Node：require('./commands.js')
 * 拼音函数通过参数注入（浏览器用 pinyin-pro UMD，Node 用 npm 包 pinyin-pro，MIT 许可）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoiceCmd = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 基础工具 ----------
  var PUNCT_CHARS = '，,。.．！!？?、；;：:…~～·\'"“”‘’「」『』《》〈〉（）()【】[\\]—\\-_ \\s\\u3000';
  var PUNCT_RE = new RegExp('[' + PUNCT_CHARS + ']', 'g');
  var EDGE_PUNCT_RE = new RegExp('^[' + PUNCT_CHARS + ']+|[' + PUNCT_CHARS + ']+$', 'g');
  var P = '[，,。.、；;：:\\s]*'; // 口令中关键词之间可能夹带的标点/空格
  var CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
  var SENT_END = '。！？!?；;…';

  var PUNCT_NAMES = {
    '句号': '。', '句点': '。', '逗号': '，', '问号': '？', '感叹号': '！', '叹号': '！',
    '惊叹号': '！', '顿号': '、', '冒号': '：', '分号': '；', '省略号': '……', '破折号': '——',
    '空格': ' '
  };
  var NEWLINE_WORDS = ['换行', '换一行', '另起一行', '回车', '新起一行', '下一行', '新段落', '换段', '分段', '另起一段', '新的一行'];

  var ONE_PUNCT_RE = new RegExp('^[' + PUNCT_CHARS + ']$');
  function isPunct(ch) { return ONE_PUNCT_RE.test(ch); }
  function stripEdges(s) { return (s || '').replace(EDGE_PUNCT_RE, ''); }
  function isCJK(ch) { return CJK_RE.test(ch); }

  function cnNum(s) {
    if (s == null || s === '') return 1;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    var map = { '零': 0, '一': 1, '幺': 1, '二': 2, '两': 2, '俩': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    if (s === '十') return 10;
    var m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
    if (m) return (m[1] ? map[m[1]] : 1) * 10 + (m[2] ? map[m[2]] : 0);
    if (s.length === 1 && s in map) return map[s];
    return NaN;
  }
  var NUM = '(\\d+|[一二两俩三四五六七八九十幺]+)';

  // 规整识别结果：去空格（中文间）、去口头语、去首尾标点
  function normalize(raw) {
    var s = String(raw || '').replace(/\u3000/g, ' ').trim();
    // 去掉中文/标点旁边的空格，保留英文单词之间的空格
    s = s.replace(/\s+/g, ' ').replace(/ /g, function (sp, off, str) {
      var a = str.charAt(off - 1), b = str.charAt(off + 1);
      return (/[\x00-\x7f]/.test(a) && /[\x00-\x7f]/.test(b)) ? ' ' : '';
    });
    var prev;
    do {
      prev = s;
      s = s.replace(/^[，,。.、\s]+/, '')
           .replace(/^(嗯+|呃+|额+|啊+|哦+|那个|就是|然后|请你|请|麻烦你|麻烦|帮我|帮忙|你|给我|我想|我要)(?=.)/, '');
    } while (s !== prev);
    s = s.replace(/[。.．！!？?，,、；;：:~～…\s]+$/, '');
    return s;
  }

  function cleanArg(s) { return stripEdges(s); }
  function mapPunctName(y) {
    var k = y.replace(/^(一个|一|个)/, '');
    if (PUNCT_NAMES[k]) return PUNCT_NAMES[k];
    if (NEWLINE_WORDS.indexOf(k) >= 0) return '\n';
    return y;
  }

  var VERB_REPLACE = '(?:改成|换成|替换成|替换为|改为|换为|修改为|修改成|更正为|更正成|纠正为|纠正成|改写成|写成)';
  var VERB_DELETE = '(?:删掉|删除|去掉|删去|删了|去了|拿掉|干掉|删)';
  var VERB_INSERT = '(?:加上|加个|加一个|加入|加|插入|插上|添加|添上|补上|补个|补|写上)';

  // ---------- 口令解析 ----------
  function parseCommand(raw) {
    var original = String(raw == null ? '' : raw);
    var s = normalize(original);
    var trimmedOrig = original.trim();
    var m;

    // 识别器把“句号”直接转成了标点：“。” 或 “加个。”
    if (s === '' && /^[。，？！、：；.,?!]$/.test(trimmedOrig)) {
      return { type: 'append', text: toCnPunct(trimmedOrig), label: punctLabel(toCnPunct(trimmedOrig)) };
    }
    m = /^(?:加|添|打|补|来|插)(?:上|个|一个|入)?([。，？！、：；.,?!])?$/.exec(s + (trimmedOrig.slice(-1).match(/[。，？！、：；.,?!]/) ? trimmedOrig.slice(-1) : ''));
    if (m && m[1] && s.length <= 3) {
      return { type: 'append', text: toCnPunct(m[1]), label: punctLabel(toCnPunct(m[1])) };
    }

    if (s === '') return { type: 'unknown', raw: original };

    // 多处匹配时的选择
    if ((m = new RegExp('^(?:选|选择|要|就)?第' + NUM + '(?:个|处|条|项)?(?:吧)?$').exec(s))) {
      var n = cnNum(m[1]);
      if (!isNaN(n)) return { type: 'choose', index: n - 1 };
    }
    if (/^(?:全部|全都|所有|都改|全部都改|全改|都要|全部改|全选|都)(?:吧)?$/.test(s)) return { type: 'choose', all: true };
    if (/^(?:取消|算了|不改了|不用了|放弃)$/.test(s)) return { type: 'choose', cancel: true };

    // 撤销
    if ((m = new RegExp('^(?:再)?(?:撤销|撤消|撤回|回退|undo)(?:一下)?(?:上一步|' + NUM + '(?:步|次))?$', 'i').exec(s))) {
      var steps = m[1] ? cnNum(m[1]) : 1;
      return { type: 'undo', steps: isNaN(steps) ? 1 : steps };
    }

    // 换行
    if (NEWLINE_WORDS.indexOf(s.replace(/^(?:加个|加一个|来个|在末尾|在最后)/, '')) >= 0) return { type: 'append', text: '\n', label: '换行' };

    // 加标点
    if ((m = /^(?:在?(?:末尾|最后|结尾))?(?:(?:加|添|打|补|来|插|写)(?:上|个|一个|入)?)?(句号|句点|逗号|问号|感叹号|叹号|惊叹号|顿号|冒号|分号|省略号|破折号)$/.exec(s))) {
      return { type: 'append', text: PUNCT_NAMES[m[1]], label: m[1] };
    }

    // 删掉最后一句 / 上一句
    if ((m = new RegExp('^(?:把)?' + VERB_DELETE + '?(?:最后|上|前|末尾)(?:的)?' + NUM + '?(?:句|句话)(?:给)?' + VERB_DELETE + '?$').exec(s))
        && /删|去|拿|干/.test(s)) {
      var ns = m[1] ? cnNum(m[1]) : 1;
      return { type: 'deleteSentence', count: isNaN(ns) ? 1 : ns };
    }
    // 删掉最后 N 个字
    if ((m = new RegExp('^' + VERB_DELETE + '(?:最后|末尾)(?:的)?' + NUM + '?个字$').exec(s))) {
      var nc = m[1] ? cnNum(m[1]) : 1;
      return { type: 'deleteChars', count: isNaN(nc) ? 1 : nc };
    }

    // 在开头/末尾加上 Y
    if ((m = new RegExp('^在?' + P + '(最后面|最后|末尾|结尾|最末尾|开头|最前面|最前|句首|文首)' + P + VERB_INSERT + P + '(.+)$').exec(s))) {
      var edge = /开头|最前|首/.test(m[1]) ? 'start' : 'end';
      var y0 = cleanArg(m[2]);
      if (y0) return { type: 'insertEdge', edge: edge, y: mapPunctName(y0) };
    }

    // 在 X 后面/前面 加上 Y
    if ((m = new RegExp('^在?' + P + '(.+?)' + P + '(?:的)?(后面|后边|之后|以后|前面|前边|之前|以前|后|前)' + P + VERB_INSERT + P + '(.+)$').exec(s))) {
      var x1 = cleanArg(m[1]), y1 = cleanArg(m[3]);
      if (x1 && y1) return { type: 'insert', x: x1, pos: /后/.test(m[2]) ? 'after' : 'before', y: mapPunctName(y1) };
    }

    // 改成 Y（作用于选区）
    if ((m = new RegExp('^(?:把)?(?:这个|这里|这段|这句|选中的|它)?' + P + VERB_REPLACE + P + '(.+)$').exec(s))) {
      var ys = cleanArg(m[1]);
      if (ys) return { type: 'replaceSelection', y: mapPunctName(ys) };
    }

    // 把 X 改成 Y
    if ((m = new RegExp('^(?:把|将)?' + P + '(所有的?|全部的?)?' + P + '(.+?)' + P + '(全部|全都|都)?' + P + VERB_REPLACE + P + '(.+)$').exec(s))) {
      var x2 = cleanArg(m[2]), y2 = cleanArg(m[4]);
      if (x2 && y2) {
        var cmd = { type: 'replace', x: x2, y: mapPunctName(y2), all: !!(m[1] || m[3]) };
        if (m[3] === '都' && !m[1]) cmd.xAlt = x2 + '都'; // “首都改成”这类，执行时消歧
        return cmd;
      }
    }

    // 删掉（作用于选区）
    if (new RegExp('^(?:把)?(?:这个|这里|这段|这句|选中的|它)?(?:给)?' + VERB_DELETE + '$').test(s)) return { type: 'deleteSelection' };

    // 把 X 删掉
    if ((m = new RegExp('^(?:把|将)' + P + '(所有的?|全部的?)?' + P + '(.+?)' + P + '(全部|全都|都)?' + P + '(?:给)?' + VERB_DELETE + '$').exec(s))) {
      var x3 = cleanArg(m[2]);
      if (x3) return { type: 'delete', x: x3, all: !!(m[1] || m[3]) };
    }
    // 删掉 X
    if ((m = new RegExp('^' + VERB_DELETE + P + '(所有的?|全部的?)?' + P + '(.+)$').exec(s))) {
      var x4 = cleanArg(m[2]);
      if (x4) return { type: 'delete', x: x4, all: !!m[1] };
    }

    return { type: 'unknown', raw: original };
  }

  function toCnPunct(c) { return ({ '.': '。', ',': '，', '?': '？', '!': '！' })[c] || c; }
  function punctLabel(c) { for (var k in PUNCT_NAMES) if (PUNCT_NAMES[k] === c) return k; return c; }

  // ---------- 定位 ----------
  function exactMatches(text, x) {
    var out = [], i = 0;
    if (!x) return out;
    while ((i = text.indexOf(x, i)) !== -1) { out.push({ start: i, end: i + x.length, matched: x }); i += x.length; }
    return out;
  }

  function tokensOf(text) { // 去掉标点空格后的字符及原位置
    var toks = [];
    for (var i = 0; i < text.length; i++) { var ch = text[i]; if (!isPunct(ch)) toks.push({ ch: ch, i: i }); }
    return toks;
  }

  function looseMatches(text, x) {
    var xs = tokensOf(x).map(function (t) { return t.ch.toLowerCase(); });
    if (!xs.length) return [];
    var toks = tokensOf(text), out = [];
    for (var s = 0; s + xs.length <= toks.length; s++) {
      var ok = true;
      for (var k = 0; k < xs.length; k++) if (toks[s + k].ch.toLowerCase() !== xs[k]) { ok = false; break; }
      if (ok) {
        var st = toks[s].i, en = toks[s + xs.length - 1].i + 1;
        out.push({ start: st, end: en, matched: text.slice(st, en) });
        s += xs.length - 1;
      }
    }
    return out;
  }

  var readingCache = {};
  function readings(ch, pinyinFn) {
    if (!isCJK(ch)) return null;
    if (readingCache[ch]) return readingCache[ch];
    var r;
    try { r = pinyinFn(ch, { multiple: true, type: 'array', toneType: 'none' }); } catch (e) { r = []; }
    if (!r || !r.length) r = [ch];
    return (readingCache[ch] = r.map(function (p) { return String(p).toLowerCase().replace(/ü/g, 'v'); }));
  }
  function fuzzSyllable(p) {
    return p.replace(/^zh/, 'z').replace(/^ch/, 'c').replace(/^sh/, 's').replace(/^n(?=[^g])/, 'l').replace(/^r/, 'l')
            .replace(/^h(?=u)/, 'f').replace(/ang$/, 'an').replace(/eng$/, 'en').replace(/ing$/, 'in');
  }
  function charLike(a, b, pinyinFn, fuzzy) {
    if (a === b || a.toLowerCase() === b.toLowerCase()) return true;
    var ra = readings(a, pinyinFn), rb = readings(b, pinyinFn);
    if (!ra || !rb) return false;
    for (var i = 0; i < ra.length; i++) for (var j = 0; j < rb.length; j++) {
      if (ra[i] === rb[j]) return true;
      if (fuzzy && fuzzSyllable(ra[i]) === fuzzSyllable(rb[j])) return true;
    }
    return false;
  }
  function pinyinMatches(text, x, pinyinFn, fuzzy) {
    if (!pinyinFn) return [];
    var xt = tokensOf(x);
    if (!xt.length || !xt.some(function (t) { return isCJK(t.ch); })) return [];
    var toks = tokensOf(text), out = [];
    for (var s = 0; s + xt.length <= toks.length; s++) {
      var ok = true;
      for (var k = 0; k < xt.length; k++) if (!charLike(toks[s + k].ch, xt[k].ch, pinyinFn, fuzzy)) { ok = false; break; }
      if (ok) {
        var st = toks[s].i, en = toks[s + xt.length - 1].i + 1;
        out.push({ start: st, end: en, matched: text.slice(st, en) });
        s += xt.length - 1;
      }
    }
    return out;
  }

  // 返回 {method: 'exact'|'loose'|'pinyin'|'pinyin-fuzzy'|null, matches}
  function findMatches(text, x, opts) {
    opts = opts || {};
    var m = exactMatches(text, x);
    if (m.length) return { method: 'exact', matches: m };
    m = looseMatches(text, x);
    if (m.length) return { method: 'loose', matches: m };
    m = pinyinMatches(text, x, opts.pinyin, false);
    if (m.length) return { method: 'pinyin', matches: m };
    m = pinyinMatches(text, x, opts.pinyin, true);
    if (m.length) return { method: 'pinyin-fuzzy', matches: m };
    return { method: null, matches: [] };
  }

  // ---------- 句子 ----------
  function lastSentenceRange(text, count) {
    count = count || 1;
    var end = text.length;
    var i = text.replace(/\s+$/, '').length; // 末尾空白不算
    var startCut = i;
    for (var c = 0; c < count; c++) {
      // 跳过末尾的句末标点与右引号
      while (i > 0 && (SENT_END.indexOf(text[i - 1]) >= 0 || '”’」』）)'.indexOf(text[i - 1]) >= 0)) i--;
      while (i > 0 && SENT_END.indexOf(text[i - 1]) < 0 && text[i - 1] !== '\n') i--;
      startCut = i;
      if (i === 0) break;
    }
    if (startCut >= end) return null;
    // 保留句子前面的换行
    return { start: startCut, end: end };
  }

  // ---------- 执行 ----------
  function methodNote(method, matches) {
    if (method === 'pinyin') return '按读音匹配到「' + uniq(matches).join('」「') + '」';
    if (method === 'pinyin-fuzzy') return '按近似读音匹配到「' + uniq(matches).join('」「') + '」';
    if (method === 'loose') return '忽略标点后匹配到「' + uniq(matches).join('」「') + '」';
    return '';
  }
  function uniq(ms) { var seen = {}, out = []; ms.forEach(function (m) { if (!seen[m.matched]) { seen[m.matched] = 1; out.push(m.matched); } }); return out; }
  function show(s) { return s === '\n' ? '换行' : s; }

  // 对若干目标区间执行编辑，返回新文本和变化区间（新文本坐标）
  function applyToTargets(text, cmd, targets) {
    var sorted = targets.slice().sort(function (a, b) { return a.start - b.start; });
    var out = '', last = 0, changes = [];
    sorted.forEach(function (t) {
      out += text.slice(last, t.start);
      var seg = text.slice(t.start, t.end), ins;
      if (cmd.type === 'replace' || cmd.type === 'replaceSelection') {
        changes.push({ start: out.length, end: out.length + cmd.y.length, kind: 'replace' });
        out += cmd.y;
      } else if (cmd.type === 'delete' || cmd.type === 'deleteSelection') {
        changes.push({ start: out.length, end: out.length, kind: 'delete' });
      } else if (cmd.type === 'insert') {
        ins = cmd.y;
        if (cmd.pos === 'before') { changes.push({ start: out.length, end: out.length + ins.length, kind: 'insert' }); out += ins + seg; }
        else { out += seg; changes.push({ start: out.length, end: out.length + ins.length, kind: 'insert' }); out += ins; }
      }
      last = t.end;
    });
    out += text.slice(last);
    return { text: out, changes: changes };
  }

  function describe(cmd, n) {
    var cnt = n > 1 ? '（' + n + ' 处）' : '';
    switch (cmd.type) {
      case 'replace': return '把「' + cmd.x + '」改成「' + show(cmd.y) + '」' + cnt;
      case 'replaceSelection': return '把选中的文字改成「' + show(cmd.y) + '」';
      case 'delete': return '删掉「' + cmd.x + '」' + cnt;
      case 'deleteSelection': return '删掉选中的文字';
      case 'insert': return '在「' + cmd.x + '」' + (cmd.pos === 'after' ? '后面' : '前面') + '加上「' + show(cmd.y) + '」' + cnt;
      default: return '';
    }
  }


  // ---------- 拆字说法：弓长张、立早章、木子李…… ----------
  // 识别常把最后一个字听成同音字（如「弓长章」），所以最后一个字按读音比对
  var CHAIZI = { '弓长': '张', '立早': '章', '木子': '李', '十八子': '李', '口天': '吴', '耳东': '陈', '古月': '胡',
    '双木': '林', '双口': '吕', '言午': '许', '人可': '何', '禾口': '程', '走肖': '赵', '文刀': '刘', '草头': '黄',
    '女生': '姓', '子小': '孙', '日月': '明', '三水': '淼', '王白': '皇', '金字旁的': '', '提手旁的': '' };
  function resolveChaizi(s, pinyinFn) {
    if (!s) return { text: s, hits: [] };
    var hits = [];
    var keys = Object.keys(CHAIZI).filter(function (k) { return CHAIZI[k]; }).sort(function (a, b) { return b.length - a.length; });
    var out = s;
    keys.forEach(function (k) {
      var target = CHAIZI[k], idx = 0;
      while ((idx = out.indexOf(k, idx)) >= 0) {
        var c = out.charAt(idx + k.length);
        var ok = c === target || (c && pinyinFn && (readings(c, pinyinFn) || []).some(function (r) { return (readings(target, pinyinFn) || []).indexOf(r) >= 0; }));
        if (ok) { hits.push(k + c + '→' + target); out = out.slice(0, idx) + target + out.slice(idx + k.length + 1); idx += 1; }
        else idx += k.length;
      }
    });
    return { text: out, hits: hits };
  }
  function chaiziCmd(cmd, pinyinFn) {
    var c = Object.assign({}, cmd), hits = [];
    ['x', 'y'].forEach(function (f) { if (typeof c[f] === 'string') { var r = resolveChaizi(c[f], pinyinFn); c[f] = r.text; hits = hits.concat(r.hits); } });
    return { cmd: c, hits: hits };
  }

  /**
   * 执行一条已解析的口令（不含撤销/选择，这两种由 Editor 处理）。
   * state: {text, selection: {start,end}|null}
   * 返回 {status:'ok', text, changes, desc, note, method}
   *    | {status:'choose', cmd, matches, method, note, desc}
   *    | {status:'error', message}
   */
  function applyCommand(state, cmd, opts) {
    opts = opts || {};
    var text = state.text || '';
    var sel = state.selection && state.selection.end > state.selection.start ? state.selection : null;
    var cz = chaiziCmd(cmd, opts.pinyin); cmd = cz.cmd;
    var r0 = applyCommandInner(text, sel, cmd, opts);
    if (cz.hits.length && r0.status !== 'error') r0.note = (r0.note ? r0.note + '；' : '') + '按拆字理解：' + cz.hits.join('，');
    if (cz.hits.length && r0.status === 'error') r0.message += '（已按拆字理解：' + cz.hits.join('，') + '）';
    return r0;
  }
  function applyCommandInner(text, sel, cmd, opts) {
    switch (cmd.type) {
      case 'append': {
        var t = text + cmd.text;
        return { status: 'ok', text: t, changes: [{ start: text.length, end: t.length, kind: 'insert' }], desc: cmd.text === '\n' ? '在末尾换行' : '在末尾加' + cmd.label + '「' + cmd.text + '」' };
      }
      case 'insertEdge': {
        if (cmd.edge === 'start') return { status: 'ok', text: cmd.y + text, changes: [{ start: 0, end: cmd.y.length, kind: 'insert' }], desc: '在开头加上「' + show(cmd.y) + '」' };
        return { status: 'ok', text: text + cmd.y, changes: [{ start: text.length, end: text.length + cmd.y.length, kind: 'insert' }], desc: '在末尾加上「' + show(cmd.y) + '」' };
      }
      case 'deleteSentence': {
        var r = lastSentenceRange(text, cmd.count);
        if (!r) return { status: 'error', message: '正文是空的，没有可删的句子' };
        var removed = text.slice(r.start, r.end);
        var nt = text.slice(0, r.start);
        return { status: 'ok', text: nt, changes: [{ start: nt.length, end: nt.length, kind: 'delete' }], desc: '删掉' + (cmd.count > 1 ? '最后 ' + cmd.count + ' 句' : '最后一句') + '「' + removed.trim() + '」' };
      }
      case 'deleteChars': {
        if (!text.length) return { status: 'error', message: '正文是空的' };
        var cut = Math.max(0, text.length - cmd.count);
        return { status: 'ok', text: text.slice(0, cut), changes: [{ start: cut, end: cut, kind: 'delete' }], desc: '删掉最后 ' + (text.length - cut) + ' 个字「' + text.slice(cut) + '」' };
      }
      case 'replaceSelection':
      case 'deleteSelection': {
        if (!sel) return { status: 'error', message: '没有选中的文字。请先在正文里选中一段，再说“改成…”或“删掉”' };
        var res = applyToTargets(text, cmd, [sel]);
        return { status: 'ok', text: res.text, changes: res.changes, desc: describe(cmd, 1) + '（原文「' + text.slice(sel.start, sel.end) + '」）' };
      }
      case 'replace':
      case 'delete':
      case 'insert': {
        var x = cmd.x, all = cmd.all;
        if (cmd.xAlt && text.indexOf(cmd.xAlt) >= 0) { x = cmd.xAlt; all = false; cmd = Object.assign({}, cmd, { x: x, all: false }); }
        var found = findMatches(text, x, opts);
        if (!found.matches.length) return { status: 'error', message: '正文里没找到「' + x + '」' + (opts.pinyin ? '（也没有读音相同或相近的）' : '（拼音库未加载，未做读音匹配）') };
        var note = methodNote(found.method, found.matches);
        if (found.matches.length > 1 && !all) {
          return { status: 'choose', cmd: cmd, matches: found.matches, method: found.method, note: note, desc: describe(cmd, 1) };
        }
        var res2 = applyToTargets(text, cmd, found.matches);
        return { status: 'ok', text: res2.text, changes: res2.changes, desc: describe(cmd, found.matches.length), note: note, method: found.method };
      }
      default:
        return { status: 'error', message: '没听懂' };
    }
  }

  // ---------- Editor：文本 + 撤销栈 + 待选状态 ----------
  function Editor(opts) {
    opts = opts || {};
    this.text = opts.text || '';
    this.pinyin = opts.pinyin || null;
    this.history = [];
    this.pending = null; // {cmd, matches, method, note}
    this.maxHistory = opts.maxHistory || 200;
  }
  Editor.prototype._commit = function (newText, desc) {
    this.history.push({ text: this.text, desc: desc });
    if (this.history.length > this.maxHistory) this.history.shift();
    this.text = newText;
  };
  Editor.prototype.setText = function (t, record) {
    if (t === this.text) return;
    if (record) this._commit(t, '手动编辑'); else this.text = t;
  };
  Editor.prototype.dictate = function (piece) {
    piece = String(piece || '');
    if (!piece.trim()) return { status: 'error', message: '没识别到文字' };
    var start = this.text.length;
    this._commit(this.text + piece, '听写');
    return { status: 'ok', text: this.text, changes: [{ start: start, end: this.text.length, kind: 'insert' }], desc: '追加听写文字' };
  };
  Editor.prototype.undo = function (steps) {
    steps = steps || 1;
    if (!this.history.length) return { status: 'error', message: '没有可以撤销的操作了' };
    var done = 0, descs = [];
    while (done < steps && this.history.length) { var h = this.history.pop(); this.text = h.text; descs.push(h.desc); done++; }
    return { status: 'ok', text: this.text, changes: [], desc: '撤销 ' + done + ' 步（' + descs.join('、') + '）' + (done < steps ? '，已经撤到最早' : '') };
  };
  Editor.prototype.choose = function (choice) {
    var p = this.pending;
    if (!p) return { status: 'error', message: '现在没有需要选择的位置' };
    if (choice === 'cancel') { this.pending = null; return { status: 'ok', text: this.text, changes: [], desc: '已取消，正文没改' }; }
    var targets;
    if (choice === 'all') targets = p.matches;
    else {
      if (choice < 0 || choice >= p.matches.length) return { status: 'error', message: '只有 ' + p.matches.length + ' 处，没有第 ' + (choice + 1) + ' 个' };
      targets = [p.matches[choice]];
    }
    var res = applyToTargets(this.text, p.cmd, targets);
    var desc = describe(p.cmd, targets.length) + (choice === 'all' ? '' : '（第 ' + (choice + 1) + ' 处）');
    this._commit(res.text, desc);
    this.pending = null;
    return { status: 'ok', text: this.text, changes: res.changes, desc: desc, note: p.note, method: p.method };
  };
  // 处理一条改字口令（识别原文）
  Editor.prototype.command = function (raw, selection) {
    var cmd = parseCommand(raw);
    var r = this.run(cmd, selection);
    r.heard = raw; r.cmd = cmd;
    return r;
  };
  Editor.prototype.run = function (cmd, selection) {
    if (cmd.type === 'unknown') return { status: 'error', message: '没听懂', unknown: true };
    if (cmd.type === 'choose') {
      if (!this.pending) return { status: 'error', message: '现在没有需要选择的位置' };
      return this.choose(cmd.cancel ? 'cancel' : cmd.all ? 'all' : cmd.index);
    }
    this.pending = null; // 说了新口令，放弃之前的待选
    if (cmd.type === 'undo') return this.undo(cmd.steps);
    var r = applyCommand({ text: this.text, selection: selection }, cmd, { pinyin: this.pinyin });
    if (r.status === 'ok') this._commit(r.text, r.desc);
    else if (r.status === 'choose') this.pending = { cmd: r.cmd, matches: r.matches, method: r.method, note: r.note };
    return r;
  };

  return {
    normalize: normalize, parseCommand: parseCommand, findMatches: findMatches,
    applyCommand: applyCommand, applyToTargets: applyToTargets, lastSentenceRange: lastSentenceRange,
    cnNum: cnNum, Editor: Editor, PUNCT_NAMES: PUNCT_NAMES
  };
});
