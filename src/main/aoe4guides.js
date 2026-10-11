'use strict';

const fs = require('fs');
const path = require('path');

// aoe4guides.com'un açık API'si. Liste uç noktaları ana alan adından değil bu adresten sunuluyor
// ve yanıtların önbelleklenmesi isteniyor; bu yüzden ülke başına sonuçları diske yazıyoruz.
const API = 'https://aoe4-guides-api-7h2vti5ckq-ey.a.run.app';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BUILDS = 15;

class BuildLibrary {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  cacheFile(guideCode) {
    return path.join(this.cacheDir, `builds-${guideCode}.json`);
  }

  readCache(guideCode) {
    try {
      return JSON.parse(fs.readFileSync(this.cacheFile(guideCode), 'utf8'));
    } catch {
      return null;
    }
  }

  // Ülkenin build'lerini döndürür. Önbellek tazeyse ağa çıkmaz; ağ hatasında eski önbelleğe düşer.
  async list(guideCode, { refresh = false } = {}) {
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

  async get(guideCode, buildId) {
    const builds = await this.list(guideCode);
    return builds.find((b) => b.id === buildId) || builds[0] || null;
  }
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
    source: b.source,
    steps,
  };
}

function parseTime(t) {
  const m = /^(\d+):(\d{2})$/.exec(String(t || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

module.exports = { BuildLibrary, normalize, parseTime };
