// "Ekran Okuma" sekmesi: oyun görüntüsü üzerinde HUD alanlarının kutularını çizme ve test etme.
import { el, fill } from '../shared/ui.js';

const api = window.kocu;
const ZOOMS = [0.5, 1, 2];

let cal = null; // { image, width, height, fields: FIELDS, regions }
let boxes = {}; // fieldKey -> {x,y,w,h} (görüntü pikseli)
let selected = null;
let zoom = 1;
let results = {};
let host = null;

export async function renderCalibration(view) {
  host = view;
  cal = await api.getCalibration();
  boxes = { ...(cal.regions && cal.regions.width === cal.width ? cal.regions.fields : {}) };
  selected = cal.fields.find((f) => !boxes[f.key])?.key || cal.fields[0].key;
  results = {};
  draw();
}

// Ctrl+Alt+K ile yeni görüntü gelince.
export function onCalibrationImage(img) {
  if (!host) return;
  cal = { ...cal, ...img };
  draw();
}

function draw() {
  fill(host,
    el('h1', { text: 'Ekran Okuma' }),
    el('p', { class: 'lead', text: 'Koç, maç sırasında saniyede bir kendi ekranındaki kaynakları, köylü dağılımını, nüfusu ve boştaki köylüleri okur. Böylece "oduna 2 köylü kaydır", "ev kur", "köylü boşta" gibi anlık uyarılar verir. Sadece senin gördüğün HUD okunur.' }),
    el('label', { class: 'check' },
      el('input', { type: 'checkbox', checked: cal.enabled, onchange: (e) => api.updateSettings({ screenReadingEnabled: e.target.checked }) }),
      'Maç sırasında ekranı oku'),
    el('div', { class: 'box' },
      el('ol', {},
        el('li', {}, 'Bir maça gir (yapay zekâya karşı olabilir). Kaynak paneli ve köylü sayıları görünür olsun.'),
        el('li', {}, el('kbd', { text: 'Ctrl+Alt+K' }), ' ile ekran görüntüsü al (ya da aşağıdaki "5 sn sonra yakala" düğmesine basıp oyuna geç).'),
        el('li', {}, 'Sağdan bir alan seç, görüntüde o sayının etrafına kutu çiz. Kutu sadece rakamları kapsasın; ikonları dışarıda bırak.'),
        el('li', {}, 'Mini harita ve oyuncu listesi kutuları renk okuması içindir: koç mini haritada beliren düşmanları (kısa süre görünse de) ve çağ atlamalarını yakalar. Oyuncu listesi oyunda açık olmalı.'),
        el('li', {}, '"Test et" ile okunan değerleri kontrol et, sonra "Kaydet".'),
      ),
      el('div', { class: 'row' },
        el('button', { class: 'btn', text: '5 sn sonra yakala', onclick: async (e) => {
          e.target.disabled = true;
          e.target.textContent = 'Oyuna geç…';
          try { onCalibrationImage(await api.captureCalibration(5)); } finally { e.target.disabled = false; }
        } }),
        el('span', { class: 'muted', text: 'Yakınlaştırma:' }),
        ZOOMS.map((z) => el('button', { class: `btn ${z === zoom ? 'primary' : ''}`, text: `%${z * 100}`, onclick: () => { zoom = z; draw(); } })),
      ),
    ),
    cal.image ? editor() : el('div', { class: 'box' }, el('p', { class: 'muted', text: 'Henüz kalibrasyon görüntüsü yok.' })),
  );
}

function editor() {
  const W = cal.width * zoom;
  const H = cal.height * zoom;
  const stage = el('div', { class: 'cal-stage' });
  stage.style.width = `${W}px`;
  stage.style.height = `${H}px`;
  const img = el('img', { src: cal.image, draggable: 'false', alt: 'Kalibrasyon görüntüsü' });
  img.style.width = `${W}px`;
  img.style.height = `${H}px`;
  stage.append(img);
  for (const f of cal.fields) {
    const b = boxes[f.key];
    if (!b) continue;
    stage.append(boxEl(f, b));
  }
  const ghost = el('div', { class: 'cal-box ghost', hidden: true });
  stage.append(ghost);

  // Fareyle kutu çizimi (görüntü pikseli = ekran pikseli / zoom).
  let start = null;
  const pos = (ev) => {
    const r = stage.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / zoom, y: (ev.clientY - r.top) / zoom };
  };
  const rect = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
  stage.addEventListener('mousedown', (ev) => { ev.preventDefault(); start = pos(ev); });
  stage.addEventListener('mousemove', (ev) => {
    if (!start) return;
    placeBox(ghost, rect(start, pos(ev)));
    ghost.hidden = false;
  });
  window.onmouseup = (ev) => {
    if (!start) return;
    const r = rect(start, pos(ev));
    start = null;
    ghost.hidden = true;
    if (r.w < 4 || r.h < 4) return;
    boxes[selected] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
    delete results[selected];
    selected = cal.fields.find((f) => !boxes[f.key])?.key || selected;
    draw();
  };

  return el('div', { class: 'cal' },
    el('div', { class: 'cal-scroll' }, stage),
    el('div', { class: 'cal-side' },
      el('div', { class: 'cal-fields' }, cal.fields.map(fieldRow)),
      el('div', { class: 'row' },
        el('button', { class: 'btn', text: 'Test et', onclick: test }),
        el('button', { class: 'btn primary', text: 'Kaydet', onclick: save }),
      ),
      el('p', { class: 'muted', id: 'cal-msg' }),
    ),
  );
}

function placeBox(node, b) {
  node.style.left = `${b.x * zoom}px`;
  node.style.top = `${b.y * zoom}px`;
  node.style.width = `${b.w * zoom}px`;
  node.style.height = `${b.h * zoom}px`;
}

function boxEl(f, b) {
  const node = el('div', { class: `cal-box ${f.key === selected ? 'sel' : ''}` }, el('span', { text: f.label }));
  placeBox(node, b);
  return node;
}

function fieldRow(f) {
  const r = results[f.key];
  const area = f.kind === 'area';
  return el('div', { class: `cal-field ${f.key === selected ? 'sel' : ''}`, onclick: () => { selected = f.key; draw(); } },
    el('div', {},
      el('b', { text: f.label }),
      el('div', { class: 'muted', text: boxes[f.key] ? 'Kutu çizildi' : area ? 'İsteğe bağlı · kutu çizilmedi' : 'Kutu çizilmedi' }),
      area && f.key === selected ? el('div', { class: 'muted', text: f.hint }) : null,
    ),
    r ? el('div', { class: `cal-result ${area ? 'area' : ''}` },
      el('img', { src: r.preview, alt: '' }),
      el('span', { class: r.value != null ? 'res-win' : 'res-loss', text: area ? r.text : r.value != null ? `${r.text} (%${r.confidence})` : `okunamadı: "${r.text}"` }),
    ) : null,
    boxes[f.key] ? el('button', { class: 'btn', text: 'Sil', onclick: (e) => { e.stopPropagation(); delete boxes[f.key]; delete results[f.key]; draw(); } }) : null,
  );
}

async function test() {
  try {
    results = await api.testCalibration(boxes);
    draw();
  } catch (err) {
    document.getElementById('cal-msg').textContent = `Test başarısız: ${err.message}`;
  }
}

async function save() {
  await api.saveCalibration({ width: cal.width, height: cal.height, fields: boxes });
  document.getElementById('cal-msg').textContent = 'Kaydedildi. Bir sonraki maçta ekran okuma devrede.';
}
