"use strict";

import {
  getDailyWonder,
  getNextAnimalId,
  getRelatedAnimals,
  getVisibleAnimals,
  sanitizeStoredIds
} from "./logic.mjs";
import {
  CARD_RANKS,
  DAILY_QUIZ_LIMIT,
  GAME_SCHEMA_VERSION,
  SINGLE_DRAW_COST,
  TEN_DRAW_COST,
  applyPullResults,
  collectionProgress,
  commitDraw,
  consumeDrawRight,
  chooseGameSnapshot,
  createCardCatalog,
  createDefaultGameState,
  drawCards,
  exchangeLeavesForSprout,
  getDailyQuizIds,
  getRank,
  hasClockRollback,
  isDailyDrawAvailable,
  localDateKey,
  labelPullResults,
  prepareQuizDay,
  recordQuizAnswer,
  recoverClockRollback,
  sanitizeGameState,
  secureRandom
} from "./game.mjs";

const rawFavorites = readLocal("waa-favorites", []);
const rawViewed = readLocal("waa-viewed-v2", []);
const loadedGameSnapshot = readGameSnapshot();
const rawGame = loadedGameSnapshot.value;

const state = {
  animals: [],
  tierData: null,
  tierByAnimal: new Map(),
  glossary: [],
  glossaryLookup: new Map(),
  glossaryMatchers: [],
  glossaryPattern: null,
  quizzes: [],
  dailyQuiz: [],
  currentQuizIndex: 0,
  cards: [],
  game: createDefaultGameState(),
  cardRankFilter: "all",
  cardGroupFilter: "all",
  cardOwnedOnly: false,
  tierFilter: "all",
  query: "",
  filter: "all",
  activeTheme: "",
  favorites: new Set(),
  viewed: new Set(),
  currentAnimalId: null,
  dailyRevealed: false,
  lastRandomId: null,
  currentQuizResult: null,
  currentResultAnimalId: null
};

const QUESTION_TRAILS = [
  { id: "からだ", label: "形態と機能" },
  { id: "海", label: "水生化" },
  { id: "飛行", label: "飛翔と潜水" },
  { id: "再生", label: "再生と発生" },
  { id: "感覚", label: "感覚と行動" },
  { id: "社会", label: "社会と文化" },
  { id: "研究", label: "証拠と研究史" }
];

const els = {
  grid: document.querySelector("#animal-grid"),
  count: document.querySelector("#result-count"),
  empty: document.querySelector("#empty-state"),
  search: document.querySelector("#animal-search"),
  filters: document.querySelector("#filter-row"),
  trails: document.querySelector("#question-trails"),
  dialog: document.querySelector("#animal-dialog"),
  dialogContent: document.querySelector("#dialog-content"),
  toast: document.querySelector("#toast"),
  favoriteGrid: document.querySelector("#favorite-grid"),
  favoriteEmpty: document.querySelector("#favorite-empty"),
  favoriteCount: document.querySelector("#favorite-count"),
  progress: document.querySelector("#view-progress"),
  progressText: document.querySelector("#view-progress-text"),
  dailyTitle: document.querySelector("#today-title"),
  dailyAnswer: document.querySelector("#daily-answer"),
  dailyAnswerText: document.querySelector("#daily-answer-text"),
  dailyReveal: document.querySelector("#daily-reveal"),
  dailyOpen: document.querySelector("#daily-open"),
  dailyPortrait: document.querySelector("#daily-portrait"),
  pointTotal: document.querySelector("#point-total"),
  lifetimePointTotal: document.querySelector("#lifetime-point-total"),
  gachaPointTotal: document.querySelector("#gacha-point-total"),
  quizCorrectTotal: document.querySelector("#quiz-correct-total"),
  cardProgressTotal: document.querySelector("#card-progress-total"),
  quizDayProgress: document.querySelector("#quiz-day-progress"),
  quizDots: document.querySelector("#quiz-dots"),
  quizAnimalLabel: document.querySelector("#quiz-animal-label"),
  quizNumber: document.querySelector("#quiz-number"),
  quizQuestion: document.querySelector("#quiz-question"),
  quizChoices: document.querySelector("#quiz-choices"),
  quizTermShelf: document.querySelector("#quiz-term-shelf"),
  quizFeedback: document.querySelector("#quiz-feedback"),
  quizNext: document.querySelector("#quiz-next"),
  quizSource: document.querySelector("#quiz-source"),
  dailyCardDraw: document.querySelector("#daily-card-draw"),
  dailyCardCopy: document.querySelector("#daily-card-copy"),
  clockRecovery: document.querySelector("#clock-recovery"),
  singleCardDraw: document.querySelector("#single-card-draw"),
  tenCardDraw: document.querySelector("#ten-card-draw"),
  singleCostCopy: document.querySelector("#single-cost-copy"),
  tenCostCopy: document.querySelector("#ten-cost-copy"),
  leafTotal: document.querySelector("#leaf-total"),
  leafAnimalSelect: document.querySelector("#leaf-animal-select"),
  leafExchangeButton: document.querySelector("#leaf-exchange-button"),
  rankProbabilities: document.querySelector("#rank-probabilities"),
  pityStatus: document.querySelector("#pity-status"),
  rankFilter: document.querySelector("#rank-filter"),
  groupFilter: document.querySelector("#group-filter"),
  ownedFilter: document.querySelector("#owned-filter"),
  albumAchievements: document.querySelector("#album-achievements"),
  tierFilter: document.querySelector("#tier-filter"),
  crownCutin: document.querySelector("#crown-cutin"),
  discoveryGrid: document.querySelector("#discovery-grid"),
  ownedSpeciesTotal: document.querySelector("#owned-species-total"),
  ownedVariantTotal: document.querySelector("#owned-variant-total"),
  tierGrid: document.querySelector("#tier-grid"),
  tierBenchmark: document.querySelector("#tier-benchmark"),
  tierMethodDate: document.querySelector("#tier-method-date"),
  glossaryPopup: document.querySelector("#glossary-dialog"),
  glossaryTitle: document.querySelector("#glossary-dialog-title"),
  glossaryCategory: document.querySelector("#glossary-category"),
  glossaryReading: document.querySelector("#glossary-reading"),
  glossaryDefinition: document.querySelector("#glossary-definition"),
  glossaryAdult: document.querySelector("#glossary-adult"),
  glossaryExample: document.querySelector("#glossary-example"),
  glossaryListDialog: document.querySelector("#glossary-list-dialog"),
  glossarySearch: document.querySelector("#glossary-search"),
  glossaryListCount: document.querySelector("#glossary-list-count"),
  glossaryList: document.querySelector("#glossary-list"),
  resultDialog: document.querySelector("#card-result-dialog"),
  resultTitle: document.querySelector("#card-result-title"),
  resultSummary: document.querySelector("#card-result-summary"),
  resultGrid: document.querySelector("#card-result-grid"),
  resultRead: document.querySelector("#result-read")
};

let toastTimer;
let lastEvidenceTrigger = null;
let dialogReturnFocus = null;
let glossaryReturnFocus = null;
let glossaryListReturnFocus = null;
let cardResultReturnFocus = null;
let drawInProgress = false;

function readGameSnapshot() {
  try {
    return chooseGameSnapshot(
      localStorage.getItem("waa-game-v2"),
      localStorage.getItem("waa-game-v2-backup")
    );
  } catch {
    return { value: createDefaultGameState(), source: "default" };
  }
}

function readLocal(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function writeLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    showToast("端末内への保存が利用できません");
  }
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function setupGlossary(globalGlossary) {
  const byTerm = new Map();
  for (const item of Array.isArray(globalGlossary) ? globalGlossary : []) {
    if (item?.term) byTerm.set(item.term, { ...item });
  }
  for (const animal of state.animals) {
    for (const item of animal.glossary || []) {
      if (!item?.term || byTerm.has(item.term)) continue;
      byTerm.set(item.term, {
        id: `animal-${animal.id}-${item.term}`,
        term: item.term,
        reading: item.reading || "",
        category: "この動物のことば",
        kidsDefinition: item.meaning || item.definition || "",
        adultDefinition: item.meaning || item.definition || "",
        aliases: [],
        example: `${animal.name}の物語で使われる言葉です。`
      });
    }
  }
  state.glossary = [...byTerm.values()];
  state.glossaryLookup = new Map();
  for (const item of state.glossary) {
    state.glossaryLookup.set(item.term.toLocaleLowerCase("ja"), item);
    for (const alias of item.aliases || []) {
      if (alias) state.glossaryLookup.set(String(alias).toLocaleLowerCase("ja"), item);
    }
  }
  state.glossaryMatchers = [...new Set([...state.glossaryLookup.keys()])]
    .filter(term => term.length >= 2)
    .sort((a, b) => b.length - a.length);
  state.glossaryPattern = state.glossaryMatchers.length
    ? new RegExp(state.glossaryMatchers.map(escapeRegExp).join("|"), "giu")
    : null;
}

function definedText(value) {
  const textValue = String(value ?? "");
  if (!textValue || !state.glossaryPattern) return escapeHTML(textValue);
  let output = "";
  let cursor = 0;
  for (const match of textValue.matchAll(state.glossaryPattern)) {
    const start = match.index ?? 0;
    const shown = match[0];
    const item = state.glossaryLookup.get(shown.toLocaleLowerCase("ja"));
    output += escapeHTML(textValue.slice(cursor, start));
    output += item
      ? `<button type="button" class="term-button" data-glossary-id="${escapeHTML(item.id)}" aria-expanded="false" aria-controls="glossary-dialog" aria-label="${escapeHTML(shown)}の意味を見る">${escapeHTML(shown)}<span aria-hidden="true">?</span></button>`
      : escapeHTML(shown);
    cursor = start + shown.length;
  }
  return output + escapeHTML(textValue.slice(cursor));
}

function glossaryItemsIn(values, limit = 8) {
  const haystack = (Array.isArray(values) ? values : [values])
    .map(value => String(value ?? "").toLocaleLowerCase("ja"))
    .join("\n");
  const found = [];
  const seenIds = new Set();
  const selectedMatchers = [];
  for (const matcher of state.glossaryMatchers) {
    if (!haystack.includes(matcher)) continue;
    if (selectedMatchers.some(selected => selected.includes(matcher))) continue;
    const item = state.glossaryLookup.get(matcher);
    if (!item || seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    selectedMatchers.push(matcher);
    found.push(item);
    if (found.length >= limit) break;
  }
  return found;
}

function termShelf(values, label = "この画面のことば") {
  const items = glossaryItemsIn(values);
  if (!items.length) return "";
  return `<aside class="term-shelf" aria-label="${escapeHTML(label)}">
    <span>${escapeHTML(label)}</span>
    <div>${items.map(item => `<button type="button" data-glossary-id="${escapeHTML(item.id)}" aria-expanded="false" aria-controls="glossary-dialog">${escapeHTML(item.term)}<b aria-hidden="true">?</b></button>`).join("")}</div>
  </aside>`;
}

function closeGlossary() {
  if (!els.glossaryPopup || els.glossaryPopup.hidden) return;
  els.glossaryPopup.hidden = true;
  if (glossaryReturnFocus?.isConnected) {
    glossaryReturnFocus.setAttribute("aria-expanded", "false");
    glossaryReturnFocus.focus();
  }
  glossaryReturnFocus = null;
  if (els.glossaryPopup.parentElement !== document.body) document.body.append(els.glossaryPopup);
}

function openGlossary(id, trigger) {
  const item = state.glossary.find(entry => entry.id === id);
  if (!item || !els.glossaryPopup) return;
  const activeDialog = trigger?.closest("dialog[open]");
  (activeDialog || document.body).append(els.glossaryPopup);
  if (glossaryReturnFocus && glossaryReturnFocus !== trigger) glossaryReturnFocus.setAttribute("aria-expanded", "false");
  glossaryReturnFocus = trigger;
  trigger?.setAttribute("aria-expanded", "true");
  els.glossaryCategory.textContent = item.category || "ことば辞典";
  els.glossaryTitle.textContent = item.term;
  els.glossaryReading.textContent = item.reading ? `読み：${item.reading}` : "";
  els.glossaryDefinition.textContent = item.kidsDefinition || item.definition || "";
  els.glossaryAdult.textContent = item.adultDefinition && item.adultDefinition !== item.kidsDefinition
    ? `もう一歩：${item.adultDefinition}` : "";
  els.glossaryAdult.hidden = !els.glossaryAdult.textContent;
  els.glossaryExample.textContent = item.example ? `この図鑑では：${item.example}` : "";
  els.glossaryExample.hidden = !els.glossaryExample.textContent;
  els.glossaryPopup.hidden = false;
  document.querySelector("#glossary-close")?.focus();
}

function renderGlossaryList(query = "") {
  const needle = String(query).trim().toLocaleLowerCase("ja");
  const entries = state.glossary.filter(item => {
    if (!needle) return true;
    return [item.term, item.reading, item.category, item.kidsDefinition, ...(item.aliases || [])]
      .some(value => String(value || "").toLocaleLowerCase("ja").includes(needle));
  });
  els.glossaryListCount.textContent = `${entries.length}語を表示中（端末内に全${state.glossary.length}語を保存）`;
  els.glossaryList.innerHTML = entries.length ? entries.map(item => `
    <details class="glossary-list-item">
      <summary><span><strong>${escapeHTML(item.term)}</strong><small>${escapeHTML(item.reading)}・${escapeHTML(item.category)}</small></span><b aria-hidden="true">＋</b></summary>
      <div><p>${escapeHTML(item.kidsDefinition)}</p>${item.adultDefinition !== item.kidsDefinition ? `<p><em>もう一歩</em>${escapeHTML(item.adultDefinition)}</p>` : ""}${item.example ? `<p><em>図鑑の例</em>${escapeHTML(item.example)}</p>` : ""}</div>
    </details>`).join("") : `<div class="collection-empty"><span aria-hidden="true">あ</span><h3>その言葉はまだ見つかりません</h3><p>短い言葉に変えて探してみてください。</p></div>`;
}

function openGlossaryList(trigger) {
  glossaryListReturnFocus = trigger;
  els.glossarySearch.value = "";
  renderGlossaryList();
  if (!els.glossaryListDialog.open) els.glossaryListDialog.showModal();
  requestAnimationFrame(() => els.glossarySearch.focus());
}

function persistGame(nextGame) {
  try {
    const stored = readLocal("waa-game-v2", null);
    if (stored && Number(stored.revision) > Number(state.game.revision)) {
      showToast("別の画面で記録が更新されました。読み直してから試してください");
      return false;
    }
    const currentText = localStorage.getItem("waa-game-v2");
    if (currentText) {
      try {
        const parsedCurrent = JSON.parse(currentText);
        const safeCurrent = sanitizeGameState(
          parsedCurrent,
          state.animals.map(animal => animal.id),
          state.quizzes.map(quiz => quiz.id)
        );
        localStorage.setItem("waa-game-v2-backup", JSON.stringify(safeCurrent));
      } catch {
        // 壊れた主データで正常なバックアップを上書きしない。
      }
    }
    localStorage.setItem("waa-game-v2", JSON.stringify(nextGame));
    state.game = nextGame;
    return true;
  } catch (error) {
    console.error("game_state_save_failed", error);
    showToast("記録を保存できなかったため、操作を取り消しました");
    return false;
  }
}

function confidenceLabel(value) {
  return value;
}

function animalConfidenceLabel(value) {
  return value;
}

function animalText(animal, key) {
  const copy = animal.copy?.deep?.[key];
  if (copy) return copy;
  const legacy = {
    hook: animal.hook,
    question: animal.question,
    story: animal.deepStory,
    wonder: animal.wonder,
    tradeoff: animal.tradeoff
  };
  return legacy[key] || "";
}

function modeValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value.deep === "string") return value.deep;
  if (typeof value.text === "string") return value.text;
  if (typeof value.body === "string") return value.body;
  return "";
}

function preferredScrollBehavior() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

function portraitStyle(index) {
  const safeIndex = Number.isInteger(index) && index >= 0 && index < 12 ? index : 0;
  return `--portrait-col:${safeIndex % 4};--portrait-row:${Math.floor(safeIndex / 4)}`;
}

// 一枚絵の図版は先頭12種のみ。13種目以降は絵文字タイルで表示する
function hasSpritePortrait(entity) {
  return Number.isInteger(entity?.portraitIndex) && entity.portraitIndex >= 0 && entity.portraitIndex < 12;
}

function portrait(entity, className = "") {
  if (hasSpritePortrait(entity)) {
    return `<span class="portrait-sprite ${className}" style="${portraitStyle(entity.portraitIndex)}" aria-hidden="true"></span>`;
  }
  // 絵文字は種によって重なることがあるため、動物ごとの固有色で地を塗り分ける
  const tint = entity?.accent ? `--tile-accent:${escapeHTML(entity.accent)}` : "";
  return `<span class="portrait-sprite portrait-emoji ${className}" style="${tint}" aria-hidden="true">${escapeHTML(entity?.emoji || "🐾")}</span>`;
}

function getAnimalTier(animalId) {
  return state.tierByAnimal.get(animalId) || null;
}

function tierBadge(animalId, compact = false) {
  const tier = getAnimalTier(animalId);
  if (!tier) return "";
  const value = String(tier.displayTier || "—");
  if (value === "UNRANKED") {
    return `<span class="animal-tier tier-unranked ${compact ? "is-compact" : ""}" aria-label="図鑑注目ティアは未算定"><b>—</b><small>未算定</small></span>`;
  }
  return `<span class="animal-tier tier-${escapeHTML(value.toLowerCase())} ${compact ? "is-compact" : ""}" aria-label="図鑑注目ティア${escapeHTML(value)}"><b>${escapeHTML(value)}</b><small>注目ティア</small></span>`;
}

function renderAnimalCard(animal, context = "explore") {
  const favorite = state.favorites.has(animal.id);
  const viewed = state.viewed.has(animal.id);
  return `
    <article class="animal-card ${context === "collection" ? "is-collection" : ""}"
      style="--accent:${escapeHTML(animal.accent)}">
      <div class="card-top">
        <div class="card-meta"><span class="habitat-tag">${escapeHTML(animal.habitat)} · ${escapeHTML(animal.group)}</span>${tierBadge(animal.id, true)}</div>
        <button class="favorite-button" data-favorite="${escapeHTML(animal.id)}" data-context="${context}"
          aria-label="${escapeHTML(animal.name)}をお気に入り${favorite ? "から外す" : "に入れる"}"
          aria-pressed="${favorite}">${favorite ? "★" : "☆"}</button>
      </div>
      <button class="card-open" data-animal-id="${escapeHTML(animal.id)}"
        aria-label="${escapeHTML(animal.name)}の物語を開く">
        <div class="animal-visual">${portrait(animal)}</div>
        <div class="card-body">
          <div class="card-status">${viewed ? "✓ 出会った" : "まだ会っていない"}</div>
          <small>${escapeHTML(animal.scientificName)}</small>
          <h3>${escapeHTML(animal.name)}</h3>
          <p>${escapeHTML(animalText(animal, "hook"))}</p>
          <div class="card-question"><i></i> ${escapeHTML(animalText(animal, "question"))}</div>
          <span class="card-confidence">${escapeHTML(animalConfidenceLabel(animal.confidence))}</span>
        </div>
      </button>
      ${termShelf([animalText(animal, "hook"), animalText(animal, "question")], `${animal.name}のことば`)}
    </article>`;
}

function renderCards() {
  const animals = getVisibleAnimals(state.animals, state);
  els.count.textContent = String(animals.length);
  els.empty.hidden = animals.length !== 0;
  els.grid.hidden = animals.length === 0;
  els.grid.innerHTML = animals.map(animal => renderAnimalCard(animal)).join("");
}

function renderCollection() {
  const animals = state.animals.filter(animal => state.favorites.has(animal.id));
  els.favoriteCount.textContent = String(animals.length);
  els.favoriteEmpty.hidden = animals.length !== 0;
  els.favoriteGrid.hidden = animals.length === 0;
  els.favoriteGrid.innerHTML = animals.map(animal => renderAnimalCard(animal, "collection")).join("");
}

function renderRankControls() {
  els.rankProbabilities.innerHTML = CARD_RANKS.map(rank => `
    <div class="rank-probability rank-${escapeHTML(rank.id)}">
      <span aria-hidden="true">${escapeHTML(rank.mark)}</span>
      <strong>${escapeHTML(rank.name)} <small>${escapeHTML(rank.symbol)}</small></strong>
      <b>${Math.round(rank.probability * 100)}%</b>
    </div>`).join("");
  const filters = [{ id: "all", name: "すべて", mark: "◎" }, ...CARD_RANKS];
  els.rankFilter.innerHTML = filters.map(rank => {
    const active = state.cardRankFilter === rank.id;
    return `<button type="button" data-rank-filter="${escapeHTML(rank.id)}" aria-pressed="${active}" class="${active ? "is-active" : ""}"><span aria-hidden="true">${escapeHTML(rank.mark)}</span>${escapeHTML(rank.name)}</button>`;
  }).join("");
  if (els.groupFilter) {
    const groups = ["all", ...new Set(state.animals.map(animal => animal.group))];
    els.groupFilter.innerHTML = groups.map(group => {
      const active = state.cardGroupFilter === group;
      return `<button type="button" data-group-filter="${escapeHTML(group)}" aria-pressed="${active}" class="${active ? "is-active" : ""}">${escapeHTML(group === "all" ? "全分類" : group)}</button>`;
    }).join("");
  }
  if (els.ownedFilter) {
    els.ownedFilter.setAttribute("aria-pressed", String(state.cardOwnedOnly));
    els.ownedFilter.classList.toggle("is-active", state.cardOwnedOnly);
  }
}

function renderDiscoveryCard(card) {
  const rank = getRank(card.rank);
  const count = Number(state.game.owned[card.id]) || 0;
  const owned = count > 0;
  return `
    <article class="discovery-card rank-${escapeHTML(rank.id)} ${owned ? "is-owned" : "is-locked"}">
      <button type="button" data-card-animal="${escapeHTML(card.animalId)}" aria-label="${escapeHTML(card.name)}、${escapeHTML(rank.name)}のカード。${owned ? `発見済み${count}枚` : "まだカードは未発見。図鑑を読む"}">
        <span class="card-rank-mark" aria-hidden="true">${escapeHTML(rank.mark)}</span>
        ${tierBadge(card.animalId, true)}
        <div class="discovery-portrait">${portrait(card)}</div>
        <small>${escapeHTML(rank.name)} ${escapeHTML(rank.symbol)}</small>
        <strong>${escapeHTML(card.name)}</strong>
        <em>${owned ? (count > 1 ? `再会 ×${count}` : "NEW FOUND") : "物語は読めます"}</em>
      </button>
    </article>`;
}

function renderDiscoveryCabinet() {
  const groupByAnimal = new Map(state.animals.map(animal => [animal.id, animal.group]));
  const visibleCards = state.cards.filter(card => {
    if (state.cardRankFilter !== "all" && card.rank !== state.cardRankFilter) return false;
    if (state.cardGroupFilter !== "all" && groupByAnimal.get(card.animalId) !== state.cardGroupFilter) return false;
    if (state.cardOwnedOnly && !(Number(state.game.owned[card.id]) > 0)) return false;
    return true;
  });
  els.discoveryGrid.innerHTML = visibleCards.length
    ? visibleCards.map(renderDiscoveryCard).join("")
    : `<p class="album-empty">この条件のカードはまだありません。絞り込みを変えるか、カードをめくってみましょう。</p>`;
  const progress = collectionProgress(state.cards, state.game.owned);
  const ownedAnimalIds = new Set(state.cards
    .filter(card => Number(state.game.owned[card.id]) > 0)
    .map(card => card.animalId));
  els.ownedSpeciesTotal.textContent = `${ownedAnimalIds.size} / ${state.animals.length}`;
  els.ownedVariantTotal.textContent = `${progress.collected} / ${progress.total}`;
  els.cardProgressTotal.textContent = `${progress.collected} / ${progress.total}`;
  renderAlbumAchievements(progress, ownedAnimalIds, groupByAnimal);
}

// 実績は表示だけの記録。期限・ノルマ・報酬はなく、集めない選択でも本文は全部読める
function renderAlbumAchievements(progress, ownedAnimalIds, groupByAnimal) {
  if (!els.albumAchievements) return;
  const ranksPerAnimal = new Map();
  for (const card of state.cards) {
    if (Number(state.game.owned[card.id]) > 0) {
      ranksPerAnimal.set(card.animalId, (ranksPerAnimal.get(card.animalId) || 0) + 1);
    }
  }
  const completeAnimals = [...ranksPerAnimal.values()].filter(count => count >= 5).length;
  const groupTotals = new Map();
  const groupOwned = new Map();
  for (const [animalId, group] of groupByAnimal) {
    groupTotals.set(group, (groupTotals.get(group) || 0) + 1);
    if (ownedAnimalIds.has(animalId)) groupOwned.set(group, (groupOwned.get(group) || 0) + 1);
  }
  const milestones = [...[1, 10, 50, 100, 200].filter(goal => goal < progress.total), progress.total];
  const badges = milestones.map(goal => {
    const achieved = progress.collected >= goal;
    return `<span class="achieve-chip ${achieved ? "is-achieved" : ""}">${achieved ? "✓" : "・"} ${goal}枚</span>`;
  }).join("");
  const groupSummary = [...groupTotals.entries()]
    .map(([group, total]) => `<span class="achieve-chip ${groupOwned.get(group) === total ? "is-achieved" : ""}">${escapeHTML(group)} ${groupOwned.get(group) || 0}/${total}</span>`)
    .join("");
  els.albumAchievements.innerHTML = `
    <p><strong>あつめの記録</strong><small>全5光そろった動物：${completeAnimals}種</small></p>
    <div class="achieve-row" aria-label="カード枚数の記録">${badges}</div>
    <div class="achieve-row" aria-label="分類ごとの出会い">${groupSummary}</div>`;
}

function conservationLabel(conservation = {}) {
  const labels = {
    CR: "深刻な危機（CR）",
    EN: "危機（EN）",
    VU: "危急（VU）",
    NT: "準絶滅危惧（NT）",
    LC: "低懸念（LC）",
    DD: "情報不足（DD）",
    NE: "世界未評価（NE）"
  };
  if (conservation.assessmentState === "reassessment-pending") return "分類変更後の再評価待ち";
  return labels[conservation.category] || conservation.category || "評価範囲を確認中";
}

function renderTierFilter(counts) {
  if (!els.tierFilter) return;
  const labels = { all: "すべて", S: "S", A: "A", B: "B", C: "C", UNRANKED: "未算定" };
  els.tierFilter.innerHTML = ["all", "S", "A", "B", "C", "UNRANKED"]
    .filter(tier => tier === "all" || counts[tier])
    .map(tier => {
      const active = state.tierFilter === tier;
      const count = tier === "all" ? Object.values(counts).reduce((sum, value) => sum + value, 0) : counts[tier];
      return `<button type="button" data-tier-filter="${escapeHTML(tier)}" aria-pressed="${active}" class="${active ? "is-active" : ""}">${escapeHTML(labels[tier])} <b>${count}</b></button>`;
    }).join("");
}

function renderTierRanking() {
  if (!state.tierData || !els.tierGrid) return;
  const tierOrder = { S: 0, A: 1, B: 2, C: 3 };
  const animalById = new Map(state.animals.map(animal => [animal.id, animal]));
  const all = [...(state.tierData.animals || [])].filter(item => animalById.has(item.animalId));
  const counts = all.reduce((result, item) => {
    result[item.displayTier] = (result[item.displayTier] || 0) + 1;
    return result;
  }, {});
  renderTierFilter(counts);
  const ranked = all
    .filter(item => state.tierFilter === "all" || item.displayTier === state.tierFilter)
    .sort((a, b) => (tierOrder[a.displayTier] ?? 9) - (tierOrder[b.displayTier] ?? 9)
      || (b.popularity?.score ?? -1) - (a.popularity?.score ?? -1)
      || animalById.get(a.animalId).name.localeCompare(animalById.get(b.animalId).name, "ja"));
  els.tierGrid.innerHTML = ranked.map(item => {
    const animal = animalById.get(item.animalId);
    const popularity = Number.isFinite(item.popularity?.score) ? `人気点 ${item.popularity.score.toFixed(1)}` : "人気は未測定";
    return `<article class="tier-card tier-${escapeHTML(item.displayTier.toLowerCase())}" style="--accent:${escapeHTML(animal.accent)}">
      <div class="tier-card-top">${tierBadge(animal.id)}<span>${escapeHTML(popularity)}</span></div>
      <div class="tier-card-animal">${portrait(animal, "is-tier")}<div><small>${escapeHTML(animal.scientificName)}</small><h3>${escapeHTML(animal.name)}</h3></div></div>
      <p>${definedText(item.tierReasonText)}</p>
      <div class="tier-card-footer"><span>${escapeHTML(conservationLabel(item.conservation))}</span><button type="button" data-animal-id="${escapeHTML(animal.id)}">本文と根拠を読む</button></div>
    </article>`;
  }).join("");
  // 完全監修の外にある比較対象がある場合だけ基準欄を出す（v5でライオンは本編へ昇格し、既定では空）
  const benchmark = state.tierData.benchmarks?.[0];
  if (els.tierBenchmark) {
    els.tierBenchmark.hidden = !benchmark;
    if (benchmark) {
      els.tierBenchmark.innerHTML = `<div class="lion-mark" aria-hidden="true">獅</div><div><span>追加候補・基準確認</span><h3>${escapeHTML(benchmark.name)} <span class="animal-tier tier-${escapeHTML(String(benchmark.displayTier).toLowerCase())}"><b>${escapeHTML(benchmark.displayTier)}</b><small>注目ティア</small></span></h3><p>${definedText(benchmark.tierReasonText)}</p><small>人気点 ${escapeHTML(benchmark.popularity.score)}｜${escapeHTML(conservationLabel(benchmark.conservation))}。完全監修の本文がないため、カード抽選には入りません。</small></div>`;
    }
  }
  if (els.tierMethodDate) els.tierMethodDate.textContent = `算定日 ${state.tierData.tierSystem?.calculatedAt || "—"}`;
}

function renderGameUI() {
  const todayKey = localDateKey();
  const rollback = hasClockRollback(state.game.latestSeenDate, todayKey);
  const dailyAvailable = !rollback && isDailyDrawAvailable(state.game.lastDailyDrawDate, todayKey);
  els.pointTotal.textContent = String(state.game.spendablePoints);
  els.lifetimePointTotal.textContent = String(state.game.lifetimePoints);
  els.gachaPointTotal.textContent = String(state.game.spendablePoints);
  els.quizCorrectTotal.textContent = String(state.game.totalFirstTryCorrect);
  els.leafTotal.textContent = String(state.game.leaves);
  els.pityStatus.textContent = `生命の宝冠まで最大あと${30 - state.game.pityCount}枚（当たると30枚保証を数え直します）`;
  const missingSproutAnimals = state.animals.filter(animal => !state.game.owned[`${animal.id}--sprout`]);
  const previousLeafChoice = els.leafAnimalSelect.value;
  els.leafAnimalSelect.innerHTML = missingSproutAnimals.length
    ? missingSproutAnimals.map(animal => `<option value="${escapeHTML(animal.id)}">${escapeHTML(animal.name)}</option>`).join("")
    : '<option value="">芽吹きカードはすべて発見済み</option>';
  if (missingSproutAnimals.some(animal => animal.id === previousLeafChoice)) els.leafAnimalSelect.value = previousLeafChoice;
  els.leafAnimalSelect.disabled = missingSproutAnimals.length === 0;
  els.leafExchangeButton.disabled = missingSproutAnimals.length === 0 || state.game.leaves < 30 || rollback || drawInProgress;
  els.dailyCardDraw.disabled = !dailyAvailable || drawInProgress;
  els.clockRecovery.hidden = !rollback;
  els.singleCardDraw.disabled = state.game.spendablePoints < SINGLE_DRAW_COST || rollback || drawInProgress;
  els.tenCardDraw.disabled = state.game.spendablePoints < TEN_DRAW_COST || rollback || drawInProgress;
  els.singleCostCopy.textContent = state.game.spendablePoints >= SINGLE_DRAW_COST
    ? `${SINGLE_DRAW_COST}ポイント｜後${state.game.spendablePoints - SINGLE_DRAW_COST}`
    : `${SINGLE_DRAW_COST}ポイント｜あと${SINGLE_DRAW_COST - state.game.spendablePoints}`;
  els.tenCostCopy.textContent = state.game.spendablePoints >= TEN_DRAW_COST
    ? `${TEN_DRAW_COST}ポイント｜後${state.game.spendablePoints - TEN_DRAW_COST}`
    : `${TEN_DRAW_COST}ポイント｜あと${TEN_DRAW_COST - state.game.spendablePoints}`;
  els.dailyCardDraw.textContent = rollback
    ? "端末の日付を確認してください"
    : dailyAvailable ? "今日の1枚をめくる" : "今日の1枚は発見済み";
  els.dailyCardCopy.textContent = rollback
    ? "端末の日付が前回より戻っています。記録を守るため、日付を確認するまで新しいカードだけ止めています。図鑑は読めます。"
    : dailyAvailable
      ? "1日1回、カードを1枚めくれます。連続日数や取り逃しはありません。"
      : "今日の1枚は標本箱へ入りました。また明日、ちがう出会いを楽しめます。";
  renderRankControls();
  renderDiscoveryCabinet();
}

function refreshDailyState() {
  if (!state.quizzes.length || !state.animals.length) return;
  const todayKey = localDateKey();
  if (hasClockRollback(state.game.latestSeenDate, todayKey)) {
    renderGameUI();
    return;
  }
  if (state.game.quizDay.dateKey !== todayKey) {
    const offeredIds = getDailyQuizIds(state.quizzes, todayKey);
    const nextGame = prepareQuizDay(state.game, todayKey, offeredIds);
    nextGame.revision = state.game.revision + 1;
    if (!persistGame(nextGame)) return;
    state.currentQuizResult = null;
  }
  state.dailyQuiz = state.game.quizDay.offeredIds
    .map(id => state.quizzes.find(quiz => quiz.id === id))
    .filter(Boolean);
  const attempted = new Set(state.game.quizDay.attemptedIds);
  const firstUnanswered = state.dailyQuiz.findIndex(quiz => !attempted.has(quiz.id));
  state.currentQuizIndex = firstUnanswered >= 0 ? firstUnanswered : state.dailyQuiz.length;
  renderQuiz();
  renderGameUI();
}

function currentQuiz() {
  return state.currentQuizIndex >= 0 && state.currentQuizIndex < state.dailyQuiz.length
    ? state.dailyQuiz[state.currentQuizIndex]
    : null;
}

function quizResultMarkup(quiz, result) {
  const correctChoice = quiz.choices[quiz.correctIndex];
  const resultLabel = result.correct ? "正解。ひらめきが増えました" : "今回はちがいました。理由を見てみよう";
  const rewardText = result.reward
    ? `<strong>使えるひらめき +${result.reward}・累計ひらめき +${result.reward}</strong>`
    : "<strong>減点はありません</strong>";
  return `<span class="quiz-result-mark ${result.correct ? "is-correct" : "is-wrong"}">${result.correct ? "○ 正解" : "△ 発見"}</span>
    <h4>${escapeHTML(resultLabel)}</h4>
    <p>答え：<b>${definedText(correctChoice)}</b></p>
    <p>${definedText(quiz.explanation)}</p>
    <div class="quiz-reward">${rewardText}</div>`;
}

function renderQuiz() {
  const day = state.game.quizDay;
  const clockLocked = hasClockRollback(state.game.latestSeenDate, localDateKey());
  const attempted = new Set(day.attemptedIds || []);
  const rewarded = new Set(day.rewardedIds || []);
  els.quizDayProgress.textContent = `${attempted.size} / ${state.dailyQuiz.length || DAILY_QUIZ_LIMIT}問・初回答正解 ${rewarded.size}問`;
  els.quizDots.innerHTML = state.dailyQuiz.map(quiz => `<i class="${rewarded.has(quiz.id) ? "is-correct" : attempted.has(quiz.id) ? "is-attempted" : ""}"></i>`).join("");
  const quiz = currentQuiz();
  if (!quiz) {
    els.quizAnimalLabel.textContent = "TODAY COMPLETE";
    els.quizNumber.textContent = "また明日";
    els.quizQuestion.textContent = attempted.size === state.dailyQuiz.length
      ? "今日の5問はここまで。じっくり考えた記録が残りました。"
      : "クイズを準備できませんでした。";
    els.quizChoices.innerHTML = "";
    els.quizTermShelf.innerHTML = "";
    els.quizFeedback.hidden = false;
    els.quizFeedback.innerHTML = attempted.size === state.dailyQuiz.length
      ? `<span class="quiz-result-mark is-correct">✓ 記録しました</span><h4>初回答正解 ${rewarded.size} / ${state.dailyQuiz.length}問</h4><p>間違いも、新しく知る入口です。図鑑はいつでも読み返せます。</p>`
      : "";
    els.quizNext.hidden = true;
    els.quizSource.hidden = true;
    return;
  }
  const animal = state.animals.find(item => item.id === quiz.animalId);
  const result = state.currentQuizResult?.quizId === quiz.id ? state.currentQuizResult : null;
  const wasAttempted = attempted.has(quiz.id);
  els.quizAnimalLabel.textContent = animal ? `${animal.name}のふしぎ` : "動物のふしぎ";
  els.quizNumber.textContent = `QUESTION ${state.currentQuizIndex + 1} / ${state.dailyQuiz.length}`;
  els.quizQuestion.innerHTML = definedText(quiz.question);
  // データ上の正解は常にcorrectIndex=0型が多いため、表示順は問題ごとにシャッフルして固定する。
  // 判定はdata-quiz-choiceが持つ元の番号で行うので、順番を変えても採点は変わらない
  if (!state.quizChoiceOrder || state.quizChoiceOrder.quizId !== quiz.id) {
    const order = [...quiz.choices.keys()];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    state.quizChoiceOrder = { quizId: quiz.id, order };
  }
  els.quizChoices.innerHTML = state.quizChoiceOrder.order.map((index, position) => {
    const choice = quiz.choices[index];
    const isCorrect = wasAttempted && index === quiz.correctIndex;
    const isChosen = result && index === result.chosenIndex;
    return `<button type="button" data-quiz-choice="${index}" ${wasAttempted || clockLocked ? "disabled" : ""} class="${isCorrect ? "is-correct" : isChosen ? "is-wrong" : ""}"><span>${String.fromCharCode(65 + position)}</span>${escapeHTML(choice)}</button>`;
  }).join("");
  els.quizTermShelf.innerHTML = termShelf([quiz.question, ...quiz.choices], "答える前に確認できることば");
  if (result) {
    els.quizFeedback.hidden = false;
    els.quizFeedback.innerHTML = quizResultMarkup(quiz, result);
  } else if (wasAttempted) {
    els.quizFeedback.hidden = false;
    els.quizFeedback.innerHTML = `<span class="quiz-result-mark">✓ 回答済み</span><h4>答えを記録しています</h4><p>答え：<b>${definedText(quiz.choices[quiz.correctIndex])}</b></p><p>${definedText(quiz.explanation)}</p>`;
  } else if (clockLocked) {
    els.quizFeedback.hidden = false;
    els.quizFeedback.innerHTML = `<span class="quiz-result-mark">日付を確認</span><h4>学びの記録を守っています</h4><p>端末の日付が前回より戻っています。正しい日付へ戻るまで、ポイントと新しいカードだけを止めています。</p>`;
  } else {
    els.quizFeedback.hidden = true;
    els.quizFeedback.innerHTML = "";
  }
  els.quizNext.hidden = !wasAttempted;
  els.quizNext.textContent = state.currentQuizIndex === state.dailyQuiz.length - 1 ? "今日の結果を見る" : "次の問題へ";
  els.quizSource.hidden = !wasAttempted;
  els.quizSource.dataset.quizId = quiz.id;
}

function answerQuiz(choiceIndex) {
  const quiz = currentQuiz();
  if (hasClockRollback(state.game.latestSeenDate, localDateKey())) {
    showToast("端末の日付を確認してください。図鑑はそのまま読めます");
    return;
  }
  if (!quiz || state.game.quizDay.attemptedIds.includes(quiz.id)) return;
  const correct = Number(choiceIndex) === quiz.correctIndex;
  const outcome = recordQuizAnswer(state.game, quiz.id, correct, localDateKey());
  if (!outcome.firstAttempt || !persistGame(outcome.game)) return;
  state.currentQuizResult = {
    quizId: quiz.id,
    chosenIndex: Number(choiceIndex),
    correct,
    reward: outcome.reward
  };
  renderQuiz();
  renderGameUI();
  requestAnimationFrame(() => els.quizFeedback.focus());
}

function nextQuiz() {
  const attempted = new Set(state.game.quizDay.attemptedIds);
  const nextIndex = state.dailyQuiz.findIndex((quiz, index) => index > state.currentQuizIndex && !attempted.has(quiz.id));
  state.currentQuizIndex = nextIndex >= 0 ? nextIndex : state.dailyQuiz.length;
  state.currentQuizResult = null;
  renderQuiz();
  requestAnimationFrame(() => els.quizQuestion.focus?.());
}

function renderResultCard(card, isNew, delay = 0) {
  const rank = getRank(card.rank);
  return `<button type="button" class="result-card rank-${escapeHTML(rank.id)} ${rank.id === "lifecrown" ? "is-crown" : ""}" style="--reveal-delay:${delay}ms" data-result-animal="${escapeHTML(card.animalId)}" aria-label="${escapeHTML(card.name)}、${escapeHTML(rank.name)}。${isNew ? "新しいカード" : "再会したカード"}。物語を読む">
    <span class="result-cover" aria-hidden="true"><i>✦</i></span>
    <span class="result-new">${isNew ? "NEW" : "再会"}</span>
    <span class="card-rank-mark" aria-hidden="true">${escapeHTML(rank.mark)}</span>
    ${tierBadge(card.animalId, true)}
    <div class="result-portrait">${portrait(card)}</div>
    <small>${escapeHTML(rank.name)} ${escapeHTML(rank.symbol)}</small>
    <strong>${escapeHTML(card.name)}</strong>
  </button>`;
}

// 一番よい光のカードだけ最後にめくる。順番待ちの時間が期待に変わる。
// chargedのときは、光が満ちる予兆のぶんだけ全体を後ろへずらす
function revealDelays(items, charged = false) {
  const base = charged ? 1050 : 320;
  const step = items.length > 1 ? 260 : 0;
  const bestIndex = items.reduce(
    (best, item, index) => getRank(item.card.rank).order > getRank(items[best].card.rank).order ? index : best,
    0
  );
  const last = base + (items.length - 1) * step + 420;
  let position = 0;
  return items.map((item, index) => {
    if (index === bestIndex && items.length > 1) return last;
    const delay = base + position * step;
    position += 1;
    return delay;
  });
}

// 端末が対応していれば、光の強さに応じた短い振動を返す。無音・非対応時は何もしない
function pulseForRank(rankId) {
  if (!navigator.vibrate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const patterns = {
    sprout: [12],
    sunbeam: [16],
    starlight: [18, 60, 18],
    moonbow: [22, 60, 22, 60, 22],
    lifecrown: [30, 70, 30, 70, 60]
  };
  navigator.vibrate(patterns[rankId] || [12]);
}

function showCardResults(pulls, newCardIds, duplicateLeaves, trigger) {
  const crownCount = pulls.filter(card => card.rank === "lifecrown").length;
  const highest = pulls.reduce((best, card) => getRank(card.rank).order > getRank(best.rank).order ? card : best, pulls[0]);
  cardResultReturnFocus = trigger;
  state.currentResultAnimalId = pulls.length === 1 ? pulls[0].animalId : highest.animalId;
  els.resultDialog.classList.toggle("has-lifecrown", crownCount > 0);
  els.resultDialog.classList.remove("is-revealed");
  // めくるたびに光の演出が変わる。急かす要素は入れず「開いた瞬間の景色」だけを豊かにする
  const revealPatterns = ["aurora", "hoshikuzu", "komorebi", "tsukinowa"];
  els.resultDialog.dataset.reveal = revealPatterns[Math.floor(Math.random() * revealPatterns.length)];
  els.resultDialog.dataset.topRank = highest.rank;
  // 星明かり以上を含む回だけ、カードが現れる前に光が満ちる「予兆」を入れる
  els.resultDialog.classList.toggle("is-charged", getRank(highest.rank).order >= 2);
  els.resultTitle.textContent = crownCount
    ? "生命の宝冠。いのちの光に出会いました"
    : `${pulls.length}枚の発見カードを開きました`;
  const duplicateCount = pulls.length - newCardIds.length;
  els.resultSummary.textContent = `${pulls.length}枚中、新しいカード${newCardIds.length}枚、再会${duplicateCount}枚${duplicateLeaves ? `、葉っぱ+${duplicateLeaves}枚` : ""}${crownCount ? `。生命の宝冠${crownCount}枚` : ""}。`;
  const labeled = labelPullResults(pulls, newCardIds);
  const delays = revealDelays(labeled, getRank(highest.rank).order >= 2);
  els.resultGrid.innerHTML = labeled
    .map((item, index) => renderResultCard(item.card, item.isNew, delays[index])).join("");
  els.resultRead.hidden = pulls.length !== 1;
  els.resultRead.dataset.animalId = state.currentResultAnimalId;
  if (!els.resultDialog.open) els.resultDialog.showModal();
  requestAnimationFrame(() => els.resultTitle.focus());
  // 宝冠が出た回だけ、カードの前に一枚の絵が差し込まれる
  if (els.crownCutin) {
    els.crownCutin.hidden = crownCount === 0;
    if (crownCount) {
      els.crownCutin.classList.remove("is-playing");
      void els.crownCutin.offsetWidth;
      els.crownCutin.classList.add("is-playing");
    }
  }
  pulseForRank(highest.rank);
}

function performDraw(type, trigger) {
  if (drawInProgress) return;
  drawInProgress = true;
  renderGameUI();
  try {
    const todayKey = localDateKey();
    const gate = consumeDrawRight(state.game, type, todayKey);
    if (!gate.allowed) {
      const messages = {
        used: "今日の1枚は、もう標本箱に入っています",
        points: type === "ten"
          ? `10枚には${TEN_DRAW_COST}ポイント必要です。あと${Math.max(0, TEN_DRAW_COST - state.game.spendablePoints)}ポイントです`
          : `1枚には${SINGLE_DRAW_COST}ポイント必要です。あと${Math.max(0, SINGLE_DRAW_COST - state.game.spendablePoints)}ポイントです`,
        clock: "端末の日付を確認してください。図鑑はそのまま読めます"
      };
      showToast(messages[gate.reason] || "このカードはまだめくれません");
      return;
    }
    const count = type === "ten" ? 10 : 1;
    const drawResult = drawCards(state.animals, count, {
      random: secureRandom,
      pityCount: gate.game.pityCount,
      speciesBag: gate.game.speciesBag
    });
    const pullResults = applyPullResults(gate.game.owned, drawResult.pulls);
    const finalGame = commitDraw(gate.game, drawResult, pullResults, type, todayKey);
    if (!persistGame(finalGame)) return;
    renderGameUI();
    showCardResults(drawResult.pulls, pullResults.newCardIds, pullResults.duplicateLeaves, trigger);
  } finally {
    drawInProgress = false;
    renderGameUI();
  }
}

function exchangeLeaves(trigger) {
  if (drawInProgress) return;
  const animalId = els.leafAnimalSelect.value;
  const outcome = exchangeLeavesForSprout(state.game, animalId, state.animals.map(animal => animal.id));
  if (!outcome.allowed) {
    const messages = {
      leaves: "葉っぱが30枚たまると選べます",
      owned: "その芽吹きカードは発見済みです",
      animal: "選べる動物を確認してください"
    };
    showToast(messages[outcome.reason] || "今は交換できません");
    return;
  }
  if (!persistGame(outcome.game)) return;
  renderGameUI();
  const animal = state.animals.find(item => item.id === animalId);
  const card = state.cards.find(item => item.id === outcome.cardId);
  if (animal && card) showCardResults([{ ...card, ...animal, id: card.id, rank: "sprout" }], [card.id], 0, trigger);
}

function recoverClock() {
  const todayKey = localDateKey();
  const offeredIds = getDailyQuizIds(state.quizzes, todayKey);
  const outcome = recoverClockRollback(state.game, todayKey, offeredIds);
  if (!outcome.recovered) {
    showToast("日付の記録は正常です");
    return;
  }
  const agreed = window.confirm("iPhoneの『日付と時刻を自動設定』が正しいことを確認しましたか？\n\nポイント・カード・葉っぱは残したまま再開します。重複防止のため、今日の1枚とクイズ報酬は明日から再開します。");
  if (!agreed || !persistGame(outcome.game)) return;
  state.dailyQuiz = offeredIds.map(id => state.quizzes.find(quiz => quiz.id === id)).filter(Boolean);
  state.currentQuizIndex = state.dailyQuiz.length;
  state.currentQuizResult = null;
  renderQuiz();
  renderGameUI();
  showToast("学びの記録を残したまま再開しました");
}

function renderProgress() {
  const count = state.animals.filter(animal => state.viewed.has(animal.id)).length;
  els.progress.max = state.animals.length;
  els.progress.value = count;
  els.progress.textContent = `${count} / ${state.animals.length}`;
  const progressText = count === 0
    ? "まだ出会っていません"
    : `${state.animals.length}匹中 ${count}匹に出会いました`;
  els.progressText.textContent = progressText;
  els.progress.setAttribute("aria-valuetext", progressText);
}

function renderFilters() {
  const groups = [...new Set(state.animals.map(animal => animal.group))];
  els.filters.innerHTML = [{ id: "all", label: "すべて" }, ...groups.map(item => ({ id: item, label: item }))]
    .map(item => {
      const active = state.filter === item.id;
      return `<button class="filter-chip ${active ? "is-active" : ""}" data-filter="${escapeHTML(item.id)}"
        aria-pressed="${active}">${escapeHTML(item.label)}</button>`;
    }).join("");
}

function renderQuestionTrails() {
  els.trails.innerHTML = QUESTION_TRAILS.map(trail => {
    const active = state.activeTheme === trail.id;
    return `<button class="question-chip ${active ? "is-active" : ""}" data-theme="${escapeHTML(trail.id)}"
      aria-pressed="${active}">${escapeHTML(trail.label)}</button>`;
  }).join("");
}

function renderDailyWonder() {
  const daily = getDailyWonder(state.animals);
  if (!daily) return;
  const question = daily.trivia.deepQuestion || modeValue(daily.trivia.question) || animalText(daily.animal, "question");
  const answer = daily.trivia.deepText || modeValue(daily.trivia) || daily.trivia.text || animalText(daily.animal, "wonder");
  els.dailyTitle.innerHTML = `${escapeHTML(daily.animal.name)}の<br><em>${definedText(question)}</em>`;
  els.dailyAnswerText.innerHTML = definedText(answer);
  els.dailyAnswer.hidden = !state.dailyRevealed;
  els.dailyReveal.setAttribute("aria-expanded", String(state.dailyRevealed));
  els.dailyReveal.textContent = state.dailyRevealed ? "答えを閉じる" : "答えをめくる";
  els.dailyOpen.dataset.animalId = daily.animal.id;
  if (hasSpritePortrait(daily.animal)) {
    els.dailyPortrait.classList.remove("portrait-emoji");
    els.dailyPortrait.setAttribute("style", portraitStyle(daily.animal.portraitIndex));
    els.dailyPortrait.textContent = "";
  } else {
    els.dailyPortrait.classList.add("portrait-emoji");
    els.dailyPortrait.removeAttribute("style");
    els.dailyPortrait.textContent = daily.animal.emoji || "🐾";
  }
}

function sourceLinks(sourceIds, animal) {
  if (!Array.isArray(sourceIds) || !sourceIds.length) return "";
  return `<span class="evidence-links">${sourceIds.map(id => {
    const sourceIndex = animal.sources.findIndex(item => item.id === id);
    const source = animal.sources[sourceIndex];
    if (!source) return "";
    const scope = source.scope.length > 34 ? `${source.scope.slice(0, 34)}…` : source.scope;
    return `<a href="#source-${escapeHTML(id)}" data-source-ref="${escapeHTML(id)}"
      aria-label="出典${sourceIndex + 1}、${escapeHTML(source.title)}、対象は${escapeHTML(source.scope)}">[${sourceIndex + 1}] ${escapeHTML(source.org)}｜${escapeHTML(scope)}</a>`;
  }).join("")}</span>`;
}

function renderTrivia(animal) {
  return (animal.trivia || []).map((item, index) => {
    const question = item.deepQuestion || modeValue(item.question);
    const answer = item.deepText || modeValue(item);
    return `
      <article class="trivia-card">
        <span>WONDER ${String(index + 1).padStart(2, "0")}</span>
        <h4>${definedText(question || `ふしぎ ${index + 1}`)}</h4>
        <p>${definedText(answer || item.text)}</p>
        <small>${escapeHTML(confidenceLabel(item.confidence))}</small>
        ${sourceLinks(item.sourceIds, animal)}
      </article>`;
  }).join("");
}

function renderTimeline(animal) {
  return animal.timeline.map(item => `
    <article>
      <time>${escapeHTML(item.age)}</time>
      <h4>${definedText(modeValue(item.title) || item.title)}</h4>
      <p>${definedText(modeValue(item.body) || item.body)}</p>
      ${sourceLinks(item.sourceIds, animal)}
    </article>`).join("");
}

function renderNarrative(value, animal) {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  return entries.map(item => `
    <article class="narrative-card">
      ${item.age ? `<time>${escapeHTML(item.age)}</time>` : ""}
      ${item.title ? `<h4>${definedText(modeValue(item.title) || item.title)}</h4>` : ""}
      <p>${definedText(modeValue(item))}</p>
      ${sourceLinks(item.sourceIds, animal)}
    </article>`).join("");
}

function renderGlossary(animal) {
  if (!animal.glossary?.length) return "";
  return `<details class="glossary">
    <summary>むずかしい言葉をやさしく見る</summary>
    <dl>${animal.glossary.map(item => `<div><dt>${escapeHTML(item.term)}${item.reading ? `（${escapeHTML(item.reading)}）` : ""}</dt><dd>${definedText(item.meaning || item.definition)}</dd></div>`).join("")}</dl>
  </details>`;
}

function renderClaims(animal) {
  return animal.claims.map(claim => `
    <article>
      <span>${escapeHTML(confidenceLabel(claim.confidence))}</span>
      <p>${definedText(claim.deepText || claim.text)}</p>
      <small>対象：${definedText(claim.taxonScope)}</small>
      ${sourceLinks(claim.sourceIds, animal)}
    </article>`).join("");
}

function renderSources(animal) {
  return animal.sources.map((source, index) => `
    <li id="source-${escapeHTML(source.id)}" tabindex="-1">
      <a href="${escapeHTML(source.url)}" target="_blank" rel="noopener noreferrer">
        <span><strong>[${index + 1}] ${escapeHTML(source.title)}</strong><small>${escapeHTML(source.org)}｜確認 ${escapeHTML(source.checkedAt)}</small></span>
        <b aria-hidden="true">↗</b>
      </a>
      <p class="scope-note">この資料の対象：${definedText(source.scope)}</p>
      <button class="source-back" data-source-back type="button">← 直前の説明へ戻る</button>
    </li>`).join("");
}

function renderDialog(animal) {
  const related = getRelatedAnimals(state.animals, animal.id, 2);
  const nextId = getNextAnimalId(state.animals, animal.id, state.viewed);
  const nextAnimal = state.animals.find(item => item.id === nextId);
  const favorite = state.favorites.has(animal.id);
  const tier = getAnimalTier(animal.id);
  const nextQuestion = animal.deepNextQuestion || modeValue(animal.nextQuestion) || animal.nextQuestion?.text || animal.question;
  const conservation = tier?.conservation || {};
  const conservationLabel = conservation.categoryLabel || conservation.category || conservation.status || "分類単位ごとに再評価中";
  els.dialogContent.innerHTML = `
    <section class="dialog-hero" style="--accent:${escapeHTML(animal.accent)}">
      <div class="dialog-portrait">${portrait(animal, "is-dialog")}</div>
      <button class="dialog-favorite" data-favorite="${escapeHTML(animal.id)}" data-context="dialog"
        aria-label="${escapeHTML(animal.name)}をお気に入り${favorite ? "から外す" : "に入れる"}"
        aria-pressed="${favorite}">${favorite ? "★ 保存中" : "☆ 採集帳へ"}</button>
      <small>${escapeHTML(animal.scientificName)} · ${escapeHTML(animal.group)}</small>
      <h2 id="dialog-title" tabindex="-1">${escapeHTML(animal.name)}</h2>
      <p>${definedText(animalText(animal, "hook"))}</p>
    </section>
    <div class="dialog-body">
      <div class="dialog-status-row"><span class="confidence">確認度：${escapeHTML(animalConfidenceLabel(animal.confidence))}</span>${tierBadge(animal.id)}</div>
      ${tier ? `<aside class="tier-context tier-${escapeHTML(String(tier.displayTier).toLowerCase())}"><strong>図鑑注目ティア ${escapeHTML(tier.displayTier)}</strong><p>${definedText(tier.tierReasonText || tier.reason || "公開された人気調査と野生での絶滅リスクから算定しています。")}</p><small>保全情報：${escapeHTML(conservationLabel)}｜${escapeHTML(conservation.assessmentScope || conservation.scope || "対象範囲は根拠欄に記載")}</small></aside>` : ""}
      <h3 class="dialog-question">${definedText(animalText(animal, "question"))}</h3>
      <p class="story-text">${definedText(animalText(animal, "story"))}</p>
      ${sourceLinks(animal.storySourceIds, animal)}

      <div class="secret-grid">
        <article><span>からだの秘密</span><p>${definedText(animalText(animal, "wonder"))}</p>${sourceLinks(animal.wonderSourceIds, animal)}</article>
        <article><span>働きと制約</span><p>${definedText(animalText(animal, "tradeoff"))}</p>${sourceLinks(animal.tradeoffSourceIds, animal)}</article>
      </div>
      ${renderGlossary(animal)}

      <details class="chapter" open><summary>進化の分かれ道</summary><div class="timeline" style="--accent:${escapeHTML(animal.accent)}">${renderTimeline(animal)}</div></details>
      <details class="chapter"><summary>研究の転機</summary><div class="narrative-list">${renderNarrative(animal.researchStory, animal)}</div></details>
      <details class="chapter"><summary>人との歴史</summary><div class="narrative-list">${renderNarrative(animal.humanHistory, animal)}</div></details>
      <details class="chapter" open><summary>4つのびっくり雑学</summary><div class="trivia-grid">${renderTrivia(animal)}</div></details>
      <details class="chapter"><summary>核心の主張と根拠</summary><div class="claim-list">${renderClaims(animal)}</div></details>

      <section class="related-section" aria-labelledby="related-title">
        <h3 id="related-title">つながる命</h3>
        <div>${related.map(item => `<button class="related-card" data-related-id="${escapeHTML(item.id)}">${portrait(item, "is-related")}<span><small>${escapeHTML(item.group)}</small><strong>${escapeHTML(item.name)}</strong><em>${escapeHTML(animalText(item, "question"))}</em></span></button>`).join("")}</div>
        ${termShelf(related.map(item => animalText(item, "question")), "関連する問いのことば")}
      </section>

      ${nextAnimal ? `<section class="next-question"><span>NEXT WONDER</span><h3>${definedText(nextQuestion)}</h3><button data-next-id="${escapeHTML(nextAnimal.id)}">${escapeHTML(nextAnimal.name)}へ続く <b aria-hidden="true">→</b></button></section>` : ""}

      <details class="chapter sources-chapter"><summary>証拠の小径 <small>外部サイト</small></summary><ul class="source-list">${renderSources(animal)}</ul></details>
    </div>`;
}

function markViewed(id) {
  if (state.viewed.has(id)) return;
  state.viewed.add(id);
  writeLocal("waa-viewed-v2", [...state.viewed]);
  renderCards();
  renderCollection();
  renderProgress();
}

function openAnimal(id, shouldOpen = true, preserveScroll = false, explicitReturnFocus = null) {
  const animal = state.animals.find(item => item.id === id);
  if (!animal) return;
  const scrollTop = preserveScroll ? els.dialog.scrollTop : 0;
  if (shouldOpen) {
    const activeElement = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
    dialogReturnFocus = explicitReturnFocus?.isConnected ? explicitReturnFocus : activeElement;
  }
  state.currentAnimalId = id;
  els.dialog.dataset.animalId = id;
  markViewed(id);
  renderDialog(animal);
  if (shouldOpen && !els.dialog.open) els.dialog.showModal();
  els.dialog.scrollTop = scrollTop;
  if (shouldOpen) document.querySelector("#dialog-close").focus();
}

function openAnimalFromCardResult(animalId) {
  const returnTarget = document.querySelector("#gacha-title");
  cardResultReturnFocus = null;
  els.resultDialog.close();
  if (animalId) requestAnimationFrame(() => openAnimal(animalId, true, false, returnTarget));
}

function focusFavorite(id, context) {
  requestAnimationFrame(() => {
    [...document.querySelectorAll("[data-favorite]")]
      .find(button => button.dataset.favorite === id && button.dataset.context === context)?.focus();
  });
}

function toggleFavorite(id, context = "explore") {
  const animal = state.animals.find(item => item.id === id);
  if (!animal) return;
  const removing = state.favorites.has(id);
  const collectionBefore = state.animals.filter(item => state.favorites.has(item.id)).map(item => item.id);
  const removedIndex = collectionBefore.indexOf(id);
  if (removing) {
    state.favorites.delete(id);
    showToast(`${animal.name}を採集帳から外しました`);
  } else {
    state.favorites.add(id);
    showToast(`${animal.name}をふしぎ採集帳へ保存しました`);
  }
  writeLocal("waa-favorites", [...state.favorites]);
  renderCards();
  renderCollection();
  if (els.dialog.open && state.currentAnimalId) renderDialog(animal);
  if (removing && context === "collection") {
    const remaining = collectionBefore.filter(itemId => itemId !== id);
    const nextId = remaining[Math.min(removedIndex, remaining.length - 1)];
    requestAnimationFrame(() => {
      if (nextId) {
        document.querySelector(`[data-favorite="${nextId}"][data-context="collection"]`)?.focus();
      } else {
        document.querySelector("#favorite-empty .primary-action")?.focus();
      }
    });
  } else {
    focusFavorite(id, context);
  }
}

function applyTheme(theme) {
  state.activeTheme = state.activeTheme === theme ? "" : theme;
  state.query = "";
  state.filter = "all";
  els.search.value = "";
  renderQuestionTrails();
  renderFilters();
  renderCards();
  document.querySelector("#explore").scrollIntoView({ behavior: preferredScrollBehavior() });
}

function clearFilters() {
  state.query = "";
  state.filter = "all";
  state.activeTheme = "";
  els.search.value = "";
  renderQuestionTrails();
  renderFilters();
  renderCards();
  els.search.focus();
}

function openRandomAnimal() {
  if (!state.animals.length) return;
  const unseen = state.animals.filter(animal => !state.viewed.has(animal.id));
  const pool = unseen.length ? unseen : state.animals.filter(animal => animal.id !== state.lastRandomId);
  const selected = pool[Math.floor(Math.random() * pool.length)] || state.animals[0];
  state.lastRandomId = selected.id;
  openAnimal(selected.id);
}

function showToast(message) {
  if (!els.toast) return;
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), 2300);
}

function updateProof() {
  document.querySelector("#animal-total").textContent = String(state.animals.length);
  const sourceIds = new Set([
    ...state.animals.flatMap(animal => animal.sources.map(source => source.id)),
    ...(state.tierData?.sources || []).map(source => source.id)
  ]);
  document.querySelector("#source-total").textContent = String(sourceIds.size);
  document.querySelector("#claim-total").textContent = String(state.animals.reduce((sum, animal) => sum + animal.claims.length, 0));
  document.querySelector("#glossary-total").textContent = String(state.glossary.length);
  // 語数はデータ次第で増えるため、見出しとボタンの文言もデータから作る
  const glossaryTitle = document.querySelector("#glossary-list-title");
  if (glossaryTitle) glossaryTitle.textContent = `${state.glossary.length}語のことば辞典`;
  const glossaryButton = document.querySelector("#open-glossary-list");
  if (glossaryButton) glossaryButton.innerHTML = `${state.glossary.length}語の辞典を見る <span aria-hidden="true">→</span>`;
}

document.addEventListener("click", event => {
  const glossaryTerm = event.target.closest("[data-glossary-id]");
  if (glossaryTerm) {
    event.preventDefault();
    event.stopPropagation();
    openGlossary(glossaryTerm.dataset.glossaryId, glossaryTerm);
    return;
  }
  const quizChoice = event.target.closest("[data-quiz-choice]");
  if (quizChoice) {
    answerQuiz(quizChoice.dataset.quizChoice);
    return;
  }
  const rankFilter = event.target.closest("[data-rank-filter]");
  if (rankFilter) {
    state.cardRankFilter = rankFilter.dataset.rankFilter;
    renderRankControls();
    renderDiscoveryCabinet();
    requestAnimationFrame(() => document.querySelector(`[data-rank-filter="${CSS.escape(state.cardRankFilter)}"]`)?.focus());
    return;
  }
  const groupFilter = event.target.closest("[data-group-filter]");
  if (groupFilter) {
    state.cardGroupFilter = groupFilter.dataset.groupFilter;
    renderRankControls();
    renderDiscoveryCabinet();
    requestAnimationFrame(() => document.querySelector(`[data-group-filter="${CSS.escape(state.cardGroupFilter)}"]`)?.focus());
    return;
  }
  const ownedFilter = event.target.closest("#owned-filter");
  if (ownedFilter) {
    state.cardOwnedOnly = !state.cardOwnedOnly;
    renderRankControls();
    renderDiscoveryCabinet();
    return;
  }
  const tierFilter = event.target.closest("[data-tier-filter]");
  if (tierFilter) {
    state.tierFilter = tierFilter.dataset.tierFilter;
    renderTierRanking();
    requestAnimationFrame(() => document.querySelector(`[data-tier-filter="${CSS.escape(state.tierFilter)}"]`)?.focus());
    return;
  }
  const discoveryCard = event.target.closest("[data-card-animal]");
  if (discoveryCard) {
    openAnimal(discoveryCard.dataset.cardAnimal);
    return;
  }
  const resultAnimal = event.target.closest("[data-result-animal]");
  if (resultAnimal) {
    openAnimalFromCardResult(resultAnimal.dataset.resultAnimal);
    return;
  }
  const sourceRef = event.target.closest("[data-source-ref]");
  if (sourceRef) {
    event.preventDefault();
    lastEvidenceTrigger = sourceRef;
    const sourceChapter = document.querySelector(".sources-chapter");
    if (sourceChapter) sourceChapter.open = true;
    const source = document.querySelector(`#source-${CSS.escape(sourceRef.dataset.sourceRef)}`);
    requestAnimationFrame(() => {
      source?.scrollIntoView({ behavior: preferredScrollBehavior(), block: "start" });
      source?.focus({ preventScroll: true });
    });
    return;
  }
  const sourceBack = event.target.closest("[data-source-back]");
  if (sourceBack) {
    if (lastEvidenceTrigger?.isConnected) {
      lastEvidenceTrigger.scrollIntoView({ behavior: preferredScrollBehavior(), block: "center" });
      lastEvidenceTrigger.focus({ preventScroll: true });
    } else {
      document.querySelector("#dialog-title")?.focus();
    }
    return;
  }
  const favorite = event.target.closest("[data-favorite]");
  if (favorite) {
    event.stopPropagation();
    toggleFavorite(favorite.dataset.favorite, favorite.dataset.context);
    return;
  }
  const filter = event.target.closest("[data-filter]");
  if (filter) {
    state.filter = filter.dataset.filter;
    renderFilters();
    renderCards();
    return;
  }
  const theme = event.target.closest("[data-theme]");
  if (theme) {
    applyTheme(theme.dataset.theme);
    return;
  }
  const related = event.target.closest("[data-related-id]");
  if (related) {
    openAnimal(related.dataset.relatedId, false);
    els.dialog.scrollTo({ top: 0, behavior: preferredScrollBehavior() });
    document.querySelector("#dialog-title").focus();
    return;
  }
  const next = event.target.closest("[data-next-id]");
  if (next) {
    openAnimal(next.dataset.nextId, false);
    els.dialog.scrollTo({ top: 0, behavior: preferredScrollBehavior() });
    document.querySelector("#dialog-title").focus();
    return;
  }
  const card = event.target.closest("[data-animal-id]");
  if (card) openAnimal(card.dataset.animalId);
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !els.glossaryPopup.hidden) {
    event.preventDefault();
    event.stopPropagation();
    closeGlossary();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    els.search.focus();
  }
});

document.querySelector("#clear-search").addEventListener("click", clearFilters);
document.querySelector("#random-animal").addEventListener("click", openRandomAnimal);
document.querySelector("#glossary-close").addEventListener("click", closeGlossary);
document.querySelector("#glossary-done").addEventListener("click", closeGlossary);
document.querySelector("#open-glossary-list").addEventListener("click", event => openGlossaryList(event.currentTarget));
document.querySelector("#glossary-list-close").addEventListener("click", () => els.glossaryListDialog.close());
els.glossarySearch.addEventListener("input", event => renderGlossaryList(event.target.value));
els.glossaryListDialog.addEventListener("click", event => {
  if (event.target === els.glossaryListDialog) els.glossaryListDialog.close();
});
els.glossaryListDialog.addEventListener("close", () => {
  if (glossaryListReturnFocus?.isConnected) glossaryListReturnFocus.focus();
  glossaryListReturnFocus = null;
});
els.quizNext.addEventListener("click", nextQuiz);
els.quizSource.addEventListener("click", () => {
  const quiz = state.quizzes.find(item => item.id === els.quizSource.dataset.quizId);
  if (!quiz) return;
  openAnimal(quiz.animalId);
  requestAnimationFrame(() => {
    const chapter = document.querySelector(".sources-chapter");
    if (chapter) chapter.open = true;
    document.querySelectorAll(".source-list .is-quiz-evidence").forEach(item => item.classList.remove("is-quiz-evidence"));
    const matchedSources = (quiz.sourceIds || []).map(sourceId => {
      const source = document.querySelector(`#source-${CSS.escape(sourceId)}`);
      source?.classList.add("is-quiz-evidence");
      return source;
    }).filter(Boolean);
    matchedSources[0]?.scrollIntoView({ behavior: preferredScrollBehavior(), block: "start" });
    showToast(`この問題の根拠${matchedSources.length}件を光で示しました`);
  });
});
els.dailyCardDraw.addEventListener("click", event => performDraw("daily", event.currentTarget));
els.clockRecovery.addEventListener("click", recoverClock);
els.singleCardDraw.addEventListener("click", event => performDraw("single", event.currentTarget));
els.tenCardDraw.addEventListener("click", event => performDraw("ten", event.currentTarget));
els.leafExchangeButton.addEventListener("click", event => exchangeLeaves(event.currentTarget));
document.querySelector("#result-skip").addEventListener("click", () => els.resultDialog.classList.add("is-revealed"));
document.querySelector("#result-close").addEventListener("click", () => els.resultDialog.close());
document.querySelector("#result-top-close").addEventListener("click", () => els.resultDialog.close());
els.resultRead.addEventListener("click", () => {
  openAnimalFromCardResult(els.resultRead.dataset.animalId);
});
els.resultDialog.addEventListener("click", event => {
  if (event.target === els.resultDialog) els.resultDialog.close();
});
els.resultDialog.addEventListener("close", () => {
  els.resultDialog.classList.remove("has-lifecrown", "is-revealed");
  const returnTarget = cardResultReturnFocus?.isConnected && !cardResultReturnFocus.disabled
    ? cardResultReturnFocus
    : document.querySelector("#gacha-title");
  requestAnimationFrame(() => returnTarget?.focus());
  cardResultReturnFocus = null;
});
els.dialog.addEventListener("click", event => {
  if (event.target === els.dialog) els.dialog.close();
});
els.dialog.addEventListener("close", () => {
  closeGlossary();
  if (dialogReturnFocus?.isConnected) dialogReturnFocus.focus();
  dialogReturnFocus = null;
  lastEvidenceTrigger = null;
});
els.search.addEventListener("input", event => {
  state.query = event.target.value;
  state.activeTheme = "";
  renderQuestionTrails();
  renderCards();
});
els.dailyReveal.addEventListener("click", () => {
  state.dailyRevealed = !state.dailyRevealed;
  renderDailyWonder();
});

async function init() {
  try {
    const loadJSON = async path => {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      return response.json();
    };
    const [animals, glossary, quizzes, tierData] = await Promise.all([
      loadJSON("data/animals.json"),
      loadJSON("data/glossary.json"),
      loadJSON("data/quizzes.json"),
      loadJSON("data/animal-tiers.json")
    ]);
    if (!Array.isArray(animals) || animals.length === 0) throw new Error("動物データが空です");
    if (!Array.isArray(glossary) || glossary.length === 0) throw new Error("用語辞典が空です");
    if (!Array.isArray(quizzes) || quizzes.length < DAILY_QUIZ_LIMIT) throw new Error("クイズが不足しています");
    if (!tierData || !Array.isArray(tierData.animals) || tierData.animals.length !== animals.length) throw new Error("動物ティアデータが不足しています");
    state.animals = animals;
    state.tierData = tierData;
    state.tierByAnimal = new Map(tierData.animals.map(item => [item.animalId, item]));
    state.quizzes = quizzes;
    state.favorites = sanitizeStoredIds(rawFavorites, animals);
    state.viewed = sanitizeStoredIds(rawViewed, animals);
    setupGlossary(glossary);
    state.cards = createCardCatalog(animals);
    state.game = sanitizeGameState(rawGame, animals.map(animal => animal.id), quizzes.map(quiz => quiz.id));
    if (loadedGameSnapshot.source === "backup") {
      try {
        localStorage.setItem("waa-game-v2", JSON.stringify(state.game));
        showToast("直前の正常な学び記録から復旧しました");
      } catch (error) {
        console.error("game_backup_restore_failed", error);
      }
    }
    const needsEconomyMigration = Number(rawGame?.schemaVersion) < GAME_SCHEMA_VERSION
      || Object.hasOwn(rawGame || {}, "points")
      || Number(rawGame?.unopenedSingles) > 0
      || Number(rawGame?.unopenedTens) > 0;
    if (needsEconomyMigration) {
      const migratedGame = structuredClone(state.game);
      migratedGame.revision += 1;
      persistGame(migratedGame);
    }
    const todayKey = localDateKey();
    if (!hasClockRollback(state.game.latestSeenDate, todayKey)) {
      const offeredIds = getDailyQuizIds(quizzes, todayKey);
      const previousQuizDate = state.game.quizDay.dateKey;
      const preparedGame = prepareQuizDay(state.game, todayKey, offeredIds);
      if (previousQuizDate !== todayKey) {
        preparedGame.revision = state.game.revision + 1;
        if (!persistGame(preparedGame)) state.game = preparedGame;
      } else {
        state.game = preparedGame;
      }
    }
    state.dailyQuiz = state.game.quizDay.offeredIds
      .map(id => quizzes.find(quiz => quiz.id === id))
      .filter(Boolean);
    const attempted = new Set(state.game.quizDay.attemptedIds);
    const firstUnanswered = state.dailyQuiz.findIndex(quiz => !attempted.has(quiz.id));
    state.currentQuizIndex = firstUnanswered >= 0 ? firstUnanswered : state.dailyQuiz.length;
    updateProof();
    renderQuestionTrails();
    renderFilters();
    renderCards();
    renderCollection();
    renderProgress();
    renderDailyWonder();
    renderTierRanking();
    renderQuiz();
    renderGameUI();
  } catch (error) {
    els.grid.innerHTML = `<div class="empty-state"><span>🪹</span><h3>図鑑データを読み込めませんでした</h3><p>サーバーから起動し、Python検証で動物・辞典・クイズのデータを確認してください。</p></div>`;
    els.count.textContent = "0";
    console.error("animal_data_load_failed", error);
  }
}

window.addEventListener("storage", event => {
  if (event.key !== "waa-game-v2" || !event.newValue || !state.animals.length) return;
  try {
    const parsed = JSON.parse(event.newValue);
    state.game = sanitizeGameState(parsed, state.animals.map(animal => animal.id), state.quizzes.map(quiz => quiz.id));
    renderQuiz();
    renderGameUI();
    showToast("別の画面の学び記録を反映しました");
  } catch {
    showToast("別の画面の記録を読み込めませんでした");
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshDailyState();
});

// HTTPS配信(ホーム画面アプリ運用)のときだけオフライン保存を有効化する。
// ローカル開発では登録せず、古いキャッシュによる混乱を避ける
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

init();
