'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { resolveMap, metaSummary, metaBrief } = require('../src/main/meta');
const { reviewContext } = require('../src/main/aiContext');

const mapList = [
  { map_id: 1, map: 'Dry Arabia', games_count: 1000, duration_median: 1597, highest_win_rate_civilization: 'french' },
  { map_id: 2, map: 'Flankwoods', games_count: 500, duration_median: 1800, highest_win_rate_civilization: 'english' },
];

test('harita adı: öğrenilmiş Türkçe ad, birebir ve harf duyarsız eşleşme', () => {
  assert.deepStrictEqual(resolveMap('Saklı Ormanlar', { 'Saklı Ormanlar': 'Flankwoods' }, mapList).id, 2);
  assert.strictEqual(resolveMap('dry arabia', {}, mapList).en, 'Dry Arabia');
  assert.deepStrictEqual(resolveMap('Dere Tepe', {}, mapList), { local: 'Dere Tepe', en: null, id: null, stats: null });
  assert.strictEqual(resolveMap(null, {}, mapList), null);
});

test('meta özeti: haritada en iyiler, benim ve rakip ülkelerin oranları', () => {
  const civRows = [
    { civilization: 'french', win_rate: 53.49, pick_rate: 13.2, games_count: 187675 },
    { civilization: 'zhu_xis_legacy', win_rate: 49.1, pick_rate: 4.4, games_count: 50000 },
    { civilization: 'mongols', win_rate: 50.2, pick_rate: 6.1, games_count: 70000 },
  ];
  const mapCivRows = [
    { civilization: 'french', win_rate: 54.16, games_count: 31262 },
    { civilization: 'mongols', win_rate: 51, games_count: 150 }, // az veri: en iyiler listesine girmez
    { civilization: 'zhu_xis_legacy', win_rate: 48, games_count: 4000 },
  ];
  const map = resolveMap('Dry Arabia', {}, mapList);
  const m = metaSummary({ kind: 'rm_3v3', mySlug: 'zhu_xis_legacy', enemySlugs: ['mongols'], civRows, map, mapCivRows });
  assert.strictEqual(m.harita.ad, 'Dry Arabia');
  assert.strictEqual(m.harita.ortalamaMacDk, 27);
  assert.deepStrictEqual(m.harita.haritadaEnIyi5, ['Fransızlar %54.2', "Zhu Xi'nin Mirası %48"]);
  assert.deepStrictEqual(m.benimUlkem, { ulke: "Zhu Xi'nin Mirası", genel: { kazanma: 49.1, secilme: 4.4, mac: 50000 }, buHaritada: '%48 (4000 maç)' });
  assert.strictEqual(m.rakipUlkeler[0].ulke, 'Moğollar');
  const brief = metaBrief({ meta: m, research: { text: 'x'.repeat(2000) } });
  assert.strictEqual(brief.internettenOzet.length, 1200);
  assert.strictEqual(metaBrief(null), null);
});

test('gelişim analizi bağlamı: analizli maçlar, tüm maçlar ve meta', () => {
  const matches = [
    { matchId: 1, map: 'Cliffside', result: 'win', durationSec: 1390, hasAnalysis: true, analysisSummary: { villagersAt10: 30 }, players: [{ profileId: 7, civCode: 'chinese_ha_01', team: 0 }] },
    { matchId: 2, map: 'Himeyama', result: 'loss', durationSec: 1843, players: [{ profileId: 7, civCode: 'chinese_ha_01', team: 0 }] },
  ];
  const analysis = { localPid: 3, findings: [{ text: 'Merkez 5 dk boş kaldı' }], report: { players: [{ pid: 3, ageUps: { 2: 300, 3: 900 }, villagers: { tcIdleFirst10: 300 }, military: { firstAt: 400, total: 50, composition: [{ name: 'Zhuge Nu', count: 30 }] }, ecoTechs: [1, 2], apm: 60 }] } };
  const c = reviewContext({ matches, loadAnalysis: () => analysis, localProfileId: 7, me: null, civRows: [{ civilization: 'french', win_rate: 53.49, pick_rate: 13.2 }], civName: (x) => (x === 'chinese_ha_01' ? "Zhu Xi'nin Mirası" : x) });
  assert.strictEqual(c.kayitAnalizliMaclarim.length, 1);
  assert.deepStrictEqual(c.kayitAnalizliMaclarim[0], { harita: 'Cliffside', sonuc: 'galibiyet', ulke: "Zhu Xi'nin Mirası", sure: '23:10', feodal: '5:00', kale: '15:00', merkezBostaIlk10: '5:00', ilkAsker: '6:40', toplamAsker: 50, ordu: ['Zhuge Nu x30'], ekoTeknoloji: 2, apm: 60, koylu10dk: 30, tespitler: ['Merkez 5 dk boş kaldı'] });
  assert.deepStrictEqual(c.uygulamadakiSonMaclarim[1], { sonuc: 'mağlubiyet', ulke: "Zhu Xi'nin Mirası", harita: 'Himeyama', dk: 31 });
  assert.deepStrictEqual(c.guncelMetaTakimOyunu, ['french %53.5 (seçilme %13.2)']);
});
