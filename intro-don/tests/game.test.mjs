// game.mjs のテスト（node --test）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASES, MODES, PLAYER_LIMITS, CASUAL_PLAYER, DEFAULT_SETTINGS, shuffleArray,
  createSession, startPlay, stopPlay, cancelJudging, buzz, judge, openHint, reveal, nextQuestion,
  currentQuestionId, allLockedOut, pointsForPlay, ranking, summaryText, playbackWindow,
} from '../src/game.mjs';

const SET = {
  id: 'konbini-chime',
  title: 'コンビニ入店音',
  playSeconds: 2,
  extendSeconds: 3,
  questions: [
    { id: 'q1', answer: 'A', hints: ['h1', 'h2'] },
    { id: 'q2', answer: 'B', hints: [] },
    { id: 'q3', answer: 'C', hints: ['h'] },
    { id: 'q4', answer: 'D', hints: [] },
  ],
};
const PLAYERS = [
  { id: 'p1', name: 'たろう', color: '#f00' },
  { id: 'p2', name: 'はなこ', color: '#0f0' },
  { id: 'p3', name: 'じろう', color: '#00f' },
];
const T0 = new Date(2026, 9, 27, 12, 0, 0).getTime();

const host = (settings = {}) => createSession({ set: SET, players: PLAYERS, settings: { mode: 'host', shuffle: false, ...settings }, now: T0 });
const buzzer = (settings = {}) => createSession({ set: SET, players: PLAYERS, settings: { mode: 'buzzer', shuffle: false, ...settings }, now: T0 });

// 遷移前後で入力が変更されていないことを確認するラッパ
function pure(fn, s, ...args) {
  const before = JSON.stringify(s);
  const out = fn(s, ...args);
  assert.equal(JSON.stringify(s), before, `${fn.name} が入力を変更した`);
  return out;
}

describe('createSession', () => {
  test('初期状態', () => {
    const s = host();
    assert.deepEqual(PHASES, ['lobby', 'ready', 'playing', 'buzzed', 'judging', 'revealed', 'finished']);
    assert.equal(s.setId, 'konbini-chime');
    assert.equal(s.phase, 'ready');
    assert.deepEqual(s.order, ['q1', 'q2', 'q3', 'q4']);
    assert.equal(s.index, 0);
    assert.equal(s.playCount, 0);
    assert.equal(s.hintCount, 0);
    assert.equal(s.buzzedBy, null);
    assert.deepEqual(s.lockedOut, []);
    assert.deepEqual(s.scores, { p1: 0, p2: 0, p3: 0 });
    assert.deepEqual(s.log, []);
    assert.equal(s.startedAt, T0);
    assert.equal(s.finishedAt, null);
    assert.equal(currentQuestionId(s), 'q1');
    assert.deepEqual(s.players[0], { id: 'p1', name: 'たろう', color: '#f00' });
  });

  test('settings は set の値 → 既定値で補う', () => {
    const s = host();
    assert.equal(s.settings.playSeconds, 2);
    assert.equal(s.settings.extendSeconds, 3);
    assert.deepEqual(s.settings.points, [3, 2, 1]);
    assert.equal(s.settings.wrongPenalty, 0);
    assert.equal(s.settings.questionLimit, null);
    const s2 = createSession({ set: { ...SET, playSeconds: undefined }, players: PLAYERS, settings: { playSeconds: 5, points: [5, 3], wrongPenalty: -1 } });
    assert.equal(s2.settings.playSeconds, 5);
    assert.deepEqual(s2.settings.points, [5, 3]);
    assert.equal(s2.settings.wrongPenalty, -1);
    assert.equal(s2.settings.mode, 'host');
    assert.equal(s2.settings.shuffle, true);
    const s3 = createSession({ set: { ...SET, playSeconds: undefined, extendSeconds: undefined }, players: PLAYERS });
    assert.equal(s3.settings.playSeconds, DEFAULT_SETTINGS.playSeconds);
    assert.equal(s3.settings.extendSeconds, DEFAULT_SETTINGS.extendSeconds);
  });

  test('シャッフルは Fisher–Yates で random 注入により決定的', () => {
    // random が常に 0 → 毎回 j=0 と交換：[a,b,c,d] → [b,c,d,a]
    const s = createSession({ set: SET, players: PLAYERS, settings: { shuffle: true }, random: () => 0 });
    assert.deepEqual(s.order, ['q2', 'q3', 'q4', 'q1']);
    // random が常に 1 直前 → j=i で交換なし
    const s2 = createSession({ set: SET, players: PLAYERS, settings: { shuffle: true }, random: () => 0.999999 });
    assert.deepEqual(s2.order, ['q1', 'q2', 'q3', 'q4']);
    assert.deepEqual(shuffleArray([1, 2, 3, 4], () => 0), [2, 3, 4, 1]);
    // 全要素が保たれる
    const s3 = createSession({ set: SET, players: PLAYERS });
    assert.deepEqual([...s3.order].sort(), ['q1', 'q2', 'q3', 'q4']);
  });

  test('questionLimit で切り詰め', () => {
    assert.deepEqual(host({ questionLimit: 2 }).order, ['q1', 'q2']);
    assert.equal(host({ questionLimit: 99 }).order.length, 4);
    assert.equal(host({ questionLimit: 0 }).order.length, 4, '0 以下は無視');
    assert.equal(host({ questionLimit: 2.7 }).order.length, 2);
  });

  test('不正な引数は throw', () => {
    assert.throws(() => createSession({ set: { ...SET, questions: [] }, players: PLAYERS }));
    assert.throws(() => createSession({ set: null, players: PLAYERS }));
    assert.throws(() => createSession({ set: SET, players: [] }));
    assert.throws(() => createSession({ set: SET, players: Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, name: 'x' })) }));
    assert.throws(() => createSession({ set: SET, players: [PLAYERS[0]], settings: { mode: 'buzzer' } }), /早押し/);
    assert.throws(() => createSession({ set: SET, players: Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: 'x' })), settings: { mode: 'buzzer' } }));
    assert.throws(() => createSession({ set: SET, players: [{ id: 'a' }, { id: 'a' }] }), /重複/);
    assert.doesNotThrow(() => createSession({ set: SET, players: Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: 'x' })) }));
    assert.doesNotThrow(() => createSession({ set: SET, players: Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, name: 'x' })), settings: { mode: 'buzzer' } }));
  });

  test('プレイヤーの id/name が欠けていれば補う', () => {
    const s = createSession({ set: SET, players: [{}, { name: '  ' }] });
    assert.deepEqual(s.players.map((p) => p.id), ['p1', 'p2']);
    assert.deepEqual(s.players.map((p) => p.name), ['プレイヤー1', 'プレイヤー2']);
  });
});

describe('司会モードの遷移', () => {
  test('どん！→ストップ→正解で加点、revealed', () => {
    let s = host();
    s = pure(startPlay, s);
    assert.equal(s.phase, 'playing');
    assert.equal(s.playCount, 1);
    s = pure(stopPlay, s);
    assert.equal(s.phase, 'judging');
    s = pure(judge, s, { correct: true, playerId: 'p2' });
    assert.equal(s.phase, 'revealed');
    assert.equal(s.scores.p2, 3);
    assert.deepEqual(s.log, [{ questionId: 'q1', winnerId: 'p2', points: 3, playCount: 1, hintCount: 0 }]);
  });

  test('再生回数が増えると得点が減る（3,2,1,1…）', () => {
    let s = host();
    for (let i = 0; i < 4; i++) {
      s = startPlay(s);
      s = stopPlay(s);
      if (i < 3) s = judge(s, { correct: false, playerId: `p${i + 1}` }); // 全員誤答 → ready に戻る
    }
    assert.equal(s.playCount, 4);
    assert.equal(s.phase, 'judging');
    assert.deepEqual(s.lockedOut, ['p1', 'p2', 'p3']);
    assert.equal(allLockedOut(s), true);
    // 全員 lockedOut なので誰も正解できない → judge は無視
    assert.equal(judge(s, { correct: true, playerId: 'p1' }), s);
    s = reveal(s);
    assert.equal(s.phase, 'revealed');
    assert.deepEqual(s.log[0], { questionId: 'q1', winnerId: null, points: 0, playCount: 4, hintCount: 0 });
  });

  test('誤答はペナルティ 0 なら減点なし、lockedOut 追加、ready に戻る', () => {
    let s = host();
    s = stopPlay(startPlay(s));
    s = pure(judge, s, { correct: false, playerId: 'p1' });
    assert.equal(s.phase, 'ready');
    assert.deepEqual(s.lockedOut, ['p1']);
    assert.equal(s.scores.p1, 0);
    // 同じプレイヤーは再判定できない
    s = stopPlay(startPlay(s));
    assert.equal(judge(s, { correct: true, playerId: 'p1' }), s);
    // 別のプレイヤーは 2 回目なので 2 点
    s = judge(s, { correct: true, playerId: 'p3' });
    assert.equal(s.scores.p3, 2);
  });

  test('wrongPenalty が負値なら加算（下限なし）、正値は無視', () => {
    let s = host({ wrongPenalty: -1 });
    s = judge(stopPlay(startPlay(s)), { correct: false, playerId: 'p1' });
    assert.equal(s.scores.p1, -1);
    s = judge(stopPlay(startPlay(s)), { correct: false, playerId: 'p2' });
    s = nextQuestion(reveal(s));
    s = judge(stopPlay(startPlay(s)), { correct: false, playerId: 'p1' });
    assert.equal(s.scores.p1, -2, '下限なし');
    let s2 = host({ wrongPenalty: 5 });
    s2 = judge(stopPlay(startPlay(s2)), { correct: false, playerId: 'p1' });
    assert.equal(s2.scores.p1, 0, '正のペナルティは加点しない');
  });

  test('司会モード：誤答のあと再生せずに stopPlay すると judging へ', () => {
    let s = judge(stopPlay(startPlay(host())), { correct: false, playerId: 'p1' });
    assert.equal(s.phase, 'ready');
    s = stopPlay(s);
    assert.equal(s.phase, 'judging');
  });

  test('無効な遷移は同じオブジェクトを返す', () => {
    const s = host();
    assert.equal(stopPlay(s), s, 'まだ一度も再生していなければ stopPlay は無効');
    assert.equal(judge(s, { correct: true, playerId: 'p1' }), s);
    assert.equal(nextQuestion(s), s);
    assert.equal(buzz(s, 'p1'), s, '司会モードでは buzz を無視');
    const playing = startPlay(s);
    assert.equal(startPlay(playing).playCount, 2, 'playing からの再押しは回数が増える');
    assert.equal(startPlay(playing).phase, 'playing');
    assert.equal(judge(playing, { correct: true, playerId: 'p1' }), playing);
    assert.equal(nextQuestion(playing), playing);
    const judging = stopPlay(playing);
    assert.equal(judge(judging, { correct: true, playerId: 'nobody' }), judging);
    assert.equal(judge(judging, { correct: true }), judging);
    assert.equal(startPlay(judging), judging);
    assert.equal(cancelJudging(judging).phase, 'ready');
    assert.equal(cancelJudging(playing), playing);
    const revealed = reveal(judging);
    assert.equal(reveal(revealed), revealed);
    assert.equal(startPlay(revealed), revealed, 'revealed からは startPlay しない');
    assert.equal(stopPlay(revealed), revealed);
    assert.equal(judge(revealed, { correct: true, playerId: 'p1' }), revealed);
    assert.equal(openHint(revealed), revealed);
  });

  test('nextQuestion でリセットし、最後は finished', () => {
    let s = host({ questionLimit: 2 });
    s = openHint(s);
    s = judge(stopPlay(startPlay(s)), { correct: false, playerId: 'p1' });
    s = reveal(s);
    s = pure(nextQuestion, s, T0 + 1000);
    assert.equal(s.phase, 'ready');
    assert.equal(s.index, 1);
    assert.equal(currentQuestionId(s), 'q2');
    assert.equal(s.playCount, 0);
    assert.equal(s.hintCount, 0);
    assert.equal(s.buzzedBy, null);
    assert.deepEqual(s.lockedOut, []);
    assert.equal(s.finishedAt, null);
    s = judge(stopPlay(startPlay(s)), { correct: true, playerId: 'p1' });
    s = nextQuestion(s, T0 + 5000);
    assert.equal(s.phase, 'finished');
    assert.equal(s.index, 1);
    assert.equal(s.finishedAt, T0 + 5000);
    assert.equal(s.log.length, 2);
    // finished からは何もできない
    assert.equal(startPlay(s), s);
    assert.equal(reveal(s), s);
    assert.equal(nextQuestion(s), s);
    assert.equal(openHint(s), s);
  });

  test('openHint は上限まで、得点に影響しない', () => {
    let s = host();
    s = pure(openHint, s, 2);
    s = openHint(s, 2);
    assert.equal(s.hintCount, 2);
    assert.equal(openHint(s, 2), s, '上限で無視');
    s = openHint(s); // 上限未指定なら増える
    assert.equal(s.hintCount, 3);
    s = judge(stopPlay(startPlay(s)), { correct: true, playerId: 'p1' });
    assert.equal(s.scores.p1, 3);
    assert.equal(s.log[0].hintCount, 3);
  });

  test('reveal は ready/playing からも可能', () => {
    const s = host();
    assert.equal(reveal(s).phase, 'revealed');
    assert.equal(reveal(startPlay(s)).phase, 'revealed');
    assert.equal(reveal(s).log[0].winnerId, null);
  });
});

describe('早押しモードの遷移', () => {
  test('playing 中の buzz → judge 正解', () => {
    let s = buzzer();
    assert.equal(buzz(s, 'p1'), s, '再生前は押せない');
    s = startPlay(s);
    s = pure(buzz, s, 'p2');
    assert.equal(s.phase, 'buzzed');
    assert.equal(s.buzzedBy, 'p2');
    assert.equal(buzz(s, 'p1'), s, 'すでに誰かが押している');
    s = pure(judge, s, { correct: true, playerId: 'p1' /* 無視される */ });
    assert.equal(s.phase, 'revealed');
    assert.equal(s.scores.p2, 3);
    assert.equal(s.scores.p1, 0);
    assert.equal(s.log[0].winnerId, 'p2');
  });

  test('stopPlay で誰も押さなければ ready、その後も playCount>0 なら buzz 可', () => {
    let s = buzzer();
    s = stopPlay(startPlay(s));
    assert.equal(s.phase, 'ready');
    assert.equal(s.playCount, 1);
    s = buzz(s, 'p3');
    assert.equal(s.phase, 'buzzed');
    assert.equal(s.buzzedBy, 'p3');
  });

  test('誤答 → ready に戻り、押し直せる。lockedOut は無視。全員で allLockedOut', () => {
    let s = buzzer();
    s = buzz(startPlay(s), 'p1');
    s = judge(s, { correct: false });
    assert.equal(s.phase, 'ready');
    assert.equal(s.buzzedBy, null);
    assert.deepEqual(s.lockedOut, ['p1']);
    assert.equal(allLockedOut(s), false);
    assert.equal(buzz(s, 'p1'), s, 'lockedOut は無視');
    s = startPlay(s);
    assert.equal(s.playCount, 2);
    assert.equal(buzz(s, 'p1'), s);
    s = judge(buzz(s, 'p2'), { correct: false });
    s = judge(buzz(startPlay(s), 'p3'), { correct: false });
    assert.equal(s.playCount, 3);
    assert.deepEqual(s.lockedOut, ['p1', 'p2', 'p3']);
    assert.equal(allLockedOut(s), true);
    assert.equal(s.phase, 'ready');
    const p = startPlay(s);
    assert.equal(buzz(p, 'p2'), p, '全員 lockedOut なら誰も押せない');
    s = reveal(s);
    assert.equal(s.phase, 'revealed');
    assert.equal(s.log[0].winnerId, null);
    assert.equal(s.log[0].playCount, 3);
  });

  test('buzz の無効ケース', () => {
    let s = startPlay(buzzer());
    assert.equal(buzz(s, 'nobody'), s);
    assert.equal(buzz(s), s);
    assert.equal(judge(s, { correct: true }), s, 'buzzed でないと判定不可');
    const b = buzz(s, 'p1');
    assert.equal(startPlay(b), b);
    assert.equal(stopPlay(b), b);
    assert.equal(nextQuestion(b), b);
    assert.equal(reveal(b).phase, 'revealed');
    assert.equal(reveal(b).buzzedBy, null);
  });

  test('得点は playCount に従う、ペナルティ', () => {
    let s = buzzer({ wrongPenalty: -1, points: [5, 3, 1] });
    s = judge(buzz(startPlay(s), 'p1'), { correct: false });
    assert.equal(s.scores.p1, -1);
    s = judge(buzz(startPlay(s), 'p2'), { correct: true });
    assert.equal(s.scores.p2, 3);
    s = nextQuestion(s);
    s = stopPlay(startPlay(s)); s = stopPlay(startPlay(s)); s = stopPlay(startPlay(s)); s = stopPlay(startPlay(s));
    s = judge(buzz(s, 'p3'), { correct: true });
    assert.equal(s.scores.p3, 1);
  });
});

describe('きがるモード（casual）', () => {
  const casual = (settings = {}, players) => createSession({ set: SET, players, settings: { mode: 'casual', shuffle: false, ...settings }, now: T0 });

  test('MODES / PLAYER_LIMITS に casual がある', () => {
    assert.deepEqual(MODES, ['host', 'buzzer', 'casual']);
    assert.deepEqual(PLAYER_LIMITS.casual, [1, 1]);
    assert.deepEqual(CASUAL_PLAYER, { id: 'solo', name: 'みんな', color: null });
  });

  test('players が空／省略なら「みんな」1 人を補う', () => {
    const s = casual();
    assert.equal(s.settings.mode, 'casual');
    assert.deepEqual(s.players, [{ id: 'solo', name: 'みんな', color: null }]);
    assert.deepEqual(s.scores, { solo: 0 });
    assert.deepEqual(casual({}, []).players, [{ id: 'solo', name: 'みんな', color: null }]);
    // 明示した 1 人はそのまま使う。2 人以上は 1 人制限で throw
    assert.deepEqual(casual({}, [{ id: 'me', name: 'わたし' }]).players, [{ id: 'me', name: 'わたし', color: null }]);
    assert.throws(() => casual({}, PLAYERS), /きがるモードのプレイヤー数は 1〜1 人/);
    // 既存モードは従来どおり players 必須
    assert.throws(() => createSession({ set: SET, settings: { mode: 'host' } }), /プレイヤーが必要/);
  });

  test('どん！→ストップは ready に戻る。buzz／judge は無視', () => {
    let s = casual();
    s = pure(startPlay, s);
    assert.equal(s.phase, 'playing');
    assert.equal(s.playCount, 1);
    assert.equal(pure(buzz, s, 'solo'), s, 'buzz は無視');
    assert.equal(pure(judge, s, { correct: true, playerId: 'solo' }), s, 'judge は無視');
    s = pure(stopPlay, s);
    assert.equal(s.phase, 'ready', 'きがるでは judging に行かず ready');
    assert.equal(stopPlay(s), s, 'ready+playCount>0 でも judging に進まない');
    assert.equal(judge(s, { correct: true, playerId: 'solo' }), s);
    assert.equal(buzz(s, 'solo'), s);
    s = startPlay(s);
    assert.equal(s.playCount, 2);
    assert.deepEqual(playbackWindow(s), { start: 0, seconds: 5 });
    s = openHint(s, 2);
    assert.equal(s.hintCount, 1);
    s = pure(reveal, s);
    assert.equal(s.phase, 'revealed');
    assert.deepEqual(s.log, [{ questionId: 'q1', winnerId: null, points: 0, playCount: 2, hintCount: 1 }]);
    assert.deepEqual(s.scores, { solo: 0 }, '得点は増えない');
    assert.equal(judge(s, { correct: true, playerId: 'solo' }), s);
    s = pure(nextQuestion, s, T0 + 1000);
    assert.equal(s.phase, 'ready');
    assert.equal(s.index, 1);
    assert.equal(s.playCount, 0);
  });

  test('全問聴くと finished、ranking は 1 人分で壊れない', () => {
    let s = casual({ questionLimit: 2 });
    s = nextQuestion(reveal(startPlay(s)), T0 + 1);
    s = nextQuestion(reveal(s), T0 + 2);
    assert.equal(s.phase, 'finished');
    assert.equal(s.finishedAt, T0 + 2);
    assert.equal(s.log.length, 2);
    assert.deepEqual(ranking(s), [{ playerId: 'solo', name: 'みんな', score: 0, rank: 1 }]);
  });

  test('summaryText は順位ではなく聴いた曲のリスト（log 順、answer は set から）', () => {
    let s = createSession({ set: SET, settings: { mode: 'casual', shuffle: true, questionLimit: 3 }, random: () => 0, now: T0 });
    assert.deepEqual(s.order, ['q2', 'q3', 'q4']);
    s = nextQuestion(reveal(startPlay(s)), T0 + 1);
    s = nextQuestion(reveal(s), T0 + 2);
    s = nextQuestion(reveal(startPlay(startPlay(s))), T0 + 3);
    assert.equal(s.phase, 'finished');
    assert.equal(summaryText(s, SET), [
      '🎵 イントロどん（コンビニ入店音）',
      '全3問 聴きました',
      '1. B',
      '2. C',
      '3. D',
      '2026-10-27',
    ].join('\n'));
    // set が無ければ questionId、タイトル無し
    assert.equal(summaryText(s).split('\n')[0], '🎵 イントロどん');
    assert.equal(summaryText(s).split('\n')[2], '1. q2');
    // 途中（finished 前）でも log にある分だけ並ぶ
    const mid = reveal(startPlay(casual()));
    assert.deepEqual(summaryText(mid, SET).split('\n'), ['🎵 イントロどん（コンビニ入店音）', '全4問 聴きました', '1. A', '2026-10-27']);
  });
});

describe('pointsForPlay / playbackWindow', () => {
  test('pointsForPlay = points[min(playCount,len)-1]', () => {
    const st = { points: [3, 2, 1] };
    assert.equal(pointsForPlay(st, 1), 3);
    assert.equal(pointsForPlay(st, 2), 2);
    assert.equal(pointsForPlay(st, 3), 1);
    assert.equal(pointsForPlay(st, 10), 1);
    assert.equal(pointsForPlay(st, 0), 3, '0 は 1 回目扱い');
    assert.equal(pointsForPlay({ points: [5] }, 4), 5);
    assert.equal(pointsForPlay({}, 2), 2, '既定の points');
    assert.equal(pointsForPlay({ points: [] }, 1), 3);
  });

  test('playbackWindow は毎回頭から、回数ごとに延長', () => {
    let s = host();
    assert.deepEqual(playbackWindow(s), { start: 0, seconds: 2 });
    s = startPlay(s);
    assert.deepEqual(playbackWindow(s), { start: 0, seconds: 2 });
    s = startPlay(judge(stopPlay(s), { correct: false, playerId: 'p1' }));
    assert.deepEqual(playbackWindow(s), { start: 0, seconds: 5 });
    s = startPlay(judge(stopPlay(s), { correct: false, playerId: 'p2' }));
    assert.deepEqual(playbackWindow(s), { start: 0, seconds: 8 });
  });
});

describe('ranking / summaryText', () => {
  function withScores(scores) {
    return { ...host(), scores };
  }

  test('同点同順位（1,1,3 方式）', () => {
    const r = ranking(withScores({ p1: 6, p2: 9, p3: 6 }));
    assert.deepEqual(r, [
      { playerId: 'p2', name: 'はなこ', score: 9, rank: 1 },
      { playerId: 'p1', name: 'たろう', score: 6, rank: 2 },
      { playerId: 'p3', name: 'じろう', score: 6, rank: 2 },
    ]);
    const r2 = ranking(withScores({ p1: 5, p2: 5, p3: 1 }));
    assert.deepEqual(r2.map((x) => x.rank), [1, 1, 3]);
    const r3 = ranking(withScores({ p1: 0, p2: 0, p3: 0 }));
    assert.deepEqual(r3.map((x) => [x.playerId, x.rank]), [['p1', 1], ['p2', 1], ['p3', 1]]);
  });

  test('summaryText の書式', () => {
    const s = { ...withScores({ p1: 9, p2: 6, p3: 6 }), finishedAt: T0 };
    const text = summaryText(s, SET);
    assert.equal(text, [
      '🎵 イントロどん 結果（コンビニ入店音）',
      '🥇 たろう 9点',
      '🥈 はなこ 6点',
      '🥈 じろう 6点',
      '全4問 / 2026-10-27',
    ].join('\n'));
  });

  test('summaryText 4位以降は番号、タイトル無しも可', () => {
    const players = [
      { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D' }, { id: 'e', name: 'E' },
    ];
    let s = createSession({ set: SET, players, settings: { shuffle: false, questionLimit: 3 }, now: T0 });
    s = { ...s, scores: { a: 1, b: 5, c: 3, d: 2, e: 0 } };
    const lines = summaryText(s).split('\n');
    assert.equal(lines[0], '🎵 イントロどん 結果');
    assert.equal(lines[1], '🥇 B 5点');
    assert.equal(lines[2], '🥈 C 3点');
    assert.equal(lines[3], '🥉 D 2点');
    assert.equal(lines[4], '4. A 1点');
    assert.equal(lines[5], '5. E 0点');
    assert.equal(lines[6], '全3問 / 2026-10-27');
  });
});

describe('フルゲーム通し（イミュータブル確認）', () => {
  test('司会モードで全問プレイしても途中の Session は変わらない', () => {
    const s0 = host();
    const snap = JSON.stringify(s0);
    let s = s0;
    const history = [s];
    for (let i = 0; i < SET.questions.length; i++) {
      s = startPlay(s); history.push(s);
      s = stopPlay(s); history.push(s);
      s = judge(s, { correct: true, playerId: PLAYERS[i % 3].id }); history.push(s);
      s = nextQuestion(s, T0 + i); history.push(s);
    }
    assert.equal(s.phase, 'finished');
    assert.equal(s.log.length, 4);
    assert.deepEqual(s.scores, { p1: 6, p2: 3, p3: 3 });
    assert.equal(JSON.stringify(s0), snap);
    for (let i = 1; i < history.length; i++) assert.notEqual(history[i], history[i - 1]);
  });
});
