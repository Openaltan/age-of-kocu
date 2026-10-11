'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LogWatcher } = require('../src/main/logWatcher');

const sample = fs.readFileSync(path.join(__dirname, 'fixtures', 'warnings-sample.log'), 'utf8').split(/\r?\n/).filter(Boolean);
const START = sample.findIndex((l) => l.includes('Starting mission'));

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kocu-'));
  return path.join(dir, 'warnings.log');
}

function record(w) {
  const events = [];
  for (const t of ['localProfile', 'catchUp', 'pastMatch', 'matchLoading', 'matchStarted', 'matchEnded', 'matchResult', 'session']) {
    w.on(t, (e) => events.push({ t, e }));
  }
  return events;
}

test('maç ortasında açılınca geçmişi sessizce işler, sonra canlı olayları yayınlar', () => {
  const file = tmpLog();
  fs.writeFileSync(file, sample.slice(0, START + 1).join('\n') + '\n');
  const w = new LogWatcher(file);
  const events = record(w);

  w.readNew(true);
  assert.deepStrictEqual(events.map((x) => x.t), ['localProfile', 'catchUp']);
  assert.strictEqual(events[1].e.match.phase, 'playing');

  fs.appendFileSync(file, sample.slice(START + 1).join('\n') + '\n');
  w.readNew(false);
  assert.deepStrictEqual(events.slice(2).map((x) => x.t), ['matchEnded', 'matchResult', 'matchResult']);
});

test('yarım satırı bir sonraki okumaya saklar', () => {
  const file = tmpLog();
  const line = sample.find((l) => l.includes('Game Over'));
  fs.writeFileSync(file, sample.slice(0, START + 1).join('\n') + '\n' + line.slice(0, 30));
  const w = new LogWatcher(file);
  const events = record(w);
  w.readNew(true);
  fs.appendFileSync(file, line.slice(30) + '\n');
  w.readNew(false);
  assert.ok(events.some((x) => x.t === 'matchEnded'));
});

test('oyun yeniden açılıp log küçülünce yeni oturuma geçer ve profili korur', () => {
  const file = tmpLog();
  fs.writeFileSync(file, sample.join('\n') + '\n');
  const w = new LogWatcher(file);
  const events = record(w);
  w.readNew(true);
  assert.strictEqual(events.filter((x) => x.t === 'pastMatch').length, 2);

  fs.writeFileSync(file, sample.slice(3, START).join('\n') + '\n');
  w.readNew(false);
  assert.ok(events.some((x) => x.t === 'session'));
  assert.ok(events.some((x) => x.t === 'matchLoading'));
  assert.strictEqual(w.parser.localProfileId, 21327806);
});
