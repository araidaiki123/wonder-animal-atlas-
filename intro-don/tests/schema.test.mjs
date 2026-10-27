// schema.mjs のテスト（node --test）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION, LIMITS, DEFAULTS,
  validateSet, normalizeSet, newUserSet, newQuestion, parseYouTubeId,
  exportSet, importSet, cloneSetForEditing,
} from '../src/schema.mjs';

const VALID = {
  schemaVersion: 1,
  id: 'konbini-chime',
  title: 'コンビニ入店音',
  emoji: '🏪',
  description: 'ドアが開くと鳴るあの音。',
  difficulty: 1,
  tags: ['お店', '定番'],
  playSeconds: 2,
  extendSeconds: 2,
  builtin: true,
  credits: '出典',
  questions: [
    {
      id: 'q01', answer: 'ファミリーマート', aliases: ['ファミマ'], subtitle: '入店音「大盛況」',
      hints: ['緑・白・青の看板', '店舗数は国内2位'], trivia: '正式名は…', searchQuery: 'ファミリーマート 入店音',
      source: { type: 'youtube', videoId: 'dQw4w9WgXcQ', start: 3 },
    },
    { id: 'q02', answer: 'セブン-イレブン', source: null },
    { id: 'q03', answer: 'ローソン', source: { type: 'local', blobId: 'b_abc123', start: 0, name: '店内.m4a', duration: 31.2 } },
  ],
};

describe('validateSet', () => {
  test('正常なセットを正規化して返す', () => {
    const r = validateSet(VALID);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.set.schemaVersion, SCHEMA_VERSION);
    assert.equal(r.set.id, 'konbini-chime');
    assert.equal(r.set.builtin, true);
    assert.deepEqual(r.set.tags, ['お店', '定番']);
    assert.equal(r.set.questions.length, 3);
    assert.deepEqual(r.set.questions[0].source, { type: 'youtube', videoId: 'dQw4w9WgXcQ', start: 3 });
    assert.equal(r.set.questions[1].searchQuery, 'セブン-イレブン', 'searchQuery 省略時は answer');
    assert.equal(r.set.questions[2].source.type, 'local');
    assert.equal(r.set.questions[2].source.duration, 31.2);
  });

  test('欠けた任意項目は既定値で埋め、未知のプロパティは捨てる', () => {
    const r = validateSet({ id: 'a', title: 't', foo: 1, questions: [{ id: 'x', answer: 'y', bar: 2 }] });
    assert.equal(r.ok, true);
    assert.equal(r.set.difficulty, DEFAULTS.difficulty);
    assert.equal(r.set.playSeconds, DEFAULTS.playSeconds);
    assert.equal(r.set.extendSeconds, DEFAULTS.extendSeconds);
    assert.equal(r.set.builtin, false);
    assert.equal(r.set.emoji, '');
    assert.deepEqual(r.set.tags, []);
    assert.equal('foo' in r.set, false);
    assert.equal('bar' in r.set.questions[0], false);
    assert.deepEqual(r.set.questions[0].aliases, []);
    assert.deepEqual(r.set.questions[0].hints, []);
    assert.equal(r.set.questions[0].source, null);
  });

  test('questions が 0 件でも ok（編集中のユーザーセット）', () => {
    assert.equal(validateSet({ id: 'user-x', title: 't' }).ok, true);
    assert.equal(validateSet({ id: 'user-x', title: 't', questions: [] }).ok, true);
  });

  test('壊れた入力で throw せず ok:false を返す', () => {
    for (const bad of [null, undefined, [], 'string', 42, true, () => {}, Symbol('s'), { }, { id: 1 }]) {
      let r;
      assert.doesNotThrow(() => { r = validateSet(bad); });
      assert.equal(r.ok, false);
      assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
    }
  });

  test('巨大文字列は throw せずエラー', () => {
    const huge = 'あ'.repeat(1_000_000);
    const r = validateSet(huge);
    assert.equal(r.ok, false);
    const r2 = validateSet({ id: 'a', title: huge, questions: [{ id: 'q', answer: huge }] });
    assert.equal(r2.ok, false);
    assert.ok(r2.errors.some((e) => e.includes('title')));
    assert.ok(r2.errors.some((e) => e.includes('answer')));
  });

  test('文字列は trim される', () => {
    const r = validateSet({ id: ' abc ', title: '  タイトル  ', questions: [{ id: ' q1 ', answer: '  答え ', aliases: [' a ', '', 'a'] }] });
    assert.equal(r.ok, true);
    assert.equal(r.set.id, 'abc');
    assert.equal(r.set.title, 'タイトル');
    assert.equal(r.set.questions[0].answer, '答え');
    assert.deepEqual(r.set.questions[0].aliases, ['a']);
  });

  test('title/answer の境界値：上限ちょうどは ok、超過は error', () => {
    const t40 = 'あ'.repeat(LIMITS.title);
    const a80 = 'い'.repeat(LIMITS.answer);
    assert.equal(validateSet({ id: 'a', title: t40, questions: [{ id: 'q', answer: a80 }] }).ok, true);
    const over = validateSet({ id: 'a', title: t40 + 'あ', questions: [{ id: 'q', answer: a80 + 'い' }] });
    assert.equal(over.ok, false);
    assert.equal(over.errors.length, 2);
    assert.equal(validateSet({ id: 'a', title: '' }).ok, false);
    assert.equal(validateSet({ id: 'a', title: '   ' }).ok, false);
    assert.equal(validateSet({ id: 'a', title: 't', questions: [{ id: 'q', answer: '' }] }).ok, false);
  });

  test('絵文字は書記素で数えるので結合絵文字も通る', () => {
    const r = validateSet({ id: 'a', title: 't', emoji: '👨‍👩‍👧' });
    assert.equal(r.ok, true);
    assert.equal(r.set.emoji, '👨‍👩‍👧');
    assert.equal(validateSet({ id: 'a', title: 't', emoji: '🏪🏪🏪' }).set.emoji, '🏪🏪');
  });

  test('description/trivia/subtitle/hints は切り詰め（error にしない）', () => {
    const r = validateSet({
      id: 'a', title: 't', description: 'd'.repeat(500), credits: 'c'.repeat(500),
      tags: Array.from({ length: 30 }, (_, i) => `t${i}`),
      questions: [{ id: 'q', answer: 'a', trivia: 'x'.repeat(400), subtitle: 's'.repeat(200), hints: ['1', '2', '3', '4', '5', '6', '7'], aliases: Array.from({ length: 30 }, (_, i) => `al${i}`) }],
    });
    assert.equal(r.ok, true);
    assert.equal(r.set.description.length, LIMITS.description);
    assert.equal(r.set.credits.length, LIMITS.credits);
    assert.equal(r.set.tags.length, LIMITS.tags);
    const q = r.set.questions[0];
    assert.equal(q.trivia.length, LIMITS.trivia);
    assert.equal(q.subtitle.length, LIMITS.subtitle);
    assert.equal(q.hints.length, LIMITS.hints);
    assert.equal(q.aliases.length, LIMITS.aliases);
  });

  test('数値は範囲にクランプ、不正値は既定', () => {
    const r = validateSet({ id: 'a', title: 't', difficulty: 9, playSeconds: 0.1, extendSeconds: 100 });
    assert.equal(r.set.difficulty, 3);
    assert.equal(r.set.playSeconds, 0.5);
    assert.equal(r.set.extendSeconds, 30);
    const r2 = validateSet({ id: 'a', title: 't', difficulty: 'abc', playSeconds: NaN, extendSeconds: '3' });
    assert.equal(r2.set.difficulty, 2);
    assert.equal(r2.set.playSeconds, 1.5);
    assert.equal(r2.set.extendSeconds, 3);
  });

  test('id の正規表現', () => {
    assert.equal(validateSet({ id: 'ABC', title: 't' }).ok, false);
    assert.equal(validateSet({ id: 'a_b', title: 't' }).ok, false);
    assert.equal(validateSet({ id: 'a'.repeat(41), title: 't' }).ok, false);
    assert.equal(validateSet({ id: 'a'.repeat(40), title: 't' }).ok, true);
    assert.equal(validateSet({ title: 't' }).ok, false);
    assert.equal(validateSet({ id: 'a', title: 't', questions: [{ id: 'あ', answer: 'x' }] }).ok, false);
    assert.equal(validateSet({ id: 'a', title: 't', questions: [{ answer: 'x' }] }).ok, false);
    assert.equal(validateSet({ id: 'a', title: 't', questions: [{ id: 'Q_1-x', answer: 'x' }] }).ok, true);
  });

  test('重複 question id は error', () => {
    const r = validateSet({ id: 'a', title: 't', questions: [{ id: 'q1', answer: 'x' }, { id: 'q1', answer: 'y' }] });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('重複')));
  });

  test('questions が配列でない／上限超過は error', () => {
    assert.equal(validateSet({ id: 'a', title: 't', questions: 'x' }).ok, false);
    assert.equal(validateSet({ id: 'a', title: 't', questions: {} }).ok, false);
    const many = Array.from({ length: LIMITS.questions + 1 }, (_, i) => ({ id: `q${i}`, answer: 'a' }));
    assert.equal(validateSet({ id: 'a', title: 't', questions: many }).ok, false);
    assert.equal(validateSet({ id: 'a', title: 't', questions: many.slice(0, LIMITS.questions) }).ok, true);
    assert.equal(validateSet({ id: 'a', title: 't', questions: [null, 'x'] }).ok, false);
  });

  test('不正な source / 未知の type は error', () => {
    const mk = (source) => validateSet({ id: 'a', title: 't', questions: [{ id: 'q', answer: 'x', source }] });
    assert.equal(mk({ type: 'spotify', uri: 'x' }).ok, false);
    assert.equal(mk({ type: 'youtube', videoId: 'short' }).ok, false);
    assert.equal(mk({ type: 'youtube' }).ok, false);
    assert.equal(mk({ type: 'local' }).ok, false);
    assert.equal(mk({ type: 'local', blobId: 'bad id!' }).ok, false);
    assert.equal(mk('youtube').ok, false);
    assert.equal(mk([]).ok, false);
    assert.equal(mk(undefined).ok, true);
    assert.equal(mk(null).ok, true);
    const ok = mk({ type: 'youtube', videoId: 'dQw4w9WgXcQ', start: -5 });
    assert.equal(ok.ok, true);
    assert.equal(ok.set.questions[0].source.start, 0);
    const big = mk({ type: 'youtube', videoId: 'dQw4w9WgXcQ', start: 99999 });
    assert.equal(big.set.questions[0].source.start, 36000);
    const loc = mk({ type: 'local', blobId: 'b_1', duration: -1, name: 'n'.repeat(500) });
    assert.equal(loc.ok, true);
    assert.equal(loc.set.questions[0].source.duration, null);
    assert.equal(loc.set.questions[0].source.name.length, LIMITS.sourceName);
    assert.equal(loc.set.questions[0].source.start, 0);
  });

  test('未来の schemaVersion は error、省略は ok', () => {
    assert.equal(validateSet({ ...VALID, schemaVersion: 99 }).ok, false);
    const { schemaVersion, ...noVer } = VALID;
    assert.equal(validateSet(noVer).ok, true);
  });

  test('入力オブジェクトを変更しない', () => {
    const input = JSON.parse(JSON.stringify(VALID));
    const snapshot = JSON.stringify(input);
    validateSet(input);
    assert.equal(JSON.stringify(input), snapshot);
  });
});

describe('normalizeSet / newUserSet / newQuestion', () => {
  test('normalizeSet は壊れていても throw しない', () => {
    assert.doesNotThrow(() => normalizeSet(null));
    assert.equal(normalizeSet(null).questions.length, 0);
    assert.equal(normalizeSet(VALID).questions.length, 3);
  });

  test('newUserSet は user- id と builtin:false、既定タイトル', () => {
    const s = newUserSet();
    assert.match(s.id, /^user-[a-z0-9]{10}$/);
    assert.equal(s.builtin, false);
    assert.equal(s.title, DEFAULTS.title);
    assert.equal(validateSet(s).ok, true);
    const s2 = newUserSet({ title: '  自作  ', builtin: true, id: 'konbini-chime' });
    assert.equal(s2.title, '自作');
    assert.equal(s2.builtin, false);
    assert.notEqual(s2.id, 'konbini-chime');
    assert.notEqual(newUserSet().id, newUserSet().id);
  });

  test('newQuestion は id を採番し、answer 空でも返す', () => {
    const q = newQuestion();
    assert.match(q.id, /^q_[a-z0-9]{8}$/);
    assert.equal(q.answer, '');
    assert.equal(q.source, null);
    assert.deepEqual(q.hints, []);
    const q2 = newQuestion({ id: 'q07', answer: ' ローソン ' });
    assert.equal(q2.id, 'q07');
    assert.equal(q2.answer, 'ローソン');
    assert.equal(q2.searchQuery, 'ローソン');
  });
});

describe('parseYouTubeId', () => {
  const ID = 'dQw4w9WgXcQ';
  const cases = [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}?t=10`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://m.youtube.com/watch?v=${ID}&list=PLxxxx&index=2`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/live/${ID}?feature=share`,
    `https://www.youtube.com/watch?feature=share&v=${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `http://youtube.com/watch?v=${ID}`,
    `youtu.be/${ID}`,
    `www.youtube.com/watch?v=${ID}`,
    ID,
    `  ${ID}  `,
    `  https://youtu.be/${ID}  `,
    `ファミリーマート 入店音 https://youtu.be/${ID}`,
    `タイトル\nhttps://www.youtube.com/watch?v=${ID}\n共有しました`,
    `見て！(https://youtu.be/${ID})`,
  ];
  for (const c of cases) {
    test(`通す: ${JSON.stringify(c)}`, () => {
      assert.equal(parseYouTubeId(c), ID);
    });
  }
  const bad = [
    '', '   ', null, undefined, 42, {}, 'abc', 'dQw4w9WgXc', 'dQw4w9WgXcQ1', 'dQw4w9WgXc!',
    'https://example.com/watch?v=dQw4w9WgXcQ', 'https://vimeo.com/123456',
    'https://www.youtube.com/', 'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/channel/UCxxxx', 'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
    'ただのテキスト dQw4w9WgXcQ です',
  ];
  for (const c of bad) {
    test(`弾く: ${JSON.stringify(String(c))}`, () => {
      assert.equal(parseYouTubeId(c), null);
    });
  }
});

describe('exportSet / importSet 往復', () => {
  test('export は builtin を false に落とし local 音源を null にする', () => {
    const { json, droppedLocalSources } = exportSet(VALID);
    assert.equal(droppedLocalSources, 1);
    const obj = JSON.parse(json);
    assert.equal(obj.builtin, false);
    assert.equal(obj._droppedLocalSources, 1);
    assert.equal(obj.questions[2].source, null);
    assert.deepEqual(obj.questions[0].source, { type: 'youtube', videoId: 'dQw4w9WgXcQ', start: 3 });
    assert.ok(json.includes('\n  '), '整形 JSON');
  });

  test('builtin:true のセットは id を user-<元id> に付け替える（複製扱い・決定的）、ユーザーセットの id はそのまま', () => {
    const a = JSON.parse(exportSet(VALID).json);
    assert.equal(a.id, 'user-konbini-chime');
    assert.equal(a.builtin, false);
    // 書き出し元は変更しない
    assert.equal(VALID.id, 'konbini-chime');
    // 2 回書き出しても同じ id（乱数ではない）
    assert.equal(JSON.parse(exportSet(VALID).json).id, a.id);
    // 40 文字の上限を超えない（id は ^[a-z0-9-]{1,40}$）
    const long = JSON.parse(exportSet({ ...VALID, id: 'a'.repeat(40) }).json);
    assert.equal(long.id, ('user-' + 'a'.repeat(40)).slice(0, 40));
    assert.equal(long.id.length, 40);
    assert.equal(importSet(exportSet({ ...VALID, id: 'a'.repeat(40) }).json).ok, true);
    // builtin でなければ id を保持
    const user = { ...VALID, id: 'user-keepme', builtin: false };
    assert.equal(JSON.parse(exportSet(user).json).id, 'user-keepme');
    // builtinIds を渡さずに取り込んでも同梱セットと衝突しない
    const r = importSet(exportSet(VALID).json);
    assert.equal(r.ok, true);
    assert.match(r.set.id, /^user-/);
  });

  test('local 音源がなければ _droppedLocalSources は付かない', () => {
    const { json, droppedLocalSources } = exportSet({ ...VALID, questions: VALID.questions.slice(0, 2) });
    assert.equal(droppedLocalSources, 0);
    assert.equal('_droppedLocalSources' in JSON.parse(json), false);
  });

  test('round-trip：export → import で内容が保たれる（builtin id は付け替え）', () => {
    const { json } = exportSet(VALID);
    const r = importSet(json, { builtinIds: ['konbini-chime'] });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.match(r.set.id, /^user-/);
    assert.equal(r.set.builtin, false);
    assert.equal('_droppedLocalSources' in r.set, false);
    assert.equal(r.set.title, VALID.title);
    assert.equal(r.set.questions.length, 3);
    assert.equal(r.set.questions[0].answer, 'ファミリーマート');
    assert.deepEqual(r.set.questions[0].hints, VALID.questions[0].hints);
    assert.equal(r.set.questions[2].source, null);
    // 2 回目の export は 1 回目と同一（id 以外）
    const again = JSON.parse(exportSet(r.set).json);
    const first = JSON.parse(json);
    delete again.id; delete first.id; delete first._droppedLocalSources;
    assert.deepEqual(again, first);
  });

  test('ユーザーセットの id は衝突しなければ保持', () => {
    const r = importSet(JSON.stringify({ id: 'user-abc', title: 'x', questions: [] }), { builtinIds: ['konbini-chime'] });
    assert.equal(r.ok, true);
    assert.equal(r.set.id, 'user-abc');
  });

  test('builtin:true のものは builtinIds を渡さなくても id を付け替える', () => {
    const r = importSet(JSON.stringify({ ...VALID, builtin: true }));
    assert.equal(r.ok, true);
    assert.match(r.set.id, /^user-/);
    assert.equal(r.set.builtin, false);
  });

  test('id 欠落 / 問題 id 欠落は補完する', () => {
    const r = importSet(JSON.stringify({ title: 'x', questions: [{ answer: 'a' }, { id: 'q01', answer: 'b' }, { answer: 'c' }] }));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.match(r.set.id, /^user-/);
    const ids = r.set.questions.map((q) => q.id);
    assert.equal(new Set(ids).size, 3);
    assert.equal(ids[1], 'q01');
  });

  test('壊れた JSON / 非オブジェクト / 不正セットは ok:false で throw しない', () => {
    for (const t of ['{', '', 'null', '[]', '"str"', JSON.stringify({ id: 'a', title: '' }), 123, null]) {
      let r;
      assert.doesNotThrow(() => { r = importSet(t); });
      assert.equal(r.ok, false);
      assert.equal(r.set, null);
      assert.ok(r.errors.length > 0);
    }
  });

  test('パース済みオブジェクトも受け付ける', () => {
    assert.equal(importSet({ id: 'user-z', title: 'x' }).ok, true);
  });
});

describe('cloneSetForEditing', () => {
  test('新しい user- id、builtin:false、問題はディープコピー', () => {
    const v = validateSet(VALID).set;
    const c = cloneSetForEditing(v);
    assert.match(c.id, /^user-/);
    assert.equal(c.builtin, false);
    assert.equal(c.title, v.title);
    assert.equal(c.questions.length, v.questions.length);
    assert.notEqual(c.questions, v.questions);
    assert.notEqual(c.questions[0], v.questions[0]);
    assert.notEqual(c.questions[0].hints, v.questions[0].hints);
    assert.deepEqual(c.questions[0], v.questions[0]);
    assert.equal(validateSet(c).ok, true);
  });
});
