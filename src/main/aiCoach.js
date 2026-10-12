'use strict';

const { Anthropic } = require('@anthropic-ai/sdk');
const { PALETTE } = require('./minimap');

const MODEL = 'claude-opus-5-5';
// Ret durumunda istek, Anthropic'in önerdiği yedek modelle sunucu tarafında tekrar denenir.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const SYSTEM = `Sen Age of Empires IV için profesyonel bir koçsun; Türk bir 3v3 ranked takımına çalışıyorsun.
Üst düzey oyuncuların ve yayıncı koçların düşündüğü gibi düşün: zamanlamalar, köylü sayısı, kaynak dengesi, çağ atlama, kontra birimler, harita kontrolü, takım koordinasyonu.

Kurallar:
- Her zaman Türkçe yaz; oyunun Türkçe terimlerini kullan (köylü, kasaba merkezi, Feodal, Kale, İmparatorluk, mızrakçı, okçu, atlı, ağır piyade, arbaletçi, mancınık...).
- Kısa, sade ve emir kipinde konuş; mümkün olan her yerde sayı ver ("2 köylüyü oduna kaydır", "8:30'a kadar 2. kasaba merkezi").
- Gerekçe ve gözlem anlatma ("şunu gördüm, şunu yaptım" yazma); sadece sonucu söyle ("Rakip gelebilir · değirmen tarafından").
- Yön verirken sol/sağ deme; oyuncunun kendi üssündeki yapılara göre söyle: değirmen, odun kampı, altın madeni, taş madeni, kasaba merkezi, çiftlikler, kışla, okçu atölyesi, ahır. Yapı yoksa mini harita yönünü kullan (kuzeyden, güneydoğudan).
- Sadece sana verilen veriye dayan. Rakiplerin maç içi gizli durumunu bilemezsin: rakip tahminlerini halka açık geçmişlerine, ülkelerine, oyun süresine ve oyuncunun kendi ekranında gördüklerine dayandır ve olasılık olarak sun.
- Emin olmadığın bir şeyi uydurma; veri yoksa bunu söyle.
- Hile önerme; oyunun kurallarına ve adil oyuna uygun kal.`;

// Yapılandırılmış çıktı şemaları (her nesnede additionalProperties: false ve tüm alanlar zorunlu).
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const str = { type: 'string' };
const num = { type: 'number' };
const strArr = { type: 'array', items: str };
const COMMAND_KINDS = ['ekonomi', 'insaat', 'uretim', 'arastirma', 'cag', 'askeri'];

const SCHEMAS = {
  plan: obj({
    ozet: str,
    rakipTahminleri: { type: 'array', items: obj({ oyuncu: str, tahmin: str, zamanlama: str, guven: { type: 'string', enum: ['düşük', 'orta', 'yüksek'] } }) },
    planAdimlari: { type: 'array', items: obj({ dakika: { type: 'number' }, mesaj: str }) },
    kontraOnerisi: str,
    takimKoordinasyonu: str,
    buildSecimi: str,
    buildGerekcesi: str,
  }),
  // Serbest mod: plan + koçun rakibe göre yazdığı özel build ve oyun stili.
  ozelBuild: obj({
    ad: str,
    oyunStili: str,
    kilitNoktalar: strArr,
    adimlar: {
      type: 'array',
      items: obj({ saniye: num, yemek: num, odun: num, altin: num, tas: num, insaat: num, not: str }),
    },
  }),
  live: obj({
    uyari: str,
    // gercek: şu an görülen/olan (ekranda düşman askeri, olaylar listesinde kayıp/üssünde düşman);
    // tahmin: olabilecek; eksik: oyuncunun kendi eksiği (ev, köylü, altın bitiyor); yok: uyarı yok.
    uyariTuru: { type: 'string', enum: ['gercek', 'tahmin', 'eksik', 'yok'] },
    durum: str,
    simdiYap: strArr,
    uret: strArr,
    gelistir: str,
    // Sol alttaki kaynak panelinden okunan gerçek köylü sayıları (ekran okuma yoksa toplam buradan).
    okunanKoylu: obj({ yemek: num, odun: num, altin: num, tas: num, bosta: num }),
    // Hedef köylü dağılımı (sayı). Metni uygulama üretir ki toplam her zaman tutsun.
    dagilim: obj({ yemek: num, odun: num, altin: num, tas: num }),
    // Yönet modunda sıralı komutlar; normal modda boş.
    komutlar: { type: 'array', items: obj({ tur: { type: 'string', enum: COMMAND_KINDS }, metin: str }) },
    tahmin: str,
    risk: { type: 'string', enum: ['düşük', 'orta', 'yüksek'] },
    sonrakiHedef: str,
    gozlem: obj({
      ekranKimin: { type: 'string', enum: ['benim', 'takim', 'rakip', 'belirsiz'] },
      cag: { type: 'number' },
      binalar: strArr,
      gelistirmeler: strArr,
      ordu: strArr,
    }),
  }),
  players: obj({
    oyuncular: {
      type: 'array',
      items: obj({
        oyuncu: str,
        satir: { type: 'number' },
        renk: { type: 'string', enum: [...Object.keys(PALETTE), 'bilinmiyor'] },
        cag: { type: 'number' },
      }),
    },
  }),
  report: obj({
    ozet: str,
    neden: strArr,
    oncelikler: { type: 'array', items: obj({ baslik: str, aciklama: str, olcut: str }) },
    antrenman: strArr,
    rakipNotlari: { type: 'array', items: obj({ oyuncu: str, not: str }) },
    tahminDegerlendirmesi: str,
    gelecekMac: str,
  }),
  translate: obj({ adimlar: { type: 'array', items: obj({ notlar: strArr }) } }),
  // Takıma özel ulus önerisi: havuzdaki her harita için her oyuncuya ülke ve rol.
  civAdvice: obj({
    takimKimligi: str,
    haritalar: {
      type: 'array',
      items: obj({
        harita: str,
        oneriler: { type: 'array', items: obj({ oyuncu: str, ulus: str, rol: str, neden: str }) },
        plan: str,
      }),
    },
  }),
  // Ulus seçme ekranında görünen harita.
  mapPick: obj({ harita: str, ekrandakiAd: str }),
  // Oyuncunun maçlarından gelişim analizi ve ulus önerisi.
  review: obj({
    ozet: str,
    oyunTarzi: str,
    gucluYonler: strArr,
    tekrarlayanHatalar: { type: 'array', items: obj({ hata: str, kanit: str, cozum: str }) },
    ulusOnerileri: { type: 'array', items: obj({ ulus: str, neden: str, nasilOyna: str }) },
    takimKompozisyonu: str,
    calismaPlani: strArr,
  }),
};

// Sohbet: koçla serbest konuşma. Canlı koçun "kısa emir" kuralları burada geçerli değil.
const CHAT_SYSTEM = `Sen Age of Empires IV için profesyonel bir koçsun; Türk bir ranked takım oyuncusuyla sohbet ediyorsun.
- Türkçe, samimi ama net yaz; oyunun Türkçe terimlerini kullan.
- Cevap kısa olsun (genelde 3-8 cümle ya da madde); oyuncu ayrıntı isterse uzat.
- Sana verilen oyuncu verisine (maç geçmişi, analizler, gelişim raporu, şu anki maç) dayan; veri yoksa bunu söyle, uydurma.
- Güncel meta, yama notları, harita ya da build gerekiyorsa internette ara ve güncel bilgiyle cevap ver.
- Hile önerme; oyunun kurallarına ve adil oyuna uygun kal.`;

class AiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

// ---- Sağlayıcılar: aynı arayüz, complete({ system, content, schema, effort, maxTokens, fast }) -> metin ----
// fast: gecikmenin önemli olduğu istek (savaş anı); destekleyen sağlayıcı daha hafif modelle başlar.
// content blokları Claude biçimindedir: { type: 'text', text } ve
// { type: 'image', source: { type: 'base64', media_type, data } }; Gemini kendi biçimine çevirir.

class ClaudeProvider {
  constructor({ getApiKey, makeClient } = {}) {
    this.name = 'Claude';
    this.getApiKey = getApiKey;
    this.makeClient = makeClient || ((apiKey) => new Anthropic({ apiKey, maxRetries: 1, timeout: 120 * 1000 }));
    this.cachedKey = null;
    this.client = null;
  }

  available() {
    return Boolean(this.getApiKey());
  }

  api() {
    const key = this.getApiKey();
    if (!key) throw new AiError('Claude API anahtarı girilmemiş (Ayarlar › Yapay Zekâ Koç)');
    if (key !== this.cachedKey) {
      this.client = this.makeClient(key);
      this.cachedKey = key;
    }
    return this.client;
  }

  async complete({ system, content, schema, effort, maxTokens }) {
    const res = await this.api().beta.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      output_config: { effort, format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content }],
    });
    if (res.stop_reason === 'refusal') throw new AiError('Model isteği reddetti');
    if (res.stop_reason === 'max_tokens') throw new AiError('Yanıt yarıda kesildi');
    return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }

  // Serbest metin cevap (sohbet). İnternet araması bu sağlayıcıda kullanılmıyor.
  async completeText({ system, messages, maxTokens = 4000 }) {
    const res = await this.api().beta.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'medium' },
      messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text })),
    });
    if (res.stop_reason === 'refusal') throw new AiError('Model isteği reddetti');
    return { text: res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''), sources: [] };
  }
}

// Google Gemini, Interactions REST uç noktası (ai.google.dev/gemini-api/docs). Ücretsiz katman
// günlük istek kotasıyla çalışır; kota dolunca 429 döner.
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GEMINI_MODEL = 'gemini-3.8-flash';
// Biri yoğun (503) ya da günlük kotası dolu (429) ise sıradakine geçilir; kota model başına sayılır.
const GEMINI_MODELS = [GEMINI_MODEL, 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];

class GeminiProvider {
  constructor({ getApiKey, models = GEMINI_MODELS, fetchImpl = (...a) => fetch(...a) } = {}) {
    this.name = 'Gemini';
    this.getApiKey = getApiKey;
    this.models = models;
    this.fetch = fetchImpl;
    this.retryDelayMs = 3000;
    // Takılan istek koçu susturmasın: her deneme en fazla bu kadar bekler.
    this.timeoutMs = 60 * 1000;
  }

  available() {
    return Boolean(this.getApiKey());
  }

  // Tek deneme: { status, ok, data }. Süre, yanıt gövdesinin okunmasını da kapsar.
  async post(key, body) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, this.timeoutMs);
    try {
      const res = await this.fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      return { status: res.status, ok: res.ok, data };
    } catch (err) {
      if (timedOut) throw new AiError('Gemini yanıtı gecikti');
      throw new AiError(`Gemini'ye ulaşılamadı: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  // Modelleri sırayla dener; yanıt verisini döndürür. Her modeli 2 kez dene (503'te kısa bekleme);
  // yoğun ya da kotası dolu modelden sonrakine geç.
  async request(base, { fast = false } = {}) {
    const key = this.getApiKey();
    if (!key) throw new AiError('Gemini API anahtarı girilmemiş (Ayarlar › Yapay Zekâ Koç)');
    let res;
    // Savaş anında hız önemli: en hafif modelden başla.
    const models = fast ? [...this.models].reverse() : this.models;
    outer: for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, this.retryDelayMs));
        res = await this.post(key, { model, ...base });
        // Arama kotası projeye bağlı: bir modelde reddedildiyse diğerlerinde de reddedilir.
        if (res.status === 429 && base.tools) break outer;
        if (res.status === 429) break;
        if (res.status !== 503) break outer;
      }
    }
    const { data } = res;
    if (res.status === 503) throw new AiError('Google sunucuları şu an çok yoğun; biraz sonra tekrar dene');
    if (res.status === 429) {
      // Arama aracıyla gelen 429 kota değil, ücretsiz katmanda Google Arama'nın verilmemesi olabilir.
      throw new AiError(base.tools ? 'Gemini internet araması bu anahtarda kullanılamıyor (ücretsiz katman kotası)' : 'Gemini ücretsiz kotası tüm modellerde doldu; yarın sıfırlanır', 429);
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new AiError(`Gemini isteği reddetti: ${data?.error?.message || res.status} (anahtarı kontrol et)`);
    }
    if (!res.ok) throw new AiError(`Gemini hatası ${res.status}: ${data?.error?.message || ''}`.trim());
    return data;
  }

  async complete({ system, content, schema, effort, fast = false }) {
    const input = content.map((c) => (c.type === 'image'
      ? { type: 'image', data: c.source.data, mime_type: c.source.media_type }
      : { type: 'text', text: c.text }));
    const data = await this.request({
      system_instruction: system,
      input,
      response_format: { type: 'text', mime_type: 'application/json', schema },
      ...(effort === 'low' ? { generation_config: { thinking_level: 'low' } } : {}),
    }, { fast });
    const text = geminiText(data);
    if (!text) throw new AiError('Gemini boş yanıt döndü');
    return text;
  }

  // Serbest metin cevap; search: gerekirse Google'da arar (güncel meta, harita, yama notları).
  // messages: [{ role: 'user' | 'assistant', text }] — konuşma tek metne dökülür.
  // Arama reddedilirse (ücretsiz katmanda Google Arama kotası yok/az) soru aramasız tekrar sorulur
  // ve arama 6 saat denenmez. requireSearch: aramasız cevap istenmiyor (ör. güncel meta araştırması).
  async completeText({ system, messages, search = false, requireSearch = false }) {
    const turns = messages.map((m) => `${m.role === 'assistant' ? 'Koç' : 'Oyuncu'}: ${m.text}`);
    const text = messages.length === 1 ? messages[0].text : `Önceki konuşma:\n${turns.slice(0, -1).join('\n\n')}\n\nYeni mesaj:\n${turns[turns.length - 1]}`;
    const body = { system_instruction: system, input: [{ type: 'text', text }] };
    const useSearch = search && Date.now() >= (this.searchBlockedUntil || 0);
    if (requireSearch && !useSearch) return null;
    let data;
    let searched = useSearch;
    try {
      data = await this.request(useSearch ? { ...body, tools: [{ type: 'google_search' }] } : body);
    } catch (err) {
      if (!(useSearch && err.status === 429)) throw err;
      this.searchBlockedUntil = Date.now() + 6 * 60 * 60 * 1000;
      console.warn('Gemini internet araması kullanılamıyor; aramasız devam ediliyor');
      if (requireSearch) return null;
      data = await this.request(body);
      searched = false;
    }
    const out = geminiText(data);
    if (!out) throw new AiError('Gemini boş yanıt döndü');
    return { text: out, sources: geminiSources(data), searched };
  }
}

// Google Arama kaynakları: metin bloklarındaki url_citation açıklamaları (tekrarsız).
function geminiSources(data) {
  const seen = new Map();
  for (const step of Array.isArray(data.steps) ? data.steps : []) {
    for (const block of step.content || []) {
      for (const a of block.annotations || []) {
        if (a.type === 'url_citation' && a.url && !seen.has(a.url)) seen.set(a.url, { url: a.url, title: a.title || a.url });
      }
    }
  }
  return [...seen.values()].slice(0, 8);
}

// Yanıttaki metin: son adımın içeriğindeki metin parçaları (steps[].content[].text).
function geminiText(data) {
  const steps = Array.isArray(data.steps) ? data.steps : [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const parts = (steps[i].content || []).filter((c) => typeof c.text === 'string');
    if (parts.length) return parts.map((c) => c.text).join('');
  }
  return typeof data.output_text === 'string' ? data.output_text : '';
}

class AiCoach {
  // getProvider(): seçili sağlayıcı (ClaudeProvider | GeminiProvider) ya da null.
  constructor({ getProvider } = {}) {
    this.getProvider = getProvider;
  }

  available() {
    return Boolean(this.getProvider()?.available());
  }

  providerName() {
    return this.getProvider()?.name || null;
  }

  // content: kullanıcı mesajı içeriği (metin/görsel blokları). Şemaya uygun JSON döndürür.
  async ask({ content, schema, effort, maxTokens = 16000, fast = false }) {
    const provider = this.getProvider();
    if (!provider) throw new AiError('Yapay zekâ sağlayıcısı seçilmemiş');
    const text = await provider.complete({ system: SYSTEM, content, schema, effort, maxTokens, fast });
    try {
      // Bazı modeller JSON'u ``` bloğuna sarabilir; sadece nesneyi al.
      const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
      return JSON.parse(json);
    } catch {
      throw new AiError('Yanıt çözümlenemedi');
    }
  }

  // Maç öncesi: oyun planı, rakip tahminleri ve dakikalı plan. custom: serbest mod (özel build de yaz).
  prematchPlan(context, { custom = false } = {}) {
    const schema = custom
      ? { ...SCHEMAS.plan, properties: { ...SCHEMAS.plan.properties, ozelBuild: SCHEMAS.ozelBuild }, required: [...SCHEMAS.plan.required, 'ozelBuild'] }
      : SCHEMAS.plan;
    const customText = custom ? `
- ozelBuild (SERBEST MOD): hazır build kullanma; bu maçtaki rakiplere göre tamamen özel bir açılış ve oyun stili yaz.
  Rakiplerin ülkesine, bu ülkeyle tecrübesine, oyun tarzına (erken mi bitirir, uzun maçta mı güçlü, ortalama maç süresi) ve bize karşı geçmiş maçlarda bastıklarına (bizeKarsiAgirlikliOrdu, gecmisKarsilasmalar) göre şekillendir. Bir rakip erken baskıcıysa savunmayı, uzun maçta zayıfsa ekonomiyi ya da baskıyı buna göre ayarla.
  * ad: kısa build adı ("Kule savunmalı hızlı Kale").
  * oyunStili: maç boyu nasıl oynayacağım, 2-3 cümle (hangi birim kompozisyonu, ne zaman baskı, kime odaklan).
  * kilitNoktalar: 3-5 ölçülebilir zamanlama hedefi ("4:30 Feodal'e tıkla", "8:00'de 10 mızrakçı").
  * adimlar: Karanlık Çağ'dan Kale Çağı'na kadar 8-14 adım. Her adımda köylülerin o andaki tam dağılımı (yemek, odun, altin, tas, insaat sayıları; toplamı o andaki köylü sayısı) ve saniye (adımın yaklaşık oyun saniyesi). not: Türkçe, kısa ve somut: ne inşa edilecek, hangi binadan kaç birim, hangi teknoloji, hangi simge yapıyla (ulkeyeOzel.simgeYapilar) çağ atlanacak. Ülkenin özel başlangıcına uy.
- buildSecimi ve buildGerekcesi: "" (serbest modda hazır build seçilmez).` : '';
    return this.ask({
      effort: 'high',
      schema,
      content: [{
        type: 'text',
        text: `Maç yükleniyor. Aşağıdaki verilerle bu maç için oyun planı hazırla.
- ozet: 2-3 cümlelik net oyun planı (bizim takım ne yapmalı).
- rakipTahminleri: her rakip için büyük olasılıkla ne yapacağı (açılış, saldırı zamanı, birim seçimi), zamanlaması ve güven seviyesi. Geçmiş karşılaşmalar varsa onlara özellikle dayan.
- planAdimlari: maç içinde benim (ben alanındaki oyuncu) için 4-7 zamanlı hatırlatma; dakika (ondalıklı olabilir) ve en fazla 6 kelimelik mesaj.
- kontraOnerisi: rakip ülke/oyun tarzlarına karşı hangi birimlere ağırlık vermeliyim.
- takimKoordinasyonu: takım arkadaşlarımla nasıl rol paylaşmalıyız.
Veride takimimiz varsa (bu maçtaki ekibin birlikte istatistikleri ve alışkanlıkları) planı ve rolleri ona göre kur: "tarz" olan alışkanlıklarımıza uygun plan yap, kazandığımız maç süresine (ör. uzun maçta güçlüysek oyunu uzat) ve bize kazandıran ülke kombinasyonlarına dikkat et.
Veride haritaVeMeta (AoE4World'ün son yamalardaki istatistikleri: haritanın ortalama maç süresi, bu haritada en çok kazanan ülkeler, ülkelerin kazanma oranları) ve internettenArastirma (güncel strateji özeti) varsa planı, kontrayı ve build'i haritaya ve güncel metaya göre kur; ör. kısa maçların haritasında erken savunma, uzun maçların haritasında ekonomi.
- buildSecimi: buildSecenekleri verildiyse rakiplere ve haritaya en uygun build'in id'si (listeden aynen); verilmediyse "". Sadece ülkeye değil her rakibin oyun tarzına, bu ülkeyle tecrübesine, ortalama maç süresine ve bize karşı geçmiş maçlarda ağırlıklı ne bastığına (bizeKarsiAgirlikliOrdu, gecmisKarsilasmalar) bak; ör. geçmişte atlıyla erken geldiyse mızrakçı/kule içeren açılışı seç.
- buildGerekcesi: seçimin tek cümlelik nedeni, hangi rakip verisine dayandığını söyleyerek (ör. "KEYI bize karşı 2 maçta 6. dk atlı baskını yaptı: kule açılışı"); seçim yoksa "".${customText}

Veri:
${JSON.stringify(context)}`,
      }],
    });
  }

  // Maç içi anlık değerlendirme. images: [{ data (base64), mediaType, label }] — ilki tam ekran,
  // varsa ikincisi mini haritanın yakın görüntüsü. combat: savaş modu (sadece çatışmayı yönet).
  // command: yönet modu (oyuncu koçun aracı; her bakışta sıralı komutlar).
  liveAssessment(context, images = [], { combat = false, command = false } = {}) {
    const content = images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } }));
    const seen = images.length ? `Görüntüler sırasıyla: ${images.map((img, i) => `${i + 1}) ${img.label}`).join(', ')}. ` : '';
    const mode = combat
      ? `SAVAŞ MODU: oyuncu şu an çatışmada ya da baskı altında (tetik: ${context.tetik || 'kayıp/düşman algılandı'}). Sadece çatışmayı yönet: savaş mı geri çekilme mi, köylüleri garnizona/merkeze al, kule/duvar, kontra birim, takımdan yardım. Ekonomi ve çağ atlama tavsiyesi verme; gelistir sadece savaşı etkileyen bir geliştirmeyse dolu olsun. uyari boş kalamaz.`
      : 'Normal mod: ekonomi, üretim ve zamanlamayı yönet; tehlike varsa onu öne al.';
    const commandMode = command
      ? `YÖNET MODU: oyuncu senin aracın; kendi karar vermez, sadece senin komutlarını uygular. Her bakışta komutlar alanına 2-4 sıralı, hemen uygulanabilir komut yaz (her biri en fazla 9 kelime, sayılı ve somut):
  * insaat: hangi binayı nereye/kaç tane ("2. ev ve kışla kur", "Odun kampını ormana taşı").
  * uretim: hangi binadan hangi birimden kaç tane ("Ahırdan 6 atlı bas").
  * arastirma: hangi binada hangi teknoloji ("Değirmende Tekerlekli El Arabası araştır").
  * cag: çağ atlarken hangi simge yapıyla (ulkeyeOzel.simgeYapilar'dan) ve ne zaman ("Feodal: Jiangnan Kulesi kur, 4:30'da"). Rakiplere göre seç: baskı bekleniyorsa savunma veren simge yapı.
  * askeri: baskın/savunma emri: hedef, birim ve sayı ("6 atlıyla kırmızının altın madenine baskın", "Okçuları kasaba merkezine çek").
  * ekonomi: köylü dışındaki ekonomi işleri (çiftlik, tüccar, ikinci kasaba merkezi).
  Rakibin ülkesine, görülen ordusuna ve geçmişine göre şekil al; build order sürüyorsa ondan sapma gerekiyorsa açıkça söyle. simdiYap'ı da komutların ilkiyle aynı tut.`
      : 'komutlar: [] (normal mod).';
    content.push({
      type: 'text',
      text: `Maç sürüyor. ${seen}Sen kontrolcü bir koçsun: her zaman somut emir ver; oyuncu senin dediğini yapacak.
${mode}
${commandMode}
- okunanKoylu: "sol alttaki kaynak paneli" görüntüsünde her kaynak satırının sağında yazan köylü sayıları ve boştaki köylü (yemek, odun, altin, tas, bosta). Tahmin etme, gördüğünü yaz; görüntü yoksa ya da okunamıyorsa hepsi 0.
- dagilim: köylülerin şu an olması gereken dağılımı (yemek/odun/altın/taş köylü sayısı). Toplamı okunanKoylu toplamına (ekrandanOkunan.toplamKoylu varsa ona) eşit olsun. Köylü dağılım sayılarını simdiYap ya da komut metinlerine yazma; uygulama onları dagilim'dan kendisi hesaplar. Savaşta ya da emin değilsen hepsi 0.
- uyari: oyuncunun ekranında köşede duracak tek not, en fazla 6 kelime. Gerçek bir risk ya da kritik eksik varsa yaz; yön biliniyorsa oyuncunun yapısına göre ekle (ör. "Rakip gelebilir · değirmen tarafından", "Baskın · altın madeninde", "Altın bitiyor"); yoksa "".
- uyariTuru: uyarının türü. "gercek" SADECE saldırıyı/düşmanı şu an gerçekten görüyorsan (tam ekranda ya da mini haritada düşman askeri, ölen birim) ya da olaylar listesinde kayıp/üssünde düşman varsa. Rakip profili, süre ya da plana dayanan her şey "tahmin"tir; tahmini olmuş gibi yazma ("Baskın · altın madeninde" değil "Baskın gelebilir · altın madeni"). Takım arkadaşlarının risk notları onların koçunun tahminidir; kendi gözünle görmediysen "gercek" sayma. Oyuncunun kendi eksiği (ev, boşta köylü, kaynak bitiyor) "eksik"; uyarı yoksa "yok".
- durum: tek kısa cümle.
- simdiYap: en fazla 3 madde, her biri en fazla 6 kelime, somut ("Kışla kur", "Ahırdan 4 atlı bas").
- uret: en fazla 2 madde, her biri en fazla 7 kelime: hangi binadan hangi birimden kaç tane ("Okçu atölyesinden 6 okçu", "2. kışla kur, mızrakçı bas"). Rakiplerin ülkesine ve görülen ordusuna karşı kontra seç. Gerekmiyorsa [].
- gelistir: şu an alınması gereken tek geliştirme ve binası ("Demirci: Erken Koşum"); yoksa "".
- tahmin: rakiplerin önümüzdeki 2-3 dakikada büyük olasılıkla ne yapacağı.
- risk: şu anki tehlike seviyesi.
- sonrakiHedef: bir sonraki hedef ve zamanı.
- gozlem: tam ekranda gördüklerin. ekranKimin: ekrandaki bölge kimin (oyuncunun rengi: ${context.renkim || 'bilinmiyor'}; takım arkadaşının ya da rakibin üssüne bakıyorsa ona göre). binalar, gelistirmeler ve ordu sadece ekranKimin "benim" iken ve ekranda gerçekten görüyorsan dolu olsun (ordu: "8 okçu" gibi). cag: sağdaki oyuncu listesinde oyuncunun kendi satırında yazan çağ (1-4), göremiyorsan 0.

Verilerin anlamı:
- buildAdimi.notlar: seçili build order'ın şimdiki adımı; sonrakiAdimlar: sıradakiler. Build sürüyorsa emirlerin bu adımlarla uyumlu olsun. buildBitti true ise ülkenin çağına göre kendi planını kur.
- usDefteri: maç boyunca oyuncunun kendi üssünde görülenler ve build'e göre yapılmış olması gerekenler. Bir şey şu anki görüntüde yok diye "yok" sayma.
- olaylar: yerel algılayıcıların son olayları (mini harita düşman görüşleri, nüfus/köylü kaybı, çağ atlamaları). Bunlar kesin bilgidir; önceliği bunlara ver.
- haritadaGorulenler: son 90 saniyede mini haritada görülen düşmanlar (kısa süre görünüp kaybolanlar dahil).
- ulkeyeOzel: oyuncunun ülkesine özel birim, teknoloji ve binalar (çağ numarasıyla); simgeYapilar: çağ atlamak için kurulabilecek simge yapılar (hangi çağa geçirdiği).
- haritaVeMeta: harita, güncel meta (ülkelerin kazanma oranları) ve internetten araştırma özeti. Taktiği haritaya göre ayarla: dar geçit/kapalı haritada duvar ve kule, açık haritada baskın ve harita kontrolü, su varsa liman, kutsal yer ve ticaret fırsatları.

Veri:
${JSON.stringify(context)}`,
    });
    return this.ask({ effort: 'low', schema: SCHEMAS.live, content, maxTokens: 5000, fast: combat });
  }

  // İnternetten maç öncesi araştırma (Google Arama destekli sağlayıcıda). Dönen: { text, sources } ya da null.
  async research({ mapName, kind, myCiv, enemyCivs, allyCivs }) {
    const provider = this.getProvider();
    if (!provider?.completeText || provider.name !== 'Gemini') return null;
    const prompt = `Age of Empires IV, güncel yama. ${kind || 'takım'} sıralı maç.
Harita: ${mapName || 'bilinmiyor'} (Türkçe adıysa İngilizce karşılığını da düşün).
Benim ülkem: ${myCiv || 'bilinmiyor'}. Takım arkadaşlarım: ${allyCivs.join(', ') || '-'}. Rakipler: ${enemyCivs.join(', ') || '-'}.
İnternette ara ve Türkçe, en fazla 12 kısa maddeyle özetle:
1) Haritanın özellikleri: açık/kapalı, su, kutsal yerler, ticaret, ormanlar, dar geçitler, kaynak dağılımı; bu haritada genelde hangi oyun tarzı kazanır.
2) Benim ülkemle bu harita ve bu rakiplere karşı güncel güçlü açılış ve oyun planı.
3) Rakip ülkelerin bilinen güçlü zamanlamaları ve bunlara kontra.
4) Son yamada bu ülkeleri etkileyen önemli değişiklikler (biliyorsan).
Sadece emin olduğun bilgileri yaz.`;
    return provider.completeText({ system: SYSTEM, messages: [{ role: 'user', text: prompt }], search: true, requireSearch: true });
  }

  // Oyuncunun maçlarından hatalar, oyun tarzı, ulus önerisi ve takım kompozisyonu.
  playerReview(context) {
    return this.ask({
      effort: 'high',
      schema: SCHEMAS.review,
      content: [{
        type: 'text',
        text: `Aşağıda benim (ben alanındaki oyuncu) maç verilerim var: uygulamanın kaydettiği maçların kayıt analizleri (çağ zamanları, kasaba merkezinin boş kaldığı süre, köylü sayısı, ilk asker, ordu, APM, otomatik tespitler), AoE4World'deki halka açık geçmişim (ülke bazında kazanma oranları, kısa/uzun maç başarısı) ve güncel meta. Takım arkadaşlarımın geçmişi de var.
Profesyonel bir koç gibi analiz et:
- ozet: 2-3 cümle.
- oyunTarzi: nasıl oynamaya çalışıyorum (erken baskı mı, ekonomi mi, hangi birimler), verilerle.
- gucluYonler: 2-4 madde.
- tekrarlayanHatalar: 3-5 hata; her birinde hata, kanit (sayılarla, hangi maçlarda) ve cozum (somut, ölçülebilir).
- ulusOnerileri: oyun tarzıma ve güncel metaya uyan 2-3 ülke; neden (verilerime dayanarak) ve nasilOyna (açılış ve plan, kısa).
- takimKompozisyonu: takım arkadaşlarımla birlikte (geçmişleri verildiyse) hangi ülke dağılımı ve roller (biri baskıcı, biri ekonomi gibi).
- calismaPlani: önümüzdeki maçlar için 3 pratik çalışma.
Veri az ise bunu söyle ve buna göre temkinli ol; uydurma.

Veri:
${JSON.stringify(context)}`,
      }],
    });
  }

  // Takımın tarzına, ikili/üçlü istatistiklerine ve haritanın (seviyeye göre) metasına uyan ülkeler.
  civAdvice(context) {
    return this.ask({
      effort: 'high',
      schema: SCHEMAS.civAdvice,
      content: [{
        type: 'text',
        text: `Biz sabit bir ekibiz (uyeler). Sıralı maçta ülkeyi ulus seçme ekranında, haritayı görerek ama rakipleri görmeden seçiyoruz. Aşağıdaki verilerle havuzdaki her harita için her birimize ülke öner.
Veri:
- takim: AoE4World geçmişimizden ikili ve üçlü istatistikler (birlikte kazanma oranı, süreye göre başarı, en iyi/kötü haritalar, en çok kazandıran ülke kombinasyonları) ve takım maçlarında her birimizin ülke tercihleri.
- aliskanliklar: maç kayıtlarından her birimizin alışkanlıkları; "tarz" olanlar bizim oynamak istediğimiz şekildir (inatla yapıyoruz ve kazandığımız maçlarda da var): ÖNERİLERİN BU TARZA UYSUN. "hata" olanları ülke seçimiyle telafi edebiliyorsan söyle.
- meta: seviyemizdeki (ve bir üst seviyedeki) güncel yama istatistikleri; her harita için o seviyede en çok kazanan ülkeler ve maçların ortalama süresi.
Kurallar:
- Önce kendi verimize dayan: bize özel kazandıran kombinasyonlar ve rahat ettiğimiz ülkeler metadan önce gelir; meta, eşit durumda ya da verimiz azken belirleyici olsun.
- Her harita için her üyeye bir ülke ver: oyuncu (adı aynen), ulus (Türkçe adı), rol (ör. "erken baskı", "ekonomi/geç oyun", "destek/okçu", "su"), neden (tek cümle, hangi veriye dayandığını söyle).
- plan: o haritada takım olarak tek cümlelik oyun planı.
- takimKimligi: 2-3 cümle; bizim takım olarak kimliğimiz (nasıl kazanıyoruz, nerede zorlanıyoruz, ikili dinamiklerimiz).
- Az veri varsa temkinli ol ve bunu nedenlerde belirt; uydurma.

${JSON.stringify(context)}`,
      }],
    });
  }

  // Ulus seçme ekranındaki harita adını okur; maps: havuzdaki haritalar (İngilizce ad, bilinen Türkçe karşılığıyla).
  identifyMap(image, maps) {
    return this.ask({
      effort: 'low',
      fast: true,
      schema: SCHEMAS.mapPick,
      maxTokens: 1000,
      content: [
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
        { type: 'text', text: `Bu Age of Empires IV ekranında (büyük olasılıkla ulus seçme ekranı) seçilen haritanın adı yazıyor olabilir. ekrandakiAd: ekranda yazan harita adı (yoksa ""). harita: bu listeden eşleşen adı aynen yaz; eşleşme yoksa ya da ekranda harita yoksa "". Liste: ${JSON.stringify(maps)}` },
      ],
    });
  }

  // Sohbet. history: [{ role: 'user' | 'assistant', text }] (sonuncusu yeni soru). Dönen: { text, sources }
  async chat(history, context) {
    const provider = this.getProvider();
    if (!provider) throw new AiError('Yapay zekâ sağlayıcısı seçilmemiş');
    const first = { role: 'user', text: `Oyuncu verisi (cevaplarında kullan):\n${JSON.stringify(context)}` };
    const ack = { role: 'assistant', text: 'Tamam, verilerini okudum.' };
    return provider.completeText({ system: CHAT_SYSTEM, messages: [first, ack, ...history], search: true });
  }

  // Sağdaki oyuncu listesini okur: her oyuncunun satırı, rengi ve çağı. image: { data, mediaType }
  identifyPlayers(players, image, rowCount = 0) {
    return this.ask({
      effort: 'low',
      fast: true,
      schema: SCHEMAS.players,
      maxTokens: 2000,
      content: [
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
        {
          type: 'text',
          text: `Görüntü Age of Empires IV'te ekranın sağındaki oyuncu listesini içeriyor ("İsim | II. Çağ" satırları; isimler oyuncu renginde yazılı).${rowCount ? ` Listede ${rowCount} satır var.` : ''}
Aşağıdaki her oyuncu için: satir (yukarıdan 1'den başlayarak; bulamazsan 0), renk (isminin yazıldığı renk; emin değilsen "bilinmiyor") ve cag (satırda yazan çağ 1-4; okuyamazsan 0). oyuncu alanına adı aynen yaz. İsimler kısaltılmış olabilir ("..." ile biter).
Oyuncular: ${JSON.stringify(players)}`,
        },
      ],
    });
  }

  // Maç sonu: profesyonel koç raporu.
  postgameReport(context) {
    return this.ask({
      effort: 'high',
      schema: SCHEMAS.report,
      content: [{
        type: 'text',
        text: `Maç bitti. Kayıt dosyasından çıkarılan verilerle bana (ben alanındaki oyuncu) profesyonel bir maç sonu raporu yaz.
- ozet: 2-3 cümle; maçın hikâyesi.
- neden: kazanma/kaybetmenin 2-4 temel nedeni, sayılarla.
- oncelikler: bir sonraki maç için tam 3 öncelik; her birinde ölçülebilir hedef (olcut, ör. "ilk 10 dk merkez boşta < 0:30").
- antrenman: 2-3 pratik çalışma önerisi.
- rakipNotlari: rakipler hakkında bir dahaki karşılaşma için akılda tutulacaklar.
- tahminDegerlendirmesi: maç öncesi tahminler varsa ne kadar tuttu; yoksa "Maç öncesi tahmin yoktu".
- gelecekMac: gelişim verime bakarak bir sonraki maçlarda beni bekleyen en büyük fırsat.

Veri:
${JSON.stringify(context)}`,
      }],
    });
  }

  // Build notlarını Türkçeye çevirir; @klasör/dosya.webp@ ikon belirteçleri aynen korunur.
  async translateBuild(build) {
    const out = await this.ask({
      effort: 'low',
      schema: SCHEMAS.translate,
      content: [{
        type: 'text',
        text: `Aşağıdaki Age of Empires IV build order notlarını doğal, kısa Türkçeye çevir. "@...@" arasındaki ikon belirteçlerine ve HTML varlıklarına (&gt; gibi) kesinlikle dokunma, yerlerini koru. Adım ve not sayısı aynı kalsın.
${JSON.stringify(build.steps.map((s) => ({ notlar: s.notes })))}`,
      }],
    });
    if (!Array.isArray(out.adimlar) || out.adimlar.length !== build.steps.length) throw new AiError('Çeviri adım sayısı tutmadı');
    return {
      ...build,
      translated: true,
      steps: build.steps.map((s, i) => {
        const notes = out.adimlar[i].notlar;
        const sameTokens = (a, b) => (a.match(/@[^@]+@/g) || []).join() === (b.match(/@[^@]+@/g) || []).join();
        const ok = notes.length === s.notes.length && notes.every((n, j) => sameTokens(n, s.notes[j]));
        return ok ? { ...s, notes } : s;
      }),
    };
  }

  async testConnection() {
    const r = await this.ask({
      effort: 'low',
      schema: obj({ tamam: { type: 'boolean' } }),
      content: [{ type: 'text', text: 'Bağlantı testi: tamam alanını true döndür.' }],
      maxTokens: 1000,
    });
    return r.tamam === true;
  }
}

module.exports = { AiCoach, AiError, ClaudeProvider, GeminiProvider, geminiText, geminiSources, SCHEMAS, MODEL, GEMINI_MODEL };
