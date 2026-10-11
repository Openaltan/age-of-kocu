'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { LogParser, parseLineTime } = require('../src/main/logWatcher');

function run(lines) {
  const parser = new LogParser();
  const events = lines.flatMap((l) => parser.feed(l));
  return { parser, events };
}

const sample = fs.readFileSync(path.join(__dirname, 'fixtures', 'warnings-sample.log'), 'utf8').split(/\r?\n/);

test('yerel profil, maç ID ve oyuncuları çıkarır', () => {
  const { events } = run(sample);
  assert.deepStrictEqual(events.map((e) => e.type), [
    'localProfile', 'matchLoading', 'matchStarted', 'matchEnded', 'matchResult', 'matchResult',
  ]);
  assert.strictEqual(events[0].profileId, 21327806);

  const loading = events[1].match;
  assert.strictEqual(loading.matchId, 255410945);
  assert.strictEqual(loading.players.length, 6);
  assert.deepStrictEqual(loading.players[1], {
    slot: 1, name: 'DWJ.九族', profileId: 25717256, team: 0, civCode: 'mongol_ha_gol', ai: false,
  });
  assert.strictEqual(loading.players[5].civCode, 'chinese_ha_01');
});

test('maç süresini frame sayısından hesaplar ve sonuçları toplar', () => {
  const { events } = run(sample);
  const ended = events.find((e) => e.type === 'matchEnded').match;
  assert.strictEqual(ended.durationSec, Math.round(15577 / 8));
  const last = events[events.length - 1].match;
  assert.deepStrictEqual(last.results, { 12532047: 'win', 21327806: 'loss' });
});

test('yerel profili sadece bir kez bildirir', () => {
  const presence = sample[1];
  const { events } = run([presence, presence, presence]);
  assert.strictEqual(events.length, 1);
});

test('log saatini bugünün tarihine, gelecekteyse düne yerleştirir', () => {
  const now = new Date(2026, 9, 11, 0, 30, 0);
  const t = parseLineTime('(I) [23:59:00.000] [1]: x', now);
  assert.strictEqual(new Date(t).getDate(), 10);
  const t2 = parseLineTime('(I) [00:10:00.500] [1]: x', now);
  assert.strictEqual(new Date(t2).getDate(), 11);
  assert.strictEqual(parseLineTime('no time here'), null);
});
