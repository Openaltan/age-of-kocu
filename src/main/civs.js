'use strict';

// Tek kaynak: her ülke için oyun log kodu, AoE4World slug'ı, aoe4guides kodu, gamedata.json ülke kodu ve Türkçe ad.
// Log kodu bilinmeyen yeni ülkeler maç sonrası AoE4World verisinden öğrenilir (learnLogCode).
const CIVS = [
  { slug: 'english', log: ['english'], guide: 'ENG', data: 'en', tr: 'İngilizler' },
  { slug: 'french', log: ['french'], guide: 'FRE', data: 'fr', tr: 'Fransızlar' },
  { slug: 'holy_roman_empire', log: ['hre'], guide: 'HRE', data: 'hr', tr: 'Kutsal Roma' },
  { slug: 'rus', log: ['rus'], guide: 'RUS', data: 'ru', tr: 'Ruslar' },
  { slug: 'mongols', log: ['mongol'], guide: 'MON', data: 'mo', tr: 'Moğollar' },
  { slug: 'chinese', log: ['chinese'], guide: 'CHI', data: 'ch', tr: 'Çinliler' },
  { slug: 'delhi_sultanate', log: ['sultanate'], guide: 'DEL', data: 'de', tr: 'Delhi Sultanlığı' },
  { slug: 'abbasid_dynasty', log: ['abbasid'], guide: 'ABB', data: 'ab', tr: 'Abbasiler' },
  { slug: 'ottomans', log: ['ottoman'], guide: 'OTT', data: 'ot', tr: 'Osmanlılar' },
  { slug: 'malians', log: ['malian'], guide: 'MAL', data: 'ma', tr: 'Malililer' },
  { slug: 'byzantines', log: ['byzantine'], guide: 'BYZ', data: 'by', tr: 'Bizanslılar' },
  { slug: 'japanese', log: ['japanese'], guide: 'JAP', data: 'ja', tr: 'Japonlar' },
  { slug: 'ayyubids', log: ['abbasid_ha_01'], guide: 'AYY', data: 'ay', tr: 'Eyyubiler' },
  { slug: 'jeanne_darc', log: ['french_ha_01'], guide: 'JDA', data: 'je', tr: "Jeanne d'Arc" },
  { slug: 'order_of_the_dragon', log: ['hre_ha_01'], guide: 'DRA', data: 'od', tr: 'Ejderha Tarikatı' },
  { slug: 'zhu_xis_legacy', log: ['chinese_ha_01'], guide: 'ZXL', data: 'zx', tr: "Zhu Xi'nin Mirası" },
  { slug: 'house_of_lancaster', log: [], guide: 'HOL', data: 'hl', tr: 'Lancaster Hanedanı' },
  { slug: 'knights_templar', log: [], guide: 'KTE', data: 'kt', tr: 'Tapınak Şövalyeleri' },
  { slug: 'golden_horde', log: ['mongol_ha_gol'], guide: 'GOH', data: 'gol', tr: 'Altın Orda' },
  { slug: 'macedonian_dynasty', log: [], guide: 'MAC', data: 'mac', tr: 'Makedon Hanedanı' },
  { slug: 'sengoku_daimyo', log: [], guide: 'SEN', data: 'sen', tr: 'Sengoku Daimyo' },
  { slug: 'tughlaq_dynasty', log: [], guide: 'TUG', data: 'tug', tr: 'Tuğluk Hanedanı' },
  { slug: 'jin_dynasty', log: [], guide: 'JIN', data: 'jin', tr: 'Jin Hanedanı' },
];

const bySlug = new Map(CIVS.map((c) => [c.slug, c]));
const byLog = new Map();
for (const c of CIVS) for (const code of c.log) byLog.set(code, c);

// Rakip ülkeye karşı kısa, genel geçer uyarılar. Sadece emin olduğumuz şeyler;
// yeni ülkelerde boş bırakılır ve kart oyuncunun geçmişine dayanır.
const THREATS = {
  english: 'Uzun menzilli okçular (longbow) ve güçlü savunma. Okçulara atlı (horseman) veya mancınıkla (mangonel) cevap ver.',
  french: 'Erken şövalye baskını yaygın. Feodal çağda mızrakçıyı (spearman) hazır tut, köylüleri koru.',
  holy_roman_empire: 'Erken ağır piyade (men-at-arms) baskını yaygın. Arbaletçi (crossbow) ve duvarla karşıla.',
  rus: 'Avcılıkla hızlı açılır, erken atlı akınları sever. Mızrakçı ve kule ile odun/altın hattını koru.',
  mongols: 'Hareketli ve akıncı: sürekli köylü avlar. Kaynak noktalarına kule/çit koy, mızrakçıyı erken çıkar.',
  chinese: 'Geç oyunda barutla çok güçlenir. Oyunu uzatma, erken ve orta oyunda baskı kur.',
  delhi_sultanate: 'Bedava teknoloji ve fillerle geç oyunda sertleşir. Erken baskı kur; filleri arbaletçi + mızrakçıyla oyala.',
  abbasid_dynasty: 'Ekonomisi güçlü, deve birlikleri atlıları zorlar. Erken baskıyla ekonomisini boz.',
  ottomans: 'Askeri okullar sürekli bedava asker üretir. Okulları erken hedef al, uzun savaşa girme.',
  malians: 'Kalabalık menzilli piyade (cirit atıcı) sever. Mancınık ve atlıyla dağıt.',
  byzantines: 'Paralı askerler ve güçlü savunma. Ekonomisini erken taciz et.',
  japanese: 'Güçlü piyade ve samuraylar. Arbaletçi ile ağır piyadeyi karşıla.',
  ayyubids: 'Feodal çağda erken saldırı yapabilir. İlk 8 dakikada savunmayı ihmal etme.',
  jeanne_darc: 'Jeanne seviye atladıkça çok güçlenir. Jeanne\'yi erken hedef al, ucuz köylü kaybı verme.',
  order_of_the_dragon: 'Altın (gilded) birlikler pahalı ve az sayıda. Sayıca üstün ol, arbaletçi kullan.',
  zhu_xis_legacy: 'Feodal/kale çağında güçlü baskı yapabilir. Zhuge Nu okçularına mancınık ve atlıyla cevap ver.',
  golden_horde: 'Moğol varyantı: hareketli, akıncı. Kaynak hatlarını kule ve mızrakçıyla koru.',
};

function fromSlug(slug) {
  return bySlug.get(slug) || null;
}

function fromLogCode(code) {
  if (byLog.has(code)) return byLog.get(code);
  // Bilinmeyen varyant ("byzantine_ha_xyz"): ana ülkeyi tahmin etme, sadece ham kodu döndür.
  return null;
}

function learnLogCode(code, slug) {
  const civ = bySlug.get(slug);
  if (!civ || byLog.get(code) === civ) return false;
  civ.log.push(code);
  byLog.set(code, civ);
  return true;
}

function trName(slugOrCode) {
  const civ = bySlug.get(slugOrCode) || byLog.get(slugOrCode);
  if (civ) return civ.tr;
  return String(slugOrCode || '?').replace(/_/g, ' ');
}

function threat(slug) {
  return THREATS[slug] || null;
}

function list() {
  return CIVS.map(({ slug, guide, tr, log }) => ({ slug, guide, tr, log: [...log] }));
}

module.exports = { fromSlug, fromLogCode, learnLogCode, trName, threat, list };
