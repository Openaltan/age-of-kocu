'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { NoteBoard } = require('../src/main/notes');

test('durum ve süreli notlar birleşir, tehlike üstte, süresi dolan kaybolur', () => {
  const b = new NoteBoard();
  b.setState([{ key: 'float', level: 'info', text: 'Kaynak birikiyor, harca' }]);
  b.push('ai-risk', 'danger', 'Rakip gelebilir · sol', 60, 1000);
  assert.deepStrictEqual(b.list(2000).map((n) => n.text), ['Rakip gelebilir · sol', 'Kaynak birikiyor, harca']);
  assert.deepStrictEqual(b.list(62000).map((n) => n.text), ['Kaynak birikiyor, harca']);
});

test('aynı anahtar tek not, en fazla 8 not', () => {
  const b = new NoteBoard();
  b.push('x', 'info', 'eski', 60, 0);
  b.push('x', 'info', 'yeni', 60, 0);
  for (let i = 0; i < 10; i++) b.push(`k${i}`, 'info', `n${i}`, 60, 0);
  const l = b.list(1);
  assert.strictEqual(l.length, 8);
  assert.strictEqual(l[0].text, 'yeni');
});

test('yönet komutları tehlikeden sonra, bilgiden önce ve kendi sırasıyla', () => {
  const b = new NoteBoard();
  b.push('ai-err', 'info', 'bilgi', 60, 0);
  b.push('cmd-1', 'cmd', '2. Ahırdan 6 atlı', 60, 0);
  b.push('cmd-0', 'cmd', '1. Kışla kur', 60, 0);
  b.push('ai-risk', 'danger', 'Rakip gelebilir', 60, 0);
  assert.deepStrictEqual(b.list(1).map((n) => n.text), ['Rakip gelebilir', '1. Kışla kur', '2. Ahırdan 6 atlı', 'bilgi']);
  b.removeWhere((n) => n.key.startsWith('cmd-'));
  assert.deepStrictEqual(b.list(1).map((n) => n.text), ['Rakip gelebilir', 'bilgi']);
});
