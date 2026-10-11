'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { AiCoach, AiError, ClaudeProvider, GeminiProvider, MODEL, GEMINI_MODEL } = require('../src/main/aiCoach');

// Claude sağlayıcılı koç (sahte istemciyle).
const claudeCoach = (client, key = 'k') => new AiCoach({ getProvider: () => new ClaudeProvider({ getApiKey: () => key, makeClient: () => client }) });
const { opponentHistory, liveContext } = require('../src/main/aiContext');

// Sahte Anthropic istemcisi: gelen isteği kaydeder, verilen yanıtı döndürür.
function fakeClient(reply) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (req) => { calls.push(req); return typeof reply === 'function' ? reply(req) : reply; } } },
  };
}
const textReply = (obj, stop = 'end_turn') => ({ stop_reason: stop, content: [{ type: 'text', text: JSON.stringify(obj) }] });

test('anahtar yoksa net hata verir', async () => {
  const ai = claudeCoach(null, null);
  assert.strictEqual(ai.available(), false);
  await assert.rejects(ai.prematchPlan({}), AiError);
});

const shot = [{ data: 'QUJD', mediaType: 'image/jpeg', label: 'oyuncunun tam ekranı' }];

test('canlı değerlendirme: görsel + şema + yedek model ile istek atar', async () => {
  const live = { uyari: '', durum: 'İyi', simdiYap: ['Oduna 2 köylü'], uret: ['Okçu atölyesinden 6 okçu'], gelistir: '', tahmin: 'Feodal baskın', risk: 'orta', sonrakiHedef: 'Kale 11:00',
    gozlem: { ekranKimin: 'benim', cag: 2, binalar: [], gelistirmeler: [], ordu: [] } };
  const client = fakeClient(textReply(live));
  const ai = claudeCoach(client);
  const out = await ai.liveAssessment({ oyunSuresi: '5:00' }, shot);
  assert.deepStrictEqual(out, live);
  const req = client.calls[0];
  assert.strictEqual(req.model, MODEL);
  assert.deepStrictEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.strictEqual(req.fallbacks, 'default');
  assert.strictEqual(req.output_config.effort, 'low');
  assert.strictEqual(req.output_config.format.type, 'json_schema');
  assert.strictEqual(req.output_config.format.schema.additionalProperties, false);
  assert.strictEqual(req.messages[0].content[0].type, 'image');
  assert.strictEqual(req.messages[0].content[0].source.media_type, 'image/jpeg');
  const text = req.messages[0].content[1].text;
  assert.match(text, /Normal mod/);
  assert.match(text, /Görüntüler sırasıyla: 1\) oyuncunun tam ekranı/);
  assert.deepStrictEqual(req.output_config.format.schema.required, ['uyari', 'uyariTuru', 'durum', 'simdiYap', 'uret', 'gelistir', 'okunanKoylu', 'dagilim', 'komutlar', 'tahmin', 'risk', 'sonrakiHedef', 'gozlem']);
});

test('yönet modunda istem sıralı komut ister; normal modda komutlar boş', async () => {
  const client = fakeClient(textReply({}));
  const ai = claudeCoach(client);
  await ai.liveAssessment({}, [], { command: true });
  await ai.liveAssessment({}, []);
  const [yonet, normal] = client.calls.map((c) => c.messages[0].content[0].text);
  assert.match(yonet, /YÖNET MODU/);
  assert.match(yonet, /simgeYapilar/);
  assert.doesNotMatch(normal, /YÖNET MODU/);
  assert.match(normal, /komutlar: \[\] \(normal mod\)/);
  const schema = client.calls[0].output_config.format.schema;
  assert.deepStrictEqual(schema.properties.dagilim.required, ['yemek', 'odun', 'altin', 'tas']);
  assert.ok(schema.properties.komutlar.items.properties.tur.enum.includes('cag'));
});

test('maç öncesi plan build seçimi alanlarını içerir', async () => {
  const client = fakeClient(textReply({}));
  await claudeCoach(client).prematchPlan({ buildSecenekleri: [{ id: 'x' }] });
  const req = client.calls[0];
  assert.ok(req.output_config.format.schema.required.includes('buildSecimi'));
  assert.match(req.messages[0].content[0].text, /buildSecimi/);
});

test('Gemini: takılan istek zaman aşımıyla anlaşılır hata olur', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const p = new GeminiProvider({ getApiKey: () => 'g', fetchImpl: hang });
  p.timeoutMs = 20;
  await assert.rejects(new AiCoach({ getProvider: () => p }).testConnection(), /Gemini yanıtı gecikti/);
});

test('savaş modunda istem sadece çatışmaya odaklanır', async () => {
  const client = fakeClient(textReply({}));
  await claudeCoach(client).liveAssessment({ tetik: 'Üssünde düşman' }, [], { combat: true });
  const text = client.calls[0].messages[0].content[0].text;
  assert.match(text, /SAVAŞ MODU/);
  assert.match(text, /tetik: Üssünde düşman/);
});

test('ret ve yarım yanıt hata olarak döner', async () => {
  const ai1 = claudeCoach(fakeClient(textReply({}, 'refusal')));
  await assert.rejects(ai1.postgameReport({}), /reddetti/);
  const ai2 = claudeCoach(fakeClient(textReply({}, 'max_tokens')));
  await assert.rejects(ai2.postgameReport({}), /yarıda/);
});

test('çeviri ikon belirteçlerini bozarsa o adımın aslı korunur', async () => {
  const build = { name: 'b', steps: [{ notes: ['All @resource/sheep.webp@ to food'] }, { notes: ['Build @building/house.webp@'] }] };
  const client = fakeClient(textReply({ adimlar: [
    { notlar: ['Hepsi @resource/sheep.webp@ yemeğe'] },
    { notlar: ['Ev kur'] }, // ikon kaybolmuş
  ] }));
  const ai = claudeCoach(client);
  const t = await ai.translateBuild(build);
  assert.strictEqual(t.steps[0].notes[0], 'Hepsi @resource/sheep.webp@ yemeğe');
  assert.strictEqual(t.steps[1].notes[0], 'Build @building/house.webp@');
});

test('rakip defteri geçmiş karşılaşmaları ve o maçtaki oyunlarını verir', () => {
  const matches = [
    { matchId: 2, myTeam: 1, result: 'loss', playedAt: Date.UTC(2026, 9, 11), map: 'Hill and Dale', hasAnalysis: true,
      players: [{ name: 'KEYI', profileId: 9, team: 0, civCode: 'abbasid' }, { name: 'ben', profileId: 1, team: 1, civCode: 'chinese_ha_01' }] },
    { matchId: 1, myTeam: 0, result: 'win', players: [{ name: 'KEYI', profileId: 9, team: 0, civCode: 'abbasid' }] }, // aynı takım: sayılmaz
  ];
  const analysis = { report: { players: [{ name: 'KEYI', ageUps: { 2: 181 }, military: { firstAt: 367, composition: [{ name: 'Deve Okçusu', count: 260 }] } }] } };
  const h = opponentHistory([9, 5], matches, () => analysis);
  assert.deepStrictEqual(Object.keys(h), ['9']);
  assert.strictEqual(h[9].length, 1);
  assert.deepStrictEqual(h[9][0], {
    tarih: '2026-10-11', harita: 'Hill and Dale', bizimSonuc: 'kaybettik', ulke: 'abbasid',
    feodal: '3:01', kale: '–', ilkAsker: '6:07', ordu: ['Deve Okçusu x260'],
  });
});

test('canlı bağlam ekran okuma kapalıyken de kurulur', () => {
  const c = liveContext({ elapsedSec: 300, hud: null, buildView: null, myCiv: { tr: 'Çinliler' }, plan: null, lastAssessment: null, scouting: null });
  assert.strictEqual(c.oyunSuresi, '5:00');
  assert.strictEqual(c.ekrandanOkunan, 'ekran okuma kapalı');
});

// Sahte fetch: isteği kaydeder, verilen durum kodu ve gövdeyle yanıt verir.
function fakeFetch(status, body) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { status, ok: status < 400, json: async () => body }; };
  f.calls = calls;
  return f;
}
const geminiCoach = (fetchImpl, key = 'g') => new AiCoach({ getProvider: () => new GeminiProvider({ getApiKey: () => key, fetchImpl }) });

test('Gemini: Interactions biçiminde istek atar, görseli çevirir, son adımdaki metni okur', async () => {
  const live = { uyari: 'Rakip gelebilir · sol', durum: 'x', simdiYap: [], tahmin: 't', risk: 'orta', sonrakiHedef: 'h' };
  // Yanıt ``` bloğuna sarılı gelse de çözülmeli.
  const wrapped = ['```json', JSON.stringify(live), '```'].join(String.fromCharCode(10));
  const f = fakeFetch(200, { id: 'i1', steps: [{ content: [{ type: 'thought' }] }, { content: [{ type: 'text', text: wrapped }] }] });
  const out = await geminiCoach(f).liveAssessment({ oyunSuresi: '5:00' }, shot);
  assert.deepStrictEqual(out, live);
  const { url, init, body } = f.calls[0];
  assert.strictEqual(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.strictEqual(init.headers['x-goog-api-key'], 'g');
  assert.strictEqual(body.model, GEMINI_MODEL); // ilk tercih
  assert.match(body.system_instruction, /Age of Empires IV/);
  assert.deepStrictEqual(body.input[0], { type: 'image', data: 'QUJD', mime_type: 'image/jpeg' });
  assert.strictEqual(body.input[1].type, 'text');
  assert.strictEqual(body.response_format.mime_type, 'application/json');
  assert.deepStrictEqual(body.generation_config, { thinking_level: 'low' });
});

test('Gemini: savaş anında ve oyuncu listesi okurken en hafif modelden başlar', async () => {
  const f = fakeFetch(200, { steps: [{ content: [{ type: 'text', text: '{"oyuncular":[]}' }] }] });
  const ai = geminiCoach(f);
  await ai.liveAssessment({}, shot, { combat: true });
  await ai.identifyPlayers(['altanarl', 'Pirofurkan'], { data: 'UE5H', mediaType: 'image/png' }, 4);
  assert.deepStrictEqual(f.calls.map((c) => c.body.model), ['gemini-3.5-flash-lite', 'gemini-3.5-flash-lite']);
  const id = f.calls[1].body;
  assert.deepStrictEqual(id.input[0], { type: 'image', data: 'UE5H', mime_type: 'image/png' });
  assert.match(id.input[1].text, /Listede 4 satır var/);
  assert.match(id.input[1].text, /"altanarl","Pirofurkan"/);
  assert.ok(id.response_format.schema.properties.oyuncular.items.properties.renk.enum.includes('camgöbeği'));
});

test('Gemini: kota dolunca ve anahtar hatalıyken anlaşılır hata', async () => {
  await assert.rejects(geminiCoach(fakeFetch(429, {})).postgameReport({}), /tüm modellerde doldu/);
  await assert.rejects(geminiCoach(fakeFetch(400, { error: { message: 'API key not valid' } })).postgameReport({}), /API key not valid/);
  await assert.rejects(geminiCoach(fakeFetch(200, {}), null).postgameReport({}), /anahtarı girilmemiş/);
});

test('Gemini: 503 yoğunlukta tekrar dener, sonra başarır', async () => {
  let n = 0;
  const f = async () => (++n < 3 ? { status: 503, ok: false, json: async () => ({}) } : { status: 200, ok: true, json: async () => ({ steps: [{ content: [{ type: 'text', text: '{"tamam":true}' }] }] }) });
  const p = new GeminiProvider({ getApiKey: () => 'g', fetchImpl: f });
  p.retryDelayMs = 1;
  const ai = new AiCoach({ getProvider: () => p });
  assert.strictEqual(await ai.testConnection(), true);
  assert.strictEqual(n, 3);
});

test('Gemini: yoğun/kotası dolu modelden sonrakine geçer', async () => {
  const used = [];
  const f = async (u, init) => { const m = JSON.parse(init.body).model; used.push(m); return m === 'gemini-3.5-flash-lite' ? { status: 200, ok: true, json: async () => ({ steps: [{ content: [{ text: '{"tamam":true}' }] }] }) } : { status: m === 'gemini-3.8-flash' ? 503 : 429, ok: false, json: async () => ({}) }; };
  const p = new GeminiProvider({ getApiKey: () => 'g', fetchImpl: f });
  p.retryDelayMs = 1;
  assert.strictEqual(await new AiCoach({ getProvider: () => p }).testConnection(), true);
  assert.deepStrictEqual(used, ['gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']);
});

test('serbest modda plan şeması özel build ister; rakip tarzı ve geçmiş ordu vurgulanır', async () => {
  const client = fakeClient(textReply({}));
  const ai = claudeCoach(client);
  await ai.prematchPlan({}, { custom: true });
  await ai.prematchPlan({});
  const [serbest, normal] = client.calls;
  const s = serbest.output_config.format.schema;
  assert.ok(s.required.includes('ozelBuild'));
  assert.deepStrictEqual(s.properties.ozelBuild.properties.adimlar.items.required, ['saniye', 'yemek', 'odun', 'altin', 'tas', 'insaat', 'not']);
  assert.match(serbest.messages[0].content[0].text, /SERBEST MOD/);
  assert.ok(!normal.output_config.format.schema.required.includes('ozelBuild'));
  assert.doesNotMatch(normal.messages[0].content[0].text, /SERBEST MOD/);
  assert.match(normal.messages[0].content[0].text, /bizeKarsiAgirlikliOrdu/);
});

test('Gemini: internet aramalı serbest metin; kaynaklar url_citation açıklamalarından', async () => {
  const body = { steps: [
    { type: 'google_search_call', arguments: { queries: ['aoe4 flankwoods strategy'] } },
    { type: 'model_output', content: [{ type: 'text', text: 'Flankwoods kapalı bir harita.', annotations: [
      { type: 'url_citation', url: 'https://a.example/1', title: 'Rehber', start_index: 0, end_index: 10 },
      { type: 'url_citation', url: 'https://a.example/1', title: 'Rehber' },
      { type: 'url_citation', url: 'https://b.example/2', title: 'Yama notları' },
    ] }] },
  ] };
  const f = fakeFetch(200, body);
  const ai = geminiCoach(f);
  const res = await ai.research({ mapName: 'Saklı Ormanlar (Flankwoods)', kind: 'rm_2v2', myCiv: 'Zhu Xi', enemyCivs: ['Moğollar'], allyCivs: [] });
  assert.strictEqual(res.text, 'Flankwoods kapalı bir harita.');
  assert.deepStrictEqual(res.sources, [{ url: 'https://a.example/1', title: 'Rehber' }, { url: 'https://b.example/2', title: 'Yama notları' }]);
  const req = f.calls[0].body;
  assert.deepStrictEqual(req.tools, [{ type: 'google_search' }]);
  assert.strictEqual(req.response_format, undefined);
  assert.match(req.input[0].text, /Saklı Ormanlar \(Flankwoods\)/);
});

test('sohbet: oyuncu verisi ilk mesajda, geçmiş sırayla; Claude araması olmadan cevaplar', async () => {
  const client = fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Feodal geç kaldı.' }] });
  const res = await claudeCoach(client).chat([{ role: 'user', text: 'Neden kaybettik?' }], { sonMaclarim: [] });
  assert.deepStrictEqual(res, { text: 'Feodal geç kaldı.', sources: [] });
  const req = client.calls[0];
  assert.deepStrictEqual(req.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.match(req.messages[0].content, /Oyuncu verisi/);
  assert.strictEqual(req.messages[2].content, 'Neden kaybettik?');
  assert.strictEqual(req.output_config.format, undefined);
  // Gemini: konuşma tek metne dökülür, arama açık.
  const f = fakeFetch(200, { steps: [{ content: [{ type: 'text', text: 'Cevap' }] }] });
  await geminiCoach(f).chat([{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }, { role: 'user', text: 'c' }], {});
  const g = f.calls[0].body;
  assert.deepStrictEqual(g.tools, [{ type: 'google_search' }]);
  assert.match(g.input[0].text, /Koç: b[\s\S]*Yeni mesaj:\nOyuncu: c$/);
});

test('araştırma sadece Gemini ile yapılır', async () => {
  assert.strictEqual(await claudeCoach(fakeClient({})).research({ enemyCivs: [], allyCivs: [] }), null);
});
