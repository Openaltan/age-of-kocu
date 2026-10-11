'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseReplay, ReplayError } = require('../src/main/replay');
const { analyzeReplay, coachFindings, simulateVillagers } = require('../src/main/analysis');

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };

const GD = {
  100: { id: 'villager-1', baseId: 'villager', name: 'Villager', age: 1, time: 20, tags: ['villager'] },
  200: { id: 'spearman-1', baseId: 'spearman', name: 'Spearman', age: 1, time: 15, tags: ['military', 'infantry', 'anti_cavalry'] },
  300: { id: 'horseman-2', baseId: 'horseman', name: 'Horseman', age: 2, time: 22, tags: ['military', 'cavalry'] },
  400: { id: 'some-landmark-1', baseId: 'some-landmark', name: 'Landmark', age: 1, time: 150, tags: ['landmark'] },
  500: { id: 'wheelbarrow', baseId: 'wheelbarrow', name: 'Wheelbarrow', age: 1, time: 30, tags: ['eco_tech'] },
};

function playerRecord(name, team, pid, civ) {
  return Buffer.concat([u32(name.length), Buffer.from(name, 'utf16le'), u32(team), u32(pid), Buffer.from([1]), u32(civ.length), Buffer.from(civ, 'latin1')]);
}

// Gerçek biçimdeki komut: 31. baytta pbgid.
function command(ctype, rawPlayer, pbgid) {
  const body = Buffer.alloc(41);
  body.writeUInt16LE(41, 0);
  body[2] = ctype;
  body[3] = rawPlayer;
  body.writeUInt32LE(pbgid, 31);
  return body;
}

function tick(n, cmds) {
  const bundles = cmds.map((c) => Buffer.concat([u32(1), u32(0), u32(c.length), c]));
  const payload = Buffer.concat([Buffer.from([0x20]), u32(n), u32(0), u32(bundles.length), ...bundles]);
  return Buffer.concat([u32(0), u32(payload.length), payload]);
}

function buildReplay(ticks) {
  const head = Buffer.alloc(76);
  Buffer.from('AOE4_RE', 'latin1').copy(head, 4);
  const players = Buffer.concat([playerRecord('altanarl', 1, 6, 'chinese_ha_01'), Buffer.alloc(8), playerRecord('Rakip', 0, 2, 'french')]);
  const chunk = Buffer.concat([Buffer.from('DATAINFO', 'latin1'), u32(1), u32(players.length), u32(0), players]);
  const chunky = Buffer.concat([Buffer.from('Relic Chunky\r\n\x1a\0', 'latin1'), u32(4), u32(1)]);
  return Buffer.concat([head, chunky, chunk, ...ticks]);
}

test('kayıt başlığından oyuncuları ve akıştan olayları çıkarır', () => {
  const buf = buildReplay([
    tick(8, [command(3, 6, 100), command(0x99, 6, 0)]),
    tick(16, [command(3, 2 | 0x80, 300), command(123, 6, 400)]),
    tick(24, [command(16, 6, 500)]),
  ]);
  const r = parseReplay(buf, GD);
  assert.deepStrictEqual(r.players, [
    { pid: 6, name: 'altanarl', team: 1, civCode: 'chinese_ha_01' },
    { pid: 2, name: 'Rakip', team: 0, civCode: 'french' },
  ]);
  assert.strictEqual(r.durationSec, 3);
  assert.deepStrictEqual(r.events, [
    { t: 1, pid: 6, auto: false, kind: 'unit', pbgid: 100 },
    { t: 2, pid: 2, auto: true, kind: 'unit', pbgid: 300 },
    { t: 2, pid: 6, auto: false, kind: 'building', pbgid: 400 },
    { t: 3, pid: 6, auto: false, kind: 'tech', pbgid: 500 },
  ]);
  // Kamera komutu (0x99) ve otomatik kuyruk APM'ye sayılmaz.
  assert.deepStrictEqual(r.actions, { 6: 3 });
});

test('yarım yazılmış son kaydı yok sayar, AoE4 dışı dosyayı reddeder', () => {
  const full = buildReplay([tick(8, [command(3, 6, 100)]), tick(16, [command(3, 6, 100)])]);
  const r = parseReplay(full.slice(0, full.length - 5), GD);
  assert.strictEqual(r.events.length, 1);
  assert.throws(() => parseReplay(Buffer.from('merhaba dünya, bu bir kayıt değil'), GD), ReplayError);
});

test('kasaba merkezi boşta süresi kuyruk simülasyonuyla hesaplanır', () => {
  // 0'da 1 köylü (0-20), 60'ta 1 köylü (60-80): 20-60 arası 40 sn boş; 80'den 600'e kadar da boş.
  const r = simulateVillagers([{ t: 0, duration: 20 }, { t: 60, duration: 20 }], []);
  assert.strictEqual(r.idleFirst10, 40 + (600 - 80));
  assert.deepStrictEqual(r.doneTimes, [20, 80]);
  // Önden kuyruğa alınan 3 köylü art arda üretilir, arada boşluk olmaz.
  const q = simulateVillagers([{ t: 0, duration: 20 }, { t: 0, duration: 20 }, { t: 0, duration: 20 }], []);
  assert.deepStrictEqual(q.doneTimes, [20, 40, 60]);
});

test('bulgular: boşta merkez, geç Feodal ve atlıya karşı mızrakçı eksikliği', () => {
  const ev = [];
  // Rakip: kesintisiz köylü, 2:30'da landmark, 30 atlı
  for (let t = 0; t < 600; t += 20) ev.push({ t, pid: 2, auto: false, kind: 'unit', pbgid: 100 });
  ev.push({ t: 150, pid: 2, auto: false, kind: 'building', pbgid: 400 });
  for (let i = 0; i < 30; i++) ev.push({ t: 300 + i * 10, pid: 2, auto: false, kind: 'unit', pbgid: 300 });
  // Ben: dakikada bir köylü, 5:00'te landmark, 12 atlı, hiç mızrakçı yok
  for (let t = 0; t < 600; t += 60) ev.push({ t, pid: 6, auto: false, kind: 'unit', pbgid: 100 });
  ev.push({ t: 300, pid: 6, auto: false, kind: 'building', pbgid: 400 });
  for (let i = 0; i < 12; i++) ev.push({ t: 400 + i * 10, pid: 6, auto: false, kind: 'unit', pbgid: 300 });
  ev.sort((a, b) => a.t - b.t);

  const report = analyzeReplay({
    players: [{ pid: 6, name: 'altanarl', team: 1, civCode: 'chinese_ha_01' }, { pid: 2, name: 'Rakip', team: 0, civCode: 'french' }],
    durationSec: 1200, events: ev, actions: { 6: 600, 2: 900 },
  }, GD);
  const me = report.players[0];
  assert.strictEqual(me.ageUps[2], 300);
  assert.strictEqual(me.apm, 30);
  assert.strictEqual(me.villagers.producedBy[10], 10);

  const texts = coachFindings(report, me).map((f) => `${f.level}: ${f.text}`).join('\n');
  assert.match(texts, /danger: İlk 10 dakikada kasaba merkezin yaklaşık/);
  assert.match(texts, /danger: Feodal landmark'ı: sen 5:00, rakip ortalaması 2:30/);
  assert.match(texts, /danger: 10\. dakikaya kadar 10 köylü ürettin; Rakip 30 üretti/);
  assert.match(texts, /danger: Rakip orduda atlı oranı %100, senin ordunda mızrakçı oranı %0/);
  assert.match(texts, /danger: Maç boyunca hiç ekonomi teknolojisi/);
});
