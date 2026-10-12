'use strict';

// AoE4World halka açık API'si (v0). Sadece belgelenmiş JSON uç noktalarını kullanır;
// /summary gibi bot-dışı sayfaları kazımaz. Yanıtlar kısa süre önbelleklenir.
const BASE = 'https://aoe4world.com/api/v0';
const USER_AGENT = 'AgeOfKocu/0.1 (AoE4 coach overlay)';

const cache = new Map();

async function getJson(url, ttlMs = 60 * 1000) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`AoE4World ${res.status}: ${url}`);
  const data = await res.json();
  cache.set(url, { at: Date.now(), data });
  return data;
}

function player(profileId) {
  return getJson(`${BASE}/players/${profileId}`, 5 * 60 * 1000);
}

// Son maçlar; her öğe { game_id, kind, map, duration, teams: [[{player:{...}}]] } biçimindedir.
async function games(profileId, { limit = 50, leaderboard, ttlMs = 5 * 60 * 1000 } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (leaderboard) params.set('leaderboard', leaderboard);
  const data = await getJson(`${BASE}/players/${profileId}/games?${params}`, ttlMs);
  return data.games || [];
}

async function searchPlayers(query) {
  const data = await getJson(`${BASE}/players/search?query=${encodeURIComponent(query)}`);
  return (data.players || []).map((p) => ({
    profileId: p.profile_id,
    name: p.name,
    country: p.country,
    rating: p.leaderboards?.rm_team?.rating ?? p.leaderboards?.rm_solo?.rating ?? null,
  }));
}

// Maç bittikten sonra AoE4World'ün işlediği maç kaydı (log'daki matchID = game_id).
async function findGame(profileId, gameId) {
  const list = await games(profileId, { limit: 10, ttlMs: 0 });
  return list.find((g) => g.game_id === gameId) || null;
}

// ---- Güncel meta (halka açık istatistik uç noktaları, son yamalar) ----
const META_TTL_MS = 6 * 60 * 60 * 1000;

// Maç türünü istatistik türüne çevirir: 1v1 sıralı "rm_solo", takım oyunları kendi adıyla.
function statsKind(kind) {
  if (!kind || kind === 'rm_1v1' || kind === 'qm_1v1') return 'rm_solo';
  return kind.replace(/^qm_/, 'rm_');
}

// Seviye süzgeci: bronze, silver, gold, platinum, diamond, conqueror (yoksa tüm seviyeler).
const RANK_LEVELS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'conqueror'];
const rankQuery = (rankLevel) => (RANK_LEVELS.includes(rankLevel) ? `?rank_level=${rankLevel}` : '');

// "silver_1" -> "silver"; bilinmeyen -> null
function rankLevelOf(rank) {
  const base = String(rank || '').replace(/_\d+$/, '');
  return RANK_LEVELS.includes(base) ? base : null;
}

// Bir üst seviye (oyuncunun hedefi): silver -> gold; conqueror -> conqueror
function nextRankLevel(level) {
  const i = RANK_LEVELS.indexOf(level);
  return i < 0 ? null : RANK_LEVELS[Math.min(RANK_LEVELS.length - 1, i + 1)];
}

// Ulusların kazanma/seçilme oranları: [{ civilization, win_rate, pick_rate, games_count, duration_median }]
async function civStats(kind, rankLevel = null) {
  return (await getJson(`${BASE}/stats/${statsKind(kind)}/civilizations${rankQuery(rankLevel)}`, META_TTL_MS)).data || [];
}

// Haritalar: [{ map_id, map, games_count, duration_median, highest_win_rate_civilization }]
async function mapStats(kind, rankLevel = null) {
  return (await getJson(`${BASE}/stats/${statsKind(kind)}/maps${rankQuery(rankLevel)}`, META_TTL_MS)).data || [];
}

// Tek haritada ulusların başarısı: [{ civilization, win_rate, games_count, duration_median }]
async function mapCivStats(kind, mapId, rankLevel = null) {
  return (await getJson(`${BASE}/stats/${statsKind(kind)}/maps/${mapId}${rankQuery(rankLevel)}`, META_TTL_MS)).data || [];
}

// Oyuncunun AoE4World'deki bütün maçları (sayfa sayfa, en fazla maxPages × 50).
async function allGames(profileId, { maxPages = 10, ttlMs = 30 * 60 * 1000 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    let data;
    try {
      data = await getJson(`${BASE}/players/${profileId}/games?limit=50&page=${page}`, ttlMs);
    } catch {
      break; // son sayfadan sonrası JSON değil
    }
    const list = data.games || [];
    out.push(...list);
    if (!list.length || out.length >= (data.total_count || 0)) break;
  }
  return out;
}

function clearCache() {
  cache.clear();
}

module.exports = { player, games, allGames, searchPlayers, findGame, clearCache, civStats, mapStats, mapCivStats, statsKind, rankLevelOf, nextRankLevel, RANK_LEVELS };
