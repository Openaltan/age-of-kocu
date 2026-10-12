'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { squadGames, comboStats, squadReport, classifyHabits } = require('../src/main/squad');
const { currentSeasonBuilds } = require('../src/main/aoe4guides');

const A = 1;
const P = 2;
const J = 3;
const members = [{ id: A, name: 'altanarl' }, { id: P, name: 'Pirofurkan' }, { id: J, name: 'jxstixab' }];
let gid = 0;
// Bir AoE4World maçı: bizim takım (lineup: [id, civ]) ve rakip.
function game(lineup, { win, map = 'Flankwoods', min = 30, kind = 'rm_3v3' } = {}) {
  gid++;
  const p = (id, civ, result) => ({ player: { profile_id: id, name: `p${id}`, civilization: civ, result } });
  return { game_id: gid, kind, map, duration: min * 60, started_at: `2026-10-${String(10 + (gid % 20)).padStart(2, '0')}T10:00:00Z`, teams: [lineup.map(([id, civ]) => p(id, civ, win ? 'win' : 'loss')), [p(99, 'french', win ? 'loss' : 'win')]] };
}

test('takım maçları: aynı tarafta en az iki üye, tekrarsız; ikili ve üçlü istatistikler', () => {
  const g1 = game([[A, 'zhu_xis_legacy'], [P, 'jeanne_darc']], { win: true, min: 40 });
  const g2 = game([[A, 'zhu_xis_legacy'], [P, 'jeanne_darc'], [J, 'abbasid_dynasty']], { win: false, min: 12, map: 'Canal' });
  const g3 = game([[A, 'zhu_xis_legacy'], [P, 'jeanne_darc']], { win: true, min: 38 });
  const solo = game([[A, 'french'], [50, 'english']], { win: true }); // ekipten tek kişi: sayılmaz
  const byMember = { [A]: [g1, g2, g3, solo], [P]: [g1, g2, g3], [J]: [g2] };
  const records = squadGames(members, byMember);
  assert.strictEqual(records.length, 3);
  const ap = comboStats(records, [A, P], { nameOf: (id) => members.find((m) => m.id === id).name, civName: (c) => c });
  assert.strictEqual(ap.mac, 3);
  assert.strictEqual(ap.kazanma, 67);
  assert.strictEqual(ap.ortalamaKazanilanDk, 39);
  assert.deepStrictEqual(ap.sureyeGore, [{ aralik: '15 dk altı', mac: 1, kazanma: 0 }, { aralik: '35 dk üstü', mac: 2, kazanma: 100 }]);
  assert.deepStrictEqual(ap.ulusKombinasyonlari, [{ ad: 'altanarl: zhu_xis_legacy + Pirofurkan: jeanne_darc', mac: 3, kazanma: 67 }]);
  assert.deepStrictEqual(ap.enIyiHaritalar, [{ ad: 'Flankwoods', mac: 2, kazanma: 100 }]);
  const r = squadReport(members, byMember);
  assert.strictEqual(r.toplamTakimMaci, 3);
  assert.deepStrictEqual(r.ikililer.map((c) => [c.oyuncular.join('+'), c.mac]), [['altanarl+Pirofurkan', 3], ['altanarl+jxstixab', 1], ['Pirofurkan+jxstixab', 1]]);
  assert.strictEqual(r.uclu.mac, 1);
  assert.deepStrictEqual(r.ulkeTercihleri[0].ulkeler[0], { ulus: 'zhu_xis_legacy', mac: 3, kazanma: 67 });
});

const row = (o) => ({ result: 'win', feudalAt: 330, castleAt: 1000, tcIdleFirst10: 30, firstMilitaryAt: 600, militaryTotal: 40, topUnits: ['Okçu'], ecoTechs: 4, ...o });

test('alışkanlık: kazanılan maçlarda da varsa tarz, kayıplarda belirgin sıksa hata; az veride yorum yok', () => {
  assert.deepStrictEqual(classifyHabits([row(), row()]), { mac: 2, azVeri: true, aliskanliklar: [] });
  // Her maç erken asker: 3 galibiyet + 2 mağlubiyette de var -> tarz.
  const early = [1, 2, 3].map(() => row({ firstMilitaryAt: 300 })).concat([1, 2].map(() => row({ firstMilitaryAt: 320, result: 'loss' })));
  const h1 = classifyHabits(early).aliskanliklar.find((a) => /7\. dakikadan önce/.test(a.aliskanlik));
  assert.strictEqual(h1.karar, 'tarz');
  // Hızlı Kale sadece mağlubiyetlerde sık -> hata.
  const fc = [row({ castleAt: 800, result: 'loss' }), row({ castleAt: 790, result: 'loss' }), row({ castleAt: 810, result: 'loss' }), row({ castleAt: 1100 }), row({ castleAt: 780 })];
  assert.strictEqual(classifyHabits(fc).aliskanliklar.find((a) => /hızlı Kale/.test(a.aliskanlik)).karar, 'hata (kayıplarda daha sık)');
  // Merkez boşta her zaman hata.
  const idle = [1, 2, 3].map(() => row({ tcIdleFirst10: 200 }));
  assert.strictEqual(classifyHabits(idle).aliskanliklar.find((a) => /boş kalıyor/.test(a.aliskanlik)).karar, 'hata');
});

test('güncel sezon build süzgeci: en yeni ve bir önceki sezon; sezonsuzlar kalır', () => {
  const b = (id, season) => ({ id, season });
  assert.deepStrictEqual(currentSeasonBuilds([b(1, 'Season 13'), b(2, 'Season 4'), b(3, 'Season 12'), b(4, '')]).map((x) => x.id), [1, 3, 4]);
  assert.deepStrictEqual(currentSeasonBuilds([b(1, 'Season 4')]).map((x) => x.id), [1]);
});
