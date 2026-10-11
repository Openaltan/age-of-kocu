'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { LiveMonitor } = require('../src/main/liveEvents');
const { BaseLedger, noteText, buildExpectations } = require('../src/main/baseLedger');
const { civSpecials, liveContext } = require('../src/main/aiContext');
const gamedata = require('../src/main/data/gamedata.json');

const hud = (pop, villagers = 20) => ({ pop: { cur: pop, cap: 60 }, villagers });

test('nüfus hızla düşünce kayıp olayı ve savaş modu; 60 sn sakinlikten sonra çıkar', () => {
  const m = new LiveMonitor();
  assert.deepStrictEqual(m.observe({ t: 100, hud: hud(34) }).fresh, []);
  m.observe({ t: 105, hud: hud(32) });
  const r = m.observe({ t: 110, hud: hud(29) });
  assert.deepStrictEqual(r.fresh.map((e) => e.text), ['Kayıp veriyorsun (−5 nüfus)']);
  assert.strictEqual(r.combatStarted, true);
  assert.strictEqual(m.combat, true);
  // Yeni üretim (artış) kayıp sayılmaz; pencere geçince olay biter ama savaş modu 60 sn sürer.
  for (let t = 111; t < 170; t += 5) assert.strictEqual(m.observe({ t, hud: hud(29) }).combatEnded, false);
  const end = m.observe({ t: 171, hud: hud(30) });
  assert.strictEqual(end.combatEnded, true);
  assert.strictEqual(m.combat, false);
});

test('mini harita olayları not olur, 20 sn sonra düşer; günlükte kalır', () => {
  const m = new LiveMonitor();
  const ev = { key: 'base', kind: 'base', level: 'danger', text: 'Üssünde düşman · batı tarafı' };
  const r = m.observe({ t: 50, mapEvents: [ev] });
  assert.strictEqual(r.fresh.length, 1);
  assert.strictEqual(r.combatStarted, true);
  assert.deepStrictEqual(m.notes(), [{ key: 'ev-map-base', level: 'danger', text: 'Üssünde düşman · batı tarafı' }]);
  assert.strictEqual(m.observe({ t: 51, mapEvents: [ev] }).fresh.length, 0); // sürüyor, yeni değil
  m.observe({ t: 75 });
  assert.deepStrictEqual(m.notes(), []);
  assert.deepStrictEqual(m.recent(80), [{ saniyeOnce: 30, olay: 'Üssünde düşman · batı tarafı' }]);
});

test('oyuncu listesinde satır 3 kare boyunca uzarsa çağ değişimi sayılır', () => {
  const m = new LiveMonitor();
  const rows = (w) => [{ width: 300 }, { width: w }];
  assert.deepStrictEqual(m.observe({ t: 1, rows: rows(150) }).rowsChanged, []);
  assert.deepStrictEqual(m.observe({ t: 2, rows: rows(158) }).rowsChanged, []);
  assert.deepStrictEqual(m.observe({ t: 3, rows: rows(158) }).rowsChanged, []);
  assert.deepStrictEqual(m.observe({ t: 4, rows: rows(158) }).rowsChanged, [1]);
  assert.deepStrictEqual(m.observe({ t: 5, rows: rows(158) }).rowsChanged, []);
  // Tek karelik sapma sayılmaz.
  m.observe({ t: 6, rows: rows(170) });
  assert.deepStrictEqual(m.observe({ t: 7, rows: rows(158) }).rowsChanged, []);
});

const build = {
  steps: [
    { notes: ['@abilities/repair.webp@@building_economy/mill.webp@ and 5 on @resource/sheep.webp@'] },
    { notes: ['@age/age_2.webp@ Feodal Çağ\'a geçince @abilities/repair.webp@@building_military/archery-range.webp@ kur; @technology_economy/wheelbarrow.webp@ al &gt; hızlı'] },
    { notes: ['@building_military/stable.webp@'] },
  ],
};

test('build notları YZ için düz metne çevrilir ve geçilen adımlardan beklenen binalar çıkar', () => {
  assert.strictEqual(noteText(build.steps[1].notes[0]), '[Feodal Çağı] Feodal Çağ\'a geçince [repair][archery range] kur; [wheelbarrow] al > hızlı');
  assert.deepStrictEqual(buildExpectations(build, 1), { buildings: ['mill', 'archery range'], techs: ['wheelbarrow'], age: 2 });
  assert.deepStrictEqual(buildExpectations(build, 0).buildings, ['mill']);
});

test('üs defteri: sadece kendi üssündeyken görülenler birikir, görülmeyen silinmez', () => {
  const l = new BaseLedger();
  l.observe({ ekranKimin: 'benim', cag: 2, binalar: ['Okçu atölyesi'], gelistirmeler: [], ordu: ['6 okçu'] }, '9:10');
  l.observe({ ekranKimin: 'takim', cag: 2, binalar: ['Ahır'], gelistirmeler: ['Erken Koşum'], ordu: ['20 şövalye'] }, '10:00');
  l.observe({ ekranKimin: 'benim', cag: 0, binalar: ['Kışla'], gelistirmeler: [], ordu: [] }, '11:00');
  const c = l.context(build, 1);
  assert.strictEqual(c.cag, 'Feodal Çağı');
  assert.deepStrictEqual(c.gorulenBinalar, ['Okçu atölyesi (9:10)', 'Kışla (11:00)']);
  assert.deepStrictEqual(c.alinanGelistirmeler, []);
  assert.deepStrictEqual(c.sonGorulenOrdu, { sure: '9:10', birimler: ['6 okçu'] });
  assert.deepStrictEqual(c.builddenYapilmisOlmali, ['mill', 'archery range']);
});

test('ülkeye özel birimler gamedata\'dan çağa göre gelir', () => {
  const s = civSpecials(gamedata, 'zx', 1);
  assert.ok(s.birimler.includes('Zhuge Nu (2)'));
  assert.ok(!s.birimler.some((n) => /\(4\)$/.test(n))); // sadece şimdiki ve sonraki çağ
  assert.strictEqual(civSpecials(gamedata, null), null);
});

test('canlı bağlam build notlarını, sıradaki adımları ve olayları içerir', () => {
  const step = { villagers: 16, food: 4, wood: 8, gold: 4, stone: 0, notes: build.steps[1].notes };
  const c = liveContext({
    elapsedSec: 400,
    hud: null,
    buildView: { name: 'b', index: 1, total: 3, step, next: build.steps[2], upcoming: [{ villagers: 18, notes: build.steps[2].notes }] },
    combat: true,
    trigger: 'Üssünde düşman',
    events: [{ saniyeOnce: 3, olay: 'Üssünde düşman' }],
  });
  assert.strictEqual(c.mod, 'savaş');
  assert.strictEqual(c.buildAdimi.notlar[0], noteText(step.notes[0]));
  assert.deepStrictEqual(c.buildAdimi.sonrakiAdimlar, [{ koylu: 18, notlar: ['[stable]'] }]);
  assert.strictEqual(c.buildAdimi.buildBitti, false);
  assert.deepStrictEqual(c.olaylar, [{ saniyeOnce: 3, olay: 'Üssünde düşman' }]);
});

test('simge yapılar hangi çağa geçirdiğiyle listelenir', () => {
  const s = civSpecials(gamedata, 'zx', 1);
  assert.ok(s.simgeYapilar.includes('Jiangnan Tower → Feodal'));
  assert.ok(s.simgeYapilar.includes('Mount Lu Academy → Kale'));
  assert.ok(!s.binalar.some((b) => b.startsWith('Jiangnan Tower')));
});

test('otomatik build için aday özetleri maç öncesi bağlama girer', () => {
  const { prematchContext } = require('../src/main/aiContext');
  const scouting = { kind: 'rm_3v3', allies: [], enemies: [] };
  const c = prematchContext({ scouting, build: null, candidates: [{ id: 'x', name: 'Tower Rush', strategy: 'Rush', steps: build.steps }], matches: [], loadAnalysis: () => null });
  assert.deepStrictEqual(c.buildSecenekleri[0].id, 'x');
  assert.match(c.buildSecenekleri[0].acilis, /\[archery range\]/);
  assert.strictEqual(prematchContext({ scouting, build: null, matches: [], loadAnalysis: () => null }).buildSecenekleri, undefined);
});

test('rakip kartı: bu ülkeyle tecrübe, ortalama süreler ve bize karşı ağırlıklı ordu', () => {
  const { prematchContext } = require('../src/main/aiContext');
  const enemy = {
    profileId: 9, name: 'KEYI', civTr: 'Fransızlar', civSlug: 'french', rating: null, insights: [],
    stats: { games: 40, winRate: 55, topCivs: [], byCiv: { french: { games: 12, winRate: 66 } }, short: { winRate: 70 }, long: { winRate: 30 }, shortWinShare: 50, avgWinMin: 14, avgLossMin: 27, form: 'GGM', controller: false },
  };
  const matches = [1, 2].map((id) => ({ matchId: id, myTeam: 0, hasAnalysis: true, players: [{ name: 'KEYI', profileId: 9, team: 1, civCode: 'french' }] }));
  const analysis = (id) => ({ report: { players: [{ name: 'KEYI', ageUps: {}, military: { firstAt: 300, composition: id === 1 ? [{ name: 'Atlı', count: 12 }, { name: 'Okçu', count: 4 }] : [{ name: 'Atlı', count: 8 }] } }] } });
  const c = prematchContext({ scouting: { kind: 'rm_2v2', allies: [], enemies: [enemy] }, build: null, matches, loadAnalysis: analysis });
  const r = c.rakipler[0];
  assert.strictEqual(r.buUlkeyle, '12 maç %66');
  assert.strictEqual(r.ortalamaKazanmaDk, 14);
  assert.deepStrictEqual(r.bizeKarsiAgirlikliOrdu, ['Atlı x20', 'Okçu x4']);
  assert.strictEqual(r.gecmisKarsilasmalar.length, 2);
});
