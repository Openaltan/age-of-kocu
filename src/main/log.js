'use strict';

// Kalıcı günlük: userData/logs/kocu.log. Paketlenmiş uygulamada konsol çıktısı hiçbir yere gitmediği
// için "koç sustu", "kayıt yazılmadı" gibi sorunlar ancak bu dosyadan anlaşılır. 2 MB'ı geçince
// bir önceki dosya kocu.old.log olur. API anahtarı gibi gizli bilgi buraya yazılmaz.

const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX_BYTES = 2 * 1024 * 1024;
let file = null;

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function write(level, args) {
  if (!file) return;
  const text = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : util.inspect(a, { depth: 4, breakLength: 200 }))).join(' ');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file.replace(/\.log$/, '.old.log'));
    fs.appendFileSync(file, `${stamp()} [${level}] ${text}\n`);
  } catch {
    // günlük yazılamazsa uygulama çalışmaya devam etmeli
  }
}

// console.log/warn/error'u da dosyaya yönlendirir; mevcut "console.warn('...')" çağrıları günlüğe düşer.
function init(dir) {
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'kocu.log');
  for (const [method, level] of [['log', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const orig = console[method].bind(console);
    console[method] = (...args) => {
      orig(...args);
      write(level, args);
    };
  }
  return file;
}

const log = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
  path: () => file,
};

module.exports = { init, log, stamp };
