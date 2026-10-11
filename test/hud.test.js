'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseField, HudState, HudCoach, distributionFix, fitDistribution, distributionLine } = require('../src/main/hud');

test('OCR metni alan türüne göre ayrıştırılır, düşük güven ve saçma değerler atılır', () => {
  assert.strictEqual(parseField('amount', '1250', 90), 1250);
  assert.strictEqual(parseField('amount', '12a', 90), null);
  assert.strictEqual(parseField('amount', '1250', 30), null);
  assert.deepStrictEqual(parseField('pop', '64/80', 90), { cur: 64, cap: 80 });
  assert.strictEqual(parseField('pop', '6480', 90), null);
  assert.strictEqual(parseField('count', '999', 90), null);
});

test('tek karelik OCR hatası ortanca ile yutulur', () => {
  const s = new HudState();
  s.push({ food: 300 });
  s.push({ food: 8300 }); // yanlış okuma
  const snap = s.push({ food: 310 });
  assert.strictEqual(snap.res.food, 310);
});

test('toplam köylü dört kaynak + boştakilerden hesaplanır', () => {
  const s = new HudState();
  const snap = s.push({ vilFood: 6, vilWood: 4, vilGold: 2, vilStone: 0, idle: 1 });
  assert.strictEqual(snap.villagers, 13);
  assert.strictEqual(new HudState().push({ vilFood: 6 }).villagers, null);
});

function hud(over = {}) {
  return {
    res: { food: 100, wood: 100, gold: 0, stone: 0 },
    vil: { food: 6, wood: 4, gold: 2, stone: 0 },
    villagers: 12,
    pop: { cur: 14, cap: 20 },
    idle: 0,
    ...over,
  };
}

test('boşta köylü notu 4 sn sonra görünür, sürdükçe kalır, bitince kaybolur', () => {
  const c = new HudCoach();
  assert.strictEqual(c.evaluate(hud({ idle: 2 }), 100, null).length, 0);
  assert.deepStrictEqual(c.evaluate(hud({ idle: 2 }), 104, null), [{ key: 'idle', level: 'danger', text: '2 köylü boşta' }]);
  assert.strictEqual(c.evaluate(hud({ idle: 2 }), 130, null).length, 1);
  assert.strictEqual(c.evaluate(hud({ idle: 0 }), 131, null).length, 0);
});

test('nüfus dolmak üzereyken ev notu, 200 nüfusta yok', () => {
  const c = new HudCoach();
  c.evaluate(hud({ pop: { cur: 19, cap: 20 } }), 200, null);
  assert.ok(c.evaluate(hud({ pop: { cur: 19, cap: 20 } }), 202, null).some((n) => n.text === 'Ev kur (19/20)'));
  const c2 = new HudCoach();
  c2.evaluate(hud({ pop: { cur: 200, cap: 200 } }), 200, null);
  assert.strictEqual(c2.evaluate(hud({ pop: { cur: 200, cap: 200 } }), 205, null).length, 0);
});

test('köylü sayısı 40 sn artmazsa "Köylü bas" notu', () => {
  const c = new HudCoach();
  let last = [];
  for (let t = 300; t <= 345; t += 5) last = c.evaluate(hud(), t, null);
  assert.ok(last.some((n) => n.text === 'Köylü bas'));
  const c2 = new HudCoach();
  let n = 12;
  for (let t = 300; t <= 345; t += 5) last = c2.evaluate(hud({ villagers: n++ }), t, null);
  assert.ok(!last.some((x) => x.key === 'vilstall'));
});

test('savaş modunda köylü kaydırma notu susar, boşta köylü notu sürer', () => {
  const c = new HudCoach();
  const step = { food: 4, wood: 6, gold: 2, stone: 0 };
  const h = hud({ vil: { food: 7, wood: 3, gold: 2, stone: 0 }, idle: 2 });
  for (let t = 100; t <= 110; t += 2) c.evaluate(h, t, step, { combat: true });
  const out = c.evaluate(h, 112, step, { combat: true });
  assert.ok(!out.some((n) => n.key === 'dist'));
  assert.ok(out.some((n) => n.key === 'idle'));
});

test('YZ dağılımı gerçek köylü sayısına oturur, toplam her zaman tutar', () => {
  // YZ 16 köylüye 3 odun 3 taş dedi ama toplam tutmuyor: oranlar korunup 16'ya tamamlanır.
  const d = fitDistribution({ yemek: 6, odun: 3, altin: 4, tas: 3 }, 18);
  assert.strictEqual(d.food + d.wood + d.gold + d.stone, 18);
  assert.deepStrictEqual(d, { food: 7, wood: 3, gold: 5, stone: 3 });
  assert.strictEqual(distributionLine(d), 'Köylü 18: 7 yemek · 3 odun · 5 altın · 3 taş');
  // Ekrandan okunamıyorsa YZ'nin kendi toplamı.
  assert.deepStrictEqual(fitDistribution({ yemek: 8, odun: 5, altin: 3, tas: 0 }, null), { food: 8, wood: 5, gold: 3, stone: 0 });
  assert.strictEqual(fitDistribution({ yemek: 0, odun: 0, altin: 0, tas: 0 }, 20), null);
  assert.strictEqual(fitDistribution(undefined, 20), null);
  for (let n = 1; n <= 60; n++) {
    const x = fitDistribution({ yemek: 7, odun: 5, altin: 3, tas: 1 }, n);
    assert.strictEqual(x.food + x.wood + x.gold + x.stone, n);
  }
});

test('build adımına göre kısa köylü kaydırma notu', () => {
  const step = { food: 4, wood: 6, gold: 2, stone: 0 };
  assert.strictEqual(distributionFix({ food: 7, wood: 3, gold: 2, stone: 0 }, step).text, 'Oduna +3 köylü (yemekten)');
  assert.strictEqual(distributionFix({ food: 4, wood: 5, gold: 2, stone: 0 }, step), null);
});
