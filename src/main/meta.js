'use strict';

// Harita ve güncel meta: AoE4World'ün halka açık istatistiklerinden (son yamalar) YZ'ye giden kısa özet.
// Saf modül: veriler dışarıdan verilir.

const civs = require('./civs');

const pct = (v) => (v == null ? null : Math.round(v * 10) / 10);
const minutes = (sec) => (sec == null ? null : Math.round(sec / 60));

// Oyunun yazdığı harita adı Türkçe olabilir ("Saklı Ormanlar"); AoE4World İngilizce ad kullanır.
// Önce öğrenilmiş eşleşme, sonra birebir ad, sonra büyük/küçük harf duyarsız eşleşme.
function resolveMap(localName, learned = {}, mapList = []) {
  if (!localName) return null;
  const en = learned[localName] || localName;
  const norm = (s) => String(s).toLocaleLowerCase('tr').replace(/[^a-z0-9ığüşöç]/g, '');
  const hit = mapList.find((m) => m.map === en) || mapList.find((m) => norm(m.map) === norm(en));
  return { local: localName, en: hit ? hit.map : learned[localName] || null, id: hit ? hit.map_id : null, stats: hit || null };
}

function civRow(rows, slug) {
  const r = rows.find((x) => x.civilization === slug);
  return r ? { kazanma: pct(r.win_rate), secilme: pct(r.pick_rate), mac: r.games_count } : null;
}

// mySlug: benim ülkem; enemySlugs: rakiplerin ülkeleri; civRows: civStats(kind); map: resolveMap(); mapCivRows: mapCivStats()
function metaSummary({ kind, patch = null, mySlug, enemySlugs = [], allySlugs = [], civRows = [], map = null, mapCivRows = [] }) {
  const name = (slug) => civs.trName(slug);
  const top = [...civRows].sort((a, b) => b.win_rate - a.win_rate).slice(0, 5).map((r) => `${name(r.civilization)} %${pct(r.win_rate)}`);
  const onMap = [...mapCivRows].filter((r) => r.games_count >= 200).sort((a, b) => b.win_rate - a.win_rate);
  const mapRow = (slug) => {
    const r = mapCivRows.find((x) => x.civilization === slug);
    return r ? `%${pct(r.win_rate)} (${r.games_count} maç)` : null;
  };
  return {
    tur: kind,
    yama: patch,
    harita: map ? {
      en: map.en || null,
      ad: map.en ? `${map.local}${map.en !== map.local ? ` (${map.en})` : ''}` : map.local,
      ortalamaMacDk: minutes(map.stats?.duration_median),
      enCokKazananUlke: map.stats?.highest_win_rate_civilization ? name(map.stats.highest_win_rate_civilization) : null,
      haritadaEnIyi5: onMap.slice(0, 5).map((r) => `${name(r.civilization)} %${pct(r.win_rate)}`),
    } : null,
    genelEnIyi5: top,
    benimUlkem: mySlug ? { ulke: name(mySlug), genel: civRow(civRows, mySlug), buHaritada: mapRow(mySlug) } : null,
    rakipUlkeler: enemySlugs.filter(Boolean).map((s) => ({ ulke: name(s), genel: civRow(civRows, s), buHaritada: mapRow(s) })),
    takimUlkeleri: allySlugs.filter(Boolean).map((s) => ({ ulke: name(s), genel: civRow(civRows, s) })),
  };
}

// Canlı koç için kısa hali (her değerlendirmede gider; uzun metin kota ve süre harcar).
function metaBrief(intel) {
  if (!intel) return null;
  const m = intel.meta;
  return {
    harita: m?.harita ? { ad: m.harita.ad, ortalamaMacDk: m.harita.ortalamaMacDk } : null,
    benimUlkem: m?.benimUlkem || null,
    rakipUlkeler: m?.rakipUlkeler || [],
    internettenOzet: intel.research ? intel.research.text.slice(0, 1200) : null,
  };
}

module.exports = { resolveMap, metaSummary, metaBrief };
