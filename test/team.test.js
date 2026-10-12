'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { TeamSync, teamNotes, roomKey } = require('../src/main/teamSync');

// Sahte WebSocket: gönderilenleri toplar, sunucu mesajını elle iletmeye izin verir.
class FakeWS {
  constructor(url) {
    this.url = url;
    this.sent = [];
    FakeWS.last = this;
    setImmediate(() => this.onopen && this.onopen());
  }
  send(t) { this.sent.push(JSON.parse(t)); }
  close() { this.closed = true; }
  receive(obj) { this.onmessage({ data: JSON.stringify(obj) }); }
}

const tick = () => new Promise((r) => setImmediate(r));

test('oda anahtarı takım kodu ve maça bağlı, büyük/küçük harf duyarsız', () => {
  assert.strictEqual(roomKey('Altan-Piro', 5), roomKey(' altan-piro ', 5));
  assert.notStrictEqual(roomKey('altan-piro', 5), roomKey('altan-piro', 6));
  assert.match(roomKey('x', 1), /^[a-f0-9]{64}$/);
});

test('otomatik mod: kod yoksa oda maça ve takım kadrosuna göre, sıradan bağımsız', () => {
  const k = roomKey(null, 255417925, [21327806, 24071999, 24072073]);
  assert.strictEqual(k, roomKey('', 255417925, ['24072073', '21327806', '24071999']));
  assert.notStrictEqual(k, roomKey(null, 255417925, [4606028, 24295983, 24254248])); // rakip takım başka oda
  assert.notStrictEqual(k, roomKey('gizli', 255417925, [21327806, 24071999, 24072073])); // gizli kod başka oda
});

test('kod girilmeden de bağlanır', async () => {
  const t = new TeamSync({ serverUrl: 'https://oda.example', WebSocketImpl: FakeWS });
  t.connect({ teamCode: null, matchId: 9, me: { id: 1, name: 'a' }, allowedIds: [1, 2] });
  await tick();
  assert.ok(FakeWS.last.url.endsWith(roomKey(null, 9, [1, 2])));
  t.disconnect();
});

test('bağlanınca kendini tanıtır, son durumunu yollar; sadece takım arkadaşlarını kabul eder', async () => {
  const t = new TeamSync({ serverUrl: 'https://oda.example', WebSocketImpl: FakeWS });
  t.sendStatus({ villagers: 10 }); // bağlanmadan önceki durum saklanır
  t.connect({ teamCode: 'kod', matchId: 7, me: { id: 1, name: 'altanarl' }, allowedIds: [1, 2, 3] });
  await tick();
  const ws = FakeWS.last;
  assert.ok(ws.url.startsWith('wss://oda.example/room/'));
  assert.deepStrictEqual(ws.sent.map((m) => m.type), ['hello', 'status']);

  const seen = [];
  t.on('status', (m) => seen.push(m.name));
  ws.receive({ type: 'status', from: { id: '2', name: 'Pirofurkan' }, data: { villagers: 20 } });
  ws.receive({ type: 'status', from: { id: '99', name: 'Yabancı' }, data: { villagers: 50 } });
  assert.deepStrictEqual(seen, ['Pirofurkan']);
  assert.deepStrictEqual(t.liveMembers().map((m) => m.name), ['Pirofurkan']);

  ws.receive({ type: 'join', from: { id: '3', name: 'jxstixab' } });
  assert.strictEqual(ws.sent[ws.sent.length - 1].type, 'status');

  ws.receive({ type: 'leave', from: { id: '2', name: 'Pirofurkan' } });
  assert.strictEqual(t.liveMembers().length, 0);
  t.disconnect();
  assert.ok(ws.closed);
});

test('takım notları: arkadaşın riski, boştaki köylüsü ve köylüde geri kalma', () => {
  const mates = [
    { id: '2', name: 'Piro', status: { risk: 'Rakip gelebilir · sol', idle: 0, villagers: 40 } },
    { id: '3', name: 'jx', status: { risk: null, idle: 4, villagers: 38 } },
  ];
  const notes = teamNotes({ villagers: 25 }, mates, 10 * 60).map((n) => n.text);
  // Türü belli olmayan risk (eski sürüm) tahmin sayılır.
  assert.deepStrictEqual(notes, ['Piro (olası): Rakip gelebilir · sol', 'jx: 4 köylü boşta', 'Takımda en az köylü sende']);
  assert.strictEqual(teamNotes({ villagers: 25 }, mates, 5 * 60).length, 2); // ilk 8 dakikada kıyas yok
  const real = teamNotes({}, [{ id: '2', name: 'Piro', status: { risk: 'Üssünde düşman · batı tarafı', riskKind: 'gercek' } }], 60);
  assert.deepStrictEqual(real, [{ key: 'team-risk-2', level: 'danger', text: 'Piro: Üssünde düşman · batı tarafı' }]);
});

test('YZ uyarısı: tahmin "Olası" ve bilgi seviyesi, sadece gerçek olay takıma gider', () => {
  const { warningNote } = require('../src/main/aiContext');
  assert.deepStrictEqual(warningNote({ uyari: 'Baskın · altın madeninde', uyariTuru: 'tahmin', risk: 'yüksek' }), { level: 'info', text: 'Olası: Baskın · altın madeninde', share: false });
  assert.deepStrictEqual(warningNote({ uyari: 'Rakip gelebilir · değirmen', uyariTuru: 'tahmin', risk: 'orta' }), { level: 'info', text: 'Rakip gelebilir · değirmen', share: false });
  assert.deepStrictEqual(warningNote({ uyari: 'Saldırı · altın madeninde', uyariTuru: 'gercek', risk: 'yüksek' }), { level: 'danger', text: 'Saldırı · altın madeninde', share: true });
  assert.deepStrictEqual(warningNote({ uyari: 'Ev kur', uyariTuru: 'eksik', risk: 'orta' }), { level: 'info', text: 'Ev kur', share: false });
  assert.strictEqual(warningNote({ uyari: '', uyariTuru: 'yok' }), null);
  // Türü olmayan eski yanıt: tahmin say.
  assert.strictEqual(warningNote({ uyari: 'Altına baskın', risk: 'yüksek' }).text, 'Olası: Altına baskın');
});

test('ortak ulus önerisi anahtarı ekip sırasından bağımsız; takım seviyesi ortalama puandan', () => {
  const { adviceKey, teamRankLevel } = require('../src/main/teamSync');
  assert.strictEqual(adviceKey([21327806, 24071999, 24072073], 'rm_3v3', 'silver'), adviceKey([24072073, 21327806, 24071999], 'rm_3v3', 'silver'));
  assert.notStrictEqual(adviceKey([1, 2, 3], 'rm_3v3', 'silver'), adviceKey([1, 2, 3], 'rm_3v3', 'gold'));
  assert.match(adviceKey([1, 2], 'rm_2v2', 'gold'), /^[a-f0-9]{64}$/);
  assert.strictEqual(teamRankLevel([500, 650, 700]), 'silver'); // ort. 616
  assert.strictEqual(teamRankLevel([1450, 1500]), 'conqueror');
  assert.strictEqual(teamRankLevel([NaN, null]), 'gold');
});
