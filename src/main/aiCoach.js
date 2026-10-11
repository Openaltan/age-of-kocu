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
  live: obj({
    uyari: str,
    durum: str,
    simdiYap: strArr,
    uret: strArr,
    gelistir: str,
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
};

class AiError extends Error {}

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

  async complete({ system, content, schema, effort, fast = false }) {
    const key = this.getApiKey();
    if (!key) throw new AiError('Gemini API anahtarı girilmemiş (Ayarlar › Yapay Zekâ Koç)');
    const input = content.map((c) => (c.type === 'image'
      ? { type: 'image', data: c.source.data, mime_type: c.source.media_type }
      : { type: 'text', text: c.text }));
    const base = {
      system_instruction: system,
      input,
      response_format: { type: 'text', mime_type: 'application/json', schema },
      ...(effort === 'low' ? { generation_config: { thinking_level: 'low' } } : {}),
    };
    // Her modeli 2 kez dene (503'te kısa bekleme); yoğun ya da kotası dolu modelden sonrakine geç.
    let res;
    // Savaş anında hız önemli: en hafif modelden başla.
    const models = fast ? [...this.models].reverse() : this.models;
    outer: for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, this.retryDelayMs));
        res = await this.post(key, { model, ...base });
        if (res.status === 429) break;
        if (res.status !== 503) break outer;
      }
    }
    const { data } = res;
    if (res.status === 503) throw new AiError('Google sunucuları şu an çok yoğun; biraz sonra tekrar dene');
    if (res.status === 429) throw new AiError('Gemini ücretsiz kotası tüm modellerde doldu; yarın sıfırlanır');
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new AiError(`Gemini isteği reddetti: ${data?.error?.message || res.status} (anahtarı kontrol et)`);
    }
    if (!res.ok) throw new AiError(`Gemini hatası ${res.status}: ${data?.error?.message || ''}`.trim());
    const text = geminiText(data);
    if (!text) throw new AiError('Gemini boş yanıt döndü');
    return text;
  }
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

  // Maç öncesi: oyun planı, rakip tahminleri ve dakikalı plan.
  prematchPlan(context) {
    return this.ask({
      effort: 'high',
      schema: SCHEMAS.plan,
      content: [{
        type: 'text',
        text: `Maç yükleniyor. Aşağıdaki verilerle bu maç için oyun planı hazırla.
- ozet: 2-3 cümlelik net oyun planı (bizim takım ne yapmalı).
- rakipTahminleri: her rakip için büyük olasılıkla ne yapacağı (açılış, saldırı zamanı, birim seçimi), zamanlaması ve güven seviyesi. Geçmiş karşılaşmalar varsa onlara özellikle dayan.
- planAdimlari: maç içinde benim (ben alanındaki oyuncu) için 4-7 zamanlı hatırlatma; dakika (ondalıklı olabilir) ve en fazla 6 kelimelik mesaj.
- kontraOnerisi: rakip ülke/oyun tarzlarına karşı hangi birimlere ağırlık vermeliyim.
- takimKoordinasyonu: takım arkadaşlarımla nasıl rol paylaşmalıyız.
- buildSecimi: buildSecenekleri verildiyse rakiplere ve haritaya en uygun build'in id'si (listeden aynen); verilmediyse "".
- buildGerekcesi: seçimin tek cümlelik nedeni (ör. "İki rakip erken baskıcı: savunmalı açılış"); seçim yoksa "".

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
- dagilim: köylülerin şu an olması gereken dağılımı (yemek/odun/altın/taş köylü sayısı). Toplamı ekrandan okunan toplam köylüye (yoksa tahminine) eşit olsun. Köylü dağılım sayılarını simdiYap ya da komut metinlerine yazma; uygulama onları dagilim'dan kendisi hesaplar. Savaşta ya da emin değilsen hepsi 0.
- uyari: oyuncunun ekranında köşede duracak tek not, en fazla 6 kelime. Gerçek bir risk ya da kritik eksik varsa yaz; yön biliniyorsa oyuncunun yapısına göre ekle (ör. "Rakip gelebilir · değirmen tarafından", "Baskın · altın madeninde", "Altın bitiyor"); yoksa "".
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

Veri:
${JSON.stringify(context)}`,
    });
    return this.ask({ effort: 'low', schema: SCHEMAS.live, content, maxTokens: 5000, fast: combat });
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

module.exports = { AiCoach, AiError, ClaudeProvider, GeminiProvider, geminiText, SCHEMAS, MODEL, GEMINI_MODEL };
