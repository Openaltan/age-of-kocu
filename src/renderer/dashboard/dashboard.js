import { el, fill, clock, note, resourceRow, stepSentence, playerCard, insightList, markdown } from '../shared/ui.js';
import { lineChart } from './chart.js';
import { renderCalibration, onCalibrationImage } from './calibration.js';

const api = window.kocu;
const views = Object.fromEntries([...document.querySelectorAll('.view')].map((v) => [v.id.replace('view-', ''), v]));
let state = null;
let settings = null;
let matches = [];
let civList = [];
let current = 'live';

// ---------- Gezinme ----------
document.getElementById('nav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) show(btn.dataset.view);
});

// Menüde olmayan alt sayfalar, açıldıkları ana sekmeyi vurgular.
const PARENT = { search: 'team', history: 'analysis', screen: 'settings' };

function show(name) {
  current = name;
  for (const [k, v] of Object.entries(views)) v.hidden = k !== name;
  const navKey = PARENT[name] || name;
  for (const b of document.querySelectorAll('#nav button')) b.classList.toggle('active', b.dataset.view === navKey);
  RENDER[name]?.();
}

// ---------- Durum çubuğu ----------
const PHASE_TEXT = { idle: 'Maç bekleniyor', loading: 'Yükleme ekranı', playing: 'Maç sürüyor', ended: 'Maç bitti' };

function renderStatus() {
  const s = state;
  const me = s.match?.players.find((p) => p.profileId === s.localProfileId);
  document.getElementById('status').replaceChildren(
    el('div', { class: s.logFound ? 'ok' : 'bad' }, el('span', { class: 'dot' }), s.logFound ? 'AoE4 bağlı' : 'AoE4 log bulunamadı'),
    el('div', { class: s.phase === 'playing' ? 'live' : '' }, el('span', { class: 'dot' }), PHASE_TEXT[s.phase] + (s.simulated ? ' (deneme)' : '')),
    el('div', {}, el('span', { class: 'dot' }), me ? me.name : s.localProfileId ? `Profil ${s.localProfileId}` : 'Profil bekleniyor'),
    updateStatus(s),
  );
}

// Otomatik güncelleme: arka planda iner; hazır olunca tek tıkla kurulur (maç sırasında kurulmaz).
function updateStatus(s) {
  const u = s.update;
  if (u?.status === 'ready') {
    return el('div', { class: 'update' },
      el('span', { text: `Yeni sürüm hazır: ${u.version}` }),
      el('button', { class: 'btn primary', text: 'Yeniden başlat ve güncelle', onclick: async (e) => {
        try { await api.installUpdate(); } catch (err) { e.target.textContent = err.message.replace(/^.*Error: /, ''); }
      } }));
  }
  if (u?.status === 'downloading') return el('div', { class: 'muted', text: `Güncelleme iniyor: ${u.version}${u.percent != null ? ` (%${u.percent})` : ''}` });
  return el('div', { class: 'muted', text: `Sürüm ${s.version || ''}` });
}

// ---------- Canlı maç ----------
let liveStepKey = null;
let liveRefs = null;

function renderLive() {
  const v = views.live;
  liveStepKey = null;
  const s = state;
  if (s.phase === 'idle' || s.phase === 'ended' || !s.match) {
    fill(v, 
      el('h1', { text: 'Canlı Maç' }),
      el('p', { class: 'lead', text: 'Ranked maç bulunduğunda yükleme ekranında rakipler otomatik analiz edilir, maç başlayınca koç devreye girer.' }),
      calibrationWarning(),
      lastMatchBox(),
      el('div', { class: 'box' },
        el('p', {}, el('b', { text: 'Overlay\'in oyunun üstünde görünmesi için: ' }), 'AoE4 › Ayarlar › Grafik › Ekran Modu: ', el('b', { text: 'Tam Ekran Pencereli' }), '.'),
        el('p', { class: 'muted', text: 'Oyuna girmeden denemek için deneme maçı başlat. Log\'daki son maçın oyuncuları kullanılır, saat şimdiden işlemeye başlar.' }),
        el('div', { class: 'row' },
          el('button', { class: 'btn primary', onclick: () => api.startSimulation(), text: 'Deneme maçı başlat' }),
        ),
      ),
    );
    return;
  }

  const sc = s.scouting;
  fill(v, 
    el('div', { class: 'match-head' },
      el('div', {},
        el('h1', { text: PHASE_TEXT[s.phase] + (s.simulated ? ' (deneme)' : '') }),
        el('div', { class: 'row' },
          s.myCiv ? el('span', { class: 'pill gold', text: s.myCiv.tr }) : null,
          s.match.matchId ? el('span', { class: 'pill', text: `Maç #${s.match.matchId}` }) : null,
        ),
      ),
      el('div', { class: 'row' },
        s.phase === 'playing' ? el('span', { class: 'big-clock', id: 'live-clock', text: '0:00' }) : null,
        s.simulated ? el('button', { class: 'btn', onclick: () => api.stopSimulation(), text: 'Denemeyi bitir' }) : null,
      ),
    ),
    calibrationWarning(),
    s.buildAuto ? el('div', { class: 'box' },
      el('p', {}, el('b', { text: s.buildAuto.mode === 'serbest' ? 'Serbest build: ' : 'Otomatik build: ' }),
        s.buildAuto.status === 'waiting'
          ? (s.buildAuto.mode === 'serbest' ? 'koç rakiplere göre özel build yazıyor…' : 'koç rakiplere bakıp seçiyor…')
          : `${s.buildAuto.name} (${s.buildAuto.source})`),
      s.buildAuto.reason ? el('p', { class: 'muted', text: s.buildAuto.reason }) : null,
      s.buildAuto.kilitNoktalar?.length ? el('ul', {}, s.buildAuto.kilitNoktalar.map((k) => el('li', { text: k }))) : null,
    ) : null,
    intelBox(s.intel),
    s.phase === 'playing' ? el('div', { id: 'live-step' }) : null,
    s.phase === 'playing' ? [el('h2', { text: 'Takımım' }), el('div', { id: 'live-team' }, teamBox(s.team))] : null,
    aiLiveSection(s),
    el('h2', { text: 'Rakipler' }),
    sc ? el('div', { class: 'grid' }, sc.enemies.map((c) => playerCard(c))) :
      el('p', { class: 'muted', text: s.scoutingError ? `Analiz başarısız: ${s.scoutingError}` : 'Rakipler analiz ediliyor…' }),
    sc && sc.allies.length ? [el('h2', { text: 'Takımın' }), el('div', { class: 'grid' }, sc.allies.map((c) => playerCard(c, { ally: true })))] : null,
  );
}

// Harita ve güncel meta: AoE4World istatistikleri ve internet araştırması (koçun bildikleri).
// Panel sık yeniden çizildiği için açık/kapalı durumu burada tutulur.
let intelOpen = false;

function intelBox(intel) {
  if (!intel?.meta) return null;
  const m = intel.meta;
  const rate = (r) => (r ? `%${r.kazanma} kazanma · %${r.secilme} seçilme` : 'veri yok');
  return el('details', { class: 'box intel', open: intelOpen, ontoggle: (e) => { intelOpen = e.target.open; } },
    el('summary', {}, el('b', { text: 'Harita ve meta: ' }), m.harita?.ad || intel.mapLocal || 'harita bilinmiyor',
      m.harita?.ortalamaMacDk ? ` · ortalama maç ${m.harita.ortalamaMacDk} dk` : ''),
    m.harita?.haritadaEnIyi5?.length ? el('p', {}, el('b', { text: 'Bu haritada en çok kazananlar: ' }), m.harita.haritadaEnIyi5.join(' · ')) : null,
    m.benimUlkem ? el('p', {}, el('b', { text: `${m.benimUlkem.ulke}: ` }), rate(m.benimUlkem.genel), m.benimUlkem.buHaritada ? ` · bu haritada ${m.benimUlkem.buHaritada}` : '') : null,
    m.rakipUlkeler?.length ? el('ul', {}, m.rakipUlkeler.map((r) => el('li', {}, el('b', { text: `${r.ulke}: ` }), rate(r.genel), r.buHaritada ? ` · bu haritada ${r.buHaritada}` : ''))) : null,
    intel.research ? [
      el('p', { class: 'muted', text: 'İnternetten araştırma:' }),
      el('div', { class: 'research', text: intel.research.text }),
      intel.research.sources?.length ? el('p', { class: 'muted' }, 'Kaynaklar: ', intel.research.sources.map((src, i) => [i ? ' · ' : '', el('a', { href: src.url, target: '_blank', text: src.title })])) : null,
    ] : null,
    el('p', { class: 'muted', text: 'İstatistikler AoE4World\'ün son yamalardaki verilerinden.' }),
  );
}

// Kalibrasyon yoksa kaynak/köylü okuma, mini harita ve kayıp algılama hiç çalışmaz.
function calibrationWarning() {
  if (settings?.hudRegions?.fields && settings.screenReadingEnabled !== false) return null;
  // Canlı koç kapalıyken kalibrasyon isteğe bağlı: sadece build adımlarını köylü sayınla eşler.
  if (!state?.liveCoach) {
    return el('p', { class: 'muted' }, 'İsteğe bağlı: ekran okumayı kalibre edersen build adımları saatle değil gerçek köylü sayınla ilerler ve başlangıcın bittiği daha doğru anlaşılır. ',
      el('button', { class: 'btn', text: 'Ekran Okuma', onclick: () => show('screen') }));
  }
  return el('div', { class: 'box' },
    el('p', { class: 'res-loss', text: settings?.hudRegions?.fields ? 'Ekran okuma ayarlardan kapalı.' : 'Ekran okuma kalibre edilmemiş: koç kaynaklarını, köylülerini ve mini haritayı göremiyor; sadece birkaç dakikada bir ekran görüntüsüne bakıyor.' }),
    el('button', { class: 'btn primary', text: 'Ekran Okuma ayarına git', onclick: () => show('screen') }),
  );
}

function renderLiveCoach(view) {
  if (current !== 'live' || !view) return;
  const clockEl = document.getElementById('live-clock');
  if (clockEl) clockEl.textContent = clock(view.elapsed);
  const host = document.getElementById('live-step');
  if (!host) return;
  const b = view.build;
  const key = b ? `${b.name}|${b.index}|${b.manual}` : 'none';
  if (key === liveStepKey) {
    if (liveRefs?.nextIn && b?.nextInSec != null) liveRefs.nextIn.textContent = clock(b.nextInSec);
    return;
  }
  liveStepKey = key;
  if (!b) {
    fill(host, el('div', { class: 'box' }, el('p', { text: 'Bu ülke için build order yok. Build Order sekmesinden seç.' })));
    return;
  }
  const nextIn = el('span', { text: b.nextInSec != null ? clock(b.nextInSec) : '' });
  liveRefs = { nextIn };
  fill(host, el('div', { class: 'box step-box' },
    el('div', { class: 'row muted' }, `${b.name} — ${b.author}`, el('span', { class: 'pill', text: `Adım ${b.index + 1}/${b.total}` }), b.manual ? el('span', { class: 'pill gold', text: 'Elle ayarlandı' }) : null),
    el('div', { class: 'say', text: stepSentence(b.step) }),
    resourceRow(b.step),
    b.step.notes.length ? el('div', { class: 'notes' }, b.step.notes.map(note)) : null,
    b.next ? el('p', { class: 'muted' }, 'Sonraki', b.nextInSec != null ? [' (', nextIn, ')'] : null, ': ', stepSentence(b.next)) : null,
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: () => api.shiftStep(-1), text: '◀ Geri' }),
      el('button', { class: 'btn', onclick: () => api.shiftStep(+1), text: 'İleri ▶' }),
      el('button', { class: 'btn', onclick: () => api.adjustClock(-10), text: 'Saat −10 sn' }),
      el('button', { class: 'btn', onclick: () => api.adjustClock(+10), text: 'Saat +10 sn' }),
    ),
  ));
}

function lastMatchBox() {
  const m = matches[0];
  if (!m) return null;
  return el('div', { class: 'box' },
    el('p', {}, el('b', { text: 'Son maç: ' }),
      m.result === 'win' ? el('span', { class: 'res-win', text: 'Galibiyet' }) : m.result === 'loss' ? el('span', { class: 'res-loss', text: 'Mağlubiyet' }) : 'Sonuç bekleniyor',
      ` · ${clock(m.durationSec)}`, m.map ? ` · ${m.map}` : ''),
    m.hasAnalysis ? el('button', { class: 'btn primary', text: 'Maç analizini aç', onclick: () => openAnalysis(m.matchId) })
      : el('p', { class: 'muted', text: state.analysis?.matchId === m.matchId && state.analysis.status === 'running' ? 'Kayıt analiz ediliyor…' : 'Bu maçın analizi yok.' }),
  );
}

function openAnalysis(matchId) {
  importedAnalysis = null;
  analysisKey = matchId;
  show('analysis');
}

// ---------- Maç Analizi ----------
let analysisKey = null; // seçili maçın matchId'si
let importedAnalysis = null; // dosyadan açılan kayıt (saklanmaz)

const ANALYSIS_STATUS = { running: 'Son maçın kaydı analiz ediliyor…', error: 'Son maçın analizi yapılamadı' };

async function renderAnalysis() {
  const v = views.analysis;
  const analyzed = matches.filter((m) => m.hasAnalysis);
  if (!importedAnalysis && !analyzed.some((m) => m.matchId === analysisKey)) analysisKey = analyzed[0]?.matchId ?? null;

  const picker = el('select', { onchange: (e) => { importedAnalysis = null; analysisKey = Number(e.target.value); renderAnalysis(); } },
    analyzed.map((m) => el('option', { value: m.matchId, selected: !importedAnalysis && m.matchId === analysisKey, text: matchLabel(m) })));
  const st = state.analysis;
  const head = [
    el('h1', { text: 'Maç Analizi' }),
    el('p', { class: 'lead', text: 'Maç bitince oyunun kayıt dosyası otomatik incelenir: çağ atlama zamanları, köylü üretimi, ordu ve rakiplerle kıyas. Kayıt maç bitmeden asla okunmaz.' }),
    el('div', { class: 'row' },
      analyzed.length ? picker : null,
      el('button', { class: 'btn', text: 'Tüm maçlar', onclick: () => show('history') }),
      el('button', { class: 'btn', text: 'Kayıt dosyası aç…', onclick: async () => {
        const r = await api.importReplay().catch((err) => ({ error: err.message }));
        if (!r) return;
        if (r.error) { alert(`Kayıt açılamadı: ${r.error}`); return; }
        importedAnalysis = r;
        renderAnalysis();
      } }),
    ),
    st && st.status !== 'done' ? el('p', { class: st.status === 'error' ? 'res-loss' : 'muted', text: `${ANALYSIS_STATUS[st.status]}${st.message ? `: ${st.message}` : ''}` }) : null,
    missingAnalyses(),
  ];

  let a = importedAnalysis;
  let m = null;
  if (!a && analysisKey != null) {
    a = await api.getAnalysis(analysisKey);
    m = matches.find((x) => x.matchId === analysisKey);
  }
  if (!a) {
    fill(v, head, el('div', { class: 'box' }, el('p', { class: 'muted', text: 'Henüz analiz edilmiş maç yok. Uygulama açıkken bir maç bitirdiğinde burada görünecek; eski bir kaydı da "Kayıt dosyası aç" ile inceleyebilirsin.' })));
    return;
  }
  fill(v, head, analysisBody(a, m));
}

// Son maçlardan analizi olmayanlar ve nedeni: çoğunlukla uygulama kapalıyken oynanmış (oyun sadece
// son maçın kaydını tutar).
function missingAnalyses() {
  const list = matches.slice(0, 15).filter((m) => !m.hasAnalysis && (m.durationSec || 0) > 120);
  if (!list.length) return null;
  return el('details', { class: 'box' },
    el('summary', {}, `Son maçlardan ${list.length} tanesi analiz edilmedi`),
    el('ul', {}, list.map((m) => el('li', {}, matchLabel(m), ' · ', el('span', { class: 'muted', text: m.analysisError ? `hata: ${m.analysisError}` : 'uygulama o maç bittiğinde kapalıydı' })))),
    el('p', { class: 'muted', text: 'Oyun sadece son maçın kaydını (temp.rec) tutar; sonraki maç başlayınca önceki kayıt silinir. Her maçın analiz edilmesi için Ayarlar\'dan "Windows açılınca arka planda başlat"ı aç. AoE4World herkese açık API\'sinde sadece maç sonucu (ülke, harita, süre, puan) var; ayrıntılı analiz bu yüzden bilgisayarındaki kayıttan yapılır.' }),
  );
}

function matchLabel(m) {
  const d = m.playedAt ? new Date(m.playedAt).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' }) : '';
  const res = m.result === 'win' ? 'Galibiyet' : m.result === 'loss' ? 'Mağlubiyet' : '';
  return [d, m.map, res].filter(Boolean).join(' · ');
}

function analysisBody(a, m) {
  const { report } = a;
  const me = report.players.find((p) => p.pid === a.localPid) || null;
  const myTeam = me ? me.team : report.players[0].team;
  const allies = report.players.filter((p) => p.team === myTeam);
  const enemies = report.players.filter((p) => p.team !== myTeam);

  return [
    el('div', { class: 'row' },
      m?.result ? el('span', { class: m.result === 'win' ? 'pill res-win' : 'pill res-loss', text: m.result === 'win' ? 'Galibiyet' : 'Mağlubiyet' }) : null,
      el('span', { class: 'pill', text: `Süre ${clock(report.durationSec)}` }),
      m?.map ? el('span', { class: 'pill', text: m.map }) : null,
      a.source ? el('span', { class: 'pill', text: a.source }) : null,
      a.buildName ? el('span', { class: 'pill gold', text: `Build: ${a.buildName}` }) : null,
    ),
    contributionSection(a.contribution),
    el('h2', { text: 'Eksiklerin ve hataların' }),
    me ? el('div', { class: 'box findings' }, a.findings.length ? insightList(a.findings) : el('p', { class: 'muted', text: 'Belirgin bir sorun bulunmadı.' }))
      : el('div', { class: 'box' }, el('p', { class: 'muted', text: 'Bu kayıtta seni bulamadım; tablo tüm oyuncuları gösteriyor.' })),
    aiReportSection(a, m),
    el('h2', { text: 'Karşılaştırma' }),
    compareTable(allies, enemies, me),
    el('h2', { text: 'Zaman içinde' }),
    el('div', { class: 'charts' },
      lineChart({ title: 'Üretilen köylü', series: chartSeries(me, allies, enemies, (p) => p.villagers.series) }),
      lineChart({ title: 'Üretilen asker', series: chartSeries(me, allies, enemies, (p) => p.military.series) }),
    ),
    el('p', { class: 'muted', text: 'Köylü sayıları üretim komutlarından tahmin edilir; ölen köylüler kayıtta görünmez.' }),
    el('h2', { text: 'Ordular' }),
    el('div', { class: 'armies' }, [...allies, ...enemies].map(armyBox)),
  ];
}

// Takıma katkı: maçta kim ne kadar ekonomi/ordu taşıdı, rolü, rakibe karşı kontra uyumu ve eksikleri.
function contributionSection(c) {
  if (!c?.oyuncular?.length) return null;
  const pct = (v) => (v == null ? '–' : `%${v}`);
  const diff = (s) => (s == null ? '–' : s === 0 ? 'ortalama' : `${s > 0 ? '+' : '−'}${clock(Math.abs(s))}`);
  return [
    el('h2', { text: 'Takıma katkı' }),
    el('div', { class: 'box cmp-wrap' },
      c.rakipAgirligi ? el('p', {}, el('b', { text: 'Rakibin ağırlığı: ' }), `ordusunun %${c.rakipAgirligi.pay}'i ${c.rakipAgirligi.rol}; kontrası ${c.rakipAgirligi.kontra}.`) : null,
      el('table', { class: 'cmp' },
        el('tr', {}, ['Oyuncu', 'Rol', 'Ekonomi payı (15. dk köylü)', 'Ordu payı', "Feodal (takıma göre)", 'Kontra payı', 'Eksikler'].map((h) => el('th', { text: h }))),
        c.oyuncular.map((p) => el('tr', { class: p.me ? 'me' : '' },
          el('td', {}, el('b', { text: p.name }), el('div', { class: 'muted', text: p.civTr })),
          el('td', { text: p.role }),
          el('td', { text: pct(p.ekonomiPayi) }),
          el('td', { text: pct(p.orduPayi) }),
          el('td', {}, el('span', { class: p.feodalFark >= 60 ? 'bad' : '', text: diff(p.feodalFark) })),
          el('td', {}, el('span', { class: p.kontraPayi != null && p.kontraPayi < 20 ? 'bad' : '', text: pct(p.kontraPayi) })),
          el('td', { class: 'wrap' }, p.eksikler.length ? el('ul', {}, p.eksikler.map((e) => el('li', { text: e }))) : el('span', { class: 'muted', text: 'Belirgin eksik yok' })),
        )),
      ),
      el('p', { class: 'muted', text: 'Paylar takımın toplamına göre (köylü: 15. dakikaya kadar üretilen; ordu: maç boyu basılan asker). Kontra payı: rakibin ağırlıklı birimine karşı etkili birimlerin ordudaki oranı.' }),
    ),
  ];
}

function chartSeries(me, allies, enemies, pick) {
  const mean = (ps) => {
    if (!ps.length) return [];
    const n = Math.max(...ps.map((p) => pick(p).length));
    return Array.from({ length: n }, (_, i) => Math.round(ps.reduce((s, p) => s + (pick(p)[i] ?? pick(p)[pick(p).length - 1] ?? 0), 0) / ps.length));
  };
  const others = allies.filter((p) => p !== me);
  const out = [];
  if (me) out.push({ label: 'Sen', values: pick(me) });
  out.push({ label: 'Rakip ort.', values: mean(enemies) });
  if (others.length) out.push({ label: me ? 'Takım ort.' : 'Takım', values: mean(me ? others : allies) });
  return out;
}

function compareTable(allies, enemies, me) {
  const enemyFeudal = enemies.map((p) => p.ageUps[2]).filter((x) => x != null);
  const bestFeudal = enemyFeudal.length ? Math.min(...enemyFeudal) : null;
  const row = (p, sep) => el('tr', { class: [p === me ? 'me' : '', sep ? 'team-sep' : ''].join(' ') },
    el('td', {}, el('b', { text: p.name })),
    el('td', { class: 'muted', text: p.civTr }),
    el('td', {}, el('span', { class: bestFeudal != null && p.ageUps[2] - bestFeudal >= 60 ? 'bad' : '', text: clock(p.ageUps[2]) })),
    el('td', { text: clock(p.ageUps[3]) }),
    el('td', { text: clock(p.ageUps[4]) }),
    el('td', {}, el('span', { class: p.villagers.tcIdleFirst10 >= 90 ? 'bad' : '', text: clock(p.villagers.tcIdleFirst10) })),
    el('td', { text: p.villagers.producedBy[10] }),
    el('td', { text: p.villagers.producedBy[15] }),
    el('td', { text: clock(p.military.firstAt) }),
    el('td', { text: p.military.by[15] }),
    el('td', { text: p.military.total }),
    el('td', { text: p.ecoTechs.length }),
    el('td', { text: p.apm }),
  );
  const heads = ['Oyuncu', 'Ülke', 'Feodal', 'Kale', 'İmp.', 'Merkez boşta (ilk 10 dk)', 'Köylü 10. dk', 'Köylü 15. dk', 'İlk asker', 'Asker 15. dk', 'Toplam asker', 'Eko tekn.', 'APM'];
  return el('div', { class: 'box cmp-wrap' }, el('table', { class: 'cmp' },
    el('tr', {}, heads.map((h) => el('th', { text: h }))),
    allies.map((p, i) => row(p, i === allies.length - 1)),
    enemies.map((p) => row(p, false)),
  ), el('p', { class: 'muted', text: 'Çağ sütunları landmark\'ın yerleştirildiği anı gösterir; inşaat süresi eklenmez.' }));
}

function armyBox(p) {
  const r = p.military.roles;
  const total = p.military.total || 1;
  const pct = (k) => Math.round((r[k] / total) * 100);
  return el('div', { class: 'box' },
    el('div', { class: 'row' }, el('b', { text: p.name }), el('span', { class: 'muted', text: `${p.civTr} · ${p.military.total} asker` })),
    p.military.total ? el('p', { class: 'muted', text: `Atlı %${pct('cavalry')} · Menzilli %${pct('ranged')} · Piyade %${pct('infantry')} · Kuşatma %${pct('siege')}` }) : null,
    el('div', { class: 'top-civs' }, p.military.composition.slice(0, 6).map((c) => el('span', { class: 'chip' }, c.name, el('b', { text: c.count })))),
  );
}

// ---------- Takım ----------
function teamBox(t) {
  if (!t) {
    return el('p', { class: 'muted', text: settings.teamSyncEnabled === false ? 'Takım senkronu kapalı (Ayarlar › Takım).' : 'Takım odasına bağlanılamadı: bu maçta profilin bulunamadı.' });
  }
  const n = (v) => (v == null ? '–' : v);
  return el('div', { class: 'box cmp-wrap' },
    el('p', { class: t.connected ? 'res-win' : 'muted', text: t.connected ? `Takım odasına bağlı · ${t.members.length} arkadaş görünüyor` : 'Takım odasına bağlanılıyor…' }),
    t.members.length ? el('table', { class: 'cmp' },
      el('tr', {}, ['Oyuncu', 'Ülke', 'Köylü', 'Nüfus', 'Yemek', 'Odun', 'Altın', 'Taş', 'Uyarılar'].map((h) => el('th', { text: h }))),
      t.members.map((m) => {
        const st = m.status || {};
        const r = st.res || {};
        return el('tr', {},
          el('td', {}, el('b', { text: m.name })), el('td', { class: 'muted', text: n(st.civ) }),
          el('td', { text: n(st.villagers) }), el('td', { text: n(st.pop) }),
          el('td', { text: n(r.food) }), el('td', { text: n(r.wood) }), el('td', { text: n(r.gold) }), el('td', { text: n(r.stone) }),
          el('td', { class: 'wrap' }, [st.risk, ...(st.notes || [])].filter(Boolean).map((x) => el('span', { class: 'pill res-loss', text: x }))),
        );
      }),
    ) : el('p', { class: 'muted', text: 'Arkadaşların henüz bağlanmadı. Onlarda da Age of Koçu açık olmalı (gizli kod kullanıyorsanız aynı kod girili olmalı).' }),
  );
}

function teamSettingsSection() {
  const code = el('input', { type: 'text', value: settings.teamCode || '', placeholder: 'Boş bırak (otomatik)', autocomplete: 'off' });
  const msg = el('span', { class: 'muted' });
  return [
    el('h2', { text: 'Takım' }),
    el('div', { class: 'box' },
      el('label', { class: 'check' },
        el('input', { type: 'checkbox', checked: settings.teamSyncEnabled !== false, onchange: async (e) => { settings = await api.updateSettings({ teamSyncEnabled: e.target.checked }); } }),
        'Maçta takım arkadaşlarımla otomatik bağlan'),
      el('p', { class: 'muted', text: 'Kurulum gerekmez: aynı maçta aynı takımda olan ve Age of Koçu\'su açık arkadaşların kendiliğinden bağlanır. Herkes takımın köylü, nüfus, kaynak ve uyarılarını görür; Ctrl+Alt+Y yardım çağrısı gider.' }),
      el('label', { class: 'field' }, 'Gizli takım kodu (isteğe bağlı)', code),
      el('p', { class: 'muted', text: 'Kod girerseniz rakip (uygulamayı bilerek değiştirse bile) takım odanızı bulamaz. Kod kullanacaksanız üçünüz de aynı kodu girin; birinin kodu boş, diğerinin dolu olursa bağlanamazsınız.' }),
      el('div', { class: 'row' },
        el('button', { class: 'btn', text: 'Kaydet', onclick: async () => {
          settings = await api.updateSettings({ teamCode: code.value });
          msg.textContent = 'Kaydedildi. Bir sonraki maçta geçerli.';
        } }),
        msg,
      ),
    ),
  ];
}

// ---------- Yapay zekâ koç ----------
const GUVEN = { 'düşük': 'muted', orta: '', 'yüksek': 'res-loss' };
const KOMUT_TR = { ekonomi: 'Ekonomi', insaat: 'İnşaat', uretim: 'Üretim', arastirma: 'Araştırma', cag: 'Çağ', askeri: 'Askeri' };

function aiLiveSection(s) {
  const a = s.ai;
  if (!s.liveCoach) {
    return el('div', { class: 'box' },
      el('p', {}, el('b', { text: 'Oyun içinde sadece build başlangıcı görünür. ' }), 'Panel adım adım ne yapacağını ve hedef süresini gösterir; başlangıç bitince çekilir. Maç bitince kayıt incelenir: hatalar, eksikler ve takıma katkın Maç Analizi\'nde.'),
      el('p', { class: 'muted', text: 'Canlı koç (YZ ile maç içi uyarılar) deneysel ve kapalı; Ayarlar › Canlı koç bölümünden açılabilir.' }),
    );
  }
  if (!a?.available) {
    return el('div', { class: 'box' }, el('p', { class: 'muted', text: 'Yapay zekâ koç kapalı. Ayarlar › Yapay Zekâ Koç bölümünden ücretsiz Gemini anahtarını gir.' }));
  }
  const plan = a.plan;
  return [
    el('h2', { text: 'Koçun oyun planı' }),
    a.planStatus === 'running' ? el('p', { class: 'muted', text: 'Koç rakipleri ve geçmişini inceleyip plan hazırlıyor…' }) : null,
    a.planStatus === 'error' ? el('p', { class: 'res-loss', text: `Plan hazırlanamadı: ${a.planError}` }) : null,
    plan ? el('div', { class: 'box ai-plan' },
      el('p', { class: 'ai-lead', text: plan.ozet }),
      el('table', { class: 'cmp' },
        el('tr', {}, ['Rakip', 'Tahmin', 'Zamanlama', 'Güven'].map((h) => el('th', { text: h }))),
        plan.rakipTahminleri.map((t) => el('tr', {},
          el('td', {}, el('b', { text: t.oyuncu })), el('td', { class: 'wrap', text: t.tahmin }), el('td', { text: t.zamanlama }),
          el('td', {}, el('span', { class: GUVEN[t.guven] || '', text: t.guven })))),
      ),
      el('p', {}, el('b', { text: 'Kontra: ' }), plan.kontraOnerisi),
      el('p', {}, el('b', { text: 'Takım: ' }), plan.takimKoordinasyonu),
      el('p', { class: 'muted' }, 'Zamanlı hatırlatmalar: ', plan.planAdimlari.map((x) => `${clock(x.dakika * 60)} ${x.mesaj}`).join(' · ')),
    ) : null,
    s.phase === 'playing' ? [
      el('h2', { text: 'Canlı değerlendirmeler' }),
      el('div', { class: 'row' },
        el('button', { class: 'btn primary', text: a.liveStatus === 'running' ? 'Koç bakıyor…' : 'Koça sor (Ctrl+Alt+A)', disabled: a.liveStatus === 'running', onclick: () => api.askCoach() }),
        a.liveStatus === 'error' ? el('span', { class: 'res-loss', text: a.liveError }) : null,
      ),
      a.combat ? el('p', { class: 'res-loss', text: 'Savaş modu: koç 30 saniyede bir bakıyor, ekonomi notları susturuldu.' }) : null,
      a.players?.length ? el('p', { class: 'muted' }, 'Oyuncu renkleri: ', a.players.map((p, i) => [i ? ' · ' : '', el('b', { text: p.name }), ` ${p.renk || '?'}${p.role === 'enemy' ? ' (rakip)' : p.role === 'me' ? ' (sen)' : ''}${p.cag ? ` · ${p.cag}. çağ` : ''}`])) : null,
      a.live.map((x) => el('div', { class: 'box ai-live' },
        el('div', { class: 'row' },
          el('span', { class: 'pill gold', text: x.at }),
          el('span', { class: `pill ${x.risk === 'yüksek' ? 'res-loss' : ''}`, text: `Risk: ${x.risk}` }),
          x.combat ? el('span', { class: 'pill res-loss', text: 'Savaş' }) : null,
          x.trigger ? el('span', { class: 'pill', text: `Tetik: ${x.trigger}` }) : null,
        ),
        el('p', { class: 'ai-lead', text: x.durum }),
        x.komutlar?.length
          ? el('ol', {}, x.komutlar.map((k) => el('li', {}, el('span', { class: 'pill', text: KOMUT_TR[k.tur] || k.tur }), ' ', k.metin)))
          : el('ol', {}, x.simdiYap.map((t) => el('li', { text: t }))),
        x.hedefDagilim ? el('p', {}, el('b', { text: 'Hedef dağılım: ' }), x.hedefDagilim) : null,
        x.uret?.length ? el('p', {}, el('b', { text: 'Üret: ' }), x.uret.join(' · ')) : null,
        x.gelistir ? el('p', {}, el('b', { text: 'Geliştir: ' }), x.gelistir) : null,
        el('p', {}, el('b', { text: 'Tahmin: ' }), x.tahmin),
        el('p', {}, el('b', { text: 'Sonraki hedef: ' }), x.sonrakiHedef),
      )),
    ] : null,
  ];
}

function aiReportSection(a, m) {
  const r = a.aiReport;
  if (!r) {
    if (!state.ai?.available || !m?.matchId) return null;
    const btn = el('button', { class: 'btn primary', text: 'YZ koç raporu oluştur', onclick: async () => {
      btn.disabled = true;
      btn.textContent = 'Koç maçı inceliyor…';
      try {
        await api.aiReport(m.matchId);
        renderAnalysis();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Tekrar dene';
        alert(`Rapor oluşturulamadı: ${err.message}`);
      }
    } });
    return [el('h2', { text: 'Koç raporu' }), el('div', { class: 'box' }, btn)];
  }
  return [
    el('h2', { text: 'Koç raporu' }),
    el('div', { class: 'box ai-report' },
      el('p', { class: 'ai-lead', text: r.ozet }),
      el('h3', { text: 'Neden?' }), el('ul', {}, r.neden.map((t) => el('li', { text: t }))),
      el('h3', { text: 'Sonraki maç için 3 öncelik' }),
      el('ol', {}, r.oncelikler.map((o) => el('li', {}, el('b', { text: o.baslik }), ` — ${o.aciklama} `, el('span', { class: 'pill gold', text: o.olcut })))),
      el('h3', { text: 'Antrenman' }), el('ul', {}, r.antrenman.map((t) => el('li', { text: t }))),
      r.rakipNotlari.length ? [el('h3', { text: 'Rakip defteri' }), el('ul', {}, r.rakipNotlari.map((n) => el('li', {}, el('b', { text: `${n.oyuncu}: ` }), n.not)))] : null,
      el('h3', { text: 'Tahminler tuttu mu?' }), el('p', { text: r.tahminDegerlendirmesi }),
      el('h3', { text: 'Seni bekleyen fırsat' }), el('p', { text: r.gelecekMac }),
    ),
  ];
}

const PROVIDERS = {
  gemini: {
    label: 'Google Gemini (ücretsiz katman)',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'Google AI Studio › "Get API key" ile ücretsiz alınır.',
    cost: 'Ücretsiz katmanda günlük istek kotası var. Koç periyodik bakışa ek olarak önemli anlarda (kayıp, üssünde düşman, çağ atlama) hemen bakar, savaşta 30 saniyede bir bakar: 30 dakikalık maç kabaca 20-40 istek (maç başına en fazla 80). Yönet modunda 45 saniyede bir bakar: 30 dakikalık maç 50-70 istek (en fazla 150); kota çabuk dolabilir. Kota dolarsa YZ o gün susar, yerel uyarılar (mini harita, kayıp, ev, boşta köylü) çalışmaya devam eder. Ücretsiz katmanda Google verileri ürün geliştirmede kullanabilir.',
  },
  claude: {
    label: 'Anthropic Claude (ücretli, kredi ile)',
    keyUrl: 'https://platform.claude.com',
    keyHint: 'Claude Console › API Keys. Kullandıkça ödenen kredi gerekir; Claude.ai aboneliği API\'yi kapsamaz.',
    cost: 'Model: Claude Opus 5.5. Kabaca maç başına 0,5-1 dolar (30 dakikalık maç; periyodik + önemli anlarda ve savaşta sık bakış).',
  },
};

function aiSettingsSection() {
  const prov = settings.aiProvider === 'claude' ? 'claude' : 'gemini';
  const p = PROVIDERS[prov];
  const hasKey = Boolean(state.ai?.keys?.[prov]);
  const keyInput = el('input', { type: 'password', placeholder: hasKey ? 'Anahtar kayıtlı (değiştirmek için yenisini yaz)' : 'API anahtarı', autocomplete: 'off' });
  const msg = el('span', { class: 'muted' });
  // defaultOn: ayar hiç kaydedilmemişse açık mı sayılır (canlı koç varsayılan kapalı).
  const toggle = (key, label, defaultOn = true) => el('label', { class: 'check' },
    el('input', { type: 'checkbox', checked: defaultOn ? settings[key] !== false : settings[key] === true, onchange: async (e) => { settings = await api.updateSettings({ [key]: e.target.checked }); } }), label);
  return [
    el('h2', { text: 'Yapay Zekâ Koç' }),
    el('div', { class: 'box' },
      el('p', { class: 'muted', text: 'Koç; maç öncesi rakipleri ve geçmişini inceleyip oyun planı ve tahmin çıkarır, maç içinde ekranını görüp kısa notlar bırakır ("Rakip gelebilir · sol"), maç sonunda rapor yazar. Anahtar bu bilgisayarda Windows şifrelemesiyle saklanır; arkadaşların kendi anahtarlarını girer. Yapay zekâ olmadan da uygulamanın geri kalanı çalışır.' }),
      el('label', { class: 'field' }, 'Sağlayıcı',
        el('select', { onchange: async (e) => { settings = await api.updateSettings({ aiProvider: e.target.value }); renderSettings(); } },
          Object.entries(PROVIDERS).map(([k, v]) => el('option', { value: k, selected: k === prov, text: v.label })))),
      el('p', { class: 'muted' }, p.keyHint, ' ', el('a', { href: p.keyUrl, target: '_blank', text: p.keyUrl })),
      el('div', { class: 'row' }, keyInput,
        el('button', { class: 'btn', text: 'Kaydet', onclick: async () => {
          try { await api.setAiKey(prov, keyInput.value); keyInput.value = ''; msg.textContent = 'Kaydedildi.'; } catch (err) { msg.textContent = err.message; }
        } }),
        el('button', { class: 'btn', text: 'Bağlantıyı test et', onclick: async () => {
          msg.textContent = 'Test ediliyor…';
          try { msg.textContent = (await api.testAi()) ? 'Bağlantı çalışıyor.' : 'Beklenmeyen yanıt.'; } catch (err) { msg.textContent = `Hata: ${err.message}`; }
        } }),
        el('button', { class: 'btn', text: 'Anahtarı sil', onclick: async () => { await api.setAiKey(prov, ''); msg.textContent = 'Silindi.'; } }),
        msg,
      ),
      el('h3', { text: 'Canlı koç (deneysel)' }),
      el('p', { class: 'muted', text: 'Açıkken maç içinde YZ ekranına bakıp uyarı ve komut verir (yönet modu, mini harita, kayıp algılama, ulus seçme ekranı önerisi, maç öncesi YZ planı). Ücretsiz Gemini kotasıyla güvenilir çalışmadığı için kapalı; kapalıyken oyun içinde sadece build başlangıcı görünür. Sohbet, gelişim analizi, ulus önerisi tablosu ve maç sonu rapor bu ayardan bağımsız çalışır.' }),
      toggle('liveCoach', 'Canlı koçu aç (deneysel)', false),
      toggle('aiPrematch', 'Maç öncesi oyun planı ve rakip tahminleri (canlı koç açıkken)'),
      toggle('aiLive', 'Maç içi otomatik değerlendirme'),
      toggle('aiVision', 'Değerlendirmede ekran görüntüsünü gönder (koç ekranını görsün)'),
      toggle('aiReport', 'Maç sonu koç raporu'),
      toggle('aiResearch', 'Maç öncesi internetten harita ve güncel meta araştırması (Gemini + Google Arama; aynı harita/ülkeler için 3 gün saklanır)'),
      toggle('aiTranslate', 'Build notlarını Türkçeleştir'),
      el('label', { class: 'field' }, 'Sakin anlarda değerlendirme sıklığı (önemli anlarda ve savaşta koç bunu beklemez)',
        el('select', { onchange: async (e) => { settings = await api.updateSettings({ aiLiveIntervalMin: Number(e.target.value) }); } },
          [2, 3, 5].map((n) => el('option', { value: n, selected: (settings.aiLiveIntervalMin || 3) === n, text: `${n} dakikada bir` })))),
      el('p', { class: 'muted', text: p.cost }),
    ),
  ];
}

// ---------- Build Order ----------
let buildCiv = null;
let openBuildId = null;

async function renderBuilds() {
  const v = views.builds;
  if (!civList.length) civList = await api.listCivs();
  buildCiv ||= state.myCiv?.slug || lastPlayedCiv() || 'zhu_xis_legacy';
  const civ = civList.find((c) => c.slug === buildCiv) || civList[0];

  const select = el('select', { onchange: (e) => { buildCiv = e.target.value; openBuildId = null; renderBuilds(); } },
    civList.map((c) => el('option', { value: c.slug, selected: c.slug === civ.slug, text: c.tr })));
  const list = el('div', { class: 'builds' }, el('p', { class: 'muted', text: 'Yükleniyor…' }));
  fill(v, 
    el('h1', { text: 'Build Order' }),
    el('p', { class: 'lead', text: 'Ülkene göre bir başlangıç seç; maçta oyunun üstünde adım adım ne yapacağını ve hedef süresini gösterir, başlangıç bitince çekilir. Video izleyip akılda tutmaya gerek yok. Build\'ler aoe4guides.com topluluğundan, puana göre sıralı; varsayılan olarak sadece güncel sezonun build\'leri listelenir.' }),
    el('div', { class: 'row' }, select, el('button', { class: 'btn', text: 'Yenile', onclick: () => loadBuildList(civ, list, true) })),
    el('h2', { text: `${civ.tr} build'leri` }),
    list,
  );
  loadBuildList(civ, list, false);
}

let showOldSeasons = false;

// Build'in adından ve stratejisinden kısa Türkçe etiketler ("Hızlı Kale", "Erken baskı" …).
const BUILD_TAGS = [
  [/fast ?castle|\bfc\b/i, 'Hızlı Kale'],
  [/fast ?imp|\bfi\b/i, 'Hızlı İmparatorluk'],
  [/rush|aggr|aggro|pressure|all.?in|timing/i, 'Erken baskı'],
  [/boom|eco|greed/i, 'Ekonomi'],
  [/tower|kule/i, 'Kule'],
  [/defen|safe|savun/i, 'Savunmalı'],
  [/beginner|easy|simple/i, 'Kolay'],
  [/water|naval|dock/i, 'Su'],
  [/archer|longbow|crossbow|zhuge|ranged/i, 'Menzilli'],
  [/knight|horse|lancer|cav/i, 'Atlı'],
  [/spear|man.?at.?arms|maa|infantry/i, 'Piyade'],
];

function buildTags(b) {
  const text = `${b.name} ${b.strategy || ''}`;
  return [...new Set(BUILD_TAGS.filter(([re]) => re.test(text)).map(([, t]) => t))].slice(0, 3);
}

async function loadBuildList(civ, host, refresh) {
  let builds;
  try {
    builds = await api.listBuilds(civ.guide, refresh);
  } catch (err) {
    fill(host, el('p', { class: 'muted', text: `Build'ler alınamadı: ${err.message}` }));
    return;
  }
  const chosen = settings.buildByCiv[civ.slug] || builds[0]?.id;
  if (!builds.length) {
    fill(host, el('p', { class: 'muted', text: 'Bu ülke için build bulunamadı.' }));
    return;
  }
  const select = async (e, id) => {
    e.stopPropagation();
    settings.buildByCiv = await api.selectBuild(civ.slug, id);
    if (id !== 'auto' && id !== 'serbest') api.translateBuild(civ.guide, id).catch(() => {});
    loadBuildList(civ, host, false);
  };
  const special = (id, name, sub) => el('div', { class: 'build-item' },
    el('div', {}, el('div', { class: 'name', text: name }), el('div', { class: 'sub', text: sub })),
    chosen === id ? el('span', { class: 'chosen', text: '✓ Maçta kullanılacak' }) : el('button', { class: 'btn', text: 'Bunu kullan', onclick: (e) => select(e, id) }),
  );
  const live = Boolean(state?.liveCoach);
  const auto = special('auto', live ? 'Otomatik (hazırlardan rakibe göre)' : 'Otomatik (rakibe göre, kurallı)',
    live
      ? 'Yükleme ekranında koç her rakibin ülkesine, o ülkeyle tecrübesine, oyun tarzına (erken mi bitirir, uzun maçta mı güçlü) ve bize karşı geçmiş maçlarda ağırlıklı ne bastığına bakıp aşağıdaki hazır build\'lerden birini seçer. Seçimi ve nedenini Canlı Maç sayfasında görürsün.'
      : 'Yükleme ekranında rakiplerin geçmişine bakılır: erken baskıcı rakip varsa savunmalı, rakipler uzun maçta zayıfsa ekonomik açılış; yoksa en yüksek puanlı güncel build. YZ kullanılmaz.');
  // Serbest (YZ'nin özel build yazması) sadece canlı koç açıkken.
  const free = live ? special('serbest', 'Serbest (koç özel build yazar)',
    'Hazır build kullanılmaz: koç bu maçın rakiplerine göre tamamen özel bir açılış (adım adım köylü dağılımı, binalar, simge yapı, çağ atlama) ve maç boyu oyun stili yazar. Yükleme ekranında YZ gerekir; yazılamazsa otomatik seçime düşer.') : null;
  // Güncel sezon (listedeki en yeni ve bir önceki): eski sezonlar meta dışı kalmış olabilir.
  const seasonOf = (b) => Number(/(\d+)/.exec(String(b.season || ''))?.[1]) || null;
  const latest = Math.max(0, ...builds.map(seasonOf).filter(Boolean));
  const isCurrent = (b) => !latest || seasonOf(b) == null || seasonOf(b) >= latest - 1;
  const old = builds.filter((b) => !isCurrent(b));
  const shown = showOldSeasons ? builds : builds.filter((b) => isCurrent(b) || b.id === chosen);
  const toggleOld = old.length ? el('label', { class: 'check' },
    el('input', { type: 'checkbox', checked: showOldSeasons, onchange: (e) => { showOldSeasons = e.target.checked; loadBuildList(civ, host, false); } }),
    `Eski sezonların build'lerini de göster (${old.length})`) : null;
  fill(host, toggleOld, auto, free, ...shown.map((b) => {
    const item = el('div', { class: `build-item ${openBuildId === b.id ? 'open' : ''}`, onclick: () => { openBuildId = openBuildId === b.id ? null : b.id; loadBuildList(civ, host, false); } },
      el('div', {},
        el('div', { class: 'name' }, b.name, ' ',
          b.custom ? el('span', { class: 'pill gold', text: 'Sana özel' }) : null,
          b.season ? el('span', { class: `pill ${isCurrent(b) ? 'gold' : ''}`, text: isCurrent(b) ? b.season : `${b.season} · eski` }) : null,
          b.map ? el('span', { class: 'pill', text: b.map }) : null,
          buildTags(b).map((t) => el('span', { class: 'pill', text: t }))),
        el('div', { class: 'sub', text: [b.author, `${b.steps.length} adım`].filter(Boolean).join(' · ') }),
        b.custom ? (b.strategy ? el('div', { class: 'desc', text: b.strategy }) : null)
          : el('div', { class: 'desc', 'data-build': b.id, text: buildSummaryCache.get(b.id) || b.description || '' }),
      ),
      b.custom ? el('button', { class: 'btn', text: 'Sil', onclick: async (e) => { e.stopPropagation(); if (!confirm(`"${b.name}" silinsin mi?`)) return; await api.removeCustomBuild(b.id); loadBuildList(civ, host, false); } }) : null,
      b.id === chosen ? el('span', { class: 'chosen', text: '✓ Maçta kullanılacak' }) :
        el('button', { class: 'btn', text: 'Bunu kullan', onclick: (e) => select(e, b.id) }),
    );
    return openBuildId === b.id ? [item, buildPreview(b, civ.guide)] : item;
  }).flat());
  // Açıklamalar Türkçe kısa özetle değişir (YZ; önbellekli). Gelene kadar orijinali görünür.
  const need = shown.filter((b) => !b.custom && !buildSummaryCache.has(b.id)).map((b) => b.id);
  if (need.length) {
    api.buildSummaries(civ.guide, need).then((map) => {
      for (const [id, text] of Object.entries(map || {})) {
        buildSummaryCache.set(id, text);
        const node = [...host.querySelectorAll('.desc[data-build]')].find((n) => n.dataset.build === id);
        if (node) node.textContent = text;
      }
    }).catch(() => {});
  }
}

const buildSummaryCache = new Map();

function buildPreview(b, guide) {
  const box = buildPreviewBox(translatedBuilds.get(b.id) || b);
  if (!b.custom && !translatedBuilds.has(b.id) && guide) {
    api.translateBuild(guide, b.id).then((tr) => {
      if (!tr?.translated) return;
      translatedBuilds.set(b.id, tr);
      if (box.isConnected) box.replaceWith(buildPreviewBox(tr));
    }).catch(() => {});
  }
  return box;
}

const translatedBuilds = new Map();

function buildPreviewBox(b) {
  return el('div', { class: 'box' },
    el('table', { class: 'steps' },
      el('tr', {}, el('th', { text: 'Süre' }), el('th', { text: 'Köylü' }), el('th', { text: 'Dağılım' }), el('th', { text: 'Notlar' })),
      b.steps.map((s) => el('tr', {},
        el('td', { class: 'num', text: s.time != null ? clock(s.time) : '' }),
        el('td', { class: 'num', text: s.villagers ?? '' }),
        el('td', {}, resourceRow(s, { compact: true })),
        el('td', {}, s.notes.map(note)),
      )),
    ),
    el('p', { class: 'muted' }, 'Kaynak: ', el('a', { href: b.source, target: '_blank', text: b.source })),
  );
}

// Log kodu ("chinese_ha_01") ya da slug ile ülkeyi bulur.
function findCiv(code) {
  return civList.find((c) => c.slug === code || c.log.includes(code)) || null;
}

function lastPlayedCiv() {
  const m = matches[0];
  const me = m?.players.find((p) => p.profileId === state.localProfileId);
  return me ? findCiv(me.civCode)?.slug || null : null;
}

// ---------- Profilim & Takım ----------
function frequentAllies() {
  const counts = new Map();
  for (const m of matches) {
    for (const p of m.players) {
      if (p.team !== m.myTeam || !p.profileId || p.profileId === state.localProfileId) continue;
      const c = counts.get(p.profileId) || { profileId: p.profileId, name: p.name, n: 0 };
      c.n += 1;
      counts.set(p.profileId, c);
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 2);
}

// Kendi istatistiklerinden koçluk notları (rakip kartındaki notların "ayna" hali).
function selfTips(st) {
  const tips = [];
  const civs = Object.entries(st.byCiv).filter(([, c]) => c.games >= 5).sort((a, b) => b[1].winRate - a[1].winRate);
  const most = st.topCivs[0];
  if (civs.length >= 2) {
    const [bestSlug, best] = civs[0];
    const bestTr = st.topCivs.find((t) => t.slug === bestSlug)?.tr || bestSlug.replace(/_/g, ' ');
    if (most && most.slug !== bestSlug && best.winRate - most.winRate >= 10) {
      tips.push({ level: 'chance', text: `En çok ${most.tr} oynuyorsun (%${most.winRate}), ama en iyi sonucu ${bestTr} ile alıyorsun (%${best.winRate}).` });
    }
  }
  if (st.short.games >= 5 && st.short.winRate <= 35) {
    tips.push({ level: 'danger', text: `15 dakikadan kısa maçlarda kazanma oranın %${st.short.winRate}: erken baskıya karşı savunman zayıf. Feodal'de mızrakçı/kule zamanlamana dikkat.` });
  }
  if (st.long.games >= 5 && st.long.winRate <= 35) {
    tips.push({ level: 'danger', text: `30+ dakikalık maçlarda %${st.long.winRate}: geç oyunda ekonomi ve üst teknolojiler eksik kalıyor olabilir.` });
  }
  if (st.long.games >= 5 && st.long.winRate >= 55) {
    tips.push({ level: 'chance', text: `Uzun maçlarda iyisin (%${st.long.winRate}). Erken riskli saldırı yerine sağlam açılıp oyunu uzatmak sana yarar.` });
  }
  if (st.streak <= -3) tips.push({ level: 'info', text: `Son ${-st.streak} maçı kaybettin. Bir mola ya da tek bir build'e odaklanmak iyi gelebilir.` });
  return tips;
}

function statBlock(st) {
  const stat = (k, v) => el('div', { class: 'stat' }, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }));
  return el('div', { class: 'stats' },
    stat('Son maçlar', `${st.games}`),
    stat('Kazanma', `%${st.winRate ?? '–'}`),
    stat('Kısa maç (<15 dk)', st.short.games ? `%${st.short.winRate} (${st.short.games} maç)` : '–'),
    stat('Uzun maç (30+ dk)', st.long.games ? `%${st.long.winRate} (${st.long.games} maç)` : '–'),
    stat('Ort. galibiyet', st.avgWinMin != null ? `${st.avgWinMin} dk` : '–'),
    stat('Ort. mağlubiyet', st.avgLossMin != null ? `${st.avgLossMin} dk` : '–'),
  );
}

async function profileSection(profileId, name, title) {
  const box = el('div', { class: 'box' }, el('p', { class: 'muted', text: `${name || profileId} yükleniyor…` }));
  api.scoutPlayer(profileId, name).then((c) => {
    if (c.error || !c.stats) {
      fill(box, el('p', { class: 'muted', text: `Profil alınamadı: ${c.error || 'veri yok'}` }));
      return;
    }
    const tips = selfTips(c.stats);
    fill(box, 
      playerCard({ ...c, insights: [] }, { ally: true }),
      statBlock(c.stats),
      tips.length ? insightList(tips) : el('p', { class: 'muted', text: 'Belirgin bir zayıflık görünmüyor.' }),
    );
  });
  return [el('h2', { text: title }), box];
}

async function renderTeam() {
  const v = views.team;
  if (!state.localProfileId) {
    fill(v, el('h1', { text: 'Profilim' }), el('p', { class: 'lead', text: 'Profilin henüz bulunamadı. AoE4\'ü bir kez aç ya da Ayarlar\'dan profil ID\'ni gir.' }));
    return;
  }
  const allies = frequentAllies();
  fill(v, 
    el('div', { class: 'match-head' },
      el('h1', { text: 'Profilim' }),
      el('button', { class: 'btn', text: 'Başka oyuncu ara', onclick: () => show('search') }),
    ),
    el('p', { class: 'lead', text: 'Son 50 maçtan çıkarılan oyun tarzı. Koç, oynadıkça bu veriye göre öneri verir.' }),
    ...(await reviewSection()),
    ...(await profileSection(state.localProfileId, null, 'Sen')),
    ...trendSection(),
    ...(await Promise.all(allies.map((a) => profileSection(a.profileId, a.name, `${a.name} · ${a.n} maç birlikte`)))).flat(),
    allies.length ? null : el('p', { class: 'muted', text: 'Takım arkadaşların, birlikte oynadığınız maçlar kaydedildikçe burada görünecek.' }),
  );
}

// Analiz edilen maçlardan gelişim tablosu: koç oynadıkça bu veriyle öğrenir.
function trendSection() {
  const rows = matches.filter((m) => m.analysisSummary).slice(0, 10);
  if (!rows.length) return [];
  const avgOf = (k) => {
    const v = rows.map((m) => m.analysisSummary[k]).filter((x) => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const cells = (s) => [clock(s.feudalAt), clock(s.tcIdleFirst10), s.villagersAt10, clock(s.firstMilitaryAt), s.apm];
  return [
    el('h2', { text: `Gelişimin · son ${rows.length} analiz edilen maç` }),
    el('div', { class: 'box cmp-wrap' }, el('table', { class: 'cmp' },
      el('tr', {}, ['Maç', 'Sonuç', 'Feodal', 'Merkez boşta (ilk 10 dk)', 'Köylü 10. dk', 'İlk asker', 'APM'].map((h) => el('th', { text: h }))),
      rows.map((m) => el('tr', {},
        el('td', {}, el('button', { class: 'btn', text: matchLabel(m) || `#${m.matchId}`, onclick: () => openAnalysis(m.matchId) })),
        el('td', {}, m.result === 'win' ? el('span', { class: 'res-win', text: 'G' }) : m.result === 'loss' ? el('span', { class: 'res-loss', text: 'M' }) : '–'),
        cells(m.analysisSummary).map((c) => el('td', { text: c ?? '–' })),
      )),
      el('tr', { class: 'me' }, el('td', {}, el('b', { text: 'Ortalama' })), el('td', { text: '' }),
        [clock(avgOf('feudalAt')), clock(avgOf('tcIdleFirst10')), Math.round(avgOf('villagersAt10') ?? 0), clock(avgOf('firstMilitaryAt')), Math.round(avgOf('apm') ?? 0)].map((c) => el('td', {}, el('b', { text: c })))),
    )),
  ];
}

// ---------- Oyuncu Ara ----------
function renderSearch() {
  const v = views.search;
  if (v.dataset.ready) return;
  v.dataset.ready = '1';
  const input = el('input', { type: 'text', placeholder: 'Oyuncu adı (en az 3 harf)' });
  const results = el('div', { class: 'results' });
  const detail = el('div');
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 3) return;
    fill(results, el('p', { class: 'muted', text: 'Aranıyor…' }));
    try {
      const list = await api.searchPlayers(q);
      fill(results, ...(list.length ? list.slice(0, 12).map((p) =>
        el('button', { onclick: () => scoutInto(detail, p) }, el('span', { text: p.name }), el('span', { class: 'muted', text: p.rating ? `${p.rating}` : '' })),
      ) : [el('p', { class: 'muted', text: 'Sonuç yok.' })]));
    } catch (err) {
      fill(results, el('p', { class: 'muted', text: `Arama başarısız: ${err.message}` }));
    }
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && run());
  fill(v, 
    el('h1', { text: 'Oyuncu Ara' }),
    el('p', { class: 'lead', text: 'Herhangi bir oyuncunun halka açık maç geçmişinden oyun tarzını çıkar.' }),
    el('div', { class: 'row' }, input, el('button', { class: 'btn primary', text: 'Ara', onclick: run })),
    results,
    detail,
  );
}

async function scoutInto(host, p) {
  fill(host, el('p', { class: 'muted', text: `${p.name} analiz ediliyor…` }));
  const c = await api.scoutPlayer(p.profileId, p.name);
  fill(host, playerCard(c), c.stats ? statBlock(c.stats) : null);
}

// ---------- Geçmiş ----------
function renderHistory() {
  const v = views.history;
  const civName = (code) => findCiv(code)?.tr || code;
  fill(v, 
    el('h1', { text: 'Geçmiş' }),
    el('p', { class: 'lead', text: "Age of Koçu'nun gördüğü maçlar. Koçun öğrenmesi bu kayıtlardan beslenir." }),
    matches.length ? el('table', { class: 'hist' },
      el('tr', {}, ['Tarih', 'Harita', 'Sonuç', 'Süre', 'Takımın', 'Rakipler', ''].map((h) => el('th', { text: h }))),
      matches.map((m) => {
        const mine = m.players.filter((p) => p.team === m.myTeam);
        const theirs = m.players.filter((p) => p.team !== m.myTeam);
        const who = (ps) => ps.map((p) => `${p.name} (${civName(p.civCode)})`).join(', ');
        return el('tr', {},
          el('td', { text: m.playedAt ? new Date(m.playedAt).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' }) : '–' }),
          el('td', { text: m.map || '–' }),
          el('td', {}, m.result === 'win' ? el('span', { class: 'res-win', text: 'Galibiyet' }) : m.result === 'loss' ? el('span', { class: 'res-loss', text: 'Mağlubiyet' }) : '–'),
          el('td', { text: clock(m.durationSec) }),
          el('td', { text: who(mine) }),
          el('td', { text: who(theirs) }),
          el('td', {}, m.hasAnalysis ? el('button', { class: 'btn', text: 'Analiz', onclick: () => openAnalysis(m.matchId) }) : null),
        );
      }),
    ) : el('p', { class: 'muted', text: 'Henüz kayıtlı maç yok. Uygulama açıkken bir maç oyna.' }),
  );
}

// ---------- Ayarlar ----------
// Sorun olunca bakılacak yer: veri klasörü, son kayıt, YZ durumu ve günlük dosyası.
function diagnosticsSection() {
  const host = el('div', { class: 'box' }, el('p', { class: 'muted', text: 'Yükleniyor…' }));
  api.getDiagnostics().then((d) => {
    const ago = (t) => (t ? `${Math.round((Date.now() - t) / 60000)} dk önce` : 'hiç');
    fill(host,
      el('p', { class: 'muted', text: 'Koç susarsa ya da bir ayar kaydedilmiyorsa günlük dosyasını Altan\'a gönder.' }),
      el('ul', {},
        el('li', {}, el('b', { text: 'Sürüm: ' }), d.version),
        el('li', {}, el('b', { text: 'Veri klasörü: ' }), d.userData),
        el('li', {}, el('b', { text: 'Gemini anahtarı: ' }), d.keys.gemini ? 'kayıtlı' : 'yok', ' · ', el('b', { text: 'Kalibrasyon: ' }), d.calibrated ? 'kayıtlı' : 'yok'),
        el('li', {}, el('b', { text: 'Son kayıt: ' }), d.lastWrite ? `${d.lastWrite.file} · ${ago(d.lastWrite.at)} · ${d.lastWrite.ok ? 'başarılı' : `HATA: ${d.lastWrite.error}`}` : 'bu oturumda yok'),
        el('li', {}, el('b', { text: 'Son YZ değerlendirmesi: ' }), ago(d.lastLiveOkAt), d.lastLiveError ? ` · son hata: ${d.lastLiveError}` : ''),
      ),
      el('button', { class: 'btn', text: 'Günlük klasörünü aç', onclick: () => api.openLogs() }),
    );
  }).catch((err) => fill(host, el('p', { class: 'res-loss', text: err.message })));
  return [el('h2', { text: 'Tanılama' }), host];
}

function renderSettings() {
  const v = views.settings;
  const idInput = el('input', { type: 'number', value: settings.profileId || '', placeholder: state.localProfileId ? `Otomatik: ${state.localProfileId}` : 'Otomatik bulunacak' });
  fill(v, 
    el('h1', { text: 'Ayarlar' }),
    el('div', { class: 'box' },
      el('label', { class: 'field' }, 'AoE4World profil ID (boş bırakırsan oyundan otomatik bulunur)', el('div', { class: 'row' }, idInput,
        el('button', { class: 'btn', text: 'Kaydet', onclick: async () => { settings = await api.updateSettings({ profileId: idInput.value }); } }))),
      el('label', { class: 'check' },
        el('input', { type: 'checkbox', checked: state.overlayEnabled, onchange: (e) => api.updateSettings({ overlayEnabled: e.target.checked }) }),
        'Oyun üstü overlay açık'),
      el('label', { class: 'check' },
        el('input', { type: 'checkbox', checked: settings.startWithWindows === true, onchange: async (e) => { settings = await api.updateSettings({ startWithWindows: e.target.checked }); } }),
        'Windows açılınca arka planda başlat (önerilir: oyun sadece son maçın kaydını tuttuğu için uygulama kapalıyken oynanan maçlar analiz edilemez)'),
      el('label', { class: 'field' }, 'Overlay görünümü',
        el('select', { onchange: async (e) => { settings = await api.updateSettings({ overlayMode: e.target.value }); } },
          el('option', { value: 'simple', selected: settings.overlayMode !== 'detailed', text: 'Sade: sol üstte sadece eksikler ve uyarılar' }),
          el('option', { value: 'detailed', selected: settings.overlayMode === 'detailed', text: 'Detaylı: build paneli, rakip kartları, koç paneli' }))),
      el('label', { class: 'field' }, 'Detaylı overlay konumu',
        el('select', { onchange: async (e) => { settings = await api.updateSettings({ overlaySide: e.target.value }); } },
          el('option', { value: 'right', selected: settings.overlaySide === 'right', text: 'Sağ' }),
          el('option', { value: 'left', selected: settings.overlaySide === 'left', text: 'Sol' }))),
    ),
    el('h2', { text: 'Ekran okuma' }),
    el('div', { class: 'box' },
      el('p', { class: 'muted', text: settings.hudRegions ? 'Kalibrasyon yapıldı. Koç maç sırasında kaynakları, köylüleri ve nüfusu okuyor.' : 'Henüz kalibrasyon yapılmadı: bir maçta Ctrl+Alt+K ile ekran görüntüsü al, sonra kutuları ayarla.' }),
      el('button', { class: 'btn', text: 'Ekran okuma kalibrasyonu', onclick: () => show('screen') }),
    ),
    teamSettingsSection(),
    aiSettingsSection(),
    diagnosticsSection(),
    el('h2', { text: 'Kısayollar (oyun içinde çalışır)' }),
    el('div', { class: 'box' }, el('ul', {},
      el('li', {}, el('kbd', { text: 'Ctrl+Alt+→' }), ' / ', el('kbd', { text: 'Ctrl+Alt+←' }), ' — build adımı ileri / geri (öndeysen ya da geride kaldıysan)'),
      el('li', {}, el('kbd', { text: 'Ctrl+Alt+↑' }), ' / ', el('kbd', { text: 'Ctrl+Alt+↓' }), ' — koç saatini 10 sn ileri / geri al (oyun duraklatıldıysa)'),
      el('li', {}, el('kbd', { text: 'Ctrl+Alt+R' }), ' — rakip kartlarını göster / gizle'),
      el('li', {}, el('kbd', { text: 'Ctrl+Alt+O' }), ' — overlay\'i aç / kapat'),
      el('li', {}, el('kbd', { text: 'Ctrl+Alt+K' }), ' — ekran okuma kalibrasyonu için ekran görüntüsü al'),
      el('li', {}, el('kbd', { text: 'Ctrl+Alt+A' }), ' — koça sor: YZ ekranına bakıp hemen değerlendirsin'),
      el('li', {}, el('kbd', { text: 'Ctrl+Alt+Y' }), ' — takıma yardım çağrısı gönder'),
    )),
    el('h2', { text: 'Oyun log dosyası' }),
    el('div', { class: 'box' }, el('p', { class: state.logFound ? '' : 'muted', text: state.logPath || '–' }),
      state.logFound ? null : el('p', { class: 'muted', text: 'Dosya yoksa AoE4\'ü bir kez açıp kapat.' })),
    el('h2', { text: 'Adil oyun' }),
    el('div', { class: 'box' }, el('p', { class: 'muted', text: 'Age of Koçu oyun belleğini okumaz ve maç sırasında rakip hakkında gizli bilgi kullanmaz. Rakip analizi yalnızca AoE4World\'deki halka açık maç geçmişinden yapılır.' })),
  );
}

// ---------- Takımımız ----------
let squadBusy = null; // 'veri' | 'oneri'

async function renderSquad() {
  const v = views.squad;
  const { squad, advice } = await api.getSquad();
  const refresh = async (withAdvice) => {
    squadBusy = withAdvice ? 'oneri' : 'veri';
    renderSquad();
    try {
      await api.refreshSquad(withAdvice);
    } catch (err) {
      alert(`Güncellenemedi: ${err.message.replace(/^.*Error: /, '')}`);
    } finally {
      squadBusy = null;
      if (current === 'squad') renderSquad();
    }
  };
  const ago = (t) => (t ? new Date(t).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' }) : '–');
  fill(v,
    el('div', { class: 'match-head' },
      el('h1', { text: 'Takımımız' }),
      el('div', { class: 'row' },
        el('button', { class: 'btn', text: squadBusy === 'veri' ? 'Geçmiş çekiliyor…' : 'Verileri yenile', disabled: Boolean(squadBusy), onclick: () => refresh(false) }),
        el('button', { class: 'btn primary', text: squadBusy === 'oneri' ? 'Koç öneri hazırlıyor…' : 'Ulus önerilerini yenile', disabled: Boolean(squadBusy) || !state.ai?.available, onclick: () => refresh(true) }),
      ),
    ),
    el('p', { class: 'lead', text: 'Ekibinizin birlikte oynadığı maçlardan (AoE4World geçmişi) ikili ve üçlü dinamikleriniz; maç kayıtlarından her birinizin tarzı ve hataları; bunlara, haritaya ve seviyenizin güncel metasına göre ulus önerileri.' }),
    el('label', { class: 'check' },
      el('input', { type: 'checkbox', checked: settings.civAdvice !== false, onchange: async (e) => { settings = await api.updateSettings({ civAdvice: e.target.checked }); } }),
      'Ulus seçme ekranında öneriyi oyunun üstünde göster (harita ekrandan okunur)'),
    !squad ? el('div', { class: 'box' }, el('p', { class: 'muted', text: squadBusy ? 'Geçmiş çekiliyor…' : 'Takım verisi henüz yok. "Verileri yenile"ye bas (birkaç saniye sürer).' })) : [
      el('p', { class: 'muted', text: `Ekip: ${squad.members.map((m) => m.name).join(', ')} · ${squad.report.toplamTakimMaci} takım maçı · seviye: ${squad.rankLevel}${squad.rating ? ` (${squad.rating})` : ''} · güncelleme ${ago(squad.at)}` }),
      advice?.advice?.takimKimligi ? el('div', { class: 'box' }, el('p', { class: 'ai-lead', text: advice.advice.takimKimligi })) : null,
      el('h2', { text: 'Birlikte' }),
      el('div', { class: 'grid' }, [squad.report.uclu, ...squad.report.ikililer].filter(Boolean).map(comboCard)),
      el('h2', { text: 'Tarzınız ve hatalarınız' }),
      el('div', { class: 'grid' }, squad.habits.map(habitCard)),
    ],
    el('h2', { text: 'Haritaya göre ulus önerisi' }),
    advice ? civAdviceTable(advice) : el('div', { class: 'box' }, el('p', { class: 'muted', text: state.ai?.available ? 'Henüz öneri yok. "Ulus önerilerini yenile"ye bas (havuzdaki her harita için bir kez hesaplanır, 3 gün saklanır).' : 'Ulus önerisi için Ayarlar › Yapay Zekâ Koç bölümünden anahtar gir.' })),
  );
}

function comboCard(c) {
  const map = (x) => `${x.ad} %${x.kazanma} (${x.mac})`;
  return el('div', { class: 'box' },
    el('h3', { text: c.oyuncular.join(' + ') }),
    el('p', {}, el('b', { text: `${c.mac} maç · %${c.kazanma} kazanma` }), c.sonOn ? el('span', { class: 'muted', text: ` · son 10: ${c.sonOn}` }) : null),
    el('p', { class: 'muted', text: `Kazanılan maç ortalama ${c.ortalamaKazanilanDk ?? '–'} dk, kaybedilen ${c.ortalamaKaybedilenDk ?? '–'} dk` }),
    c.sureyeGore.length ? el('p', {}, el('b', { text: 'Süreye göre: ' }), c.sureyeGore.map((s) => `${s.aralik} %${s.kazanma} (${s.mac})`).join(' · ')) : null,
    c.enIyiHaritalar.length ? el('p', {}, el('b', { text: 'En iyi haritalar: ' }), c.enIyiHaritalar.map(map).join(' · ')) : null,
    c.enKotuHaritalar.length ? el('p', {}, el('b', { text: 'Zorlandığınız: ' }), c.enKotuHaritalar.map(map).join(' · ')) : null,
    c.ulusKombinasyonlari.length ? [el('p', {}, el('b', { text: 'Ülke kombinasyonları:' })), el('ul', {}, c.ulusKombinasyonlari.map((u) => el('li', { text: `${u.ad} · ${u.mac} maç %${u.kazanma}` })))] : null,
  );
}

function habitCard(h) {
  return el('div', { class: 'box' },
    el('h3', { text: h.oyuncu }),
    h.azVeri ? el('p', { class: 'muted', text: `${h.mac} analizli maç: ${h.mac < 3 ? 'alışkanlık çıkarmak için az (en az 3 gerekir)' : 'az veri, yorumlar kesin değil'}.` }) : null,
    h.aliskanliklar.length ? el('ul', {}, h.aliskanliklar.map((a) => el('li', {},
      el('span', { class: `pill ${a.karar.startsWith('hata') ? 'res-loss' : 'gold'}`, text: a.karar.startsWith('hata') ? 'hata' : 'tarz' }), ' ', a.aliskanlik,
      el('div', { class: 'muted', text: `${a.siklik} maçta${a.galibiyetlerde ? ` · galibiyetlerde ${a.galibiyetlerde}, mağlubiyetlerde ${a.maglubiyetlerde}` : ''}` })))) : null,
    h.enCokBastigiBirimler?.length ? el('p', { class: 'muted', text: `En çok bastığı: ${h.enCokBastigiBirimler.join(', ')}` }) : null,
  );
}

function civAdviceTable(advice) {
  const members = advice.members.map((m) => m.name);
  return el('div', { class: 'box cmp-wrap' },
    el('p', { class: 'muted', text: `${advice.kind === 'rm_3v3' ? '3v3' : '2v2'} · takım seviyesi ${advice.rankLevel} · ${new Date(advice.at).toLocaleDateString('tr-TR')}${advice.shared ? ` · ekipçe ortak (${advice.by || 'ekipten biri'} hesapladı; üçünüz de aynı tabloyu görürsünüz)` : ' · sadece bu bilgisayarda (takım sunucusuna ulaşılamadı)'} · ulus seçme ekranında harita okununca bu satır oyunun üstünde görünür.` }),
    el('table', { class: 'cmp' },
      el('tr', {}, el('th', { text: 'Harita' }), members.map((n) => el('th', { text: n })), el('th', { text: 'Plan' })),
      advice.advice.haritalar.map((h) => el('tr', {},
        el('td', {}, el('b', { text: h.harita })),
        members.map((n) => {
          const o = h.oneriler.find((x) => x.oyuncu === n);
          return el('td', { class: 'wrap', title: o?.neden || '' }, o ? [el('b', { text: o.ulus }), el('div', { class: 'muted', text: o.rol })] : '–');
        }),
        el('td', { class: 'wrap', text: h.plan }),
      )),
    ),
  );
}

// ---------- Koça Sor (sohbet) ----------
let chatBusy = false;
let chatDraft = '';

const CHAT_EXAMPLES = [
  'Son maçta neden kaybettik?',
  'Fransızlara karşı Zhu Xi ile ne açmalıyım?',
  'Bu haritada nasıl oynamalıyız?',
  'Güncel yamada en güçlü takım ülkeleri hangileri?',
];

async function renderChat() {
  const v = views.chat;
  const log = await api.getChat();
  const list = el('div', { class: 'chat-log' },
    log.length ? log.map((m, i) => chatBubble(m, i, i === log.length - 1)) : el('div', { class: 'box' },
      el('p', { class: 'muted', text: 'Koça maçların, rakiplerin, haritalar ya da güncel meta hakkında soru sor. Koç maç geçmişini, analizlerini ve (maçtaysan) şu anki maçı bilir; gerekirse internette arar.' }),
      el('div', { class: 'row' }, CHAT_EXAMPLES.map((q) => el('button', { class: 'btn', text: q, onclick: () => sendChat(q) }))),
    ),
    chatBusy ? el('div', { class: 'chat-msg coach muted', text: 'Koç yazıyor…' }) : null,
  );
  const input = el('textarea', { class: 'chat-input', rows: 2, placeholder: state.ai?.available ? 'Koça sor… (Enter gönderir, Shift+Enter yeni satır)' : 'Önce Ayarlar › Yapay Zekâ Koç bölümünden anahtar gir', disabled: chatBusy || !state.ai?.available });
  input.value = chatDraft;
  input.addEventListener('input', () => { chatDraft = input.value; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat(input.value);
    }
  });
  const msg = el('p', { class: 'res-loss', id: 'chat-err' });
  fill(v,
    el('div', { class: 'match-head' },
      el('h1', { text: 'Koça Sor' }),
      log.length ? el('button', { class: 'btn', text: 'Sohbeti temizle', onclick: async () => { await api.clearChat(); renderChat(); } }) : null,
    ),
    chatPrefsBox(),
    list,
    el('div', { class: 'chat-compose' }, input, el('button', { class: 'btn primary', text: 'Gönder', disabled: chatBusy, onclick: () => sendChat(input.value) })),
    msg,
  );
  list.scrollTop = list.scrollHeight;
  if (!chatBusy) input.focus();
}

// Koçun hatırladığı kalıcı tercihler; sohbette söyleyince eklenir, buradan silinir.
function chatPrefsBox() {
  const prefs = settings.chatPrefs || [];
  if (!prefs.length) return null;
  return el('div', { class: 'chat-prefs' },
    el('span', { class: 'muted', text: 'Koçun hatırladığı tercihlerin: ' }),
    prefs.map((p) => el('span', { class: 'pill' }, p, ' ',
      el('button', { class: 'pill-x', title: 'Unut', text: '×', onclick: async () => { settings = await api.updateSettings({ chatPrefs: prefs.filter((x) => x !== p) }); renderChat(); } }))),
  );
}

function chatBubble(m, index, last = false) {
  return el('div', { class: `chat-msg ${m.role === 'assistant' ? 'coach' : 'me'}` },
    m.role === 'assistant' ? markdown(m.text) : el('div', { class: 'chat-text', text: m.text }),
    m.action ? chatActionCard(m.action, index) : null,
    m.savedPref ? el('div', { class: 'chat-pref muted', text: `📌 Tercihin kaydedildi: ${m.savedPref}` }) : null,
    m.suggestions?.length && last ? el('div', { class: 'chat-suggest' }, m.suggestions.map((q) => el('button', { class: 'btn small', text: q, disabled: chatBusy, onclick: () => sendChat(q) }))) : null,
    m.sources?.length ? el('div', { class: 'chat-src' }, 'Kaynaklar: ', m.sources.map((s, i) => [i ? ' · ' : '', el('a', { href: s.url, target: '_blank', text: s.title })])) : null,
  );
}

// Koçun önerdiği eylem: hazır build seçimi ya da sana özel başlangıç; düğmeyle onaylanır.
function chatActionCard(a, index) {
  const apply = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Ekleniyor…';
    try {
      await api.applyChatAction(index);
      settings = await api.getSettings();
      renderChat();
    } catch (err) {
      e.target.disabled = false;
      e.target.textContent = `Olmadı: ${err.message.replace(/^.*Error: /, '')}`;
    }
  };
  const custom = a.type === 'ozel_build';
  return el('div', { class: 'chat-action' },
    el('div', {}, el('b', { text: custom ? 'Sana özel başlangıç: ' : 'Önerilen başlangıç: ' }), `${a.buildName} (${a.civTr})`),
    a.reason ? el('div', { class: 'muted', text: a.reason }) : null,
    custom && a.build ? el('details', {}, el('summary', { text: `${a.build.steps.length} adımı göster` }),
      el('ol', {}, a.build.steps.map((st) => el('li', {}, `${st.time != null ? `${clock(st.time)} · ` : ''}${st.villagers ?? ''} köylü: `, st.notes.join(' '))))) : null,
    a.applied
      ? el('div', { class: 'res-win', text: custom ? "✓ Build Order'a eklendi ve seçildi; maçta oyunun üstünde görünecek" : '✓ Seçildi; maçta oyunun üstünde görünecek' })
      : el('button', { class: 'btn primary', text: custom ? "Build Order'a ekle ve kullan" : 'Bunu kullan', onclick: apply }),
  );
}

async function sendChat(text) {
  const t = String(text || '').trim();
  if (!t || chatBusy) return;
  chatBusy = true;
  chatDraft = t;
  await renderChat();
  try {
    await api.sendChat(t);
    chatDraft = '';
  } catch (err) {
    chatBusy = false;
    await renderChat();
    const e = document.getElementById('chat-err');
    if (e) e.textContent = `Gönderilemedi: ${err.message.replace(/^.*Error: /, '')}`;
    return;
  }
  chatBusy = false;
  if (current === 'chat') renderChat();
}

// ---------- Gelişim analizi (Profilim) ----------
let reviewBusy = false;

async function reviewSection() {
  const saved = await api.getReview();
  const r = saved?.review;
  const btn = el('button', { class: 'btn primary', text: reviewBusy ? 'Koç maçlarını inceliyor…' : r ? 'Yeniden analiz et' : 'Maçlarımı analiz et: hatalarım ve ulus önerisi', disabled: reviewBusy || !state.ai?.available, onclick: async () => {
    reviewBusy = true;
    renderTeam();
    try {
      await api.runReview();
    } catch (err) {
      alert(`Analiz yapılamadı: ${err.message.replace(/^.*Error: /, '')}`);
    } finally {
      reviewBusy = false;
      if (current === 'team') renderTeam();
    }
  } });
  const head = [el('h2', { text: 'Koçun gelişim analizi' }), el('div', { class: 'row' }, btn,
    saved ? el('span', { class: 'muted', text: `${new Date(saved.at).toLocaleDateString('tr-TR')} · ${saved.basedOn.analyzed} analizli maç, ${saved.basedOn.matches} maç${saved.basedOn.mates?.length ? ` · takım: ${saved.basedOn.mates.join(', ')}` : ''}` }) : null,
    !state.ai?.available ? el('span', { class: 'muted', text: 'Yapay zekâ anahtarı gerekli (Ayarlar).' }) : null)];
  if (!r) return [...head, el('p', { class: 'muted', text: 'Koç kaydedilen maçlarına (kayıt analizleri) ve AoE4World geçmişine bakıp tekrarlayan hatalarını, oyun tarzını, sana uyan ülkeleri ve takım kompozisyonunu çıkarır. Maç biriktikçe daha isabetli olur.' })];
  return [...head, el('div', { class: 'box ai-report' },
    el('p', { class: 'ai-lead', text: r.ozet }),
    el('p', {}, el('b', { text: 'Oyun tarzın: ' }), r.oyunTarzi),
    el('h3', { text: 'Güçlü yönlerin' }), el('ul', {}, r.gucluYonler.map((t) => el('li', { text: t }))),
    el('h3', { text: 'Tekrarlayan hataların' }),
    el('ol', {}, r.tekrarlayanHatalar.map((h) => el('li', {}, el('b', { text: h.hata }), el('div', { class: 'muted', text: h.kanit }), el('div', {}, '→ ', h.cozum)))),
    el('h3', { text: 'Sana uyan ülkeler' }),
    el('ul', {}, r.ulusOnerileri.map((u) => el('li', {}, el('b', { text: `${u.ulus}: ` }), u.neden, el('div', { class: 'muted', text: u.nasilOyna })))),
    el('h3', { text: 'Takım kompozisyonu' }), el('p', { text: r.takimKompozisyonu }),
    el('h3', { text: 'Çalışma planı' }), el('ul', {}, r.calismaPlani.map((t) => el('li', { text: t }))),
  )];
}

const RENDER = { live: renderLive, analysis: renderAnalysis, builds: renderBuilds, squad: renderSquad, team: renderTeam, chat: renderChat, search: renderSearch, history: renderHistory, screen: () => renderCalibration(views.screen), settings: renderSettings };

// ---------- Olaylar ----------
api.on('state', (s) => {
  const analysisChanged = JSON.stringify(state?.analysis) !== JSON.stringify(s.analysis);
  const liveChanged = state?.liveCoach !== s.liveCoach;
  state = s;
  renderStatus();
  if (liveChanged) renderModeSwitch();
  if (current === 'live') renderLive();
  if (current === 'analysis' && analysisChanged) renderAnalysis();
});
api.on('coach', renderLiveCoach);
api.on('matches', (m) => {
  matches = m;
  if (current === 'history') renderHistory();
  if (current === 'live') renderLive();
});
api.on('settings', (s) => { settings = s; renderModeSwitch(); });
api.on('team', (t) => {
  const host = document.getElementById('live-team');
  if (host && current === 'live') fill(host, teamBox(t));
});
api.on('calibration', (img) => { if (current === 'screen') onCalibrationImage(img); });

(async () => {
  [state, settings, matches, civList] = await Promise.all([api.getState(), api.getSettings(), api.listMatches(), api.listCivs()]);
  renderStatus();
  renderModeSwitch();
  show('live');
})();

// Sağ üstteki koç modu anahtarı: Normal (uyarı/öneri) · Yönet (koç sıralı komut verir).
function renderModeSwitch() {
  // Normal/Yönet sadece canlı koç açıkken anlamlı.
  if (!state?.liveCoach) {
    fill(document.getElementById('mode-switch'));
    return;
  }
  const mode = settings?.coachMode === 'yonet' ? 'yonet' : 'normal';
  const btn = (key, label, title) => el('button', {
    class: `${mode === key ? 'on' : ''} ${key}`,
    title,
    text: label,
    onclick: async () => { if (mode !== key) settings = await api.updateSettings({ coachMode: key }); },
  });
  fill(document.getElementById('mode-switch'),
    el('span', { text: 'Koç modu (Ctrl+Alt+N)' }),
    el('div', { class: 'seg' },
      btn('normal', 'Normal', 'Koç uyarır ve önerir; kararı sen verirsin.'),
      btn('yonet', 'Yönet', 'Koç seni yönetir: 45 saniyede bir sıralı komut (inşaat, üretim, araştırma, çağ atlama, baskın). Daha çok YZ isteği harcar.'),
    ),
  );
}
