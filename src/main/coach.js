'use strict';

// AoE4'te kasaba merkezi 20 saniyede bir köylü üretir; ekran okuma gelene kadar
// build adımlarını bu tahminle ilerletiyoruz.
const VILLAGER_TRAIN_SEC = 20;
const DEFAULT_START_VILLAGERS = 6;

// Her adım için "ne zaman gelmeli" saniyesini hesaplar. Süresi yazılı adım süreyi,
// sadece köylü hedefi olan adım üretim tahminini kullanır; ikisi de yoksa öncekini devralır.
function stepTriggers(steps) {
  const startVils = steps.find((s) => s.villagers)?.villagers || DEFAULT_START_VILLAGERS;
  let prev = 0;
  return steps.map((s) => {
    let t = prev;
    if (s.time != null) t = s.time;
    else if (s.villagers) t = Math.max(0, (s.villagers - startVils) * VILLAGER_TRAIN_SEC);
    prev = Math.max(prev, t);
    return prev;
  });
}

class BuildRunner {
  constructor(build) {
    this.build = build;
    this.triggers = build ? stepTriggers(build.steps) : [];
    this.offset = 0;
  }

  autoIndex(elapsedSec) {
    let idx = 0;
    for (let i = 0; i < this.triggers.length; i++) if (this.triggers[i] <= elapsedSec) idx = i;
    return idx;
  }

  index(elapsedSec) {
    const n = this.triggers.length;
    if (!n) return -1;
    return Math.min(n - 1, Math.max(0, this.autoIndex(elapsedSec) + this.offset));
  }

  // Oyuncu geride/ileride kaldıysa bütün planı bir adım kaydırır.
  shift(delta, elapsedSec) {
    const n = this.triggers.length;
    const auto = this.autoIndex(elapsedSec);
    this.offset = Math.min(n - 1 - auto, Math.max(-auto, this.offset + delta));
    this.manualAtSec = elapsedSec;
  }

  // Ekrandan okunan gerçek köylü sayısına göre adımı seçer (tahmini saatten daha doğru).
  // Oyuncu son 20 saniyede elle kaydırdıysa ona dokunmaz.
  syncVillagers(villagers, elapsedSec) {
    if (!this.build || villagers == null) return;
    if (this.manualAtSec != null && elapsedSec - this.manualAtSec < 20) return;
    let target = 0;
    this.build.steps.forEach((s, i) => {
      if (s.villagers != null && s.villagers <= villagers) target = i;
    });
    this.offset = target - this.autoIndex(elapsedSec);
    this.synced = true;
  }

  view(elapsedSec) {
    const i = this.index(elapsedSec);
    if (i < 0) return null;
    const steps = this.build.steps;
    const nextAt = i + 1 < steps.length ? this.triggers[i + 1] : null;
    return {
      name: this.build.name,
      author: this.build.author,
      source: this.build.source,
      index: i,
      total: steps.length,
      step: steps[i],
      next: steps[i + 1] || null,
      upcoming: steps.slice(i + 1, i + 3),
      nextInSec: nextAt != null && this.offset === 0 && !this.synced ? Math.max(0, nextAt - elapsedSec) : null,
      // Ekran okuma açıkken sonraki adım köylü sayısıyla gelir.
      nextAtVillagers: this.synced ? steps[i + 1]?.villagers ?? null : null,
      synced: Boolean(this.synced),
      manual: this.offset !== 0 && !this.synced,
    };
  }
}

// Rakip/oyuncu analizinden maç içi zamanlı uyarılar üretir. Sadece maç öncesi
// halka açık veriye dayanır; maç içinde rakip hakkında gizli bilgi kullanılmaz.
function buildAlerts(scouting) {
  const alerts = [];
  if (!scouting) return alerts;
  const early = scouting.enemies.filter((c) => c.insights.some((i) => i.level === 'danger' && /Erken|erken bitirmeyi/.test(i.text)));
  if (early.length) {
    const names = early.map((c) => `${c.name} (${c.civTr})`).join(', ');
    alerts.push({ at: 3 * 60, level: 'danger', text: `${names} erken baskıyı seviyor. Feodal'e çıkarken mızrakçı/kule planın hazır olsun.`, short: 'Erken baskı gelebilir: mızrakçı/kule hazır' });
    alerts.push({ at: 7 * 60, level: 'danger', text: `Erken baskı penceresindesin: ${names}. Köylüleri merkeze yakın tut, gözcü gönder.`, short: 'Baskın riski: köylüleri koru' });
  }
  const threat = scouting.enemies.find((c) => c.mainThreat);
  if (threat) {
    alerts.push({ at: 10 * 60, level: 'info', text: `Ana tehdit ${threat.name} (${threat.civTr}). Takımca ona odaklanın, tek tek girmeyin.`, short: `Ana tehdit: ${threat.name}` });
  }
  const weakLate = scouting.enemies.filter((c) => c.insights.some((i) => /Uzayan maçlarda zayıflıyor|uzayınca düşüyor/.test(i.text)));
  if (weakLate.length) {
    alerts.push({ at: 20 * 60, level: 'chance', text: `${weakLate.map((c) => c.name).join(', ')} uzun maçlarda zayıflıyor. Riskli savaş yerine ekonomiyi büyüt, oyunu uzat.`, short: 'Rakip uzun maçta zayıf: oyunu uzat' });
  }
  return alerts.sort((a, b) => a.at - b.at);
}

class Coach {
  constructor() {
    this.reset();
  }

  reset() {
    this.startedAt = null;
    this.runner = new BuildRunner(null);
    this.alerts = [];
  }

  start(startedAt, build, scouting) {
    this.startedAt = startedAt;
    this.runner = new BuildRunner(build);
    this.alerts = buildAlerts(scouting);
  }

  // Sonradan gelen zamanlı uyarılar (ör. YZ oyun planı). Her uyarı kendi "fired" bayrağını taşır.
  addAlerts(list) {
    this.alerts.push(...list);
  }

  setBuild(build) {
    this.runner = new BuildRunner(build);
  }

  // Aynı adımlara sahip build'in (ör. Türkçeleştirilmiş notlar) adım konumunu koruyarak değiştirir.
  replaceBuild(build) {
    if (this.runner.build && build && build.steps.length === this.runner.build.steps.length) this.runner.build = build;
    else this.setBuild(build);
  }

  // Uyarıları tetiklemeden güncel build görünümü.
  buildView(now = Date.now()) {
    return this.runner.view(this.elapsed(now));
  }

  elapsed(now = Date.now()) {
    return this.startedAt ? Math.max(0, Math.floor((now - this.startedAt) / 1000)) : 0;
  }

  // Oyun süresini elle düzeltmek için (ör. oyun duraklatıldıysa).
  adjustClock(deltaSec) {
    if (this.startedAt) this.startedAt -= deltaSec * 1000;
  }

  shiftStep(delta, now = Date.now()) {
    this.runner.shift(delta, this.elapsed(now));
  }

  observeVillagers(villagers, now = Date.now()) {
    this.runner.syncVillagers(villagers, this.elapsed(now));
  }

  currentStep(now = Date.now()) {
    return this.runner.view(this.elapsed(now))?.step || null;
  }

  // Güncel durum + bu tikte zamanı gelen yeni uyarılar.
  tick(now = Date.now()) {
    const elapsed = this.elapsed(now);
    const due = [];
    for (const a of this.alerts) {
      // Uygulama maç ortasında açıldıysa ya da uyarı geç eklendiyse çok eski olanları atla.
      if (!a.fired && elapsed >= a.at) {
        a.fired = true;
        if (elapsed - a.at < 60) due.push(a);
      }
    }
    return { elapsed, build: this.runner.view(elapsed), due };
  }
}

// Yükleme ekranında rakipler için tek satırlık etiketler: "KEYI: ülke uzmanı, formda".
function enemyLabels(scouting) {
  if (!scouting) return [];
  return scouting.enemies.map((c) => {
    const tags = [];
    if (c.mainThreat) tags.push('ana tehdit');
    for (const i of c.insights) {
      if (i.level !== 'danger') continue;
      if (/Erken|erken bitirmeyi/.test(i.text)) tags.push('erken baskıcı');
      else if (/uzmanı/.test(i.text)) tags.push('ülke uzmanı');
      else if (/Formda/.test(i.text)) tags.push('formda');
      else if (/Uzun maçlarda güçlü/.test(i.text)) tags.push('geç oyunda güçlü');
    }
    const uniq = [...new Set(tags)];
    return uniq.length ? { key: `enemy-${c.profileId}`, level: 'danger', text: `${c.name}: ${uniq.join(', ')}` } : null;
  }).filter(Boolean);
}

module.exports = { Coach, BuildRunner, stepTriggers, buildAlerts, enemyLabels, VILLAGER_TRAIN_SEC };
