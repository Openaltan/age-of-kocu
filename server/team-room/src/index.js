import { DurableObject } from 'cloudflare:workers';

// Oda adresi: /room/<64 haneli hex>. Hex, uygulamada "takım kodu + maç numarası"ndan üretilir;
// kodu bilmeyen odayı tahmin edemez. Sunucu oda mesajlarını sadece aynı odadakilere iletir, saklamaz.
//
// Ortak ulus önerisi: /advice/<64 haneli hex>. Hex, ekibin profil kimliklerinden üretilir. Ekipteki
// her uygulama aynı öneriyi görsün diye ilk hesaplanan öneri burada 3 gün saklanır (GET okur,
// PUT yazar; süresi dolmamış öneri sadece "replace" ile değiştirilir). İçerik herkese açık AoE4World
// verisinden üretilmiş öneridir; kişisel bilgi ya da anahtar içermez.
const ROOM = /^\/room\/([a-f0-9]{64})$/;
const ADVICE = /^\/advice\/([a-f0-9]{64})$/;
const MAX_MEMBERS = 8;
const MAX_MESSAGE = 16 * 1024;
const MAX_ADVICE = 256 * 1024;
const ADVICE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const RELAYED = new Set(['status', 'ping']);

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const advice = ADVICE.exec(path);
    if (advice) return env.ROOMS.get(env.ROOMS.idFromName(`advice:${advice[1]}`)).fetch(request);
    const m = ROOM.exec(path);
    if (!m) return new Response('Age of Koçu takım odası', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket bekleniyor', { status: 426 });
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(request);
  },
};

export class TeamRoom extends DurableObject {
  async fetch(request) {
    if (ADVICE.test(new URL(request.url).pathname)) return this.advice(request);
    if (this.ctx.getWebSockets().length >= MAX_MEMBERS) return new Response('Oda dolu', { status: 429 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async advice(request) {
    const stored = await this.ctx.storage.get('advice');
    const fresh = stored && Date.now() - stored.at < ADVICE_TTL_MS;
    if (request.method === 'GET') return fresh ? json(stored) : json({ error: 'yok' }, 404);
    if (request.method !== 'PUT') return json({ error: 'GET ya da PUT' }, 405);
    const text = await request.text();
    if (text.length > MAX_ADVICE) return json({ error: 'çok büyük' }, 413);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: 'geçersiz JSON' }, 400);
    }
    if (!body || typeof body.data !== 'object' || body.data === null) return json({ error: 'data eksik' }, 400);
    // Süresi dolmamış öneri varsa ve değiştirme istenmediyse mevcut öneri döner (ekip aynı öneriyi görür).
    if (fresh && !body.replace) return json({ ...stored, kept: true });
    const record = { at: Date.now(), data: body.data };
    await this.ctx.storage.put('advice', record);
    return json(record);
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
