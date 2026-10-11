'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const STALE_MS = 12 * 1000;

// Oda anahtarı. İki mod:
//  - otomatik (kod yok): maç numarası + takımdaki oyuncuların kimlikleri. Aynı maçta aynı takımda
//    olan ve uygulaması açık herkes kendiliğinden aynı odaya düşer, kurulum gerekmez.
//  - gizli kod: takım kodu + maç numarası. Kodu bilmeyen odayı bulamaz (rakibe karşı en güvenlisi).
function roomKey(teamCode, matchId, teamIds = []) {
  const code = String(teamCode || '').trim().toLowerCase();
  const seed = code
    ? `age-of-kocu|${code}|${matchId ?? 'deneme'}`
    : `age-of-kocu-auto|${matchId ?? 'deneme'}|${[...teamIds].map(String).sort().join(',')}`;
  return crypto.createHash('sha256').update(seed).digest('hex');
}

// Takım odası istemcisi. Bağlantı koparsa artan aralıklarla yeniden bağlanır.
// Olaylar: 'status' (üye), 'ping' (üye, veri), 'change' (bağlantı/üye listesi değişti)
class TeamSync extends EventEmitter {
  constructor({ serverUrl, WebSocketImpl = globalThis.WebSocket } = {}) {
    super();
    this.serverUrl = serverUrl;
    this.WebSocketImpl = WebSocketImpl;
    this.members = new Map(); // id -> { id, name, status, at }
    this.ws = null;
    this.active = false;
    this.connected = false;
    this.retry = 0;
    this.lastStatus = null;
  }

  // allowedIds: bu maçta benim takımımdaki oyuncuların profil kimlikleri (başkası gelirse yok sayılır).
  connect({ teamCode, matchId, me, allowedIds }) {
    this.disconnect();
    if (!this.serverUrl) return;
    this.active = true;
    this.me = me;
    this.allowed = new Set((allowedIds || []).map(String));
    this.url = `${this.serverUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/room/${roomKey(teamCode, matchId, allowedIds)}`;
    this.open();
  }

  open() {
    if (!this.active) return;
    let ws;
    try {
      ws = new this.WebSocketImpl(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.send({ type: 'hello', member: { id: String(this.me.id), name: this.me.name } });
      if (this.lastStatus) this.send({ type: 'status', data: this.lastStatus });
      this.emit('change');
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.emit('change');
      this.scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  scheduleReconnect() {
    if (!this.active) return;
    const delay = Math.min(30, 2 ** this.retry++) * 1000;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const from = msg.from;
    if (!from || (this.allowed.size && !this.allowed.has(String(from.id)))) return;
    if (msg.type === 'join') {
      // Yeni gelen arkadaş hemen durumumu görsün.
      if (this.lastStatus) this.send({ type: 'status', data: this.lastStatus });
    } else if (msg.type === 'status') {
      this.members.set(String(from.id), { id: String(from.id), name: from.name, status: msg.data, at: Date.now() });
      this.emit('status', this.members.get(String(from.id)));
      this.emit('change');
    } else if (msg.type === 'ping') {
      this.emit('ping', { id: String(from.id), name: from.name }, msg.data);
    } else if (msg.type === 'leave') {
      this.members.delete(String(from.id));
      this.emit('change');
    }
  }

  send(obj) {
    if (this.ws && this.connected) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch {
        // bağlantı kapanıyor; yeniden bağlanınca son durum tekrar gönderilir
      }
    }
  }

  sendStatus(data) {
    this.lastStatus = data;
    this.send({ type: 'status', data });
  }

  sendPing(data) {
    this.send({ type: 'ping', data });
  }

  // Son 12 saniyede haber veren arkadaşlar.
  liveMembers(now = Date.now()) {
    return [...this.members.values()].filter((m) => now - m.at < STALE_MS);
  }

  disconnect() {
    this.active = false;
    clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    this.members.clear();
    if (ws) {
      try {
        ws.close();
      } catch {
        // zaten kapalı
      }
    }
  }
}

// Takım verisinden benim overlay'ime düşecek kısa notlar (durum notları).
function teamNotes(me, mates, elapsedSec) {
  const out = [];
  for (const m of mates) {
    const s = m.status;
    if (!s) continue;
    // Arkadaşın üssünde gerçekten bir şey oluyorsa (riskKind 'gercek') tehlike; eski sürümler
    // tahminleri de gönderdiği için türü belli olmayan risk "olası" olarak gösterilir.
    if (s.risk) {
      const real = s.riskKind === 'gercek';
      out.push({ key: `team-risk-${m.id}`, level: real ? 'danger' : 'info', text: real ? `${m.name}: ${s.risk}` : `${m.name} (olası): ${s.risk}` });
    }
    if (s.idle >= 3) out.push({ key: `team-idle-${m.id}`, level: 'info', text: `${m.name}: ${s.idle} köylü boşta` });
  }
  const known = mates.map((m) => m.status?.villagers).filter((v) => v != null);
  if (me?.villagers != null && known.length && elapsedSec > 8 * 60) {
    const avg = known.reduce((a, b) => a + b, 0) / known.length;
    if (me.villagers < avg - 8) out.push({ key: 'team-vil', level: 'info', text: 'Takımda en az köylü sende' });
  }
  return out;
}

module.exports = { TeamSync, teamNotes, roomKey };
