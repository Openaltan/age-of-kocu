'use strict';

// Takım analizi: aynı ekiple (ör. altanarl, Pirofurkan, jxstixab) oynanan maçlardan ikili/üçlü
// dinamikler ve kayıt analizlerinden her oyuncunun alışkanlıkları (tarz mı, hata mı).
// Saf modül: AoE4World maç listeleri ve analizler dışarıdan verilir.

const pct = (w, n) => (n ? Math.round((w / n) * 100) : null);
const minutes = (sec) => (sec == null ? null : Math.round(sec / 60));

// Üyelerin maç listelerinden takım maçları: aynı tarafta en az iki üye olan maçlar (tekrarsız).
// members: [{ id, name }], gamesByMember: { [id]: AoE4World maçları }
function squadGames(members, gamesByMember) {
  const ids = new Set(members.map((m) => m.id));
  const seen = new Map();
  for (const m of members) {
    for (const g of gamesByMember[m.id] || []) {
      if (seen.has(g.game_id) || !Array.isArray(g.teams)) continue;
      const team = g.teams.find((t) => t.some((x) => x.player.profile_id === m.id));
      if (!team) continue;
      const mine = team.filter((x) => ids.has(x.player.profile_id));
      if (mine.length < 2) continue;
      const result = mine[0].player.result;
      if (result !== 'win' && result !== 'loss') continue;
      seen.set(g.game_id, {
        id: g.game_id,
        kind: g.kind,
        map: g.map,
        season: g.season ?? null,
        startedAt: g.started_at,
        duration: g.duration || 0,
        win: result === 'win',
        lineup: mine.map((x) => x.player.profile_id).sort((a, b) => a - b),
        civs: Object.fromEntries(mine.map((x) => [x.player.profile_id, x.player.civilization])),
      });
    }
  }
  return [...seen.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

const DURATION_BUCKETS = [[0, 15, '15 dk altı'], [15, 25, '15-25 dk'], [25, 35, '25-35 dk'], [35, Infinity, '35 dk üstü']];

// Bir kombinasyon (ör. [altan, piro]) için: o ikisinin aynı takımda olduğu bütün maçlar.
function comboStats(records, comboIds, { nameOf = String, civName = String } = {}) {
  const games = records.filter((r) => comboIds.every((id) => r.lineup.includes(id)));
  const wins = games.filter((g) => g.win).length;
  const group = (keyOf) => {
    const m = new Map();
    for (const g of games) {
      const k = keyOf(g);
      if (!k) continue;
      const b = m.get(k) || { n: 0, w: 0 };
      b.n++;
      b.w += g.win;
      m.set(k, b);
    }
    return [...m.entries()].map(([k, b]) => ({ ad: k, mac: b.n, kazanma: pct(b.w, b.n) }));
  };
  const maps = group((g) => g.map).filter((x) => x.mac >= 2).sort((a, b) => b.kazanma - a.kazanma || b.mac - a.mac);
  const civCombos = group((g) => comboIds.map((id) => `${nameOf(id)}: ${civName(g.civs[id])}`).join(' + ')).filter((x) => x.mac >= 2).sort((a, b) => b.mac - a.mac).slice(0, 6);
  const avg = (xs) => (xs.length ? minutes(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
  return {
    oyuncular: comboIds.map(nameOf),
    mac: games.length,
    galibiyet: wins,
    kazanma: pct(wins, games.length),
    sonOn: games.slice(0, 10).map((g) => (g.win ? 'G' : 'M')).join(''),
    ortalamaKazanilanDk: avg(games.filter((g) => g.win).map((g) => g.duration)),
    ortalamaKaybedilenDk: avg(games.filter((g) => !g.win).map((g) => g.duration)),
    sureyeGore: DURATION_BUCKETS.map(([a, b, label]) => {
      const xs = games.filter((g) => g.duration / 60 >= a && g.duration / 60 < b);
      return { aralik: label, mac: xs.length, kazanma: pct(xs.filter((g) => g.win).length, xs.length) };
    }).filter((x) => x.mac),
    turler: group((g) => g.kind),
    enIyiHaritalar: maps.slice(0, 4),
    enKotuHaritalar: maps.length > 4 ? maps.slice(-3).reverse() : [],
    ulusKombinasyonlari: civCombos,
  };
}

// Her ikili ve (varsa) üçlü için istatistik + üyelerin takım maçlarındaki ülke tercihleri.
function squadReport(members, gamesByMember, { civName = String } = {}) {
  const records = squadGames(members, gamesByMember);
  const nameOf = (id) => members.find((m) => m.id === id)?.name || String(id);
  const opts = { nameOf, civName };
  const combos = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) combos.push([members[i].id, members[j].id]);
  }
  const pairs = combos.map((c) => comboStats(records, c, opts)).filter((c) => c.mac);
  const trio = members.length >= 3 ? comboStats(records, members.slice(0, 3).map((m) => m.id), opts) : null;
  const civPrefs = members.map((m) => {
    const mine = records.filter((r) => r.lineup.includes(m.id));
    const by = new Map();
    for (const r of mine) {
      const c = r.civs[m.id];
      const b = by.get(c) || { n: 0, w: 0 };
      b.n++;
      b.w += r.win;
      by.set(c, b);
    }
    return {
      oyuncu: m.name,
      takimMaci: mine.length,
      ulkeler: [...by.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 5).map(([c, b]) => ({ ulus: civName(c), mac: b.n, kazanma: pct(b.w, b.n) })),
    };
  });
  return {
    toplamTakimMaci: records.length,
    ikililer: pairs,
    uclu: trio && trio.mac ? trio : null,
    ulkeTercihleri: civPrefs,
    sonMac: records[0]?.startedAt || null,
  };
}

// ---- Alışkanlıklar: kayıt analizlerinden (maç sonu .rec) ----

// Her özellik: maç başına doğru/yanlış. kind: 'tarz' adayı (sonuca göre karar) ya da 'hata' (her zaman kötü).
const HABITS = [
  { key: 'erkenAsker', label: 'İlk askeri 7. dakikadan önce çıkarıyor (erken baskı)', kind: 'tarz', test: (r) => r.firstMilitaryAt != null && r.firstMilitaryAt < 7 * 60 },
  { key: 'gecAsker', label: 'İlk askeri 12. dakikadan sonra çıkarıyor (ekonomi önce)', kind: 'tarz', test: (r) => r.firstMilitaryAt == null || r.firstMilitaryAt > 12 * 60 },
  { key: 'hizliFeodal', label: "Feodal'e 5:00'ten önce geçiyor", kind: 'tarz', test: (r) => r.feudalAt != null && r.feudalAt < 5 * 60 },
  { key: 'hizliKale', label: "Kale Çağı'na 14:00'ten önce geçiyor (hızlı Kale)", kind: 'tarz', test: (r) => r.castleAt != null && r.castleAt < 14 * 60 },
  { key: 'buyukOrdu', label: 'Maç başına 60+ asker basıyor (savaşçı)', kind: 'tarz', test: (r) => r.militaryTotal >= 60 },
  { key: 'gecFeodal', label: "Feodal'e 7:00'den sonra geçiyor", kind: 'hata', test: (r) => r.feudalAt == null || r.feudalAt > 7 * 60 },
  { key: 'merkezBosta', label: 'Kasaba merkezi ilk 10 dakikada 2+ dakika boş kalıyor', kind: 'hata', test: (r) => r.tcIdleFirst10 != null && r.tcIdleFirst10 > 120 },
  { key: 'azEkoTeknoloji', label: 'En fazla 2 ekonomi teknolojisi alıyor', kind: 'hata', test: (r) => r.ecoTechs != null && r.ecoTechs <= 2 },
];

// Analiz edilmiş maçlardan üye başına satırlar. matches: store.matches; loadAnalysis(id) -> analiz
function habitRows(members, matches, loadAnalysis) {
  const rows = Object.fromEntries(members.map((m) => [m.id, []]));
  for (const match of matches) {
    if (!match.hasAnalysis) continue;
    const a = loadAnalysis(match.matchId);
    if (!a) continue;
    for (const m of members) {
      const lp = match.players.find((p) => p.profileId === m.id);
      if (!lp) continue;
      const r = a.report.players.find((p) => p.name === lp.name);
      if (!r) continue;
      const res = match.players.find((p) => p.profileId === m.id)?.result || (lp.team === match.myTeam ? match.result : null);
      rows[m.id].push({
        result: res === 'win' ? 'win' : res === 'loss' ? 'loss' : null,
        civ: r.civTr || lp.civCode,
        feudalAt: r.ageUps?.[2] ?? null,
        castleAt: r.ageUps?.[3] ?? null,
        tcIdleFirst10: r.villagers?.tcIdleFirst10 ?? null,
        firstMilitaryAt: r.military?.firstAt ?? null,
        militaryTotal: r.military?.total ?? 0,
        topUnits: (r.military?.composition || []).slice(0, 3).map((c) => c.name),
        ecoTechs: r.ecoTechs ? r.ecoTechs.length : null,
        apm: r.apm ?? null,
      });
    }
  }
  return rows;
}

// Bir alışkanlık sık tekrarlanıyorsa (%60+): galibiyetlerde de aynı sıklıkta görülüyorsa tarz,
// mağlubiyetlerde belirgin daha sıksa hata. 'hata' türündekiler (merkez boşta gibi) her zaman hata.
function classifyHabits(rows) {
  const n = rows.length;
  if (n < 3) return { mac: n, azVeri: true, aliskanliklar: [] };
  const wins = rows.filter((r) => r.result === 'win');
  const losses = rows.filter((r) => r.result === 'loss');
  const freq = (xs, h) => (xs.length ? xs.filter(h.test).length / xs.length : null);
  const out = [];
  for (const h of HABITS) {
    const all = freq(rows, h);
    if (all < 0.6) continue;
    const fw = freq(wins, h);
    const fl = freq(losses, h);
    let verdict;
    if (h.kind === 'hata') verdict = 'hata';
    else if (fw == null || fl == null) verdict = 'tarz (sonuç verisi az)';
    else verdict = fw >= fl - 0.15 ? 'tarz' : 'hata (kayıplarda daha sık)';
    out.push({ aliskanlik: h.label, siklik: `%${Math.round(all * 100)}`, galibiyetlerde: fw == null ? null : `%${Math.round(fw * 100)}`, maglubiyetlerde: fl == null ? null : `%${Math.round(fl * 100)}`, karar: verdict });
  }
  const units = new Map();
  for (const r of rows) for (const u of r.topUnits) units.set(u, (units.get(u) || 0) + 1);
  return {
    mac: n,
    azVeri: n < 5,
    aliskanliklar: out,
    enCokBastigiBirimler: [...units.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([u, c]) => `${u} (${c} maçta)`),
  };
}

function squadHabits(members, matches, loadAnalysis) {
  const rows = habitRows(members, matches, loadAnalysis);
  return members.map((m) => ({ oyuncu: m.name, ...classifyHabits(rows[m.id]) }));
}

module.exports = { squadGames, comboStats, squadReport, habitRows, classifyHabits, squadHabits, HABITS };
