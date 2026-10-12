'use strict';

// YZ koça gönderilecek bağlamı hazırlayan saf fonksiyonlar. Sadece halka açık geçmiş,
// oyuncunun kendi ekranı/HUD'u ve biten maçların kayıtları kullanılır.

const { mmss, teamContribution } = require('./analysis');
const { noteText, AGE_NAMES } = require('./baseLedger');

// Rakip defteri: bu oyuncularla daha önce oynanan maçlar ve (analiz varsa) o maçtaki oyunları.
// matches: store.matches, loadAnalysis(matchId) -> analiz ya da null
function opponentHistory(profileIds, matches, loadAnalysis, limit = 5) {
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

// Bize karşı oynadığı maçlarda en çok bastığı birimler (rakip defterindeki "Ad xN" satırlarından).
function armyTendency(history) {
  const total = new Map();
  for (const h of history || []) {
    for (const line of h.ordu || []) {
      const m = /^(.*) x(\d+)$/.exec(line);
      if (m) total.set(m[1], (total.get(m[1]) || 0) + Number(m[2]));
    }
  }
  return [...total.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, n]) => `${name} x${n}`);
}

function compactCard(c, history) {
  const s = c.stats;
  const army = armyTendency(history);
  return {
    oyuncu: c.name,
    ulke: c.civTr,
    reyting: c.rating ? `${c.rating.rating}${c.rating.rankLevel ? ` (${c.rating.rankLevel})` : ''}` : null,
    ...(s ? {
      sonMaclar: s.games,
      kazanmaYuzdesi: s.winRate,
      favoriUlkeler: s.topCivs.map((t) => `${t.tr} ${t.games} maç %${t.winRate}`),
      buUlkeyle: c.civSlug && s.byCiv[c.civSlug] ? `${s.byCiv[c.civSlug].games} maç %${s.byCiv[c.civSlug].winRate}` : 'bu ülkeyle neredeyse hiç oynamamış',
      onbesDkAltiKazanma: s.short.winRate,
      otuzDkUstuKazanma: s.long.winRate,
      erkenGalibiyetPayi: s.shortWinShare,
      ortalamaKazanmaDk: s.avgWinMin,
      ortalamaKaybetmeDk: s.avgLossMin,
      form: s.form,
      kontrolcu: s.controller,
    } : {}),
    notlar: c.insights.map((i) => i.text),
    ...(history ? { gecmisKarsilasmalar: history } : {}),
    ...(army.length ? { bizeKarsiAgirlikliOrdu: army } : {}),
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
    sezon: b.season || null,
    // Bazı build'ler belirli bir harita için yazılmıştır.
    harita: b.map || null,
    acilis: b.steps.slice(0, 6).flatMap((s) => s.notes.map(noteText)).join(' / ').slice(0, 400),
  }));
}

function prematchContext({ scouting, myCiv, build, candidates = null, specials = null, intel = null, squad = null, matches, loadAnalysis, mapName, localName }) {
  const enemyIds = scouting.enemies.map((c) => c.profileId);
  const hist = opponentHistory(enemyIds, matches, loadAnalysis);
  return {
    harita: mapName || 'bilinmiyor',
    mod: scouting.kind,
    benimUlkem: myCiv?.tr || null,
    // Otomatik build: koç bu listeden rakiplere göre seçer; benimBuild şimdilik en yüksek puanlı.
    ...(candidates ? { buildSecenekleri: buildCandidates(candidates) } : {}),
    // Serbest: koç özel build yazar; ülkenin özel birim/teknoloji/simge yapıları doğru isimlerle.
    ...(specials ? { ulkeyeOzel: specials } : {}),
    // Harita ve güncel meta (AoE4World istatistikleri) + internetten araştırma özeti.
    ...(intel?.meta ? { haritaVeMeta: intel.meta } : {}),
    ...(intel?.research ? { internettenArastirma: intel.research.text } : {}),
    // Ekibimiz: bu maçtaki ikili/üçlü istatistiklerimiz ve alışkanlıklarımız (tarz/hata).
    ...(squad ? { takimimiz: squad } : {}),
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

function liveContext({ elapsedSec, hud, buildView, myCiv, plan, lastAssessment, scouting, team = [], combat = false, trigger = null, events = [], mapSightings = [], ledger = null, specials = null, myColor = null, localName = null, intel = null }) {
  const steps = buildView ? buildView.upcoming || [] : [];
  return {
    mod: combat ? 'savaş' : 'normal',
    haritaVeMeta: intel,
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
    macOncesiPlan: plan ? {
      ozet: plan.ozet,
      tahminler: plan.rakipTahminleri,
      kontra: plan.kontraOnerisi,
      // Serbest modda koçun yazdığı oyun stili ve zamanlama hedefleri: maç boyu buna sadık kal.
      ...(plan.ozelBuild?.oyunStili ? { ozelOyunStili: plan.ozelBuild.oyunStili, kilitNoktalar: plan.ozelBuild.kilitNoktalar } : {}),
    } : null,
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
    // Takıma katkı: her takım arkadaşının ekonomi/ordu payı, rolü, rakibe karşı kontra uyumu ve eksikleri.
    takimaKatki: teamContribution(report, analysis.localPid),
    benimGelisimim: myTrend(matches.filter((m) => m.matchId !== match?.matchId)),
    macOncesiTahminler: plan ? plan.rakipTahminleri : null,
  };
}

// Gelişim analizi: benim maçlarım (kayıt analizleriyle), halka açık geçmişim, takım arkadaşlarım ve meta.
// me/mates: scout kartları; civRows: AoE4World ülke istatistikleri; civName(code) -> Türkçe ad.
function reviewContext({ matches, loadAnalysis, localProfileId, me, mates = [], civRows = [], civName = (c) => c }) {
  const mine = (m) => m.players.find((p) => p.profileId === localProfileId) || null;
  const result = (m) => (m.result === 'win' ? 'galibiyet' : m.result === 'loss' ? 'mağlubiyet' : null);
  const detailed = matches.filter((m) => m.hasAnalysis).slice(0, 12).map((m) => {
    const a = loadAnalysis(m.matchId);
    const r = a?.report.players.find((p) => p.pid === a.localPid);
    return {
      harita: m.map || null,
      sonuc: result(m),
      ulke: mine(m) ? civName(mine(m).civCode) : null,
      sure: m.durationSec ? mmss(m.durationSec) : null,
      ...(r ? {
        feodal: mmss(r.ageUps[2]),
        kale: mmss(r.ageUps[3]),
        merkezBostaIlk10: mmss(r.villagers.tcIdleFirst10),
        ilkAsker: mmss(r.military.firstAt),
        toplamAsker: r.military.total,
        ordu: r.military.composition.slice(0, 5).map((c) => `${c.name} x${c.count}`),
        ekoTeknoloji: r.ecoTechs.length,
        apm: r.apm,
      } : {}),
      koylu10dk: m.analysisSummary?.villagersAt10 ?? null,
      tespitler: (a?.findings || []).slice(0, 5).map((f) => f.text),
    };
  });
  const all = matches.slice(0, 40).map((m) => ({
    sonuc: result(m),
    ulke: mine(m) ? civName(mine(m).civCode) : null,
    harita: m.map || null,
    dk: m.durationSec ? Math.round(m.durationSec / 60) : null,
  }));
  return {
    ben: me ? compactCard(me) : null,
    kayitAnalizliMaclarim: detailed,
    uygulamadakiSonMaclarim: all,
    takimArkadaslarim: mates.map((c) => compactCard(c)),
    guncelMetaTakimOyunu: [...civRows].sort((a, b) => b.win_rate - a.win_rate).map((r) => `${civName(r.civilization)} %${Math.round(r.win_rate * 10) / 10} (seçilme %${Math.round(r.pick_rate * 10) / 10})`),
  };
}

// YZ uyarısını overlay notuna çevirir: tahmin, olmuş bir saldırı gibi görünmesin.
// Dönen: { level, text, share } ya da null. share: takım arkadaşlarına iletilsin mi (sadece gerçek olay).
function warningNote(res) {
  const text = String(res?.uyari || '').trim();
  const kind = res?.uyariTuru || 'tahmin';
  if (!text || kind === 'yok') return null;
  if (kind === 'gercek') return { level: res.risk === 'düşük' ? 'info' : 'danger', text, share: true };
  if (kind === 'eksik') return { level: 'info', text, share: false };
  const hedged = /gelebilir|olası|muhtemel|bekle|hazır ol/i.test(text) ? text : `Olası: ${text}`;
  return { level: 'info', text: hedged, share: false };
}

module.exports = { opponentHistory, prematchContext, liveContext, postgameContext, reviewContext, myTrend, civSpecials, buildCandidates, warningNote };
