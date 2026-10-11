'use strict';

const fs = require('fs');
const path = require('path');
const { createWorker, PSM } = require('tesseract.js');

// Pakete gömülü İngilizce modeli tesseract.js'in önbellek klasörüne "eng.traineddata" adıyla
// koyarız; tesseract.js önbellekten okuyunca gzip'i kendisi açar ve indirmeye hiç kalkmaz.
// (Doğrudan langPath vermek Electron'da asılı kalıyor: yerel yolu URL sanıp indirmeye çalışıyor.)
function prepareModel(cacheDir) {
  const target = path.join(cacheDir, 'eng.traineddata');
  if (fs.existsSync(target)) return;
  const dir = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(target, fs.readFileSync(path.join(dir, '4.0.0_best_int', 'eng.traineddata.gz')));
}

// Tek satırlık sayı okuyucu ("1250", "64/80"). Aynı anda tek istek işler.
class NumberReader {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
  }

  async init() {
    prepareModel(this.cacheDir);
    this.worker = await createWorker('eng', 1, { cachePath: this.cacheDir, cacheMethod: 'readOnly' });
    await this.worker.setParameters({
      tessedit_char_whitelist: '0123456789/',
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
    });
  }

  // png: Buffer. Dönen: { text, confidence }
  async read(png) {
    const { data } = await this.worker.recognize(png);
    return { text: data.text.replace(/\s+/g, ''), confidence: data.confidence };
  }

  async close() {
    await this.worker?.terminate();
  }
}

module.exports = { NumberReader };
