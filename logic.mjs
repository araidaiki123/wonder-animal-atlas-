"use strict";

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/\s+/g, "");
}

function searchableText(animal) {
  const sourceFreeAnimal = { ...animal, sources: undefined };
  return normalizeText(JSON.stringify(sourceFreeAnimal));
}

export function getVisibleAnimals(animals, state) {
  const query = normalizeText(state.query);
  const activeTheme = normalizeText(state.activeTheme);
  return animals.filter(animal => {
    const habitatMatch = state.filter === "all" || animal.habitat === state.filter || animal.group === state.filter;
    const queryMatch = !query || searchableText(animal).includes(query);
    const themes = (animal.themes || []).map(normalizeText);
    const themeMatch = !activeTheme || themes.some(theme =>
      theme.includes(activeTheme) || activeTheme.includes(theme)
    );
    return habitatMatch && queryMatch && themeMatch;
  });
}

export function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getDailyWonder(animals, dateKey = localDateKey()) {
  const candidates = animals.flatMap(animal => {
    const trivia = Array.isArray(animal.trivia) && animal.trivia.length
      ? animal.trivia
      : [{ id: "wonder", kids: animal.wonder, deep: animal.wonder, sourceIds: [] }];
    return trivia.map(item => ({ animal, trivia: item }));
  });
  if (!candidates.length) return null;
  const [year, month, day] = String(dateKey).split("-").map(Number);
  const dayNumber = Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  return candidates[((dayNumber % candidates.length) + candidates.length) % candidates.length];
}

export function getRelatedAnimals(animals, animalId, limit = 2) {
  const animal = animals.find(item => item.id === animalId);
  if (!animal) return [];
  const explicit = (animal.relatedIds || [])
    .map(id => animals.find(item => item.id === id))
    .filter(Boolean)
    .filter(item => item.id !== animalId);
  const seen = new Set(explicit.map(item => item.id));
  const themeFallback = animals
    .filter(item => item.id !== animalId && !seen.has(item.id))
    .map(item => ({
      item,
      score: (item.themes || []).filter(theme => (animal.themes || []).includes(theme)).length
    }))
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.item);
  return [...explicit, ...themeFallback].slice(0, limit);
}

export function getNextAnimalId(animals, currentId, viewedIds) {
  const viewed = viewedIds instanceof Set ? viewedIds : new Set(viewedIds || []);
  const related = getRelatedAnimals(animals, currentId, animals.length);
  const relatedUnseen = related.find(animal => !viewed.has(animal.id));
  if (relatedUnseen) return relatedUnseen.id;
  const anyUnseen = animals.find(animal => animal.id !== currentId && !viewed.has(animal.id));
  if (anyUnseen) return anyUnseen.id;
  return related[0]?.id || animals.find(animal => animal.id !== currentId)?.id || null;
}

export function sanitizeStoredIds(rawIds, animals) {
  const valid = new Set(animals.map(animal => animal.id));
  return new Set((Array.isArray(rawIds) ? rawIds : []).filter(id => valid.has(id)));
}
