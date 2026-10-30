const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../public/commands.js');
const { pinyin } = require('pinyin-pro');

const ed = (text) => new V.Editor({ text, pinyin });
const p = (s) => V.parseCommand(s);

test('解析：替换的各种变体', () => {
  for (const s of ['把张三改成章三', '把张三换成章三', '把张三替换成章三', '将张三改为章三', '张三改成章三',
    '把张三改成章三。', '把 张三 ，改成 章三。', '嗯，把“张三”改成「章三」', '请把张三修改为章三！']) {
    assert.deepEqual({ ...p(s), xAlt: undefined }, { type: 'replace', x: '张三', y: '章三', all: false, xAlt: undefined }, s);
  }
  assert.equal(p('把所有的甲方改成乙方').all, true);
  assert.equal(p('把甲方全部改成乙方').all, true);
});

test('解析：删除', () => {
  for (const s of ['删掉张三', '删除张三', '去掉张三', '把张三删掉', '把张三去掉。', '删除，“张三”。', '把张三给删了'])
    assert.deepEqual(p(s), { type: 'delete', x: '张三', all: false }, s);
  for (const s of ['删掉最后一句', '删掉上一句', '删除最后一句话。', '把最后一句删掉', '去掉上一句'])
    assert.deepEqual(p(s), { type: 'deleteSentence', count: 1 }, s);
  assert.deepEqual(p('删掉最后两句'), { type: 'deleteSentence', count: 2 });
  assert.deepEqual(p('删掉最后一个字'), { type: 'deleteChars', count: 1 });
});

test('解析：插入', () => {
  assert.deepEqual(p('在违约责任后面加上及赔偿损失'), { type: 'insert', x: '违约责任', pos: 'after', y: '及赔偿损失' });
  assert.deepEqual(p('在“违约责任”后面，加上“及赔偿损失”。'), { type: 'insert', x: '违约责任', pos: 'after', y: '及赔偿损失' });
  assert.deepEqual(p('在张三前面插入律师'), { type: 'insert', x: '张三', pos: 'before', y: '律师' });
  assert.deepEqual(p('在张三的前边加上律师'), { type: 'insert', x: '张三', pos: 'before', y: '律师' });
  assert.deepEqual(p('张三后面加上先生'), { type: 'insert', x: '张三', pos: 'after', y: '先生' });
  assert.deepEqual(p('在甲方后面加个逗号'), { type: 'insert', x: '甲方', pos: 'after', y: '，' });
  assert.deepEqual(p('在开头加上标题'), { type: 'insertEdge', edge: 'start', y: '标题' });
  assert.deepEqual(p('在末尾加上谢谢'), { type: 'insertEdge', edge: 'end', y: '谢谢' });
});

test('解析：撤销、标点、换行、选择、选区', () => {
  assert.deepEqual(p('撤销'), { type: 'undo', steps: 1 });
  assert.deepEqual(p('撤销。'), { type: 'undo', steps: 1 });
  assert.deepEqual(p('撤回上一步'), { type: 'undo', steps: 1 });
  assert.deepEqual(p('撤销三步'), { type: 'undo', steps: 3 });
  assert.deepEqual(p('撤销2次'), { type: 'undo', steps: 2 });
  for (const [s, t] of [['加个句号', '。'], ['句号', '。'], ['加逗号', '，'], ['加个问号。', '？'], ['加一个感叹号', '！'], ['。', '。'], ['加个。', '。'], ['加个？', '？']])
    assert.equal(p(s).type === 'append' && p(s).text, t, s);
  for (const s of ['换行', '换行。', '另起一行', '回车']) assert.deepEqual(p(s), { type: 'append', text: '\n', label: '换行' }, s);
  assert.deepEqual(p('第二个'), { type: 'choose', index: 1 });
  assert.deepEqual(p('第2个。'), { type: 'choose', index: 1 });
  assert.deepEqual(p('选第三处'), { type: 'choose', index: 2 });
  assert.deepEqual(p('全部'), { type: 'choose', all: true });
  assert.deepEqual(p('取消'), { type: 'choose', cancel: true });
  assert.deepEqual(p('改成李四'), { type: 'replaceSelection', y: '李四' });
  assert.deepEqual(p('把这个改成李四。'), { type: 'replaceSelection', y: '李四' });
  assert.deepEqual(p('删掉'), { type: 'deleteSelection' });
  assert.deepEqual(p('删除。'), { type: 'deleteSelection' });
});

test('解析：听不懂的不乱改', () => {
  for (const s of ['今天天气不错', '', '   ', '张三', '把张三', '改成']) assert.equal(p(s).type, 'unknown', JSON.stringify(s));
  const e = ed('原文不动。');
  const r = e.command('今天天气不错');
  assert.equal(r.status, 'error'); assert.equal(r.message, '没听懂'); assert.equal(r.heard, '今天天气不错');
  assert.equal(e.text, '原文不动。'); assert.equal(e.history.length, 0);
});

test('执行：精确替换 + 高亮区间', () => {
  const e = ed('原告张三诉被告。');
  const r = e.command('把张三改成章三。');
  assert.equal(r.status, 'ok'); assert.equal(e.text, '原告章三诉被告。');
  assert.deepEqual(r.changes, [{ start: 2, end: 4, kind: 'replace' }]);
  assert.equal(r.method, 'exact'); assert.equal(r.note, '');
});

test('执行：多处匹配 → 待选 → 第二个 / 全部 / 取消', () => {
  let e = ed('甲方同意，甲方签字，甲方盖章。');
  let r = e.command('把甲方改成乙方');
  assert.equal(r.status, 'choose'); assert.equal(r.matches.length, 3);
  assert.deepEqual(r.matches.map(m => m.start), [0, 5, 10]);
  assert.equal(e.text, '甲方同意，甲方签字，甲方盖章。');
  r = e.command('第二个');
  assert.equal(r.status, 'ok'); assert.equal(e.text, '甲方同意，乙方签字，甲方盖章。');

  e = ed('甲方同意，甲方签字。');
  e.command('把甲方改成乙方'); r = e.command('全部');
  assert.equal(e.text, '乙方同意，乙方签字。'); assert.equal(r.changes.length, 2);

  e = ed('甲方同意，甲方签字。');
  e.command('把甲方改成乙方'); r = e.command('第五个');
  assert.equal(r.status, 'error'); assert.ok(e.pending);
  e.command('取消'); assert.equal(e.pending, null); assert.equal(e.text, '甲方同意，甲方签字。');

  e = ed('甲方同意，甲方签字。');
  r = e.command('把甲方都改成乙方'); assert.equal(e.text, '乙方同意，乙方签字。');
  e = ed('甲方同意，甲方签字。');
  r = e.command('把所有甲方改成乙方'); assert.equal(e.text, '乙方同意，乙方签字。');
  e = ed('中国首都是北京，首都很大。');
  r = e.command('把首都改成京城');
  assert.equal(r.status, 'choose');
  r = e.choose(0); assert.equal(e.text, '中国京城是北京，首都很大。');
});

test('执行：没有待选时说“第二个”报错', () => {
  const e = ed('abc');
  assert.equal(e.command('第二个').status, 'error'); assert.equal(e.text, 'abc');
});

test('执行：同音字匹配（拼音），并标明按读音匹配', () => {
  const e = ed('被告章三于五月签约。');
  const r = e.command('把张三改成章珊');
  assert.equal(r.status, 'ok'); assert.equal(r.method, 'pinyin');
  assert.match(r.note, /按读音匹配到「章三」/);
  assert.equal(e.text, '被告章珊于五月签约。');
  // 多音字：长(zhang/chang)
  const e2 = ed('他是厂长。');
  assert.equal(e2.command('把厂掌改成经理').status, 'ok'); assert.equal(e2.text, '他是经理。');
  // 多处同音 → 待选
  const e3 = ed('章三说，张叁也说。');
  const r3 = e3.command('删掉张三');
  assert.equal(r3.status, 'choose'); assert.equal(r3.method, 'pinyin');
  assert.equal(r3.matches.length, 2);
  e3.command('第一个'); assert.equal(e3.text, '说，张叁也说。');
});

test('执行：近似读音（平翘舌/前后鼻音）兜底', () => {
  const e = ed('联系人：陈胜。');
  const r = e.command('把岑森改成陈生');
  assert.equal(r.status, 'ok'); assert.equal(r.method, 'pinyin-fuzzy'); assert.match(r.note, /近似读音/);
  assert.equal(e.text, '联系人：陈生。');
});

test('执行：找不到时报错且不改正文', () => {
  const e = ed('今天开会。');
  const r = e.command('把明天改成后天');
  assert.equal(r.status, 'error'); assert.match(r.message, /没找到「明天」/); assert.equal(e.text, '今天开会。');
  const noPy = new V.Editor({ text: '章三' });
  assert.match(noPy.command('删掉张三').message, /拼音库未加载/);
});

test('执行：识别结果带标点 / 正文带标点（忽略标点匹配）', () => {
  const e = ed('甲方：北京某某公司，乙方：张三。');
  let r = e.command('把甲方北京某某公司，改成甲方上海某某公司。');
  assert.equal(r.status, 'ok'); assert.equal(r.method, 'loose');
  assert.equal(e.text, '甲方上海某某公司，乙方：张三。');
  r = e.command('删除，“乙方”。');
  assert.equal(e.text, '甲方上海某某公司，：张三。');
});

test('执行：删掉最后一句 / 上一句 / 最后两句', () => {
  let e = ed('第一句。第二句！第三句？');
  e.command('删掉最后一句'); assert.equal(e.text, '第一句。第二句！');
  e.command('删掉上一句。'); assert.equal(e.text, '第一句。');
  e = ed('第一句。第二句。没有句号的半句');
  e.command('删掉最后一句'); assert.equal(e.text, '第一句。第二句。');
  e = ed('一。二。三。');
  e.command('删掉最后两句'); assert.equal(e.text, '一。');
  e = ed('第一段。\n第二段');
  e.command('删掉最后一句'); assert.equal(e.text, '第一段。\n');
  e = ed('');
  assert.equal(e.command('删掉最后一句').status, 'error');
});

test('执行：插入、标点、换行', () => {
  const e = ed('违约责任由乙方承担');
  e.command('在违约责任后面加上及赔偿损失'); assert.equal(e.text, '违约责任及赔偿损失由乙方承担');
  e.command('在乙方前面加上全体'); assert.equal(e.text, '违约责任及赔偿损失由全体乙方承担');
  e.command('加个句号'); assert.equal(e.text, '违约责任及赔偿损失由全体乙方承担。');
  e.command('换行'); assert.ok(e.text.endsWith('。\n'));
  e.command('在开头加上第一条'); assert.ok(e.text.startsWith('第一条违约'));
  const r = e.command('在承担后面加个逗号'); assert.equal(r.status, 'ok'); assert.ok(e.text.includes('承担，。'));
});

test('执行：作用于选区', () => {
  const e = ed('原告张三诉被告李四。');
  let r = e.command('改成王五', { start: 2, end: 4 });
  assert.equal(r.status, 'ok'); assert.equal(e.text, '原告王五诉被告李四。');
  r = e.command('删掉', { start: 7, end: 9 });
  assert.equal(e.text, '原告王五诉被告。');
  r = e.command('改成王五', null);
  assert.equal(r.status, 'error'); assert.match(r.message, /没有选中/);
  r = e.command('删掉', { start: 3, end: 3 });
  assert.equal(r.status, 'error');
});

test('撤销：多步、超出、包含听写', () => {
  const e = ed('');
  e.dictate('今天张三来了。');
  e.command('把张三改成李四');
  e.command('加个问号');
  assert.equal(e.text, '今天李四来了。？');
  e.command('撤销'); assert.equal(e.text, '今天李四来了。');
  e.command('撤销'); assert.equal(e.text, '今天张三来了。');
  e.command('加个句号'); e.command('加个句号');
  const r = e.command('撤销五步');
  assert.equal(r.status, 'ok'); assert.match(r.desc, /撤到最早/); assert.equal(e.text, '');
  assert.equal(e.command('撤销').status, 'error');
});

test('听写：原样追加，不改写', () => {
  const e = ed('开头');
  const r = e.dictate('把张三改成李四。');
  assert.equal(e.text, '开头把张三改成李四。');
  assert.deepEqual(r.changes, [{ start: 2, end: 10, kind: 'insert' }]);
  assert.equal(e.dictate('  ').status, 'error');
});

test('新口令会清掉旧的待选', () => {
  const e = ed('甲乙甲');
  assert.equal(e.command('删掉甲').status, 'choose');
  e.command('加个句号');
  assert.equal(e.pending, null); assert.equal(e.text, '甲乙甲。');
});

test('normalize 与中文数字', () => {
  assert.equal(V.normalize('  嗯，那个 把 张三 改成 李四。 '), '把张三改成李四');
  assert.equal(V.normalize('把 iPhone 17 改成 iPhone 18'), '把iPhone 17改成iPhone 18');
  assert.equal(V.cnNum('十二'), 12); assert.equal(V.cnNum('两'), 2); assert.equal(V.cnNum('3'), 3);
});
