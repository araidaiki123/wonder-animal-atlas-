# イントロどん — アーキテクチャ仕様（チーム共通ドキュメント）

スマホ1台で、外出先でも遊べる「イントロどん」PWA。ビルド工程なしの素のHTML/CSS/ES Modules。
GitHub Pages のサブパス（`/wonder-animal-atlas-/intro-don/`）で配信されるので、**すべてのパスは相対パス**で書く。

## 1. プロダクト方針（確定事項）

- **音源はアプリに同梱しない**（著作権・配布上の理由）。問題ごとに音源を次の3方式で「取り込む」：
  1. `youtube` … YouTube の動画 URL/ID を貼り付け。IFrame Player API で 0秒(or 指定秒)から N 秒だけ再生。要オンライン。
  2. `local` … 端末の音声ファイル（Files/ダウンロード等）を選択。IndexedDB に Blob 保存。**オフライン可**。
  3. `record` … マイクでその場録音（例：お店の来店曲を店内で録音）。`local` と同じ経路で Blob 保存。**オフライン可**。
  - 音源未設定の問題でも遊べる：「別アプリで再生」モード（司会が自分の音楽アプリで流し、本アプリは早押し・採点・答え表示を担当）。
- **同梱するのは「お題セット（問題リスト＝メタデータ）」のみ**：答え、別名、ヒント、豆知識、音源探し用の検索語。
- 遊び方は3モード：
  - **きがるモード**（`casual`）：対決しない版。プレイヤー登録も得点もなし。「どん！」で流す → 分からなければもう一度「どん！」（少し長く）やヒント → 「答えを見る」→ 次へ、を繰り返すだけ。1人でも、車やピクニックでみんなで聴きながら口頭で当てる用途。ホームの各セットカードの「🎧 聴く」で設定画面を経由せず即開始（前回の秒数設定、シャッフル有り、全問）。
  - **司会モード**（`host`）：司会が「どん！」→ 誰かが答えたら「ストップ」→ 正解者をタップして加点。
  - **早押しモード**（`buzzer`）：スマホを机の中央に置き、画面を人数分の「早押しボタン」に分割。最初にタッチした人が解答権。司会が○/×判定。
- 採点（司会・早押し）：再生回数が少ないほど高得点（1回目=3点、2回目=2点、3回目以降=1点、初期値・変更可）。誤答は 0 点でその問題の解答権を失う（設定で -1 も可）。きがるモードは採点しない。
- 外出先での利用：PWA（ホーム画面追加）、アプリ殻は Service Worker で完全キャッシュ、`local/record` 音源は IndexedDB で圏外でも再生可。

## 2. ファイル構成（担当を分けるため、ファイル単位で所有者を固定）

```
intro-don/
  ARCHITECTURE.md        … この文書（lead）
  README.md              … 利用者向け説明・デプロイ手順（lead）
  index.html             … 画面の静的骨組み（UI担当）
  styles.css             … スタイル（UI担当）
  app.js                 … UIコントローラ（画面遷移・描画・イベント）（UI担当）
  manifest.webmanifest   … PWA（UI担当）
  sw.js                  … Service Worker（UI担当）
  assets/icon-512.png, assets/icon.svg （UI担当）
  src/
    game.mjs             … 純粋関数のゲーム状態機械・採点（コア担当）
    schema.mjs           … お題セットのスキーマ検証・正規化・import/export（コア担当）
    storage.mjs          … IndexedDB/localStorage ラッパ（コア担当）
    audio/
      player.mjs         … 統一プレイヤー（音源種別で adapter を切替、N秒再生）（音声担当）
      youtube.mjs        … YouTube IFrame API adapter（音声担当）
      local.mjs          … Blob 再生 adapter + MediaRecorder 録音（音声担当）
  data/
    sets/index.json      … 同梱セットの一覧（コンテンツ担当）
    sets/<id>.json       … 各セット（コンテンツ担当）
  tests/
    *.test.mjs           … node --test（各担当が自分のモジュール分を書く）
    e2e/                 … Playwright（QA担当）
```

## 3. お題セット JSON スキーマ（`schema.mjs` が検証・正規化する）

```jsonc
{
  "schemaVersion": 1,
  "id": "konbini-chime",            // ^[a-z0-9-]{1,40}$  同梱セットは英小文字ケバブ。ユーザー作成は "user-" + ランダム
  "title": "コンビニ入店音",          // 1..40文字
  "emoji": "🏪",                     // 任意。1〜2文字
  "description": "ドアが開くと鳴るあの音。", // 任意 0..200文字
  "difficulty": 1,                   // 1..3（任意、既定2）
  "tags": ["お店", "定番"],           // 任意
  "playSeconds": 2,                  // 任意。初回再生秒数の既定（0.5..30、既定 1.5）
  "extendSeconds": 2,                // 任意。「もう一度」で延長する秒数（0.5..30、既定 2）
  "builtin": true,                   // 同梱セットは true。ユーザー作成は false/省略。
  "credits": "出典・参考（任意）",
  "questions": [
    {
      "id": "q01",                   // セット内で一意 ^[a-zA-Z0-9_-]{1,40}$
      "answer": "ファミリーマート",     // 正解表示（必須 1..80）
      "aliases": ["ファミマ"],          // 別解（任意）
      "subtitle": "入店音「大盛況」（稲田康 作曲）", // 正解時に添える補足（任意 0..120）
      "hints": ["緑・白・青の看板", "店舗数は国内2位"], // 段階ヒント（任意、最大5）
      "trivia": "正式名は「メロディーチャイム No.1 ニ長調 作品17 大盛況」。", // 任意 0..300
      "searchQuery": "ファミリーマート 入店音",  // 音源を探すときの検索語（任意）。省略時は answer
      "source": null                 // 下記 Source。未設定は null
    }
  ]
}
```

### Source（音源の指定）

```jsonc
// YouTube
{ "type": "youtube", "videoId": "dQw4w9WgXcQ", "start": 0 }   // videoId ^[A-Za-z0-9_-]{11}$、start 秒(0..36000, 既定0)
// 端末ファイル / 録音（Blob は IndexedDB の audio ストアに別保存。JSONには blobId のみ）
{ "type": "local", "blobId": "b_abc123", "start": 0, "name": "店内BGM.m4a", "duration": 31.2 }
```

- `export` 時、`local` の音源は Blob を持ち出せないので `source: null` に落とし、`_droppedLocalSources: n` を付けて利用者に知らせる（`schema.exportSet` の責務）。
- ユーザー作成セットは `questions` が 0 件でも保存可（編集中）。プレイ開始は 1 件以上必要。

### `src/schema.mjs` の公開API

```js
export const SCHEMA_VERSION = 1;
export const LIMITS = { title: 40, answer: 80, hints: 5, questions: 200, ... };
export function validateSet(obj) -> { ok: true, set: NormalizedSet } | { ok: false, errors: string[] }
   // 未知のプロパティは捨てる。文字列は trim。欠けた任意項目は既定値で埋める。壊れた question は errors に積む。
export function normalizeSet(obj) -> NormalizedSet       // validate の ok 前提の正規化（内部でも使用）
export function newUserSet(partial = {}) -> NormalizedSet // id は "user-" + 乱数、builtin:false
export function newQuestion(partial = {}) -> Question
export function parseYouTubeId(text) -> string | null     // URL(watch?v=, youtu.be/, shorts/, embed/, music.youtube.com) か 11文字ID を受け付ける
export function exportSet(set) -> { json: string, droppedLocalSources: number }  // 整形JSON。builtin は false に落とす（複製として扱う）。builtin:true のセットは id を "user-<元id>"（40 文字で切り詰め）に決定的に付け替える（元のセットは変更しない）
export function importSet(text) -> { ok, set, errors }     // JSON.parse + validateSet。id が builtin と衝突したら "user-" を付け直す
export function cloneSetForEditing(set) -> NormalizedSet   // 同梱セットを複製してユーザーセットにする
```

## 4. ゲーム状態機械（`src/game.mjs`、純粋関数・副作用なし）

```js
export const PHASES = ['lobby','ready','playing','buzzed','judging','revealed','finished'];

export const MODES = ['host', 'buzzer', 'casual'];
export const PLAYER_LIMITS = { host: [1, 8], buzzer: [2, 4], casual: [1, 1] };
export const CASUAL_PLAYER = { id: 'solo', name: 'みんな', color: null };

export function createSession({ set, players, settings, random = Math.random }) -> Session
// players: [{ id, name, color }]（1..8人）。早押しモードは 2..4 人。きがるモードは 1 人で、
//   players が空／省略なら CASUAL_PLAYER を自動補完する（UI は補完後の session.players を使う）。
// settings: {
//   mode: 'host' | 'buzzer' | 'casual',
//   playSeconds, extendSeconds,          // set の値を既定にして上書き可
//   points: [3, 2, 1],                    // 再生回数 1,2,3+ 回目の得点
//   wrongPenalty: 0,                      // 誤答のペナルティ（0 or -1）
//   shuffle: true,
//   questionLimit: null | number          // 出題数の上限（null=全問）
// }

Session = {
  setId, players, settings,
  order: [questionId...],  // shuffle に従う。questionLimit で切り詰め
  index: 0,                // 現在の問題（order の添字）
  phase: 'ready',
  playCount: 0,            // 現在の問題で「どん！」した回数
  hintCount: 0,            // 開いたヒント数
  buzzedBy: null,          // 早押しで解答権を持つ playerId
  lockedOut: [],           // 現在の問題で誤答済みの playerId
  scores: { [playerId]: number },
  log: [ { questionId, winnerId|null, points, playCount, hintCount } ],
  startedAt, finishedAt
}

// 遷移（すべて新しい Session を返す。無効な遷移は同じ Session を返す（throw しない））
export function startPlay(s)             // ready|revealed→ 'playing', playCount+1  (revealed からは呼ばない。UI が nextQuestion してから)
export function stopPlay(s)              // playing → mode==='host' ? 'judging' : 'ready'（早押し・きがるでは ready に戻る）
export function buzz(s, playerId)        // playing|ready(再生後) → 'buzzed'、buzzedBy=playerId（lockedOut なら無視。host/casual では無視）
export function judge(s, { correct, playerId })
//   host: playerId 必須。correct → points 加算、'revealed'。incorrect → lockedOut に追加、'ready'
//   buzzer: playerId は buzzedBy。同上。
//   casual: 常に無視（同じ Session を返す）。きがるの遷移は startPlay / openHint / reveal / nextQuestion だけ
export function openHint(s)              // hintCount+1（上限は question.hints.length、UI が渡す）→ 得点に影響させない（シンプル維持）
export function reveal(s)                // 'revealed' に遷移（誰も正解なし、winner null で log）
export function nextQuestion(s)          // revealed → index+1, playCount/hintCount/buzzedBy/lockedOut リセット、'ready'。最後なら 'finished'
export function currentQuestionId(s)
export function pointsForPlay(settings, playCount)  // points[min(playCount,len)-1]
export function ranking(s) -> [{ playerId, name, score, rank }]  // 同点は同順位（casual でも 1 人分を返す）
export function summaryText(s, set) -> string   // 共有用テキスト「🎵 イントロどん 結果 …」
//   casual では順位ではなく「🎵 イントロどん（セット名）／全N問 聴きました／1. 答え…／日付」（log の順、answer は set から引く）
export function playbackWindow(s) -> { start: 0, seconds }  // 今回の再生秒数 = playSeconds + extendSeconds*(playCount-1)。
//   ※ 毎回「頭から」再生し、回数ごとに長く聞かせる（イントロどんの定番ルール）
```

## 5. 統一プレイヤー（`src/audio/player.mjs`）

```js
export function createPlayer({ youtubeMount /* HTMLElement */, onStateChange }) -> Player
Player = {
  async prepare(source)                 // 問題遷移時に呼ぶ。youtube: cue、local: Blob→ObjectURL。source が null なら 'none'
                                        // adapter を別種別（または none）に切り替えるとき、前の adapter に release() があれば呼ぶ
  async play({ start = 0, seconds })    // 必ずユーザー操作（タップ）ハンドラ内から同期的に呼ぶこと（iOS対策）。seconds 後に自動停止。
                                        // 戻り値 Promise<true | false | null>（reject しない）：
                                        //   true  … 実際に再生が始まった
                                        //   false … 始まらなかった（watchdog／adapter のエラー／準備できていない）。'error' を通知済み
                                        //   null  … 始まる前に stop() / prepare() / destroy() / 再 play() で中断された（エラーではない。
                                        //           UI は「ストップ」「早押し」「やめる」などで出るこの値に対してトーストを出してはいけない）
                                        // watchdog：再生開始（PLAYING / playing イベント）が PLAY_START_TIMEOUT_MS（4 秒）以内に
                                        // 来なければ lastError = Error(PLAY_START_TIMEOUT_MESSAGE) で 'error' を通知し false で解決する。
                                        // watchdog は stop() / prepare() / destroy() / 再 play() でも必ず clear される。
  stop()
  unlock()                              // 初回タップで呼ぶ。HTMLAudio の無音再生で iOS のオーディオを解放
  resetWarmUp() -> boolean              // watchdog 後の復帰用。adapter が「暖機済み」と判断している（needsWarmUp が false。スキップ後など）なら
                                        // その adapter を destroy() して作り直し対象にし true を返す（state は 'idle'）。呼び出し側は続けて prepare() する
  get state()                           // 'idle'|'loading'|'ready'|'playing'|'error'|'none'
  get kind()                            // 'youtube'|'local'|'none'
  get lastError()
  destroy()
}
// onStateChange(state, { remainingMs?, error? }) を 100ms 間隔程度で呼ぶ（UI がプログレスを描く）
// play() 直後は onStateChange('playing', { remainingMs, elapsedMs: 0, buffering: true }) を 1 回通知する（バッファ待ち中。
// UI は buffering:true の間はリングを回さない）。実際に音が出始めてから buffering 無しの 'playing' が 100ms ごとに来る。
export const PLAY_START_TIMEOUT_MS = 4000;
export const PLAY_START_TIMEOUT_MESSAGE = '再生が始まりませんでした。動画枠の中央を1回タップしてから、もう一度「どん！」を押してください';
```

- UI（`play.mjs`）での扱い：`play()` が `false` で解決し、かつ `player.state === 'error'` のときだけ「どん！」前の状態に戻す。
  `lastError.message === PLAY_START_TIMEOUT_MESSAGE`（watchdog）なら `resetWarmUp()` → 同じ問題を `prepare()` し直し、
  タッチ端末でなくても暖機（動画枠の中央を 1 回タップ）を提示する。トーストは `PLAY_START_TIMEOUT_MESSAGE` だけを出す。
  `prepare()` 自体の失敗（圏外など）は 'error' のまま「どん！で回数だけ数える」運用になる。

- `youtube.mjs`：IFrame API（`https://www.youtube.com/iframe_api`）を遅延ロード。オフライン/ロード失敗は `error`。`YT.Player` 作成（onReady 待ち）が `timeoutMs` でタイムアウトしたら作りかけの player を `destroy()` して holder を mount から除去し、遅れて来た `onReady` は無視する（次回の `prepare` で作り直す。`destroy()` 中の作成も同様に捨てる）。`playsinline:1, controls:0, disablekb:1, rel:0, modestbranding:1, origin`。`seekTo(start,true); playVideo()` → `seconds` 後に `pauseVideo()`。再生開始検知は `onStateChange(PLAYING)` で行い、停止タイマーはそこから数える。**動画の見た目はUI側が不透明オーバーレイで覆う**（サムネ・タイトルがネタバレになるため）。音量0や display:none は使わない（iOS で再生されない恐れ）。
- `local.mjs`：`<audio playsinline>` 1要素を使い回し。`currentTime=start; play()`。停止は `timeupdate`+`setTimeout` 併用で ±50ms 以内。adapter の `release()` は ObjectURL を revoke し `audio.removeAttribute('src'); audio.load()` する（要素とリスナーは残す。player.mjs が種別切替時に呼ぶ）。録音：`createRecorder({ onLevel, audioContext, env })` → `start()/stop()` → `{ blob, mimeType, duration }`。mimeType は `audio/mp4`→`audio/webm;codecs=opus`→`audio/webm` の順で `MediaRecorder.isTypeSupported`。
  - `audioContext`：UI がタップの同期区間で生成した `AudioContext` を渡せる（iOS でレベルメーターを動かすため）。渡された場合はレベル計測に使い、**close しない**（UI の責務）。省略時は内部で生成し `stop()/cancel()` で close する。
  - `cancel()` / `stop()` は `getUserMedia` 待ち中（`state === 'requesting'`）でも有効：解決後に取得した track を stop して `start()` を `Error('録音を中止しました')` で reject する（マイクが掴まれたまま残らない）。`MediaRecorder` の生成や `recorder.start()` が throw した場合も stream を解放して reject。
  - `state`：`'inactive' | 'requesting' | 'recording'`。

## 6. ストレージ（`src/storage.mjs`）

- IndexedDB `intro-don` v1、ストア：`sets`（key: id）、`audio`（key: blobId、{ blob, mimeType, name, duration, createdAt }）、`results`（key: autoIncrement、Session の要約）。
- `localStorage`：`intro-don:settings`（最後に使った設定・プレイヤー名）。
- API（すべて Promise）：
  `loadBuiltinSets()`（`data/sets/index.json` → 各 json を fetch、validateSet 済みで返す）、
  `listUserSets()`, `getSet(id)`, `saveUserSet(set)`, `deleteUserSet(id)`（紐づく audio も削除）、
  `putAudio({blob,...}) -> blobId`, `getAudio(blobId)`, `deleteAudio(blobId)`, `estimateUsage()`（`navigator.storage.estimate`）、
  `saveResult(summary)`, `listResults(limit)`, `loadSettings()`, `saveSettings(obj)`。
- `navigator.storage.persist()` を初回保存時に要求（iOS の自動削除対策、失敗は無視）。

### Service Worker のキャッシュ方針（`sw.js`）

- **デプロイ時は必ず `sw.js` の `VERSION` を上げる**（現在 `v1.2.0`）。キャッシュ名は `intro-don-<VERSION>`。
- install：`SHELL`（index.html / styles.css / app.js / src/**/*.mjs / manifest / icons / data/sets/index.json）と `index.json` が列挙する `data/sets/*.json` を `cache.add(new Request(u, { cache: 'reload' }))` で precache する（HTTP キャッシュを経由せず必ずネットワークから取る）。
- fetch：
  - `SHELL` と `data/sets/*`（および navigate）は **バージョン付きキャッシュから cache-first**。バックグラウンド更新（stale-while-revalidate）は**しない**。古い `app.js` と新しい `*.mjs` が混在しないよう、更新は `VERSION` を上げて丸ごと入れ替える（activate で旧キャッシュを削除 → `app.js` が「新しいバージョンがあります」トースト → `SKIP_WAITING` → 再読み込み）。
  - `SHELL` 以外の同一オリジン（将来の追加ファイル）は network-first + キャッシュ fallback。
  - クロスオリジン（YouTube 等）には触らない。navigate がオフラインかつ未キャッシュなら `index.html` を返す。

## 7. 画面（`app.js` + `index.html`）

1. **ホーム**：セット一覧（同梱・自作）。各カードに曲数・難易度・音源設定済み数「🎧 8/12」、「🎧 聴く」（きがるモードで即開始。`setup.startQuick(set, { mode: 'casual' })`：前回の秒数設定（無ければセットの既定）・シャッフル有り・全問。保存済み設定は変更しない）と「あそぶ」（設定画面へ）。「＋ 自作セット」「読み込み(JSON)」。
2. **セット詳細／編集**：問題リスト。各問題に音源バッジ（YouTube／端末／録音／未設定）。タップで編集：答え・別解・ヒント・豆知識・音源（YouTube URL貼付 / ファイル選択 / 録音）。「YouTubeで探す」「Apple Musicで探す」ボタンは検索語でアプリ/ブラウザを開く外部リンク。同梱セットは「複製して編集」。
3. **ゲーム設定**：モード（きがる／司会／早押し、この順）、人数と名前、秒数、得点、出題数、シャッフル。きがる選択時は人数・名前・得点・ペナルティの欄を隠す（秒数・出題数・シャッフルは残す。説明文「得点なし。流して、答えを見て、次へ。」）。保存される設定（`storage.saveSettings`）の `mode` が `casual` でも `playerCount` / `playerNames` / `points` / `wrongPenalty` は上書きしない。
4. **プレイ**：大きな「どん！」ボタン、再生プログレス、再生回数、ヒント、「ストップ」「答えを見る」。司会モードは停止後に正解者ボタン群。早押しモードは画面を人数分に分割した巨大ボタン（横向き・縦向き両対応）。正解表示には answer/subtitle/trivia とサムネ（YouTube のみ、正解後だけ）。
   きがるモード（`section[data-mode="casual"]`）は司会モードのステージを使い回し、問題番号・どん！（＋リング）・「◯回目・N秒」・ヒント・大きめの主ボタン「答えを見る」だけを出す（スコア行・ストップ・正解者パネル・勝者行は非表示、音源なし問題の「再生した」カウンタも無し）。「次の問題」は最後の問題で「おしまい」。YouTube の暖機・watchdog・戻る番兵・案内トースト（音量のみ）は既存ロジックのまま。
5. **結果**：順位表、共有（Web Share API→クリップボード fallback）、「もう一回」「ホームへ」。きがるモードは順位表の代わりに「全N問 聴きました」と聴いた曲（answer と subtitle）のリスト。共有は `summaryText` の casual 書式。`storage.saveResult` は従来の形（ranking は 1 人分）。
- 画面遷移中に `screen.orientation`／`wakeLock`（`navigator.wakeLock.request('screen')`）でプレイ中の画面消灯を防ぐ（失敗は無視）。
- プレイ画面の「戻る」番兵：`enter()` で同じ URL の履歴（`history.state.introDonGuard`）を 1 つ積む。戻る操作（popstate）で
  まだ `#/play` なら **確認ダイアログは使わず**「ゲーム中です。やめる場合は左上の × を押してください」をトーストして
  `history.forward()` で戻す（iOS Safari のスワイプバック中は `window.confirm` が無視されることがあるため。やめるのは × のみ）。
  × でやめる／最後の問題のあと結果へ進むときは `state.session = null`（やめる場合）にしてから番兵を `history.back()` で捨て、
  popstate 後に `navigate(name, {}, { replace: true })` で置換遷移する（`leaveTo()`）。遷移先で「戻る」を押すとプレイ前の
  画面（設定）に 1 回で戻り、`#/play` には戻らない（戻っても session が無ければ `enter()` が false を返しホームへ置換）。
  結果画面の「もう一回」も置換遷移。
- プレイ画面の案内トースト（「ホーム画面に追加すると…」「自動ロックを…」「音が出ないときは…」）は **1 ゲームにつき 1 件だけ**
  （優先順：ホーム画面追加 → 自動ロック → 音量）、表示時間 4 秒、別の案内が表示中なら出さない。出せなかった案内は次のゲームに持ち越す。
- 文言はすべて日本語。タップ領域は 44px 以上。セーフエリア（`env(safe-area-inset-*)`）対応。ダーク配色（屋外の視認性のため高コントラスト）。
- Web Share Target（Android）：`manifest.share_target` で `?url=` を受け、起動時に「このYouTube動画を問題に追加」導線を出す。

### UI 基盤モジュールの API（`src/ui/router.mjs`, `toast.mjs`, `dom.mjs`）

- `router.mjs`：`registerScreen(name, { el, enter, leave })` / `navigate(name, params, { replace })` / `parseHash(hash)` / `startRouter()`。
  - 遷移の競合：`enter()` 中に別の遷移が始まった場合、その `enter` 完了後に割り込まれた画面の `leave()` を必ず呼ぶ（表示はしない）。`leave()` 中に別遷移が始まった場合は後の遷移が続きを担当する。
  - `parseHash` は `decodeURIComponent` に失敗する不正値（`#/set/%E0` 等）を `{ name: 'home' }` として扱い、throw しない。
- `toast(message, { kind, duration = 3500, action })`：`duration: 0` は常駐（返り値の `remove()` かアクションボタンで閉じる）。一時トーストは最多 `MAX_TOASTS`（3）件で古いものから間引くが、**常駐トーストは数えず間引かない**（`data-persistent` 属性が付く）。
- `dom.bindDialogClose(dlg, onClose, { backdrop = true } = {})`：`backdrop: false` で背景タップによるクローズを無効化できる（Esc と `[data-close]` の × は従来どおり）。

## 8. 品質基準（レビューで見る観点）

- `node --test intro-don/tests` が全通過。純粋関数のカバレッジ：状態遷移・採点・スキーマ境界値。
- Playwright（iPhone 14 相当ビューポート）：ホーム→セット→設定→プレイ→結果まで通し、早押し分割ボタンの多点タッチ、JSON import/export、オフライン（SW）で再読み込み。
- iOS Safari の制約：ユーザー操作内で `play()`、`playsinline`、MediaRecorder の `audio/mp4`。
- XSS：ユーザー入力は `textContent` か明示エスケープのみで描画。`innerHTML` にユーザー文字列を入れない。
- 相対パスのみ。コンソールエラー 0。Lighthouse PWA 要件（manifest, SW, icon, theme-color）。
