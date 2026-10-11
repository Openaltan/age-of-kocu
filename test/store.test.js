'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kocu-store-'));

test('ayarlar yazılır ve sağlam son hali yedeklenir', () => {
  const dir = tmpDir();
  const s = new Store(dir);
  s.updateSettings({ geminiKeyEnc: 'abc', hudRegions: { width: 1, height: 1, fields: { food: { x: 0, y: 0, w: 1, h: 1 } } } });
  assert.strictEqual(new Store(dir).settings.geminiKeyEnc, 'abc');
  assert.ok(fs.existsSync(path.join(dir, 'settings.json.bak')));
  assert.deepStrictEqual(s.lastWrite.ok, true);
});

test('bozuk ayar dosyası anahtarı ve kalibrasyonu sessizce silmez: yedekten yüklenir', () => {
  const dir = tmpDir();
  new Store(dir).updateSettings({ geminiKeyEnc: 'abc', coachMode: 'yonet' });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"geminiKeyEnc": "ab'); // yarım yazılmış
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const s = new Store(dir);
    assert.strictEqual(s.settings.geminiKeyEnc, 'abc');
    assert.strictEqual(s.settings.coachMode, 'yonet');
  } finally {
    console.error = orig;
  }
  assert.ok(errors.some((e) => /okunamadı/.test(e)));
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('settings.json.bozuk-')));
});

test('yazma hatası akışı kırmaz, son hata saklanır', () => {
  const dir = tmpDir();
  const s = new Store(dir);
  s.matchesPath = path.join(dir, 'yok', 'olmayan', 'matches.json');
  const orig = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => s.saveMatch({ matchId: 1 }));
  } finally {
    console.error = orig;
  }
  assert.strictEqual(s.lastWrite.ok, false);
  assert.strictEqual(s.matches[0].matchId, 1); // bellekte duruyor
});
