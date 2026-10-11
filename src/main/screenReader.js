'use strict';

const { desktopCapturer, screen, nativeImage } = require('electron');
const { prepareForOcr } = require('./imageops');
const { NumberReader } = require('./ocr');
const { FIELDS, parseField } = require('./hud');

const OCR_SCALE = 3;

// Birincil ekranın tam çözünürlüklü görüntüsü (fiziksel piksel).
async function captureScreen() {
  const d = screen.getPrimaryDisplay();
  const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = sources.find((s) => s.display_id === String(d.id)) || sources[0];
  if (!src) throw new Error('Ekran yakalanamadı');
  return src.thumbnail;
}

// Bir bölgeyi OCR'a hazır PNG'ye çevirir. inkRatio: yazı sayılan piksel oranı.
function regionPng(image, r) {
  const piece = image.crop({ x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.w)), height: Math.max(1, Math.round(r.h)) });
  const { width, height } = piece.getSize();
  const p = prepareForOcr({ width, height, data: piece.toBitmap() }, OCR_SCALE);
  return { png: nativeImage.createFromBitmap(Buffer.from(p.data.buffer), { width: p.width, height: p.height }).toPNG(), inkRatio: p.inkRatio };
}

// Neredeyse boş ya da tamamen dolu bölgede okunacak rakam yoktur; OCR'a göndermeyiz.
const MIN_INK = 0.01;
const MAX_INK = 0.6;

// Maç sırasında saniyede bir ekranı okur. regions: { fieldKey: {x,y,w,h} } (fiziksel piksel).
class ScreenReader {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    this.reader = new NumberReader(cacheDir);
    this.ready = null;
    this.timer = null;
    this.busy = false;
  }

  init() {
    this.ready ||= this.reader.init();
    return this.ready;
  }

  async readImage(image, regions, { withPreview = false } = {}) {
    await this.init();
    const out = {};
    for (const f of FIELDS) {
      const r = regions[f.key];
      if (!r) continue;
      const { png, inkRatio } = regionPng(image, r);
      const blank = inkRatio < MIN_INK || inkRatio > MAX_INK;
      const { text, confidence } = blank ? { text: '', confidence: 0 } : await this.reader.read(png);
      out[f.key] = { text, confidence: Math.round(confidence), value: parseField(f.kind, text, confidence) };
      if (withPreview) out[f.key].preview = `data:image/png;base64,${png.toString('base64')}`;
    }
    return out;
  }

  // onFrame(image): her yakalanan karede OCR'dan önce (mini harita gibi hızlı renk analizleri için).
  // onReading({ fieldKey: value|null }) her başarılı OCR turunda çağrılır.
  start(regions, { onFrame, onReading }, intervalMs = 1000) {
    this.stop();
    const loop = async () => {
      if (this.busy) {
        // Önceki tur bitmediyse bu turu atla. 20 sn'den uzun takıldıysa OCR'ı yeniden kur;
        // yoksa ekran okuma maçın geri kalanında bir daha çalışmaz.
        if (Date.now() - this.busySince < 20000) return;
        console.warn('ekran okuma takıldı; OCR yeniden kuruluyor');
        const old = this.reader;
        this.reader = new NumberReader(this.cacheDir);
        this.ready = null;
        old.close().catch(() => {});
      }
      this.busy = true;
      const turn = (this.busySince = Date.now());
      try {
        const img = await captureScreen();
        this.lastFrame = { image: img, at: Date.now() };
        onFrame?.(img);
        const res = await this.readImage(img, regions);
        onReading(Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.value])));
      } catch (err) {
        console.warn('ekran okuma:', err.message);
      } finally {
        if (this.busySince === turn) this.busy = false; // takılıp bırakılan eski tur dokunmasın
      }
    };
    this.timer = setInterval(loop, intervalMs);
    loop();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async close() {
    this.stop();
    await this.reader.close();
  }
}

// Bölgenin ham BGRA görüntüsü (minimap.js analizleri için).
function areaBitmap(image, r) {
  const size = image.getSize();
  const x = Math.max(0, Math.round(r.x));
  const y = Math.max(0, Math.round(r.y));
  const rect = { x, y, width: Math.max(1, Math.min(size.width - x, Math.round(r.w))), height: Math.max(1, Math.min(size.height - y, Math.round(r.h))) };
  const piece = image.crop(rect);
  const s = piece.getSize();
  return { width: s.width, height: s.height, data: piece.toBitmap(), image: piece };
}

module.exports = { ScreenReader, captureScreen, areaBitmap };
