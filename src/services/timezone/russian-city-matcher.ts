// src/services/timezone/russian-city-matcher.ts

// Suffixes ordered longest-first for greedy stripping
const SUFFIXES_3PLUS = ['ами', 'ями', 'ого', 'его', 'ому', 'ему'];
const SUFFIXES_2 = ['ом', 'ем', 'ём', 'ой', 'ей', 'ий', 'ый', 'ах', 'ях', 'ов', 'ев', 'им'];
const SUFFIXES_1 = ['а', 'я', 'е', 'у', 'ю', 'о', 'и', 'ы'];

/** Strip Russian noun/adjective case endings to get an approximate stem. */
export function stemRussian(input: string): string {
  return input
    .split(/\s+/)
    .map((word) => stemWord(word))
    .join(' ');
}

function stemWord(word: string): string {
  // Don't stem words with hyphens at word level — stem each part
  if (word.includes('-')) {
    const parts = word.split('-');
    const lastIdx = parts.length - 1;
    // Only stem the last part (e.g., "санкт-петербурге" → "санкт-петербург")
    parts[lastIdx] = stemWord(parts[lastIdx]!);
    return parts.join('-');
  }

  if (word.length <= 3) return word;

  for (const suffix of SUFFIXES_3PLUS) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, -suffix.length);
    }
  }
  for (const suffix of SUFFIXES_2) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, -suffix.length);
    }
  }
  for (const suffix of SUFFIXES_1) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, -suffix.length);
    }
  }

  return word;
}

/** Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(matrix[i - 1]![j]! + 1, matrix[i]![j - 1]! + 1, matrix[i - 1]![j - 1]! + cost);
    }
  }

  return matrix[a.length]![b.length]!;
}

// City dictionary: [russianNominative, ianaTimezone]
// Only nominative forms — stemmer handles all grammatical cases
const CITIES: [string, string][] = [
  // Russia — Moscow timezone (Europe/Moscow, UTC+3)
  ['москва', 'Europe/Moscow'],
  ['санкт-петербург', 'Europe/Moscow'],
  ['петербург', 'Europe/Moscow'],
  ['питер', 'Europe/Moscow'],
  ['казань', 'Europe/Moscow'],
  ['ростов-на-дону', 'Europe/Moscow'],
  ['ростов', 'Europe/Moscow'],
  ['воронеж', 'Europe/Moscow'],
  ['волгоград', 'Europe/Moscow'],
  ['краснодар', 'Europe/Moscow'],
  ['нижний новгород', 'Europe/Moscow'],
  ['саратов', 'Europe/Moscow'],
  ['тула', 'Europe/Moscow'],
  ['ярославль', 'Europe/Moscow'],
  ['рязань', 'Europe/Moscow'],
  ['пенза', 'Europe/Moscow'],
  ['липецк', 'Europe/Moscow'],
  ['тверь', 'Europe/Moscow'],
  ['иваново', 'Europe/Moscow'],
  ['брянск', 'Europe/Moscow'],
  ['архангельск', 'Europe/Moscow'],
  ['вологда', 'Europe/Moscow'],
  ['мурманск', 'Europe/Moscow'],
  ['сочи', 'Europe/Moscow'],
  ['великий новгород', 'Europe/Moscow'],
  ['псков', 'Europe/Moscow'],
  ['курск', 'Europe/Moscow'],
  ['орёл', 'Europe/Moscow'],
  ['белгород', 'Europe/Moscow'],
  ['тамбов', 'Europe/Moscow'],
  ['кострома', 'Europe/Moscow'],
  ['смоленск', 'Europe/Moscow'],
  ['махачкала', 'Europe/Moscow'],
  ['грозный', 'Europe/Moscow'],

  // Russia — Kaliningrad (Europe/Kaliningrad, UTC+2)
  ['калининград', 'Europe/Kaliningrad'],

  // Russia — Samara (Europe/Samara, UTC+4)
  ['самара', 'Europe/Samara'],
  ['ижевск', 'Europe/Samara'],
  ['ульяновск', 'Europe/Samara'],
  ['оренбург', 'Europe/Samara'],
  ['тольятти', 'Europe/Samara'],
  ['астрахань', 'Europe/Samara'],

  // Russia — Yekaterinburg (Asia/Yekaterinburg, UTC+5)
  ['екатеринбург', 'Asia/Yekaterinburg'],
  ['челябинск', 'Asia/Yekaterinburg'],
  ['пермь', 'Asia/Yekaterinburg'],
  ['уфа', 'Asia/Yekaterinburg'],
  ['тюмень', 'Asia/Yekaterinburg'],
  ['сургут', 'Asia/Yekaterinburg'],
  ['курган', 'Asia/Yekaterinburg'],
  ['магнитогорск', 'Asia/Yekaterinburg'],

  // Russia — Omsk (Asia/Omsk, UTC+6)
  ['омск', 'Asia/Omsk'],

  // Russia — Krasnoyarsk (Asia/Krasnoyarsk, UTC+7)
  ['красноярск', 'Asia/Krasnoyarsk'],
  ['новосибирск', 'Asia/Novosibirsk'],
  ['барнаул', 'Asia/Barnaul'],
  ['томск', 'Asia/Tomsk'],
  ['кемерово', 'Asia/Novokuznetsk'],
  ['новокузнецк', 'Asia/Novokuznetsk'],

  // Russia — Irkutsk (Asia/Irkutsk, UTC+8)
  ['иркутск', 'Asia/Irkutsk'],

  // Russia — Yakutsk (Asia/Yakutsk, UTC+9)
  ['якутск', 'Asia/Yakutsk'],
  ['чита', 'Asia/Chita'],

  // Russia — Vladivostok (Asia/Vladivostok, UTC+10)
  ['владивосток', 'Asia/Vladivostok'],
  ['хабаровск', 'Asia/Vladivostok'],

  // Russia — Magadan (Asia/Magadan, UTC+11)
  ['магадан', 'Asia/Magadan'],
  ['южно-сахалинск', 'Asia/Sakhalin'],

  // Russia — Kamchatka (Asia/Kamchatka, UTC+12)
  ['петропавловск-камчатский', 'Asia/Kamchatka'],

  // CIS countries
  ['минск', 'Europe/Minsk'],
  ['гомель', 'Europe/Minsk'],
  ['витебск', 'Europe/Minsk'],
  ['брест', 'Europe/Minsk'],
  ['киев', 'Europe/Kyiv'],
  ['київ', 'Europe/Kyiv'],
  ['харьков', 'Europe/Kyiv'],
  ['одесса', 'Europe/Kyiv'],
  ['львов', 'Europe/Kyiv'],
  ['днепр', 'Europe/Kyiv'],
  ['запорожье', 'Europe/Kyiv'],
  ['алматы', 'Asia/Almaty'],
  ['астана', 'Asia/Almaty'],
  ['нур-султан', 'Asia/Almaty'],
  ['шымкент', 'Asia/Almaty'],
  ['ташкент', 'Asia/Tashkent'],
  ['самарканд', 'Asia/Samarkand'],
  ['бишкек', 'Asia/Bishkek'],
  ['тбилиси', 'Asia/Tbilisi'],
  ['батуми', 'Asia/Tbilisi'],
  ['кутаиси', 'Asia/Tbilisi'],
  ['ереван', 'Asia/Yerevan'],
  ['гюмри', 'Asia/Yerevan'],
  ['баку', 'Asia/Baku'],
  ['кишинёв', 'Europe/Chisinau'],
  ['кишинев', 'Europe/Chisinau'],
  ['душанбе', 'Asia/Dushanbe'],
  ['ашхабад', 'Asia/Ashgabat'],

  // Georgia (popular with relocants)
  ['рустави', 'Asia/Tbilisi'],

  // Europe — capitals and major cities
  ['лондон', 'Europe/London'],
  ['манчестер', 'Europe/London'],
  ['эдинбург', 'Europe/London'],
  ['бирмингем', 'Europe/London'],
  ['париж', 'Europe/Paris'],
  ['марсель', 'Europe/Paris'],
  ['лион', 'Europe/Paris'],
  ['ницца', 'Europe/Paris'],
  ['берлин', 'Europe/Berlin'],
  ['мюнхен', 'Europe/Berlin'],
  ['франкфурт', 'Europe/Berlin'],
  ['гамбург', 'Europe/Berlin'],
  ['кёльн', 'Europe/Berlin'],
  ['дюссельдорф', 'Europe/Berlin'],
  ['мадрид', 'Europe/Madrid'],
  ['барселона', 'Europe/Madrid'],
  ['валенсия', 'Europe/Madrid'],
  ['севилья', 'Europe/Madrid'],
  ['малага', 'Europe/Madrid'],
  ['рим', 'Europe/Rome'],
  ['милан', 'Europe/Rome'],
  ['неаполь', 'Europe/Rome'],
  ['флоренция', 'Europe/Rome'],
  ['турин', 'Europe/Rome'],
  ['амстердам', 'Europe/Amsterdam'],
  ['роттердам', 'Europe/Amsterdam'],
  ['брюссель', 'Europe/Brussels'],
  ['антверпен', 'Europe/Brussels'],
  ['вена', 'Europe/Vienna'],
  ['прага', 'Europe/Prague'],
  ['братислава', 'Europe/Bratislava'],
  ['варшава', 'Europe/Warsaw'],
  ['краков', 'Europe/Warsaw'],
  ['вроцлав', 'Europe/Warsaw'],
  ['гданьск', 'Europe/Warsaw'],
  ['будапешт', 'Europe/Budapest'],
  ['бухарест', 'Europe/Bucharest'],
  ['белград', 'Europe/Belgrade'],
  ['београд', 'Europe/Belgrade'],
  ['нови-сад', 'Europe/Belgrade'],
  ['загреб', 'Europe/Zagreb'],
  ['сплит', 'Europe/Zagreb'],
  ['любляна', 'Europe/Ljubljana'],
  ['афины', 'Europe/Athens'],
  ['салоники', 'Europe/Athens'],
  ['стокгольм', 'Europe/Stockholm'],
  ['хельсинки', 'Europe/Helsinki'],
  ['осло', 'Europe/Oslo'],
  ['копенгаген', 'Europe/Copenhagen'],
  ['лиссабон', 'Europe/Lisbon'],
  ['порту', 'Europe/Lisbon'],
  ['дублин', 'Europe/Dublin'],
  ['цюрих', 'Europe/Zurich'],
  ['женева', 'Europe/Zurich'],
  ['берн', 'Europe/Zurich'],
  ['стамбул', 'Europe/Istanbul'],
  ['анкара', 'Europe/Istanbul'],
  ['измир', 'Europe/Istanbul'],
  ['анталья', 'Europe/Istanbul'],
  ['бодрум', 'Europe/Istanbul'],

  // Balkans & Mediterranean (relocant destinations)
  ['подгорица', 'Europe/Podgorica'],
  ['будва', 'Europe/Podgorica'],
  ['тиват', 'Europe/Podgorica'],
  ['бар', 'Europe/Podgorica'],
  ['никосия', 'Asia/Nicosia'],
  ['лимасол', 'Asia/Nicosia'],
  ['ларнака', 'Asia/Nicosia'],
  ['пафос', 'Asia/Nicosia'],
  ['тирана', 'Europe/Tirane'],
  ['софия', 'Europe/Sofia'],
  ['скопье', 'Europe/Skopje'],
  ['рига', 'Europe/Riga'],
  ['таллин', 'Europe/Tallinn'],
  ['вильнюс', 'Europe/Vilnius'],

  // Americas — USA major cities
  ['нью-йорк', 'America/New_York'],
  ['вашингтон', 'America/New_York'],
  ['бостон', 'America/New_York'],
  ['филадельфия', 'America/New_York'],
  ['майами', 'America/New_York'],
  ['маями', 'America/New_York'],
  ['атланта', 'America/New_York'],
  ['шарлотт', 'America/New_York'],
  ['орландо', 'America/New_York'],
  ['питтсбург', 'America/New_York'],
  ['чикаго', 'America/Chicago'],
  ['хьюстон', 'America/Chicago'],
  ['даллас', 'America/Chicago'],
  ['сан-антонио', 'America/Chicago'],
  ['остин', 'America/Chicago'],
  ['миннеаполис', 'America/Chicago'],
  ['детройт', 'America/Detroit'],
  ['денвер', 'America/Denver'],
  ['финикс', 'America/Phoenix'],
  ['лос-анджелес', 'America/Los_Angeles'],
  ['сан-франциско', 'America/Los_Angeles'],
  ['сан-диего', 'America/Los_Angeles'],
  ['сиэтл', 'America/Los_Angeles'],
  ['лас-вегас', 'America/Los_Angeles'],
  ['портленд', 'America/Los_Angeles'],
  ['гонолулу', 'Pacific/Honolulu'],
  // Americas — other
  ['ванкувер', 'America/Vancouver'],
  ['торонто', 'America/Toronto'],
  ['монреаль', 'America/Toronto'],
  ['оттава', 'America/Toronto'],
  ['мехико', 'America/Mexico_City'],
  ['канкун', 'America/Cancun'],
  ['сан-паулу', 'America/Sao_Paulo'],
  ['рио-де-жанейро', 'America/Sao_Paulo'],
  ['буэнос-айрес', 'America/Argentina/Buenos_Aires'],
  ['лима', 'America/Lima'],
  ['богота', 'America/Bogota'],
  ['сантьяго', 'America/Santiago'],

  // Asia — major cities
  ['токио', 'Asia/Tokyo'],
  ['осака', 'Asia/Tokyo'],
  ['пекин', 'Asia/Shanghai'],
  ['шанхай', 'Asia/Shanghai'],
  ['гуанчжоу', 'Asia/Shanghai'],
  ['шэньчжэнь', 'Asia/Shanghai'],
  ['гонконг', 'Asia/Hong_Kong'],
  ['тайпей', 'Asia/Taipei'],
  ['сеул', 'Asia/Seoul'],
  ['сингапур', 'Asia/Singapore'],
  ['куала-лумпур', 'Asia/Kuala_Lumpur'],
  ['бангкок', 'Asia/Bangkok'],
  ['паттайя', 'Asia/Bangkok'],
  ['пхукет', 'Asia/Bangkok'],
  ['чиангмай', 'Asia/Bangkok'],
  ['бали', 'Asia/Makassar'],
  ['джакарта', 'Asia/Jakarta'],
  ['дубай', 'Asia/Dubai'],
  ['абу-даби', 'Asia/Dubai'],
  ['доха', 'Asia/Qatar'],
  ['эр-рияд', 'Asia/Riyadh'],
  ['мумбаи', 'Asia/Kolkata'],
  ['дели', 'Asia/Kolkata'],
  ['бангалор', 'Asia/Kolkata'],
  ['гоа', 'Asia/Kolkata'],
  ['тель-авив', 'Asia/Jerusalem'],
  ['иерусалим', 'Asia/Jerusalem'],
  ['хайфа', 'Asia/Jerusalem'],
  ['ханой', 'Asia/Ho_Chi_Minh'],
  ['хошимин', 'Asia/Ho_Chi_Minh'],
  ['манила', 'Asia/Manila'],

  // Oceania / Africa
  ['сидней', 'Australia/Sydney'],
  ['мельбурн', 'Australia/Melbourne'],
  ['брисбен', 'Australia/Brisbane'],
  ['перт', 'Australia/Perth'],
  ['окленд', 'Pacific/Auckland'],
  ['каир', 'Africa/Cairo'],
  ['кейптаун', 'Africa/Johannesburg'],
  ['йоханнесбург', 'Africa/Johannesburg'],
  ['найроби', 'Africa/Nairobi'],
  ['лагос', 'Africa/Lagos'],
  ['аддис-абеба', 'Africa/Addis_Ababa'],
  ['касабланка', 'Africa/Casablanca'],

  // Abbreviations
  ['мск', 'Europe/Moscow'],
  ['спб', 'Europe/Moscow'],
  ['екб', 'Asia/Yekaterinburg'],
  ['нск', 'Asia/Novosibirsk'],
];

// Build first-letter index for fast lookup
type CityEntry = { name: string; stemmed: string; timezone: string };
const cityIndex = new Map<string, CityEntry[]>();

for (const [name, timezone] of CITIES) {
  const stemmed = stemRussian(name);
  const firstChar = name[0]!;
  const entry: CityEntry = { name, stemmed, timezone };

  const list = cityIndex.get(firstChar);
  if (list) {
    list.push(entry);
  } else {
    cityIndex.set(firstChar, [entry]);
  }
}

// Also index abbreviations by their first character (they're already in CITIES)

/**
 * Match a Russian city name (any grammatical case) against the dictionary.
 * Uses stemming + Levenshtein fuzzy matching.
 * Returns IANA timezone or null.
 */
export function matchCity(input: string): string | null {
  const normalized = input
    .toLowerCase()
    .replace(/[?!.,;:]+$/g, '')
    .trim();
  if (normalized.length < 2) return null;

  const stemmed = stemRussian(normalized);

  // 1. Try exact stemmed match across all entries
  for (const entries of cityIndex.values()) {
    for (const entry of entries) {
      if (entry.stemmed === stemmed) return entry.timezone;
    }
  }

  // 2. Exact match on original name (for abbreviations like мск, спб)
  for (const entries of cityIndex.values()) {
    for (const entry of entries) {
      if (entry.name === normalized) return entry.timezone;
    }
  }

  // 3. Fuzzy match — check candidates by first letter
  const firstChar = normalized[0]!;
  const candidates = cityIndex.get(firstChar) ?? [];

  let bestMatch: CityEntry | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const entry of candidates) {
    const dist = levenshtein(stemmed, entry.stemmed);
    // Threshold: max 30% of the longer string's length, minimum 2
    const maxDist = Math.max(2, Math.floor(Math.max(stemmed.length, entry.stemmed.length) * 0.3));
    if (dist < bestDistance && dist <= maxDist) {
      bestDistance = dist;
      bestMatch = entry;
    }
  }

  if (bestMatch) return bestMatch.timezone;

  // 4. Multi-word: try matching individual words (e.g., "новгороде" → "новгород")
  const words = stemmed.split(/\s+/);
  if (words.length === 1 && words[0]!.length >= 4) {
    // Single word — search ALL entries for fuzzy match (not just first-letter)
    for (const entries of cityIndex.values()) {
      for (const entry of entries) {
        // Check if stemmed entry contains the word or vice versa
        const entryWords = entry.stemmed.split(/\s+/);
        for (const ew of entryWords) {
          const dist = levenshtein(words[0]!, ew);
          const maxDist = Math.max(2, Math.floor(Math.max(words[0]!.length, ew.length) * 0.3));
          if (dist < bestDistance && dist <= maxDist) {
            bestDistance = dist;
            bestMatch = entry;
          }
        }
      }
    }
    if (bestMatch) return bestMatch.timezone;
  }

  return null;
}
