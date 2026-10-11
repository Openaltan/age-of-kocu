'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { BuildRunner, stepTriggers, Coach } = require('../src/main/coach');
const { normalize, parseTime } = require('../src/main/aoe4guides');

const steps = [
  { villagers: 6, time: null },
  { villagers: 9, time: null },
  { villagers: null, time: null },
  { villagers: 12, time: 150 },
  { villagers: 14, time: null },
];

test('adım zamanları köylü üretimi ve yazılı süreden hesaplanır', () => {
  // 9. köylü: 3 köylü * 20 sn = 60; boş adım öncekini devralır; 14. köylü 160 sn ama 150'den geri gidemez.
  assert.deepStrictEqual(stepTriggers(steps), [0, 60, 60, 150, 160]);
});

test('adım kaydırma sınırlar içinde kalır', () => {
  const r = new BuildRunner({ name: 'x', steps });
  assert.strictEqual(r.index(0), 0);
  assert.strictEqual(r.index(155), 3);
  r.shift(-1, 155);
  assert.strictEqual(r.index(155), 2);
  r.shift(-10, 155);
  assert.strictEqual(r.index(155), 0);
  r.shift(+10, 155);
  assert.strictEqual(r.index(155), 4);
});

test('uyarılar zamanı gelince bir kez ve geç kalınmadıysa verilir', () => {
  const c = new Coach();
  const t0 = 1_000_000;
  c.start(t0, null, {
    enemies: [{ name: 'A', civTr: 'Fransızlar', insights: [{ level: 'danger', text: 'Erken bitirmeyi seviyor' }] }],
  });
  assert.strictEqual(c.tick(t0 + 179_000).due.length, 0);
  assert.strictEqual(c.tick(t0 + 181_000).due.length, 1);
  assert.strictEqual(c.tick(t0 + 182_000).due.length, 0);
  // 7. dakika uyarısı kaçırıldıysa (uygulama 9. dakikada açıldı) gösterilmez.
  assert.strictEqual(c.tick(t0 + 9 * 60_000).due.length, 0);
});

test('aoe4guides overlay biçimi sadeleştirilir', () => {
  const b = normalize({
    name: 'Test', author: 'me', source: 'https://aoe4guides.com/builds/abc123', strategy: 'Rush',
    build_order: [
      { age: -1, villager_count: 5, time: '0:00', resources: { food: 5, wood: 0, gold: 0, stone: 0, builder: -1 }, notes: ['a'] },
      { age: -1, villager_count: -1, resources: { food: 0, wood: 0, gold: 0, stone: 0, builder: -1 }, notes: [] },
    ],
  });
  assert.strictEqual(b.id, 'abc123');
  assert.strictEqual(b.steps.length, 1);
  assert.deepStrictEqual(b.steps[0], { age: null, villagers: 5, time: 0, food: 5, wood: 0, gold: 0, stone: 0, builder: 0, notes: ['a'] });
  assert.strictEqual(parseTime('2:50'), 170);
  assert.strictEqual(parseTime(''), null);
});

test('ekrandan okunan köylü sayısı adımı belirler, elle kaydırma 20 sn korunur', () => {
  const r = new BuildRunner({ name: 'x', steps });
  r.syncVillagers(12, 30); // saat 30 sn'yi gösterse de 12 köylü = 4. adım (index 3)
  assert.strictEqual(r.index(30), 3);
  const v = r.view(30);
  assert.strictEqual(v.nextAtVillagers, 14);
  assert.strictEqual(v.nextInSec, null);
  r.shift(-1, 35);
  r.syncVillagers(12, 40); // elle kaydırmadan 5 sn sonra: dokunma
  assert.strictEqual(r.index(40), 2);
  r.syncVillagers(14, 60); // 25 sn sonra tekrar eşitle
  assert.strictEqual(r.index(60), 4);
});

const { pickBuild } = require('../src/main/coach');

test('otomatik build: erken baskıcı rakibe savunmalı, uzun maçta zayıflara ekonomik açılış', () => {
  const builds = [
    { id: 'a', name: 'Feudal Rush', strategy: 'Rush' },
    { id: 'b', name: 'Safe Tower Opening', strategy: '' },
    { id: 'c', name: 'Fast Castle Boom', strategy: 'Fast Castle' },
  ];
  const enemy = (texts, level = 'danger') => ({ insights: texts.map((text) => ({ level, text })) });
  assert.strictEqual(pickBuild(builds, { enemies: [enemy(['Erken baskıyı seviyor'])] }).build.id, 'b');
  assert.strictEqual(pickBuild(builds, { enemies: [enemy(['Uzayan maçlarda zayıflıyor'], 'chance')] }).build.id, 'c');
  assert.deepStrictEqual(pickBuild(builds, null), { build: builds[0], reason: 'En yüksek puanlı build' });
  assert.deepStrictEqual(pickBuild([], null), { build: null, reason: null });
});
