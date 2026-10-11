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

test('aynı anahtar tek not, en fazla 6 not', () => {
  const b = new NoteBoard();
  b.push('x', 'info', 'eski', 60, 0);
  b.push('x', 'info', 'yeni', 60, 0);
  for (let i = 0; i < 10; i++) b.push(`k${i}`, 'info', `n${i}`, 60, 0);
  const l = b.list(1);
  assert.strictEqual(l.length, 6);
  assert.strictEqual(l[0].text, 'yeni');
});
