(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var KEY_TEXT = 'voice-edit-demo:text', KEY_MODE = 'voice-edit-demo:mode';
  var ua = navigator.userAgent;
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS) document.documentElement.classList.add('ios');

  var pinyinFn = (window.pinyinPro && window.pinyinPro.pinyin) || null;
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
                set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

  var editor = new VoiceCmd.Editor({ text: store.get(KEY_TEXT) || '', pinyin: pinyinFn });
  var ta = $('editor'), backdrop = $('backdrop');
  var mode = store.get(KEY_MODE) === 'edit' ? 'edit' : 'dictate';
  var selection = null;      // {start,end} 最近一次在正文里的选区
  var manualBurst = false;   // 一段连续手动输入只记一条撤销
  var highlight = null, hlTimer = null;

  // ---------- 渲染 ----------
  function esc(s) { return s.replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  var CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
  function renderBackdrop() {
    var text = editor.text, marks = [];
    if (editor.pending) editor.pending.matches.forEach(function (m, i) { marks.push({ start: m.start, end: m.end, cls: 'cand', badge: CIRCLED[i] || String(i + 1) }); });
    else if (highlight) highlight.forEach(function (c) { marks.push({ start: c.start, end: c.end, cls: c.end > c.start ? 'hl' : 'hl-del' }); });
    else if (selection && selection.end > selection.start && document.activeElement !== ta) marks.push({ start: selection.start, end: selection.end, cls: 'sel' });
    marks.sort(function (a, b) { return a.start - b.start; });
    var html = '', last = 0;
    marks.forEach(function (m) {
      if (m.start < last) return;
      html += esc(text.slice(last, m.start));
      html += '<mark class="' + m.cls + '">' + (m.badge ? '<span class="badge">' + m.badge + '</span>' : '') + esc(text.slice(m.start, m.end)) + '</mark>';
      last = m.end;
    });
    html += esc(text.slice(last)) + '\n ';
    backdrop.innerHTML = html;
    var first = backdrop.querySelector('mark');
    if (first && (highlight || editor.pending)) {
      var top = first.offsetTop - 40;
      if (top < ta.scrollTop || first.offsetTop > ta.scrollTop + ta.clientHeight - 40) ta.scrollTop = Math.max(0, top);
    }
    backdrop.scrollTop = ta.scrollTop;
  }
  function syncText() {
    if (ta.value !== editor.text) ta.value = editor.text;
    store.set(KEY_TEXT, editor.text);
    renderBackdrop();
  }
  function flash(changes) {
    highlight = changes && changes.length ? changes : null;
    clearTimeout(hlTimer);
    if (highlight) hlTimer = setTimeout(function () { highlight = null; renderBackdrop(); }, 3500);
  }
  function setSelection(s) {
    selection = s && s.end > s.start ? s : null;
    var chip = $('selChip');
    if (selection) { chip.hidden = false; $('selText').textContent = '已选中「' + editor.text.slice(selection.start, selection.end) + '」→ 改字模式下说“改成…”或“删掉”'; }
    else chip.hidden = true;
  }

  // ---------- 模式 ----------
  function setMode(m) {
    mode = m; store.set(KEY_MODE, m);
    document.body.className = 'mode-' + m;
    $('modeDictate').classList.toggle('active', m === 'dictate');
    $('modeEdit').classList.toggle('active', m === 'edit');
    $('modeDictate').setAttribute('aria-checked', m === 'dictate');
    $('modeEdit').setAttribute('aria-checked', m === 'edit');
    document.querySelector('meta[name=theme-color]').content = m === 'edit' ? '#e65100' : '#1565c0';
    $('simInput').placeholder = m === 'edit' ? '例：把张三改成章三' : '例：今天下午三点开会。';
    updateRecBtn();
  }
  $('modeDictate').onclick = function () { setMode('dictate'); };
  $('modeEdit').onclick = function () { setMode('edit'); };

  // ---------- 结果与日志 ----------
  function now() { var d = new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2); }
  function addLog(m, heard, r) {
    var li = document.createElement('li');
    var label = m === 'dictate' ? '<span class="m d">听写</span>' : m === 'edit' ? '<span class="m e">改字</span>' : '<span class="m o">操作</span>';
    var body = '';
    if (heard != null) body += '听到「' + esc(heard) + '」→ ';
    if (r.status === 'ok') body += '<span class="ok">✅ ' + esc(r.desc || '') + '</span>' + (r.note ? '<span class="tag">' + esc(r.note) + '</span>' : '');
    else if (r.status === 'choose') body += '<span>❓ 找到 ' + r.matches.length + ' 处，等待选择</span>' + (r.note ? '<span class="tag">' + esc(r.note) + '</span>' : '');
    else body += '<span class="bad">⚠️ ' + esc(r.message) + (r.unknown ? '，正文没改' : '') + '</span>';
    li.innerHTML = '<span class="t">' + now() + '</span>' + label + body;
    var log = $('log'); log.insertBefore(li, log.firstChild);
    while (log.children.length > 60) log.removeChild(log.lastChild);
  }
  function showResult(heard, r) {
    var box = $('result'); box.hidden = false;
    box.className = 'result' + (r.status === 'error' ? ' err' : r.status === 'choose' ? ' ask' : '');
    var h = heard != null ? '<div class="heard">听到：「' + esc(heard) + '」</div>' : '';
    var main;
    if (r.status === 'ok') main = '✅ ' + esc(r.desc || '') + (r.note ? ' <span class="tag">⚠️ ' + esc(r.note) + '</span>' : '') + (r.changes && r.changes.length ? ' <button class="undo-inline" id="undoInline">撤销</button>' : '');
    else if (r.status === 'choose') main = '❓ ' + esc(r.desc) + '：找到 ' + r.matches.length + ' 处，请选择' + (r.note ? ' <span class="tag">⚠️ ' + esc(r.note) + '</span>' : '');
    else main = (r.unknown ? '🤔 没听懂，正文没改。' : '⚠️ ' + esc(r.message));
    box.innerHTML = h + '<div>' + main + '</div>';
    var u = $('undoInline'); if (u) u.onclick = function () { apply(null, 'other', editor.undo(1)); };
  }
  function renderChoice() {
    var p = editor.pending, box = $('choice');
    if (!p) { box.hidden = true; return; }
    box.hidden = false;
    $('choiceTitle').innerHTML = esc(describePending(p)) + '：正文里有 ' + p.matches.length + ' 处（橙色编号）。点一下选择，或说“第二个”“全部”“取消”。' + (p.note ? '<br><span class="tag">⚠️ ' + esc(p.note) + '</span>' : '');
    var btns = $('choiceBtns'); btns.innerHTML = '';
    p.matches.forEach(function (m, i) {
      var b = document.createElement('button');
      b.textContent = (CIRCLED[i] || (i + 1)) + ' ' + (m.matched.length > 6 ? m.matched.slice(0, 6) + '…' : m.matched);
      b.onclick = function () { apply('点选第 ' + (i + 1) + ' 处', 'edit', editor.choose(i)); };
      btns.appendChild(b);
    });
    var all = document.createElement('button'); all.className = 'all'; all.textContent = '全部 ' + p.matches.length + ' 处';
    all.onclick = function () { apply('点选全部', 'edit', editor.choose('all')); }; btns.appendChild(all);
    var c = document.createElement('button'); c.className = 'cancel'; c.textContent = '取消';
    c.onclick = function () { apply('点选取消', 'edit', editor.choose('cancel')); }; btns.appendChild(c);
  }
  function describePending(p) {
    var c = p.cmd;
    if (c.type === 'replace') return '把「' + c.x + '」改成「' + (c.y === '\n' ? '换行' : c.y) + '」';
    if (c.type === 'delete') return '删掉「' + c.x + '」';
    if (c.type === 'insert') return '在「' + c.x + '」' + (c.pos === 'after' ? '后面' : '前面') + '加上「' + c.y + '」';
    return '执行口令';
  }
  // 统一入口：把结果反映到界面
  function apply(heard, m, r) {
    if (r.status === 'ok') { manualBurst = false; setSelection(null); flash(r.changes); }
    if (r.status === 'choose') flash(null);
    syncText(); renderChoice(); showResult(heard, r); addLog(m, heard, r);
  }
  function handleUtterance(text, m) {
    text = String(text || '');
    if (!text.trim()) { var r0 = { status: 'error', message: '没识别到内容' }; showResult('', r0); addLog(m, '', r0); return; }
    if (m === 'dictate') apply(text, 'dictate', editor.dictate(text));
    else apply(text, 'edit', editor.command(text, selection));
  }

  // ---------- 正文编辑与选区 ----------
  ta.addEventListener('input', function () {
    editor.pending = null; renderChoice();
    editor.setText(ta.value, !manualBurst); manualBurst = true;
    highlight = null; setSelection(null);
    store.set(KEY_TEXT, editor.text); renderBackdrop();
  });
  function captureSel() {
    if (document.activeElement !== ta) return;
    setSelection({ start: ta.selectionStart, end: ta.selectionEnd });
  }
  document.addEventListener('selectionchange', captureSel);
  ['select', 'keyup', 'mouseup', 'touchend'].forEach(function (ev) { ta.addEventListener(ev, function () { setTimeout(captureSel, 0); }); });
  ta.addEventListener('focus', function () { manualBurst = false; renderBackdrop(); });
  ta.addEventListener('blur', function () { manualBurst = false; renderBackdrop(); });
  ta.addEventListener('scroll', function () { backdrop.scrollTop = ta.scrollTop; });
  $('selClear').onclick = function () { setSelection(null); renderBackdrop(); };

  // ---------- 按钮 ----------
  $('undoBtn').onclick = function () { apply(null, 'other', editor.undo(1)); };
  $('clearBtn').onclick = function () {
    if (!editor.text) return;
    editor.pending = null; editor._commit('', '清空');
    apply(null, 'other', { status: 'ok', desc: '已清空（可以点撤销恢复）', changes: [] });
  };
  $('copyBtn').onclick = function () {
    var text = editor.text;
    function fallback() {
      ta.focus(); ta.setSelectionRange(0, text.length);
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      addLog('other', null, ok ? { status: 'ok', desc: '已复制全文（兜底方式）' } : { status: 'error', message: '自动复制失败，已帮你选中全文，请长按手动拷贝' });
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        addLog('other', null, { status: 'ok', desc: '已复制全文（' + text.length + ' 字）' });
        var b = $('copyBtn'); b.textContent = '✅ 已复制'; setTimeout(function () { b.textContent = '📋 复制全文'; }, 1500);
      }, fallback);
    } else fallback();
  };
  $('simBtn').onclick = function () { var v = $('simInput').value; if (!v.trim()) return; handleUtterance(v, mode); $('simInput').value = ''; };
  $('simInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('simBtn').onclick(); } });
  ['把张三改成章三', '把甲方改成乙方', '删掉最后一句', '在违约责任后面加上及赔偿损失', '加个句号', '换行', '撤销', '第二个', '全部', '把张山改成李四', '改成王五', '删掉'].forEach(function (t) {
    var b = document.createElement('button'); b.textContent = t;
    b.onclick = function () { $('simInput').value = t; if (mode !== 'edit') setMode('edit'); $('simInput').focus(); };
    $('chips').appendChild(b);
  });
  $('sampleBtn').onclick = function () {
    editor.pending = null; editor._commit('甲方章三与乙方李四签订本合同。甲方应于五月前付款，甲方逾期的，承担违约责任。乙方收到款项后开具发票。', '载入示例');
    apply(null, 'other', { status: 'ok', desc: '载入示例正文', changes: [{ start: 0, end: editor.text.length }] });
  };

  // ---------- 语音识别 ----------
  // iOS 27 WebKit 回归（bugs.webkit.org/show_bug.cgi?id=321436）：同一页面第二次起的识别会“聋掉”
  // （start/audiostart 都触发、麦克风灯亮，但没有任何结果和错误）。
  // 所以整页只在第一次点击时 start() 一次（continuous），之后一直开着；
  // 大按钮只用来标记“段”的开始/结束：第一下开始录入，第二下结束并执行。绝不自动执行。
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null, recCount = 0, alive = false, everStarted = false, starting = false;
  var base = '', cur = '';                 // 累计转写 = 之前实例留下的 base + 当前实例的 cur
  var capturing = false, processing = false, segMode = 'dictate', segStart = 0, segSnap = '', segLastSeen = '', segBeganAt = 0;
  var curRaw = [], curFinal = [], segIdx = 0, segTailLen = 0, segCarry = '';  // 按结果下标定位段起点（兜底用）
  var lastResultAt = 0, deafTimer = null, graceTimer = null, sessionDied = false;
  var GRACE_MS = 700, DEAF_MS = 6000;
  var ERRORS = {
    'not-allowed': '没有麦克风或语音识别权限。请在弹窗里选“允许”；如果之前拒绝过：点地址栏左侧「大小」图标 › 网站设置 › 麦克风 › 允许，或 设置 › Safari › 麦克风。',
    'service-not-allowed': '系统语音识别不可用。请到 设置 › 通用 › 键盘，打开「启用听写」（或打开 Siri），然后刷新重试。也可能是在微信等 App 内置浏览器里，请改用 Safari。',
    'no-speech': '没听到说话声。',
    'audio-capture': '麦克风用不了（可能正被通话或其他 App 占用）。',
    'network': '网络出错：iOS 语音识别可能需要联网。',
    'language-not-supported': '当前系统不支持中文（zh-CN）识别。'
  };

  // 调试行：最近的识别事件 + 相对时间
  var dbgT0 = 0, dbgEvents = [];
  function dbg(ev) {
    var t = Date.now(); if (!dbgT0) dbgT0 = t;
    dbgEvents.push('+' + ((t - dbgT0) / 1000).toFixed(1) + 's ' + ev);
    if (dbgEvents.length > 40) dbgEvents.shift();
    var el = $('dbgText'); if (el) el.textContent = dbgEvents.slice(-14).join('  ·  ');
    var s = $('dbgSum'); if (s) s.textContent = '识别事件（实例 ' + recCount + '，' + (alive ? '运行中' : '未运行') + '）：' + ev;
  }
  window.__vedDebug = function () { return { events: dbgEvents.slice(), recCount: recCount, alive: alive, capturing: capturing, transcript: base + cur }; };

  function full() { return base + cur; }
  // 从 event.results 拼出当前实例的完整转写（iOS 会推重复/累积型的结果，要去重）
  function joinResults(results) {
    var parts = [];
    for (var i = 0; i < results.length; i++) {
      var t = results[i] && results[i][0] ? results[i][0].transcript : '';
      if (!t) continue;
      var joined = parts.join('');
      if (parts.length && parts[parts.length - 1] === t) continue;           // iOS 重复结果
      if (joined && t.indexOf(joined) === 0) { parts = [t]; continue; }       // 累积型结果
      parts.push(t);
    }
    return parts.join('');
  }
  // 取本段文字：正常情况下就是 full().slice(segStart)；
  // 如果 iOS 改写了段开始之前的结果（转写变短/变样），改用“段开始时的结果下标”定位
  function segmentText() {
    var f = full(), t;
    if (f.length >= segStart && f.slice(0, segStart) === segSnap) t = f.slice(segStart);
    else {
      var arr = curRaw.slice(segIdx);
      if (arr.length && segTailLen) arr[0] = arr[0].slice(segTailLen);
      t = joinResults(arr.map(function (x) { return [{ transcript: x }]; }));
    }
    t = (segCarry + t).replace(/^[\s，。、,.！？!?；;：:]+/, '');
    return t;
  }
  function markSegStart() {
    segSnap = full(); segStart = segSnap.length;
    var n = curRaw.length;
    if (n && !curFinal[n - 1]) { segIdx = n - 1; segTailLen = curRaw[n - 1].length; } else { segIdx = n; segTailLen = 0; }
  }

  function updateRecBtn() {
    var b = $('recBtn'), lbl;
    b.classList.toggle('on', capturing && !processing);
    $('recIcon').textContent = capturing ? '■' : '●';
    if (processing) lbl = '正在处理…';
    else if (capturing && !alive) lbl = '识别断了，点一下接着听';
    else if (capturing) lbl = segMode === 'edit' ? '正在听口令…说完点一下执行' : '正在听…说完点一下';
    else if (everStarted && !alive) lbl = '识别断了，点一下重新开始';
    else lbl = '点一下开始说';
    $('recLabel').textContent = lbl;
    if (!SR) { b.disabled = true; $('recLabel').textContent = '此浏览器不支持语音识别'; }
  }
  function live() {
    var box = $('live');
    box.hidden = !capturing;
    if (!capturing) return;
    var t = segmentText() || segLastSeen;
    $('liveText').textContent = t || (alive ? '正在听…' : '（识别断了）');
    var showExec = !alive && !processing && !!(t && t.trim());
    $('execNow').hidden = !showExec;
  }
  function setHint(msg) { var h = $('hint'); h.hidden = !msg; h.textContent = msg || ''; }

  function createRec() {
    var r = new SR();
    r.lang = 'zh-CN';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    var id = ++recCount;
    r.onstart = function () { dbg('#' + id + ' start'); };
    r.onaudiostart = function () { dbg('#' + id + ' audiostart'); };
    r.onspeechstart = function () { dbg('#' + id + ' speechstart'); };
    r.onspeechend = function () { dbg('#' + id + ' speechend'); };
    r.onnomatch = function () { dbg('#' + id + ' nomatch'); };
    r.onresult = function (e) {
      if (r !== rec) return;
      lastResultAt = Date.now();
      curRaw = []; curFinal = [];
      for (var q = 0; q < e.results.length; q++) { curRaw.push(e.results[q] && e.results[q][0] ? e.results[q][0].transcript || '' : ''); curFinal.push(!!e.results[q].isFinal); }
      var next = joinResults(e.results);
      var fin = 0; for (var j = 0; j < e.results.length; j++) if (e.results[j].isFinal) fin++;
      dbg('#' + id + ' result(' + e.results.length + (fin ? ',final' + fin : '') + ')');
      if (!next.trim()) return;               // iOS 有时推空结果，别清掉已识别的内容
      cur = next;
      if (capturing) { setHint(''); var st = segmentText(); if (st) segLastSeen = st; live(); }
    };
    r.onerror = function (e) {
      dbg('#' + id + ' error:' + e.error);
      if (r !== rec || e.error === 'aborted') return;
      var fatal = e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'language-not-supported';
      if (fatal) showBanner(ERRORS[e.error], true);
      else addLog(capturing ? segMode : 'other', null, { status: 'error', message: (ERRORS[e.error] || ('语音识别出错：' + e.error)) + ' 识别断了，点一下重新开始' });
    };
    r.onend = function () {
      dbg('#' + id + ' end');
      if (r !== rec) return;
      // iOS 自己结束了：不自动重开（不在用户手势里重开会更容易“聋”），等用户下一次点击
      alive = false; sessionDied = true;
      if (capturing) segCarry = segmentText();   // 段内已听到的保留，下个实例接着拼
      base = full(); cur = ''; curRaw = []; curFinal = [];
      if (capturing) markSegStart();
      clearTimeout(deafTimer); setHint('');
      updateRecBtn(); live();
    };
    return r;
  }
  // 在点击（用户手势）里同步调用 start()；失败的话按 300/1000/2000ms 重试一轮，不会无限循环
  function startSession(onOk) {
    if (starting) return;
    if (rec) { var old = rec; rec = null; try { old.onresult = old.onend = old.onerror = null; old.abort(); } catch (e) {} }
    base = full(); cur = ''; curRaw = []; curFinal = [];
    if (capturing) markSegStart();
    try { rec = createRec(); } catch (e) { showResult(null, { status: 'error', message: '无法创建语音识别：' + e.message }); return; }
    var delays = [0, 300, 1000, 2000], k = 0, r = rec;
    starting = true;
    (function attempt() {
      if (r !== rec) { starting = false; return; }
      try {
        r.start();
        starting = false; alive = true; everStarted = true; sessionDied = false;
        dbg('#' + recCount + ' start()调用' + (k ? '（第' + (k + 1) + '次）' : ''));
        updateRecBtn();
        if (onOk) onOk();
      } catch (e) {
        dbg('#' + recCount + ' start()失败:' + (e && e.name || e));
        k++;
        if (k < delays.length) setTimeout(attempt, delays[k]);
        else { starting = false; alive = false; everStarted = true; updateRecBtn(); setHint('启动语音识别失败，请刷新页面后再试'); }
      }
    })();
  }
  function armDeaf() {
    clearTimeout(deafTimer);
    var began = segBeganAt;
    deafTimer = setTimeout(function () {
      if (capturing && alive && !processing && lastResultAt < began) setHint('好像没在听，可能是 iOS 的已知问题，刷新页面后再试');
    }, DEAF_MS);
  }
  function beginSegment() {
    capturing = true; segMode = mode;
    segCarry = ''; markSegStart(); segLastSeen = ''; segBeganAt = Date.now();
    dbg('tap:开始段(' + (segMode === 'edit' ? '改字' : '听写') + ')');
    setHint(''); armDeaf(); updateRecBtn(); live();
  }
  function endSegment() {
    processing = true; clearTimeout(deafTimer); setHint('');
    dbg('tap:结束段');
    updateRecBtn(); live();
    // 留一点时间让最后几个字的结果到达，然后执行
    graceTimer = setTimeout(function () {
      var t = segmentText() || segLastSeen, m = segMode;
      capturing = false; processing = false;
      updateRecBtn(); live();
      if (t.trim()) handleUtterance(t, m);
      else { var r1 = { status: 'error', message: '这次没识别到文字，请再点一下重说' }; showResult(null, r1); addLog(m, null, r1); }
    }, alive ? GRACE_MS : 0);
  }
  function onRecTap() {
    if (!SR || processing || starting) return;
    if (!capturing) {
      if (!alive) {
        // 首次：启动整页唯一的会话；之后只有 iOS 自己结束了才在这次点击里重开一个
        startSession(beginSegment);
        return;
      }
      beginSegment();
    } else if (!alive) {
      // 正在录入时识别断了：点一下在手势里重开，接着录这一段（已听到的保留）
      startSession(function () {
        segBeganAt = Date.now(); armDeaf(); updateRecBtn(); live();
      });
    } else endSegment();
  }
  $('recBtn').onclick = onRecTap;
  $('execNow').onclick = function () { if (capturing && !alive && !processing) endSegment(); };
  document.addEventListener('visibilitychange', function () { dbg(document.hidden ? 'page:hidden' : 'page:visible'); });

  // ---------- 兼容性检查 ----------
  function showBanner(html, isErr) { var b = $('banner'); b.hidden = false; b.className = 'banner' + (isErr ? ' err' : ''); b.innerHTML = html; }
  var warn = [];
  if (!window.isSecureContext) warn.push('当前不是 HTTPS 页面，浏览器不会给麦克风权限。');
  if (/MicroMessenger|QQ\/|Weibo|DingTalk|Lark|Feishu/i.test(ua)) warn.push('你在 App 内置浏览器里，语音识别通常用不了。请点右上角「…」选择「在 Safari 中打开」。');
  else if (isIOS && /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) warn.push('iPhone 上的 Chrome/Edge/Firefox 可能用不了网页语音识别，建议用 Safari 打开。');
  if (navigator.standalone) warn.push('从主屏幕图标打开的网页版不支持语音识别，请直接在 Safari 里打开。');
  if (!SR) warn.push('这个浏览器不支持网页语音识别（Web Speech API）。可以用下面的“打字模拟语音”测试口令。');
  if (!pinyinFn) warn.push('拼音库没加载成功，同音字匹配暂时不可用。');
  if (warn.length) showBanner(warn.join('<br>'), !SR);

  // ---------- 初始化 ----------
  setMode(mode);
  syncText();
  if (!editor.text) addLog('other', null, { status: 'ok', desc: '页面已就绪。可以先点“载入示例正文”试改字。' });
})();
