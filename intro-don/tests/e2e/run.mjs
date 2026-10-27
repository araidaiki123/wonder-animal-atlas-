// イントロどん E2E（Playwright, iPhone 相当ビューポート）
// 使い方: リポジトリのルートで `python3 -m http.server 8000` を起動してから
//   node intro-don/tests/e2e/run.mjs [baseUrl] [screenshotDir]
// 失敗すると例外で終了コード 1。コンソールエラー・ページエラーも失敗扱い。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// グローバルインストールの playwright も拾えるよう require で解決する
const { chromium, devices } = require('playwright');
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:8000/intro-don/';
const SHOTS = process.argv[3] || path.resolve('e2e-shots');
mkdirSync(SHOTS, { recursive: true });

const iphone = devices['iPhone 14'];
const errors = [];
let shotNo = 0;

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

async function shot(page, name) {
  shotNo += 1;
  await page.screenshot({ path: path.join(SHOTS, `${String(shotNo).padStart(2, '0')}-${name}.png`) });
}

async function newPage(context) {
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const t = m.text();
      // サンドボックスでは外部ネットワークが無いので、YouTube/サムネ取得の失敗だけ許容
      if (/ytimg|youtube|iframe_api|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|net::ERR/.test(t)) return;
      errors.push('console: ' + t);
    }
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());
  return page;
}

async function hostFlow(context) {
  const page = await newPage(context);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#builtin-list .set-card');
  const builtinCount = await page.locator('#builtin-list .set-card').count();
  assert(builtinCount === 10, `同梱セットが 10 件表示される（実際 ${builtinCount}）`);
  await shot(page, 'home');

  // セット詳細 → 複製
  await page.locator('#builtin-list .set-card').first().locator('[data-action="open"]').click();
  await page.waitForSelector('#btn-clone:visible');
  await shot(page, 'set-builtin');
  await page.click('#btn-clone');
  await page.waitForSelector('#set-form:visible');
  const title = await page.inputValue('#set-title');
  assert(title.length > 0, 'タイトルが引き継がれる');

  // 問題編集：YouTube URL を付ける
  await page.locator('#q-list .q-item [data-action="edit"]').first().click();
  await page.waitForSelector('#dlg-question[open]');
  await page.click('#source-tabs [data-tab="youtube"]');
  await page.fill('#q-yt-url', 'https://youtu.be/dQw4w9WgXcQ?t=5');
  await page.click('#btn-yt-apply');
  await page.fill('#q-answer', '<img src=x onerror="window.__xss=1">ファミリーマート');
  await shot(page, 'question-dialog');
  await page.click('#btn-q-save');
  await page.waitForSelector('#dlg-question[open]', { state: 'hidden' });
  const badge = await page.locator('#q-list .q-item').first().locator('.q-badge').getAttribute('data-kind');
  assert(badge === 'youtube', `音源バッジが youtube になる（実際 ${badge}）`);
  const xss = await page.evaluate(() => window.__xss);
  assert(!xss, 'XSS 文字列が実行されない');
  const answerText = await page.locator('#q-list .q-item .q-answer').first().textContent();
  assert(answerText.includes('<img'), '入力はテキストとして描画される');

  // 不正な URL はエラー
  await page.locator('#q-list .q-item [data-action="edit"]').nth(1).click();
  await page.waitForSelector('#dlg-question[open]');
  await page.click('#source-tabs [data-tab="youtube"]');
  await page.fill('#q-yt-url', 'https://example.com/notyoutube');
  await page.click('#btn-yt-apply');
  const ytErr = await page.locator('#q-yt-error').textContent();
  assert(ytErr && ytErr.trim().length > 0, 'YouTube URL エラーが表示される');
  await page.click('#btn-q-save');
  await page.waitForSelector('#dlg-question[open]', { state: 'hidden' });

  // 書き出し
  await page.click('#btn-export');
  await page.waitForSelector('#dlg-export[open]');
  const exported = await page.inputValue('#export-text');
  const parsed = JSON.parse(exported);
  assert(parsed.questions[0].source && parsed.questions[0].source.videoId === 'dQw4w9WgXcQ', '書き出し JSON に videoId が含まれる');
  await shot(page, 'export');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#dlg-export[open]', { state: 'hidden' }).catch(() => {});

  // 設定 → 司会モード 2 人
  await page.click('#btn-play-set');
  await page.waitForSelector('#btn-start:visible');
  await page.click('#mode-seg [data-mode="host"]');
  await page.fill('#setup-limit', '3');
  await page.locator('#players-list .player-name').first().fill('たろう');
  await shot(page, 'setup-host');
  await page.click('#btn-start');
  await page.waitForSelector('[data-screen="play"]:not([hidden])');
  await page.waitForTimeout(300);
  await shot(page, 'play-host');

  // 1問目：音源あり/なし両方に対応して「再生」操作をする
  for (let q = 0; q < 3; q += 1) {
    const hasDon = await page.locator('#don-button:visible').count();
    if (hasDon) {
      await page.click('#don-button');
    } else {
      await page.click('#no-source-panel .ns-count');
    }
    await page.waitForTimeout(200);
    const phase = await page.getAttribute('[data-screen="play"]', 'data-phase');
    assert(phase === 'playing', `どん！で playing（実際 ${phase}）`);
    await page.click('#btn-stop');
    await page.waitForSelector('#judge-panel:not([hidden])');
    if (q === 0) await shot(page, 'judge');
    if (q === 1) {
      // 誤答 → 戻る → 正解者なしで答えを見る
      await page.check('#judge-wrong-mode');
      await page.locator('#judge-players .judge-btn').nth(1).click();
      const locked = await page.locator('#play-scores .score-chip[data-locked="true"]').count();
      assert(locked === 1, '誤答した人がロックされる');
      await page.click('#btn-reveal');
    } else {
      await page.locator('#judge-players .judge-btn').first().click();
    }
    await page.waitForSelector('#reveal-panel:not([hidden])');
    if (q === 0) await shot(page, 'reveal');
    await page.click('#btn-next');
    await page.waitForTimeout(200);
  }
  await page.waitForSelector('[data-screen="result"]:not([hidden])');
  const rows = await page.locator('#ranking li, #ranking .rank-row').count();
  assert(rows >= 2, `結果に 2 人分の行（実際 ${rows}）`);
  const summary = await page.locator('#summary-text').textContent();
  assert(summary.includes('たろう') && summary.includes('点'), '共有テキストに名前と得点');
  await shot(page, 'result');
  await page.close();
}

async function buzzerFlow(context) {
  const page = await newPage(context);
  await page.goto(BASE + '#/home', { waitUntil: 'networkidle' });
  await page.waitForSelector('#builtin-list .set-card');
  await page.locator('#builtin-list .set-card').nth(2).locator('[data-action="play"]').click();
  await page.waitForSelector('#btn-start:visible');
  await page.click('#mode-seg [data-mode="buzzer"]');
  await page.click('#players-plus');
  await page.click('#players-plus');
  const count = await page.locator('#players-list .player-name').count();
  assert(count === 4, `早押し 4 人（実際 ${count}）`);
  await page.fill('#setup-limit', '2');
  await page.click('#btn-start');
  await page.waitForSelector('#buzz-stage:not([hidden])');
  await page.waitForTimeout(300);
  await shot(page, 'play-buzzer');
  const panels = page.locator('#buzz-grid .buzz-panel');
  assert((await panels.count()) === 4, '4 枚の早押しパネル');

  // 再生前はブザー無効
  await panels.nth(0).dispatchEvent('pointerdown', { bubbles: true });
  let phase = await page.getAttribute('[data-screen="play"]', 'data-phase');
  assert(phase === 'ready', '再生前の早押しは無視される');

  // どん！（音源なしなら「再生した」）
  const hasDon = await page.locator('#buzz-don:visible').count();
  if (hasDon) await page.click('#buzz-don'); else await page.click('#buzz-no-source .ns-count');
  await page.waitForTimeout(150);
  // 3 人目がタッチ
  const box = await panels.nth(2).boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(100);
  phase = await page.getAttribute('[data-screen="play"]', 'data-phase');
  assert(phase === 'buzzed', `早押しで buzzed（実際 ${phase}）`);
  assert((await panels.nth(2).getAttribute('data-active')) === 'true', '押した人のパネルが点灯');
  await shot(page, 'buzzed');
  await page.click('#buzz-wrong');
  assert((await panels.nth(2).getAttribute('data-locked')) === 'true', '誤答でロック');
  // 別の人が押して正解
  const box2 = await panels.nth(0).boundingBox();
  await page.touchscreen.tap(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.waitForTimeout(100);
  await page.click('#buzz-correct');
  await page.waitForSelector('#reveal-panel:not([hidden])');
  const winner = await page.locator('#reveal-winner').textContent();
  assert(winner.includes('+'), `正解者と得点が表示される（${winner}）`);
  await page.click('#btn-next');
  await page.waitForTimeout(200);
  // 2 問目：答えを見る → 結果
  await page.click('#buzz-reveal');
  await page.waitForSelector('#reveal-panel:not([hidden])');
  await page.click('#btn-next');
  await page.waitForSelector('[data-screen="result"]:not([hidden])');
  await page.close();
}

async function importFlow(context) {
  const page = await newPage(context);
  await page.goto(BASE + '#/home', { waitUntil: 'networkidle' });
  await page.waitForSelector('#builtin-list .set-card');
  await page.click('#btn-import');
  await page.waitForSelector('#dlg-import[open]');
  await page.fill('#import-text', '{ broken json');
  await page.click('#btn-import-confirm');
  const err = await page.locator('#import-error').textContent();
  assert(err && err.trim(), '不正 JSON でエラー表示');
  const good = JSON.stringify({
    schemaVersion: 1, id: 'konbini-chime', title: '読み込みテスト', questions: [
      { id: 'a', answer: '答え1', source: { type: 'youtube', videoId: 'dQw4w9WgXcQ' } },
      { id: 'b', answer: '答え2' },
    ],
  });
  await page.fill('#import-text', good);
  await page.click('#btn-import-confirm');
  await page.waitForSelector('#dlg-import[open]', { state: 'hidden' });
  await page.waitForTimeout(300);
  const userTitles = await page.locator('#user-list .set-title').allTextContents();
  assert(userTitles.some((t) => t.includes('読み込みテスト')), `読み込んだセットが自作一覧に出る（${userTitles.join(',')}）`);
  await shot(page, 'home-after-import');
  await page.close();
}

async function offlineFlow(context) {
  const page = await newPage(context);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#builtin-list .set-card');
  // SW のインストール完了を待つ
  await page.waitForFunction(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return !!(r && r.active);
  }, null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#builtin-list .set-card', { timeout: 15000 });
  const n = await page.locator('#builtin-list .set-card').count();
  assert(n === 10, `オフラインでも同梱セットが開ける（実際 ${n}）`);
  const banner = await page.locator('#offline-banner').isVisible();
  assert(banner, '圏外バナーが出る');
  await shot(page, 'offline');
  await context.setOffline(false);
  await page.close();
}

async function landscapeShot(browser) {
  const context = await browser.newContext({ ...iphone, viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  const page = await newPage(context);
  await page.goto(BASE + '#/home', { waitUntil: 'networkidle' });
  await page.locator('#builtin-list .set-card').nth(1).locator('[data-action="play"]').click();
  await page.waitForSelector('#btn-start:visible');
  await page.click('#mode-seg [data-mode="buzzer"]');
  await page.click('#btn-start');
  await page.waitForSelector('#buzz-stage:not([hidden])');
  await page.waitForTimeout(300);
  await shot(page, 'buzzer-landscape');
  await context.close();
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ ...iphone });
  await hostFlow(context);
  await buzzerFlow(context);
  await importFlow(context);
  await offlineFlow(context);
  await context.close();
  await landscapeShot(browser);
} finally {
  await browser.close();
}

if (errors.length) {
  console.error('ブラウザエラー:\n' + errors.join('\n'));
  process.exit(1);
}
console.log(`E2E OK（スクリーンショット: ${SHOTS}）`);
