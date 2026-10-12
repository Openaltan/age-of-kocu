'use strict';

// AoE4 kayıt dosyası (.rec) ayrıştırıcısı. Biçim tersine mühendislikle çözüldü:
//
//   [76 bayt başlık "AOE4_RE..."] [Relic Chunky blokları: FOLDPOST, DATASDSC, FOLDINFO]
//   ardından kayıt akışı: { u32 tür, u32 uzunluk, gövde }*
//     tür 0 = tik: u8 bayrak, u32 tik no, u32 sağlama, u32 paket sayısı, paketler
//       paket: u32, u32, u32 uzunluk, komutlar
//         komut: u16 uzunluk, u8 komut türü, u8 oyuncu (0x80 bitli = oyunun otomatik kuyruğu), ...
//
// Komut türleri: 3 = birim üret, 16 = teknoloji araştır, 123 = bina yerleştir; hepsinde oyunun
// iç kimliği (pbgid) 31. baytta (nadiren 32.). Simülasyon saniyede 8 tik ilerler.
//
// ADİL OYUN: temp.rec maç sürerken de yazılır ve rakiplerin komutlarını içerir. Bu modül sadece
// maç bittikten sonra çağrılmalıdır (bkz. main.js analyzeAfterMatch).

const TICKS_PER_SECOND = 8;
const CMD = { PRODUCE: 3, RESEARCH: 16, PLACE: 123, CANCEL: 5 };
const KIND_BY_CMD = { [CMD.PRODUCE]: 'unit', [CMD.RESEARCH]: 'tech', [CMD.PLACE]: 'building' };
// Kamera/seçim gibi sık gelen ve oyuncu eylemi sayılmayan komutlar (APM hesabına girmez).
const NOISE_CMDS = new Set([0x99, 0x9a, 0x92, 0x94]);

const MAGIC = Buffer.from('Relic Chunky');

class ReplayError extends Error {}

// Chunky bloklarını atlar ve kayıt akışının başladığı ofseti döndürür.
function findStreamStart(buf) {
  let off = buf.indexOf(MAGIC);
  if (off < 0 || buf.toString('latin1', 4, 11) !== 'AOE4_RE') throw new ReplayError('AoE4 kayıt dosyası değil');
  while (buf.slice(off, off + MAGIC.length).equals(MAGIC)) {
    off += 16 + 8; // imza + sürüm + platform
    off = skipChunks(buf, off, buf.length);
  }
  return off;
}

function skipChunks(buf, off, end) {
  while (off + 20 <= end) {
    const kind = buf.toString('latin1', off, off + 4);
    if (kind !== 'FOLD' && kind !== 'DATA') return off;
    const size = buf.readUInt32LE(off + 12);
    const nameLen = buf.readUInt32LE(off + 16);
    off += 20 + nameLen + size;
  }
  return off;
}

// Başlıktaki oyuncu kayıtları: u32 n, UTF-16 isim (n karakter), u32 takım, u32 oyuncu no,
// u8 1, u32 m, ASCII ülke kodu (m karakter). Desen katı olduğu için tarama güvenli.
function parsePlayers(buf, end) {
  const players = [];
  for (let i = 0; i + 8 < end; i++) {
    const n = buf.readUInt32LE(i);
    if (n < 1 || n > 64) continue;
    const nameEnd = i + 4 + n * 2;
    if (nameEnd + 13 > end) continue;
    const team = buf.readUInt32LE(nameEnd);
    const pid = buf.readUInt32LE(nameEnd + 4);
    // Oyuncu numarası 0 da olabilir (ör. maçtan erken düşen oyuncu); 0 dışlanırsa o oyuncu listeden
    // düşer ve kayıt maçla eşleşmez. Aynı desene uyan lobi ayarları ("map_size_640") oyuncu değildir.
    if (team > 8 || pid > 32 || buf[nameEnd + 8] !== 1) continue;
    const civLen = buf.readUInt32LE(nameEnd + 9);
    if (civLen < 3 || civLen > 40 || nameEnd + 13 + civLen > end) continue;
    const civ = buf.toString('latin1', nameEnd + 13, nameEnd + 13 + civLen);
    if (!/^[a-z][a-z0-9_]*$/.test(civ) || (pid === 0 && /^map_/.test(civ))) continue;
    const name = buf.toString('utf16le', i + 4, nameEnd);
    if (/[\u0000-\u001f]/.test(name)) continue;
    players.push({ pid, name, team, civCode: civ });
    i = nameEnd + 13 + civLen - 1;
  }
  return players;
}

// gamedata: pbgid -> kayıt (src/main/data/gamedata.json)
function parseReplay(buf, gamedata) {
  const streamStart = findStreamStart(buf);
  const players = parsePlayers(buf, streamStart);
  if (!players.length) throw new ReplayError('Oyuncu bilgisi bulunamadı');

  const events = [];
  const actions = new Map(); // pid -> eylem sayısı (APM için)
  let lastTick = 0;
  let off = streamStart;
  while (off + 8 <= buf.length) {
    const type = buf.readUInt32LE(off);
    const len = buf.readUInt32LE(off + 4);
    const body = off + 8;
    const end = body + len;
    if (end > buf.length) break; // yarım yazılmış son kayıt
    off = end;
    if (type !== 0 || len < 13) continue;

    const tick = buf.readUInt32LE(body + 1);
    const bundles = buf.readUInt32LE(body + 9);
    lastTick = tick;
    let q = body + 13;
    for (let b = 0; b < bundles && q + 12 <= end; b++) {
      const blen = buf.readUInt32LE(q + 8);
      let r = q + 12;
      const bend = Math.min(r + blen, end);
      while (r + 4 <= bend) {
        const clen = buf.readUInt16LE(r);
        if (clen < 4 || r + clen > bend) break;
        const ctype = buf[r + 2];
        const raw = buf[r + 3];
        const pid = raw & 0x7f;
        const auto = (raw & 0x80) !== 0;
        if (!auto && !NOISE_CMDS.has(ctype)) actions.set(pid, (actions.get(pid) || 0) + 1);
        const kind = KIND_BY_CMD[ctype];
        if (kind && clen >= 35) {
          const pbgid = readPbgid(buf, r, clen, gamedata);
          events.push({ t: tick / TICKS_PER_SECOND, pid, auto, kind, pbgid });
        }
        r += clen;
      }
      q += 12 + blen;
    }
  }
  return { players, durationSec: lastTick / TICKS_PER_SECOND, events, actions: Object.fromEntries(actions) };
}

function readPbgid(buf, r, clen, gamedata) {
  for (const o of [31, 32]) {
    if (o + 4 > clen) continue;
    const v = buf.readUInt32LE(r + o);
    if (gamedata[v]) return v;
  }
  return buf.readUInt32LE(r + 31);
}

module.exports = { parseReplay, parsePlayers, ReplayError, TICKS_PER_SECOND };
