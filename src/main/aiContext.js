'use strict';

// YZ koça gönderilecek bağlamı hazırlayan saf fonksiyonlar. Sadece halka açık geçmiş,
// oyuncunun kendi ekranı/HUD'u ve biten maçların kayıtları kullanılır.

const { mmss } = require('./analysis');
const { noteText, AGE_NAMES } = require('./baseLedger');

// Rakip defteri: bu oyuncularla daha önce oynanan maçlar ve (analiz varsa) o maçtaki oyunları.
// matches: store.matches, loadAnalysis(matchId) -> analiz ya da null
function opponentHistory(profileIds, matches, loadAnalysis, limit = 3) {
  const out = {};
  for (const id of profileIds) {
    if (!id) continue;
    const past = matches.filter((m) => m.players.some((p) => p.profileId === id && p.team !== m.myTeam)).slice(0, limit);
    if (!past.length) continue;
    out[id] = past.map((m) => {
      const p = m.players.find((x) => x.profileId === id);
      const a = m.hasAnalysis ? loadAnalysis(m.matchId) : null;
      const r = a?.report.players.find((x) => x.name === p.name);
      return {
        tarih: m.playedAt ? new Date(m.playedAt).toISOString().slice(0, 10) : null,
        harita: m.map || null,
        bizimSonuc: m.result === 'win' ? 'kazandık' : m.result === 'loss' ? 'kaybettik' : null,
        ulke: p.civCode,
        ...(r ? {
          feodal: mmss(r.ageUps[2]),
          kale: mmss(r.ageUps[3]),
          ilkAsker: mmss(r.military.firstAt),
          ordu: r.military.composition.slice(0, 4).map((c) => `${c.name} x${c.count}`),
        } : {}),
      };
    });
  }
  return out;
}

function compactCard(c, history) {
  const s = c.stats;
  return {
    oyuncu: c.name,
    ulke: c.civTr,
    reyting: c.rating ? `${c.rating.rating}${c.rating.rankLevel ? ` (${c.rating.rankLevel})` : ''}` : null,
    ...(s ? {
      sonMaclar: s.games,
      kazanmaYuzdesi: s.winRate,
      favoriUlkeler: s.topCivs.map((t) => `${t.tr} ${t.games} maç %${t.winRate}`),
      onbesDkAltiKazanma: s.short.winRate,
      otuzDkUstuKazanma: s.long.winRate,
      erkenGalibiyetPayi: s.shortWinShare,
      form: s.form,
      kontrolcu: s.controller,
    } : {}),
    notlar: c.insights.map((i) => i.text),
    ...(history ? { gecmisKarsilasmalar: history } : {}),
  };
}

function myTrend(matches, limit = 8) {
  return matches.filter((m) => m.analysisSummary).slice(0, limit).map((m) => ({
    sonuc: m.result,
    feodal: mmss(m.analysisSummary.feudalAt),
    merkezBostaIlk10: mmss(m.analysisSummary.tcIdleFirst10),
    koylu10dk: m.analysisSummary.villagersAt10,
    ilkAsker: mmss(m.analysisSummary.firstMilitaryAt),
    apm: m.analysisSummary.apm,
  }));
}

function buildOutline(build) {
  if (!build) return null;
  return {
    ad: build.name,
    strateji: build.strategy || null,
    adimlar: build.steps.slice(0, 12).map((s) => ({
      sure: s.time != null ? mmss(s.time) : null,
      koylu: s.villagers,
      dagilim: { yemek: s.food, odun: s.wood, altin: s.gold, tas: s.stone, insaat: s.builder },
      notlar: s.notes.map(noteText),
    })),
  };
}

// Otomatik build seçimi için aday build'lerin kısa özeti: ilk adımların notları açılışı anlatır.
function buildCandidates(builds) {
  return builds.map((b) => ({
    id: b.id,
    ad: b.name,
    strateji: b.strategy || null,
    acilis: b.steps.slice(0, 6).flatMap((s) => s.notes.map(noteText)).join(' / ').slice(0, 400),
  }));
}

function prematchContext({ scouting, myCiv, build, candidates = null, matches, loadAnalysis, mapName, localName }) {
  const enemyIds = scouting.enemies.map((c) => c.profileId);
  const hist = opponentHistory(enemyIds, matches, loadAnalysis);
  return {
    harita: mapName || 'bilinmiyor',
    mod: scouting.kind,
    benimUlkem: myCiv?.tr || null,
    // Otomatik build: koç bu listeden rakiplere göre seçer; benimBuild şimdilik en yüksek puanlı.
    ...(candidates ? { buildSecenekleri: buildCandidates(candidates) } : {}),
    benimBuild: buildOutline(build),
    takimim: scouting.allies.map((c) => compactCard(c)),
    rakipler: scouting.enemies.map((c) => compactCard(c, hist[c.profileId])),
    benimGelisimim: myTrend(matches),
    ben: localName || null,
  };
}

// Ülkeye özel (en fazla 3 ülkenin paylaştığı) birim, teknoloji ve binalar; şimdiki ve sonraki çağ.
// gamedata.json ortak birim/teknolojilerde eksik olduğundan sadece ülkeye özgü olanlar verilir.
function civSpecials(gamedata, civCode, age = 1) {
  if (!gamedata || !civCode) return null;
  const seen = new Map();
  for (const e of Object.values(gamedata)) {
    if (!e.civs.includes(civCode) || e.civs.length > 3 || e.age > Math.min(4, age + 1)) continue;
    const prev = seen.get(e.baseId);
    if (!prev || e.age < prev.age) seen.set(e.baseId, e);
  }
  const pick = (kinds) => [...seen.values()].filter((e) => kinds.includes(e.kind) && !e.tags.includes('landmark')).sort((a, b) => a.age - b.age).map((e) => `${e.name} (${e.age})`);
  // Simge yapılar çağdan bağımsız hepsi: N. çağda kurulan simge N+1. çağa geçirir.
  const landmarks = Object.values(gamedata).filter((e) => e.civs.includes(civCode) && e.tags.includes('landmark') && e.age < 4)
    .sort((a, b) => a.age - b.age).map((e) => `${e.name} → ${AGE_NAMES[e.age + 1]}`);
  return { birimler: pick(['unit']), teknolojiler: pick(['technology', 'upgrade']), binalar: pick(['building']), simgeYapilar: [...new Set(landmarks)] };
}

function liveContext({ elapsedSec, hud, buildView, myCiv, plan, lastAssessment, scouting, team = [], combat = false, trigger = null, events = [], mapSightings = [], ledger = null, specials = null, myColor = null, localName = null }) {
  const steps = buildView ? buildView.upcoming || [] : [];
  return {
    mod: combat ? 'savaş' : 'normal',
    tetik: trigger,
    ben: localName,
    renkim: myColor,
    olaylar: events,
    haritadaGorulenler: mapSightings,
    usDefteri: ledger,
    ulkeyeOzel: specials,
    takimArkadaslarim: team.map((m) => ({ oyuncu: m.name, ulke: m.status?.civ ?? null, koylu: m.status?.villagers ?? null, nufus: m.status?.pop ?? null, risk: m.status?.risk ?? null })),
    oyunSuresi: mmss(elapsedSec),
    benimUlkem: myCiv?.tr || null,
    ekrandanOkunan: hud ? {
      kaynaklar: { yemek: hud.res.food, odun: hud.res.wood, altin: hud.res.gold, tas: hud.res.stone },
      koyluDagilimi: { yemek: hud.vil.food, odun: hud.vil.wood, altin: hud.vil.gold, tas: hud.vil.stone },
      toplamKoylu: hud.villagers,
      nufus: hud.pop ? `${hud.pop.cur}/${hud.pop.cap}` : null,
      bostaKoylu: hud.idle,
    } : 'ekran okuma kapalı',
    buildAdimi: buildView ? {
      build: buildView.name,
      adim: `${buildView.index + 1}/${buildView.total}`,
      hedefKoylu: buildView.step.villagers,
      hedefDagilim: { yemek: buildView.step.food, odun: buildView.step.wood, altin: buildView.step.gold, tas: buildView.step.stone },
      notlar: buildView.step.notes.map(noteText),
      sonrakiAdimlar: steps.map((s) => ({ koylu: s.villagers, notlar: s.notes.map(noteText) })),
      buildBitti: !buildView.next,
    } : null,
    rakipler: scouting ? scouting.enemies.map((c) => ({ oyuncu: c.name, ulke: c.civTr, notlar: c.insights.slice(0, 3).map((i) => i.text) })) : [],
    macOncesiPlan: plan ? { ozet: plan.ozet, tahminler: plan.rakipTahminleri, kontra: plan.kontraOnerisi } : null,
    oncekiDegerlendirme: lastAssessment ? { sure: lastAssessment.at, durum: lastAssessment.durum, simdiYap: lastAssessment.simdiYap, uret: lastAssessment.uret, gelistir: lastAssessment.gelistir } : null,
  };
}

function postgameContext({ analysis, match, matches, plan }) {
  const { report } = analysis;
  const me = report.players.find((p) => p.pid === analysis.localPid);
  const row = (p) => ({
    oyuncu: p.name,
    takim: me ? (p.team === me.team ? 'biz' : 'rakip') : p.team,
    ulke: p.civTr,
    feodal: mmss(p.ageUps[2]),
    kale: mmss(p.ageUps[3]),
    imparatorluk: mmss(p.ageUps[4]),
    merkezBostaIlk10: mmss(p.villagers.tcIdleFirst10),
    koylu: p.villagers.producedBy,
    ilkAsker: mmss(p.military.firstAt),
    asker: p.military.by,
    toplamAsker: p.military.total,
    ordu: p.military.composition.slice(0, 5).map((c) => `${c.name} x${c.count}`),
    ekoTeknoloji: p.ecoTechs.length,
    apm: p.apm,
  });
  return {
    sonuc: match?.result || null,
    sure: mmss(report.durationSec),
    harita: match?.map || null,
    ben: me?.name || null,
    build: analysis.buildName,
    oyuncular: report.players.map(row),
    otomatikTespitler: analysis.findings.map((f) => f.text),
    benimGelisimim: myTrend(matches.filter((m) => m.matchId !== match?.matchId)),
    macOncesiTahminler: plan ? plan.rakipTahminleri : null,
  };
}

module.exports = { opponentHistory, prematchContext, liveContext, postgameContext, myTrend, civSpecials, buildCandidates };
