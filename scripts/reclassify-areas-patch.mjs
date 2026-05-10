/**
 * reclassify-areas-patch.mjs
 * Fixes any businesses that still have fl_area_id = null after the main script.
 * Uses ordered pagination to avoid row-skipping.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter(l => l.includes("=") && !l.startsWith("#"))
    .map(l => l.split("=").map(p => p.trim()))
    .filter(([k]) => k)
    .map(([k, ...v]) => [k, v.join("=")])
);

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

const POSTCODE_MAP = {
  EH1: "edinburgh", EH2: "edinburgh", EH3: "stockbridge", EH4: "stockbridge",
  EH5: "newhaven", EH6: "leith", EH7: "restalrig", EH8: "newington",
  EH9: "morningside", EH10: "bruntsfield", EH11: "gorgie", EH12: "corstorphine",
  EH13: "colinton", EH14: "currie", EH15: "portobello", EH16: "craigmillar",
  EH17: "liberton", EH18: "loanhead", EH19: "bonnyrigg", EH20: "loanhead",
  EH21: "musselburgh", EH22: "dalkeith", EH23: "dalkeith", EH24: "dalkeith",
  EH25: "dalkeith", EH26: "penicuik", EH27: "edinburgh", EH28: "edinburgh",
  EH29: "edinburgh", EH30: "south-queensferry", EH31: "haddington",
  EH32: "tranent", EH33: "tranent", EH34: "haddington", EH35: "tranent",
  EH36: "haddington", EH37: "dalkeith", EH38: "dalkeith",
  EH39: "north-berwick", EH40: "haddington", EH41: "haddington",
  EH42: "haddington", EH43: "edinburgh", EH44: "edinburgh",
  EH45: "edinburgh", EH46: "edinburgh",
  EH47: "bathgate", EH48: "bathgate", EH49: "linlithgow",
  EH51: "falkirk", EH52: "broxburn", EH53: "livingston", EH54: "livingston",
  EH55: "livingston",
  G1: "glasgow", G2: "glasgow", G3: "glasgow", G4: "glasgow", G5: "glasgow",
  G11: "partick", G12: "hyndland", G13: "anniesland", G14: "scotstoun",
  G20: "maryhill", G21: "glasgow", G22: "glasgow", G23: "glasgow",
  G31: "dennistoun", G32: "glasgow", G33: "glasgow", G34: "glasgow",
  G40: "bridgeton", G41: "pollokshields", G42: "govanhill",
  G43: "pollokshaws", G44: "cathcart", G45: "glasgow", G46: "giffnock",
  G51: "govan", G52: "glasgow", G53: "glasgow",
  G60: "clydebank", G61: "bearsden", G62: "milngavie",
  G63: "glasgow", G64: "glasgow", G65: "glasgow", G66: "glasgow",
  G71: "uddingston", G72: "cambuslang", G73: "rutherglen",
  G74: "east-kilbride", G75: "east-kilbride",
  G76: "clarkston", G77: "newton-mearns", G78: "barrhead", G81: "clydebank",
  ML1: "motherwell", ML2: "motherwell", ML3: "hamilton", ML4: "motherwell",
  ML5: "motherwell", ML6: "motherwell", ML7: "motherwell", ML8: "hamilton",
  ML9: "hamilton", ML10: "hamilton", ML11: "hamilton", ML12: "hamilton",
  KA1: "kilmarnock", KA2: "kilmarnock", KA3: "kilmarnock", KA4: "kilmarnock",
  KA5: "ayr", KA6: "ayr", KA7: "ayr", KA8: "ayr", KA9: "ayr",
  KA10: "ayr", KA11: "ayr", KA12: "ayr", KA13: "ayr", KA14: "ayr",
  KA15: "ayr", KA16: "kilmarnock", KA17: "kilmarnock", KA18: "kilmarnock",
  KA19: "ayr", KA20: "ayr", KA21: "ayr", KA22: "ayr", KA23: "ayr",
  KA24: "ayr", KA25: "ayr", KA26: "ayr", KA27: "ayr", KA28: "ayr",
  KA29: "ayr", KA30: "ayr",
  PA1: "paisley", PA2: "paisley", PA3: "paisley", PA4: "renfrew",
  PA5: "johnstone", PA6: "johnstone", PA7: "johnstone", PA8: "johnstone",
  PA9: "johnstone", PA10: "johnstone", PA11: "johnstone", PA12: "johnstone",
  PA13: "johnstone", PA14: "paisley", PA15: "paisley", PA16: "paisley",
  PA17: "paisley", PA18: "paisley", PA19: "paisley", PA20: "paisley",
  FK1: "falkirk", FK2: "falkirk", FK3: "falkirk", FK4: "falkirk", FK5: "falkirk",
  FK6: "stirling", FK7: "stirling", FK8: "stirling", FK9: "stirling",
  FK10: "stirling", FK11: "stirling", FK12: "stirling", FK13: "stirling",
  FK14: "stirling", FK15: "stirling", FK16: "stirling", FK17: "stirling",
  FK18: "stirling", FK19: "stirling", FK20: "stirling", FK21: "stirling",
  KY1: "kirkcaldy", KY2: "kirkcaldy", KY3: "kirkcaldy", KY4: "kirkcaldy",
  KY5: "kirkcaldy", KY6: "kirkcaldy", KY7: "kirkcaldy", KY8: "kirkcaldy",
  KY9: "kirkcaldy", KY10: "kirkcaldy",
  KY11: "dunfermline", KY12: "dunfermline", KY13: "perth",
  KY14: "st-andrews", KY15: "st-andrews", KY16: "st-andrews",
  DD1: "dundee", DD2: "dundee", DD3: "dundee", DD4: "dundee", DD5: "dundee",
  DD6: "st-andrews", DD7: "dundee", DD8: "dundee", DD9: "dundee",
  DD10: "dundee", DD11: "dundee",
  AB10: "aberdeen", AB11: "aberdeen", AB12: "aberdeen", AB13: "aberdeen",
  AB14: "aberdeen", AB15: "aberdeen", AB16: "aberdeen",
  AB21: "aberdeen", AB22: "aberdeen", AB23: "aberdeen", AB24: "aberdeen",
  AB25: "aberdeen", AB30: "aberdeen", AB31: "aberdeen", AB32: "aberdeen",
  AB33: "aberdeen", AB34: "aberdeen", AB35: "aberdeen", AB36: "aberdeen",
  AB37: "aberdeen", AB38: "aberdeen", AB39: "aberdeen", AB41: "aberdeen",
  AB42: "aberdeen", AB43: "aberdeen", AB44: "aberdeen", AB45: "aberdeen",
  AB51: "aberdeen", AB52: "aberdeen", AB53: "aberdeen", AB54: "aberdeen",
  AB55: "aberdeen", AB56: "aberdeen",
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
  PH1: "perth", PH2: "perth", PH3: "perth", PH4: "perth", PH5: "perth",
  PH6: "perth", PH7: "perth", PH8: "perth", PH9: "perth", PH10: "perth",
  PH11: "perth", PH12: "perth", PH13: "perth", PH14: "perth", PH15: "perth",
  PH16: "perth", PH17: "perth", PH18: "perth", PH19: "perth", PH20: "perth",
  PH21: "perth", PH22: "perth", PH23: "perth", PH24: "perth", PH25: "perth",
  PH26: "perth", PH30: "perth", PH31: "perth", PH32: "perth",
  PH33: "fort-william", PH34: "fort-william", PH35: "fort-william",
  PH36: "fort-william", PH37: "fort-william", PH38: "fort-william",
  PH39: "fort-william", PH40: "fort-william", PH41: "fort-william",
  PH42: "fort-william", PH43: "fort-william", PH44: "fort-william",
  PH49: "oban", PH50: "oban",
  DG1: "dumfries", DG2: "dumfries", DG3: "dumfries", DG4: "dumfries",
  DG5: "dumfries", DG6: "dumfries", DG7: "dumfries", DG8: "dumfries",
  DG9: "dumfries", DG10: "dumfries", DG11: "dumfries", DG12: "dumfries",
  DG13: "dumfries", DG14: "dumfries",
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

function extractDistrict(postcode) {
  if (!postcode) return null;
  const clean = postcode.trim().toUpperCase();
  const spaceIdx = clean.indexOf(" ");
  return spaceIdx > 0 ? clean.slice(0, spaceIdx) : clean;
}

async function main() {
  console.log("=== Patch: fixing remaining null fl_area_id ===\n");

  const { data: areas } = await supabase.from("areas").select("id, slug, name");
  const areaIdBySlug = Object.fromEntries(areas.map(a => [a.slug, a.id]));
  const areaNameBySlug = Object.fromEntries(areas.map(a => [a.slug, a.name]));

  let fixed = 0;
  let skipped = 0;
  let offset = 0;

  while (true) {
    // Use order("id") for stable pagination
    const { data: batch } = await supabase
      .from("businesses")
      .select("id, postcode, name")
      .is("fl_area_id", null)
      .order("id")
      .range(offset, offset + 199);

    if (!batch?.length) break;

    for (const b of batch) {
      const district = extractDistrict(b.postcode);
      if (!district) { skipped++; continue; }

      const slug = POSTCODE_MAP[district];
      if (!slug) { skipped++; console.log(`  No map entry for district: ${district} (${b.name})`); continue; }

      const areaId = areaIdBySlug[slug];
      if (!areaId) { skipped++; console.log(`  Area not in DB: ${slug} (${b.name})`); continue; }

      const displayLocation = DISPLAY_NAME[district] ?? areaNameBySlug[slug];

      const { error } = await supabase
        .from("businesses")
        .update({ fl_area_id: areaId, location: displayLocation })
        .eq("id", b.id);

      if (error) { console.error(`  Error updating ${b.name}: ${error.message}`); skipped++; }
      else { fixed++; }
    }

    console.log(`  Batch done: fixed ${fixed}, skipped ${skipped}`);
    if (batch.length < 200) break;
    // Don't advance offset — we're filtering by fl_area_id=null and fixing as we go,
    // so the next query will naturally return remaining unmatched records.
  }

  console.log(`\nDone — fixed: ${fixed}, genuinely unresolvable: ${skipped}`);
}

main().catch(err => { console.error(err); process.exit(1); });
