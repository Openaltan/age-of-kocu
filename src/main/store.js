'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  profileId: null, // log'dan otomatik bulunur; elle de girilebilir
  overlayEnabled: true,
  overlaySide: 'right',
  buildByCiv: {}, // { zhu_xis_legacy: 'buildId' }
  learnedCivCodes: {}, // { 'byzantine_ha_mac': 'macedonian_dynasty' }
  screenReadingEnabled: true,
  hudRegions: null, // { width, height, fields: { food: {x,y,w,h}, ... } } fiziksel piksel
  aiProvider: 'gemini', // gemini (ücretsiz katman) | claude
  geminiKeyEnc: null, // Gemini API anahtarı, safeStorage ile şifreli (base64)
  aiKeyEnc: null, // Claude API anahtarı, safeStorage ile şifreli (base64)
  aiPrematch: true, // maç öncesi YZ oyun planı
  aiLive: true, // maç içi periyodik YZ değerlendirmesi
  aiVision: true, // değerlendirmede ekran görüntüsü gönder
  aiLiveIntervalMin: 3,
  aiReport: true, // maç sonu YZ raporu
  aiTranslate: true, // build notlarını Türkçeleştir
  overlayMode: 'simple', // simple: sol üstte sadece notlar · detailed: build paneli, kartlar, YZ paneli
  teamSyncEnabled: true, // maçta takım arkadaşlarıyla otomatik bağlan
  teamCode: null, // isteğe bağlı gizli kod; boşsa otomatik mod
  teamServerUrl: null, // boşsa uygulamadaki varsayılan takım sunucusu
};

// Basit JSON deposu: ayarlar ve oynanan maçlar (maç sonrası analiz ve öğrenme için).
class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.settingsPath = path.join(dir, 'settings.json');
    this.matchesPath = path.join(dir, 'matches.json');
    this.settings = { ...DEFAULT_SETTINGS, ...readJson(this.settingsPath, {}) };
    this.matches = readJson(this.matchesPath, []);
  }

  updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    writeJson(this.settingsPath, this.settings);
    return this.settings;
  }

  // Aynı matchId tekrar gelirse (sonuç satırları, AoE4World eşleşmesi) kaydı günceller.
  saveMatch(record) {
    const i = this.matches.findIndex((m) => m.matchId && m.matchId === record.matchId);
    if (i >= 0) this.matches[i] = { ...this.matches[i], ...record };
    else this.matches.unshift(record);
    this.matches = this.matches.slice(0, 500);
    writeJson(this.matchesPath, this.matches);
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Yarım yazılmış dosya bırakmamak için önce geçici dosyaya yazıp taşırız.
function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { Store };
