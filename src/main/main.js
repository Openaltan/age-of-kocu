'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell, dialog, nativeImage, safeStorage } = require('electron');
const { LogWatcher, defaultLogPath } = require('./logWatcher');
const { Store } = require('./store');
const { BuildLibrary, currentSeasonBuilds } = require('./aoe4guides');
const { Coach, buildAlerts, enemyLabels, pickBuild, customBuildFrom } = require('./coach');
const { NoteBoard } = require('./notes');
const { TeamSync, teamNotes, adviceKey, teamRankLevel } = require('./teamSync');
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
const { mmss, teamContribution, summaryFor } = require('./analysis');
const { MinimapWatcher, scoreboardRows, PALETTE, hueDist, hsv } = require('./minimap');
const { LiveMonitor } = require('./liveEvents');
const { BaseLedger, AGE_NAMES } = require('./baseLedger');
const logger = require('./log');
const { resolveMap, metaSummary, metaBrief } = require('./meta');
const { squadReport, squadHabits } = require('./squad');

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
const LIVE_CALL_TIMEOUT_MS = 100 * 1000; // tek değerlendirmenin (görüntü + YZ) en uzun süresi
const CAPTURE_TIMEOUT_MS = 8 * 1000;
const KEEP_GUIDANCE_SEC = 15 * 60; // koç notları yenisi gelene kadar kalır (en fazla 15 dk)
const INTEL_WAIT_MS = 25 * 1000; // maç öncesi plan, harita/meta için en fazla bu kadar bekler
const RESEARCH_TTL_MS = 3 * 24 * 60 * 60 * 1000;
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
let aiTarget = null; // { dagilim, total, at } YZ'nin son hedef köylü dağılımı (yenisi gelene kadar)
let liveSeq = 0; // takılan YZ çağrısının geç gelen sonucunu yok saymak için
let lastLiveOkAt = 0; // son başarılı YZ değerlendirmesi (ms)
let lastLiveError = null;
let stepStartedAt = 0; // şimdiki build adımının başladığı maç saniyesi
const mapLocalById = new Map(); // matchId -> oyunun yazdığı (Türkçe olabilen) harita adı
let pendingMapLearn = null; // ulus seçme ekranında okunan ad -> İngilizce ad (yükleme ekranında doğrulanır)
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
  intel: null, // harita ve meta: { mapLocal, map, meta, research }
  civSelect: null, // ulus seçme ekranı: { matchId, at, map, status }
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
      autoCandidates = currentSeasonBuilds(await library.list(civ.guide));
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
  console.log(`build seçildi (${source}): ${build.name}${reason ? ` — ${reason}` : ''}`);
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
  state.intel = null;
  state.civSelect = null;
  state.cardsVisible = true;
  notes.clear();
  hudNotes = [];
  aiRisk = null;
  lastStepIndex = null;
  resetLiveWatch();
  pushState();
  pushNotes();

  const buildReady = loadBuildFor(match).then(pushState);
  const intelReady = gatherIntel(match);
  try {
    const result = await scout.scoutMatch(match, state.localProfileId);
    if (state.match !== match) return; // bu arada yeni maç başladıysa eski sonucu at
    state.scouting = result;
    if (liveOn()) for (const n of enemyLabels(result)) notes.push(n.key, n.level, n.text, 240);
    pushNotes();
    // Analiz maç başladıktan sonra bittiyse uyarıları sonradan yükle.
    if (state.phase === 'playing') coach.alerts = buildAlerts(result);
    // Otomatik build seçimi için aday listesi hazır olsun.
    await buildReady.catch(() => {});
    state.intel = await withTimeout(intelReady, INTEL_WAIT_MS, 'harita/meta gecikti').catch((err) => {
      console.warn('harita/meta:', err.message);
      return null;
    });
    if (state.match !== match) return;
    pushState();
    if (!liveOn() || !aiOn('aiPrematch')) autoBuildByRule();
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
  // Ekran okuma (yerel OCR) build adımını köylü sayısıyla eşlemek için canlı koç kapalıyken de çalışır.
  startScreenReading();
  if (liveOn()) {
    startAiLive();
    connectTeam(state.match);
    // Kalibrasyon yoksa ekran okuma, mini harita ve kayıp algılama çalışmaz: oyuncu bilsin.
    if (!store.settings.hudRegions?.fields) notes.push('calib', 'info', 'Ekran okuma kapalı: Ctrl+Alt+K ile kalibre et', 60);
    else if (!store.settings.screenReadingEnabled) notes.push('calib', 'info', 'Ekran okuma ayarlardan kapalı', 30);
  }
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

// Takım arkadaşlarının son durumu; bozuk veri koçu durdurmasın.
function liveMates() {
  try {
    return team ? team.liveMembers() : [];
  } catch (err) {
    console.warn('takım verisi okunamadı:', err.message);
    return [];
  }
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
    riskKind: 'gercek', // bu sürüm sadece görülen tehlikeyi gönderir (tahminler gönderilmez)
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

// Canlı koç (deneysel): maç içi YZ değerlendirmesi, yönet modu, mini harita/kayıp uyarıları, takım
// senkronu, ulus seçme ekranı önerisi ve maç öncesi YZ planı. Kapalıyken (varsayılan) oyun içinde
// sadece seçili build'in başlangıcı görünür; YZ ve ekran görüntüsü kullanılmaz. Kod duruyor, ayardan açılır.
function liveOn() {
  return store?.settings.liveCoach === true;
}

// Windows açılınca arka planda başlat: maçlar uygulama açıkken bittiği için hepsi analiz edilir
// (oyun sadece son maçın kaydını tutar). Sadece kurulu uygulamada.
function applyLoginItem() {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: store.settings.startWithWindows === true, args: ['--hidden'] });
  } catch (err) {
    console.warn('başlangıçta açılma ayarlanamadı:', err.message);
  }
}

function refreshAiState() {
  state.liveCoach = liveOn();
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

// ---------- Harita ve güncel meta ----------
// AoE4World'ün halka açık istatistikleri (ulus/harita kazanma oranları) + isteğe bağlı internet
// araştırması (Gemini + Google Arama). Araştırma aynı harita ve ülkeler için 3 gün önbelleklenir.

function matchKind(match) {
  const humans = match.players.length;
  const per = Math.max(1, Math.round(humans / 2));
  return humans <= 2 ? 'rm_1v1' : `rm_${per}v${per}`;
}

async function gatherIntel(match) {
  const local = readMapName();
  if (pendingMapLearn && local && pendingMapLearn.local === local && store.settings.learnedMapNames?.[local] !== pendingMapLearn.en) {
    store.updateSettings({ learnedMapNames: { ...(store.settings.learnedMapNames || {}), [local]: pendingMapLearn.en } });
  }
  pendingMapLearn = null;
  if (match.matchId && local) mapLocalById.set(match.matchId, local);
  const me = myPlayer(match);
  const slugOf = (p) => civs.fromLogCode(p.civCode)?.slug || null;
  const enemies = me ? match.players.filter((p) => p.team !== me.team) : [];
  const allies = me ? match.players.filter((p) => p.team === me.team && p.profileId !== me.profileId) : [];
  const kind = matchKind(match);
  const [civRows, mapList] = await Promise.all([
    aoe4world.civStats(kind).catch((err) => { console.warn('meta (ülkeler):', err.message); return []; }),
    aoe4world.mapStats(kind).catch((err) => { console.warn('meta (haritalar):', err.message); return []; }),
  ]);
  const map = resolveMap(local, store.settings.learnedMapNames || {}, mapList);
  const mapCivRows = map?.id ? await aoe4world.mapCivStats(kind, map.id).catch(() => []) : [];
  const meta = metaSummary({ kind, mySlug: me ? slugOf(me) : null, enemySlugs: enemies.map(slugOf), allySlugs: allies.map(slugOf), civRows, map, mapCivRows });
  let research = null;
  if (liveOn() && aiOn('aiResearch')) {
    research = await cachedResearch({
      mapName: map?.en ? `${local} (${map.en})` : local,
      kind,
      myCiv: me ? civs.trName(slugOf(me) || me.civCode) : null,
      enemyCivs: enemies.map((p) => civs.trName(slugOf(p) || p.civCode)),
      allyCivs: allies.map((p) => civs.trName(slugOf(p) || p.civCode)),
    }).catch((err) => { console.warn('internet araştırması:', err.message); return null; });
  }
  console.log(`harita/meta: ${meta.harita?.ad || 'harita bilinmiyor'} · ${civRows.length} ülke istatistiği · araştırma ${research ? 'var' : 'yok'}`);
  return { mapLocal: local, map, meta, research };
}

async function cachedResearch(q) {
  const key = require('crypto').createHash('sha1').update(JSON.stringify([q.mapName, q.kind, q.myCiv, [...q.enemyCivs].sort(), [...q.allyCivs].sort()])).digest('hex').slice(0, 16);
  const file = path.join(app.getPath('userData'), 'cache', `research-${key}.json`);
  try {
    const hit = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - hit.at < RESEARCH_TTL_MS) return hit;
  } catch {
    // önbellekte yok
  }
  const res = await ai.research(q);
  if (!res) return null;
  const out = { at: Date.now(), query: q, text: res.text, sources: res.sources };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

async function runPrematch(match) {
  if (!liveOn() || !aiOn('aiPrematch') || !state.scouting) return;
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
      mapName: state.intel?.meta?.harita?.ad || readMapName(),
      intel: state.intel,
      squad: squadBrief(match),
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
    console.warn('maç öncesi plan başarısız:', err.message);
    Object.assign(state.ai, { planStatus: 'error', planError: err.message });
    if (state.match === match) autoBuildByRule();
  }
  pushState();
}

// En son yakalanan kare 2 sn'den tazeyse onu kullanır (ekran okuma zaten saniyede bir yakalıyor).
async function freshFrame() {
  const last = screenReader?.lastFrame;
  if (last && Date.now() - last.at < 2000) return last.image;
  return withTimeout(captureScreen(), CAPTURE_TIMEOUT_MS, 'Ekran yakalama gecikti');
}

// Söz verilen süre içinde bitmeyen işi hata olarak sonlandırır (takılan iş koçu susturmasın).
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Karenin ortalama parlaklığı: tam ekran oyunlarda yakalama siyah dönebilir.
function meanBrightness(img) {
  const small = img.resize({ width: 64 });
  const d = small.toBitmap();
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
  return sum / (d.length / 4);
}

// YZ'ye gidecek görüntüler: tam ekran (küçültülmüş), sol alttaki kaynak paneli yakın planda
// (köylü sayıları küçültülmüş ekranda okunamıyor) ve varsa mini haritanın yakın görüntüsü.
async function liveImages() {
  if (store.settings.aiVision === false) return [];
  let img;
  try {
    img = await freshFrame();
  } catch (err) {
    console.warn('YZ için ekran alınamadı:', err.message);
    return [];
  }
  const bright = meanBrightness(img);
  if (bright < 6) {
    console.warn(`ekran görüntüsü siyah (parlaklık ${bright.toFixed(1)}): oyun özel tam ekranda olabilir`);
    return [];
  }
  const { width, height } = img.getSize();
  const out = [{ data: img.resize({ width: 1280, quality: 'good' }).toJPEG(70).toString('base64'), mediaType: 'image/jpeg', label: 'oyuncunun tam ekranı' }];
  const hud = areaBitmap(img, { x: 0, y: height * 0.74, w: width * 0.13, h: height * 0.26 }).image;
  out.push({ data: hud.toJPEG(90).toString('base64'), mediaType: 'image/jpeg', label: 'sol alttaki kaynak paneli (yakın): üstte nüfus, her satırda kaynak miktarı ve sağında o kaynaktaki köylü sayısı' });
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
      team: liveMates(),
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
      intel: metaBrief(state.intel),
    });
    const images = await liveImages();
    console.log(`YZ bakıyor: ${trigger?.reason || (manual ? 'oyuncu sordu' : 'periyodik')}${combat ? ' · savaş' : ''}${command ? ' · yönet' : ''} · ${images.length} görüntü`);
    const res = await withTimeout(ai.liveAssessment(context, images, { combat, command }), LIVE_CALL_TIMEOUT_MS, 'Koç zamanında cevap vermedi');
    if (seq !== liveSeq || state.phase !== 'playing') return;
    console.log(`YZ cevap verdi (${((Date.now() - lastLiveAt) / 1000).toFixed(1)} sn): ${res.uyari || res.durum}`);
    lastLiveOkAt = Date.now();
    lastLiveError = null;
    const simdiYap = res.simdiYap || [];
    const uret = res.uret || [];
    const komutlar = command ? (res.komutlar || []).filter((k) => k?.metin).slice(0, 4) : [];
    // Köylü dağılımı: YZ'nin oranları gerçek köylü sayısına oturtulur (toplam tutar). Gerçek sayı:
    // ekran okuma varsa oradan, yoksa YZ'nin sol alt panelden okuduğu sayılardan.
    const read = res.okunanKoylu || {};
    const readTotal = ['yemek', 'odun', 'altin', 'tas', 'bosta'].reduce((s, k) => s + Math.max(0, Number(read[k]) || 0), 0);
    const total = lastHud?.villagers ?? (readTotal || null);
    const target = combat ? null : fitDistribution(res.dagilim, total);
    // Hedef, yenisi gelene kadar geçerli; köylü sayısı artınca anlık sayıya yeniden oturtulur.
    aiTarget = target ? { dagilim: res.dagilim, total: target.food + target.wood + target.gold + target.stone, at: Date.now() } : combat ? aiTarget : null;
    ledger.observe(res.gozlem, mmss(elapsed));
    state.ai.live = [{ at: mmss(elapsed), combat, command, trigger: trigger?.reason || null, ...res, simdiYap, uret, komutlar, hedefDagilim: target ? distributionLine(target) : null }, ...state.ai.live].slice(0, 6);
    state.ai.liveStatus = 'done';
    broadcast('alert', { level: res.risk === 'yüksek' ? 'danger' : 'info', text: `Koç: ${komutlar[0]?.metin || simdiYap[0] || res.durum}` });
    // Sade overlay: her değerlendirme bir öncekinin notlarının yerini alır; yenisi gelene kadar
    // (oyuncu uygulayabilsin diye) kalır. Koç uzun süre bakamazsa "bakamadı" notu bunu söyler.
    const ttl = KEEP_GUIDANCE_SEC;
    // Tahmin "Olası:" diye ve bilgi seviyesinde görünür; takıma sadece gerçekten görülen tehlike gider.
    const warn = aiContext.warningNote(res);
    aiRisk = warn?.share ? warn.text : null;
    notes.remove('ai-err');
    setOrRemove('ai-risk', warn?.level || 'info', warn?.text || '', Math.round(liveIntervalMs() / 1000) + 60);
    notes.removeWhere((n) => n.key.startsWith('cmd-'));
    if (command) {
      // Yönet modu: sıralı komutlar; ayrı "şimdi/üret/geliştir" notlarına gerek yok.
      komutlar.forEach((k, i) => notes.push(`cmd-${i}`, 'cmd', `${i + 1}. ${k.metin}`, ttl));
      for (const key of ['ai-do', 'ai-uret', 'ai-gelistir']) notes.remove(key);
    } else {
      setOrRemove('ai-do', 'info', simdiYap[0], ttl);
      setOrRemove('ai-uret', 'info', uret.length ? `Üret: ${uret.join(' · ')}` : '', ttl);
      setOrRemove('ai-gelistir', 'info', res.gelistir ? `Geliştir: ${res.gelistir}` : '', ttl);
    }
    pushNotes();
  } catch (err) {
    if (seq !== liveSeq) return;
    console.warn('YZ değerlendirmesi başarısız:', err.message);
    lastLiveError = err.message;
    Object.assign(state.ai, { liveStatus: 'error', liveError: err.message });
    // Sessizce susmasın: koçun neden bakamadığı overlay'de de görünsün.
    notes.push('ai-err', 'info', `Koç bakamadı: ${err.message}`.slice(0, 70), 90);
    pushNotes();
  } finally {
    if (seq === liveSeq) aiLiveBusy = false;
  }
  pushState();
}

// Geçerli YZ köylü hedefi (yenisi gelene kadar). Köylü sayısı değiştikçe anlık sayıya oturtulur.
function activeAiTarget() {
  if (!aiTarget || monitor.combat) return null;
  const view = coach.buildView();
  if (!(commandMode() || !view || !view.next)) return null; // build sürerken normal modda build adımı geçerli
  return fitDistribution(aiTarget.dagilim, lastHud?.villagers ?? aiTarget.total);
}

// Köylü kaydırma notunun hedefi: yönet modunda (ya da build bitince) YZ'nin son hedefi, yoksa build adımı.
function distributionTarget() {
  return activeAiTarget() || coach.currentStep();
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
  lastLiveOkAt = 0;
  lastLiveError = null;
  stepStartedAt = 0;
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
  if (!liveOn() || state.phase !== 'playing' || !areaRegions) return;
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

// ---------- Gelişim analizi ve sohbet ----------

function userFile(name) {
  return path.join(app.getPath('userData'), name);
}

function readUserJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(userFile(name), 'utf8'));
  } catch {
    return fallback;
  }
}

// En sık birlikte oynadığım takım arkadaşları (en az 2 maç).
function frequentMates(limit = 2) {
  const count = new Map();
  for (const m of store.matches) {
    const me = m.players.find((p) => p.profileId === state.localProfileId);
    if (!me) continue;
    for (const p of m.players) {
      if (p.team !== me.team || !p.profileId || p.profileId === me.profileId) continue;
      const c = count.get(p.profileId) || { profileId: p.profileId, name: p.name, n: 0 };
      c.n++;
      count.set(p.profileId, c);
    }
  }
  return [...count.values()].filter((c) => c.n >= 2).sort((a, b) => b.n - a.n).slice(0, limit);
}

// En çok oynadığım maç türü (meta istatistiği için).
function usualKind() {
  const kinds = new Map();
  for (const m of store.matches.slice(0, 30)) {
    const k = m.kind || matchKind(m);
    kinds.set(k, (kinds.get(k) || 0) + 1);
  }
  return [...kinds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'rm_3v3';
}

// Maçlarımdan hatalar, oyun tarzı, ulus önerisi ve takım kompozisyonu.
async function runReview() {
  if (!state.localProfileId) throw new Error('Profilin henüz bulunamadı');
  if (!ai.available()) throw new Error('Yapay zekâ anahtarı girilmemiş (Ayarlar › Yapay Zekâ Koç)');
  const kind = usualKind();
  const mates = frequentMates();
  const blank = (profileId, name) => ({ profileId, name, team: null, civCode: null });
  const [me, ...mateCards] = await Promise.all([blank(state.localProfileId, null), ...mates.map((m) => blank(m.profileId, m.name))].map((p) => scout.scoutPlayer(p, kind)));
  const civRows = await aoe4world.civStats(kind).catch(() => []);
  const context = aiContext.reviewContext({
    matches: store.matches,
    loadAnalysis: (id) => postgame.load(id),
    localProfileId: state.localProfileId,
    me,
    mates: mateCards,
    civRows,
    civName: (c) => civs.trName(c),
  });
  console.log(`gelişim analizi istendi: ${context.kayitAnalizliMaclarim.length} analizli maç, ${context.uygulamadakiSonMaclarim.length} maç, ${mateCards.length} takım arkadaşı`);
  const review = await ai.playerReview(context);
  const out = { at: Date.now(), kind, review, basedOn: { analyzed: context.kayitAnalizliMaclarim.length, matches: context.uygulamadakiSonMaclarim.length, mates: mateCards.map((c) => c.name) } };
  fs.writeFileSync(userFile('review.json'), JSON.stringify(out));
  return out;
}

let chatHistory = null; // [{ role: 'user' | 'assistant', text, sources?, at }]
const CHAT_KEEP = 60;
const CHAT_CONTEXT_TURNS = 12;

function chatLog() {
  chatHistory ||= readUserJson('chat.json', []);
  return chatHistory;
}

// Sohbette koçun bildikleri: maç geçmişim, son maç analizi, gelişim raporu ve (varsa) şu anki maç.
function chatContext() {
  const me = (m) => m.players.find((p) => p.profileId === state.localProfileId);
  const recent = store.matches.slice(0, 15).map((m) => ({
    sonuc: m.result === 'win' ? 'galibiyet' : m.result === 'loss' ? 'mağlubiyet' : null,
    ulke: me(m) ? civs.trName(me(m).civCode) : null,
    harita: m.map || m.mapLocal || null,
    dk: m.durationSec ? Math.round(m.durationSec / 60) : null,
    rakipler: m.players.filter((p) => me(m) && p.team !== me(m).team).map((p) => `${p.name} (${civs.trName(p.civCode)})`),
    ...(m.analysisSummary ? { analiz: { feodal: mmss(m.analysisSummary.feudalAt), merkezBostaIlk10: mmss(m.analysisSummary.tcIdleFirst10), koylu10dk: m.analysisSummary.villagersAt10, ilkAsker: mmss(m.analysisSummary.firstMilitaryAt), apm: m.analysisSummary.apm } } : {}),
  }));
  const last = store.matches.find((m) => m.hasAnalysis);
  const lastAnalysis = last ? postgame.load(last.matchId) : null;
  const review = readUserJson('review.json', null);
  const inMatch = state.phase === 'loading' || state.phase === 'playing';
  return {
    ben: myPlayer(state.match)?.name || store.matches.map(me).find(Boolean)?.name || null,
    sonMaclarim: recent,
    sonAnalizliMac: lastAnalysis ? { harita: last.map, sonuc: last.result, tespitler: lastAnalysis.findings.map((x) => x.text), koçRaporu: lastAnalysis.aiReport?.ozet || null } : null,
    gelisimRaporu: review ? { tarih: new Date(review.at).toISOString().slice(0, 10), ...review.review } : null,
    takimimiz: squadBrief(),
    ulusOnerileri: readUserJson('civ-advice.json', null)?.advice || null,
    suAnkiMac: inMatch ? {
      faz: state.phase,
      sure: state.phase === 'playing' ? mmss(coach.elapsed()) : null,
      ulkem: state.myCiv?.tr || null,
      build: state.build?.name || null,
      rakipler: state.scouting ? state.scouting.enemies.map((c) => ({ oyuncu: c.name, ulke: c.civTr, notlar: c.insights.slice(0, 3).map((i) => i.text) })) : [],
      haritaVeMeta: metaBrief(state.intel),
      plan: state.ai.plan?.ozet || null,
      sonDegerlendirme: state.ai.live[0] ? { durum: state.ai.live[0].durum, simdiYap: state.ai.live[0].simdiYap } : null,
    } : null,
  };
}

async function chatSend(text) {
  const msg = String(text || '').trim().slice(0, 2000);
  if (!msg) throw new Error('Boş mesaj');
  if (!ai.available()) throw new Error('Yapay zekâ anahtarı girilmemiş (Ayarlar › Yapay Zekâ Koç)');
  const log = chatLog();
  // Sohbet her zaman oyuncunun mesajıyla başlamalı ve sırayla ilerlemeli.
  let turns = log.slice(-CHAT_CONTEXT_TURNS).map(({ role, text: t }) => ({ role, text: t }));
  while (turns.length && turns[0].role !== 'user') turns.shift();
  turns = [...turns, { role: 'user', text: msg }];
  const res = await ai.chat(turns, chatContext());
  log.push({ role: 'user', text: msg, at: Date.now() }, { role: 'assistant', text: res.text, sources: res.sources || [], searched: res.searched !== false, at: Date.now() });
  chatHistory = log.slice(-CHAT_KEEP);
  fs.writeFileSync(userFile('chat.json'), JSON.stringify(chatHistory));
  return chatHistory;
}

// ---------- Takımımız: ekip analizi ve ulus önerisi ----------
// Ekip: benimle en az SQUAD_MIN_GAMES maç aynı takımda oynamış en sık 2 oyuncu (AoE4World geçmişinden).

const SQUAD_TTL_MS = 6 * 60 * 60 * 1000;
const SQUAD_MIN_GAMES = 8;
const ADVICE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
let squadBusy = null; // süren yenileme (aynı anda iki kez çekilmesin)
let adviceBusy = null;

function squadMembersFrom(myId, myName, myGames) {
  const count = new Map();
  for (const g of myGames) {
    const team = (g.teams || []).find((t) => t.some((x) => x.player.profile_id === myId));
    for (const x of team || []) {
      if (x.player.profile_id === myId) continue;
      const c = count.get(x.player.profile_id) || { id: x.player.profile_id, name: x.player.name, n: 0 };
      c.n++;
      count.set(x.player.profile_id, c);
    }
  }
  const mates = [...count.values()].filter((c) => c.n >= SQUAD_MIN_GAMES).sort((a, b) => b.n - a.n).slice(0, 2);
  return [{ id: myId, name: myName }, ...mates.map(({ id, name }) => ({ id, name }))];
}

async function refreshSquad({ force = false } = {}) {
  const cached = readUserJson('squad.json', null);
  if (!force && cached && cached.me === state.localProfileId && Date.now() - cached.at < SQUAD_TTL_MS) return cached;
  if (!state.localProfileId) throw new Error('Profilin henüz bulunamadı');
  squadBusy ||= (async () => {
    const myId = state.localProfileId;
    const [me, myGames] = await Promise.all([aoe4world.player(myId), aoe4world.allGames(myId)]);
    const members = squadMembersFrom(myId, me.name, myGames);
    const gamesByMember = { [myId]: myGames };
    for (const m of members.slice(1)) gamesByMember[m.id] = await aoe4world.allGames(m.id).catch(() => []);
    const report = squadReport(members, gamesByMember, { civName: (c) => civs.trName(c) });
    const habits = squadHabits(members, store.matches, (id) => postgame.load(id));
    const rankLevel = aoe4world.rankLevelOf(me.modes?.rm_team?.rank_level) || 'gold';
    // Ortak öneri için ekip seviyesi: üyelerin takım puanı ortalaması (her uygulamada aynı çıkar).
    const ratings = [me.modes?.rm_team?.rating];
    for (const m of members.slice(1)) ratings.push(await aoe4world.player(m.id).then((p) => p.modes?.rm_team?.rating).catch(() => null));
    const teamLevel = teamRankLevel(ratings.map(Number));
    const out = { at: Date.now(), me: myId, members, rankLevel, teamRankLevel: teamLevel, rating: me.modes?.rm_team?.rating ?? null, report, habits };
    fs.writeFileSync(userFile('squad.json'), JSON.stringify(out));
    console.log(`takım analizi: ${members.map((m) => m.name).join(', ')} · ${report.toplamTakimMaci} takım maçı · seviye ${rankLevel}`);
    return out;
  })().finally(() => { squadBusy = null; });
  return squadBusy;
}

// Havuzdaki haritalar: bu yamada en çok oynanan haritalar (oynanma payı %2+), en fazla 14.
function mapPool(mapRows) {
  const total = mapRows.reduce((sum, m) => sum + (m.games_count || 0), 0);
  return mapRows.filter((m) => total && m.games_count / total >= 0.02).sort((a, b) => b.games_count - a.games_count).slice(0, 14);
}

// Ortak ulus önerisi takım sunucusunda saklanır: ekipte ilk hesaplayanın önerisini herkes görür.
function adviceUrl(key) {
  return `${teamServer().replace(/\/$/, '')}/advice/${key}`;
}

async function sharedAdviceGet(key) {
  if (store.settings.teamSyncEnabled === false) return null;
  const res = await withTimeout(fetch(adviceUrl(key)), 8000, 'takım sunucusu gecikti');
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`takım sunucusu ${res.status}`);
  return res.json();
}

async function sharedAdvicePut(key, data, replace) {
  if (store.settings.teamSyncEnabled === false) return null;
  const res = await withTimeout(fetch(adviceUrl(key), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data, replace }) }), 8000, 'takım sunucusu gecikti');
  if (!res.ok) throw new Error(`takım sunucusu ${res.status}`);
  return res.json();
}

function saveAdvice(record, key) {
  const out = { ...record.data, at: record.at, me: state.localProfileId, key, shared: true };
  fs.writeFileSync(userFile('civ-advice.json'), JSON.stringify(out));
  return out;
}

// Sunucudaki ortak öneri daha yeniyse yerel kopyayı günceller (ulus seçme ekranında da çağrılır).
async function syncSharedAdvice() {
  const local = readUserJson('civ-advice.json', null);
  if (!local?.key) return local;
  try {
    const remote = await sharedAdviceGet(local.key);
    if (remote && remote.at > (local.at || 0)) {
      console.log('ortak ulus önerisi sunucudan güncellendi');
      return saveAdvice(remote, local.key);
    }
  } catch (err) {
    console.warn('ortak öneri:', err.message);
  }
  return local;
}

async function refreshCivAdvice({ force = false } = {}) {
  adviceBusy ||= (async () => {
    const squad = await refreshSquad();
    const kind = squad.members.length >= 3 ? 'rm_3v3' : 'rm_2v2';
    const level = squad.teamRankLevel || squad.rankLevel;
    const key = adviceKey(squad.members.map((m) => m.id), kind, level);
    // 1) Ekipten biri zaten hesapladıysa onu kullan (yenile istenmedikçe).
    if (!force) {
      const remote = await sharedAdviceGet(key).catch((err) => { console.warn('ortak öneri:', err.message); return null; });
      if (remote) return saveAdvice(remote, key);
      const local = readUserJson('civ-advice.json', null);
      if (local && local.key === key && Date.now() - local.at < ADVICE_TTL_MS) return local;
    }
    if (!ai.available()) throw new Error('Yapay zekâ anahtarı girilmemiş (Ayarlar › Yapay Zekâ Koç)');
    const upper = aoe4world.nextRankLevel(level);
    const pool = mapPool(await aoe4world.mapStats(kind, level));
    const top = (rows) => [...rows].filter((r) => r.games_count >= 100).sort((a, b) => b.win_rate - a.win_rate).slice(0, 6).map((r) => `${civs.trName(r.civilization)} %${Math.round(r.win_rate * 10) / 10}`);
    const maps = [];
    for (const m of pool) {
      const [mine, up] = await Promise.all([
        aoe4world.mapCivStats(kind, m.map_id, level).catch(() => []),
        upper && upper !== level ? aoe4world.mapCivStats(kind, m.map_id, upper).catch(() => []) : [],
      ]);
      maps.push({ harita: m.map, ortalamaMacDk: Math.round((m.duration_median || 0) / 60), seviyemizdeEnIyi: top(mine), ustSeviyedeEnIyi: top(up) });
    }
    const [civMine, civUp] = await Promise.all([aoe4world.civStats(kind, level), upper ? aoe4world.civStats(kind, upper) : []]);
    const context = {
      uyeler: squad.members.map((m) => m.name),
      seviye: { biz: level, ust: upper, puan: squad.rating },
      takim: squad.report,
      aliskanliklar: squad.habits,
      meta: { tur: kind, seviyemizde: top(civMine), ustSeviyede: top(civUp), haritalar: maps },
    };
    console.log(`ulus önerisi isteniyor: ${pool.length} harita · ${kind} · ${level}`);
    const advice = await ai.civAdvice(context);
    // Sütun sırası her uygulamada aynı olsun: üyeler kimliğe göre sıralı.
    const members = [...squad.members].sort((a, b) => a.id - b.id);
    const data = { kind, rankLevel: level, members, pool: pool.map((m) => m.map), advice, by: squad.members[0].name };
    // 2) Sunucuya koy; o arada ekipten biri koyduysa (ve yenile istenmediyse) sunucudaki geçerli olur.
    try {
      const stored = await sharedAdvicePut(key, data, force);
      if (stored) return saveAdvice(stored, key);
    } catch (err) {
      console.warn('ortak öneri yazılamadı (yerelde kullanılıyor):', err.message);
    }
    const out = { ...data, at: Date.now(), me: state.localProfileId, key, shared: false };
    fs.writeFileSync(userFile('civ-advice.json'), JSON.stringify(out));
    return out;
  })().finally(() => { adviceBusy = null; });
  return adviceBusy;
}

// Uygulama açılınca ve maç bitince: takım verisi ve (anahtar varsa) ulus önerileri arka planda tazelenir.
function backgroundTeamRefresh() {
  if (!state.localProfileId) return;
  refreshSquad()
    .then(() => (store.settings.civAdvice !== false ? refreshCivAdvice() : null))
    .catch((err) => console.warn('takım/ulus önerisi:', err.message));
}

// Kısa takım özeti: maç öncesi plan ve sohbet için (bu maçtaki ekip üyelerine göre).
function squadBrief(match = null) {
  const squad = readUserJson('squad.json', null);
  if (!squad) return null;
  const inMatch = match ? new Set(match.players.map((p) => p.profileId)) : null;
  const present = inMatch ? squad.members.filter((m) => inMatch.has(m.id)).map((m) => m.name) : squad.members.map((m) => m.name);
  const relevant = (c) => c.oyuncular.every((n) => present.includes(n));
  const slim = (c) => ({ oyuncular: c.oyuncular, mac: c.mac, kazanma: c.kazanma, ortalamaKazanilanDk: c.ortalamaKazanilanDk, sureyeGore: c.sureyeGore, enIyiHaritalar: c.enIyiHaritalar, ulusKombinasyonlari: c.ulusKombinasyonlari.slice(0, 3) });
  return {
    buMactakiEkip: present,
    ikililer: squad.report.ikililer.filter(relevant).map(slim),
    uclu: squad.report.uclu && relevant(squad.report.uclu) ? slim(squad.report.uclu) : null,
    aliskanliklar: squad.habits.filter((h) => present.includes(h.oyuncu)),
  };
}

// ---- Ulus seçme ekranı ----
// Eşleşme bulununca ekrandaki harita okunur ve önceden hesaplanmış takım önerisi overlay'e düşer.

const CIV_PICK_TRIES_MS = [3000, 8000, 14000, 22000, 30000];

async function onMatchFound(matchId) {
  if (!liveOn() || store.settings.civAdvice === false || matchInProgress()) return;
  const advice = await withTimeout(syncSharedAdvice(), 4000, 'gecikti').catch(() => readUserJson('civ-advice.json', null));
  state.civSelect = { matchId, at: Date.now(), map: null, status: advice ? 'harita okunuyor' : 'öneri yok' };
  console.log(`eşleşme bulundu: ${matchId} · ulus önerisi ${advice ? 'hazır' : 'yok'}`);
  if (!advice) {
    notes.push('civ-none', 'info', 'Ulus önerisi henüz hazır değil (Takımımız sayfası)', 40);
    pushNotes();
    pushState();
    return;
  }
  pushState();
  for (const ms of CIV_PICK_TRIES_MS) setTimeout(() => detectPickMap(matchId, advice), ms);
  // Eşleşme iptal olursa (biri kabul etmedi) öneri ekranda asılı kalmasın.
  setTimeout(() => {
    if (state.civSelect?.matchId === matchId) {
      state.civSelect = null;
      pushState();
    }
  }, 90 * 1000);
}

async function detectPickMap(matchId, advice) {
  const cs = state.civSelect;
  if (!cs || cs.matchId !== matchId || cs.map || cs.busy || matchInProgress()) return;
  if (!ai.available()) {
    showCivAdvice(advice, null);
    return;
  }
  cs.busy = true;
  try {
    const img = await withTimeout(captureScreen(), CAPTURE_TIMEOUT_MS, 'Ekran yakalama gecikti');
    const learned = store.settings.learnedMapNames || {};
    const localOf = (en) => Object.keys(learned).find((k) => learned[k] === en);
    const list = advice.pool.map((en) => (localOf(en) ? `${en} (Türkçe: ${localOf(en)})` : en));
    const res = await withTimeout(ai.identifyMap({ data: img.resize({ width: 1600, quality: 'good' }).toJPEG(80).toString('base64'), mediaType: 'image/jpeg' }, list), 20000, 'harita okunamadı');
    const name = advice.pool.find((en) => en.toLowerCase() === String(res.harita || '').replace(/ \(Türkçe:.*\)$/, '').toLowerCase());
    console.log(`ulus seçme ekranı: ekranda "${res.ekrandakiAd}" → ${name || 'eşleşmedi'}`);
    if (name && state.civSelect?.matchId === matchId) {
      state.civSelect.map = name;
      if (res.ekrandakiAd && res.ekrandakiAd !== name) pendingMapLearn = { local: res.ekrandakiAd, en: name };
      showCivAdvice(advice, name);
    }
  } catch (err) {
    console.warn('ulus seçme ekranı:', err.message);
  } finally {
    if (state.civSelect?.matchId === matchId) state.civSelect.busy = false;
  }
}

function showCivAdvice(advice, mapName) {
  const entry = mapName ? advice.advice.haritalar.find((h) => h.harita.toLowerCase() === mapName.toLowerCase()) : null;
  notes.removeWhere((n) => n.key.startsWith('civ-'));
  if (!entry) {
    notes.push('civ-0', 'cmd', `Ulus · harita okunamadı: ${advice.advice.takimKimligi}`.slice(0, 90), 60);
  } else {
    const myName = advice.members.find((m) => m.id === state.localProfileId)?.name;
    const mine = entry.oneriler.find((o) => o.oyuncu === myName);
    notes.push('civ-0', 'cmd', `Ulus önerisi · ${entry.harita}`, 75);
    entry.oneriler.forEach((o, i) => notes.push(`civ-${i + 1}`, 'cmd', `${o.oyuncu === myName ? 'Sen' : o.oyuncu}: ${o.ulus} (${o.rol})`, 75));
    if (mine) flash(`Önerilen ulus: ${mine.ulus}`);
  }
  if (state.civSelect) state.civSelect.status = entry ? 'gösterildi' : 'harita bulunamadı';
  pushNotes();
  pushState();
}

// Maç analizine takıma katkı (pay, rol, kontra uyumu, eksikler) eklenir; eski analizlerde de çalışır.
function withContribution(a) {
  if (!a?.report) return a;
  try {
    return { ...a, contribution: teamContribution(a.report, a.localPid) };
  } catch (err) {
    console.warn('katkı hesaplanamadı:', err.message);
    return a;
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
      if (!liveOn()) return; // canlı koç kapalı: okuma sadece build adımı için
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
  // Yeni maç AoE4World'e düşünce takım verisi tazelensin.
  setTimeout(() => refreshSquad({ force: true }).catch((err) => console.warn('takım:', err.message)), 5 * 60 * 1000);
}

// Maç bittikten sonra kayıt dosyasını analiz eder. Maç sürerken PostGame okumayı reddeder.
async function runPostGame(match, build = null) {
  if (!match.matchId || !postgame || postgame.has(match.matchId)) return;
  state.analysis = { matchId: match.matchId, status: 'running' };
  pushState();
  try {
    console.log(`maç analizi başladı: ${match.matchId}`);
    const result = await postgame.analyzeMatch(match, { localName: myPlayer(match)?.name, build });
    console.log(`maç analizi bitti: ${match.matchId}`);
    store.saveMatch({ matchId: match.matchId, hasAnalysis: true, analysisSummary: result.summary });
    state.analysis = { matchId: match.matchId, status: 'done' };
    broadcast('matches', store.matches);
    if (aiOn('aiReport')) runReport(match.matchId).then(pushState).catch((err) => console.warn('YZ raporu:', err.message));
  } catch (err) {
    console.warn(`maç analizi yapılamadı (${match.matchId}):`, err.message);
    state.analysis = { matchId: match.matchId, status: 'error', message: err.message };
    store.saveMatch({ matchId: match.matchId, analysisError: err.message });
  }
  pushState();
}

// Diskte analizi olduğu halde listede "analiz yok" görünen maçları düzeltir (ör. ayar dosyası
// ezildiğinde kaybolan işaretler).
function reconcileAnalyses() {
  let fixed = 0;
  for (const m of store.matches) {
    if (m.hasAnalysis || !m.matchId) continue;
    const a = postgame.load(m.matchId);
    if (!a) continue;
    const me = a.report?.players.find((p) => p.pid === a.localPid);
    store.saveMatch({ matchId: m.matchId, hasAnalysis: true, analysisSummary: a.summary || (me ? summaryFor(me) : null) });
    fixed++;
  }
  if (fixed) console.log(`${fixed} maçın analiz işareti düzeltildi`);
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
    ...(mapLocalById.has(match.matchId) ? { mapLocal: mapLocalById.get(match.matchId) } : {}),
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
      const local = mapLocalById.get(match.matchId) || store.matches.find((m) => m.matchId === match.matchId)?.mapLocal;
      const maps = { ...(store.settings.learnedMapNames || {}) };
      if (local && game.map && maps[local] !== game.map) maps[local] = game.map;
      store.updateSettings({ learnedCivCodes: learned, learnedMapNames: maps });
      store.saveMatch({ matchId: match.matchId, map: game.map, kind: game.kind, aoe4world: true });
      broadcast('matches', store.matches);
    } catch {
      if (i + 1 < AOE4WORLD_SYNC_DELAYS_MS.length) setTimeout(() => attempt(i + 1), AOE4WORLD_SYNC_DELAYS_MS[i + 1]);
    }
  };
  setTimeout(() => attempt(0), firstDelayMs);
}

// Aynı hata her yarım saniyede günlüğü doldurmasın: değişince ya da dakikada bir yazılır.
const guardSeen = new Map();
function guard(name, fn) {
  try {
    fn();
  } catch (err) {
    const prev = guardSeen.get(name);
    if (!prev || prev.msg !== err.message || Date.now() - prev.at > 60000) {
      console.error(`tik hatası (${name}):`, err);
      guardSeen.set(name, { msg: err.message, at: Date.now() });
    }
  }
}

// Kalıcı yönlendirme notları: köylü dağılımı (build adımı ya da YZ hedefi) oyuncu uygulayana ya da
// karar değişene kadar ekranda kalır; koç uzun süre bakamazsa bu da not olur.
function guidanceNotes(view) {
  const out = [];
  const ai = activeAiTarget();
  if (ai) {
    out.push({ key: 'dist-line', level: commandMode() ? 'cmd' : 'info', text: distributionLine(ai) });
  } else if (view?.build && (view.build.next || view.elapsed - stepStartedAt < 90)) {
    out.push({ key: 'step', level: 'info', text: `Şimdi: ${stepShort(view.build.step)}` });
  }
  const stale = staleNote();
  if (stale) out.push(stale);
  return out;
}

// YZ uzun süredir bakamıyorsa sessizce susmasın.
function staleNote() {
  if (!aiLiveOn || state.phase !== 'playing') return null;
  if (!ai.available()) {
    return coach.elapsed() < 90 ? { key: 'ai-stale', level: 'info', text: 'YZ anahtarı yok: sadece yerel uyarılar' } : null;
  }
  const since = Date.now() - Math.max(lastLiveOkAt, liveStartAt);
  const limit = Math.max(2 * liveIntervalMs(), 4 * 60 * 1000);
  if (since < limit) return null;
  const min = Math.floor(since / 60000);
  return { key: 'ai-stale', level: 'danger', text: `Koç ${min} dk'dır bakamadı${lastLiveError ? `: ${lastLiveError}` : ''}`.slice(0, 80) };
}

function startTicking() {
  stopTicking();
  // Her parça ayrı korunur: birindeki hata (ör. takım verisi) koçun zamanlayıcısını öldürmesin.
  const tick = () => {
    let view = null;
    guard('koç', () => {
      view = coach.tick();
      broadcast('coach', view);
      for (const a of view.due) {
        broadcast('alert', a);
        notes.push(`alert-${a.at}-${a.level}`, a.level, a.short || a.text, 45);
      }
      if (view.build && view.build.index !== lastStepIndex) {
        lastStepIndex = view.build.index;
        stepStartedAt = view.elapsed;
      }
    });
    const elapsed = view ? view.elapsed : coach.elapsed();
    guard('notlar', () => {
      const mates = liveMates();
      // Canlı koç kapalıyken not yok: oyun içinde sadece build paneli görünür.
      notes.setState(liveOn() ? [
        ...monitor.notes(),
        ...guidanceNotes(view),
        ...hudNotes,
        ...teamNotes(lastHud, mates, elapsed),
      ] : []);
      pushNotes();
    });
    guard('yz', scheduleLive);
    guard('overlay', keepOverlayOnTop);
    guard('takım', () => {
      sendTeamStatus(elapsed);
      if (team) {
        state.team = teamView();
        broadcast('team', state.team);
      }
    });
    // İlk 2 dakikadan sonra rakip kartlarını otomatik küçült.
    if (state.cardsVisible && elapsed > 120 && !state.cardsPinned) {
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
  reconcileAnalyses();
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
  watcher.on('matchFound', ({ matchId }) => onMatchFound(matchId));
  watcher.on('matchLoading', ({ match }) => {
    console.log(`maç yükleniyor: ${match.matchId} · ${match.players.map((p) => `${p.name}(${p.team})`).join(', ')}`);
    onMatchLoading(match);
  });
  watcher.on('matchStarted', ({ match }) => {
    console.log(`maç başladı: ${match.matchId}`);
    onMatchStarted(match);
  });
  watcher.on('matchEnded', ({ match }) => {
    console.log(`maç bitti: ${match.matchId}`);
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

// Windows açılışında arka planda başlatıldıysa (--hidden) panel görünmez; uygulamayı tekrar açınca gelir.
const START_HIDDEN = process.argv.includes('--hidden');

function createDashboard() {
  dashboardWin = new BrowserWindow({
    show: !START_HIDDEN,
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
  'Control+Alt+A': () => (liveOn() ? runLive({ manual: true }) : flash('Canlı koç kapalı (Ayarlar)')),
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
  'Control+Alt+N': () => {
    if (!liveOn()) {
      flash('Canlı koç kapalı (Ayarlar)');
      return;
    }
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
    for (const k of ['aiPrematch', 'aiLive', 'aiVision', 'aiReport', 'aiTranslate', 'aiResearch', 'civAdvice', 'liveCoach', 'startWithWindows']) if (k in patch) allowed[k] = Boolean(patch[k]);
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
    if ('liveCoach' in allowed) refreshAiState();
    if ('startWithWindows' in allowed) applyLoginItem();
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
        autoCandidates = currentSeasonBuilds(await library.list(state.myCiv.guide));
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
  ipcMain.handle('analysis:get', (_e, matchId) => withContribution(postgame.load(Number(matchId))));
  ipcMain.handle('analysis:import', async () => {
    const res = await dialog.showOpenDialog(dashboardWin, {
      title: 'Kayıt dosyası seç',
      defaultPath: postgame.playbackDir,
      filters: [{ name: 'AoE4 kaydı', extensions: ['rec'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const localName = myPlayer(state.match)?.name || store.matches.flatMap((m) => m.players).find((p) => p.profileId === state.localProfileId)?.name;
    return withContribution(await postgame.analyzeFile(res.filePaths[0], { localName }));
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
    // Diske gerçekten yazıldı mı: dosyadan geri okuyup say.
    let saved = 0;
    try {
      saved = Object.keys(JSON.parse(fs.readFileSync(store.settingsPath, 'utf8')).hudRegions?.fields || {}).length;
    } catch (err) {
      console.error('kalibrasyon geri okunamadı:', err.message);
    }
    console.log(`kalibrasyon kaydedildi: ${Object.keys(cal.fields).length} alan, diskte ${saved}`);
    if (saved !== Object.keys(cal.fields).length) throw new Error(`Kalibrasyon diske yazılamadı (${store.lastWrite?.error || 'bilinmeyen hata'})`);
    return { settings: s, saved };
  });
  ipcMain.handle('diag:get', () => ({
    version: app.getVersion(),
    userData: app.getPath('userData'),
    logFile: logger.log.path(),
    lastWrite: store.lastWrite,
    keys: { gemini: Boolean(store.settings.geminiKeyEnc), claude: Boolean(store.settings.aiKeyEnc) },
    calibrated: Boolean(store.settings.hudRegions?.fields),
    lastLiveOkAt,
    lastLiveError,
  }));
  ipcMain.handle('diag:openLogs', () => shell.openPath(path.dirname(logger.log.path() || app.getPath('userData'))));
  ipcMain.handle('ai:setKey', (_e, provider, key) => saveApiKey(provider, key));
  ipcMain.handle('ai:test', () => ai.testConnection());
  ipcMain.handle('ai:ask', () => runLive({ manual: true }));
  ipcMain.handle('ai:report', (_e, matchId) => runReport(Number(matchId)));
  ipcMain.handle('squad:get', () => ({ squad: readUserJson('squad.json', null), advice: readUserJson('civ-advice.json', null) }));
  ipcMain.handle('squad:refresh', async (_e, withAdvice) => {
    const squad = await refreshSquad({ force: true });
    // "Verileri yenile" ekipçe ortak öneriyi de sunucudan çeker; "Önerileri yenile" yeniden hesaplar.
    const advice = withAdvice ? await refreshCivAdvice({ force: true }) : await syncSharedAdvice();
    return { squad, advice };
  });
  ipcMain.handle('review:get', () => readUserJson('review.json', null));
  ipcMain.handle('review:run', () => runReview());
  ipcMain.handle('chat:get', () => chatLog());
  ipcMain.handle('chat:send', (_e, text) => chatSend(text));
  ipcMain.handle('chat:clear', () => {
    chatHistory = [];
    fs.writeFileSync(userFile('chat.json'), '[]');
    return chatHistory;
  });
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

// Ana süreçteki beklenmeyen hatalar uygulamayı durdurmasın ve kaybolmasın: günlüğe yazılır.
process.on('uncaughtException', (err) => console.error('yakalanmamış hata:', err));
process.on('unhandledRejection', (err) => console.error('yakalanmamış ret:', err));

if (!app.requestSingleInstanceLock()) {
  // Aynı veri klasörünü iki uygulama birden kullanırsa birbirinin kayıtlarını ezer.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (dashboardWin) {
      if (!dashboardWin.isVisible()) dashboardWin.show();
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
    const logFile = logger.init(path.join(app.getPath('userData'), 'logs'));
    store = new Store(app.getPath('userData'));
    const s = store.settings;
    console.log(`başladı: sürüm ${app.getVersion()}${app.isPackaged ? '' : ' (geliştirme)'} · veri: ${app.getPath('userData')} · günlük: ${logFile}`);
    console.log(`ayarlar: sağlayıcı=${s.aiProvider} geminiAnahtarı=${Boolean(s.geminiKeyEnc)} claudeAnahtarı=${Boolean(s.aiKeyEnc)} kalibrasyon=${Boolean(s.hudRegions?.fields)} ekranOkuma=${s.screenReadingEnabled} canlıKoç=${s.liveCoach === true} mod=${s.coachMode} build=${JSON.stringify(s.buildByCiv)}`);
    library = new BuildLibrary(path.join(app.getPath('userData'), 'cache'));
    screenReader = new ScreenReader(path.join(app.getPath('userData'), 'ocr'));
    for (const [code, slug] of Object.entries(store.settings.learnedCivCodes)) civs.learnLogCode(code, slug);
    state.localProfileId = store.settings.profileId;
    state.overlayEnabled = store.settings.overlayEnabled;
    refreshAiState();
    state.teamServer = Boolean(store.settings.teamServerUrl || DEFAULT_TEAM_SERVER);

    registerIpc();
    applyLoginItem();
    createDashboard();
    createOverlay();
    registerShortcuts();
    startWatcher();
    setupUpdater();
    setTimeout(backgroundTeamRefresh, 15000);
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    screenReader?.close();
  });
}
