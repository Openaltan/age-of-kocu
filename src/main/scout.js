'use strict';

const aoe4world = require('./aoe4world');
const civs = require('./civs');

const SHORT_GAME_SEC = 15 * 60;
const LONG_GAME_SEC = 30 * 60;

// Oyunun türüne göre hangi reytingin gösterileceği.
function ratingModes(kind) {
  if (kind === 'rm_1v1') return ['rm_solo', 'rm_1v1_elo'];
  if (kind && kind.startsWith('rm_')) return ['rm_team', `${kind}_elo`];
  if (kind && kind.startsWith('qm_')) return [`${kind}_elo`, 'rm_team'];
  return ['rm_team', 'rm_solo'];
}

function pct(wins, n) {
  return n ? Math.round((wins / n) * 100) : null;
}

function bucket() {
  return { n: 0, wins: 0 };
}

// Saf analiz: AoE4World maç listesinden oyuncu profili çıkarır.
function analyzeGames(profileId, games) {
  const rows = [];
  for (const g of games) {
    const me = g.teams.flat().map((t) => t.player).find((p) => p.profile_id === profileId);
    if (!me || (me.result !== 'win' && me.result !== 'loss')) continue;
    rows.push({ win: me.result === 'win', civ: me.civilization, duration: g.duration || 0, kind: g.kind, input: me.input_type });
  }

  const overall = bucket();
  const byCiv = new Map();
  const short = bucket();
  const long = bucket();
  let winDur = 0;
  let lossDur = 0;
  let controller = 0;
  for (const r of rows) {
    overall.n += 1;
    overall.wins += r.win;
    if (!byCiv.has(r.civ)) byCiv.set(r.civ, bucket());
    const c = byCiv.get(r.civ);
    c.n += 1;
    c.wins += r.win;
    if (r.duration < SHORT_GAME_SEC) { short.n += 1; short.wins += r.win; }
    if (r.duration > LONG_GAME_SEC) { long.n += 1; long.wins += r.win; }
    if (r.win) winDur += r.duration; else lossDur += r.duration;
    if (r.input === 'controller') controller += 1;
  }

  // Seri: en son maçtan geriye aynı sonuç kaç kez tekrarlandı (+ galibiyet, - mağlubiyet).
  let streak = 0;
  for (const r of rows) {
    if (streak === 0) streak = r.win ? 1 : -1;
    else if (r.win === streak > 0) streak += streak > 0 ? 1 : -1;
    else break;
  }

  const losses = overall.n - overall.wins;
  return {
    games: overall.n,
    winRate: pct(overall.wins, overall.n),
    topCivs: [...byCiv.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 3)
      .map(([slug, b]) => ({ slug, tr: civs.trName(slug), games: b.n, winRate: pct(b.wins, b.n) })),
    byCiv: Object.fromEntries([...byCiv.entries()].map(([slug, b]) => [slug, { games: b.n, winRate: pct(b.wins, b.n) }])),
    short: { games: short.n, winRate: pct(short.wins, short.n) },
    long: { games: long.n, winRate: pct(long.wins, long.n) },
    shortWinShare: overall.wins ? Math.round((rows.filter((r) => r.win && r.duration < SHORT_GAME_SEC).length / overall.wins) * 100) : null,
    avgWinMin: overall.wins ? Math.round(winDur / overall.wins / 60) : null,
    avgLossMin: losses ? Math.round(lossDur / losses / 60) : null,
    form: rows.slice(0, 10).map((r) => (r.win ? 'G' : 'M')).join(''),
    streak,
    controller: overall.n > 0 && controller / overall.n > 0.5,
  };
}

// Profil istatistiklerinden Türkçe, eyleme dönük notlar üretir.
// level: 'danger' (dikkat), 'chance' (fırsat), 'info'.
function insights(stats, civSlug) {
  const out = [];
  const add = (level, text) => out.push({ level, text });

  if (stats.games < 5) {
    add('info', `Az veri var (${stats.games} maç). Yorumlar kesin değil.`);
  }

  const civ = civSlug ? stats.byCiv[civSlug] : null;
  const civName = civSlug ? civs.trName(civSlug) : null;
  if (civSlug && stats.games >= 10) {
    if (!civ || civ.games <= 1) {
      add('chance', `${civName} ile neredeyse hiç oynamamış. Tecrübesiz olabilir.`);
    } else if (civ.games >= 5 && civ.winRate >= 60) {
      add('danger', `${civName} uzmanı: ${civ.games} maçta %${civ.winRate} kazanmış.`);
    } else if (civ.games >= 8) {
      add('info', `${civName} ana ülkelerinden (${civ.games} maç, %${civ.winRate}).`);
    }
  }

  if (stats.shortWinShare !== null && stats.shortWinShare >= 40 && stats.games >= 10) {
    add('danger', `Erken bitirmeyi seviyor (galibiyetlerinde 15 dk altı oranı: %${stats.shortWinShare}). İlk 10 dakikada savunmaya hazır ol.`);
  }
  if (stats.long.games >= 5 && stats.short.games >= 5) {
    const s = stats.short.winRate;
    const l = stats.long.winRate;
    if (l - s >= 15) {
      if (l >= 50) add('danger', `Uzun maçlarda güçlü (30+ dk: %${l}). Oyunu erken koparmaya çalış.`);
      else add('chance', `Erken oyunda zayıf (15 dk altı: %${s}). Erken baskı kur.`);
    } else if (s - l >= 15) {
      if (s >= 50) add('danger', `Erken oyunda güçlü (15 dk altı: %${s}), uzayınca düşüyor (%${l}). Erken baskıyı karşıla, oyunu uzat.`);
      else add('chance', `Uzayan maçlarda zayıflıyor (30+ dk: %${l}). Oyunu uzat.`);
    }
  }

  if (stats.streak <= -3) add('chance', `Üst üste ${-stats.streak} maç kaybetmiş. Moralsiz olabilir.`);
  if (stats.streak >= 3) add('danger', `Formda: üst üste ${stats.streak} galibiyet.`);
  if (stats.controller) add('chance', 'Kontrolcüyle oynuyor: aynı anda birkaç cepheden taciz ona zor gelir.');

  const t = civSlug && civs.threat(civSlug);
  if (t) add('info', t);
  return out;
}

function pickRating(player, kind) {
  for (const mode of ratingModes(kind)) {
    const m = player?.modes?.[mode];
    if (m && m.rating != null) {
      return { mode, rating: m.rating, rankLevel: m.rank_level || null, winRate: m.win_rate ?? null, games: m.games_count ?? null };
    }
  }
  return null;
}

// Tek oyuncu kartı: maçtaki oyuncu bilgisi + AoE4World profili + notlar.
async function scoutPlayer(p, kind) {
  const civ = civs.fromLogCode(p.civCode);
  const civSlug = civ ? civ.slug : null;
  const card = {
    profileId: p.profileId,
    name: p.name,
    team: p.team,
    civCode: p.civCode,
    civSlug,
    civTr: civSlug ? civ.tr : p.civCode ? civs.trName(p.civCode) : null,
    rating: null,
    stats: null,
    insights: [],
    error: null,
  };
  if (!p.profileId) return card;
  try {
    const [player, games] = await Promise.all([aoe4world.player(p.profileId), aoe4world.games(p.profileId, { limit: 50 })]);
    card.name = card.name || player.name;
    card.rating = pickRating(player, kind);
    card.country = player.country || null;
    card.stats = analyzeGames(p.profileId, games);
    card.insights = insights(card.stats, civSlug);
  } catch (err) {
    card.error = err.message;
  }
  return card;
}

// Bütün maç: her iki takım için kartlar ve rakip takımdaki ana tehdit.
async function scoutMatch(match, localProfileId) {
  const me = match.players.find((p) => p.profileId === localProfileId);
  const myTeam = me ? me.team : null;
  const kind = `rm_${Math.ceil(match.players.length / 2)}v${Math.ceil(match.players.length / 2)}`;
  const cards = await Promise.all(match.players.map((p) => scoutPlayer(p, kind)));
  const enemies = cards.filter((c) => myTeam !== null && c.team !== myTeam);
  const allies = cards.filter((c) => myTeam === null || c.team === myTeam);
  // Notlar rakip gözüyle yazıldığı için müttefik kartlarında gösterilmez.
  if (myTeam !== null) for (const c of allies) c.insights = [];

  const ranked = enemies.filter((c) => c.rating).sort((a, b) => b.rating.rating - a.rating.rating);
  if (ranked.length > 1 && ranked[0].rating.rating - ranked[1].rating.rating >= 50) {
    ranked[0].insights.unshift({ level: 'danger', text: 'Rakip takımın en güçlüsü. Ona tek başına girme, takımca odaklanın.' });
    ranked[0].mainThreat = true;
  }
  return { matchId: match.matchId, kind, myTeam, allies, enemies };
}

module.exports = { analyzeGames, insights, scoutPlayer, scoutMatch, pickRating };
