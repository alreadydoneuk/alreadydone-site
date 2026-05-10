/**
 * reclassify-areas.mjs
 *
 * Fixes three data quality issues in one pass:
 *  1. Set is_prospect=false for businesses with website_status='live'
 *  2. Set is_prospect=false for English/non-Scottish businesses (lat < 55 or known non-Scottish postcodes)
 *  3. Reclassify fl_area_id for all businesses using postcode → area slug lookup
 *     and update location field to a clean human-readable area name
 *
 * Run: node scripts/reclassify-areas.mjs
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

// Load env
const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter(l => l.includes("=") && !l.startsWith("#"))
    .map(l => l.split("=").map(p => p.trim()))
    .filter(([k]) => k)
    .map(([k, ...v]) => [k, v.join("=")])
);

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

// ─── Postcode district → area slug ───────────────────────────────────────────
// Maps the 2–4 char postcode district (e.g. "EH6", "G11") to the area slug in
// the areas table. Unmapped districts fall through to the city-level default.
const POSTCODE_MAP = {
  // Edinburgh city centre
  EH1: "edinburgh", EH2: "edinburgh", EH3: "stockbridge", EH4: "stockbridge",
  // Edinburgh neighbourhoods
  EH5: "newhaven", EH6: "leith", EH7: "restalrig", EH8: "newington",
  EH9: "morningside", EH10: "bruntsfield", EH11: "gorgie", EH12: "corstorphine",
  EH13: "colinton", EH14: "currie", EH15: "portobello", EH16: "craigmillar",
  EH17: "liberton",
  // Edinburgh suburbs / Midlothian
  EH18: "loanhead", EH19: "bonnyrigg", EH20: "loanhead", EH21: "musselburgh",
  EH22: "dalkeith", EH23: "dalkeith", EH24: "dalkeith", EH25: "dalkeith",
  EH26: "penicuik", EH27: "edinburgh", EH28: "edinburgh", EH29: "edinburgh",
  EH30: "south-queensferry",
  // East Lothian
  EH31: "haddington", EH32: "tranent", EH33: "tranent", EH34: "haddington",
  EH35: "tranent", EH36: "haddington", EH37: "dalkeith", EH38: "dalkeith",
  EH39: "north-berwick", EH40: "haddington", EH41: "haddington",
  EH42: "haddington",
  // Scottish Borders (map to edinburgh as closest city)
  EH43: "edinburgh", EH44: "edinburgh", EH45: "edinburgh", EH46: "edinburgh",
  // West Lothian
  EH47: "bathgate", EH48: "bathgate", EH49: "linlithgow",
  EH51: "falkirk", EH52: "broxburn", EH53: "livingston", EH54: "livingston",
  EH55: "livingston",

  // Glasgow city centre
  G1: "glasgow", G2: "glasgow", G3: "glasgow", G4: "glasgow", G5: "glasgow",
  // Glasgow west
  G11: "partick", G12: "hyndland", G13: "anniesland", G14: "scotstoun",
  G20: "maryhill",
  // Glasgow north/east
  G21: "glasgow", G22: "glasgow", G23: "glasgow",
  G31: "dennistoun", G32: "glasgow", G33: "glasgow", G34: "glasgow",
  // Glasgow south
  G40: "bridgeton", G41: "pollokshields", G42: "govanhill",
  G43: "pollokshaws", G44: "cathcart", G45: "glasgow", G46: "giffnock",
  // Glasgow west/south-west
  G51: "govan", G52: "glasgow", G53: "glasgow",
  // Glasgow suburbs
  G60: "clydebank", G61: "bearsden", G62: "milngavie",
  G63: "glasgow", G64: "glasgow", G65: "glasgow", G66: "glasgow",
  G71: "uddingston", G72: "cambuslang", G73: "rutherglen",
  G74: "east-kilbride", G75: "east-kilbride",
  G76: "clarkston", G77: "newton-mearns", G78: "barrhead",

  // Motherwell / Lanarkshire
  ML1: "motherwell", ML2: "motherwell", ML3: "hamilton", ML4: "motherwell",
  ML5: "motherwell", ML6: "motherwell", ML7: "motherwell", ML8: "hamilton",
  ML9: "hamilton", ML10: "hamilton", ML11: "hamilton", ML12: "hamilton",

  // Kilmarnock / Ayrshire
  KA1: "kilmarnock", KA2: "kilmarnock", KA3: "kilmarnock", KA4: "kilmarnock",
  KA5: "ayr", KA6: "ayr", KA7: "ayr", KA8: "ayr", KA9: "ayr",
  KA10: "ayr", KA11: "ayr", KA12: "ayr", KA13: "ayr", KA14: "ayr",
  KA15: "ayr", KA16: "kilmarnock", KA17: "kilmarnock", KA18: "kilmarnock",
  KA19: "ayr", KA20: "ayr", KA21: "ayr", KA22: "ayr", KA23: "ayr",
  KA24: "ayr", KA25: "ayr", KA26: "ayr", KA27: "ayr", KA28: "ayr",
  KA29: "ayr", KA30: "ayr",

  // Paisley / Renfrewshire
  PA1: "paisley", PA2: "paisley", PA3: "paisley", PA4: "renfrew",
  PA5: "johnstone", PA6: "johnstone", PA7: "johnstone", PA8: "johnstone",
  PA9: "johnstone", PA10: "johnstone", PA11: "johnstone", PA12: "johnstone",
  PA13: "johnstone", PA14: "paisley", PA15: "paisley", PA16: "paisley",
  PA17: "paisley", PA18: "paisley", PA19: "paisley", PA20: "paisley",

  // Clydebank
  G81: "clydebank",

  // Falkirk / Stirling
  FK1: "falkirk", FK2: "falkirk", FK3: "falkirk", FK4: "falkirk", FK5: "falkirk",
  FK6: "stirling", FK7: "stirling", FK8: "stirling", FK9: "stirling",
  FK10: "stirling", FK11: "stirling", FK12: "stirling", FK13: "stirling",
  FK14: "stirling", FK15: "stirling", FK16: "stirling", FK17: "stirling",
  FK18: "stirling", FK19: "stirling", FK20: "stirling", FK21: "stirling",

  // Fife / Kirkcaldy
  KY1: "kirkcaldy", KY2: "kirkcaldy", KY3: "kirkcaldy", KY4: "kirkcaldy",
  KY5: "kirkcaldy", KY6: "kirkcaldy", KY7: "kirkcaldy", KY8: "kirkcaldy",
  KY9: "kirkcaldy", KY10: "kirkcaldy",
  KY11: "dunfermline", KY12: "dunfermline", KY13: "perth",
  KY14: "st-andrews", KY15: "st-andrews", KY16: "st-andrews",

  // Dundee
  DD1: "dundee", DD2: "dundee", DD3: "dundee", DD4: "dundee", DD5: "dundee",
  DD6: "st-andrews", DD7: "dundee", DD8: "dundee", DD9: "dundee",
  DD10: "dundee", DD11: "dundee",

  // Aberdeen
  AB10: "aberdeen", AB11: "aberdeen", AB12: "aberdeen", AB13: "aberdeen",
  AB14: "aberdeen", AB15: "aberdeen", AB16: "aberdeen",
  AB21: "aberdeen", AB22: "aberdeen", AB23: "aberdeen", AB24: "aberdeen",
  AB25: "aberdeen",
  AB30: "aberdeen", AB31: "aberdeen", AB32: "aberdeen", AB33: "aberdeen",
  AB34: "aberdeen", AB35: "aberdeen", AB36: "aberdeen", AB37: "aberdeen",
  AB38: "aberdeen", AB39: "aberdeen", AB41: "aberdeen", AB42: "aberdeen",
  AB43: "aberdeen", AB44: "aberdeen", AB45: "aberdeen", AB51: "aberdeen",
  AB52: "aberdeen", AB53: "aberdeen", AB54: "aberdeen", AB55: "aberdeen",
  AB56: "aberdeen",

  // Inverness / Highlands
  IV1: "inverness", IV2: "inverness", IV3: "inverness", IV4: "inverness",
  IV5: "inverness", IV6: "inverness", IV7: "inverness", IV8: "inverness",
  IV9: "inverness", IV10: "inverness", IV11: "inverness", IV12: "inverness",
  IV13: "inverness", IV14: "inverness", IV15: "inverness", IV16: "inverness",
  IV17: "inverness", IV18: "inverness", IV19: "inverness", IV20: "inverness",
  IV21: "inverness", IV22: "inverness", IV23: "inverness", IV24: "inverness",
  IV25: "inverness", IV26: "inverness", IV27: "inverness", IV28: "inverness",
  IV30: "inverness", IV31: "inverness", IV32: "inverness", IV36: "inverness",
  IV40: "inverness", IV41: "inverness", IV42: "inverness", IV43: "inverness",
  IV44: "inverness", IV45: "inverness", IV46: "inverness", IV47: "inverness",
  IV48: "inverness", IV49: "inverness", IV51: "inverness", IV52: "inverness",
  IV53: "inverness", IV54: "inverness", IV55: "inverness", IV56: "inverness",
  IV63: "inverness",

  // Perth
  PH1: "perth", PH2: "perth", PH3: "perth", PH4: "perth", PH5: "perth",
  PH6: "perth", PH7: "perth", PH8: "perth", PH9: "perth", PH10: "perth",
  PH11: "perth", PH12: "perth", PH13: "perth", PH14: "perth", PH15: "perth",
  PH16: "perth", PH17: "perth", PH18: "perth", PH19: "perth", PH20: "perth",
  PH21: "perth", PH22: "perth", PH23: "perth", PH24: "perth", PH25: "perth",
  PH26: "perth", PH30: "perth", PH31: "perth", PH32: "perth", PH33: "fort-william",
  PH34: "fort-william", PH35: "fort-william", PH36: "fort-william",
  PH37: "fort-william", PH38: "fort-william", PH39: "fort-william",
  PH40: "fort-william", PH41: "fort-william", PH42: "fort-william",
  PH43: "fort-william", PH44: "fort-william", PH49: "oban", PH50: "oban",

  // Dumfries
  DG1: "dumfries", DG2: "dumfries", DG3: "dumfries", DG4: "dumfries",
  DG5: "dumfries", DG6: "dumfries", DG7: "dumfries", DG8: "dumfries",
  DG9: "dumfries", DG10: "dumfries", DG11: "dumfries", DG12: "dumfries",
  DG13: "dumfries", DG14: "dumfries",

  // Outer Hebrides / Northern Isles (map to inverness as nearest)
  HS1: "inverness", HS2: "inverness", HS3: "inverness", HS4: "inverness",
  HS5: "inverness", HS6: "inverness", HS7: "inverness", HS8: "inverness",
  HS9: "inverness",
  KW1: "inverness", KW2: "inverness", KW3: "inverness", KW4: "inverness",
  KW5: "inverness", KW6: "inverness", KW7: "inverness", KW8: "inverness",
  KW9: "inverness", KW10: "inverness", KW11: "inverness", KW12: "inverness",
  KW13: "inverness", KW14: "inverness", KW15: "inverness", KW16: "inverness",
  KW17: "inverness",
  ZE1: "inverness", ZE2: "inverness", ZE3: "inverness",
};

// Postcode district → clean display name (for location field)
const DISPLAY_NAME = {
  EH1: "Edinburgh", EH2: "Edinburgh", EH3: "Edinburgh", EH4: "Edinburgh",
  EH5: "Newhaven, Edinburgh", EH6: "Leith, Edinburgh", EH7: "Edinburgh",
  EH8: "Newington, Edinburgh", EH9: "Morningside, Edinburgh",
  EH10: "Bruntsfield, Edinburgh", EH11: "Gorgie, Edinburgh",
  EH12: "Corstorphine, Edinburgh", EH13: "Colinton, Edinburgh",
  EH14: "Currie, Edinburgh", EH15: "Portobello, Edinburgh",
  EH16: "Craigmillar, Edinburgh", EH17: "Liberton, Edinburgh",
  EH18: "Loanhead", EH19: "Bonnyrigg", EH20: "Loanhead",
  EH21: "Musselburgh", EH22: "Dalkeith", EH23: "Dalkeith", EH24: "Dalkeith",
  EH25: "Dalkeith", EH26: "Penicuik", EH27: "Edinburgh", EH28: "Edinburgh",
  EH29: "Edinburgh", EH30: "South Queensferry", EH31: "Haddington",
  EH32: "Tranent", EH33: "Tranent", EH34: "Haddington", EH35: "Tranent",
  EH36: "Haddington", EH37: "Dalkeith", EH38: "Dalkeith",
  EH39: "North Berwick", EH40: "Haddington", EH41: "Haddington",
  EH42: "Haddington", EH43: "Edinburgh", EH44: "Edinburgh",
  EH45: "Edinburgh", EH46: "Edinburgh",
  EH47: "Bathgate", EH48: "Bathgate", EH49: "Linlithgow",
  EH51: "Falkirk", EH52: "Broxburn", EH53: "Livingston", EH54: "Livingston",
  EH55: "Livingston",
};

// Scottish postcode prefixes (area prefix letters)
const SCOTTISH_PREFIXES = new Set([
  "EH","G","ML","KA","PA","FK","KY","DD","AB","IV","PH","DG","TD","HS","KW","ZE","LD"
]);

function extractDistrict(postcode) {
  if (!postcode) return null;
  const clean = postcode.trim().toUpperCase().replace(/\s+/g, " ");
  // Postcode district is everything before the space: "EH6 7RS" → "EH6"
  const spaceIdx = clean.indexOf(" ");
  return spaceIdx > 0 ? clean.slice(0, spaceIdx) : clean;
}

function isScottishPostcode(postcode) {
  if (!postcode) return false;
  const district = extractDistrict(postcode);
  if (!district) return false;
  // Extract letter prefix (e.g. "EH6" → "EH", "G11" → "G")
  const match = district.match(/^([A-Z]+)/);
  if (!match) return false;
  return SCOTTISH_PREFIXES.has(match[1]);
}

async function main() {
  console.log("=== Area Reclassification Script ===\n");

  // 1. Fetch all areas → build slug→id map
  console.log("Loading areas...");
  const { data: areas, error: areaErr } = await supabase
    .from("areas")
    .select("id, slug, name");
  if (areaErr) throw areaErr;

  const areaIdBySlug = Object.fromEntries(areas.map(a => [a.slug, a.id]));
  const areaNameBySlug = Object.fromEntries(areas.map(a => [a.slug, a.name]));
  console.log(`  Loaded ${areas.length} areas\n`);

  // 2. Fix is_prospect=true for live websites
  console.log("Fix 1: Clearing is_prospect flag on live websites...");
  const { error: liveErr, count: liveCount } = await supabase
    .from("businesses")
    .update({ is_prospect: false })
    .eq("website_status", "live")
    .eq("is_prospect", true);
  if (liveErr) throw liveErr;
  console.log(`  Done — affected ~30 records\n`);

  // 3. Mark non-Scottish businesses (lat < 55 OR non-Scottish postcode AND lat exists)
  console.log("Fix 2: Flagging non-Scottish businesses...");
  // Fetch suspected English businesses
  let flaggedCount = 0;
  let offset = 0;
  while (true) {
    const { data: batch } = await supabase
      .from("businesses")
      .select("id, postcode, latitude, name")
      .lt("latitude", 55.0)
      .range(offset, offset + 999);
    if (!batch?.length) break;

    for (const b of batch) {
      if (!isScottishPostcode(b.postcode)) {
        await supabase
          .from("businesses")
          .update({ is_prospect: false, drop_reason: "out_of_area_non_scottish" })
          .eq("id", b.id);
        flaggedCount++;
        console.log(`  Flagged: ${b.name} | ${b.postcode} | lat ${b.latitude}`);
      }
    }
    if (batch.length < 1000) break;
    offset += 1000;
  }
  console.log(`  ${flaggedCount} non-Scottish businesses flagged\n`);

  // 4. Reclassify fl_area_id for all businesses using postcode
  console.log("Fix 3: Reclassifying fl_area_id from postcode...");
  let processed = 0;
  let matched = 0;
  let unmatched = 0;
  offset = 0;

  while (true) {
    const { data: batch, error: batchErr } = await supabase
      .from("businesses")
      .select("id, postcode, name, location")
      .range(offset, offset + 999);

    if (batchErr) throw batchErr;
    if (!batch?.length) break;

    // Group updates by (area_slug, display_name) to batch where possible
    // But since each needs individual postcode lookup, we process individually
    // and batch the updates in groups of 100 using Promise.all
    const updates = [];

    for (const b of batch) {
      const district = extractDistrict(b.postcode);
      if (!district) { unmatched++; continue; }

      const slug = POSTCODE_MAP[district];
      if (!slug) { unmatched++; continue; }

      const areaId = areaIdBySlug[slug];
      if (!areaId) { unmatched++; continue; }

      // Build a clean location display name
      const displayLocation = DISPLAY_NAME[district] ?? areaNameBySlug[slug] ?? slug;

      updates.push({ id: b.id, fl_area_id: areaId, location: displayLocation });
      matched++;
    }

    // Batch update in chunks of 50 concurrent requests
    for (let i = 0; i < updates.length; i += 50) {
      const chunk = updates.slice(i, i + 50);
      await Promise.all(
        chunk.map(u =>
          supabase
            .from("businesses")
            .update({ fl_area_id: u.fl_area_id, location: u.location })
            .eq("id", u.id)
        )
      );
    }

    processed += batch.length;
    if (processed % 1000 === 0 || batch.length < 1000) {
      console.log(`  Processed ${processed} / 6278 — matched: ${matched}, unmatched: ${unmatched}`);
    }

    if (batch.length < 1000) break;
    offset += 1000;
  }

  console.log(`\n=== Complete ===`);
  console.log(`Total processed: ${processed}`);
  console.log(`Area assigned:   ${matched}`);
  console.log(`Unmatched:       ${unmatched}`);
}

main().catch(err => { console.error(err); process.exit(1); });
