'use strict';

// Ekrandan okunan HUD değerlerini yorumlar ve koç uyarıları üretir. Saf modül: zaman ve
// okumalar dışarıdan verilir, böylece testlerde birebir tekrar edilebilir.
//
// Sadece oyuncunun kendi ekranında gördüğü bilgi kullanılır (kaynaklar, köylü dağılımı,
// nüfus, boşta köylü). Rakip hakkında hiçbir şey okunmaz.

const RESOURCES = ['food', 'wood', 'gold', 'stone'];
const RES_TR_DAT = { food: 'yemeğe', wood: 'oduna', gold: 'altına', stone: 'taşa' };
const RES_TR_ABL = { food: 'yemekten', wood: 'odundan', gold: 'altından', stone: 'taştan' };

// Kalibrasyonda tanımlanabilen alanlar; panel bu listeyi kullanır.
const FIELDS = [
  { key: 'food', label: 'Yemek miktarı', kind: 'amount' },
  { key: 'wood', label: 'Odun miktarı', kind: 'amount' },
  { key: 'gold', label: 'Altın miktarı', kind: 'amount' },
  { key: 'stone', label: 'Taş miktarı', kind: 'amount' },
  { key: 'vilFood', label: 'Yemekteki köylü', kind: 'count' },
  { key: 'vilWood', label: 'Odundaki köylü', kind: 'count' },
  { key: 'vilGold', label: 'Altındaki köylü', kind: 'count' },
  { key: 'vilStone', label: 'Taştaki köylü', kind: 'count' },
  { key: 'pop', label: 'Nüfus (64/80)', kind: 'pop' },
  { key: 'idle', label: 'Boştaki köylü', kind: 'count' },
];

// OCR'a girmeyen, renkleri incelenen bölgeler (bkz. minimap.js).
const AREAS = [
  { key: 'minimap', label: 'Mini harita (tamamı)', kind: 'area', hint: 'Mini haritanın kendisini kapsa; çevresindeki süsleri ve düğmeleri dışarıda bırak.' },
  { key: 'scoreboard', label: 'Oyuncu listesi (sağdaki isimler)', kind: 'area', hint: '"İsim | II. Çağ" satırlarının hepsini kapsa; sağdaki bayrakları dışarıda bırak, soldaki ⚔ işaretleri için biraz boşluk bırak.' },
];

const MIN_CONFIDENCE = 55;
const SMOOTH_WINDOW = 3;

function parseField(kind, text, confidence) {
  if (confidence < MIN_CONFIDENCE) return null;
  if (kind === 'pop') {
    const m = /^(\d{1,3})\/(\d{1,3})$/.exec(text);
    if (!m) return null;
    const cur = Number(m[1]);
    const cap = Number(m[2]);
    return cur <= 300 && cap <= 300 ? { cur, cap } : null;
  }
  if (!/^\d{1,6}$/.test(text)) return null;
  const v = Number(text);
  if (kind === 'count' && v > 250) return null;
  return v;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Son birkaç okumanın ortancası: tek karelik OCR hatalarını yutar.
class HudState {
  constructor() {
    this.raw = {};
  }

  push(readings) {
    for (const f of FIELDS) {
      const r = readings[f.key];
      if (r === undefined) continue;
      const list = (this.raw[f.key] ||= []);
      list.push(r);
      if (list.length > SMOOTH_WINDOW) list.shift();
    }
    return this.snapshot();
  }

  value(key) {
    const list = (this.raw[key] || []).filter((v) => v != null);
    if (!list.length) return null;
    if (key === 'pop') {
      return { cur: median(list.map((p) => p.cur)), cap: median(list.map((p) => p.cap)) };
    }
    return median(list);
  }

  snapshot() {
    const vil = {
      food: this.value('vilFood'),
      wood: this.value('vilWood'),
      gold: this.value('vilGold'),
      stone: this.value('vilStone'),
    };
    const known = RESOURCES.filter((r) => vil[r] != null);
    const idle = this.value('idle');
    return {
      res: Object.fromEntries(RESOURCES.map((r) => [r, this.value(r)])),
      vil,
      villagers: known.length === 4 ? known.reduce((s, r) => s + vil[r], 0) + (idle || 0) : null,
      pop: this.value('pop'),
      idle,
    };
  }
}

// Durum kuralları: koşul holdSec boyunca sürünce not görünür, koşul bitince kaybolur.
// Metinler bilinçli olarak kısa: overlay'de sadece "ne eksik" görünür.
class HudCoach {
  constructor() {
    this.reset();
  }

  reset() {
    this.since = {};
    this.villagerHistory = []; // { t, n }
  }

  held(key, active, t, holdSec) {
    if (!active) {
      delete this.since[key];
      return false;
    }
    this.since[key] ??= t;
    return t - this.since[key] >= holdSec;
  }

  // hud: HudState.snapshot(); t: maç saniyesi; step: güncel build adımı (yoksa null)
  // combat: savaş modunda köylü kaydırma notu verilmez (dikkat dağıtmasın).
  // Dönen: o an geçerli notlar [{ key, level, text }]
  evaluate(hud, t, step, { combat = false } = {}) {
    const out = [];
    const add = (key, level, text) => out.push({ key, level, text });

    if (hud.idle != null && this.held('idle', hud.idle > 0, t, 4)) add('idle', 'danger', `${hud.idle} köylü boşta`);

    if (hud.pop && hud.pop.cap < 200 && this.held('house', hud.pop.cap - hud.pop.cur <= 2, t, 2)) {
      add('house', 'danger', `Ev kur (${hud.pop.cur}/${hud.pop.cap})`);
    }

    if (hud.villagers != null) {
      this.villagerHistory.push({ t, n: hud.villagers });
      while (this.villagerHistory.length && t - this.villagerHistory[0].t > 45) this.villagerHistory.shift();
      const first = this.villagerHistory[0];
      const stalled = t > 60 && hud.villagers < 100 && t - first.t >= 40 && hud.villagers <= first.n && (!hud.pop || hud.pop.cap - hud.pop.cur > 2);
      if (this.held('vilstall', stalled, t, 0)) add('vilstall', 'danger', 'Köylü bas');
    }

    const r = hud.res;
    if (RESOURCES.every((k) => r[k] != null)) {
      const bank = r.food + r.wood + r.gold + r.stone;
      if (this.held('float', bank > (t < 12 * 60 ? 800 : 1500), t, 20)) add('float', 'info', 'Kaynak birikiyor, harca');
    }

    const fix = combat ? null : distributionFix(hud.vil, step);
    if (fix && this.held(`dist:${fix.key}`, true, t, 8)) add('dist', 'info', fix.text);

    return out;
  }
}

// Build adımındaki hedef dağılımla HUD'daki dağılımı karşılaştırır: "Oduna +2 köylü (yemekten)".
function distributionFix(vil, step) {
  if (!step || RESOURCES.some((k) => vil[k] == null)) return null;
  const target = Object.fromEntries(RESOURCES.map((k) => [k, step[k] || 0]));
  const totalTarget = RESOURCES.reduce((s, k) => s + target[k], 0);
  if (!totalTarget) return null;
  const diffs = RESOURCES.map((k) => ({ k, d: target[k] - vil[k] }));
  const need = diffs.filter((x) => x.d >= 2).sort((a, b) => b.d - a.d)[0];
  if (!need) return null;
  const extra = diffs.filter((x) => x.d <= -1).sort((a, b) => a.d - b.d)[0];
  const word = RES_TR_DAT[need.k];
  return {
    key: `${need.k}:${target[need.k]}`,
    text: `${word[0].toUpperCase()}${word.slice(1)} +${need.d} köylü${extra ? ` (${RES_TR_ABL[extra.k]})` : ''}`,
  };
}

module.exports = { FIELDS, AREAS, RESOURCES, parseField, HudState, HudCoach, distributionFix };
