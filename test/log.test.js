'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('günlük: console çıktısı zaman damgasıyla dosyaya da yazılır', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kocu-log-'));
  const { init } = require('../src/main/log');
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(saved)) console[k] = () => {}; // test çıktısını kirletmesin
  try {
    const file = init(dir);
    console.warn('YZ değerlendirmesi başarısız:', 'Gemini yanıtı gecikti');
    console.error('kayıt yazılamadı', new Error('EPERM'));
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} \[WARN\] YZ değerlendirmesi başarısız: Gemini yanıtı gecikti$/m);
    assert.match(text, /\[ERROR\] kayıt yazılamadı Error: EPERM/);
  } finally {
    Object.assign(console, saved);
  }
});
