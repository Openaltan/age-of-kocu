'use strict';

const civs = require('./civs');

const DEFAULT_VILLAGER_SEC = 20;
const TC_BUILD_SEC = 150;
const MIN_AGE_UP_SEC = 90;
const CHECKPOINTS_MIN = [5, 10, 15, 20];
const AGE_TR = { 2: 'Feodal', 3: 'Kale', 4: 'İmparatorluk' };

// Sık görülen birimlerin Türkçe adları; listede olmayanlar oyunun İngilizce adıyla kalır.
const UNIT_TR = {
  villager: 'Köylü', scout: 'Gözcü', spearman: 'Mızrakçı', archer: 'Okçu', horseman: 'Atlı',
  'man-at-arms': 'Ağır Piyade', knight: 'Şövalye', crossbowman: 'Arbaletçi', handcannoneer: 'Elle Topçu',
  mangonel: 'Mancınık', 'battering-ram': 'Koçbaşı', springald: 'Springald', trebuchet: 'Trebuchet',
  'bombard': 'Bombard', 'culverin': 'Kulverin', 'ribauldequin': 'Ribauldequin', 'monk': 'Keşiş',
  'horse-archer': 'Atlı Okçu', 'camel-archer': 'Deve Okçusu', 'camel-rider': 'Deve Süvarisi',
  'longbowman': 'Uzun Okçu', 'lancer': 'Mızraklı Süvari', 'trader': 'Tüccar', 'fishing-boat': 'Balıkçı Teknesi',
};

const ROLE_TR = { cavalry: 'atlı', ranged: 'menzilli', infantry: 'piyade', siege: 'kuşatma' };

function unitName(info) {
  return UNIT_TR[info.baseId] || info.name;
}

function mmss(sec) {
  if (sec == null) return '–';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Kasaba merkezi üretim kuyruğunu simüle eder: her köylü komutu bir iş, işler sırayla ve
// komut anından önce başlamadan işlenir. Yeni kasaba merkezleri yerleştirildikten
// TC_BUILD_SEC sonra paralel hat olarak eklenir. Dönen değerler tahmindir: iptaller ve
// yetişmeyen kaynak nedeniyle bekleyen kuyruklar kayıtta görünmez.
function simulateVillagers(villagerEvents, tcPlacements) {
  const lanes = [0]; // her hattın boşalacağı an
  const laneReadyAt = [0, ...tcPlacements.map((t) => t + TC_BUILD_SEC)].sort((a, b) => a - b);
  const done = [];
  let idleMain = 0;
  let idleMainFirst10 = 0;
  const secondTcAt = laneReadyAt[1] ?? Infinity;
  const addIdle = (from, to) => {
    if (to <= from) return;
    const end = Math.min(to, secondTcAt, 20 * 60);
    if (end > from) idleMain += end - from;
    const end10 = Math.min(to, secondTcAt, 10 * 60);
    if (end10 > from) idleMainFirst10 += end10 - from;
  };

  for (const ev of villagerEvents) {
    while (lanes.length < laneReadyAt.length && laneReadyAt[lanes.length] <= ev.t) lanes.push(laneReadyAt[lanes.length]);
    let best = 0;
    for (let i = 1; i < lanes.length; i++) if (Math.max(ev.t, lanes[i]) < Math.max(ev.t, lanes[best])) best = i;
    const start = Math.max(ev.t, lanes[best]);
    if (best === 0) addIdle(lanes[0], start);
    lanes[0 + best] = start + (ev.duration || DEFAULT_VILLAGER_SEC);
    done.push(lanes[best]);
  }
  // Son işten sonra merkez yine boş kaldıysa (20. dakikaya kadar) onu da say.
  addIdle(lanes[0], 20 * 60);
  return { doneTimes: done.sort((a, b) => a - b), idleFirst10: Math.round(idleMainFirst10), idleFirst20: Math.round(idleMain) };
}

function countBefore(times, sec) {
  let n = 0;
  for (const t of times) if (t <= sec) n += 1;
  return n;
}

function analyzePlayer(p, events, gamedata, durationSec, actions) {
  const mine = events.filter((e) => e.pid === p.pid && gamedata[e.pbgid]);
  const info = (e) => gamedata[e.pbgid];

  const ageUps = {};
  for (const e of mine) {
    const i = info(e);
    // Oyun başında kurulan özel yapılar (ör. Altın Orda çadırı) çağ atlama sayılmaz.
    const landmark = e.kind === 'building' && i.tags.includes('landmark') && e.t >= MIN_AGE_UP_SEC;
    const wing = e.kind === 'tech' && i.tags.includes('wing');
    if ((landmark || wing) && i.age) {
      const to = i.age + 1;
      if (to <= 4 && (ageUps[to] == null || e.t < ageUps[to])) ageUps[to] = e.t;
    }
  }

  const vilEvents = mine.filter((e) => e.kind === 'unit' && info(e).tags.includes('villager')).map((e) => ({ t: e.t, duration: info(e).time || DEFAULT_VILLAGER_SEC }));
  const tcPlacements = mine.filter((e) => e.kind === 'building' && info(e).tags.includes('town_center')).map((e) => e.t);
  const vil = simulateVillagers(vilEvents, tcPlacements);

  const militaryEvents = mine.filter((e) => e.kind === 'unit' && info(e).tags.includes('military'));
  const composition = new Map();
  const roles = { cavalry: 0, ranged: 0, infantry: 0, siege: 0, heavy: 0, anti_cavalry: 0, anti_armor: 0 };
  for (const e of militaryEvents) {
    const i = info(e);
    const key = i.baseId;
    const c = composition.get(key) || { baseId: key, name: unitName(i), count: 0, firstAt: e.t };
    c.count += 1;
    composition.set(key, c);
    for (const r of Object.keys(roles)) if (i.tags.includes(r)) roles[r] += 1;
  }
  const militaryTimes = militaryEvents.map((e) => e.t);

  const ecoTechs = mine.filter((e) => e.kind === 'tech' && info(e).tags.includes('eco_tech')).map((e) => ({ name: info(e).name, t: e.t }));
  const buildingCount = (tag) => mine.filter((e) => e.kind === 'building' && info(e).tags.includes(tag)).length;

  const atMin = (times) => Object.fromEntries(CHECKPOINTS_MIN.map((m) => [m, countBefore(times, m * 60)]));
  const series = (times) => Array.from({ length: Math.ceil(durationSec / 60) + 1 }, (_, m) => countBefore(times, m * 60));

  const civ = civs.fromLogCode(p.civCode);
  return {
    pid: p.pid,
    name: p.name,
    team: p.team,
    civCode: p.civCode,
    civTr: civ ? civ.tr : civs.trName(p.civCode),
    apm: Math.round(((actions[p.pid] || 0) / Math.max(1, durationSec)) * 60),
    ageUps,
    villagers: {
      commands: vilEvents.length,
      producedBy: atMin(vil.doneTimes),
      tcIdleFirst10: vil.idleFirst10,
      tcIdleFirst20: vil.idleFirst20,
      series: series(vil.doneTimes),
      doneTimes: vil.doneTimes,
    },
    military: {
      total: militaryEvents.length,
      firstAt: militaryTimes.length ? Math.min(...militaryTimes) : null,
      by: atMin(militaryTimes),
      series: series(militaryTimes),
      composition: [...composition.values()].sort((a, b) => b.count - a.count),
      roles,
    },
    buildings: {
      houses: buildingCount('house'),
      townCenters: tcPlacements.length,
      military: buildingCount('military_building'),
      firstMilitaryAt: mine.find((e) => e.kind === 'building' && info(e).tags.includes('military_building'))?.t ?? null,
    },
    ecoTechs,
  };
}

function analyzeReplay(parsed, gamedata) {
  const players = parsed.players.map((p) => analyzePlayer(p, parsed.events, gamedata, parsed.durationSec, parsed.actions));
  return { durationSec: parsed.durationSec, players };
}

function avg(xs) {
  const v = xs.filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function share(roles, key, total) {
  return total ? roles[key] / total : 0;
}

// Yerel oyuncu için eyleme dönük Türkçe bulgular. level: danger | chance | good | info
function coachFindings(report, me, { build } = {}) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  const enemies = report.players.filter((p) => p.team !== me.team);
  const allies = report.players.filter((p) => p.team === me.team && p.pid !== me.pid);

  // 1) Kasaba merkezi boşta
  const idle = me.villagers.tcIdleFirst10;
  if (idle >= 90) add('danger', `İlk 10 dakikada kasaba merkezin yaklaşık ${mmss(idle)} boşta kaldı. Bu, ~${Math.round(idle / DEFAULT_VILLAGER_SEC)} köylü demek. Kuyrukta hep 1-2 köylü tut.`);
  else if (idle >= 40) add('info', `İlk 10 dakikada kasaba merkezin yaklaşık ${mmss(idle)} boşta kaldı. Hedef 30 saniyenin altı.`);
  else add('good', `Köylü üretimin kesintisizdi (ilk 10 dakikada merkez boşta ~${mmss(idle)}).`);

  // 2) Köylü sayısı
  const v10 = me.villagers.producedBy[10];
  const bestEnemy10 = Math.max(0, ...enemies.map((p) => p.villagers.producedBy[10]));
  if (bestEnemy10 - v10 >= 6) {
    const who = enemies.find((p) => p.villagers.producedBy[10] === bestEnemy10);
    add('danger', `10. dakikaya kadar ${v10} köylü ürettin; ${who.name} ${bestEnemy10} üretti. Ekonomi farkı buradan açılıyor.`);
  }

  // 3) Feodal zamanı
  const myFeudal = me.ageUps[2];
  const enemyFeudal = avg(enemies.map((p) => p.ageUps[2]));
  if (myFeudal == null) {
    add('danger', 'Kayıtta Feodal çağa geçiş görünmüyor.');
  } else if (enemyFeudal != null) {
    const diff = myFeudal - enemyFeudal;
    if (diff >= 60) add('danger', `Feodal landmark'ı: sen ${mmss(myFeudal)}, rakip ortalaması ${mmss(enemyFeudal)}. ${mmss(diff)} geridesin.`);
    else if (diff <= -30) add('good', `Feodal'e rakiplerden hızlı çıktın (${mmss(myFeudal)}, rakip ort. ${mmss(enemyFeudal)}).`);
    else add('info', `Feodal landmark: ${mmss(myFeudal)} (rakip ort. ${mmss(enemyFeudal)}).`);
  }
  const myCastle = me.ageUps[3];
  const enemyCastle = avg(enemies.map((p) => p.ageUps[3]));
  if (myCastle != null && enemyCastle != null && myCastle - enemyCastle >= 120) {
    add('danger', `Kale çağı landmark'ı: sen ${mmss(myCastle)}, rakip ortalaması ${mmss(enemyCastle)}. Kale çağındaki güç farkı burada oluşuyor.`);
  }

  // 4) İlk asker / erken baskı
  const firstEnemyMil = enemies.filter((p) => p.military.firstAt != null).sort((a, b) => a.military.firstAt - b.military.firstAt)[0];
  if (firstEnemyMil && (me.military.firstAt == null || me.military.firstAt - firstEnemyMil.military.firstAt >= 120)) {
    add('danger', `İlk asker: ${firstEnemyMil.name} ${mmss(firstEnemyMil.military.firstAt)}, sen ${mmss(me.military.firstAt)}. Erken baskıya karşı birkaç mızrakçı/okçu ya da kule hazır olsun.`);
  }

  // 5) Ekonomi teknolojileri
  const earlyEco = me.ecoTechs.filter((t) => t.t <= 12 * 60);
  if (!me.ecoTechs.length) add('danger', 'Maç boyunca hiç ekonomi teknolojisi (çift balta, bahçecilik, uzman kazma, el arabası…) almadın. Her biri toplama hızını %15 civarı artırır.');
  else if (!earlyEco.length) add('info', `İlk ekonomi teknolojin geç geldi (${mmss(me.ecoTechs[0].t)}). Feodal'e çıkar çıkmaz ilk ikisini al.`);

  // 6) Ordu büyüklüğü
  const enemyArmy15 = avg(enemies.map((p) => p.military.by[15]));
  if (report.durationSec >= 15 * 60 && enemyArmy15 >= 10 && me.military.by[15] < enemyArmy15 * 0.5) {
    add('danger', `15. dakikada ${me.military.by[15]} asker üretmiştin; rakiplerin ortalaması ${Math.round(enemyArmy15)}.`);
  }

  // 7) Kontra kontrolü: rakip takımın ordu karışımına göre
  const enemyRoles = { cavalry: 0, ranged: 0, infantry: 0, siege: 0, heavy: 0 };
  let enemyMil = 0;
  for (const p of enemies) {
    enemyMil += p.military.total;
    for (const k of Object.keys(enemyRoles)) enemyRoles[k] += p.military.roles[k];
  }
  const myMil = me.military.total;
  if (enemyMil >= 20 && myMil >= 10) {
    if (share(enemyRoles, 'cavalry', enemyMil) >= 0.35 && share(me.military.roles, 'anti_cavalry', myMil) < 0.15) {
      add('danger', `Rakip orduda atlı oranı %${Math.round(share(enemyRoles, 'cavalry', enemyMil) * 100)}, senin ordunda mızrakçı oranı %${Math.round(share(me.military.roles, 'anti_cavalry', myMil) * 100)}. Atlıya karşı mızrakçı/pikeman bas.`);
    }
    if (share(enemyRoles, 'heavy', enemyMil) >= 0.3 && share(me.military.roles, 'anti_armor', myMil) < 0.15) {
      add('danger', `Rakip ağırlıklı zırhlı birim (ağır piyade/şövalye) bastı; sende arbaletçi/elle topçu oranı düşük. Zırha karşı arbaletçi ekle.`);
    }
    if (share(enemyRoles, 'ranged', enemyMil) >= 0.45 && (me.military.roles.cavalry + me.military.roles.siege) / myMil < 0.2) {
      add('danger', `Rakip ordusunun yarısına yakını menzilliydi. Okçu kalabalığına atlı ya da mancınıkla cevap ver.`);
    }
  }

  // 8) Build order karşılaştırması: build'de süresi ve köylü hedefi yazılı adımlar
  if (build && build.steps) {
    const startVils = build.steps.find((s) => s.villagers)?.villagers || 6;
    const checks = build.steps.filter((s) => s.time && s.villagers && s.time <= 10 * 60);
    const worst = checks
      .map((s) => ({ s, have: startVils + countBefore(me.villagers.doneTimes, s.time) }))
      .sort((a, b) => (a.have - a.s.villagers) - (b.have - b.s.villagers))[0];
    if (worst && worst.s.villagers - worst.have >= 3) {
      add('info', `Build hedefi ${mmss(worst.s.time)} itibarıyla ${worst.s.villagers} köylü; sende yaklaşık ${worst.have} vardı ("${build.name}").`);
    }
  }

  // 9) Takımdaki yerin
  const team = [me, ...allies];
  const fastest = team.filter((p) => p.ageUps[2] != null).sort((a, b) => a.ageUps[2] - b.ageUps[2])[0];
  if (allies.length && fastest === me && myFeudal != null) add('good', 'Takımda Feodal\'e ilk çıkan sendin.');

  const order = { danger: 0, info: 1, chance: 1, good: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

// Profil sayfasındaki eğilim için maç başına tek satırlık özet.
function summaryFor(me) {
  return {
    feudalAt: me.ageUps[2] ?? null,
    castleAt: me.ageUps[3] ?? null,
    tcIdleFirst10: me.villagers.tcIdleFirst10,
    villagersAt10: me.villagers.producedBy[10],
    firstMilitaryAt: me.military.firstAt,
    apm: me.apm,
  };
}

module.exports = { analyzeReplay, coachFindings, summaryFor, simulateVillagers, AGE_TR, ROLE_TR, mmss };
