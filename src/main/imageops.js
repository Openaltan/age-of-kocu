'use strict';

// OCR öncesi saf JS görüntü işlemleri. Görüntü: { width, height, data } ve data 4 kanallı
// (Electron nativeImage.toBitmap() BGRA verir; gri tonda kanal sırası önemsiz sayılacak kadar
// yakın olduğundan R ve B'yi aynı ağırlıkla alıyoruz).

function crop(img, x, y, w, h) {
  x = Math.max(0, Math.round(x));
  y = Math.max(0, Math.round(y));
  w = Math.max(1, Math.min(img.width - x, Math.round(w)));
  h = Math.max(1, Math.min(img.height - y, Math.round(h)));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const src = ((y + row) * img.width + x) * 4;
    out.set(img.data.subarray(src, src + w * 4), row * w * 4);
  }
  return { width: w, height: h, data: out };
}

// Parlaklık (0-255) dizisi.
function gray(img) {
  const n = img.width * img.height;
  const g = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    g[i] = (img.data[o] * 0.3 + img.data[o + 1] * 0.59 + img.data[o + 2] * 0.11) | 0;
  }
  return { width: img.width, height: img.height, g };
}

// Çift doğrusal büyütme (küçük HUD rakamları OCR için 3-4 kat büyütülmeli).
function upscale({ width, height, g }, k) {
  const W = width * k;
  const H = height * k;
  const out = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(height - 1, (y + 0.5) / k - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = Math.max(0, sy - y0);
    for (let x = 0; x < W; x++) {
      const sx = Math.min(width - 1, (x + 0.5) / k - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = Math.max(0, sx - x0);
      const top = g[y0 * width + x0] * (1 - fx) + g[y0 * width + x1] * fx;
      const bot = g[y1 * width + x0] * (1 - fx) + g[y1 * width + x1] * fx;
      out[y * W + x] = top * (1 - fy) + bot * fy;
    }
  }
  return { width: W, height: H, g: out };
}

// Otsu eşiği: histogramı iki sınıfa en iyi ayıran parlaklık.
function otsu(g) {
  const hist = new Array(256).fill(0);
  for (const v of g) hist[v] += 1;
  const total = g.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      thr = i;
    }
  }
  return thr;
}

// Açık renkli HUD yazısını beyaz zemin üzerinde siyah metne çevirir ve kenar boşluğu ekler.
// Çıktı RGBA (Electron nativeImage.createFromBitmap için BGRA ile aynı, gri olduğundan).
function binarizeForOcr(grayImg, pad = 12) {
  const thr = otsu(grayImg.g);
  const W = grayImg.width + pad * 2;
  const H = grayImg.height + pad * 2;
  const out = new Uint8ClampedArray(W * H * 4).fill(255);
  let ink = 0;
  for (let y = 0; y < grayImg.height; y++) {
    for (let x = 0; x < grayImg.width; x++) {
      if (grayImg.g[y * grayImg.width + x] > thr) {
        const o = ((y + pad) * W + x + pad) * 4;
        out[o] = out[o + 1] = out[o + 2] = 0;
        ink += 1;
      }
    }
  }
  return { width: W, height: H, data: out, inkRatio: ink / (grayImg.width * grayImg.height) };
}

function prepareForOcr(img, scale = 3) {
  return binarizeForOcr(upscale(gray(img), scale));
}

module.exports = { crop, gray, upscale, otsu, binarizeForOcr, prepareForOcr };
