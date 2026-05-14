// National and large regional chain detector.
// Returns true if a business should be excluded from the directory and prospect list.

const CHAIN_NAMES = new Set([
  // Fast food & coffee
  "mcdonald's", 'mcdonalds', 'kfc', 'burger king', 'subway', 'greggs', 'pret a manger', 'pret',
  'costa coffee', 'costa', 'starbucks', 'caffe nero', 'nero', 'tim hortons', 'five guys',
  'nando\'s', 'nandos', 'wagamama', 'pizza hut', 'domino\'s', 'dominos', 'papa john\'s',
  'papa johns', 'leon', 'itsu', 'yo sushi', 'wasabi', 'tortilla', 'chipotle',
  'the real greek', 'bella italia', 'zizzi', 'ask italian', 'frankie & benny\'s',
  'harvester', 'toby carvery', 'brewers fayre', 'beefeater', 'miller & carter',
  'weather spoons', 'wetherspoons', "wetherspoon", 'j d wetherspoon',

  // Supermarkets & food retail
  'tesco', 'sainsbury\'s', 'sainsburys', 'asda', 'morrisons', 'lidl', 'aldi',
  'co-op', 'the co-op', 'waitrose', 'm&s', 'marks & spencer', 'marks and spencer',
  'iceland', 'farmfoods', 'home bargains', 'b&m', 'poundland', 'pound bakery',

  // Pharmacy & health
  'boots', 'lloyds pharmacy', 'well pharmacy', 'rowlands pharmacy', 'cohens chemist',
  'specsavers', 'vision express', 'boots opticians', 'optical express',
  'mydentist', 'bupa dental', 'denplan',

  // Jewellery chains
  'beaverbrooks', 'h.samuel', 'h samuel', 'ernest jones', 'goldsmiths', 'mappin & webb',
  'mappin and webb', 'f.hinds', 'f hinds', 'warren james', 'warren james jewellers', 'pandora', 'swarovski',
  'tiffany', 'tiffany & co', 'tiffany and co', 'signet', 'ratner',

  // Sports & footwear
  'sports direct', 'jd sports', 'nike', 'adidas', 'footlocker', 'foot locker',
  'schuh', 'office shoes', 'clarks', 'ugg', 'timberland',

  // Charity / not SME
  'oxfam', 'british heart foundation', 'cancer research uk', 'marie curie',
  'save the children', 'age uk', 'barnardos', "barnardo's", 'shelter', 'mind',

  // Recruitment chains
  'reed', 'hays', 'manpower', 'adecco', 'randstad', 'michael page', 'robert half',

  // Travel agencies
  'trailfinders', 'kuoni', 'tui', 'thomas cook', 'jet2', 'expedia', 'lastminute',
  'flight centre', 'going places', 'holidays please',

  // Business coaching / franchise chains
  'actioncoach', 'action coach', 'bni', 'sandler training', 'dale carnegie',

  // DIY & trade
  'b&q', 'wickes', 'homebase', 'screwfix', 'toolstation', 'travis perkins',
  'jewson', 'buildbase', 'selco', 'plumbbase', 'city plumbing',

  // Banks & finance
  'natwest', 'barclays', 'hsbc', 'lloyds', 'lloyds bank', 'halifax',
  'santander', 'nationwide', 'metro bank', 'virgin money', 'tsb',
  'post office', 'western union', 'monzo', 'starling',

  // Telecoms & tech
  'vodafone', 'o2', 'ee', 'three', 'bt', 'sky', 'talk talk', 'talktalk',
  'carphone warehouse', 'currys', 'pc world', 'apple store',

  // Clothing & retail
  'next', 'h&m', 'primark', 'zara', 'river island', 'new look', 'dorothy perkins',
  'topshop', 'burton', 'evans', 'bonmarché', 'peacocks', 'george',

  // Petrol / automotive
  'bp', 'shell', 'esso', 'texaco', 'gulf', 'jet petrol',
  'kwik fit', 'halfords', 'national tyres', 'mr tyre', 'formula one autocentres',
  'arnold clark', 'evans halshaw', 'pendragon', 'lookers', 'marshall motor',

  // Gyms & leisure
  'puregym', 'the gym group', 'anytime fitness', 'david lloyd', 'nuffield health',
  'bannatyne', 'virgin active', 'snap fitness', 'everyone active',

  // Hotels & travel
  'premier inn', 'travelodge', 'holiday inn', 'ibis', 'novotel', 'hilton',
  'marriott', 'best western', 'crowne plaza',

  // Estate agents (big chains)
  'foxtons', 'countrywide', 'connells', 'your move', 'remax', 're/max',
  'purple bricks', 'purplebricks', 'rightmove', 'zoopla',

  // Services
  'hertz', 'enterprise', 'avis', 'budget', 'europcar', 'sixt',
  'speedy hire', 'hss hire', 'jewson',
  'uswitch', 'comparethemarket',
]);

// Google place types that almost always indicate chains or non-SME businesses
const CHAIN_TYPES = new Set([
  'supermarket', 'department_store', 'gas_station', 'bank', 'atm',
  'airport', 'train_station', 'subway_station', 'bus_station', 'transit_station',
  'shopping_mall', 'lodging', 'car_rental', 'embassy', 'government_office',
  'police', 'hospital', 'university', 'primary_school', 'secondary_school',
  'stadium', 'amusement_park', 'zoo', 'museum', 'art_gallery',
]);

// Review count above this combined with a non-niche type = likely chain
const CHAIN_REVIEW_THRESHOLD = 500;

export function isChain(business) {
  const name = (business.name || '').toLowerCase().trim();

  // Exact match or starts-with match against known chain names
  if (CHAIN_NAMES.has(name)) return true;
  for (const chain of CHAIN_NAMES) {
    if (name.startsWith(chain + ' ') || name === chain) return true;
  }

  // Place type is a chain indicator
  const types = business.google_types || [];
  if (types.some(t => CHAIN_TYPES.has(t))) return true;

  // Very high review count = almost certainly not a micro/SME business
  if ((business.review_count || 0) >= CHAIN_REVIEW_THRESHOLD) return true;

  return false;
}
