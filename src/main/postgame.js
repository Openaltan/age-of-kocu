'use strict';

const fs = require('fs');
const path = require('path');
const { parseReplay } = require('./replay');
const { analyzeReplay, coachFindings, summaryFor } = require('./analysis');

const KEEP_REPLAYS = 30;
const STABLE_MS = 4000;
const STABLE_TIMEOUT_MS = 90 * 1000;

// Maç sonrası derin analiz: oyunun yazdığı temp.rec'i maç bittikten sonra kopyalar,
// ayrıştırır, analiz eder ve sonucu diske yazar.
class PostGame {
  constructor({ dataDir, playbackDir, gamedata, isMatchInProgress }) {
    this.playbackDir = playbackDir;
    this.gamedata = gamedata;
    this.isMatchInProgress = isMatchInProgress;
    this.replaysDir = path.join(dataDir, 'replays');
    this.analysesDir = path.join(dataDir, 'analyses');
    fs.mkdirSync(this.replaysDir, { recursive: true });
    fs.mkdirSync(this.analysesDir, { recursive: true });
  }

  analysisPath(matchId) {
    return path.join(this.analysesDir, `${matchId}.json`);
  }

  has(matchId) {
    return fs.existsSync(this.analysisPath(matchId));
  }

  load(matchId) {
    try {
      return JSON.parse(fs.readFileSync(this.analysisPath(matchId), 'utf8'));
    } catch {
      return null;
    }
  }

  // Analiz dosyasına ek alan yazar (ör. YZ raporu).
  saveExtra(matchId, extra) {
    const a = this.load(matchId);
    if (!a) return;
    fs.writeFileSync(this.analysisPath(matchId), JSON.stringify({ ...a, ...extra }));
  }

  // match: log'dan gelen biten maç. localName: yerel oyuncunun adı. build: maçta kullanılan build.
  async analyzeMatch(match, { localName, build } = {}) {
    // Adil oyun: maç sürerken kayıt dosyası rakip komutlarını da içerir; asla okunmaz.
    if (this.isMatchInProgress()) throw new Error('Maç sürerken kayıt okunmaz');
    const src = path.join(this.playbackDir, 'temp.rec');
    await waitUntilStable(src);
    if (this.isMatchInProgress()) throw new Error('Maç sürerken kayıt okunmaz');

    const buf = fs.readFileSync(src);
    const parsed = parseReplay(buf, this.gamedata);
    if (!samePlayers(parsed.players, match.players)) throw new Error('temp.rec bu maça ait değil');

    const copy = path.join(this.replaysDir, `${match.matchId}.rec`);
    fs.writeFileSync(copy, buf);
    this.pruneReplays();

    const result = this.build(parsed, { localName, build });
    result.matchId = match.matchId;
    fs.writeFileSync(this.analysisPath(match.matchId), JSON.stringify(result));
    return result;
  }

  // Kullanıcının seçtiği eski bir kayıt dosyası (kaydedilmiş replay). Saklanmaz, sadece gösterilir.
  analyzeFile(file, { localName } = {}) {
    if (this.isMatchInProgress()) throw new Error('Maç sürerken kayıt okunmaz');
    const parsed = parseReplay(fs.readFileSync(file), this.gamedata);
    const result = this.build(parsed, { localName });
    result.source = path.basename(file);
    return result;
  }

  build(parsed, { localName, build }) {
    const report = analyzeReplay(parsed, this.gamedata);
    const me = report.players.find((p) => p.name === localName) || null;
    return {
      analyzedAt: Date.now(),
      report,
      localPid: me ? me.pid : null,
      findings: me ? coachFindings(report, me, { build }) : [],
      summary: me ? summaryFor(me) : null,
      buildName: build?.name || null,
    };
  }

  pruneReplays() {
    const files = fs.readdirSync(this.replaysDir)
      .filter((f) => f.endsWith('.rec'))
      .map((f) => ({ f, t: fs.statSync(path.join(this.replaysDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(KEEP_REPLAYS)) fs.rmSync(path.join(this.replaysDir, f), { force: true });
  }
}

// Kayıt bu maça mı ait: maçtaki (log) oyuncuların en fazla biri kayıtta bulunamayabilir ve kayıtta
// maçta olmayan en fazla bir isim olabilir. Tek bir okunamayan oyuncu (ör. erken düşen) analizi düşürmesin.
function samePlayers(replayPlayers, matchPlayers) {
  const a = new Set(replayPlayers.map((p) => p.name));
  const b = new Set(matchPlayers.map((p) => p.name));
  const missing = [...b].filter((n) => !a.has(n)).length;
  const extra = [...a].filter((n) => !b.has(n)).length;
  return b.size > 0 && missing <= 1 && extra <= 1 && missing < b.size / 2;
}

// Oyun maç sonunda dosyayı bir süre daha yazabilir; boyut ve zaman STABLE_MS boyunca
// değişmeyene kadar bekler.
async function waitUntilStable(file) {
  const start = Date.now();
  let last = '';
  let since = Date.now();
  while (Date.now() - start < STABLE_TIMEOUT_MS) {
    const st = fs.statSync(file);
    const sig = `${st.size}:${st.mtimeMs}`;
    if (sig !== last) {
      last = sig;
      since = Date.now();
    } else if (Date.now() - since >= STABLE_MS) {
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

module.exports = { PostGame, samePlayers };
