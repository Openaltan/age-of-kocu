'use strict';

const fs = require('fs');
const path = require('path');

// aoe4guides.com'un açık API'si. Liste uç noktaları ana alan adından değil bu adresten sunuluyor
// ve yanıtların önbelleklenmesi isteniyor; bu yüzden ülke başına sonuçları diske yazıyoruz.
const API = 'https://aoe4-guides-api-7h2vti5ckq-ey.a.run.app';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BUILDS = 15;

class BuildLibrary {
  // customFile: koçun oyuncuya özel yazdığı başlangıçlar (Koça Sor'dan eklenir), ülke koduna göre.
  constructor(cacheDir, customFile = null) {
    this.cacheDir = cacheDir;
    this.customFile = customFile;
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  // v2: açıklama alanı eklendi (eski önbellekte yok).
  cacheFile(guideCode) {
    return path.join(this.cacheDir, `builds-v2-${guideCode}.json`);
  }

  readCustoms() {
    if (!this.customFile) return [];
    try {
      return JSON.parse(fs.readFileSync(this.customFile, 'utf8'));
    } catch {
      return [];
    }
  }

  customs(guideCode) {
    return this.readCustoms().filter((b) => b.guide === guideCode);
  }

  // Özel başlangıç ekler (aynı adla varsa yerine geçer); eklenen build'i döndürür.
  addCustom(guideCode, build) {
    const all = this.readCustoms().filter((b) => !(b.guide === guideCode && b.name === build.name));
    const saved = { ...build, guide: guideCode, id: build.id || `ozel-${Date.now()}`, custom: true, createdAt: Date.now() };
    fs.writeFileSync(this.customFile, JSON.stringify([saved, ...all].slice(0, 50)));
    return saved;
  }

  removeCustom(id) {
    fs.writeFileSync(this.customFile, JSON.stringify(this.readCustoms().filter((b) => b.id !== id)));
  }

  readCache(guideCode) {
    try {
      return JSON.parse(fs.readFileSync(this.cacheFile(guideCode), 'utf8'));
    } catch {
      return null;
    }
  }

  // Ülkenin build'lerini döndürür. Önbellek tazeyse ağa çıkmaz; ağ hatasında eski önbelleğe düşer.
  // Özel başlangıçlar listenin başında.
  async list(guideCode, opts = {}) {
    const builds = await this.listRemote(guideCode, opts);
    return [...this.customs(guideCode), ...builds];
  }

  async listRemote(guideCode, { refresh = false } = {}) {
    const cached = this.readCache(guideCode);
    if (cached && !refresh && Date.now() - cached.at < CACHE_TTL_MS) return cached.builds;
    try {
      const res = await fetch(`${API}/builds?civ=${guideCode}&orderBy=score&overlay=true`, {
        headers: { Accept: 'application/json', 'User-Agent': 'AgeOfKocu/0.1' },
      });
      if (!res.ok) throw new Error(`aoe4guides ${res.status}`);
      const raw = await res.json();
      const builds = raw.slice(0, MAX_BUILDS).map(normalize);
      fs.writeFileSync(this.cacheFile(guideCode), JSON.stringify({ at: Date.now(), builds }));
      return builds;
    } catch (err) {
      if (cached) return cached.builds;
      throw err;
    }
  }

  // Seçilen build; seçim yoksa güncel sezonun en yüksek puanlısı.
  async get(guideCode, buildId) {
    const builds = await this.list(guideCode);
    return builds.find((b) => b.id === buildId) || currentSeasonBuilds(builds)[0] || builds[0] || null;
  }
}

// "Season 13" -> 13
function seasonNumber(b) {
  const m = /(\d+)/.exec(String(b?.season || ''));
  return m ? Number(m[1]) : null;
}

// Güncel (listedeki en yeni) ve bir önceki sezonun build'leri; eski sezonlar meta dışı kalmış olabilir.
// Sezonu yazılmamış build'ler tutulur. Hepsi eskiyse liste olduğu gibi döner.
function currentSeasonBuilds(builds) {
  const seasons = builds.map(seasonNumber).filter((n) => n != null);
  if (!seasons.length) return builds;
  const latest = Math.max(...seasons);
  const fresh = builds.filter((b) => seasonNumber(b) == null || seasonNumber(b) >= latest - 1);
  return fresh.length ? fresh : builds;
}

function idFromSource(source) {
  const m = /\/builds\/([^/?#]+)/.exec(source || '');
  return m ? m[1] : source;
}

// Overlay biçimini koçun kullandığı sade yapıya çevirir. Boş adımlar atılır.
function normalize(b) {
  const steps = [];
  for (const s of b.build_order || []) {
    const r = s.resources || {};
    const notes = (s.notes || []).filter((n) => n && n.trim());
    const hasRes = ['food', 'wood', 'gold', 'stone'].some((k) => r[k] > 0);
    if (!notes.length && !hasRes && !(s.villager_count > 0)) continue;
    steps.push({
      age: s.age > 0 ? s.age : null,
      villagers: s.villager_count > 0 ? s.villager_count : null,
      time: parseTime(s.time),
      food: r.food > 0 ? r.food : 0,
      wood: r.wood > 0 ? r.wood : 0,
      gold: r.gold > 0 ? r.gold : 0,
      stone: r.stone > 0 ? r.stone : 0,
      builder: r.builder > 0 ? r.builder : 0,
      notes,
    });
  }
  return {
    id: idFromSource(b.source),
    name: b.name,
    author: b.author,
    strategy: b.strategy || '',
    season: b.season || '',
    // Yazarın kısa açıklaması (HTML'siz, kısaltılmış; çoğunlukla İngilizce).
    description: String(b.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240),
    map: b.map || null,
    source: b.source,
    steps,
  };
}

function parseTime(t) {
  const m = /^(\d+):(\d{2})$/.exec(String(t || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

module.exports = { BuildLibrary, normalize, parseTime, currentSeasonBuilds, seasonNumber };
