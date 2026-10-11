import { el, fill, clock, note, resourceRow, stepSentence, playerCard } from '../shared/ui.js';

const $column = document.getElementById('column');
const $coach = document.getElementById('coach');
const $alerts = document.getElementById('alerts');
const $cards = document.getElementById('cards');
const $hud = document.getElementById('hud');
const $ai = document.getElementById('ai');
const $notes = document.getElementById('notes');
let mode = 'simple';
let noteList = [];

const ALERT_MS = 15000;
let state = null;
let coachKey = null;
let refs = null;

function applySide(side) {
  $column.className = `column ${side === 'left' ? 'left' : 'right'}`;
}

// Sade mod: sol üstte sadece "ne eksik / ne risk" notları; diğer paneller gizli.
function applyMode(m) {
  mode = m === 'detailed' ? 'detailed' : 'simple';
  $column.hidden = mode === 'simple';
  renderNotes();
}

function renderNotes() {
  const show = mode === 'simple' && state && (state.phase === 'loading' || state.phase === 'playing') && noteList.length;
  $notes.hidden = !show;
  if (!show) return;
  fill($notes, noteList.map((n) => el('div', { class: `note-pill lvl-${n.level}`, text: n.text })));
}

// ---- Rakip kartları ----
function renderCards() {
  const show = state && (state.phase === 'loading' || state.phase === 'playing') && state.cardsVisible;
  $cards.hidden = !show;
  if (!show) return;
  fill($cards, );
  const s = state.scouting;
  if (!s) {
    $cards.append(el('div', { class: 'panel muted', text: state.scoutingError ? `Analiz başarısız: ${state.scoutingError}` : 'Rakipler analiz ediliyor…' }));
    return;
  }
  $cards.append(el('h3', { text: 'Rakipler' }));
  for (const c of s.enemies) $cards.append(playerCard(c, { compact: true }));
  if (s.allies.length) {
    $cards.append(el('div', { class: 'panel allies' }, 'Takım: ', s.allies.map((c, i) => [i ? ', ' : '', el('b', { text: c.name }), ` ${c.civTr}`])));
  }
}

// ---- Koç paneli ----
function renderCoach(view) {
  const playing = state && state.phase === 'playing' && view;
  $coach.hidden = !playing;
  if (!playing) {
    coachKey = null;
    return;
  }
  const b = view.build;
  const key = b ? `${b.name}|${b.index}|${b.manual}` : 'none';
  if (key !== coachKey) {
    coachKey = key;
    refs = buildCoachDom(b);
    fill($coach, refs.root);
  }
  refs.clock.textContent = clock(view.elapsed);
  if (refs.bar && b && b.nextInSec != null) {
    refs.nextIn.textContent = clock(b.nextInSec);
    // Çubuk, adım ekrana geldiği andaki kalan süreye göre dolar.
    refs.spanSec ||= Math.max(1, b.nextInSec);
    refs.bar.style.width = `${Math.min(100, 100 - (b.nextInSec / refs.spanSec) * 100)}%`;
  }
}

function buildCoachDom(b) {
  const clockEl = el('span', { class: 'clock', text: '0:00' });
  if (!b) {
    const civ = state.myCiv ? state.myCiv.tr : 'ülken';
    return {
      clock: clockEl,
      root: el('div', { class: 'panel' },
        el('div', { class: 'top' }, el('span', { text: 'Age of Koçu' }), clockEl),
        el('p', { class: 'empty', text: `${civ} için build order yüklenemedi. Panelden bir build seç.` }),
      ),
    };
  }
  const s = b.step;
  const nextIn = el('b', { text: '' });
  const bar = el('i');
  bar.style.width = '0%';
  const root = el('div', { class: 'panel' },
    el('div', { class: 'top' },
      el('span', { class: 'build-name', title: b.name, text: `${b.name} · ${b.index + 1}/${b.total}` }),
      clockEl,
    ),
    el('div', { class: 'say', text: stepSentence(s) }),
    resourceRow(s, { compact: true }),
    s.notes.length ? el('div', { class: 'notes' }, s.notes.map(note)) : null,
    b.next ? el('div', { class: 'next' },
      b.manual ? el('span', { class: 'manual', text: 'Elle ayarlandı · ' }) : null,
      'Sonraki',
      b.nextInSec != null ? [' (', nextIn, ')'] : null,
      b.nextAtVillagers != null ? ` (${b.nextAtVillagers} köylüde)` : null,
      ': ', stepSentence(b.next),
      b.nextInSec != null ? el('div', { class: 'bar' }, bar) : null,
    ) : el('div', { class: 'next', text: 'Build order bitti. Artık oyunu oku, ekonomiyi büyütmeye devam et.' }),
    el('div', { class: 'keys', text: 'Ctrl+Alt+→/← adım · ↑/↓ saat ±10 sn · R rakipler · N yönet modu · O gizle' }),
  );
  return { root, clock: clockEl, bar: b.nextInSec != null ? bar : null, nextIn, spanSec: null };
}

// ---- Ekrandan okunan değerler: koçun ne gördüğünü gösterir ----
function renderHud(h) {
  $hud.hidden = !h;
  if (!h) return;
  const n = (v) => (v == null ? '?' : v);
  const vil = h.vil;
  fill($hud, el('div', { class: 'panel hud-row' },
    el('span', { text: `Y ${n(h.res.food)} · O ${n(h.res.wood)} · A ${n(h.res.gold)} · T ${n(h.res.stone)}` }),
    el('span', { text: `Köylü ${n(h.villagers)} (${n(vil.food)}/${n(vil.wood)}/${n(vil.gold)}/${n(vil.stone)})` }),
    el('span', { text: `Nüfus ${h.pop ? `${h.pop.cur}/${h.pop.cap}` : '?'}` }),
    h.idle ? el('span', { class: 'idle', text: `Boşta ${h.idle}` }) : null,
  ));
}

// ---- YZ koç: yüklemede oyun planı, maç içinde son değerlendirme ----
const RISK_TR = { 'düşük': 'Düşük risk', orta: 'Orta risk', 'yüksek': 'Yüksek risk' };

function renderAi() {
  const a = state?.ai;
  const active = state && (state.phase === 'loading' || state.phase === 'playing') && a?.available;
  const live = a?.live?.[0];
  const showPlan = state?.phase === 'loading' || (state?.cardsVisible && !live);
  $ai.hidden = !active || (!a.plan && !live && !a.planStatus && !a.liveStatus);
  if ($ai.hidden) return;
  const busy = a.planStatus === 'running' ? 'Koç oyun planını hazırlıyor…' : a.liveStatus === 'running' ? 'Koç ekranına bakıyor…' : null;
  const err = a.liveStatus === 'error' ? a.liveError : a.planStatus === 'error' ? a.planError : null;
  fill($ai, el('div', { class: `panel ai lvl-${live ? (live.risk === 'yüksek' ? 'danger' : live.risk === 'orta' ? 'info' : 'chance') : 'info'}` },
    el('div', { class: 'ai-head' }, el('b', { text: `Koç${live?.command ? ' · yönet' : ''}${a.combat ? ' · savaş' : ''}` }), live && !showPlan ? el('span', { text: `${live.at} · ${RISK_TR[live.risk] || ''}` }) : null),
    showPlan && a.plan ? [
      el('p', { class: 'ai-main', text: a.plan.ozet }),
      el('ul', {}, a.plan.rakipTahminleri.slice(0, 3).map((t) => el('li', {}, el('b', { text: `${t.oyuncu}: ` }), `${t.tahmin} (${t.zamanlama})`))),
    ] : null,
    !showPlan && live ? [
      el('p', { class: 'ai-main', text: live.durum }),
      live.komutlar?.length
        ? el('ol', {}, live.komutlar.map((k) => el('li', { text: k.metin })))
        : el('ol', {}, live.simdiYap.map((x) => el('li', { text: x }))),
      live.hedefDagilim ? el('p', { class: 'ai-sub', text: live.hedefDagilim }) : null,
      !live.komutlar?.length && live.uret?.length ? el('p', { class: 'ai-sub' }, el('b', { text: 'Üret: ' }), live.uret.join(' · ')) : null,
      !live.komutlar?.length && live.gelistir ? el('p', { class: 'ai-sub' }, el('b', { text: 'Geliştir: ' }), live.gelistir) : null,
      el('p', { class: 'ai-sub' }, el('b', { text: 'Tahmin: ' }), live.tahmin),
      el('p', { class: 'ai-sub' }, el('b', { text: 'Hedef: ' }), live.sonrakiHedef),
    ] : null,
    busy ? el('p', { class: 'ai-sub', text: busy }) : null,
    err ? el('p', { class: 'ai-sub err', text: `YZ: ${err}` }) : null,
  ));
}

// ---- Uyarılar ----
function showAlert(a) {
  const node = el('div', { class: `panel alert lvl-${a.level}`, text: a.text });
  $alerts.prepend(node);
  setTimeout(() => node.classList.add('out'), ALERT_MS);
  setTimeout(() => node.remove(), ALERT_MS + 700);
}

window.kocu.on('state', (s) => {
  state = s;
  if (s.phase !== 'playing') renderCoach(null);
  renderCards();
  renderAi();
  renderNotes();
});
window.kocu.on('coach', (view) => renderCoach(view));
window.kocu.on('alert', (a) => { if (mode === 'detailed') showAlert(a); });
window.kocu.on('hud', renderHud);
window.kocu.on('notes', (list) => { noteList = list; renderNotes(); });

// Kısayol onayı (ör. "Ekran görüntüsü alındı ✓"): her durumda 3 sn görünür.
const $flash = document.getElementById('flash');
let flashTimer = null;
window.kocu.on('flash', ({ text, level }) => {
  $flash.textContent = text;
  $flash.className = `flash lvl-${level}`;
  $flash.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { $flash.hidden = true; }, 3000);
});
window.kocu.on('settings', (s) => { applySide(s.overlaySide); applyMode(s.overlayMode); });

Promise.all([window.kocu.getState(), window.kocu.getSettings()]).then(([s, settings]) => {
  state = s;
  applySide(settings.overlaySide);
  renderCards();
  renderAi();
  applyMode(settings.overlayMode);
});
window.kocu.getNotes().then((list) => { noteList = list; renderNotes(); });
