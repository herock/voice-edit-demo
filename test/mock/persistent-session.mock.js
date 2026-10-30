// 模拟 iOS 上“整页一个持续会话”的 webkitSpeechRecognition（continuous）
const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const p = await b.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.evaluateOnNewDocument(() => {
    window.__recs = []; window.__failNextStart = 0;
    class FakeSR {
      constructor() { window.__recs.push(this); this.results = []; this.starts = 0; }
      start() {
        if (window.__failNextStart > 0) { window.__failNextStart--; const e = new Error('InvalidStateError'); e.name = 'InvalidStateError'; throw e; }
        if (this.running) throw new Error('already started');
        this.running = true; this.starts++;
        setTimeout(() => { this.onstart && this.onstart(); this.onaudiostart && this.onaudiostart(); }, 10);
      }
      stop() { this.running = false; setTimeout(() => this.onend && this.onend(), 30); }
      abort() { this.running = false; }
      _fire() {
        const results = this.results.map(r => Object.assign([{ transcript: r.t }], { isFinal: r.fin }));
        this.onresult && this.onresult({ results, resultIndex: 0 });
      }
      // 说话：更新最后一个 interim，或把它定稿
      say(t, fin) {
        const last = this.results[this.results.length - 1];
        if (last && !last.fin) { last.t = t; last.fin = !!fin; } else this.results.push({ t, fin: !!fin });
        this._fire();
      }
      dup() { this._fire(); this._fire(); }                 // iOS 重复推送同样的结果
      rewrite(i, t) { this.results[i].t = t; this._fire(); } // iOS 改写前面的结果
      die(err) { this.running = false; if (err) this.onerror && this.onerror({ error: err }); this.onend && this.onend(); }
    }
    Object.defineProperty(window, 'webkitSpeechRecognition', { value: FakeSR, configurable: true, writable: true });
    Object.defineProperty(window, 'SpeechRecognition', { value: FakeSR, configurable: true, writable: true });
  });
  await p.goto('http://127.0.0.1:8799/index.html?mock=' + Date.now(), { waitUntil: 'networkidle0' });
  await p.evaluate(() => localStorage.clear()); await p.reload({ waitUntil: 'networkidle0' });
  const w = ms => new Promise(r => setTimeout(r, ms));
  const val = () => p.$eval('#editor', e => e.value);
  const label = () => p.$eval('#recLabel', e => e.textContent);
  const nrec = () => p.evaluate(() => window.__recs.length);
  const say = (t, fin) => p.evaluate((t, fin) => window.__recs.at(-1).say(t, fin), t, fin);
  let fails = 0;
  const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  [' + extra + ']' : '')); if (!ok) fails++; };

  check('idle label', (await label()) === '点一下开始说', await label());
  check('no SR instance before first tap', (await nrec()) === 0);

  // ---- 段 1：听写 ----
  await p.click('#recBtn'); await w(50);
  check('first tap starts ONE session', (await nrec()) === 1 && await p.evaluate(() => window.__recs[0].continuous && window.__recs[0].interimResults && window.__recs[0].lang === 'zh-CN'));
  check('dictate capturing label', (await label()) === '正在听…说完点一下', await label());
  await say('甲方张三'); await p.evaluate(() => window.__recs[0].dup());
  await say('甲方张三欠乙方四百元。', true); await p.evaluate(() => window.__recs[0].dup());
  await w(2000);
  check('seg1 not executed without end tap', (await val()) === '', await val());
  await p.click('#recBtn');
  check('processing label during grace', (await label()) === '正在处理…', await label());
  await w(900);
  check('seg1 dictated', (await val()) === '甲方张三欠乙方四百元。', await val());

  // 段间说的话应被忽略
  await say('嗯那个我想想', true); await w(300);
  check('speech between segments ignored', (await val()) === '甲方张三欠乙方四百元。');

  // ---- 段 2：改字（中途停顿，结束点击后才到最后几个字） ----
  await p.click('#modeEdit'); await w(50);
  await p.click('#recBtn'); await w(50);
  check('edit capturing label', (await label()) === '正在听口令…说完点一下执行', await label());
  await say('把张三'); await w(3000);   // 停下来想
  check('seg2 not executed during pause', (await val()) === '甲方张三欠乙方四百元。');
  await say('把张三改成');
  await p.click('#recBtn');            // 用户点得比最后几个字早
  await w(250); await say('把张三改成章三', true);
  await w(900);
  check('seg2 executed with late final words (grace)', (await val()) === '甲方章三欠乙方四百元。', await val());

  // ---- 段 3：改字 ----
  await p.click('#recBtn'); await w(50);
  await say('把四百改成五百', true); await p.evaluate(() => window.__recs[0].dup());
  await p.click('#recBtn'); await w(900);
  check('seg3 executed', (await val()) === '甲方章三欠乙方五百元。', await val());
  check('only ONE SR instance across 3 segments', (await nrec()) === 1 && await p.evaluate(() => window.__recs[0].starts === 1), 'instances=' + await nrec());

  // ---- 段切模式：段的模式 = 开始时的模式 ----
  await p.click('#modeDictate'); await w(50);
  await p.click('#recBtn'); await p.click('#modeEdit'); await w(50);
  await say('好的', true);
  await p.click('#recBtn'); await w(900);
  check('segment keeps mode from its start (dictate)', (await val()) === '甲方章三欠乙方五百元。好的', await val());

  // ---- iOS 改写前面的结果（转写变短到 offset 以下）----
  await p.click('#recBtn'); await w(50);
  await say('删掉最后一个字', true);
  await p.evaluate(() => window.__recs[0].rewrite(0, '甲方张三')); // 把第一个结果改短
  await p.click('#recBtn'); await w(900);
  check('earlier-result rewrite still yields segment text', (await val()) === '甲方章三欠乙方五百元。好', await val());

  // ---- iOS 自己结束了会话（段之间） ----
  await p.evaluate(() => window.__recs[0].die('no-speech')); await w(100);
  check('status after iOS ended session', (await label()) === '识别断了，点一下重新开始', await label());
  check('no silent auto-restart', (await nrec()) === 1);
  await w(1500); check('still no auto-restart after 1.5s', (await nrec()) === 1);
  await p.evaluate(() => { window.__failNextStart = 1; });   // 第一次 start() 抛错，测试重试阶梯
  await p.click('#recBtn'); await w(500);
  check('tap restarts one new instance (with retry ladder after a throw)', (await nrec()) === 2 && await p.evaluate(() => window.__recs[1].starts === 1), 'instances=' + await nrec());
  await say('加个句号', true);
  await p.click('#recBtn'); await w(900);
  check('command after recovery executed', (await val()) === '甲方章三欠乙方五百元。好。', await val());

  // ---- iOS 在录入中途结束会话 ----
  await p.click('#recBtn'); await w(50);
  await say('在开头加上', true);
  await p.evaluate(() => window.__recs[1].die()); await w(100);
  check('mid-segment end label', (await label()) === '识别断了，点一下接着听', await label());
  check('captured text kept', (await p.$eval('#liveText', e => e.textContent)) === '在开头加上');
  check('direct-exec button shown', await p.$eval('#execNow', e => !e.hidden));
  check('nothing executed by session end', (await val()) === '甲方章三欠乙方五百元。好。');
  await p.click('#recBtn'); await w(100);
  check('tap resumes with new instance', (await nrec()) === 3);
  await say('合同', true);
  await p.click('#recBtn'); await w(900);
  check('segment spanning restart executed as one command', (await val()) === '合同甲方章三欠乙方五百元。好。', await val());

  // ---- 聋掉检测 ----
  await p.click('#recBtn'); await w(6500);
  const hint = await p.$eval('#hint', e => e.hidden ? '' : e.textContent);
  check('deaf hint after 6s with no results', hint.indexOf('好像没在听') === 0, hint);
  await p.click('#recBtn'); await w(900);
  check('empty segment does not change text', (await val()) === '合同甲方章三欠乙方五百元。好。');

  // 中途断了直接点“直接执行”
  await p.click('#recBtn'); await w(50);
  await say('加个句号', true);
  await p.evaluate(() => window.__recs.at(-1).die('network')); await w(100);
  await p.click('#execNow'); await w(300);
  check('execNow runs captured text without restart', (await val()) === '合同甲方章三欠乙方五百元。好。。' && (await nrec()) === 3 && (await label()) === '识别断了，点一下重新开始', await val() + ' | ' + await label());
  await p.$eval('#undoBtn', e => e.click()); await w(50);

  // 历史/清空
  const stored = await p.evaluate(() => localStorage.getItem('voice-edit-demo:text'));
  check('localStorage persisted', stored === '合同甲方章三欠乙方五百元。好。');
  await p.click('#clearBtn'); await w(50);
  check('清空 works', (await val()) === '');
  console.log('debug line:', await p.$eval('#dbgText', e => e.textContent));
  console.log('page errors', errs);
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  await b.close(); process.exit(fails ? 1 : 0);
})();
