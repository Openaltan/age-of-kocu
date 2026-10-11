'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { scoreboardRows, MinimapWatcher, hsv, direction, DIRS } = require('../src/main/minimap');

// Gerçek maç görüntüsünden kesitler (1080p): oyuncu listesi ve mini harita, BGRA.
function fixture(name) {
  const dir = path.join(__dirname, 'fixtures');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
  return { width: meta.width, height: meta.height, data: zlib.gunzipSync(fs.readFileSync(path.join(dir, `${name}.bgra.gz`))) };
}

test('oyuncu listesi: satır renkleri ve ⚔ rakip işareti okunur, bayraklar karışmaz', () => {
  const rows = scoreboardRows(fixture('scoreboard'));
  assert.strictEqual(rows.length, 4);
  const near = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b)) <= 8;
  // camgöbeği, kırmızı, sarı, mavi
  [180, 2, 58, 211].forEach((h, i) => assert.ok(near(rows[i].hue, h), `satır ${i} tonu ${rows[i].hue}`));
  assert.deepStrictEqual(rows.map((r) => r.enemy), [true, true, false, false]);
  // "B.Eng. Odin Jens der Hodenhen... | III. Çağ" en uzun satır.
  assert.ok(rows[0].width > rows[1].width && rows[1].width > rows[3].width);
});

test('gerçek mini harita: üsse giren düşman ordusu 2 karede "Üssüne saldırı" olur', () => {
  const rows = scoreboardRows(fixture('scoreboard'));
  const roles = ['enemy', 'enemy', 'ally', 'me'];
  const w = new MinimapWatcher();
  w.setPlayers(rows.map((r, i) => ({ key: `row-${i}`, name: `p${i}`, role: roles[i], hue: r.hue })));
  const full = fixture('minimap');
  // İlk kare: ordu henüz yok (bölge karartıldı).
  const before = { ...full, data: Buffer.from(full.data) };
  for (let y = 185; y < 215; y++) {
    for (let x = 118; x < 150; x++) {
      const o = (y * full.width + x) * 4;
      before.data[o] = before.data[o + 1] = before.data[o + 2] = 20;
    }
  }
  assert.deepStrictEqual(w.update(before, 100).events, []);
  assert.deepStrictEqual(w.update(full, 101).events, []); // tek kare: kırpışma olabilir
  const ev = w.update(full, 102).events;
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].kind, 'base');
  assert.strictEqual(ev[0].level, 'danger');
  assert.strictEqual(ev[0].text, 'Üssüne saldırı · batı tarafı');
});

// ---- Yapay mini harita: 240x240, 24x24 hücre (10 px) ----
const BLUE = [40, 120, 255];
const RED = [230, 40, 40];
const YELLOW = [240, 225, 40];

function canvas() {
  const img = { width: 240, height: 240, data: Buffer.alloc(240 * 240 * 4) };
  paint(img, 0, 0, 240, 240, [25, 30, 20]);
  return img;
}

function paint(img, x0, y0, w, h, [r, g, b]) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const o = (y * img.width + x) * 4;
      img.data[o] = b;
      img.data[o + 1] = g;
      img.data[o + 2] = r;
      img.data[o + 3] = 255;
    }
  }
}

// Hücre koordinatıyla (cx, cy) kare çizer.
const cell = (img, cx, cy, size, rgb) => paint(img, cx * 10 + 1, cy * 10 + 1, size, size, rgb);

function world(extra = () => {}) {
  const img = canvas();
  for (let cx = 3; cx <= 5; cx++) for (let cy = 3; cy <= 5; cy++) cell(img, cx, cy, 6, BLUE); // benim üssüm (kuzeybatı)
  for (let cx = 18; cx <= 20; cx++) for (let cy = 18; cy <= 20; cy++) cell(img, cx, cy, 6, RED); // rakip üssü (güneydoğu)
  for (let cx = 3; cx <= 5; cx++) for (let cy = 18; cy <= 20; cy++) cell(img, cx, cy, 6, YELLOW); // takım arkadaşı (güneybatı)
  extra(img);
  return img;
}

function watcher() {
  const w = new MinimapWatcher();
  const h = (rgb) => hsv(...rgb).h;
  w.setPlayers([
    { key: 'me', name: 'altanarl', role: 'me', hue: h(BLUE) },
    { key: 'ally', name: 'Pirofurkan', role: 'ally', hue: h(YELLOW) },
    { key: 'enemy', name: 'Rakip', role: 'enemy', hue: h(RED) },
  ]);
  w.update(world(), 0); // ilk kare: üsler yerleşik sayılır
  return w;
}

test('sahadaki rakip ordusu bana yaklaşınca "Ordu sana geliyor" olur', () => {
  const w = watcher();
  const army = (cx, cy) => world((img) => { cell(img, cx, cy, 8, RED); cell(img, cx + 1, cy, 8, RED); });
  w.update(army(14, 14), 1);
  assert.deepStrictEqual(w.update(army(14, 14), 2).events.map((e) => e.kind), ['army']);
  w.update(army(12, 12), 3);
  const ev = w.update(army(11, 11), 4).events;
  assert.strictEqual(ev[0].kind, 'incoming');
  assert.strictEqual(ev[0].level, 'danger');
  assert.match(ev[0].text, /^Ordu sana geliyor · güneydoğudan$/);
});

test('kısa süre görünen düşman: tek kare yok sayılır, iki kare görülürse not ve hafıza', () => {
  const w = watcher();
  const scout = () => world((img) => cell(img, 12, 4, 3, RED));
  assert.deepStrictEqual(w.update(scout(), 1).events, []);
  const ev = w.update(scout(), 2).events;
  assert.deepStrictEqual(ev.map((e) => [e.kind, e.text]), [['sighting', 'Düşman görüldü · doğu']]);
  assert.deepStrictEqual(w.update(world(), 3).events, []); // kayboldu
  assert.deepStrictEqual(w.recent(30), [{ saniyeOnce: 28, ne: 'Düşman görüldü · doğu' }]);
});

test('baskındaki birliğime rakip ordusu yaklaşınca uyarır; rakip üssündeki köylüler sessiz', () => {
  const w = watcher();
  const raid = () => world((img) => {
    cell(img, 16, 15, 5, BLUE); // benim baskın birliğim rakip üssünün yakınında
    cell(img, 18, 17, 2, RED); // rakip üssünde tek tük köylü
  });
  w.update(raid(), 1);
  assert.deepStrictEqual(w.update(raid(), 2).events, []);
  const attacked = () => world((img) => {
    cell(img, 16, 15, 5, BLUE);
    cell(img, 17, 13, 8, RED);
    cell(img, 18, 13, 8, RED);
  });
  w.update(attacked(), 3);
  const ev = w.update(attacked(), 4).events;
  assert.strictEqual(ev[0].kind, 'raid');
  assert.match(ev[0].text, /^Birliğine ordu geliyor · kuzeydoğudan$/);
});

test('takım arkadaşının üssüne giren düşman ona göre bildirilir', () => {
  const w = watcher();
  const img = () => world((i) => cell(i, 6, 19, 4, RED));
  w.update(img(), 1);
  assert.deepStrictEqual(w.update(img(), 2).events.map((e) => e.text), ['Pirofurkan üssünde düşman']);
});

test('yön: mini haritanın üstü kuzey', () => {
  assert.strictEqual(DIRS[direction({ x: 5, y: 5 }, { x: 5, y: 1 })], 'kuzey');
  assert.strictEqual(DIRS[direction({ x: 5, y: 5 }, { x: 9, y: 9 })], 'güneydoğu');
  assert.strictEqual(direction({ x: 5, y: 5 }, { x: 5.2, y: 5 }), null);
});
