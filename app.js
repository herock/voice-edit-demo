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
    if (listening) stopRec();
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
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null, listening = false, sessionMode = 'dictate', transcript = '', sessionId = 0, ended = true;
  var silenceTimer = null, maxTimer = null, stopGuard = null;
  var ERRORS = {
    'not-allowed': '没有麦克风或语音识别权限。请在弹窗里选“允许”；如果之前拒绝过：点地址栏左侧「大小」图标 › 网站设置 › 麦克风 › 允许，或 设置 › Safari › 麦克风。',
    'service-not-allowed': '系统语音识别不可用。请到 设置 › 通用 › 键盘，打开「启用听写」（或打开 Siri），然后刷新重试。也可能是在微信等 App 内置浏览器里，请改用 Safari。',
    'no-speech': '没听到说话声，请靠近一点再试。',
    'audio-capture': '麦克风用不了（可能正被通话或其他 App 占用）。',
    'network': '网络出错：iOS 语音识别可能需要联网。',
    'language-not-supported': '当前系统不支持中文（zh-CN）识别。'
  };
  function updateRecBtn() {
    var b = $('recBtn');
    b.classList.toggle('on', listening);
    $('recIcon').textContent = listening ? '■' : '●';
    $('recLabel').textContent = listening ? (sessionMode === 'edit' ? '正在听口令…点一下结束' : '正在听写…点一下结束')
                                          : (mode === 'edit' ? '点一下说改字口令' : '点一下开始听写');
    if (!SR) { b.disabled = true; $('recLabel').textContent = '此浏览器不支持语音识别'; }
  }
  function live(text) { $('live').hidden = !listening && !text; $('liveText').textContent = text || '正在听…'; }

  function startRec() {
    // 必须在点击事件里同步调用 start()（iOS 要求用户手势触发）
    var id = ++sessionId;
    try {
      rec = new SR();
      rec.lang = 'zh-CN';
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
    } catch (e) { showResult(null, { status: 'error', message: '无法创建语音识别：' + e.message }); return; }
    sessionMode = mode; transcript = ''; ended = false;
    rec.onresult = function (e) {
      if (id !== sessionId) return;
      var parts = [];
      for (var i = 0; i < e.results.length; i++) {
        var t = e.results[i][0] ? e.results[i][0].transcript : '';
        var joined = parts.join('');
        if (!t) continue;
        if (parts.length && parts[parts.length - 1] === t) continue;           // iOS 重复结果
        if (joined && t.indexOf(joined) === 0) { parts = [t]; continue; }       // 累积型结果
        parts.push(t);
      }
      transcript = parts.join('');
      live(transcript);
      if (sessionMode === 'edit') { clearTimeout(silenceTimer); silenceTimer = setTimeout(stopRec, 1600); } // 口令说完停 1.6 秒自动结束
    };
    rec.onerror = function (e) {
      if (id !== sessionId) return;
      if (e.error === 'aborted') return;
      var msg = ERRORS[e.error] || ('语音识别出错：' + e.error);
      showBanner(msg, e.error === 'not-allowed' || e.error === 'service-not-allowed');
      addLog(sessionMode, null, { status: 'error', message: msg });
    };
    rec.onend = function () { finish(id); };
    try { rec.start(); } catch (e) { showResult(null, { status: 'error', message: '启动语音识别失败：' + e.message }); return; }
    listening = true; updateRecBtn(); live('');
    maxTimer = setTimeout(stopRec, 60000); // 单次最长 60 秒
  }
  function stopRec() {
    if (!rec || ended) return;
    clearTimeout(silenceTimer);
    try { rec.stop(); } catch (e) {}
    var id = sessionId, r = rec;
    // iOS 上偶尔不触发 onend：1.5 秒后强制结束
    clearTimeout(stopGuard);
    stopGuard = setTimeout(function () { if (!ended && id === sessionId) { try { r.abort(); } catch (e) {} finish(id); } }, 1500);
  }
  function finish(id) {
    if (id !== sessionId || ended) return;
    ended = true; listening = false;
    clearTimeout(silenceTimer); clearTimeout(maxTimer); clearTimeout(stopGuard);
    updateRecBtn(); $('live').hidden = true;
    var t = transcript; transcript = '';
    if (t.trim()) handleUtterance(t, sessionMode);
    else addLog(sessionMode, null, { status: 'error', message: '这次没识别到文字' });
  }
  $('recBtn').onclick = function () { if (listening) stopRec(); else startRec(); };

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
