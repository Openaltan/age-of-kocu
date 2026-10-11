'use strict';

// Üs defteri: koçun maç boyunca kendi üssün hakkında öğrendikleri. Her YZ değerlendirmesi tek bir
// ekran görüntüsüne baktığı için "şu an görmüyorum" ile "yok" karışmasın diye görülenler birikir.
// Kaynaklar: YZ'nin kendi ekranında gördükleri (sadece ekran oyuncunun kendi üssünü gösteriyorsa)
// ve build order'da geçilmiş adımlardaki binalar/teknolojiler.

const AGE_NAMES = { 1: 'Karanlık', 2: 'Feodal', 3: 'Kale', 4: 'İmparatorluk' };

// "@building_military/archery-range.webp@" -> "archery range", "@age/age_2.webp@" -> "Feodal Çağı"
function tokenName(token) {
  const age = /^age\/age_(\d)/.exec(token);
  if (age && AGE_NAMES[age[1]]) return `${AGE_NAMES[age[1]]} Çağı`;
  const file = token.split('/').pop().replace(/\.webp$/, '');
  return file.replace(/[-_]+/g, ' ').replace(/\s+\d+$/, '').trim();
}

// Build notunu YZ'nin okuyacağı düz metne çevirir: ikonlar [ad] olur.
function noteText(note) {
  return String(note)
    .replace(/@([^@]+)@/g, (_m, t) => `[${tokenName(t)}]`)
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build'in ilk (index+1) adımındaki bina ve teknoloji ikonları: bu adımlara gelindiyse yapılmış olmalı.
function buildExpectations(build, index) {
  const buildings = new Set();
  const techs = new Set();
  let age = 1;
  if (!build) return { buildings: [], techs: [], age };
  for (const step of build.steps.slice(0, index + 1)) {
    for (const note of step.notes) {
      for (const [, token] of note.matchAll(/@([^@]+)@/g)) {
        const cat = token.split('/')[0];
        if (/^(building|landmark)/.test(cat)) buildings.add(tokenName(token));
        else if (/^technology/.test(cat)) techs.add(tokenName(token));
        else if (cat === 'age') {
          const n = Number(/age_(\d)/.exec(token)?.[1]);
          if (n > age) age = n;
        }
      }
    }
  }
  return { buildings: [...buildings], techs: [...techs], age };
}

class BaseLedger {
  constructor() {
    this.reset();
  }

  reset() {
    this.age = null;
    this.buildings = new Map(); // ad (küçük harf) -> { ad, at }
    this.techs = new Map();
    this.army = null; // { at, units }
    this.screens = { benim: 0, takim: 0, rakip: 0, belirsiz: 0 };
  }

  setAge(age) {
    if (age >= 1 && age <= 4 && (!this.age || age > this.age)) this.age = age;
  }

  // gozlem: YZ'nin canlı değerlendirmedeki gözlem nesnesi; at: "12:30" gibi oyun süresi.
  observe(gozlem, at) {
    if (!gozlem) return;
    const owner = gozlem.ekranKimin in this.screens ? gozlem.ekranKimin : 'belirsiz';
    this.screens[owner]++;
    // Çağ, oyuncu listesinden her ekranda okunabilir; bina ve ordu sadece kendi üssündeyken.
    if (gozlem.cag) this.setAge(gozlem.cag);
    if (owner !== 'benim') return;
    const add = (map, list) => {
      for (const raw of list || []) {
        const name = String(raw).trim();
        if (name && !map.has(name.toLowerCase())) map.set(name.toLowerCase(), { ad: name, at });
      }
    };
    add(this.buildings, gozlem.binalar);
    add(this.techs, gozlem.gelistirmeler);
    if (gozlem.ordu?.length) this.army = { at, units: gozlem.ordu.slice(0, 8) };
  }

  context(build, buildIndex) {
    const exp = buildExpectations(build, buildIndex ?? -1);
    const age = Math.max(this.age || 1, exp.age);
    return {
      cag: `${AGE_NAMES[age]} Çağı`,
      gorulenBinalar: [...this.buildings.values()].map((b) => `${b.ad} (${b.at})`),
      alinanGelistirmeler: [...this.techs.values()].map((b) => b.ad),
      sonGorulenOrdu: this.army ? { sure: this.army.at, birimler: this.army.units } : null,
      builddenYapilmisOlmali: exp.buildings,
      builddenAlinmisOlmali: exp.techs,
    };
  }
}

module.exports = { BaseLedger, noteText, tokenName, buildExpectations, AGE_NAMES };
