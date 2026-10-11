'use strict';

// Mini harita ve oyuncu listesi (sağdaki "İsim | II. Çağ" satırları) için saf piksel analizi.
// Görüntü: { width, height, data } ve data BGRA (Electron nativeImage.toBitmap()).
//
// ADİL OYUN: sadece oyuncunun kendi ekranında o an gördüğü şey kullanılır. Mini haritada
// düşman birimi ancak senin ya da takımının görüş alanındaysa çizilir; oyun bunu zaten gösterir.

// ---------- Renk ----------

function hsv(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: mx ? d / mx : 0, v: mx / 255 };
}

function pixel(img, x, y) {
  const o = (y * img.width + x) * 4;
  return hsv(img.data[o + 2], img.data[o + 1], img.data[o]);
}

function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// AoE4 oyuncu renklerinin yaklaşık tonları; oyuncu listesi okunamazsa YZ'nin söylediği renk adından kullanılır.
const PALETTE = {
  'kırmızı': 3,
  turuncu: 28,
  'sarı': 57,
  'yeşil': 120,
  'camgöbeği': 180,
  mavi: 210,
  mor: 280,
  pembe: 320,
};

// Oyuncu rengi sayılacak piksel: canlı ve parlak. Arazi, sis, kamera çerçevesi ve gri ikonlar elenir.
const SAT_MIN = 0.5;
const VAL_MIN = 0.5;
// Altın madeni ikonları (ton ~40) sarı oyuncuya (~57) karışmasın diye dar tutulur.
const HUE_TOL = 9;

// ---------- Oyuncu listesi ----------

// Satırlar: yazı rengi (oyuncu rengi), rakip işareti (⚔) ve yazı genişliği (çağ değişince uzar).
const TEXT_S = 0.45;
const TEXT_V = 0.45;

function scoreboardRows(img) {
  const isText = (p) => p.s >= TEXT_S && p.v >= TEXT_V;
  const perRow = [];
  for (let y = 0; y < img.height; y++) {
    let c = 0;
    for (let x = 0; x < img.width; x++) if (isText(pixel(img, x, y))) c++;
    perRow.push(c);
  }
  // Yazılı piksel satırlarını 2 satırlık boşluklara kadar birleştirip bantlara ayır.
  const bands = [];
  let start = -1;
  let gap = 0;
  for (let y = 0; y <= img.height; y++) {
    const on = y < img.height && perRow[y] >= 2;
    if (on) {
      if (start < 0) start = y;
      gap = 0;
    } else if (start >= 0 && ++gap > 2) {
      const end = y - gap;
      if (end - start + 1 >= 6) bands.push([start, end]);
      start = -1;
      gap = 0;
    }
  }
  return bands.map(([y0, y1]) => bandInfo(img, y0, y1, isText)).filter(Boolean);
}

function bandInfo(img, y0, y1, isText) {
  const h = y1 - y0 + 1;
  const fill = [];
  for (let x = 0; x < img.width; x++) {
    let c = 0;
    for (let y = y0; y <= y1; y++) if (isText(pixel(img, x, y))) c++;
    fill.push(c);
  }
  // Sütun koşuları: 6+ boş sütunla ayrılan parçalar. Sağdaki dolu kare parça ülke bayrağıdır.
  const runs = [];
  let rs = -1;
  let empty = 0;
  for (let x = 0; x <= img.width; x++) {
    const on = x < img.width && fill[x] > 0;
    if (on) {
      if (rs < 0) rs = x;
      empty = 0;
    } else if (rs >= 0 && ++empty >= 6) {
      runs.push([rs, x - empty]);
      rs = -1;
      empty = 0;
    }
  }
  if (rs >= 0) runs.push([rs, img.width - 1]);
  const text = runs.filter(([a, b]) => {
    const w = b - a + 1;
    const mean = fill.slice(a, b + 1).reduce((s, v) => s + v, 0) / (w * h);
    return !(w <= h * 2.5 && mean >= 0.4);
  });
  if (!text.length) return null;

  const bins = new Array(90).fill(0);
  let n = 0;
  for (const [a, b] of text) {
    for (let x = a; x <= b; x++) {
      for (let y = y0; y <= y1; y++) {
        const p = pixel(img, x, y);
        if (isText(p)) {
          bins[Math.floor(p.h / 4) % 90]++;
          n++;
        }
      }
    }
  }
  if (n < 15) return null;
  const top = bins.indexOf(Math.max(...bins));
  // Komşu kutularla ağırlıklı ortalama ton.
  let sum = 0;
  let wsum = 0;
  for (const d of [-1, 0, 1]) {
    const i = (top + d + 90) % 90;
    sum += (top + d) * 4 * bins[i] + 2 * bins[i];
    wsum += bins[i];
  }
  const hue = ((sum / wsum) + 360) % 360;

  // Yazının sınırları: sadece canlı ve satır renginde pikseller (⚔ işareti soluk ve sarımsı).
  const strict = (p) => p.s >= 0.6 && p.v >= TEXT_V && hueDist(p.h, hue) <= 25;
  const cols = [];
  for (const [a, b] of text) {
    for (let x = a; x <= b; x++) {
      let c = 0;
      for (let y = y0; y <= y1; y++) if (strict(pixel(img, x, y))) c++;
      if (c >= 2) cols.push(x);
    }
  }
  if (!cols.length) return null;
  const x0 = cols[0];
  const x1 = cols[cols.length - 1];

  // ⚔ işareti: yazının hemen solunda açık renkli, soluk pikseller. Açık renkli zemin yanılmasın
  // diye daha soldaki aynı genişlikte şeritle karşılaştırılır.
  const pale = (xa, xb) => {
    let c = 0;
    for (let x = Math.max(0, xa); x < Math.max(0, xb); x++) {
      for (let y = y0; y <= y1; y++) {
        const p = pixel(img, x, y);
        if (p.v >= 0.5 && p.s < 0.6 && !strict(p)) c++;
      }
    }
    return c;
  };
  const icon = pale(x0 - Math.round(h * 1.6), x0 - 1);
  const ground = pale(x0 - Math.round(h * 3.6), x0 - Math.round(h * 2));
  return { y0, y1, x0, x1, width: x1 - x0 + 1, hue: Math.round(hue), enemy: icon >= h * 0.8 && icon >= ground * 2.5 };
}

// ---------- Mini harita ----------

const DIRS = ['kuzey', 'kuzeydoğu', 'doğu', 'güneydoğu', 'güney', 'güneybatı', 'batı', 'kuzeybatı'];
const DIRS_ABL = ['kuzeyden', 'kuzeydoğudan', 'doğudan', 'güneydoğudan', 'güneyden', 'güneybatıdan', 'batıdan', 'kuzeybatıdan'];

// Mini haritanın üstü kuzey kabul edilir (ekrandaki yönler).
function direction(from, to) {
  const dx = to.x - from.x;
  const dy = from.y - to.y;
  if (Math.hypot(dx, dy) < 0.5) return null;
  const a = (Math.atan2(dx, dy) * 180) / Math.PI;
  return Math.round(((a + 360) % 360) / 45) % 8;
}

const GRID = 24;
const STATIC_TAU = 30; // sn: bu kadar yerinde duran şey bina sayılır
const HOME_TAU = 180; // sn: oyuncunun yerleşik bölgesi
const STATIC_MIN = 0.6;
const HOME_MIN = 0.25;
const CELL_MIN_PX = 2;
const REF_AREA = 265 * 260; // ayar yapılan mini harita kesitinin alanı (1080p)
const ARMY_PX = 40; // REF_AREA'da ordu sayılan düşman pikseli
const MEMORY_SEC = 90;

// Mini haritayı saniyede bir izler; düşmanın üssüne/takım üslerine/baskın birliğine yaklaşmasını,
// sahadaki rakip ordularını ve kısa süre görünüp kaybolan düşmanları olay olarak verir.
class MinimapWatcher {
  constructor({ grid = GRID } = {}) {
    this.grid = grid;
    this.players = [];
    this.reset();
  }

  reset() {
    this.maps = new Map(); // key -> { stat: Float32Array, home: Float32Array }
    this.lastT = null;
    this.prevArmies = [];
    this.streak = new Map(); // olay anahtarı -> art arda görüldüğü kare sayısı
    this.sightings = []; // { t, kind, text }
  }

  // players: [{ key, name, role: 'me' | 'ally' | 'enemy', hue }]
  setPlayers(players) {
    this.players = players.filter((p) => p.hue != null);
    for (const p of this.players) if (!this.maps.has(p.key)) this.maps.set(p.key, null);
  }

  hasPlayers() {
    return this.players.some((p) => p.role === 'enemy') && this.players.some((p) => p.role !== 'enemy');
  }

  classify(p) {
    if (p.s < SAT_MIN || p.v < VAL_MIN) return null;
    let best = null;
    let bestD = HUE_TOL + 1;
    for (const pl of this.players) {
      const d = hueDist(p.h, pl.hue);
      if (d < bestD) {
        bestD = d;
        best = pl;
      }
    }
    return best;
  }

  // Dönen: { events: [{ key, kind, level, text, size }], clusters } — events bu karede geçerli olanlar.
  update(img, t) {
    const G = this.grid;
    const n = G * G;
    const counts = new Map(this.players.map((p) => [p.key, new Uint16Array(n)]));
    for (let y = 0; y < img.height; y++) {
      const cy = Math.min(G - 1, Math.floor((y * G) / img.height));
      for (let x = 0; x < img.width; x++) {
        const pl = this.classify(pixel(img, x, y));
        if (!pl) continue;
        const cx = Math.min(G - 1, Math.floor((x * G) / img.width));
        counts.get(pl.key)[cy * G + cx]++;
      }
    }
    const dt = this.lastT == null ? null : Math.max(0.2, Math.min(10, t - this.lastT));
    this.lastT = t;
    const units = new Map();
    for (const p of this.players) {
      const c = counts.get(p.key);
      let m = this.maps.get(p.key);
      const first = !m;
      if (first) {
        m = { stat: new Float32Array(n), home: new Float32Array(n) };
        this.maps.set(p.key, m);
      }
      const aS = dt == null ? 1 : 1 - Math.exp(-dt / STATIC_TAU);
      const aH = dt == null ? 1 : 1 - Math.exp(-dt / HOME_TAU);
      const u = new Uint16Array(n);
      for (let i = 0; i < n; i++) {
        const present = c[i] >= CELL_MIN_PX ? 1 : 0;
        // İlk karede görünen her şey yerleşik sayılır (maç ortasında açılınca hızlı öğrenme).
        const wasStatic = !first && m.stat[i] >= STATIC_MIN;
        m.stat[i] += aS * (present - m.stat[i]);
        m.home[i] += aH * (present - m.home[i]);
        if (present && !first && !wasStatic) u[i] = c[i];
      }
      units.set(p.key, u);
    }
    return this.detect(units, t, img.width * img.height);
  }

  homeCells(filter) {
    const cells = [];
    for (const p of this.players) {
      if (!filter(p)) continue;
      const m = this.maps.get(p.key);
      if (!m) continue;
      for (let i = 0; i < m.home.length; i++) if (m.home[i] >= HOME_MIN || m.stat[i] >= STATIC_MIN) cells.push(i);
    }
    return cells;
  }

  center(cells) {
    if (!cells.length) return null;
    const G = this.grid;
    let x = 0;
    let y = 0;
    for (const i of cells) {
      x += i % G;
      y += Math.floor(i / G);
    }
    return { x: x / cells.length, y: y / cells.length };
  }

  // Küme hücrelerinden hedef hücre kümesine en kısa Chebyshev uzaklığı.
  dist(cells, targets) {
    if (!targets.length) return Infinity;
    const G = this.grid;
    let best = Infinity;
    for (const a of cells) {
      for (const b of targets) {
        const d = Math.max(Math.abs((a % G) - (b % G)), Math.abs(Math.floor(a / G) - Math.floor(b / G)));
        if (d < best) best = d;
      }
    }
    return best;
  }

  clusters(grid) {
    const G = this.grid;
    const seen = new Uint8Array(grid.length);
    const out = [];
    for (let i = 0; i < grid.length; i++) {
      if (!grid[i] || seen[i]) continue;
      const cells = [];
      const stack = [i];
      seen[i] = 1;
      let px = 0;
      while (stack.length) {
        const c = stack.pop();
        cells.push(c);
        px += grid[c];
        const cx = c % G;
        const cy = Math.floor(c / G);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const x = cx + dx;
            const y = cy + dy;
            if (x < 0 || y < 0 || x >= G || y >= G) continue;
            const j = y * G + x;
            if (grid[j] && !seen[j]) {
              seen[j] = 1;
              stack.push(j);
            }
          }
        }
      }
      out.push({ cells, px, center: this.center(cells) });
    }
    return out;
  }

  sum(units, filter) {
    const n = this.grid * this.grid;
    const g = new Uint32Array(n);
    for (const p of this.players) {
      if (!filter(p)) continue;
      const u = units.get(p.key);
      for (let i = 0; i < n; i++) g[i] += u[i];
    }
    return g;
  }

  detect(units, t, area) {
    const scale = area / REF_AREA;
    const armyPx = Math.max(12, ARMY_PX * scale);
    const me = this.players.find((p) => p.role === 'me');
    const myHome = me ? this.homeCells((p) => p === me) : this.homeCells((p) => p.role !== 'enemy');
    const myCenter = this.center(myHome);
    const enemyHome = this.homeCells((p) => p.role === 'enemy');
    const allies = this.players.filter((p) => p.role === 'ally' && me);
    const enemies = this.clusters(this.sum(units, (p) => p.role === 'enemy'));
    const mine = me ? this.clusters(this.sum(units, (p) => p === me)).filter((c) => this.dist(c.cells, myHome) > 1) : [];

    const raw = [];
    const armies = [];
    for (const c of enemies) {
      const dir = myCenter && c.center ? direction(myCenter, c.center) : null;
      const big = c.px >= armyPx;
      if (myHome.length && this.dist(c.cells, myHome) <= 1) {
        // Kim olduğumuz bilinmiyorsa (YZ oyuncu listesini okuyamadı) bütün takım üsleri birlikte izlenir.
        const where = me ? (big ? 'Üssüne saldırı' : 'Üssünde düşman') : (big ? 'Takım üssüne saldırı' : 'Takım üssünde düşman');
        raw.push({ key: 'base', kind: 'base', level: 'danger', size: c.px, text: `${where}${dir != null ? ` · ${DIRS[dir]} tarafı` : ''}` });
        continue;
      }
      const ally = allies.find((a) => this.dist(c.cells, this.homeCells((p) => p === a)) <= 1);
      if (ally) {
        raw.push({ key: `ally-${ally.key}`, kind: 'ally', level: big ? 'danger' : 'info', size: c.px, text: `${ally.name} üssünde düşman` });
        continue;
      }
      const nearRaid = mine.find((m) => this.dist(c.cells, m.cells) <= 2);
      if (nearRaid && big) {
        const d = direction(nearRaid.center, c.center);
        raw.push({ key: 'raid', kind: 'raid', level: 'danger', size: c.px, text: `Birliğine ordu geliyor${d != null ? ` · ${DIRS_ABL[d]}` : ''}` });
        continue;
      }
      const inEnemyBase = this.dist(c.cells, enemyHome) <= 1;
      if (big) {
        armies.push(c);
        const prev = this.prevArmies.find((p) => Math.hypot(p.center.x - c.center.x, p.center.y - c.center.y) <= 3);
        const toMe = (pt) => (myCenter ? Math.hypot(pt.x - myCenter.x, pt.y - myCenter.y) : Infinity);
        const coming = prev && t - prev.t <= 12 && toMe(prev.center) - toMe(c.center) >= 1;
        if (coming) {
          raw.push({ key: 'incoming', kind: 'incoming', level: 'danger', size: c.px, text: `Ordu sana geliyor${dir != null ? ` · ${DIRS_ABL[dir]}` : ''}` });
        } else {
          raw.push({ key: 'army', kind: 'army', level: 'info', size: c.px, text: `${inEnemyBase ? 'Rakip ordusu üssünde' : 'Rakip ordusu sahada'}${dir != null && !inEnemyBase ? ` · ${DIRS[dir]}` : ''}` });
        }
      } else if (!inEnemyBase) {
        raw.push({ key: 'sighting', kind: 'sighting', level: 'info', size: c.px, text: `Düşman görüldü${dir != null ? ` · ${DIRS[dir]}` : ''}` });
      }
    }
    // Ordu konumlarını 12 sn tut: yaklaşma hesabı bir önceki görüşe göre.
    this.prevArmies = [...armies.map((c) => ({ center: c.center, t })), ...this.prevArmies.filter((p) => t - p.t <= 12)].slice(0, 8);

    // Aynı anahtardan en büyüğü; tek karelik kırpışmaları yutmak için 2 kare art arda görülmeli.
    const byKey = new Map();
    for (const e of raw) if (!byKey.has(e.key) || byKey.get(e.key).size < e.size) byKey.set(e.key, e);
    const events = [];
    for (const key of [...this.streak.keys()]) if (!byKey.has(key)) this.streak.delete(key);
    for (const [key, e] of byKey) {
      const s = (this.streak.get(key) || 0) + 1;
      this.streak.set(key, s);
      if (s >= 2) events.push(e);
      if (s === 2) this.sightings.push({ t, kind: e.kind, text: e.text });
    }
    this.sightings = this.sightings.filter((s) => t - s.t <= MEMORY_SEC);
    return { events, enemyClusters: enemies.length };
  }

  // YZ bağlamı için son 90 saniyede mini haritada görülenler.
  recent(t) {
    return this.sightings.filter((s) => t - s.t <= MEMORY_SEC).map((s) => ({ saniyeOnce: Math.round(t - s.t), ne: s.text }));
  }
}

module.exports = { hsv, hueDist, scoreboardRows, MinimapWatcher, PALETTE, DIRS, DIRS_ABL, direction };
