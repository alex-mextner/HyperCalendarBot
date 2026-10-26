"""Pseudonymising scrubber for chat text (Russian and English), stdlib only.

Replaces personal data with CONSISTENT pseudonyms, never with deletions or invented noise:
  - first names, surnames, usernames (declension aware: «с Машей» -> «с Катей», «Ивану» -> «Борису»);
  - places, organisations, streets, house/flat numbers;
  - phones, e-mails, URLs, @handles, long digit ids, card-like numbers.
One stable mapping (lemma -> pseudonym) serves the whole corpus. Message structure, punctuation, typos, letter case
and every date or time word stay untouched. The mapping is private data: it is returned to the caller, never written
here, and the caller keeps it at 0600 outside git.

Run on the odroid only: the real text this module sees must not leave that host.
"""

from __future__ import annotations

import bisect
import hashlib
import hmac
import re
from dataclasses import dataclass, field, replace
from typing import Iterable

import pools

CYR = "А-Яа-яЁё"
LAT = "A-Za-z"
WORD_RE = re.compile(rf"[{LAT}{CYR}]+(?:[-'’][{LAT}{CYR}]+)*")
VERSION = "1.0.0"

# ─── paradigms ──────────────────────────────────────────────────────────────────────────────────────────────────
# class -> {case: canonical ending}; alternates list the other spellings accepted when reading a form.
CASES: dict[str, dict[str, str]] = {
    "hard": {"nom": "", "gen": "а", "dat": "у", "acc": "а", "ins": "ом", "prep": "е"},
    "soft": {"nom": "ь", "gen": "я", "dat": "ю", "acc": "я", "ins": "ем", "prep": "е"},
    "j": {"nom": "й", "gen": "я", "dat": "ю", "acc": "я", "ins": "ем", "prep": "е"},
    "iy": {"nom": "ий", "gen": "ия", "dat": "ию", "acc": "ия", "ins": "ием", "prep": "ии"},
    "a": {"nom": "а", "gen": "ы", "dat": "е", "acc": "у", "ins": "ой", "prep": "е"},
    "ya": {"nom": "я", "gen": "и", "dat": "е", "acc": "ю", "ins": "ей", "prep": "е"},
    "ia": {"nom": "ия", "gen": "ии", "dat": "ии", "acc": "ию", "ins": "ией", "prep": "ии"},
    "adjf": {"nom": "ая", "gen": "ой", "dat": "ой", "acc": "ую", "ins": "ой", "prep": "ой"},
    "none": {"nom": ""},
}
ALTERNATES: dict[str, dict[str, tuple[str, ...]]] = {
    "hard": {"ins": ("ем", "ым"), "gen": ("ого",), "dat": ("ому",)},
    "soft": {"ins": ("ём",)},
    "j": {"ins": ("ём",)},
    "a": {"gen": ("и",), "ins": ("ою",)},
    "ya": {"ins": ("ёй", "ею"), "gen": ("ы",)},
    "ia": {},
}
# Possessive adjectives of a- and ya-class names: «Машин телефон», «к Ваниному».
POSSESSIVE = ("ин", "ина", "ино", "ины", "ину", "иной", "иным", "ином", "иных")
NOMINATIVE_STRIP = {"hard": 0, "soft": 1, "j": 1, "iy": 2, "a": 1, "ya": 1, "ia": 2, "adjf": 2, "none": 0}

FUGITIVE = {"павел": "павл", "пётр": "петр", "лев": "льв", "петр": "петр"}
SURNAME_SUFFIXES = ("ов", "ев", "ёв", "ин", "ын", "ова", "ева", "ёва", "ина", "ына", "ский", "ская", "цкий", "цкая", "енко", "ук", "юк")
FEMALE_SURNAME_SUFFIXES = ("ова", "ева", "ёва", "ина", "ына", "ская", "цкая")
PLACE_PREPS = frozenset({"в", "во", "на", "из", "до", "около", "возле", "рядом", "по", "над", "под", "за", "от", "с", "со"})
PERSON_PREPS = frozenset({"с", "со", "к", "ко", "для", "у", "от", "про", "о", "об", "обо", "без", "напомни", "позвони", "пригласи", "и"})
GUESS_ENDINGS = tuple(
    sorted(
        ("ами", "ями", "ого", "ому", "ым", "им", "ом", "ем", "ём", "ой", "ей", "ёй", "ою", "ею", "ах", "ях", "ов", "ев",
         "а", "я", "у", "ю", "е", "ы", "и", "ь", "й"),
        key=len,
        reverse=True,
    )
)


MALE_NAMES = frozenset(x.lower() for x in pools.MALE_FULL + pools.MALE_DIM + pools.LATIN_MALE)
FEMALE_NAMES = frozenset(x.lower() for x in pools.FEMALE_FULL + pools.FEMALE_DIM + pools.LATIN_FEMALE)
URL_WORDS = frozenset({"https", "http", "www", "com", "org", "net", "example", "tme", "html"})
NAME_ENDING = re.compile(r"(?:ой|ей|ом|ем|ёй|ою|у|ю|е|а|я|ы|и)$")


def norm(text: str) -> str:
    return text.lower().replace("ё", "е")


def classify(lemma: str) -> str:
    low = lemma.lower()
    if re.search(r"[A-Za-z]", low):
        return "none"
    if low.endswith("ия"):
        return "ia"
    if low.endswith("ий"):
        return "iy"
    if low.endswith("ая"):
        return "adjf"
    if low.endswith("а"):
        return "a"
    if low.endswith("я"):
        return "ya"
    if low.endswith("й"):
        return "j"
    if low.endswith("ь"):
        return "soft"
    if low[-1:] in "бвгджзклмнпрстфхцчшщ":
        return "hard"
    return "none"


def stem_of(lemma: str, cls: str) -> str:
    low = lemma.lower()
    cut = NOMINATIVE_STRIP[cls]
    return low[: len(low) - cut] if cut else low


def with_case_of(model: str, word: str) -> str:
    if len(model) > 1 and model.isupper():
        return word.upper()
    if model[:1].isupper():
        return word[:1].upper() + word[1:]
    return word


def orthography(stem: str, ending: str) -> str:
    """Spelling rules that change an ending after the last stem letter (ы/и, о/е)."""
    last = stem[-1:]
    if ending.startswith("ы") and last in "гкхжчшщ":
        ending = "и" + ending[1:]
    if ending in ("ом", "ой", "ою") and last in "жчшщц":
        ending = "е" + ending[1:]
    if ending.startswith("ю") and last in "жчшщ":
        ending = "у" + ending[1:]
    if ending.startswith("я") and last in "жчшщ":
        ending = "а" + ending[1:]
    return ending


@dataclass(frozen=True)
class Entry:
    lemma: str  # nominative as stored, lower case
    cls: str
    kind: str  # first | surname | place | org | street | other
    gender: str  # m | f | -
    dim: bool
    real: bool  # from the private database (replaced whatever the letter case) vs gazetteer (only when capitalised)
    stems: tuple[str, ...]


@dataclass
class Hit:
    entry: Entry
    case: str
    ending: str


def _is_latin(word: str) -> bool:
    return re.search(rf"[{LAT}]", word) is not None and re.search(rf"[{CYR}]", word) is None


@dataclass
class Scrubber:
    vocab: set[str]  # normalised common words (Russian and English)
    proper: set[str]  # normalised lemmas of capitalised dictionary entries (places, names)
    secret: bytes
    mapping: dict[str, str] = field(default_factory=dict)
    entries: dict[str, Entry] = field(default_factory=dict)
    forms: dict[str, list[tuple[Entry, str, str]]] = field(default_factory=dict)
    used: set[str] = field(default_factory=set)
    real_norms: set[str] = field(default_factory=set)
    real_stems: set[str] = field(default_factory=set)
    stem_entries: dict[str, Entry] = field(default_factory=dict)
    counters: dict[str, int] = field(default_factory=dict)
    banned: set[str] = field(default_factory=set)
    _sorted_vocab: list[str] | None = None

    def __post_init__(self) -> None:
        self.used = {norm(value) for value in self.mapping.values()}
        self._load_gazetteer()

    # ─── entities ───────────────────────────────────────────────────────────────────────────────────────────────

    def _gender(self, lemma: str) -> str:
        low = lemma.lower()
        if low in MALE_NAMES:
            return "m"
        if low in FEMALE_NAMES or low.endswith(FEMALE_SURNAME_SUFFIXES):
            return "f"
        return "f" if low.endswith(("а", "я")) else "m"

    def _register(self, lemma: str, kind: str, real: bool) -> Entry | None:
        low = lemma.lower().strip()
        if len(low) < 2 or not WORD_RE.fullmatch(low):
            return None
        key = norm(low)
        existing = self.entries.get(key)
        if existing and (existing.real or not real):
            return existing
        cls = classify(low)
        gender = self._gender(low) if kind in ("first", "surname", "other") else "-"
        if kind == "other" and low.endswith(SURNAME_SUFFIXES):
            kind = "surname"
        dim = low in self._dims()
        stems = {stem_of(low, cls)}
        if low in FUGITIVE:
            stems.add(FUGITIVE[low])
        entry = Entry(low, cls, kind, gender, dim, real, tuple(sorted(norm(s) for s in stems)))
        self.entries[key] = entry
        self._index(entry)
        if real:
            self.real_norms.add(key)
            for stem in entry.stems:
                if len(stem) >= 3:
                    self.real_stems.add(stem)
                if len(stem) >= 5:
                    self.stem_entries.setdefault(stem, entry)
        return entry

    _DIMS: set[str] | None = None

    def _dims(self) -> set[str]:
        if Scrubber._DIMS is None:
            Scrubber._DIMS = {x.lower() for x in pools.MALE_DIM + pools.FEMALE_DIM}
        return Scrubber._DIMS

    def _index(self, entry: Entry) -> None:
        cls = entry.cls
        endings: list[tuple[str, str]] = [(case, ending) for case, ending in CASES[cls].items()]
        for case, extra in ALTERNATES.get(cls, {}).items():
            endings.extend((case, ending) for ending in extra)
        if cls in ("a", "ya") and entry.kind == "first":
            endings.extend(("poss", ending) for ending in POSSESSIVE)
        for stem in entry.stems:
            for case, ending in endings:
                form = norm(stem + ending)
                self.forms.setdefault(form, []).append((entry, case, ending))
            if cls == "none":
                self.forms.setdefault(norm(entry.lemma), []).append((entry, "nom", ""))
                for suffix in ("'s", "’s"):
                    self.forms.setdefault(norm(entry.lemma + suffix), []).append((entry, "poss", suffix))

    def _load_gazetteer(self) -> None:
        groups = (
            (pools.MALE_FULL + pools.MALE_DIM + pools.FEMALE_FULL + pools.FEMALE_DIM + pools.LATIN_MALE + pools.LATIN_FEMALE, "first"),
            (pools.PLACES, "place"),
        )
        for names, kind in groups:
            for name in names:
                self._register(name, kind, real=False)
        for lemma in self.proper:
            if lemma not in self.entries and 3 <= len(lemma) <= 24 and WORD_RE.fullmatch(lemma):
                self._register(lemma, "other", real=False)

    def add_entity(self, surface: str, kind: str, *, always: bool = True) -> None:
        """A real string of the private database. `kind` first | surname | place | org | street | other | text.

        Name-like kinds register every token. `text` (event titles, notes) registers only tokens outside the common
        vocabulary, so «стендап» stays and a proper noun in the same title goes."""
        surface = self.EMAIL.sub(" ", self.URL.sub(" ", surface))
        first_word = True
        for token in WORD_RE.findall(surface):
            at_start, first_word = first_word, False
            for part in re.split(r"[-'’]", token):
                low = norm(part)
                if len(low) < 3 or low in pools.SAFE_PROPER or low in URL_WORDS or low in pools.NEVER_ENTITY:
                    continue
                ordinary = low in self.vocab and low not in self.proper and low not in MALE_NAMES and low not in FEMALE_NAMES
                if ordinary and kind in ("text", "other"):
                    continue  # a common word is not personal data, even when someone used it as a username
                if ordinary:
                    self._register(part, kind, real=False)  # a first name that is also a word: replaced when capitalised
                elif kind == "text":
                    # Free text: a capitalised word in the middle of a phrase is a proper noun; the first word is
                    # capitalised anyway, so it counts only when it looks like a name. Lower-case slang is not personal.
                    capitalised = part[:1].isupper() and not part.isupper()
                    nameish = low in self.proper or low.endswith(SURNAME_SUFFIXES) or _is_latin(part)
                    if capitalised and (not at_start or nameish):
                        self._register(part, "other", real=True)
                else:
                    self._register(part, kind, real=True)

    # ─── pseudonyms ─────────────────────────────────────────────────────────────────────────────────────────────

    def _pool(self, entry: Entry) -> list[str]:
        latin = _is_latin(entry.lemma)
        if entry.kind == "first":
            if latin:
                return pools.LATIN_FEMALE if entry.gender == "f" else pools.LATIN_MALE
            if entry.gender == "f":
                return pools.FEMALE_DIM if entry.dim else pools.FEMALE_FULL
            return pools.MALE_DIM if entry.dim else pools.MALE_FULL
        if entry.kind == "surname":
            if latin:
                return pools.LATIN_MALE
            base = pools.SURNAMES
            return [name + "а" for name in base] if entry.gender == "f" else list(base)
        if entry.kind == "place":
            return pools.PLACES if not latin else pools.LATIN_MALE
        if entry.kind == "street":
            return pools.STREETS
        if latin:
            return pools.LATIN_FEMALE if entry.gender == "f" else pools.LATIN_MALE
        return pools.ORGANISATIONS

    def _pseudonym(self, entry: Entry, classes: tuple[str, ...] | None = None) -> Entry:
        key = norm(entry.lemma)
        chosen = self.mapping.get(key)
        if chosen is None:
            everything = self._pool(entry)
            if classes:
                everything = [name for name in everything if classify(name) in classes] or everything
            pool = [name for name in everything if not self._is_real_form(name) and norm(name) not in self.banned] or list(everything)
            digest = hmac.new(self.secret, f"{entry.kind}|{entry.gender}|{key}".encode(), hashlib.sha256).digest()
            start = int.from_bytes(digest[:8], "big")
            for offset in range(len(pool)):
                candidate = pool[(start + offset) % len(pool)]
                if norm(candidate) not in self.used:
                    chosen = candidate
                    break
            if chosen is None:  # pool exhausted: a numbered variant keeps the mapping injective
                self.counters[entry.kind] = self.counters.get(entry.kind, 0) + 1
                chosen = f"{pool[start % len(pool)]}{self.counters[entry.kind] + 1}"
            self.mapping[key] = chosen
            self.used.add(norm(chosen))
        cls = classify(chosen)
        return Entry(chosen.lower(), cls, entry.kind, entry.gender, entry.dim, False, (norm(stem_of(chosen, cls)),))

    def _is_real_form(self, name: str) -> bool:
        low = norm(name)
        if low in self.real_norms or low in self.real_stems or any(hit[0].real for hit in self.forms.get(low, ())):
            return True
        return len(low) >= 5 and any(low.startswith(stem) and len(low) - len(stem) <= 3 for stem in self.stem_entries)

    def _render(self, hit: Hit, original: str) -> str:
        for _ in range(8):
            target = self._pseudonym(hit.entry)
            stem = stem_of(target.lemma, target.cls)
            if hit.case in ("poss", "x") or target.cls == hit.entry.cls:
                ending = hit.ending
            else:
                ending = CASES[target.cls].get(hit.case, CASES[target.cls]["nom"])
            word = stem + orthography(stem, ending)
            if target.cls == "none":
                word = target.lemma + hit.ending if hit.case in ("poss", "x") else target.lemma
            if not self._is_real_form(word):
                break
            self._reroll(hit.entry)  # the inflected pseudonym happens to be a real entity's form
        return with_case_of(original, word)

    def _reroll(self, entry: Entry) -> None:
        self.banned.add(norm(self.mapping.pop(norm(entry.lemma))))

    # ─── unknown proper nouns ───────────────────────────────────────────────────────────────────────────────────

    def _unknown(self, token: str, previous: str) -> str:
        low = norm(token)
        latin = _is_latin(token)
        ending, stem = "", low
        if not latin:
            for candidate in GUESS_ENDINGS:
                if low.endswith(candidate) and len(low) - len(candidate) >= 3:
                    ending, stem = candidate, low[: -len(candidate)]
                    break
        female = ending in ("а", "я", "ой", "ую", "ою")
        if stem.endswith(("ов", "ев", "ин", "ын", "ск")) or low.endswith(SURNAME_SUFFIXES):
            kind = "surname"
            female = low.endswith(FEMALE_SURNAME_SUFFIXES) or (ending in ("ой", "ую", "ою", "а") and stem.endswith(("ов", "ев", "ин", "ын")))
        elif previous in PLACE_PREPS - {"с", "со", "от"}:
            kind, female = "place", False
        elif previous in PERSON_PREPS:
            kind = "first"
        else:
            kind, female = "org", False
        probe = Entry(stem, "none" if latin else "hard", kind, "f" if female else "m", False, True, (stem,))
        self._propagate(probe, stem, latin, low)
        for _ in range(8):
            target = self._pseudonym(probe, classes=None if latin else ("hard", "a"))
            if latin:
                word = target.lemma
            else:
                target_stem = stem_of(target.lemma, target.cls)
                tail = ending if ending or target.cls == "hard" else CASES[target.cls]["nom"]
                word = target_stem + orthography(target_stem, tail)
            if not self._is_real_form(word):
                break
            self._reroll(probe)
        return with_case_of(token, word)

    def _propagate(self, probe: Entry, stem: str, latin: bool, exact: str) -> None:
        """A word found to be a proper noun is one everywhere: later (or, in a second pass, earlier) lower-case and
        inflected occurrences are replaced by the same pseudonym."""
        if norm(probe.lemma) in self.entries and self.entries[norm(probe.lemma)].real:
            return
        self.entries[norm(probe.lemma)] = probe
        self.real_norms.add(norm(stem) if len(stem) >= 5 else exact)
        if len(stem) >= 5:
            for ending in ("",) if latin else ("",) + GUESS_ENDINGS:
                self.forms.setdefault(norm(stem + ending), []).append((probe, "x", ending))
        self.forms.setdefault(exact, []).append((probe, "x", exact[len(stem):] if exact.startswith(stem) else ""))
        if len(stem) >= 5:
            self.stem_entries.setdefault(stem, probe)
            self.real_stems.add(stem)

    def _plausibly_typo(self, low: str) -> bool:
        """A one-edit neighbour of a common word is a typo, not a name."""
        letters = "абвгдежзийклмнопрстуфхцчшщъыьэюя"
        for index in range(len(low) + 1):
            for letter in letters if re.search(rf"[{CYR}]", low) else "abcdefghijklmnopqrstuvwxyz":
                if index < len(low) and norm(low[:index] + letter + low[index + 1 :]) in self.vocab:
                    return True
                if norm(low[:index] + letter + low[index:]) in self.vocab:
                    return True
            if index < len(low) and norm(low[:index] + low[index + 1 :]) in self.vocab:
                return True
            if index + 1 < len(low) and norm(low[:index] + low[index + 1] + low[index] + low[index + 2 :]) in self.vocab:
                return True
        return False

    # ─── text ───────────────────────────────────────────────────────────────────────────────────────────────────

    def _word_pass(self, text: str) -> str:
        out: list[str] = []
        cursor = 0
        previous = ""
        for match in WORD_RE.finditer(text):
            start, end = match.span()
            out.append(text[cursor:start])
            token = match.group(0)
            lead = text[:start].rstrip(" \t«\"“'(")
            sentence_start = lead == "" or lead[-1:] in ".!?…\n" or text[:start].rstrip(" \t").endswith("\n")
            parts = re.split(r"([-'’])", token)
            rebuilt = []
            for part in parts:
                if part in ("-", "'", "’"):
                    rebuilt.append(part)
                else:
                    rebuilt.append(self._token(part, previous, sentence_start and len(parts) == 1, token))
            out.append("".join(rebuilt))
            previous = norm(token)
            cursor = end
        out.append(text[cursor:])
        return "".join(out)

    def _context_kind(self, entry: Entry, previous: str) -> Entry:
        """An entity of unknown nature takes its pool from the word before it («в …» place, «с …» person)."""
        if entry.kind != "other":
            return entry
        if previous in PLACE_PREPS - {"с", "со", "от"}:
            return replace(entry, kind="place")
        if previous in PERSON_PREPS:
            return replace(entry, kind="first", gender=self._gender(entry.lemma))
        return entry

    def _is_inflected_word(self, low: str) -> bool:
        """True when `low` is the stem of a longer dictionary word (an inflection, not a name)."""
        if self._sorted_vocab is None:
            self._sorted_vocab = sorted(self.vocab)
        index = bisect.bisect_left(self._sorted_vocab, low)
        return index < len(self._sorted_vocab) and self._sorted_vocab[index].startswith(low) and len(self._sorted_vocab[index]) - len(low) <= 4

    def _token(self, token: str, previous: str, sentence_start: bool, whole: str) -> str:
        low = norm(token)
        if low in pools.SAFE_PROPER or low in pools.NEVER_ENTITY or low == "s" and "'" in whole:
            return token
        capital = token[:1].isupper()
        common = low in self.vocab
        hits = self.forms.get(low)
        if hits:
            real = [hit for hit in hits if hit[0].real]
            if real:
                entry, case, ending = real[0]
                return self._render(Hit(self._context_kind(entry, previous), case, ending), token)
            ordinary = sentence_start and low in pools.NAME_LIKE_COMMON_WORDS
            if capital and not ordinary:
                entry, case, ending = hits[0]
                return self._render(Hit(self._context_kind(entry, previous), case, ending), token)
        if len(low) >= 5 and not common:
            for stem, entry in self.stem_entries.items():
                if low.startswith(stem) and len(low) - len(stem) <= 3:
                    return self._render(Hit(self._context_kind(entry, previous), "x", low[len(stem):]), token)
        if len(low) < 4:
            return token
        if capital and not sentence_start:
            return token if common and low not in self.proper else self._unknown(token, previous)
        if capital:
            return token if common or self._plausibly_typo(low) or self._is_inflected_word(low) else self._unknown(token, previous)
        if previous in PERSON_PREPS and not common and NAME_ENDING.search(low) and not self._plausibly_typo(low):
            return self._unknown(token, previous)
        return token

    # ─── patterns ───────────────────────────────────────────────────────────────────────────────────────────────

    KEEP = re.compile(
        r"\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?"
        r"|\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b|\b\d{1,2}:\d{2}(?::\d{2})?\b"
    )
    URL = re.compile(r"(?i)\b(?:https?://|www\.|t\.me/|tg://)[^\s<>\"')\]]+|\b[a-z0-9-]+\.(?:com|org|net|ru|io|me|app|dev)(?:/[^\s<>\"')\]]*)?")
    EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
    HANDLE = re.compile(r"(?<![\w@])@[A-Za-z0-9_]{4,32}\b")
    CARD = re.compile(r"(?<!\d)(?:\d{4}[ -]){3}\d{4}(?!\d)")
    PHONE = re.compile(r"(?<![\w])(?:\+\d|\b[78]|\b9)(?:[\s().-]{0,2}\d){9,13}(?!\d)")
    DIGITS = re.compile(r"(?<![\d.,])\d{6,}(?!\d)")
    ADDRESS = re.compile(
        rf"(?i)\b(?P<kw>ул(?:ица|ицу|ице|ицы|\.)?|просп(?:ект\w*|\.)|пр-кт|пр-т|переул\w+|пер\.|площад\w+|пл\.|бульвар\w*|б-р|шоссе|набережн\w+|наб\.)"
        rf"\s+(?P<street>[{CYR}A-Za-z]+(?:\s+[{CYR}A-Za-z]+)?)(?P<house>(?:[,\s]+(?:д\.?|дом)?\s*\d+[{CYR}]?(?:\s*(?:к|корп\.?|стр\.?|с)\s*\d+)?)?(?:[,\s]+(?:кв\.?|квартира|оф\.?|офис)\s*\d+)?)"
    )

    def _tag(self, kind: str, value: str) -> str:
        return hmac.new(self.secret, f"{kind}|{value.lower()}".encode(), hashlib.sha256).hexdigest()

    def _digits_like(self, kind: str, value: str, keep_prefix: int = 0) -> str:
        stream = self._tag(kind, value)
        out, index = [], 0
        for ch in value:
            if ch.isdigit():
                if keep_prefix > 0:
                    keep_prefix -= 1
                    out.append(ch)
                else:
                    shifted = (int(stream[index % len(stream)], 16) + 1 + int(ch)) % 10
                    out.append(str(shifted if str(shifted) != ch else (shifted + 1) % 10))
                    index += 1
            else:
                out.append(ch)
        return "".join(out)

    def _replace_span(self, kind: str, value: str) -> str:
        tag = self._tag(kind, value)
        if kind == "url":
            return f"https://example.org/p{tag[:8]}"
        if kind == "email":
            return f"user{tag[:6]}@example.org"
        if kind == "handle":
            return f"@px_{tag[:8]}"
        if kind == "phone":
            keep = 2 if value.startswith("+") else 1 if value[:1] in "78" else 0
            return self._digits_like("phone", value, keep_prefix=keep)
        return self._digits_like(kind, value)

    def _address(self, match: re.Match[str]) -> str:
        street = match.group("street")
        words = street.split()
        fake = []
        for word in words:
            entry = Entry(norm(word), classify(word), "street", "f", False, True, (norm(word),))
            fake.append(self._pseudonym(entry).lemma.capitalize() if word[:1].isupper() else self._pseudonym(entry).lemma)
        house = re.sub(r"\d+", lambda m: str((int(m.group(0)) % 97) + 3 if len(m.group(0)) < 4 else self._digits_like("addr", m.group(0))), match.group("house"))
        return f"{match.group('kw')} {' '.join(fake)}{house}"

    def scrub(self, text: str) -> str:
        spans: list[tuple[int, int, str, str]] = []
        taken: list[tuple[int, int]] = []

        def free(start: int, end: int) -> bool:
            return all(end <= other_start or start >= other_end for other_start, other_end in taken)

        for pattern, kind in (
            (self.KEEP, "keep"),
            (self.EMAIL, "email"),
            (self.URL, "url"),
            (self.HANDLE, "handle"),
            (self.CARD, "card"),
            (self.PHONE, "phone"),
            (self.DIGITS, "id"),
            (self.ADDRESS, "address"),
        ):
            for match in pattern.finditer(text):
                if free(match.start(), match.end()):
                    if kind == "phone" and (re.search(r"\d{4}-\d{2}-\d{2}|:", match.group(0)) or not re.search(r"\d{3}", match.group(0))):
                        continue
                    taken.append((match.start(), match.end()))
                    spans.append((match.start(), match.end(), kind, match.group(0)))
        spans.sort()
        out: list[str] = []
        cursor = 0
        for start, end, kind, value in spans:
            out.append(self._word_pass(text[cursor:start]) if start > cursor else "")
            if kind == "keep":
                out.append(value)
            elif kind == "address":
                out.append(self._address(self.ADDRESS.fullmatch(value)))  # type: ignore[arg-type]
            else:
                out.append(self._replace_span(kind, value))
            cursor = end
        out.append(self._word_pass(text[cursor:]))
        return "".join(out)

    def scrub_json(self, value):  # noqa: ANN001, ANN201
        if isinstance(value, str):
            return self.scrub(value)
        if isinstance(value, list):
            return [self.scrub_json(item) for item in value]
        if isinstance(value, dict):
            return {key: self.scrub_json(item) for key, item in value.items()}
        if isinstance(value, int) and not isinstance(value, bool) and abs(value) >= 100000:
            return int(self._digits_like("jsonid", str(abs(value))))
        return value

    # ─── leak gate ──────────────────────────────────────────────────────────────────────────────────────────────

    def leaks(self, text: str) -> list[tuple[str, str, str]]:
        """Real entity forms left in scrubbed text: (reason, token, entity kind). Callers print the token only when it
        is a common word."""
        found: list[tuple[str, str, str]] = []
        for match in WORD_RE.finditer(text):
            for part in re.split(r"[-'’]", match.group(0)):
                low = norm(part)
                if low in pools.SAFE_PROPER or low in pools.NEVER_ENTITY:
                    continue
                hits = self.forms.get(low)
                real = [hit for hit in hits if hit[0].real] if hits else []
                if real and low not in URL_WORDS:
                    found.append(("form", low, real[0][0].kind))
                    continue
                if len(low) >= 5:
                    for stem in self.real_stems:
                        if len(stem) >= 5 and low.startswith(stem) and len(low) - len(stem) <= 3 and low not in self.used and low not in self.vocab and not any(low.startswith(norm(v)) for v in self.mapping.values() if len(v) >= 4):
                            found.append(("stem", low, "stem"))
                            break
        return found

    def export_mapping(self) -> dict[str, str]:
        return dict(sorted(self.mapping.items()))


def checksum(lines: Iterable[str]) -> str:
    digest = hashlib.sha256()
    for line in lines:
        digest.update(line.encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()
