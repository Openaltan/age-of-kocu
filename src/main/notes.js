'use strict';

// Overlay'deki sade not panosu. İki tür not var:
//  - durum notları: her turda yeniden hesaplanır, koşul sürdükçe görünür ("Ev kur (19/20)")
//  - süreli notlar: belirli bir süre görünür (plan hatırlatması, YZ riski, takım çağrısı)
// Aynı anahtar tek not olarak görünür; tehlike notları üstte.

// cmd: yönet modundaki koç komutları; tehlikeden sonra, bilgiden önce ve kendi sıralarıyla.
const ORDER = { danger: 0, cmd: 1, info: 2, chance: 3 };
const MAX_NOTES = 8;

class NoteBoard {
  constructor() {
    this.clear();
  }

  clear() {
    this.state = [];
    this.timed = new Map(); // key -> { key, level, text, until }
  }

  setState(list) {
    this.state = list;
  }

  push(key, level, text, ttlSec, now = Date.now()) {
    this.timed.set(key, { key, level, text, until: now + ttlSec * 1000 });
  }

  remove(key) {
    this.timed.delete(key);
  }

  // Durum değişince bayatlayan süreli notları toplu silmek için (ör. savaş başlayınca ekonomi notları).
  removeWhere(pred) {
    for (const [k, n] of this.timed) if (pred(n)) this.timed.delete(k);
  }

  list(now = Date.now()) {
    for (const [k, n] of this.timed) if (n.until <= now) this.timed.delete(k);
    const byKey = new Map();
    for (const n of [...this.state, ...this.timed.values()]) if (!byKey.has(n.key)) byKey.set(n.key, { key: n.key, level: n.level, text: n.text });
    // Aynı seviyede anahtar sırası korunur (komutlar cmd-0, cmd-1… sırasıyla).
    const rank = (n) => ORDER[n.level] ?? 2;
    return [...byKey.values()]
      .sort((a, b) => rank(a) - rank(b) || (a.level === 'cmd' ? a.key.localeCompare(b.key) : 0))
      .slice(0, MAX_NOTES);
  }
}

module.exports = { NoteBoard };
