'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell, dialog, nativeImage, safeStorage } = require('electron');
const { LogWatcher, defaultLogPath } = require('./logWatcher');
const { Store } = require('./store');
const { BuildLibrary } = require('./aoe4guides');
const { Coach, buildAlerts, enemyLabels, pickBuild, customBuildFrom } = require('./coach');
const { NoteBoard } = require('./notes');
const { TeamSync, teamNotes } = require('./teamSync');
const aoe4world = require('./aoe4world');
const scout = require('./scout');
const civs = require('./civs');
const { PostGame } = require('./postgame');
const gamedata = require('./data/gamedata.json');
const { ScreenReader, captureScreen, areaBitmap } = require('./screenReader');
const { HudState, HudCoach, FIELDS, AREAS, fitDistribution, distributionLine } = require('./hud');
const fs = require('fs');
const { AiCoach, ClaudeProvider, GeminiProvider } = require('./aiCoach');
const aiContext = require('./aiContext');
const { mmss } = require('./analysis');
const { MinimapWatcher, scoreboardRows, PALETTE, hueDist, hsv } = require('./minimap');
const { LiveMonitor } = require('./liveEvents');
const { BaseLedger, AGE_NAMES } = require('./baseLedger');

const RENDERER = path.join(__dirname, '..', 'renderer');
const TICK_MS = 500;
const AOE4WORLD_SYNC_DELAYS_MS = [90 * 1000, 4 * 60 * 1000, 10 * 60 * 1000];
// Canlı YZ çağrılarının sıklığı: olay tetiklemeli + periyodik. Kota için maç başına üst sınır.
const LIVE_URGENT_COOLDOWN_MS = 20 * 1000; // tehlike olayından sonra en erken yeniden çağrı
const LIVE_EVENT_COOLDOWN_MS = 45 * 1000; // bilgi olayları (ordu görüldü, çağ atlandı)
const LIVE_COMBAT_INTERVAL_MS = 30 * 1000; // savaş modunda periyot
const LIVE_MAX_AUTO_CALLS = 80;
const LIVE_COMMAND_INTERVAL_MS = 45 * 1000; // yönet modunda sakin anlarda da 45 sn'de bir komut
const LIVE_MAX_COMMAND_CALLS = 150;
const LIVE_STUCK_MS = 150 * 1000; // bundan uzun süren çağrı takılmış sayılır
const IDENTIFY_RETRY_MS = 60 * 1000;
const IDENTIFY_COOLDOWN_MS = 15 * 1000;

let store;
let library;
let watcher;
let postgame;
let screenReader;
let hudState = new HudState();
const hudCoach = new HudCoach();
let lastHud = null;
// Yapay zekâ sağlayıcıları; Ayarlar'dan seçilir (varsayılan Gemini: ücretsiz katman).
const KEY_FIELD = { gemini: 'geminiKeyEnc', claude: 'aiKeyEnc' };
const providers = {
  gemini: new GeminiProvider({ getApiKey: () => readApiKey('gemini') }),
  claude: new ClaudeProvider({ getApiKey: () => readApiKey('claude') }),
};
const ai = new AiCoach({ getProvider: () => providers[store?.settings.aiProvider] || providers.gemini });
let aiLiveBusy = false;
let aiLiveOn = false; // maç sürerken otomatik değerlendirme açık mı
let lastLiveAt = 0; // son YZ değerlendirmesinin başladığı an (ms)
let liveStartAt = 0; // otomatik değerlendirmenin başladığı an: ilk periyodik bakış bir aralık sonra
let pendingTrigger = null; // bekleme süresi yüzünden ertelenen tetik
let liveAutoCalls = 0;
// Maç içi yerel algılayıcılar: olaylar/savaş modu, mini harita, oyuncu listesi, üs defteri.
const monitor = new LiveMonitor();
const minimapWatcher = new MinimapWatcher();
const ledger = new BaseLedger();
let areaRegions = null; // { minimap, scoreboard } fiziksel piksel
let scoreRows = null; // oyuncu listesinin son okunan satırları
let players = null; // [{ key, name, role, hue, renk, cag }] (YZ ya da yerel okuma)
let playersSource = null; // 'ai' | 'local'
let identifyBusy = false;
let identifyAt = 0;
let identifyWanted = false;
let autoCandidates = null; // "Otomatik" build seçiliyken ülkenin build listesi
let aiTarget = null; // { target: {food,wood,gold,stone}, at } YZ'nin son hedef köylü dağılımı
let liveSeq = 0; // takılan YZ çağrısının geç gelen sonucunu yok saymak için
const notes = new NoteBoard();
let hudNotes = [];
let lastNotesJson = '';
let lastStepIndex = null;
let aiRisk = null; // takım arkadaşlarına iletilen son YZ uyarısı
let team = null; // TeamSync
let lastTeamSend = 0;

// Takım odası sunucusu (server/team-room). Ayarlardan değiştirilebilir.
const DEFAULT_TEAM_SERVER = 'https://age-of-kocu-team.altanarla01.workers.dev';
let dashboardWin = null;
let overlayWin = null;
let tickTimer = null;
const coach = new Coach();

// Panel ve overlay'in gördüğü tek durum nesnesi.
const state = {
  logPath: null,
  logFound: false,
  localProfileId: null,
  phase: 'idle', // idle | loading | playing | ended
  simulated: false,
  match: null,
  scouting: null,
  scoutingError: null,
  myCiv: null,
  build: null,
  cardsVisible: true,
  cardsPinned: false,
  overlayEnabled: true,
  analysis: null, // { matchId, status: 'running' | 'done' | 'error', message }
  screenReading: false, // maç sırasında ekran okuma aktif mi
  version: app.getVersion(),
  update: null, // { status: 'downloading' | 'ready', version, percent }
  buildAuto: null, // otomatik build: { status: 'waiting' | 'done', name, reason, source }
  ai: { available: false, plan: null, planStatus: null, planError: null, live: [], liveStatus: null, liveError: null, combat: false, players: null },
};

function broadcast(channel, payload) {
  for (const w of [dashboardWin, overlayWin]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function pushState() {
  broadcast('state', state);
}

// ---------- Maç akışı ----------

function myPlayer(match) {
  return match?.players.find((p) => p.profileId === state.localProfileId) || null;
}

async function loadBuildFor(match) {
  const me = myPlayer(match);
  const civ = me ? civs.fromLogCode(me.civCode) : null;
  state.myCiv = civ ? { slug: civ.slug, tr: civ.tr, guide: civ.guide } : null;
  state.build = null;
  state.buildAuto = null;
  autoCandidates = null;
  if (!civ) return null;
  try {
    const choice = store.settings.buildByCiv[civ.slug];
    if (choice === 'auto' || choice === 'serbest') {
      // Otomatik: rakipler belli olunca koç (ya da kural) hazır build'lerden seçer.
      // Serbest: koç rakibe göre özel build yazar. İkisinde de o zamana kadar en yüksek puanlı build.
      autoCandidates = await library.list(civ.guide);
      state.buildAuto = { status: 'waiting', mode: choice };
      useBuild(autoCandidates[0] || null);
    } else {
      useBuild(await library.get(civ.guide, choice));
    }
  } catch (err) {
    console.warn('build alınamadı:', err.message);
  }
  return state.build;
}

// Build'i koça verir; Türkçe notlar arka planda gelir, gelince adım konumu korunarak güncellenir.
function useBuild(build) {
  state.build = build;
  if (state.phase === 'playing') coach.setBuild(build);
  translateBuild(build).then((tr) => {
    if (tr !== build && state.build === build) {
      state.build = tr;
      coach.replaceBuild(tr);
      pushState();
    }
  }).catch((err) => console.warn('çeviri:', err.message));
}

// Otomatik build kararı (YZ ya da kural). Sadece "Otomatik" seçiliyken ve bir kez uygulanır.
function applyAutoBuild(build, reason, source, extra = {}) {
  if (!autoCandidates || !build || state.buildAuto?.status === 'done') return;
  if (build.id !== state.build?.id) useBuild(build);
  state.buildAuto = { status: 'done', mode: state.buildAuto?.mode || 'auto', name: build.name, reason: reason || null, source, ...extra };
  notes.push('auto-build', 'info', `Build: ${build.name}`, 40);
  pushNotes();
  pushState();
}

function autoBuildByRule() {
  if (!autoCandidates) return;
  const p = pickBuild(autoCandidates, state.scouting);
  // Serbest istenip YZ yazamadıysa hazır build'e düşüldüğü belli olsun.
  const reason = state.buildAuto?.mode === 'serbest' ? `Özel build yazılamadı, hazır build: ${p.reason}` : p.reason;
  applyAutoBuild(p.build, reason, 'kural');
}

// Plan geldiğinde otomatik/serbest kararını uygular.
function applyPlanBuild(plan) {
  if (!autoCandidates || state.buildAuto?.status !== 'waiting') return;
  if (state.buildAuto.mode === 'serbest') {
    const custom = customBuildFrom(plan.ozelBuild, `ozel-${state.match?.matchId || Date.now()}`);
    if (custom) {
      applyAutoBuild(custom, plan.ozelBuild.oyunStili, 'YZ · serbest', { kilitNoktalar: plan.ozelBuild.kilitNoktalar || [] });
      return;
    }
  } else {
    const picked = autoCandidates.find((b) => b.id === plan.buildSecimi);
    if (picked) {
      applyAutoBuild(picked, plan.buildGerekcesi, 'YZ');
      return;
    }
  }
  autoBuildByRule();
}

async function onMatchLoading(match, { simulated = false } = {}) {
  state.phase = 'loading';
  state.simulated = simulated;
  state.match = match;
  state.scouting = null;
  state.scoutingError = null;
  state.cardsVisible = true;
  notes.clear();
  hudNotes = [];
  aiRisk = null;
  lastStepIndex = null;
  resetLiveWatch();
  pushState();
  pushNotes();

  const buildReady = loadBuildFor(match).then(pushState);
  try {
    const result = await scout.scoutMatch(match, state.localProfileId);
    if (state.match !== match) return; // bu arada yeni maç başladıysa eski sonucu at
    state.scouting = result;
    for (const n of enemyLabels(result)) notes.push(n.key, n.level, n.text, 240);
    pushNotes();
    // Analiz maç başladıktan sonra bittiyse uyarıları sonradan yükle.
    if (state.phase === 'playing') coach.alerts = buildAlerts(result);
    // Otomatik build seçimi için aday listesi hazır olsun.
    await buildReady.catch(() => {});
    if (state.match !== match) return;
    if (!aiOn('aiPrematch')) autoBuildByRule();
    runPrematch(match);
  } catch (err) {
    state.scoutingError = err.message;
    autoBuildByRule();
  }
  pushState();
}

async function onMatchStarted(match, { simulated = false } = {}) {
  const known = !simulated && state.match && state.match.matchId === match.matchId;
  // Aynı nesneyi güncelliyoruz: arka planda süren analiz, sonucunu bu nesneye bağlı kontrol ediyor.
  if (known) Object.assign(state.match, { phase: match.phase, startedAt: match.startedAt });
  else onMatchLoading(match, { simulated }); // yükleme ekranı kaçırıldıysa analizi şimdi başlat
  state.phase = 'playing';
  const build = state.build || (await loadBuildFor(match));
  coach.start(match.startedAt || Date.now(), build, state.scouting);
  startTicking();
  startScreenReading();
  startAiLive();
  connectTeam(state.match);
  // Kalibrasyon yoksa ekran okuma, mini harita ve kayıp algılama çalışmaz: oyuncu bilsin.
  if (!store.settings.hudRegions?.fields) notes.push('calib', 'info', 'Ekran okuma kapalı: Ctrl+Alt+K ile kalibre et', 60);
  else if (!store.settings.screenReadingEnabled) notes.push('calib', 'info', 'Ekran okuma ayarlardan kapalı', 30);
  pushNotes();
  pushState();
}

// ---------- Not panosu (sade overlay) ----------

function pushNotes() {
  const list = notes.list();
  const json = JSON.stringify(list);
  if (json !== lastNotesJson) {
    lastNotesJson = json;
    broadcast('notes', list);
  }
}

function stepShort(step) {
  const parts = [['food', 'yemek'], ['wood', 'odun'], ['gold', 'altın'], ['stone', 'taş']].filter(([k]) => step[k] > 0).map(([k, tr]) => `${step[k]} ${tr}`);
  return `${step.villagers ? `${step.villagers} köylü` : 'Köylüler'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

// ---------- Takım senkronu ----------

function teamServer() {
  return store.settings.teamServerUrl || DEFAULT_TEAM_SERVER;
}

function connectTeam(match) {
  disconnectTeam();
  const code = store.settings.teamCode; // boşsa otomatik mod
  const me = myPlayer(match);
  if (store.settings.teamSyncEnabled === false || !teamServer() || !me) return;
  team = new TeamSync({ serverUrl: teamServer() });
  team.on('change', () => {
    state.team = teamView();
    broadcast('team', state.team);
  });
  team.on('ping', (from, data) => {
    if (data?.kind === 'yardım') notes.push(`ping-${from.id}`, 'danger', `${from.name} yardım istiyor!`, 30);
    pushNotes();
  });
  const allowedIds = match.players.filter((p) => p.team === me.team && p.profileId).map((p) => p.profileId);
  team.connect({ teamCode: code, matchId: match.matchId, me: { id: me.profileId, name: me.name }, allowedIds });
  state.team = teamView();
}

function disconnectTeam() {
  team?.disconnect();
  team = null;
  state.team = null;
  broadcast('team', null);
}

function teamView() {
  if (!team) return null;
  return { connected: team.connected, members: team.liveMembers().map((m) => ({ id: m.id, name: m.name, status: m.status, ago: Math.round((Date.now() - m.at) / 1000) })) };
}

// Takım arkadaşlarına 3 sn'de bir kendi durumumu yollarım (sadece kendi ekranımdan okunanlar).
function sendTeamStatus(elapsed) {
  if (!team || Date.now() - lastTeamSend < 3000) return;
  lastTeamSend = Date.now();
  const h = lastHud;
  team.sendStatus({
    civ: state.myCiv?.tr || null,
    elapsed,
    villagers: h?.villagers ?? null,
    pop: h?.pop ? `${h.pop.cur}/${h.pop.cap}` : null,
    res: h ? h.res : null,
    idle: h?.idle ?? null,
    // YZ uyarısı yoksa yerel algılayıcının tehlike notu (ör. "Üssünde düşman · güney tarafı").
    risk: aiRisk || monitor.notes().find((n) => n.level === 'danger')?.text || null,
    notes: hudNotes.filter((n) => n.level === 'danger').map((n) => n.text).slice(0, 3),
  });
}

// ---------- Yapay zekâ koç ----------
// Anahtar Windows'un kullanıcıya özel şifrelemesiyle (DPAPI / safeStorage) saklanır.

function readApiKey(provider) {
  const enc = store?.settings[KEY_FIELD[provider]];
  if (!enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return null;
  }
}

function saveApiKey(provider, key) {
  const field = KEY_FIELD[provider];
  if (!field) throw new Error('Bilinmeyen sağlayıcı');
  const k = String(key || '').trim();
  if (!k) {
    store.updateSettings({ [field]: null });
  } else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Bu bilgisayarda şifreli depolama kullanılamıyor');
    store.updateSettings({ [field]: safeStorage.encryptString(k).toString('base64') });
  }
  refreshAiState();
}

function refreshAiState() {
  state.ai.available = ai.available();
  state.ai.provider = store.settings.aiProvider || 'gemini';
  state.ai.keys = { gemini: Boolean(store.settings.geminiKeyEnc), claude: Boolean(store.settings.aiKeyEnc) };
  pushState();
}

function aiOn(flag) {
  return ai.available() && store.settings[flag] !== false;
}

// Oyunun session_data.txt dosyasındaki "module = MP_[Dere Tepe_Ilıman Avrupa]_..." satırından harita adı.
function readMapName() {
  try {
    const txt = fs.readFileSync(path.join(path.dirname(state.logPath), 'session_data.txt'), 'utf8');
    const m = /module = MP_\[(.+)\]_\d+/.exec(txt);
    if (!m) return null;
    const i = m[1].lastIndexOf('_');
    return i > 0 ? m[1].slice(0, i) : m[1];
  } catch {
    return null;
  }
}

async function runPrematch(match) {
  if (!aiOn('aiPrematch') || !state.scouting) return;
  Object.assign(state.ai, { plan: null, planStatus: 'running', planError: null, live: [] });
  pushState();
  try {
    const context = aiContext.prematchContext({
      scouting: state.scouting,
      myCiv: state.myCiv,
      build: state.build,
      candidates: state.buildAuto?.status === 'waiting' && state.buildAuto.mode === 'auto' ? autoCandidates : null,
      specials: aiContext.civSpecials(gamedata, civs.fromSlug(state.myCiv?.slug)?.data, 3),
      matches: store.matches,
      loadAnalysis: (id) => postgame.load(id),
      mapName: readMapName(),
      localName: myPlayer(match)?.name || null,
    });
    const custom = state.buildAuto?.status === 'waiting' && state.buildAuto.mode === 'serbest';
    const plan = await ai.prematchPlan(context, { custom });
    if (state.match !== match) return;
    Object.assign(state.ai, { plan, planStatus: 'done' });
    coach.addAlerts(plan.planAdimlari.map((a) => ({ at: Math.round(a.dakika * 60), level: 'info', text: `Koç: ${a.mesaj}`, short: a.mesaj })));
    if (match.matchId) store.saveMatch({ matchId: match.matchId, aiPlan: plan });
    applyPlanBuild(plan);
  } catch (err) {
    Object.assign(state.ai, { planStatus: 'error', planError: err.message });
    if (state.match === match) autoBuildByRule();
  }
  pushState();
}

// En son yakalanan kare 2 sn'den tazeyse onu kullanır (ekran okuma zaten saniyede bir yakalıyor).
async function freshFrame() {
  const last = screenReader?.lastFrame;
  if (last && Date.now() - last.at < 2000) return last.image;
  return captureScreen();
}

// YZ'ye gidecek görüntüler: tam ekran (küçültülmüş) ve varsa mini haritanın yakın görüntüsü.
async function liveImages() {
  if (store.settings.aiVision === false) return [];
  const img = await freshFrame();
  const out = [{ data: img.resize({ width: 1280, quality: 'good' }).toJPEG(70).toString('base64'), mediaType: 'image/jpeg', label: 'oyuncunun tam ekranı' }];
  if (areaRegions?.minimap) {
    const mm = areaBitmap(img, areaRegions.minimap).image;
    out.push({ data: mm.resize({ width: Math.max(400, mm.getSize().width), quality: 'good' }).toJPEG(85).toString('base64'), mediaType: 'image/jpeg', label: 'mini harita (yakın)' });
  }
  return out;
}

function commandMode() {
  return store.settings.coachMode === 'yonet';
}

function liveIntervalMs() {
  if (monitor.combat) return LIVE_COMBAT_INTERVAL_MS;
  if (commandMode()) return LIVE_COMMAND_INTERVAL_MS;
  return Math.max(1, Number(store.settings.aiLiveIntervalMin) || 3) * 60 * 1000;
}

// Olay ya da periyot YZ değerlendirmesi ister. Bekleme süresi dolmadıysa tetik ertelenir;
// tehlike tetikleri bilgi tetiklerinin yerini alır.
function requestLive(trigger) {
  if (!aiLiveOn || !ai.available() || store.settings.aiLive === false || state.phase !== 'playing') return;
  if (liveAutoCalls >= (commandMode() ? LIVE_MAX_COMMAND_CALLS : LIVE_MAX_AUTO_CALLS)) return;
  const cooldown = trigger.urgent ? LIVE_URGENT_COOLDOWN_MS : LIVE_EVENT_COOLDOWN_MS;
  if (aiLiveBusy || Date.now() - lastLiveAt < cooldown) {
    if (!pendingTrigger || (trigger.urgent && !pendingTrigger.urgent)) pendingTrigger = trigger;
    return;
  }
  pendingTrigger = null;
  liveAutoCalls++;
  runLive({ trigger });
}

// Her tikte: ertelenen tetik ya da periyodu dolan değerlendirme.
function scheduleLive() {
  if (!aiLiveOn) return;
  // Takılan istek koçu maç boyunca susturmasın: süresi aşan çağrı bırakılır, sonucu yok sayılır.
  if (aiLiveBusy && Date.now() - lastLiveAt > LIVE_STUCK_MS) {
    console.warn('YZ değerlendirmesi takıldı; bırakılıyor');
    liveSeq++;
    aiLiveBusy = false;
  }
  if (aiLiveBusy) return;
  if (pendingTrigger) {
    const cooldown = pendingTrigger.urgent ? LIVE_URGENT_COOLDOWN_MS : LIVE_EVENT_COOLDOWN_MS;
    if (Date.now() - lastLiveAt >= cooldown) requestLive(pendingTrigger);
    return;
  }
  if (Date.now() - Math.max(lastLiveAt, liveStartAt) >= liveIntervalMs()) requestLive({ reason: null, periodic: true });
}

async function runLive({ manual = false, trigger = null } = {}) {
  if (aiLiveBusy || state.phase !== 'playing' || !ai.available()) return;
  if (!manual && store.settings.aiLive === false) return;
  aiLiveBusy = true;
  const seq = ++liveSeq;
  lastLiveAt = Date.now();
  const combat = monitor.combat;
  const command = commandMode();
  Object.assign(state.ai, { liveStatus: 'running', liveError: null });
  pushState();
  try {
    const elapsed = coach.elapsed();
    const buildView = coach.buildView();
    const me = players?.find((p) => p.role === 'me');
    const context = aiContext.liveContext({
      elapsedSec: elapsed,
      hud: lastHud,
      buildView,
      team: team ? team.liveMembers() : [],
      myCiv: state.myCiv,
      plan: state.ai.plan,
      lastAssessment: state.ai.live[0] || null,
      scouting: state.scouting,
      combat,
      trigger: trigger?.reason || (manual ? 'oyuncu sordu' : null),
      events: monitor.recent(elapsed),
      mapSightings: minimapWatcher.recent(elapsed),
      ledger: ledger.context(state.build, buildView ? buildView.index : -1),
      specials: aiContext.civSpecials(gamedata, civs.fromSlug(state.myCiv?.slug)?.data, ledger.age || 1),
      myColor: me?.renk || null,
      localName: myPlayer(state.match)?.name || null,
    });
    const res = await ai.liveAssessment(context, await liveImages(), { combat, command });
    if (seq !== liveSeq || state.phase !== 'playing') return;
    const simdiYap = res.simdiYap || [];
    const uret = res.uret || [];
    const komutlar = command ? (res.komutlar || []).filter((k) => k?.metin).slice(0, 4) : [];
    // Köylü dağılımı: YZ'nin oranları ekrandan okunan gerçek köylü sayısına oturtulur (toplam tutar).
    const target = combat ? null : fitDistribution(res.dagilim, lastHud?.villagers ?? null);
    aiTarget = target ? { target, at: Date.now() } : null;
    ledger.observe(res.gozlem, mmss(elapsed));
    state.ai.live = [{ at: mmss(elapsed), combat, command, trigger: trigger?.reason || null, ...res, simdiYap, uret, komutlar, hedefDagilim: target ? distributionLine(target) : null }, ...state.ai.live].slice(0, 6);
    state.ai.liveStatus = 'done';
    broadcast('alert', { level: res.risk === 'yüksek' ? 'danger' : 'info', text: `Koç: ${komutlar[0]?.metin || simdiYap[0] || res.durum}` });
    // Sade overlay: her değerlendirme bir öncekinin notlarının yerini alır (bayat tavsiye kalmasın).
    const ttl = Math.round(liveIntervalMs() / 1000) + 60;
    aiRisk = res.uyari && res.risk !== 'düşük' ? res.uyari : null;
    notes.remove('ai-err');
    setOrRemove('ai-risk', res.risk === 'yüksek' ? 'danger' : 'info', res.uyari, ttl);
    notes.removeWhere((n) => n.key.startsWith('cmd-'));
    if (command) {
      // Yönet modu: sıralı komutlar + hedef dağılım; ayrı "şimdi/üret/geliştir" notlarına gerek yok.
      komutlar.forEach((k, i) => notes.push(`cmd-${i}`, 'cmd', `${i + 1}. ${k.metin}`, ttl));
      for (const key of ['ai-do', 'ai-uret', 'ai-gelistir']) notes.remove(key);
      setOrRemove('cmd-dist', 'cmd', target ? distributionLine(target) : '', ttl);
    } else {
      setOrRemove('ai-do', 'info', simdiYap[0], 120);
      setOrRemove('ai-uret', 'info', uret.length ? `Üret: ${uret.join(' · ')}` : '', ttl);
      setOrRemove('ai-gelistir', 'info', res.gelistir ? `Geliştir: ${res.gelistir}` : '', ttl);
    }
    pushNotes();
  } catch (err) {
    if (seq !== liveSeq) return;
    Object.assign(state.ai, { liveStatus: 'error', liveError: err.message });
    // Sessizce susmasın: koçun neden bakamadığı overlay'de de görünsün.
    notes.push('ai-err', 'info', `Koç bakamadı: ${err.message}`.slice(0, 70), 90);
    pushNotes();
  } finally {
    if (seq === liveSeq) aiLiveBusy = false;
  }
  pushState();
}

// Köylü kaydırma notunun hedefi: yönet modunda (ya da build bitince) YZ'nin son hedefi, yoksa build adımı.
function distributionTarget() {
  const fresh = aiTarget && Date.now() - aiTarget.at < 3 * 60 * 1000;
  const view = coach.buildView();
  if (fresh && (commandMode() || !view || !view.next)) return aiTarget.target;
  return coach.currentStep();
}

function setOrRemove(key, level, text, ttl) {
  if (text) notes.push(key, level, text, ttl);
  else notes.remove(key);
}

function startAiLive() {
  aiLiveOn = true;
  // İlk periyodik değerlendirme bir aralık sonra; olaylar beklemeden tetikler.
  liveStartAt = Date.now();
  lastLiveAt = 0;
}

function stopAiLive() {
  aiLiveOn = false;
  pendingTrigger = null;
}

// ---------- Maç içi yerel algılayıcılar ----------

function resetLiveWatch() {
  monitor.reset();
  minimapWatcher.reset();
  minimapWatcher.setPlayers([]);
  ledger.reset();
  scoreRows = null;
  players = null;
  playersSource = null;
  identifyAt = 0;
  identifyWanted = false;
  liveAutoCalls = 0;
  pendingTrigger = null;
  aiTarget = null;
  state.ai.combat = false;
  state.ai.players = null;
}

// Yerel algılayıcının sonucuna göre notlar, savaş modu ve YZ tetikleri.
function handleMonitor(res) {
  for (const e of res.fresh) {
    if (e.level === 'danger') requestLive({ reason: e.text, urgent: true });
    else if (e.kind === 'army' || e.kind === 'ageup' || e.kind === 'ally') requestLive({ reason: e.text });
  }
  if (res.combatStarted) {
    // Savaş başladı: ekonomi/plan notları bayatladı, hemen kaldır.
    notes.removeWhere((n) => ['ai-do', 'ai-uret', 'ai-gelistir', 'step'].includes(n.key) || n.key.startsWith('alert-'));
    state.ai.combat = true;
    pushNotes();
    pushState();
  }
  if (res.combatEnded) {
    state.ai.combat = false;
    requestLive({ reason: 'Savaş bitti: toparlanma planı' });
    pushState();
  }
  if (res.rowsChanged.length) {
    identifyWanted = true;
    // YZ yoksa en azından rakip satırındaki değişikliği bildir.
    if (!ai.available()) {
      for (const i of res.rowsChanged) {
        if (scoreRows?.[i]?.enemy) monitor.push(coach.elapsed(), { key: `ageup-row-${i}`, kind: 'ageup', level: 'info', text: 'Bir rakip çağ atladı' });
      }
    }
  }
}

function paletteName(hue) {
  let best = null;
  for (const [name, h] of Object.entries(PALETTE)) if (!best || hueDist(hue, h) < hueDist(hue, PALETTE[best])) best = name;
  return best;
}

// YZ yokken (ya da cevap gelene kadar) oyuncu listesinden: ⚔ işaretli satırlar rakip, diğerleri takım.
function applyLocalPlayers(rows) {
  if (playersSource === 'ai' || !rows?.length || !rows.some((r) => r.enemy)) return;
  players = rows.map((r, i) => ({ key: `row-${i}`, name: r.enemy ? `Rakip (${paletteName(r.hue)})` : `Takım arkadaşı (${paletteName(r.hue)})`, role: r.enemy ? 'enemy' : 'ally', hue: r.hue, renk: paletteName(r.hue), cag: null }));
  playersSource = 'local';
  minimapWatcher.setPlayers(players);
  state.ai.players = players.map(({ name, role, renk, cag }) => ({ name, role, renk, cag }));
}

function playerRole(p) {
  const me = myPlayer(state.match);
  if (!me) return 'ally';
  if (p.profileId === me.profileId) return 'me';
  return p.team === me.team ? 'ally' : 'enemy';
}

// YZ'nin oyuncu listesi okumasını maçtaki oyuncularla eşleştirir; renk tonu mümkünse
// yerel okunan satırdan (daha kesin), değilse renk adından gelir. Çağ değişimleri olay olur.
function applyIdentity(list) {
  const match = state.match;
  if (!match) return;
  const norm = (s) => String(s || '').replace(/\.{3}|…/g, '').trim().toLowerCase();
  const prev = new Map((players || []).map((p) => [p.name, p]));
  const out = [];
  for (const p of match.players) {
    const r = list.find((x) => norm(x.oyuncu) === norm(p.name)) || list.find((x) => norm(p.name).startsWith(norm(x.oyuncu)) && norm(x.oyuncu).length >= 4);
    if (!r) continue;
    const row = scoreRows && r.satir >= 1 && r.satir <= scoreRows.length ? scoreRows[r.satir - 1] : null;
    const hue = row ? row.hue : PALETTE[r.renk] ?? null;
    out.push({ key: row ? `row-${r.satir - 1}` : `p-${p.profileId || p.name}`, name: p.name, role: playerRole(p), hue, renk: row ? paletteName(row.hue) : r.renk, cag: r.cag >= 1 && r.cag <= 4 ? r.cag : null });
  }
  if (!out.length) return;
  const t = coach.elapsed();
  for (const p of out) {
    const before = prev.get(p.name)?.cag;
    if (p.role === 'me' && p.cag) ledger.setAge(p.cag);
    if (before && p.cag && p.cag > before) {
      const text = p.role === 'me' ? `${AGE_NAMES[p.cag]} Çağı'na geçtin` : `${p.name} ${AGE_NAMES[p.cag]} Çağı'nda`;
      monitor.push(t, { key: `ageup-${p.name}`, kind: 'ageup', level: p.role === 'enemy' ? 'danger' : 'info', text });
      requestLive({ reason: text, urgent: p.role === 'enemy' && p.cag >= 3 });
    }
  }
  players = out;
  playersSource = 'ai';
  minimapWatcher.setPlayers(out);
  state.ai.players = out.map(({ name, role, renk, cag }) => ({ name, role, renk, cag }));
  pushState();
}

// Oyuncu listesini YZ'ye okutur: maç başında bir kez (başarısızsa dakikada bir), satır değişince yeniden.
async function maybeIdentify(img) {
  if (identifyBusy || !ai.available() || !state.match || state.simulated) return;
  const since = Date.now() - identifyAt;
  const due = (!players || playersSource !== 'ai') ? since >= IDENTIFY_RETRY_MS : identifyWanted && since >= IDENTIFY_COOLDOWN_MS;
  if (!due || coach.elapsed() < 5) return;
  identifyBusy = true;
  identifyAt = Date.now();
  identifyWanted = false;
  try {
    const image = areaRegions?.scoreboard
      ? { data: areaBitmap(img, areaRegions.scoreboard).image.toPNG().toString('base64'), mediaType: 'image/png' }
      : { data: img.resize({ width: 1600, quality: 'good' }).toJPEG(80).toString('base64'), mediaType: 'image/jpeg' };
    const res = await ai.identifyPlayers(state.match.players.map((p) => p.name), image, scoreRows?.length || 0);
    applyIdentity(res.oyuncular || []);
  } catch (err) {
    console.warn('oyuncu listesi:', err.message);
  } finally {
    identifyBusy = false;
  }
}

// Ekran okumanın her karesinde (OCR'dan önce): oyuncu listesi ve mini harita.
function onFrame(img) {
  if (state.phase !== 'playing' || !areaRegions) return;
  const t = coach.elapsed();
  let rows = null;
  try {
    if (areaRegions.scoreboard) {
      rows = scoreboardRows(areaBitmap(img, areaRegions.scoreboard));
      scoreRows = rows;
      applyLocalPlayers(rows);
    }
    maybeIdentify(img);
    let mapEvents = [];
    if (areaRegions.minimap && minimapWatcher.hasPlayers()) {
      mapEvents = minimapWatcher.update(areaBitmap(img, areaRegions.minimap), t).events;
    }
    handleMonitor(monitor.observe({ t, mapEvents, rows }));
  } catch (err) {
    console.warn('mini harita:', err.message);
  }
}

async function runReport(matchId) {
  const analysis = postgame.load(matchId);
  if (!analysis) throw new Error('Bu maçın analizi yok');
  const match = store.matches.find((m) => m.matchId === matchId) || null;
  const context = aiContext.postgameContext({ analysis, match, matches: store.matches, plan: match?.aiPlan || null });
  const report = await ai.postgameReport(context);
  postgame.saveExtra(matchId, { aiReport: report });
  broadcast('matches', store.matches);
  return report;
}

// Build notlarını Türkçeleştirir; sonuç build kimliğine göre diskte önbelleklenir.
// Aynı build için eşzamanlı istekler tek bir çeviride birleşir.
const translating = new Map();
function translateBuild(build) {
  if (!build || build.translated || !aiOn('aiTranslate')) return Promise.resolve(build);
  if (!translating.has(build.id)) {
    translating.set(build.id, translateBuildUncached(build).finally(() => translating.delete(build.id)));
  }
  return translating.get(build.id);
}

async function translateBuildUncached(build) {
  const file = path.join(app.getPath('userData'), 'cache', `tr-${build.id}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // önbellekte yok: çevir
  }
  const tr = await ai.translateBuild(build);
  fs.writeFileSync(file, JSON.stringify(tr));
  return tr;
}

// ---------- Ekran okuma ----------
// Sadece oyuncunun kendi ekranındaki HUD okunur (kaynak, köylü dağılımı, nüfus, boşta köylü).

function calibrationPath() {
  return path.join(app.getPath('userData'), 'calibration.png');
}

// Kalibrasyon bölgelerini güncel ekran çözünürlüğüne ölçekler.
function scaledRegions(width, height) {
  const cal = store.settings.hudRegions;
  if (!cal || !cal.fields) return null;
  const sx = width / cal.width;
  const sy = height / cal.height;
  return Object.fromEntries(Object.entries(cal.fields).map(([k, r]) => [k, { x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy }]));
}

function startScreenReading() {
  stopScreenReading();
  if (!store.settings.screenReadingEnabled || !store.settings.hudRegions) return;
  const d = screen.getPrimaryDisplay();
  const regions = scaledRegions(Math.round(d.size.width * d.scaleFactor), Math.round(d.size.height * d.scaleFactor));
  const areas = Object.fromEntries(AREAS.filter((a) => regions[a.key]).map((a) => [a.key, regions[a.key]]));
  areaRegions = Object.keys(areas).length ? areas : null;
  hudState = new HudState();
  hudCoach.reset();
  state.screenReading = true;
  screenReader.start(regions, {
    onFrame,
    onReading: (values) => {
      const snap = hudState.push(values);
      lastHud = snap;
      coach.observeVillagers(snap.villagers);
      broadcast('hud', snap);
      const t = coach.elapsed();
      handleMonitor(monitor.observe({ t, hud: snap }));
      hudNotes = hudCoach.evaluate(snap, t, distributionTarget(), { combat: monitor.combat });
    },
  });
}

function stopScreenReading() {
  screenReader?.stop();
  areaRegions = null;
  if (state.screenReading) {
    state.screenReading = false;
    broadcast('hud', null);
  }
}

// Kalibrasyon testi: oyuncu listesinden okunan satırlar ve mini haritada bu renklerden kaç piksel bulunduğu.
function testAreas(img, fields) {
  const out = {};
  let rows = [];
  if (fields.scoreboard) {
    const bmp = areaBitmap(img, fields.scoreboard);
    rows = scoreboardRows(bmp);
    out.scoreboard = {
      preview: bmp.image.toDataURL(),
      value: rows.length || null,
      text: rows.length ? `${rows.length} satır: ${rows.map((r) => `${r.enemy ? '⚔ ' : ''}${paletteName(r.hue)}`).join(', ')}` : 'satır bulunamadı',
    };
  }
  if (fields.minimap) {
    const bmp = areaBitmap(img, fields.minimap);
    const refs = rows.length ? rows.map((r, i) => ({ key: `row-${i}`, name: paletteName(r.hue), role: r.enemy ? 'enemy' : 'ally', hue: r.hue }))
      : Object.entries(PALETTE).map(([name, hue]) => ({ key: name, name, role: 'ally', hue }));
    const w = new MinimapWatcher();
    w.setPlayers(refs);
    const counts = new Map();
    for (let y = 0; y < bmp.height; y++) {
      for (let x = 0; x < bmp.width; x++) {
        const o = (y * bmp.width + x) * 4;
        const pl = w.classify(hsv(bmp.data[o + 2], bmp.data[o + 1], bmp.data[o]));
        if (pl) counts.set(pl.name, (counts.get(pl.name) || 0) + 1);
      }
    }
    const list = [...counts.entries()].filter(([, n]) => n >= 20).sort((a, b) => b[1] - a[1]);
    out.minimap = {
      preview: bmp.image.toDataURL(),
      value: list.length || null,
      text: list.length ? `Oyuncu renkleri: ${list.map(([name, n]) => `${name} ${n}`).join(', ')}` : 'oyuncu rengi bulunamadı',
    };
  }
  return out;
}

async function captureCalibration() {
  const img = await captureScreen();
  fs.writeFileSync(calibrationPath(), img.toPNG());
  const { width, height } = img.getSize();
  return { image: img.toDataURL(), width, height };
}

function onMatchEnded(match) {
  stopTicking();
  stopScreenReading();
  stopAiLive();
  resetLiveWatch();
  disconnectTeam();
  notes.clear();
  hudNotes = [];
  pushNotes();
  if (state.simulated) return;
  const build = state.build;
  state.phase = 'ended';
  state.match = match;
  state.cardsVisible = false;
  pushState();
  saveMatch(match);
  runPostGame(match, build);
}

// Maç bittikten sonra kayıt dosyasını analiz eder. Maç sürerken PostGame okumayı reddeder.
async function runPostGame(match, build = null) {
  if (!match.matchId || !postgame || postgame.has(match.matchId)) return;
  state.analysis = { matchId: match.matchId, status: 'running' };
  pushState();
  try {
    const result = await postgame.analyzeMatch(match, { localName: myPlayer(match)?.name, build });
    store.saveMatch({ matchId: match.matchId, hasAnalysis: true, analysisSummary: result.summary });
    state.analysis = { matchId: match.matchId, status: 'done' };
    broadcast('matches', store.matches);
    if (aiOn('aiReport')) runReport(match.matchId).then(pushState).catch((err) => console.warn('YZ raporu:', err.message));
  } catch (err) {
    state.analysis = { matchId: match.matchId, status: 'error', message: err.message };
  }
  pushState();
}

function matchInProgress() {
  return !state.simulated && (state.phase === 'loading' || state.phase === 'playing');
}

function saveMatch(match) {
  if (!match.matchId) return;
  const me = myPlayer(match);
  store.saveMatch({
    matchId: match.matchId,
    playedAt: match.startedAt,
    durationSec: match.durationSec,
    myTeam: me ? me.team : null,
    result: me ? match.results[me.profileId] || null : null,
    players: match.players.map((p) => ({ ...p, result: match.results[p.profileId] || null })),
    scouting: state.scouting && state.scouting.matchId === match.matchId ? summarizeScouting(state.scouting) : null,
  });
}

// Maç kaydına analizin özeti yazılır; ileride "koç ne dedi, ne oldu" karşılaştırması için.
function summarizeScouting(s) {
  return s.enemies.map((c) => ({ profileId: c.profileId, rating: c.rating?.rating ?? null, insights: c.insights.map((i) => i.text) }));
}

// AoE4World maçı işledikten sonra ülke kodlarını ve harita bilgisini öğren.
// Geçmiş maçlar zaten işlenmiş olduğundan ilk deneme beklemeden yapılabilir.
const syncScheduled = new Set();
function scheduleAoe4WorldSync(match, { firstDelayMs = AOE4WORLD_SYNC_DELAYS_MS[0] } = {}) {
  if (!match.matchId || !state.localProfileId || syncScheduled.has(match.matchId)) return;
  if (store.matches.some((m) => m.matchId === match.matchId && m.aoe4world)) return;
  syncScheduled.add(match.matchId);
  const attempt = async (i) => {
    try {
      const game = await aoe4world.findGame(state.localProfileId, match.matchId);
      if (!game) throw new Error('henüz işlenmedi');
      const learned = { ...store.settings.learnedCivCodes };
      for (const t of game.teams.flat()) {
        const lp = match.players.find((p) => p.profileId === t.player.profile_id);
        if (lp && civs.learnLogCode(lp.civCode, t.player.civilization)) learned[lp.civCode] = t.player.civilization;
      }
      store.updateSettings({ learnedCivCodes: learned });
      store.saveMatch({ matchId: match.matchId, map: game.map, kind: game.kind, aoe4world: true });
      broadcast('matches', store.matches);
    } catch {
      if (i + 1 < AOE4WORLD_SYNC_DELAYS_MS.length) setTimeout(() => attempt(i + 1), AOE4WORLD_SYNC_DELAYS_MS[i + 1]);
    }
  };
  setTimeout(() => attempt(0), firstDelayMs);
}

function startTicking() {
  stopTicking();
  const tick = () => {
    const view = coach.tick();
    broadcast('coach', view);
    for (const a of view.due) {
      broadcast('alert', a);
      notes.push(`alert-${a.at}-${a.level}`, a.level, a.short || a.text, 45);
    }
    // Build adımı değişince kısa süreli "şimdi" notu.
    if (view.build && view.build.index !== lastStepIndex) {
      lastStepIndex = view.build.index;
      notes.push('step', 'info', `Şimdi: ${stepShort(view.build.step)}`, 15);
    }
    const mates = team ? team.liveMembers() : [];
    notes.setState([...monitor.notes(), ...hudNotes, ...teamNotes(lastHud, mates, view.elapsed)]);
    pushNotes();
    scheduleLive();
    keepOverlayOnTop();
    sendTeamStatus(view.elapsed);
    if (team) {
      state.team = teamView();
      broadcast('team', state.team);
    }
    // İlk 2 dakikadan sonra rakip kartlarını otomatik küçült.
    if (state.cardsVisible && view.elapsed > 120 && !state.cardsPinned) {
      state.cardsVisible = false;
      pushState();
    }
  };
  tick();
  tickTimer = setInterval(tick, TICK_MS);
}

function stopTicking() {
  clearInterval(tickTimer);
  tickTimer = null;
}

// ---------- Log izleyici ----------

function startWatcher() {
  state.logPath = defaultLogPath(app.getPath('documents'));
  postgame = new PostGame({
    dataDir: app.getPath('userData'),
    playbackDir: path.join(path.dirname(state.logPath), 'playback'),
    gamedata,
    isMatchInProgress: matchInProgress,
  });
  watcher = new LogWatcher(state.logPath);
  watcher.on('missing', () => {
    state.logFound = false;
    pushState();
  });
  watcher.on('localProfile', ({ profileId }) => {
    state.logFound = true;
    // Ayarlarda elle girilmiş ID varsa o geçerli; yoksa oyunun kendi bildirdiği hesap.
    state.localProfileId = store.settings.profileId || profileId;
    pushState();
  });
  watcher.on('catchUp', ({ match }) => {
    state.logFound = true;
    // Uygulama maç ortasında açıldı: son 2 saat içinde başlamış ve bitmemiş maça bağlan.
    if (match && match.phase === 'loading') onMatchLoading(match);
    if (match && match.phase === 'playing' && Date.now() - match.startedAt < 2 * 60 * 60 * 1000) onMatchStarted(match);
    // Son maç bitmiş ama analiz edilmemişse (uygulama kapalıydı): temp.rec o maça aitse analiz et.
    if (match && match.phase === 'ended') runPostGame(match);
    pushState();
  });
  // Uygulama kapalıyken bu oturumda oynanmış maçları geçmişe ekle.
  watcher.on('pastMatch', ({ match }) => {
    saveMatch(match);
    scheduleAoe4WorldSync(match, { firstDelayMs: 0 });
    broadcast('matches', store.matches);
  });
  watcher.on('matchLoading', ({ match }) => onMatchLoading(match));
  watcher.on('matchStarted', ({ match }) => onMatchStarted(match));
  watcher.on('matchEnded', ({ match }) => {
    onMatchEnded(match);
    scheduleAoe4WorldSync(match);
  });
  watcher.on('matchResult', ({ match }) => {
    if (state.phase === 'ended' && state.match?.matchId === match.matchId) {
      state.match = match;
      saveMatch(match);
      pushState();
      broadcast('matches', store.matches);
    }
  });
  watcher.start();
}

// Oyuna girmeden overlay'i denemek için: log'daki son maçın oyuncularıyla sahte maç başlatır.
function simulateMatch() {
  const last = watcher?.parser.match;
  const players = last?.players?.length
    ? last.players
    : [{ slot: 0, name: 'Sen', profileId: state.localProfileId, team: 0, civCode: 'chinese_ha_01', ai: false }];
  const match = { matchId: null, players, phase: 'playing', startedAt: Date.now(), results: {} };
  onMatchStarted(match, { simulated: true });
}

function stopSimulation() {
  if (!state.simulated) return;
  stopTicking();
  stopScreenReading();
  stopAiLive();
  resetLiveWatch();
  disconnectTeam();
  notes.clear();
  hudNotes = [];
  pushNotes();
  coach.reset();
  Object.assign(state, { phase: 'idle', simulated: false, match: null, scouting: null, build: null });
  pushState();
  broadcast('coach', null);
}

// ---------- Pencereler ----------

function createDashboard() {
  dashboardWin = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Age of Koçu',
    backgroundColor: '#0b1016',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  dashboardWin.loadFile(path.join(RENDERER, 'dashboard', 'index.html'));
  dashboardWin.webContents.on('render-process-gone', (_e, details) => {
    console.warn('panel çöktü:', details.reason);
    if (dashboardWin && !dashboardWin.isDestroyed()) dashboardWin.reload();
  });
  dashboardWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  dashboardWin.on('closed', () => {
    dashboardWin = null;
    app.quit();
  });
}

// Oyunun üstünde duran, tıklamaları oyuna geçiren şeffaf katman.
// Oyun "Tam ekran pencereli" (borderless) modda olmalı; özel tam ekranda görünmez.
function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();
  overlayWin = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.loadFile(path.join(RENDERER, 'overlay', 'index.html'));
  overlayWin.once('ready-to-show', () => {
    if (state.overlayEnabled) overlayWin.showInactive();
  });
  // Overlay'in sayfası çöker ya da donup düzelirse notlar kaybolmasın: yeniden kur / tekrar gönder.
  const win = overlayWin;
  win.webContents.on('render-process-gone', (_e, details) => {
    console.warn('overlay çöktü:', details.reason);
    if (overlayWin !== win) return;
    overlayWin = null;
    if (!win.isDestroyed()) win.destroy();
    createOverlay();
  });
  win.on('unresponsive', () => console.warn('overlay yanıt vermiyor'));
  win.on('responsive', resendOverlay);
  win.webContents.on('did-finish-load', resendOverlay);
}

function resendOverlay() {
  lastNotesJson = '';
  pushNotes();
  pushState();
}

// Oyun tam ekrana geçince ya da Windows'un "yanıt vermiyor" penceresinden sonra overlay oyunun
// arkasında kalabiliyor; maç sırasında birkaç saniyede bir en üste geri alınır.
let lastOverlayRaise = 0;
function keepOverlayOnTop() {
  if (!overlayWin || overlayWin.isDestroyed() || !state.overlayEnabled || Date.now() - lastOverlayRaise < 5000) return;
  lastOverlayRaise = Date.now();
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  if (!overlayWin.isVisible()) overlayWin.showInactive();
  overlayWin.moveTop();
}

// Kısayollara anında onay: overlay modundan ve maç durumundan bağımsız, birkaç saniye görünür.
function flash(text, level = 'info') {
  broadcast('flash', { text, level });
}

function setOverlayEnabled(on) {
  state.overlayEnabled = on;
  store.updateSettings({ overlayEnabled: on });
  if (overlayWin) on ? overlayWin.showInactive() : overlayWin.hide();
  pushState();
}

const SHORTCUTS = {
  'Control+Alt+Right': () => coach.shiftStep(+1),
  'Control+Alt+Left': () => coach.shiftStep(-1),
  'Control+Alt+Up': () => coach.adjustClock(+10),
  'Control+Alt+Down': () => coach.adjustClock(-10),
  'Control+Alt+O': () => setOverlayEnabled(!state.overlayEnabled),
  'Control+Alt+A': () => runLive({ manual: true }),
  'Control+Alt+Y': () => {
    if (!team) {
      flash('Takım bağlı değil', 'danger');
    } else {
      team.sendPing({ kind: 'yardım' });
      flash('Yardım çağrısı gönderildi ✓');
    }
  },
  'Control+Alt+K': async () => {
    try {
      const cal = await captureCalibration();
      broadcast('calibration', cal);
      flash('Ekran görüntüsü alındı ✓');
    } catch (err) {
      flash(`Ekran yakalanamadı: ${err.message}`, 'danger');
    }
  },
  'Control+Alt+R': () => {
    state.cardsVisible = !state.cardsVisible;
    state.cardsPinned = state.cardsVisible;
    pushState();
  },
  'Control+Alt+M': () => {
    const s = store.updateSettings({ coachMode: commandMode() ? 'normal' : 'yonet' });
    broadcast('settings', s);
    onCoachModeChanged();
  },
};

// Mod değişince: kısa onay, eski moddan kalan notlar silinir, yönet modunda hemen ilk komutlar.
function onCoachModeChanged() {
  const on = commandMode();
  flash(on ? 'Yönet modu: koç komut verecek' : 'Normal mod');
  if (on) {
    for (const key of ['ai-do', 'ai-uret', 'ai-gelistir']) notes.remove(key);
    requestLive({ reason: 'Yönet modu açıldı', urgent: true });
  } else {
    notes.removeWhere((n) => n.key.startsWith('cmd-'));
  }
  pushNotes();
  pushState();
}

function registerShortcuts() {
  for (const [accel, fn] of Object.entries(SHORTCUTS)) {
    if (!globalShortcut.register(accel, fn)) console.warn('kısayol alınamadı:', accel);
  }
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('state:get', () => state);
  ipcMain.handle('notes:get', () => notes.list());
  ipcMain.handle('matches:list', () => store.matches);
  ipcMain.handle('settings:get', () => store.settings);
  ipcMain.handle('settings:update', (_e, patch) => {
    const allowed = {};
    if ('overlaySide' in patch) allowed.overlaySide = patch.overlaySide === 'left' ? 'left' : 'right';
    if ('screenReadingEnabled' in patch) allowed.screenReadingEnabled = Boolean(patch.screenReadingEnabled);
    for (const k of ['aiPrematch', 'aiLive', 'aiVision', 'aiReport', 'aiTranslate']) if (k in patch) allowed[k] = Boolean(patch[k]);
    if ('aiLiveIntervalMin' in patch) allowed.aiLiveIntervalMin = Math.min(10, Math.max(1, Number(patch.aiLiveIntervalMin) || 3));
    if ('aiProvider' in patch) allowed.aiProvider = patch.aiProvider === 'claude' ? 'claude' : 'gemini';
    if ('overlayMode' in patch) allowed.overlayMode = patch.overlayMode === 'detailed' ? 'detailed' : 'simple';
    if ('coachMode' in patch) allowed.coachMode = patch.coachMode === 'yonet' ? 'yonet' : 'normal';
    if ('teamSyncEnabled' in patch) allowed.teamSyncEnabled = Boolean(patch.teamSyncEnabled);
    if ('teamCode' in patch) allowed.teamCode = String(patch.teamCode || '').trim().slice(0, 64) || null;
    if ('teamServerUrl' in patch) allowed.teamServerUrl = /^https:\/\//.test(String(patch.teamServerUrl || '')) ? String(patch.teamServerUrl).trim() : null;
    if ('profileId' in patch) allowed.profileId = Number(patch.profileId) || null;
    const s = store.updateSettings(allowed);
    if ('profileId' in allowed) state.localProfileId = allowed.profileId || watcher?.parser.localProfileId || null;
    if ('overlayEnabled' in patch) setOverlayEnabled(Boolean(patch.overlayEnabled));
    if ('aiProvider' in allowed) refreshAiState();
    if ('coachMode' in allowed) onCoachModeChanged();
    broadcast('settings', s);
    pushState();
    return s;
  });
  ipcMain.handle('civs:list', () => civs.list());
  ipcMain.handle('builds:list', (_e, guideCode, refresh) => library.list(guideCode, { refresh }));
  ipcMain.handle('builds:select', async (_e, civSlug, buildId) => {
    store.updateSettings({ buildByCiv: { ...store.settings.buildByCiv, [civSlug]: buildId } });
    if (state.myCiv?.slug === civSlug) {
      if (buildId === 'auto' || buildId === 'serbest') {
        // Maç sırasında geçildi: plan bunu içeriyorsa onu, yoksa kuralı uygula (plan bir daha istenmez).
        autoCandidates = await library.list(state.myCiv.guide);
        state.buildAuto = { status: 'waiting', mode: buildId };
        if (state.ai.plan) applyPlanBuild(state.ai.plan);
        else if (state.scouting && !aiOn('aiPrematch')) autoBuildByRule();
      } else {
        autoCandidates = null;
        state.buildAuto = null;
        state.build = await library.get(state.myCiv.guide, buildId);
        coach.setBuild(state.build);
      }
      pushState();
    }
    return store.settings.buildByCiv;
  });
  ipcMain.handle('players:search', (_e, q) => aoe4world.searchPlayers(q));
  ipcMain.handle('players:scout', (_e, profileId, name) =>
    scout.scoutPlayer({ profileId: Number(profileId), name, team: null, civCode: null }, 'rm_3v3'));
  ipcMain.handle('analysis:get', (_e, matchId) => postgame.load(Number(matchId)));
  ipcMain.handle('analysis:import', async () => {
    const res = await dialog.showOpenDialog(dashboardWin, {
      title: 'Kayıt dosyası seç',
      defaultPath: postgame.playbackDir,
      filters: [{ name: 'AoE4 kaydı', extensions: ['rec'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const localName = myPlayer(state.match)?.name || store.matches.flatMap((m) => m.players).find((p) => p.profileId === state.localProfileId)?.name;
    return postgame.analyzeFile(res.filePaths[0], { localName });
  });
  ipcMain.handle('calib:get', () => {
    const file = calibrationPath();
    const base = { fields: [...FIELDS, ...AREAS], regions: store.settings.hudRegions, enabled: store.settings.screenReadingEnabled };
    if (!fs.existsSync(file)) return { ...base, image: null };
    const img = nativeImage.createFromPath(file);
    return { ...base, image: img.toDataURL(), ...img.getSize() };
  });
  ipcMain.handle('calib:capture', async (_e, delaySec = 0) => {
    await new Promise((r) => setTimeout(r, Math.min(15, Number(delaySec) || 0) * 1000));
    return captureCalibration();
  });
  ipcMain.handle('calib:test', async (_e, fields) => {
    const file = calibrationPath();
    if (!fs.existsSync(file)) throw new Error('Önce kalibrasyon görüntüsü al');
    const img = nativeImage.createFromPath(file);
    const out = await screenReader.readImage(img, fields, { withPreview: true });
    return { ...out, ...testAreas(img, fields) };
  });
  ipcMain.handle('calib:save', (_e, cal) => {
    const s = store.updateSettings({ hudRegions: { width: cal.width, height: cal.height, fields: cal.fields } });
    broadcast('settings', s);
    return s;
  });
  ipcMain.handle('ai:setKey', (_e, provider, key) => saveApiKey(provider, key));
  ipcMain.handle('ai:test', () => ai.testConnection());
  ipcMain.handle('ai:ask', () => runLive({ manual: true }));
  ipcMain.handle('ai:report', (_e, matchId) => runReport(Number(matchId)));
  ipcMain.handle('sim:start', () => simulateMatch());
  ipcMain.handle('sim:stop', () => stopSimulation());
  ipcMain.handle('coach:shift', (_e, delta) => coach.shiftStep(Math.sign(delta)));
  ipcMain.handle('coach:clock', (_e, sec) => coach.adjustClock(Number(sec) || 0));
}

async function runOcrSelftest(png, out) {
  const reader = new ScreenReader(path.join(app.getPath('userData'), 'ocr'));
  let result;
  try {
    const img = nativeImage.createFromPath(png);
    const { width, height } = img.getSize();
    result = await reader.readImage(img, { food: { x: 0, y: 0, w: width, h: height } });
  } catch (err) {
    result = { error: err.message };
  }
  fs.writeFileSync(out || path.join(app.getPath('userData'), 'ocr-selftest.json'), JSON.stringify(result));
  await reader.close();
}

// ---------- Otomatik güncelleme ----------
// Kurulu sürüm açılışta ve 30 dakikada bir GitHub Releases'a bakar; yeni sürümü arka planda indirir.
// Maç sırasında yeniden başlatılmaz: kullanıcı panelden onaylar ya da uygulama kapanırken kurulur.

function setupUpdater() {
  if (!app.isPackaged) return; // geliştirme sırasında (npm start) güncelleme yok
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const set = (update) => {
    state.update = update;
    pushState();
  };
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', version: state.update?.version, percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => console.warn('güncelleme:', err.message));
  const check = () => autoUpdater.checkForUpdates().catch((err) => console.warn('güncelleme:', err.message));
  check();
  setInterval(check, 30 * 60 * 1000);
  ipcMain.handle('update:install', () => {
    if (matchInProgress()) throw new Error('Maç bitince güncelle');
    autoUpdater.quitAndInstall(true, true);
  });
}

// ---------- Başlangıç ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (dashboardWin) {
      if (dashboardWin.isMinimized()) dashboardWin.restore();
      dashboardWin.focus();
    }
  });

  app.whenReady().then(async () => {
    // Teşhis: paketlenmiş uygulamada OCR'ın çalıştığını doğrulamak için
    //   "Age of Koçu.exe" --ocr-selftest=<png> --out=<json>
    const selftest = process.argv.find((a) => a.startsWith('--ocr-selftest='));
    if (selftest) {
      await runOcrSelftest(selftest.split('=')[1], process.argv.find((a) => a.startsWith('--out='))?.split('=')[1]);
      app.exit(0);
      return;
    }
    store = new Store(app.getPath('userData'));
    library = new BuildLibrary(path.join(app.getPath('userData'), 'cache'));
    screenReader = new ScreenReader(path.join(app.getPath('userData'), 'ocr'));
    for (const [code, slug] of Object.entries(store.settings.learnedCivCodes)) civs.learnLogCode(code, slug);
    state.localProfileId = store.settings.profileId;
    state.overlayEnabled = store.settings.overlayEnabled;
    refreshAiState();
    state.teamServer = Boolean(store.settings.teamServerUrl || DEFAULT_TEAM_SERVER);

    registerIpc();
    createDashboard();
    createOverlay();
    registerShortcuts();
    startWatcher();
    setupUpdater();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    screenReader?.close();
  });
}
