// Basit çizgi grafiği (SVG): x = dakika, y = adet. Seriler sabit sırada renk alır
// (--series-1..3), uçlarında doğrudan etiket, üstte gösterge, fareyle dikey çizgi + değer kutusu.
import { el } from '../shared/ui.js';

const NS = 'http://www.w3.org/2000/svg';
const W = 470;
const H = 220;
const PAD = { top: 12, right: 96, bottom: 26, left: 36 };

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  for (const c of children.flat()) if (c) node.append(c);
  return node;
}

function niceMax(v) {
  if (v <= 5) return 5;
  const step = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / step) * step;
}

// series: [{ label, values: number[] (dakika başına) }]
export function lineChart({ title, series, unit = '' }) {
  const n = Math.max(...series.map((s) => s.values.length));
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (i) => PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * iw);
  const y = (v) => PAD.top + ih - (v / max) * ih;

  const grid = [];
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k;
    grid.push(svg('line', { x1: PAD.left, x2: PAD.left + iw, y1: y(v), y2: y(v), class: 'grid' }));
    grid.push(svg('text', { x: PAD.left - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, String(Math.round(v))));
  }
  const stepMin = n > 40 ? 10 : 5;
  for (let m = 0; m < n; m += stepMin) {
    grid.push(svg('text', { x: x(m), y: H - 6, 'text-anchor': 'middle', class: 'tick' }, `${m} dk`));
  }

  // Doğrudan etiketler çakışmasın diye dikeyde en az 14px aralık bırakılır.
  const ends = series.map((s, i) => ({ i, y: y(s.values[s.values.length - 1] ?? 0) })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) ends[k].y = Math.max(ends[k].y, ends[k - 1].y + 14);
  const labelY = Object.fromEntries(ends.map((e) => [e.i, e.y]));

  const lines = series.map((s, i) => {
    const d = s.values.map((v, j) => `${j ? 'L' : 'M'}${x(j).toFixed(1)},${y(v).toFixed(1)}`).join('');
    return svg('g', { class: `series s${i + 1}` },
      svg('path', { d, class: 'line' }),
      svg('text', { x: x(s.values.length - 1) + 6, y: labelY[i] + 4, class: 'end-label' }, `${s.label} ${s.values[s.values.length - 1] ?? 0}`),
    );
  });

  const cross = svg('line', { y1: PAD.top, y2: PAD.top + ih, class: 'cross', visibility: 'hidden' });
  const dots = series.map((_, i) => svg('circle', { r: 4, class: `dot s${i + 1}`, visibility: 'hidden' }));
  const hit = svg('rect', { x: PAD.left, y: PAD.top, width: iw, height: ih, class: 'hit' });
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': title }, grid, lines, cross, dots, hit);

  const tip = el('div', { class: 'chart-tip', hidden: true });
  const box = el('figure', { class: 'chart-box' },
    el('figcaption', {}, el('strong', { text: title }),
      el('span', { class: 'legend' }, series.map((s, i) => el('span', { class: `key s${i + 1}` }, el('i'), s.label)))),
    el('div', { class: 'chart-wrap' }, root, tip),
  );

  hit.addEventListener('mousemove', (ev) => {
    const r = root.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const m = Math.max(0, Math.min(n - 1, Math.round(((px - PAD.left) / iw) * (n - 1))));
    cross.setAttribute('x1', x(m));
    cross.setAttribute('x2', x(m));
    cross.setAttribute('visibility', 'visible');
    series.forEach((s, i) => {
      const v = s.values[Math.min(m, s.values.length - 1)] ?? 0;
      dots[i].setAttribute('cx', x(m));
      dots[i].setAttribute('cy', y(v));
      dots[i].setAttribute('visibility', 'visible');
    });
    tip.replaceChildren(el('b', { text: `${m}. dakika` }), ...series.map((s, i) =>
      el('div', { class: `row s${i + 1}` }, el('i'), `${s.label}: `, el('b', { text: `${s.values[Math.min(m, s.values.length - 1)] ?? 0}${unit}` }))));
    tip.hidden = false;
    const left = (x(m) / W) * r.width;
    tip.style.left = `${Math.min(left + 12, r.width - 160)}px`;
  });
  hit.addEventListener('mouseleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
    tip.hidden = true;
  });
  return box;
}
