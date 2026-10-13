# Age of Koçu — Geliştirme Önerileri

Uygulama 0.6.x'te analiz odaklı bir yöne dönmüş. Öneriler bu yöne göre, en çok fark yaratacaklar başta olacak şekilde sıralandı.

## 1. Analizi daha işe yarar yapmak (asıl odak)

### a) Plan ile gerçek karşılaştırması
`analysis.js` içindeki `coachFindings` zaten `build` alıyor. Bu, adım adım bir tabloya çevrilebilir:

| Adım | Plan | Sen | Fark |
|---|---|---|---|
| 2. ev | 1:40 | 2:25 | +45 sn |
| Feodal | 4:30 | 5:12 | +42 sn |

Oyuncu hangi adımda kaydığını tam olarak görür.

### b) Unutulan gelişimler listesi
`ecoTechs` şu an sadece listeleniyor. Bunu "olması gereken" bir listeyle karşılaştır: el arabası (Wheelbarrow), Feodal'de odun ve altın gelişimleri, demirci gelişimleri.
Örnek çıktı: *"Kale çağında 6 dakika kaldın ama demirciden hiç gelişim almadın."*
Kayıt dosyası araştırma komutlarını içeriyor, yani ekstra veri gerekmez.

### c) Etkileşimli zaman çizelgesi
`chart.js` üzerinde köylü ve asker serilerinin üstüne şunlar işaretlenir:
- çağ atlamaları
- kasaba merkezinin boşta kaldığı aralıklar
- ilk askeri bina
- rakibin ilk saldırısı

Grafikte bir yere tıklayınca o anın tespiti açılır.

### d) Kendi en iyi maçınla kıyas
*"Bu ülkeyle en iyi maçında 10. dakikada 48 köylün vardı, bu maçta 36."*
Kıyası kendi geçmişinle yapmak, genel bir ortalamayla yapmaktan daha motive edici.

## 2. Gelişimi oyunlaştırmak

- **Maç hedefi:** Maç sonu raporu tek bir ölçülebilir hedef koysun (örneğin "10. dakikada 40 köylü"). Bir sonraki maçta bu hedef kendiliğinden kontrol edilsin: ✅ / ❌.
- **Seri ve rozetler:** "3 maç üst üste kasaba merkezi boşta kalma süresi 30 saniyenin altında", "İlk kez 5:00'ten önce Feodal".
- **Haftalık özet kartı:** Haftanın en büyük gelişimi, tekrarlayan tek hata, önümüzdeki haftanın odağı. Ekiple paylaşılabilir.

## 3. Ürün ve deneyim

- **YZ'siz uyarıları ayır:** Ekran okuma (OCR) uyarıları ("Ev kur 19/20", "2 köylü boşta") YZ kullanmıyor, ama şu an canlı koç kapalıyken onlar da kapalı görünüyor. Bunlar "Canlı YZ koç"tan ayrı, varsayılan açık bir seçenek olursa Gemini kotası sorunu bu özellikleri etkilemez.
- **Analizi bekletme:** Önce hesapla çıkan tespitleri hemen göster, YZ raporu arkadan yüklensin ("YZ raporu hazırlanıyor…").
- **Tekrar izleme ipucu:** Önemli anları "oyunun replay'inde 7:20'ye bak" şeklinde zaman damgasıyla listele.

## 4. Kod tarafında

- **Bölme:** `main.js` (2239 satır) ve `dashboard.js` (1259 satır) çok büyük. YZ akışları, sohbet, takım ve IPC ayrı modüllere bölünürse yeni özellik eklemek kolaylaşır.
- **Test:** En değerli kısım olan `analysis.js` ve `postgame.js`'in test dosyası yok. Analiz özelliklerinden önce gerçek bir `.rec` örneğiyle test eklemek iyi olur.

## Önerilen sıra

1. Plan ile gerçek karşılaştırması (1a)
2. Unutulan gelişimler (1b)
3. Maç hedefi ve sonraki maçta kontrolü (2)

Üçü de mevcut kayıt verisiyle yapılabilir ve maç sonu ekranını belirgin şekilde zenginleştirir.
