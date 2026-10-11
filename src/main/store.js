'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  profileId: null, // log'dan otomatik bulunur; elle de girilebilir
  overlayEnabled: true,
  overlaySide: 'right',
  buildByCiv: {}, // { zhu_xis_legacy: 'buildId' | 'auto' } — auto: koç rakiplere göre seçer
  learnedCivCodes: {}, // { 'byzantine_ha_mac': 'macedonian_dynasty' }
  learnedMapNames: {}, // oyunun Türkçe harita adı -> AoE4World adı { 'Saklı Ormanlar': 'Flankwoods' }
  screenReadingEnabled: true,
  hudRegions: null, // { width, height, fields: { food: {x,y,w,h}, ... } } fiziksel piksel
  aiProvider: 'gemini', // gemini (ücretsiz katman) | claude
  geminiKeyEnc: null, // Gemini API anahtarı, safeStorage ile şifreli (base64)
  aiKeyEnc: null, // Claude API anahtarı, safeStorage ile şifreli (base64)
  aiPrematch: true, // maç öncesi YZ oyun planı
  aiLive: true, // maç içi periyodik YZ değerlendirmesi
  aiVision: true, // değerlendirmede ekran görüntüsü gönder
  aiLiveIntervalMin: 3,
  coachMode: 'normal', // normal: uyarı ve öneri · yonet: koç her an sıralı komut verir (oyuncu uygular)
  aiReport: true, // maç sonu YZ raporu
  aiResearch: true, // maç öncesi internetten harita/meta araştırması (Gemini + Google Arama)
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
    this.lastWrite = null; // { file, at, ok, error }
  }

  updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this.write(this.settingsPath, this.settings);
    return this.settings;
  }

  // Aynı matchId tekrar gelirse (sonuç satırları, AoE4World eşleşmesi) kaydı günceller.
  saveMatch(record) {
    const i = this.matches.findIndex((m) => m.matchId && m.matchId === record.matchId);
    if (i >= 0) this.matches[i] = { ...this.matches[i], ...record };
    else this.matches.unshift(record);
    this.matches = this.matches.slice(0, 500);
    this.write(this.matchesPath, this.matches);
  }

  // Yazma hatası akışı kırmasın (maç sonu kaydı, analiz yine çalışsın) ama günlüğe ve panele düşsün.
  write(file, data) {
    try {
      writeJson(file, data);
      this.lastWrite = { file: path.basename(file), at: Date.now(), ok: true };
    } catch (err) {
      this.lastWrite = { file: path.basename(file), at: Date.now(), ok: false, error: err.message };
      console.error(`kayıt yazılamadı (${file}):`, err.message);
    }
  }
}

// Okunamayan dosya sessizce varsayılana dönmesin: aksi halde bir sonraki kayıt anahtarı ve
// kalibrasyonu silerdi. Önce son sağlam yedeğe (.bak) bakılır, bozuk dosya saklanır.
function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`okunamadı (${file}):`, err.message);
    try {
      fs.copyFileSync(file, `${file}.bozuk-${Date.now()}`);
    } catch {
      // kopyalanamazsa da devam
    }
    try {
      const data = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
      console.warn(`yedekten yüklendi: ${file}.bak`);
      return data;
    } catch {
      return fallback;
    }
  }
}

// Yarım yazılmış dosya bırakmamak için önce geçici dosyaya yazıp taşırız; sağlam son hali .bak'ta durur.
function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  const text = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  fs.writeFileSync(`${file}.bak`, text);
}

module.exports = { Store };
