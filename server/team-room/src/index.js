import { DurableObject } from 'cloudflare:workers';

// Oda adresi: /room/<64 haneli hex>. Hex, uygulamada "takım kodu + maç numarası"ndan üretilir;
// kodu bilmeyen odayı tahmin edemez. Sunucu mesajları sadece aynı odadakilere iletir, saklamaz.
const ROOM = /^\/room\/([a-f0-9]{64})$/;
const MAX_MEMBERS = 8;
const MAX_MESSAGE = 16 * 1024;
const RELAYED = new Set(['status', 'ping']);

export default {
  async fetch(request, env) {
    const m = ROOM.exec(new URL(request.url).pathname);
    if (!m) return new Response('Age of Koçu takım odası', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket bekleniyor', { status: 426 });
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(request);
  },
};

export class TeamRoom extends DurableObject {
  async fetch() {
    if (this.ctx.getWebSockets().length >= MAX_MEMBERS) return new Response('Oda dolu', { status: 429 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(from, payload) {
    const text = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === from) continue;
      try {
        ws.send(text);
      } catch {
        // kopmuş bağlantı: kapanış olayında temizlenir
      }
    }
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      const member = { id: String(msg.member?.id ?? '').slice(0, 24), name: String(msg.member?.name ?? '').slice(0, 48) };
      ws.serializeAttachment({ member });
      // Yeni gelen herkesin güncel durumunu hemen görsün diye diğerlerinden durum iste.
      this.broadcast(ws, { type: 'join', from: member });
      return;
    }
    const member = ws.deserializeAttachment()?.member;
    if (!member || !RELAYED.has(msg.type)) return;
    this.broadcast(ws, { type: msg.type, from: member, data: msg.data, at: Date.now() });
  }

  async webSocketClose(ws, code) {
    const member = ws.deserializeAttachment()?.member;
    if (member) this.broadcast(ws, { type: 'leave', from: member });
    try {
      ws.close(code === 1005 ? 1000 : code, 'kapandı');
    } catch {
      // zaten kapalı
    }
  }
}
