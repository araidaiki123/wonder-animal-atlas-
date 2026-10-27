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
  const builtinFirstTitle = await page.locator('#builtin-list .set-title').first().textContent();
  await page.fill('#import-text', good);
  await page.click('#btn-import-confirm');
  await page.waitForSelector('#dlg-import[open]', { state: 'hidden' });
  // 同梱 id と衝突する読み込みは "user-" の id に付け替えられてセット画面へ遷移する
  await page.waitForSelector('[data-screen="set"]:not([hidden])');
  const hashAfterImport = await page.evaluate(() => location.hash);
  assert(/^#\/set\/user-/.test(hashAfterImport), `読み込んだセットの id が user- に付け替わる（${hashAfterImport}）`);
  const kindBadge = await page.locator('#set-kind-badge').textContent();
  assert(kindBadge === '自作', `読み込んだセットは自作扱い（${kindBadge}）`);
  await page.goto(BASE + '#/home', { waitUntil: 'networkidle' });
  await page.waitForSelector('#builtin-list .set-card');
  await page.waitForTimeout(300);
  const userTitles = await page.locator('#user-list .set-title').allTextContents();
  assert(userTitles.some((t) => t.includes('読み込みテスト')), `読み込んだセットが自作一覧に出る（${userTitles.join(',')}）`);
  const builtinTitles = await page.locator('#builtin-list .set-title').allTextContents();
  assert(builtinTitles.length === 10 && builtinTitles[0] === builtinFirstTitle && !builtinTitles.includes('読み込みテスト'),
    `同梱カードは同梱のまま（${builtinTitles[0]}）`);
  await shot(page, 'home-after-import');
  await page.close();
}

// YouTube 音源付きセットを読み込み → 早押し → 正解表示（動画枠と正解パネルが重ならない）
async function youtubeBuzzerFlow(context) {
  const page = await newPage(context);
  await page.goto(BASE + '#/home', { waitUntil: 'networkidle' });
  await page.waitForSelector('#builtin-list .set-card');
  await page.click('#btn-import');
  await page.waitForSelector('#dlg-import[open]');
  const ytSet = JSON.stringify({
    schemaVersion: 1, id: 'user-e2e-youtube', title: 'YouTube テスト', emoji: '📺', questions: [
      { id: 'a', answer: 'YouTube の答え1', subtitle: '補足1', trivia: '豆知識1', source: { type: 'youtube', videoId: 'dQw4w9WgXcQ' } },
      { id: 'b', answer: 'YouTube の答え2', source: { type: 'youtube', videoId: 'dQw4w9WgXcQ', start: 10 } },
    ],
  });
  await page.fill('#import-text', ytSet);
  await page.click('#btn-import-confirm');
  await page.waitForSelector('[data-screen="set"]:not([hidden])');
  await page.click('#btn-play-set');
  await page.waitForSelector('#btn-start:visible');
  await page.click('#mode-seg [data-mode="buzzer"]');
  await page.click('#btn-start');
  await page.waitForSelector('#buzz-stage:not([hidden])');
  await page.waitForSelector('#yt-box:not([hidden])');
  await page.waitForTimeout(300);
  const toastTop = await page.evaluate(() => {
    const host = document.querySelector('.toast-host');
    const r = host.getBoundingClientRect();
    return r.top;
  });
  assert(toastTop < 200, `プレイ画面ではトーストが上部に出る（top=${toastTop}）`);
  await shot(page, 'play-buzzer-youtube');

  // 暖機オーバーレイ：中央だけタップが iframe 側に通り、周囲の帯は通らない（DOM を直接暖機状態にして検証）
  const hit = await page.evaluate(() => {
    const ov = document.querySelector('#yt-overlay');
    ov.dataset.warmup = 'true';
    const box = document.querySelector('#yt-box').getBoundingClientRect();
    const at = (fx, fy) => {
      const e = document.elementFromPoint(box.left + box.width * fx, box.top + box.height * fy);
      return e ? (e.id || e.className || e.tagName) : null;
    };
    const res = { center: at(0.5, 0.5), top: at(0.5, 0.1), bottom: at(0.5, 0.9), left: at(0.05, 0.5), right: at(0.95, 0.5) };
    ov.dataset.warmup = 'false';
    return res;
  });
  assert(hit.center === 'yt-mount' || /iframe/i.test(hit.center), `暖機中は中央のタップが動画に届く（${hit.center}）`);
  assert(/yt-band/.test(hit.top) && /yt-band/.test(hit.bottom) && /yt-band/.test(hit.left) && /yt-band/.test(hit.right),
    `暖機中は周囲の帯がタップを遮る（${JSON.stringify(hit)}）`);

  // どん！（サンドボックスでは YouTube に繋がらないので回数だけ数える）→ 早押し → 正解
  await page.click('#buzz-don');
  await page.waitForTimeout(150);
  let phase = await page.getAttribute('[data-screen="play"]', 'data-phase');
  assert(phase === 'playing', `YouTube 問題でもどん！で playing（実際 ${phase}）`);
  const panels = page.locator('#buzz-grid .buzz-panel');
  const box = await panels.nth(1).boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(100);
  await page.click('#buzz-correct');
  await page.waitForSelector('#reveal-panel:not([hidden])');
  await page.waitForTimeout(300);
  const layout = await page.evaluate(() => {
    const yt = document.querySelector('#yt-box').getBoundingClientRect();
    const rv = document.querySelector('#reveal-panel').getBoundingClientRect();
    const ans = document.querySelector('#reveal-answer').getBoundingClientRect();
    return { ytBottom: yt.bottom, ytTop: yt.top, revealTop: rv.top, answerTop: ans.top, answerH: ans.height };
  });
  assert(layout.revealTop >= layout.ytBottom - 1, `正解パネルが動画枠の下に来る（yt.bottom=${layout.ytBottom}, reveal.top=${layout.revealTop}）`);
  assert(layout.answerH > 0 && layout.answerTop >= layout.ytBottom - 1, '正解テキストが動画枠に隠れない');
  const answerText = await page.locator('#reveal-answer').textContent();
  assert(answerText.includes('YouTube の答え'), `正解が表示される（${answerText}）`);
  await shot(page, 'reveal-buzzer-youtube');
  // 戻る操作の確認：pushState の番兵があり、戻っても #/play のまま（confirm は自動で OK → ホームへ）
  const guard = await page.evaluate(() => !!(history.state && history.state.introDonGuard));
  assert(guard, '戻る確認用の履歴が積まれている');
  // 暖機中の見た目（帯と中央の枠）
  await page.click('#btn-next');
  await page.waitForSelector('#buzz-stage:not([hidden])');
  await page.evaluate(() => { document.querySelector('#yt-overlay').dataset.warmup = 'true'; document.querySelector('#yt-overlay-text').textContent = '▶ 中央を1回タップして準備'; });
  await shot(page, 'warmup-overlay');
  await page.evaluate(() => { document.querySelector('#yt-overlay').dataset.warmup = 'false'; });
  // ブラウザバック → confirm（自動 OK）→ ホームへ
  await page.goBack();
  await page.waitForSelector('[data-screen="home"]:not([hidden])', { timeout: 5000 });
  const hashAfterBack = await page.evaluate(() => location.hash);
  assert(/#\/home/.test(hashAfterBack), `戻る操作の確認後にホームへ（${hashAfterBack}）`);
  await page.close();
}

// 横向き：動画枠が左上に退避し、ハブと重ならない
async function landscapeYoutubeFlow(browser) {
  const context = await browser.newContext({ ...iphone, viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  const page = await newPage(context);
  await page.goto(BASE + '#/home', { waitUntil: 'networkidle' });
  await page.waitForSelector('#builtin-list .set-card');
  await page.click('#btn-import');
  await page.waitForSelector('#dlg-import[open]');
  await page.fill('#import-text', JSON.stringify({
    schemaVersion: 1, id: 'user-e2e-landscape', title: '横向きテスト', questions: [
      { id: 'a', answer: '答え', source: { type: 'youtube', videoId: 'dQw4w9WgXcQ' } },
    ],
  }));
  await page.click('#btn-import-confirm');
  await page.waitForSelector('[data-screen="set"]:not([hidden])');
  await page.click('#btn-play-set');
  await page.waitForSelector('#btn-start:visible');
  await page.click('#mode-seg [data-mode="buzzer"]');
  await page.click('#btn-start');
  await page.waitForSelector('#buzz-stage:not([hidden])');
  await page.waitForSelector('#yt-box:not([hidden])');
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => {
    const yt = document.querySelector('#yt-box').getBoundingClientRect();
    const hub = document.querySelector('#buzz-hub').getBoundingClientRect();
    const overlap = !(yt.right <= hub.left || yt.left >= hub.right || yt.bottom <= hub.top || yt.top >= hub.bottom);
    return { ytLeft: yt.left, ytRight: yt.right, hubLeft: hub.left, hubWidth: hub.width, overlap };
  });
  assert(!r.overlap, `横向きで動画枠がハブと重ならない（${JSON.stringify(r)}）`);
  assert(r.hubWidth <= 221, `横向きでハブが縮小される（${r.hubWidth}）`);
  await shot(page, 'buzzer-landscape-youtube');
  await context.close();
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
  await youtubeBuzzerFlow(context);
  await offlineFlow(context);
  await context.close();
  await landscapeShot(browser);
  await landscapeYoutubeFlow(browser);
} finally {
  await browser.close();
}

if (errors.length) {
  console.error('ブラウザエラー:\n' + errors.join('\n'));
  process.exit(1);
}
console.log(`E2E OK（スクリーンショット: ${SHOTS}）`);
