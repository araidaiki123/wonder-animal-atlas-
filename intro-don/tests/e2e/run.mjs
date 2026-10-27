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

/** 表示中の画面名（data-screen） */
async function visibleScreen(page) {
  return page.evaluate(() => {
    const s = Array.from(document.querySelectorAll('[data-screen]')).find((x) => !x.hidden);
    return s ? s.dataset.screen : null;
  });
}

/** 案内系トースト（エラーではないお知らせ）の本文だけを集める */
async function guideToasts(page) {
  const all = await page.locator('#toast-host .toast').allTextContents();
  return all.filter((t) => /ホーム画面に追加|自動ロック|音が出ないとき/.test(t));
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
  page.on('dialog', (d) => { dialogCount += 1; d.accept(); });
  return page;
}
let dialogCount = 0;

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
  const guides0 = await guideToasts(page);
  assert(guides0.length <= 1, `案内トーストは 1 ゲームに 1 件まで（${guides0.join(' | ')}）`);

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
  // 結果画面は番兵の履歴を捨ててから置換遷移しているので、「戻る」1 回で設定画面に戻る（プレイには戻らない）
  await page.goBack();
  await page.waitForTimeout(500);
  const afterResultBack = await visibleScreen(page);
  assert(afterResultBack === 'setup', `結果画面から戻ると 1 回で設定画面（実際 ${afterResultBack}）`);
  await page.close();
}

// × でやめる → ホーム → 戻る：設定画面に戻り、プレイ画面との間で無限ループしない（第2回レビュー #1）
async function quitBackFlow(context) {
  const page = await newPage(context);
  await page.goto(BASE + '#/home', { waitUntil: 'networkidle' });
  await page.waitForSelector('#builtin-list .set-card');
  await page.locator('#builtin-list .set-card').nth(3).locator('[data-action="play"]').click();
  await page.waitForSelector('#btn-start:visible');
  const setupHash = await page.evaluate(() => location.hash);
  assert(/^#\/setup\//.test(setupHash), `設定画面の hash（${setupHash}）`);
  await page.click('#mode-seg [data-mode="host"]');
  await page.click('#btn-start');
  await page.waitForSelector('[data-screen="play"]:not([hidden])');
  await page.waitForTimeout(300);
  assert(await page.evaluate(() => !!(history.state && history.state.introDonGuard)), '番兵の履歴が積まれている');
  // × → confirm（自動 OK）→ ホーム（置換遷移）
  await page.click('#btn-quit');
  await page.waitForSelector('[data-screen="home"]:not([hidden])', { timeout: 5000 });
  await page.waitForTimeout(300);
  assert(/^#\/home/.test(await page.evaluate(() => location.hash)), 'やめるとホームへ');
  // 戻る → 設定画面（直前の画面）。進む／戻るを繰り返してもプレイ画面には行かない
  await page.goBack();
  await page.waitForTimeout(500);
  let screen = await visibleScreen(page);
  assert(screen === 'setup', `やめたあとの「戻る」は設定画面に戻る（実際 ${screen}）`);
  assert((await page.evaluate(() => location.hash)) === setupHash, '設定画面の hash に戻る');
  for (let i = 0; i < 3; i += 1) {
    await page.goForward();
    await page.waitForTimeout(300);
    screen = await visibleScreen(page);
    assert(screen !== 'play', `進んでもプレイ画面に戻らない（#${i + 1}: ${screen}）`);
    await page.goBack();
    await page.waitForTimeout(300);
    screen = await visibleScreen(page);
    assert(screen === 'setup', `戻ると設定画面（#${i + 1}: ${screen}）`);
  }
  await shot(page, 'after-quit-back');
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
  const guides = await guideToasts(page);
  assert(guides.length <= 1, `案内トーストは 1 ゲームに 1 件まで（${guides.join(' | ')}）`);
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
  // 戻る操作の番兵：pushState の番兵がある
  const guard = await page.evaluate(() => !!(history.state && history.state.introDonGuard));
  assert(guard, '戻る確認用の履歴が積まれている');
  // 暖機中の見た目（帯と中央の枠）
  await page.click('#btn-next');
  await page.waitForSelector('#buzz-stage:not([hidden])');
  await page.evaluate(() => { document.querySelector('#yt-overlay').dataset.warmup = 'true'; document.querySelector('#yt-overlay-text').textContent = '▶ 中央を1回タップして準備'; });
  await shot(page, 'warmup-overlay');
  await page.evaluate(() => { document.querySelector('#yt-overlay').dataset.warmup = 'false'; });
  // ブラウザバック → 確認ダイアログは出さず、案内トーストを出してプレイ画面に留まる（戻るは常にキャンセル）
  const dialogsBefore = dialogCount;
  await page.goBack();
  await page.waitForTimeout(500);
  assert((await visibleScreen(page)) === 'play', '戻る操作ではプレイ画面に留まる');
  assert(dialogCount === dialogsBefore, '戻る操作で confirm を出さない');
  const guardToasts = await page.locator('#toast-host .toast').allTextContents();
  assert(guardToasts.some((t) => t.includes('ゲーム中です')), `戻る操作で案内トーストが出る（${guardToasts.join(' | ')}）`);
  assert(await page.evaluate(() => !!(history.state && history.state.introDonGuard)), 'forward() で番兵の履歴に戻っている');
  assert(/#\/play/.test(await page.evaluate(() => location.hash)), 'hash は #/play のまま');
  // × でやめる（confirm は自動 OK）→ ホーム。その後の「戻る」は設定画面（プレイには戻らない）
  await page.click('#btn-quit');
  await page.waitForSelector('[data-screen="home"]:not([hidden])', { timeout: 5000 });
  assert(dialogCount === dialogsBefore + 1, '× では confirm を出す');
  const hashAfterQuit = await page.evaluate(() => location.hash);
  assert(/#\/home/.test(hashAfterQuit), `やめるとホームへ（${hashAfterQuit}）`);
  await page.goBack();
  await page.waitForTimeout(500);
  const afterQuitBack = await visibleScreen(page);
  assert(afterQuitBack === 'setup', `やめたあとの「戻る」は設定画面（実際 ${afterQuitBack}）`);
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

// きがるモード：ホームの「🎧 聴く」→ プレイ（casual）→ 答え → 次 → … → 結果に曲リスト → 共有テキスト
async function casualFlow(context) {
  const page = await newPage(context);
  await page.goto(BASE + '#/home', { waitUntil: 'networkidle' });
  await page.waitForSelector('#builtin-list .set-card');
  const card = page.locator('#builtin-list .set-card').first();
  const total = parseInt((await card.locator('.set-meta').textContent()).match(/(\d+)曲/)[1], 10);
  assert(total > 0, `セットの曲数（${total}）`);
  const listen = card.locator('[data-action="listen"]');
  const listenBox = await listen.boundingBox();
  assert(listenBox && listenBox.height >= 44, `「聴く」のタップ領域が 44px 以上（${listenBox && listenBox.height}）`);
  await listen.click();
  await page.waitForSelector('[data-screen="play"]:not([hidden])');
  await page.waitForTimeout(300);
  assert((await page.getAttribute('[data-screen="play"]', 'data-mode')) === 'casual', 'プレイ画面が casual');
  assert(/^#\/play/.test(await page.evaluate(() => location.hash)), '設定画面を経由せずプレイへ');
  assert((await page.locator('#play-mode-badge').textContent()) === 'きがる', 'モードバッジ');
  assert((await page.locator('#play-counter').textContent()).trim() === `1 / ${total}`, '全問出題');
  assert(!(await page.locator('#play-scores').isVisible()), 'スコア行は非表示');
  assert(!(await page.locator('#btn-stop').isVisible()), 'ストップは非表示');
  assert(await page.locator('#btn-reveal').isVisible(), '「答えを見る」が表示される');
  const revealBox = await page.locator('#btn-reveal').boundingBox();
  const hintBox = await page.locator('#btn-hint').boundingBox();
  assert(revealBox.width > hintBox.width && revealBox.height >= 56, `「答えを見る」が大きめの主ボタン（${revealBox.width}x${revealBox.height}）`);
  const guides = await guideToasts(page);
  assert(guides.length <= 1 && guides.every((t) => /音が出ないとき/.test(t)), `きがるの案内は音量だけ（${guides.join(' | ')}）`);
  await shot(page, 'play-casual');

  for (let q = 0; q < total; q += 1) {
    const hasDon = await page.locator('#don-button:visible').count();
    if (hasDon) {
      await page.click('#don-button');
      await page.waitForTimeout(200);
      const phase = await page.getAttribute('[data-screen="play"]', 'data-phase');
      assert(phase === 'playing', `どん！で playing（実際 ${phase}）`);
      assert(/2回目/.test(await page.locator('#don-sub').textContent()), '「◯回目・N秒」が進む');
    } else {
      // 音源なし：別アプリで再生パネルが出る（「再生した」カウンタは出ない）
      assert(await page.locator('#no-source-panel').isVisible(), '音源なしでは別アプリパネル');
      assert((await page.locator('#no-source-panel .ns-count:visible').count()) === 0, 'きがるでは「再生した」カウンタ無し');
    }
    await page.click('#btn-reveal');
    await page.waitForSelector('#reveal-panel:not([hidden])');
    assert(!(await page.locator('#reveal-winner').isVisible()), '勝者行は出ない');
    const nextText = (await page.locator('#btn-next').textContent()).trim();
    assert(nextText === (q === total - 1 ? 'おしまい' : '次の問題'), `次ボタンの文言（${nextText}）`);
    if (q === 0) await shot(page, 'reveal-casual');
    await page.click('#btn-next');
    await page.waitForTimeout(200);
  }
  await page.waitForSelector('[data-screen="result"]:not([hidden])');
  await page.waitForTimeout(200);
  assert(!(await page.locator('#ranking').isVisible()), '順位表は出ない');
  const listenedTitle = await page.locator('#listened-title').textContent();
  assert(listenedTitle.includes(`全${total}問 聴きました`), `「全N問 聴きました」（${listenedTitle}）`);
  const items = await page.locator('#listened li').count();
  assert(items === total, `聴いた曲が ${total} 件（実際 ${items}）`);
  const summary = await page.locator('#summary-text').textContent();
  assert(summary.includes('聴きました') && !summary.includes('点'), `共有テキストに「聴きました」（${summary.split('\n')[1]}）`);
  assert(summary.split('\n').length === total + 3, '共有テキストに全曲');
  await shot(page, 'result-casual');
  // もう一回 → きがるのまま
  await page.click('#btn-again');
  await page.waitForSelector('[data-screen="play"]:not([hidden])');
  await page.waitForTimeout(300);
  assert((await page.getAttribute('[data-screen="play"]', 'data-mode')) === 'casual', 'もう一回も casual');
  await page.click('#btn-quit');
  await page.waitForSelector('[data-screen="home"]:not([hidden])', { timeout: 5000 });
  await page.close();
}

// 設定画面からきがるモードを選ぶ経路：人数・得点欄が隠れ、YouTube 音源の問題でどん！が使える。
// 保存される設定の mode が casual になっても人数・得点は壊れない
async function casualSetupFlow(context) {
  const page = await newPage(context);
  await page.goto(BASE + '#/home', { waitUntil: 'networkidle' });
  await page.waitForSelector('#builtin-list .set-card');
  await page.click('#btn-import');
  await page.waitForSelector('#dlg-import[open]');
  await page.fill('#import-text', JSON.stringify({
    schemaVersion: 1, id: 'user-e2e-casual', title: 'きがるテスト', emoji: '🎧', questions: [
      { id: 'a', answer: 'きがるの答え1', subtitle: '補足A', source: { type: 'youtube', videoId: 'dQw4w9WgXcQ' } },
      { id: 'b', answer: 'きがるの答え2' },
    ],
  }));
  await page.click('#btn-import-confirm');
  await page.waitForSelector('[data-screen="set"]:not([hidden])');
  await page.click('#btn-play-set');
  await page.waitForSelector('#btn-start:visible');
  // 保存済みの人数・得点（前のフローのもの）は、きがるで開始しても上書きされない
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('intro-don:settings') || '{}'));
  assert(typeof before.playerCount === 'number' && Array.isArray(before.points), `保存済み設定がある（${JSON.stringify(before)}）`);
  await page.click('#mode-seg [data-mode="host"]');
  assert(await page.locator('#players-block').isVisible(), '司会では人数欄が見える');
  await page.click('#mode-seg [data-mode="casual"]');
  assert((await page.getAttribute('#mode-seg [data-mode="casual"]', 'aria-checked')) === 'true', 'きがるが選択される');
  assert(!(await page.locator('#players-block').isVisible()), 'きがるでは人数欄が隠れる');
  assert(!(await page.locator('#setup-points-row').isVisible()), 'きがるでは得点欄が隠れる');
  assert(!(await page.locator('#setup-penalty-field').isVisible()), 'きがるではペナルティ欄が隠れる');
  assert(await page.locator('#setup-play-seconds').isVisible() && await page.locator('#setup-limit').isVisible() && await page.locator('#setup-shuffle').isVisible(), '秒数・出題数・シャッフルは残る');
  const desc = await page.locator('#mode-desc').textContent();
  assert(desc.includes('得点なし'), `説明文（${desc}）`);
  await shot(page, 'setup-casual');
  await page.click('#btn-start');
  await page.waitForSelector('[data-screen="play"]:not([hidden])');
  await page.waitForTimeout(300);
  assert((await page.getAttribute('[data-screen="play"]', 'data-mode')) === 'casual', '設定画面からも casual');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('intro-don:settings') || '{}'));
  assert(saved.mode === 'casual', `設定に mode=casual が保存される（${saved.mode}）`);
  assert(saved.playerCount === before.playerCount && JSON.stringify(saved.points) === JSON.stringify(before.points)
    && saved.wrongPenalty === before.wrongPenalty && JSON.stringify(saved.playerNames) === JSON.stringify(before.playerNames),
    `きがるで保存しても人数・名前・得点・ペナルティは壊れない（${JSON.stringify(saved)}）`);
  // 2 問とも流す：YouTube 問題はどん！（サンドボックスでは回数だけ）、音源なしは別アプリパネル
  let donShot = false;
  for (let q = 0; q < 2; q += 1) {
    const hasDon = await page.locator('#don-button:visible').count();
    if (hasDon) {
      if (!donShot) { donShot = true; await shot(page, 'play-casual-don'); }
      await page.click('#don-button');
      await page.waitForTimeout(200);
      assert((await page.getAttribute('[data-screen="play"]', 'data-phase')) === 'playing', 'YouTube 問題でもどん！で playing');
      await page.click('#don-button');
      await page.waitForTimeout(200);
      assert(/3回目/.test(await page.locator('#don-sub').textContent()), 'もう一度どん！で回数が増える');
    } else {
      assert(await page.locator('#no-source-panel').isVisible(), '音源なしでは別アプリパネル');
    }
    await page.click('#btn-reveal');
    await page.waitForSelector('#reveal-panel:not([hidden])');
    await page.click('#btn-next');
    await page.waitForTimeout(200);
  }
  await page.waitForSelector('[data-screen="result"]:not([hidden])');
  const subs = await page.locator('#listened .listened-sub:visible').allTextContents();
  assert(subs.length === 1 && subs[0] === '補足A', `曲リストに subtitle（${subs.join(',')}）`);
  // 次に設定画面を開くときはきがるが既定で選ばれている
  await page.goBack();
  await page.waitForTimeout(500);
  assert((await visibleScreen(page)) === 'setup', '結果から戻ると設定画面');
  assert((await page.getAttribute('#mode-seg [data-mode="casual"]', 'aria-checked')) === 'true', '前回のモード（きがる）が復元される');
  await page.click('#mode-seg [data-mode="host"]');
  assert(await page.locator('#players-block').isVisible(), '司会に戻すと人数欄が出る');
  const cnt = await page.locator('#players-list .player-name').count();
  assert(cnt === before.playerCount, `司会に戻すと保存済みの人数（${before.playerCount}）が残っている（実際 ${cnt}）`);
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
  await quitBackFlow(context);
  await buzzerFlow(context);
  await importFlow(context);
  await youtubeBuzzerFlow(context);
  await casualFlow(context);
  await casualSetupFlow(context);
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
