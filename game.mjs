"use strict";

export const CARD_RANKS = Object.freeze([
  { id: "sprout", name: "芽吹き", mark: "○", symbol: "I", order: 0, probability: 0.50, duplicateLeaves: 1 },
  { id: "sunbeam", name: "木漏れ日", mark: "△", symbol: "II", order: 1, probability: 0.27, duplicateLeaves: 2 },
  { id: "starlight", name: "星明かり", mark: "◇", symbol: "III", order: 2, probability: 0.13, duplicateLeaves: 4 },
  { id: "moonbow", name: "月虹", mark: "✧", symbol: "IV", order: 3, probability: 0.07, duplicateLeaves: 8 },
  { id: "lifecrown", name: "生命の宝冠", mark: "✦", symbol: "V", order: 4, probability: 0.03, duplicateLeaves: 15 }
]);

export const QUIZ_CORRECT_POINTS = 20;
export const DAILY_QUIZ_LIMIT = 5;
export const PITY_LIMIT = 30;
export const LEAF_EXCHANGE_COST = 30;
export const SINGLE_DRAW_COST = 100;
export const TEN_DRAW_COST = 900;
export const GAME_SCHEMA_VERSION = 3;
const MAX_POINT_TOTAL = 1_000_000;

export function localDateKey(date = new Date()) {
  const safeDate = date instanceof Date && !Number.isNaN(date.valueOf()) ? date : new Date();
  const year = safeDate.getFullYear();
  const month = String(safeDate.getMonth() + 1).padStart(2, "0");
  const day = String(safeDate.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function createDefaultGameState() {
  return {
    schemaVersion: GAME_SCHEMA_VERSION,
    revision: 0,
    lifetimePoints: 0,
    spendablePoints: 0,
    leaves: 0,
    owned: {},
    totalDraws: 0,
    pityCount: 0,
    lastDailyDrawDate: null,
    latestSeenDate: null,
    speciesBag: [],
    unopenedSingles: 0,
    unopenedTens: 0,
    totalFirstTryCorrect: 0,
    quizDay: {
      dateKey: null,
      offeredIds: [],
      attemptedIds: [],
      rewardedIds: [],
      tenBonusAwarded: false
    },
    history: []
  };
}

export function chooseGameSnapshot(primaryText, backupText) {
  for (const [source, text] of [["primary", primaryText], ["backup", backupText]]) {
    if (typeof text !== "string" || !text) continue;
    try {
      const value = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value)) return { value, source };
    } catch {
      // 次の候補を確認する。
    }
  }
  return { value: createDefaultGameState(), source: "default" };
}

function safeInteger(value, maximum = 1_000_000) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return 0;
  return Math.min(number, maximum);
}

function uniqueKnownIds(value, knownIds, maximum = 200) {
  if (!Array.isArray(value)) return [];
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
  return [...new Set(value.filter(id => typeof id === "string" && (!known.size || known.has(id))))].slice(0, maximum);
}

function validDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function sanitizeGameState(raw, animalIds = [], quizIds = []) {
  const fallback = createDefaultGameState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const animalSet = new Set(animalIds);
  const quizSet = new Set(quizIds);
  const validCardIds = new Set();
  for (const animalId of animalSet) {
    for (const rank of CARD_RANKS) validCardIds.add(`${animalId}--${rank.id}`);
  }
  const owned = {};
  if (raw.owned && typeof raw.owned === "object" && !Array.isArray(raw.owned)) {
    for (const [id, count] of Object.entries(raw.owned)) {
      const safeCount = safeInteger(count, 999);
      if (validCardIds.has(id) && safeCount > 0) owned[id] = safeCount;
    }
  }
  const quizDay = raw.quizDay && typeof raw.quizDay === "object" ? raw.quizDay : {};
  const rawSchemaVersion = safeInteger(raw.schemaVersion, 100);
  const legacyPoints = safeInteger(raw.points);
  const legacySingles = safeInteger(raw.unopenedSingles, 1000);
  const legacyTens = safeInteger(raw.unopenedTens, 100);
  const isLegacyEconomy = rawSchemaVersion < GAME_SCHEMA_VERSION;
  const storedLifetimePoints = safeInteger(raw.lifetimePoints);
  const storedSpendablePoints = safeInteger(raw.spendablePoints);
  const lifetimePoints = isLegacyEconomy
    ? Math.max(storedLifetimePoints, legacyPoints)
    : storedLifetimePoints;
  const spendablePoints = isLegacyEconomy
    ? Math.min(MAX_POINT_TOTAL, storedSpendablePoints + legacyPoints + legacySingles * SINGLE_DRAW_COST + legacyTens * TEN_DRAW_COST)
    : storedSpendablePoints;
  const history = Array.isArray(raw.history)
    ? raw.history.filter(item => item && typeof item === "object").slice(-30)
    : [];
  return {
    schemaVersion: GAME_SCHEMA_VERSION,
    revision: safeInteger(raw.revision),
    lifetimePoints,
    spendablePoints,
    leaves: safeInteger(raw.leaves),
    owned,
    totalDraws: safeInteger(raw.totalDraws),
    pityCount: Math.min(safeInteger(raw.pityCount), PITY_LIMIT - 1),
    lastDailyDrawDate: validDateKey(raw.lastDailyDrawDate) ? raw.lastDailyDrawDate : null,
    latestSeenDate: validDateKey(raw.latestSeenDate) ? raw.latestSeenDate : null,
    speciesBag: uniqueKnownIds(raw.speciesBag, animalSet, animalSet.size),
    unopenedSingles: 0,
    unopenedTens: 0,
    totalFirstTryCorrect: safeInteger(raw.totalFirstTryCorrect),
    quizDay: {
      dateKey: validDateKey(quizDay.dateKey) ? quizDay.dateKey : null,
      offeredIds: uniqueKnownIds(quizDay.offeredIds, quizSet, DAILY_QUIZ_LIMIT),
      attemptedIds: uniqueKnownIds(quizDay.attemptedIds, quizSet, DAILY_QUIZ_LIMIT),
      rewardedIds: uniqueKnownIds(quizDay.rewardedIds, quizSet, DAILY_QUIZ_LIMIT),
      tenBonusAwarded: Boolean(quizDay.tenBonusAwarded)
    },
    history
  };
}

function normalizedRandom(random) {
  const value = Number(random());
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.999999999, Math.max(0, value));
}

export function secureRandom() {
  if (globalThis.crypto?.getRandomValues) {
    const values = new Uint32Array(1);
    globalThis.crypto.getRandomValues(values);
    return values[0] / 0x100000000;
  }
  return Math.random();
}

export function getRank(rankId) {
  return CARD_RANKS.find(rank => rank.id === rankId) || CARD_RANKS[0];
}

export function isDailyDrawAvailable(lastDailyDrawDate, todayKey) {
  return String(lastDailyDrawDate || "") !== String(todayKey || "");
}

export const isDailyFreeAvailable = isDailyDrawAvailable;

export function hasClockRollback(latestSeenDate, todayKey) {
  return Boolean(latestSeenDate && todayKey && String(todayKey) < String(latestSeenDate));
}

export function recoverClockRollback(gameState, todayKey, offeredIds) {
  if (!hasClockRollback(gameState?.latestSeenDate, todayKey)) {
    return { recovered: false, game: gameState };
  }
  const game = structuredClone(gameState);
  game.latestSeenDate = todayKey;
  game.lastDailyDrawDate = todayKey;
  game.quizDay = {
    dateKey: todayKey,
    offeredIds: [...new Set(offeredIds || [])].slice(0, DAILY_QUIZ_LIMIT),
    attemptedIds: [...new Set(offeredIds || [])].slice(0, DAILY_QUIZ_LIMIT),
    rewardedIds: [],
    tenBonusAwarded: false
  };
  game.revision += 1;
  game.history = [...(game.history || []), { type: "clock-recovery", dateKey: todayKey }].slice(-30);
  return { recovered: true, game };
}

export function chooseRank(random, pityCount = 0, minimumOrder = 0) {
  if (Number(pityCount) >= PITY_LIMIT - 1) return CARD_RANKS.at(-1);
  const eligible = CARD_RANKS.filter(rank => rank.order >= minimumOrder);
  const total = eligible.reduce((sum, rank) => sum + rank.probability, 0);
  let cursor = normalizedRandom(random) * total;
  for (const rank of eligible) {
    cursor -= rank.probability;
    if (cursor < 0) return rank;
  }
  return eligible.at(-1);
}

function takeSpecies(animalIds, bag, random) {
  const availableIds = animalIds.filter(id => !bag.includes(id));
  const nextBag = availableIds.length ? [...bag] : [];
  const pool = availableIds.length ? availableIds : animalIds;
  if (!pool.length) throw new Error("発見カードの動物が空です");
  const animalId = pool[Math.floor(normalizedRandom(random) * pool.length)];
  nextBag.push(animalId);
  return { animalId, nextBag };
}

export function createCardCatalog(animals) {
  if (!Array.isArray(animals)) return [];
  return animals.flatMap(animal => CARD_RANKS.map(rank => ({
    id: `${animal.id}--${rank.id}`,
    animalId: animal.id,
    rank: rank.id,
    name: animal.name,
    scientificName: animal.scientificName,
    portraitIndex: animal.portraitIndex,
    emoji: animal.emoji,
    accent: animal.accent
  })));
}

export function drawCards(animals, count, options = {}) {
  if (![1, 10].includes(count)) throw new Error("カード枚数は1枚または10枚です");
  if (!Array.isArray(animals) || !animals.length) throw new Error("発見カードの動物が空です");
  const random = typeof options.random === "function" ? options.random : secureRandom;
  const animalIds = [...new Set(animals.map(animal => animal.id))];
  const animalById = Object.fromEntries(animals.map(animal => [animal.id, animal]));
  let speciesBag = uniqueKnownIds(options.speciesBag, new Set(animalIds), animalIds.length);
  let pityCount = Math.min(Math.max(0, Number(options.pityCount) || 0), PITY_LIMIT - 1);
  const pulls = [];
  let hasGuaranteedRank = false;

  for (let index = 0; index < count; index += 1) {
    const isFinalTenCard = count === 10 && index === 9;
    const minimumOrder = isFinalTenCard && !hasGuaranteedRank ? 2 : 0;
    const rank = chooseRank(random, pityCount, minimumOrder);
    const species = takeSpecies(animalIds, speciesBag, random);
    speciesBag = species.nextBag;
    const animal = animalById[species.animalId];
    pulls.push({
      id: `${animal.id}--${rank.id}`,
      animalId: animal.id,
      rank: rank.id,
      name: animal.name,
      scientificName: animal.scientificName,
      portraitIndex: animal.portraitIndex,
      emoji: animal.emoji,
      accent: animal.accent,
      rankMeta: rank
    });
    hasGuaranteedRank ||= rank.order >= 2;
    pityCount = rank.id === "lifecrown" ? 0 : pityCount + 1;
  }

  return { pulls, nextPityCount: pityCount, nextSpeciesBag: speciesBag };
}

export function applyPullResults(existingOwned, pulls) {
  const owned = { ...(existingOwned && typeof existingOwned === "object" ? existingOwned : {}) };
  const newCardIds = [];
  let duplicateLeaves = 0;
  for (const pull of pulls || []) {
    const previous = safeInteger(owned[pull.id], 999);
    if (previous === 0) newCardIds.push(pull.id);
    else duplicateLeaves += getRank(pull.rank).duplicateLeaves;
    owned[pull.id] = Math.min(previous + 1, 999);
  }
  return { owned, newCardIds, duplicateLeaves };
}

export function labelPullResults(pulls, newCardIds) {
  const newIds = new Set(newCardIds || []);
  const revealedNewIds = new Set();
  return (pulls || []).map(card => {
    const isNew = newIds.has(card.id) && !revealedNewIds.has(card.id);
    if (isNew) revealedNewIds.add(card.id);
    return { card, isNew };
  });
}

function stringHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function getDailyQuizIds(quizzes, dateKey, limit = DAILY_QUIZ_LIMIT) {
  if (!Array.isArray(quizzes)) return [];
  return quizzes
    .map(quiz => ({ id: quiz.id, score: stringHash(`${dateKey}:${quiz.id}`) }))
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit))
    .map(item => item.id);
}

export function prepareQuizDay(gameState, dateKey, offeredIds) {
  const game = { ...gameState };
  if (game.quizDay?.dateKey === dateKey) return game;
  return {
    ...game,
    latestSeenDate: !game.latestSeenDate || dateKey > game.latestSeenDate ? dateKey : game.latestSeenDate,
    quizDay: {
      dateKey,
      offeredIds: [...new Set(offeredIds || [])].slice(0, DAILY_QUIZ_LIMIT),
      attemptedIds: [],
      rewardedIds: [],
      tenBonusAwarded: false
    }
  };
}

export function recordQuizAnswer(gameState, quizId, correct, todayKey = gameState?.quizDay?.dateKey) {
  if (hasClockRollback(gameState?.latestSeenDate, todayKey)) {
    return { game: gameState, firstAttempt: false, reward: 0, bonusTen: false, reason: "clock" };
  }
  const game = structuredClone(gameState);
  const day = game.quizDay;
  if (!day?.offeredIds?.includes(quizId)) return { game: gameState, firstAttempt: false, reward: 0, bonusTen: false };
  if (day.attemptedIds.includes(quizId)) return { game: gameState, firstAttempt: false, reward: 0, bonusTen: false };
  day.attemptedIds.push(quizId);
  let reward = 0;
  let bonusTen = false;
  if (correct) {
    day.rewardedIds.push(quizId);
    game.lifetimePoints = Math.min(MAX_POINT_TOTAL, safeInteger(game.lifetimePoints) + QUIZ_CORRECT_POINTS);
    game.spendablePoints = Math.min(MAX_POINT_TOTAL, safeInteger(game.spendablePoints) + QUIZ_CORRECT_POINTS);
    game.totalFirstTryCorrect += 1;
    reward = QUIZ_CORRECT_POINTS;
  }
  game.revision += 1;
  game.history = [...(game.history || []), { type: "quiz", quizId, correct: Boolean(correct), dateKey: day.dateKey }].slice(-30);
  return { game, firstAttempt: true, reward, bonusTen };
}

export function consumeDrawRight(gameState, type, todayKey) {
  const game = structuredClone(gameState);
  if (hasClockRollback(game.latestSeenDate, todayKey)) return { allowed: false, reason: "clock", game: gameState };
  game.spendablePoints = safeInteger(game.spendablePoints);
  let spentPoints = 0;
  if (type === "daily") {
    if (!isDailyDrawAvailable(game.lastDailyDrawDate, todayKey)) return { allowed: false, reason: "used", game: gameState };
    game.lastDailyDrawDate = todayKey;
  } else if (type === "single") {
    if (game.spendablePoints < SINGLE_DRAW_COST) return { allowed: false, reason: "points", game: gameState };
    spentPoints = SINGLE_DRAW_COST;
    game.spendablePoints -= spentPoints;
  } else if (type === "ten") {
    if (game.spendablePoints < TEN_DRAW_COST) return { allowed: false, reason: "points", game: gameState };
    spentPoints = TEN_DRAW_COST;
    game.spendablePoints -= spentPoints;
  } else {
    return { allowed: false, reason: "type", game: gameState };
  }
  game.latestSeenDate = !game.latestSeenDate || todayKey > game.latestSeenDate ? todayKey : game.latestSeenDate;
  game.revision += 1;
  return { allowed: true, reason: "", game, spentPoints };
}

export function exchangeLeavesForSprout(gameState, animalId, validAnimalIds) {
  const known = new Set(validAnimalIds || []);
  if (!known.has(animalId)) return { allowed: false, reason: "animal", game: gameState };
  const cardId = `${animalId}--sprout`;
  if (Number(gameState?.owned?.[cardId]) > 0) return { allowed: false, reason: "owned", game: gameState };
  if (Number(gameState?.leaves) < LEAF_EXCHANGE_COST) return { allowed: false, reason: "leaves", game: gameState };
  const game = structuredClone(gameState);
  game.leaves -= LEAF_EXCHANGE_COST;
  game.owned[cardId] = 1;
  game.revision += 1;
  game.history = [...(game.history || []), { type: "leaf-exchange", animalId, cardId }].slice(-30);
  return { allowed: true, reason: "", game, cardId };
}

export function commitDraw(gameState, drawResult, pullResults, drawType, todayKey) {
  const game = structuredClone(gameState);
  game.owned = pullResults.owned;
  game.leaves += pullResults.duplicateLeaves;
  game.pityCount = drawResult.nextPityCount;
  game.speciesBag = drawResult.nextSpeciesBag;
  game.totalDraws += drawResult.pulls.length;
  game.history = [...(game.history || []), {
    type: "draw",
    drawType,
    spentPoints: drawType === "single" ? SINGLE_DRAW_COST : drawType === "ten" ? TEN_DRAW_COST : 0,
    dateKey: todayKey,
    cardIds: drawResult.pulls.map(card => card.id)
  }].slice(-30);
  return game;
}

export function quizReward(correct, alreadyAttempted) {
  return correct && !alreadyAttempted ? QUIZ_CORRECT_POINTS : 0;
}

export function collectionProgress(cards, owned) {
  const total = Array.isArray(cards) ? cards.length : 0;
  const collected = (cards || []).filter(card => Number(owned?.[card.id]) > 0).length;
  return { total, collected, percent: total ? Math.round((collected / total) * 100) : 0 };
}
