// Panel ve overlay'in ortak çizim yardımcıları. Dışarıdan gelen metin (oyuncu adı,
// build notları) her zaman textContent ile basılır; HTML olarak yorumlanmaz.

const ICON_BASE = 'https://aoe4guides.com/assets/pictures/';

export const RESOURCES = [
  { key: 'food', label: 'Yemek', icon: 'resource/resource_food.webp' },
  { key: 'wood', label: 'Odun', icon: 'resource/resource_wood.webp' },
  { key: 'gold', label: 'Altın', icon: 'resource/resource_gold.webp' },
  { key: 'stone', label: 'Taş', icon: 'resource/resource_stone.webp' },
  { key: 'builder', label: 'İnşaat', icon: 'abilities/repair.webp' },
];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// replaceChildren null/false'u "null" metni olarak basar; bu sarmalayıcı onları atlar.
export function fill(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return node;
}

export function icon(path, title = '') {
  return el('img', { class: 'ico', src: ICON_BASE + path, alt: title, title, draggable: 'false' });
}

export function clock(sec) {
  if (sec == null) return '–';
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function decodeEntities(s) {
  return s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// aoe4guides notlarındaki "@klasör/dosya.webp@" belirteçlerini ikonlara çevirir.
export function note(text) {
  const parts = decodeEntities(text).split(/@([\w\-/.]+?\.(?:webp|png|jpg))@/);
  return el('div', { class: 'note' }, parts.map((p, i) => (i % 2 ? icon(p) : p)));
}

// "7 yemek · 2 odun · 2 altın" satırı: koçun en net talimatı.
export function resourceRow(step, { compact = false } = {}) {
  const items = RESOURCES.filter((r) => step[r.key] > 0).map((r) =>
    el('span', { class: `res res-${r.key}` }, icon(r.icon, r.label), el('b', { text: String(step[r.key]) }), compact ? null : el('small', { text: r.label })),
  );
  return el('div', { class: 'res-row' }, items.length ? items : el('span', { class: 'muted', text: 'Dağılım değişmiyor' }));
}

export function stepSentence(step) {
  const parts = RESOURCES.filter((r) => r.key !== 'builder' && step[r.key] > 0).map((r) => `${step[r.key]} ${r.label.toLowerCase()}`);
  if (step.builder > 0) parts.push(`${step.builder} inşaatta`);
  const head = step.villagers ? `${step.villagers} köylü` : 'Köylüler';
  return parts.length ? `${head}: ${parts.join(', ')}` : head;
}

const LEVEL_LABEL = { danger: 'Dikkat', chance: 'Fırsat', info: 'Bilgi', good: 'İyi' };

export function insightList(insights, max = Infinity) {
  return el('ul', { class: 'insights' }, insights.slice(0, max).map((i) =>
    el('li', { class: `lvl-${i.level}` }, el('span', { class: 'tag', text: LEVEL_LABEL[i.level] || '' }), el('span', { text: i.text })),
  ));
}

function rankText(r) {
  if (!r) return 'Reyting yok';
  const lvl = r.rankLevel ? ` · ${r.rankLevel.replace('_', ' ')}` : '';
  return `${r.rating}${lvl}`;
}

export function formDots(form) {
  return el('span', { class: 'form', title: 'Son maçlar (soldan en yeni)' }, [...(form || '')].map((c) => el('i', { class: c === 'G' ? 'w' : 'l' })));
}

// Oyuncu kartı. compact: overlay'de kısa sürüm (en fazla 2 not).
export function playerCard(c, { compact = false, ally = false } = {}) {
  const s = c.stats;
  return el('article', { class: `card ${ally ? 'ally' : 'enemy'} ${c.mainThreat ? 'threat' : ''}` },
    el('header', {},
      el('div', { class: 'who' },
        el('strong', { text: c.name }),
        el('span', { class: 'civ', text: c.civTr || '' }),
      ),
      el('div', { class: 'rating', text: rankText(c.rating) }),
    ),
    c.error ? el('p', { class: 'muted', text: `Profil alınamadı: ${c.error}` }) : null,
    s ? el('div', { class: 'meta' },
      el('span', { text: `${s.games} maç · %${s.winRate ?? '–'}` }),
      formDots(s.form),
    ) : null,
    s && !compact ? el('div', { class: 'top-civs' }, s.topCivs.map((t) => el('span', { class: 'chip', text: `${t.tr} ${t.games} · %${t.winRate}` }))) : null,
    c.insights?.length ? insightList(c.insights, compact ? 2 : Infinity) : null,
  );
}
