# Age of Koçu

Age of Empires IV için Türkçe maç koçu.

**Odak: analiz ve öğrenme.** Oyun içinde sadece seçtiğin build'in başlangıcı görünür; asıl iş maç sonunda: hataların, eksiklerin, maça ve takıma katkın.

- **Oyun içi build paneli:** Build Order'dan güncel sezonun hazır başlangıçlarından birini seç; maçta panel adım adım ne yapacağını, köylü dağılımını ve hedef süreyi gösterir. Başlangıç bitince (son adımdan 60 sn sonra ya da ekran okuma açıksa köylü sayın son adımı geçince) "Başlangıç bitti" deyip çekilir. YZ ve ekran görüntüsü kullanılmaz.
- **Takıma katkı (Maç Analizi):** Her takım arkadaşının ekonomi ve ordu payı, rolü (orduyu taşıyan, ekonomi, erken baskı), Feodal'e takıma göre ne zaman geçtiği, rakibin ağırlıklı birimine karşı kontra payı ve eksikleri.
- **Canlı koç (deneysel, varsayılan kapalı):** Maç içi YZ uyarıları, yönet modu, mini harita/kayıp algılama, ulus seçme ekranı önerisi. Ücretsiz Gemini kotasıyla güvenilir çalışmadığı için kapalı; Ayarlar › Yapay Zekâ Koç › Canlı koç ile açılır. Aşağıdaki maç içi özellikler sadece açıkken çalışır.
- **Maç öncesi:** Yükleme ekranında rakiplerin AoE4World'deki halka açık geçmişinden oyun tarzı çıkarılır: favori ülke, erken baskıcı mı, uzun maçta zayıf mı, form durumu.
- **Maç içi:** Ülkene göre seçtiğin build order adım adım, sayılarla okunur ("11 köylü: 7 yemek, 2 odun, 2 altın"). Rakip analizine göre zamanlı uyarılar gelir.
- **Ekran okuma:** Maç sırasında saniyede bir kendi ekranındaki kaynaklar, köylü dağılımı, nüfus ve boştaki köylüler okunur (OCR, internetsiz). "Oduna 3 köylü daha", "Ev kur: nüfus 19/20", "2 köylü boşta", "Köylü üretimi durdu" gibi anlık uyarılar gelir; build adımı gerçek köylü sayısına göre ilerler.
- **Yönet modu (Ctrl+Alt+N ya da panelin sağ üstü):** Koç seni yönetir: 45 saniyede bir sıralı komut verir (ne inşa edilecek, hangi binadan kaç birim, hangi araştırma, hangi simge yapıyla ne zaman çağ atlanacak, nereye kaç birimle baskın). Köylü dağılımı her zaman gerçek köylü sayına oturtulur, toplam tutar. Normal mod (uyarı ve öneri) varsayılandır.
- **Otomatik build:** Build Order sayfasında "Otomatik" seçilirse koç yükleme ekranında her rakibin ülkesine, o ülkeyle tecrübesine, oyun tarzına (erken mi bitirir, uzun maçta mı güçlü, ortalama maç süresi) ve bize karşı geçmiş maçlarda ağırlıklı ne bastığına bakıp hazır build'lerden birini seçer (YZ yoksa erken baskıcıya karşı savunmalı açılış).
- **Serbest build:** Koç hazır build kullanmaz; bu maçın rakiplerine göre tamamen özel bir açılış (adım adım köylü dağılımı, binalar, simge yapıyla çağ atlama) ve maç boyu oyun stili yazar; canlı koç da bu stile göre yönetir.
- **Harita ve güncel meta:** Yükleme ekranında koç haritayı tanır ve AoE4World'ün son yamalardaki istatistiklerine bakar (bu haritada maçlar ortalama kaç dakika sürüyor, hangi ülkeler kazanıyor, senin ve rakiplerinin ülkelerinin kazanma oranı). Gemini ile internetten haritaya ve ülkelere göre güncel strateji araştırır (aynı harita/ülkeler için 3 gün saklanır). Plan, build seçimi ve canlı koç buna göre şekillenir.
- **Takımımız:** Ekip (seninle en sık oynayan 2 oyuncu) AoE4World geçmişinden kendiliğinden bulunur. Her ikili ve üçlü için birlikte kazanma oranı, süreye göre başarı, en iyi/kötü haritalar ve kazandıran ülke kombinasyonları; maç kayıtlarından her oyuncunun alışkanlıkları ve bunların **tarz** mı (kazanılan maçlarda da var) **hata** mı (kayıplarda belirgin sık) olduğu.
- **Ulus önerisi:** Havuzdaki her harita için ekibin her üyesine ülke ve rol; ekibin tarzına, ikili/üçlü istatistiklerine ve seviyenizdeki (ve bir üst seviyedeki) güncel metaya göre. Öneri takım sunucusunda ekipçe ortak saklanır (3 gün): ilk hesaplayanın önerisini herkes görür, "yenile"ye basan herkes için yeniler; seviye takımın ortalama puanından. Eşleşme bulununca ulus seçme ekranındaki harita okunur ve öneri oyunun üstünde görünür.
- **Koça Sor (sohbet):** Panelden koça soru sor ("Son maçta neden kaybettik?", "Fransızlara karşı ne açmalıyım?"). Koç maç geçmişini, kayıt analizlerini, gelişim raporunu ve (maçtaysan) şu anki maçı bilir; gerekirse internette arar. Sohbet uygulamayla bağlı: "bana uygun bir başlangıç seç" dersen Build Order'dan güncel sezonun build'lerinden birini önerir, "bana özel açılış yap" dersen maçlarına göre ilk ~10 dakikalık bir açılış yazar; "Bunu kullan" / "Build Order'a ekle ve kullan" ile oyun içi panelde görünür. Cevaplardaki kalın yazı ve listeler biçimli görünür; koç cevabın sonunda işine yarayacak takip önerileri sunar ("Buna göre bana özel açılış hazırla"), tek tıkla sorulur.
- **Build Order listesi:** Her build'in kısa açıklaması ve etiketleri (Hızlı Kale, Erken baskı, Ekonomi, Kule…) görünür; koçun yazdığı özel build'ler "Sana özel" etiketiyle en üstte durur ve silinebilir.
- **Gelişim analizi (Profilim):** Koç kaydedilen maçlarına ve AoE4World geçmişine bakıp oyun tarzını, tekrarlayan hatalarını (kanıtıyla), sana uyan ülkeleri ve takım arkadaşlarınla kompozisyonu çıkarır.
- **Mini harita ve oyuncu listesi:** Kalibrasyonda işaretlenirse saniyede bir renkleri okunur (internetsiz). Mini haritada üssüne giren, sana ya da baskın birliğine yaklaşan, kısa süre görünüp kaybolan düşmanlar ve takım arkadaşının üssüne giren düşman anında not olur ("Üssüne saldırı · batı tarafı", "Ordu sana geliyor · güneydoğudan"). Oyuncu listesinden renkler, rakipler (⚔) ve çağ atlamaları anlaşılır. Yalnızca oyunun sana zaten gösterdiği bilgi kullanılır.
- **Sade overlay:** Oyunda sol üstte sadece eksikler ve riskler kısa notlar halinde görünür ("Ev kur (19/20)", "2 köylü boşta", "Rakip gelebilir · sol"). Not, durum sürdükçe kalır; tehlike kırmızıdır. Ayarlar'dan detaylı moda geçilebilir.
- **Takım senkronu:** Kurulum gerekmez: maç başlayınca aynı takımdaki Age of Koçu kullanıcıları ücretsiz bir Cloudflare Worker odası (`server/team-room`) üzerinden kendiliğinden bağlanır. Herkes takımın köylü/nüfus/kaynak durumunu ve uyarılarını görür; Ctrl+Alt+Y yardım çağrısı yollar. İsteğe bağlı gizli takım kodu, odayı rakibe karşı tamamen kapatır.
- **Yapay zekâ koç (Claude):** Maç öncesi rakip profilleri, rakip defteri (geçmiş karşılaşmalar) ve senin gelişim verinden oyun planı + rakip tahminleri + dakikalı plan çıkarır; maç içinde ekranına ve mini haritaya bakıp "şimdi yap", "üret" (hangi binadan kaç birim) ve "geliştir" emirleri, rakip tahmini ve risk verir. Sakin anlarda birkaç dakikada bir bakar; önemli anda (kayıp, üssünde düşman, ordu yaklaşıyor, çağ atlama) beklemeden bakar, savaşta 30 saniyede bir bakar ve sadece çatışmayı yönetir. Kendi üssünde gördüklerini maç boyunca hatırlar (üs defteri), takım arkadaşının üssüne bakarken onu senin üssün sanmaz; maç sonunda ölçülebilir hedefli profesyonel rapor yazar ve maç öncesi tahminlerinin tuttuğunu kontrol eder. Build notlarını Türkçeleştirir. Sağlayıcı seçilebilir: **Google Gemini** (varsayılan, ücretsiz katman; anahtar aistudio.google.com/apikey) ya da **Claude** (kredi ile). Anahtar Ayarlar › Yapay Zekâ Koç bölümüne girilir ve bilgisayarda Windows şifrelemesiyle saklanır.
- **Maç sonrası:** Maç bitince oyunun kayıt dosyası (`temp.rec`) ayrıştırılır: çağ atlama zamanları, kasaba merkezinin boşta kaldığı süre, dakika dakika köylü/asker üretimi, ordu kompozisyonu ve rakiplerle kıyas. Koç bunlardan Türkçe tespitler çıkarır; Profilim sekmesi maçlar arası gelişimi gösterir.

**Adil oyun:** Oyun belleği okunmaz, maç sırasında rakip hakkında gizli bilgi kullanılmaz. Ekran okuma sadece senin ekranını (HUD, mini harita, oyuncu listesi) okur. Kayıt dosyası rakip komutlarını da içerdiği için **yalnızca maç bittikten sonra** okunur. Rakip analizi halka açık AoE4World verisiyle yapılır.

## Kurulum (oyuncular)

1. `Age of Koçu Setup x.y.z.exe` dosyasını çalıştır. Windows "bilinmeyen yayıncı" uyarısı verirse *Ek bilgi › Yine de çalıştır*.
2. AoE4 › Ayarlar › Grafik › **Ekran Modu: Tam Ekran Pencereli** (yoksa overlay oyunun üstünde görünmez).
3. Age of Koçu'yu açık bırakıp ranked maça gir. Profilin otomatik bulunur.
4. Ekran okuma için bir kerelik kalibrasyon: herhangi bir maçta **Ctrl+Alt+K**'ya bas, panelde *Ekran Okuma* sekmesinde her sayının etrafına kutu çiz; isteğe bağlı olarak mini haritanın ve sağdaki oyuncu listesinin (oyunda açık olmalı) etrafına da. *Test et* › *Kaydet*.

### Oyun içi kısayollar

| Kısayol | İşlev |
|---|---|
| Ctrl+Alt+→ / ← | Build adımı ileri / geri |
| Ctrl+Alt+↑ / ↓ | Koç saatini ±10 sn (oyun duraklatıldıysa) |
| Ctrl+Alt+R | Rakip kartlarını göster / gizle |
| Ctrl+Alt+O | Overlay'i aç / kapat |
| Ctrl+Alt+K | Ekran okuma kalibrasyonu için ekran görüntüsü |
| Ctrl+Alt+Y | Takıma yardım çağrısı |
| Ctrl+Alt+A | Koça sor: YZ ekranına bakıp hemen değerlendirir |
| Ctrl+Alt+N | Koç modu: Normal ↔ Yönet |

## Geliştirme

```bash
npm install
npm start        # uygulamayı çalıştır
npm test         # birim testleri
npm run dist     # dist/ altına Windows kurulum dosyası
node scripts/build-gamedata.js   # yeni yama/ülke gelince oyun verisi tablosunu yenile
```

| Dosya | Görev |
|---|---|
| `src/main/logWatcher.js` | `warnings.log` takibi: maç ID, oyuncular, başlangıç/bitiş, sonuçlar |
| `src/main/scout.js` | AoE4World maç geçmişinden oyuncu profili ve Türkçe notlar |
| `src/main/aoe4guides.js` | Topluluk build order'ları (diskte önbelleklenir) |
| `src/main/coach.js` | Build adımlarını zamanlama (saat ya da okunan köylü sayısı), zamanlı uyarılar |
| `src/main/screenReader.js`, `ocr.js`, `imageops.js` | Ekran yakalama, ön işleme, tesseract.js ile rakam okuma |
| `src/main/hud.js` | Okunan HUD değerlerini yumuşatma ve anlık koç kuralları |
| `src/main/minimap.js` | Mini harita ve oyuncu listesi renk analizi: düşman görüşleri, ordu yaklaşması, rakip satırları |
| `src/main/squad.js` | Ekip analizi: ikili/üçlü istatistikler, alışkanlıkların tarz/hata ayrımı |
| `src/main/meta.js` | Harita adı eşleştirme ve AoE4World meta özeti (ülke/harita kazanma oranları) |
| `src/main/log.js` | Kalıcı günlük (`%APPDATA%\Age of Koçu\logs\kocu.log`) |
| `src/main/liveEvents.js` | Önemli an algılayıcı (kayıp, mini harita olayları, çağ değişimi) ve savaş modu |
| `src/main/baseLedger.js` | Üs defteri: maç boyunca kendi üssünde görülenler + build'e göre yapılmış olması gerekenler |
| `src/main/replay.js` | AoE4 `.rec` ayrıştırıcısı (biçim dosyanın başındaki yorumda) |
| `src/main/analysis.js` | Kayıttan oyuncu raporu ve Türkçe koç tespitleri |
| `src/main/aiCoach.js`, `aiContext.js` | Claude ile maç öncesi plan, canlı (görsel) değerlendirme, maç sonu rapor, build çevirisi; YZ'ye giden bağlam |
| `src/main/postgame.js` | Maç sonu kaydı bekleme, doğrulama, kopyalama, analiz |
| `src/main/data/gamedata.json` | pbgid → birim/bina/teknoloji tablosu (data.aoe4world.com'dan üretilir) |
| `src/main/main.js` | Pencereler, kısayollar, olay akışı |
| `src/renderer/` | Panel (`dashboard/`) ve oyun üstü katman (`overlay/`) |
