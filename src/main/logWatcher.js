'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

// AoE4 simülasyonu saniyede 8 frame ilerler ("Game Over at frame N").
const FRAMES_PER_SECOND = 8;

const RE = {
  time: /^\([A-Z]\) \[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/,
  localProfile: /ProcessMessages: message=\[\d+,"\w+",(\d+),/,
  join: /OnJoinAutomatch - Server told us join matchID=(\d+)/,
  scenario: /GAME -- Scenario:/,
  humanPlayer: /GAME -- Human Player: (\d+) (.+) (\d+) (\d+) (\S+)\s*$/,
  aiPlayer: /GAME -- AI Player: (\d+) (.+?) (-?\d+) (\d+) (\S+)\s*$/,
  start: /GAME -- Starting mission/,
  gameOver: /MOD -- Game Over at frame (\d+)/,
  report: /Report sent for profileID\[(\d+)\] -> race=\[\d+\], result=\[(\d+)\]/,
  locale: /GAME -- \[Age of Empires IV\] set to language \[(\w+)\]/,
};

// Saf ayrıştırıcı: satırları alır, maç durumunu tutar ve olay listesi döndürür.
// Dosya/zaman bağımlılığı yok, böylece gerçek log parçalarıyla test edilebilir.
class LogParser {
  constructor() {
    this.localProfileId = null;
    this.pendingMatchId = null;
    this.match = null;
  }

  feed(line) {
    const events = [];
    const at = parseLineTime(line);
    let m;

    // Oyuncu satırları tek blok halinde yazılır; bloktan sonraki ilk satırda listeyi bir kez yayınla.
    const playerLine = this.match && this.match.phase === 'loading' && (RE.humanPlayer.exec(line) || RE.aiPlayer.exec(line));
    if (!playerLine && this.match && this.match.phase === 'loading' && !this.match.announced && this.match.players.length) {
      this.match.announced = true;
      events.push({ type: 'matchLoading', match: this.snapshot() });
    }

    if (!this.localProfileId && (m = RE.localProfile.exec(line))) {
      this.localProfileId = Number(m[1]);
      events.push({ type: 'localProfile', profileId: this.localProfileId });
    } else if ((m = RE.join.exec(line))) {
      // Eşleşme bulundu: ulus seçme ekranı açılıyor (harita görünür, rakipler henüz görünmez).
      // Sunucu aynı maçı ikinci kez söyleyebilir; bir kez bildirilir.
      const id = Number(m[1]);
      if (id !== this.pendingMatchId) events.push({ type: 'matchFound', matchId: id, at });
      this.pendingMatchId = id;
    } else if (RE.scenario.test(line)) {
      this.match = {
        matchId: this.pendingMatchId,
        players: [],
        phase: 'loading',
        loadingAt: at,
        startedAt: null,
        endedAt: null,
        durationSec: null,
        results: {},
        announced: false,
      };
      this.pendingMatchId = null;
    } else if (playerLine) {
      const isAi = !RE.humanPlayer.test(line);
      this.match.players.push({
        slot: Number(playerLine[1]),
        name: playerLine[2],
        profileId: isAi ? null : Number(playerLine[3]),
        team: Number(playerLine[4]),
        civCode: playerLine[5],
        ai: isAi,
      });
    } else if (this.match && RE.start.test(line)) {
      this.match.phase = 'playing';
      this.match.startedAt = at;
      events.push({ type: 'matchStarted', match: this.snapshot() });
    } else if (this.match && (m = RE.gameOver.exec(line))) {
      this.match.phase = 'ended';
      this.match.endedAt = at;
      this.match.durationSec = Math.round(Number(m[1]) / FRAMES_PER_SECOND);
      events.push({ type: 'matchEnded', match: this.snapshot() });
    } else if (this.match && (m = RE.report.exec(line))) {
      this.match.results[m[1]] = m[2] === '1' ? 'win' : 'loss';
      events.push({ type: 'matchResult', match: this.snapshot() });
    }
    return events;
  }

  snapshot() {
    return this.match ? JSON.parse(JSON.stringify(this.match)) : null;
  }
}

// Log satırındaki "[HH:MM:SS.mmm]" yerel saatini bugünün tarihiyle epoch ms'ye çevirir.
// Gece yarısını aşan oturumlarda gelecekte kalan saat bir gün geriye alınır.
function parseLineTime(line, now = new Date()) {
  const m = RE.time.exec(line);
  if (!m) return null;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));
  if (d.getTime() - now.getTime() > 60 * 1000) d.setDate(d.getDate() - 1);
  return d.getTime();
}

// Belgeler klasörü OneDrive'a yönlenmiş olabilir; Electron'da app.getPath('documents') verilmeli.
// Verilmezse bilinen aday klasörleri sırayla dener.
function defaultLogPath(documentsDir) {
  const rel = path.join('My Games', 'Age of Empires IV', 'warnings.log');
  if (documentsDir) return path.join(documentsDir, rel);
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Documents'),
    ...['OneDrive', 'OneDrive - Personal'].flatMap((od) => ['Documents', 'Belgeler'].map((d) => path.join(home, od, d))),
  ].map((d) => path.join(d, rel));
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

// warnings.log dosyasını izler. Oyun her açılışta dosyayı baştan yazar; boyut küçülünce
// başa sarıp yeni oturumu ayrıştırırız. Uygulama maç ortasında açılırsa geçmiş satırlar
// sessizce işlenir ve sadece son durum ("catchUp") bildirilir.
class LogWatcher extends EventEmitter {
  constructor(logPath = defaultLogPath(), { intervalMs = 1000 } = {}) {
    super();
    this.logPath = logPath;
    this.intervalMs = intervalMs;
    this.offset = 0;
    this.partial = '';
    this.parser = new LogParser();
    this.timer = null;
  }

  start() {
    this.readNew(true);
    this.timer = setInterval(() => this.readNew(false), this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // Bir dinleyicideki hata kalan satırları (ör. maç sonu) kaybettirmesin.
  safeEmit(type, ev) {
    try {
      this.emit(type, ev);
    } catch (err) {
      console.error(`log olayı işlenemedi (${type}):`, err);
    }
  }

  readNew(isCatchUp) {
    let stat;
    try {
      stat = fs.statSync(this.logPath);
    } catch {
      if (isCatchUp) this.emit('missing', this.logPath);
      return;
    }
    if (stat.size < this.offset) {
      // Oyun yeniden başlatıldı: yeni oturum.
      this.offset = 0;
      this.partial = '';
      const prevProfile = this.parser.localProfileId;
      this.parser = new LogParser();
      this.parser.localProfileId = prevProfile;
      this.emit('session');
    }
    if (stat.size === this.offset) return;

    const fd = fs.openSync(this.logPath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = stat.size;
      const text = this.partial + buf.toString('utf8');
      const lines = text.split(/\r?\n/);
      this.partial = lines.pop();
      for (const line of lines) {
        for (const ev of this.parser.feed(line)) {
          if (isCatchUp) {
            // Geçmiş satırlar: sadece profili ve sonuçlanmış maçları (geçmişe kayıt için) bildir.
            if (ev.type === 'localProfile') this.safeEmit(ev.type, ev);
            if (ev.type === 'matchResult') this.safeEmit('pastMatch', ev);
          } else {
            this.safeEmit(ev.type, ev);
          }
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    if (isCatchUp) this.emit('catchUp', { match: this.parser.snapshot(), localProfileId: this.parser.localProfileId });
  }
}

module.exports = { LogParser, LogWatcher, parseLineTime, defaultLogPath, FRAMES_PER_SECOND };
