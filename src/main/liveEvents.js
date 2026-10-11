'use strict';

// Maç içi "önemli an" algılayıcı. Her saniye yerel verilerle (ekrandan okunan HUD, mini harita
// olayları, oyuncu listesi) çalışır; YZ'yi beklemeden not üretir ve savaş moduna girip çıkar.
// Saf modül: zaman ve okumalar dışarıdan verilir.

const LOSS_WINDOW = 15; // sn
const POP_LOSS = 4; // bu pencerede bu kadar nüfus düşüşü = kayıp
const VIL_LOSS = 3;
const HOLD_SEC = 20; // olay bittikten sonra notun kalma süresi
const COMBAT_EXIT_SEC = 60; // bu kadar sakin geçince savaş modu biter
const COMBAT_KINDS = new Set(['losses', 'vilLoss', 'base', 'incoming', 'raid']);
const WIDTH_CHANGE = 4; // px: oyuncu listesinde satır bu kadar uzayınca çağ atlamış olabilir
const WIDTH_FRAMES = 3;

class LiveMonitor {
  constructor() {
    this.reset();
  }

  reset() {
    this.popHist = []; // { t, v }
    this.vilHist = [];
    this.active = new Map(); // key -> { key, kind, level, text, since, last }
    this.combatSince = null;
    this.lastCombatSignal = null;
    this.rowBase = null; // oyuncu listesi satır genişlikleri (son kararlı)
    this.rowPending = null; // { widths, frames }
    this.log = []; // { t, kind, text } YZ bağlamı için son olaylar
  }

  get combat() {
    return this.combatSince != null;
  }

  // Dönen: { fresh: yeni başlayan olaylar, combatStarted, combatEnded, rowsChanged: değişen satır indeksleri }
  observe({ t, hud = null, mapEvents = [], rows = null }) {
    const now = [];
    if (hud?.pop) this.track(this.popHist, t, hud.pop.cur);
    if (hud?.villagers != null) this.track(this.vilHist, t, hud.villagers);
    const popDrop = this.drop(this.popHist);
    if (popDrop >= POP_LOSS) now.push({ key: 'losses', kind: 'losses', level: 'danger', text: `Kayıp veriyorsun (−${popDrop} nüfus)` });
    const vilDrop = this.drop(this.vilHist);
    if (vilDrop >= VIL_LOSS) now.push({ key: 'vilLoss', kind: 'vilLoss', level: 'danger', text: 'Köylüler saldırı altında' });
    for (const e of mapEvents) now.push({ key: `map-${e.key}`, kind: e.kind, level: e.level, text: e.text });

    const fresh = [];
    for (const e of now) {
      const cur = this.active.get(e.key);
      if (!cur) {
        fresh.push(e);
        this.log.push({ t, kind: e.kind, text: e.text });
      }
      this.active.set(e.key, { ...e, since: cur ? cur.since : t, last: t });
    }
    for (const [k, e] of this.active) if (t - e.last > HOLD_SEC) this.active.delete(k);
    this.log = this.log.filter((x) => t - x.t <= 120).slice(-12);

    let combatStarted = false;
    let combatEnded = false;
    if (now.some((e) => COMBAT_KINDS.has(e.kind))) {
      this.lastCombatSignal = t;
      if (this.combatSince == null) {
        this.combatSince = t;
        combatStarted = true;
      }
    } else if (this.combatSince != null && t - this.lastCombatSignal >= COMBAT_EXIT_SEC) {
      this.combatSince = null;
      combatEnded = true;
    }

    return { fresh, combatStarted, combatEnded, rowsChanged: rows ? this.rowChanges(rows) : [] };
  }

  track(hist, t, v) {
    hist.push({ t, v });
    while (hist.length && t - hist[0].t > LOSS_WINDOW) hist.shift();
  }

  // Penceredeki en yüksek değerden şimdiki değere düşüş. Artışlar (yeni üretim) sayılmaz.
  drop(hist) {
    if (hist.length < 2) return 0;
    const cur = hist[hist.length - 1].v;
    return Math.max(0, Math.max(...hist.map((h) => h.v)) - cur);
  }

  // Satır sayısı aynı kalıp bir satırın genişliği 3 kare boyunca değişik kalırsa o satır değişmiştir.
  rowChanges(rows) {
    const widths = rows.map((r) => r.width);
    if (!this.rowBase || this.rowBase.length !== widths.length) {
      this.rowBase = widths;
      this.rowPending = null;
      return [];
    }
    const diff = widths.map((w, i) => Math.abs(w - this.rowBase[i]) >= WIDTH_CHANGE);
    if (!diff.some(Boolean)) {
      this.rowPending = null;
      return [];
    }
    const same = this.rowPending && this.rowPending.widths.every((w, i) => Math.abs(w - widths[i]) < WIDTH_CHANGE);
    this.rowPending = { widths, frames: same ? this.rowPending.frames + 1 : 1 };
    if (this.rowPending.frames < WIDTH_FRAMES) return [];
    const changed = diff.map((d, i) => (d ? i : -1)).filter((i) => i >= 0);
    this.rowBase = widths;
    this.rowPending = null;
    return changed;
  }

  // Dışarıdan gelen olay (ör. YZ'nin okuduğu çağ atlaması) hem not hem günlük olur.
  push(t, e) {
    const cur = this.active.get(e.key);
    this.active.set(e.key, { ...e, since: cur ? cur.since : t, last: t });
    if (!cur) this.log.push({ t, kind: e.kind, text: e.text });
  }

  notes() {
    return [...this.active.values()].map((e) => ({ key: `ev-${e.key}`, level: e.level, text: e.text }));
  }

  recent(t) {
    return this.log.filter((x) => t - x.t <= 120).map((x) => ({ saniyeOnce: Math.round(t - x.t), olay: x.text }));
  }
}

module.exports = { LiveMonitor, COMBAT_KINDS };
