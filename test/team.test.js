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
  assert.deepStrictEqual(notes, ['Piro: Rakip gelebilir · sol', 'jx: 4 köylü boşta', 'Takımda en az köylü sende']);
  assert.strictEqual(teamNotes({ villagers: 25 }, mates, 5 * 60).length, 2); // ilk 8 dakikada kıyas yok
});
