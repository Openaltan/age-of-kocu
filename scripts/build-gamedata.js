'use strict';

// AoE4World'ün açık oyun verisinden (data.aoe4world.com) kayıt analizinin ihtiyaç duyduğu
// sade kimlik tablosunu üretir: pbgid -> { id, baseId, name, kind, age, civs, time, tags }.
// Kullanım: node scripts/build-gamedata.js   (yeni yama/ülke geldiğinde tekrar çalıştır)
const fs = require('fs');
const path = require('path');

const KINDS = ['units', 'buildings', 'technologies', 'upgrades'];
const OUT = path.join(__dirname, '..', 'src', 'main', 'data', 'gamedata.json');

const ECO_TECH = /^(wheelbarrow|horticulture|fertilization|precision-cross-breeding|double-broadax|lumber-preservation|crosscut-saw|forestry|specialized-pick|cupellation|acid-distillation|survival-techniques|.*-farm-gather)(-improved)?$/;

function tags(x) {
  const c = new Set(x.classes || []);
  const t = [];
  if (c.has('landmark') && !c.has('town_center') && x.baseId !== 'house-of-wisdom') t.push('landmark');
  if (c.has('town_center')) t.push('town_center');
  if (/^villager/.test(x.baseId) || c.has('worker')) t.push('villager');
  if (x.type === 'unit' && c.has('military')) t.push('military');
  if (c.has('house')) t.push('house');
  if (c.has('military_production_building')) t.push('military_building');
  if (c.has('economy_building')) t.push('eco_building');
  if (/-wing$/.test(x.baseId)) t.push('wing'); // Abbasi/Eyyubi çağ atlama kanatları
  if (x.type === 'technology' && (c.has('economy_upgrade') || ECO_TECH.test(x.baseId))) t.push('eco_tech');
  // Birim rolü: kontra önerileri için.
  if (x.type === 'unit' && c.has('military')) {
    if (c.has('siege')) t.push('siege');
    else if (c.has('cavalry')) t.push('cavalry');
    else if (c.has('ranged')) t.push('ranged');
    else if (c.has('infantry')) t.push('infantry');
    if (c.has('heavy')) t.push('heavy');
    if (/spear|pike/.test(x.baseId)) t.push('anti_cavalry');
    if (/crossbow|handcannon|arbaletrier|zhuge/.test(x.baseId)) t.push('anti_armor');
  }
  return t;
}

async function main() {
  const out = {};
  for (const kind of KINDS) {
    const res = await fetch(`https://data.aoe4world.com/${kind}/all.json`);
    if (!res.ok) throw new Error(`${kind}: ${res.status}`);
    const { data } = await res.json();
    for (const x of data) {
      if (!x.pbgid || out[x.pbgid]) continue;
      out[x.pbgid] = {
        id: x.id,
        baseId: x.baseId,
        name: x.name,
        kind: kind.replace(/s$/, '').replace(/ie$/, 'y'),
        age: x.age ?? null,
        civs: x.civs || [],
        time: x.costs?.time ?? null,
        tags: tags(x),
      };
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`${Object.keys(out).length} kayıt -> ${OUT} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
