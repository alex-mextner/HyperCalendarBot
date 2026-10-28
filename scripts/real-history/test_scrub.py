"""Unit tests of the scrubber on invented data. Run: python3 -m unittest scripts/real-history/test_scrub.py -v"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from scrub import Scrubber, norm

VOCAB = {
    norm(w)
    for w in [
        "завтра",
        "встреча",
        "встречу",
        "встречей",
        "с",
        "со",
        "на",
        "в",
        "к",
        "для",
        "у",
        "от",
        "про",
        "удали",
        "перенеси",
        "напомни",
        "позвони",
        "пригласи",
        "что",
        "когда",
        "где",
        "во",
        "сколько",
        "часа",
        "утра",
        "вечера",
        "день",
        "недели",
        "понедельник",
        "стендап",
        "врач",
        "врачем",
        "зуб",
        "кофе",
        "в",
        "офисе",
        "дома",
        "через",
        "минут",
        "час",
        "ровно",
        "создай",
        "событие",
        "мне",
        "и",
        "за",
        "не",
        "нет",
        "да",
        "привет",
        "спасибо",
        "москве",
        "сегодня",
    ]
}
PROPER = {norm("Москва")}


def make(entities=()):
    s = Scrubber(vocab=set(VOCAB), proper=set(PROPER), secret=b"k" * 32)
    for surface, kind in entities:
        s.add_entity(surface, kind)
    return s


class ScrubTest(unittest.TestCase):
    def test_names_decline_and_stay_stable(self):
        s = make([("Игорь", "first"), ("Петрова", "surname"), ("Лиза", "first")])
        a = s.scrub("встреча с Игорем завтра в 15:00")
        b = s.scrub("позвони Игорю и Игоря не трогай")
        self.assertNotIn("игор", norm(a + b))
        self.assertTrue(a.startswith("встреча с ") and a.endswith(" завтра в 15:00"))
        first = a.split()[2]
        self.assertTrue(first.endswith(("ом", "ем")), first)
        self.assertEqual(s.scrub("Игорь"), s.scrub("Игорь"))
        self.assertEqual(s.scrub("Игорем"), first)
        self.assertNotIn("лиз", norm(s.scrub("напомни Лизе про зуб")))

    def test_gender_and_dimunitive_kept(self):
        s = make([("Маша", "first"), ("Иван", "first")])
        out = s.scrub("с Машей и с Иваном")
        self.assertNotIn("маш", norm(out))
        self.assertNotIn("иван", norm(out))

    def test_letter_case_preserved(self):
        s = make([("Иван", "first")])
        self.assertTrue(s.scrub("ИВАН").isupper())
        self.assertTrue(s.scrub("иван")[0].islower())
        self.assertTrue(s.scrub("Иван")[0].isupper())

    def test_patterns(self):
        s = make()
        text = "пиши на a.b@mail.com или +7 (916) 555-12-34, @someone_real, https://t.me/secretchat 12345678901"
        out = s.scrub(text)
        for leaked in (
            "a.b@mail.com",
            "916",
            "555-12-34",
            "someone_real",
            "secretchat",
            "12345678901",
        ):
            self.assertNotIn(leaked, out)
        self.assertIn("@px_", out)
        self.assertIn("example.org", out)

    def test_dates_and_times_untouched(self):
        s = make()
        text = "2026-10-05T12:00:00+03:00 или 5.11.2026 в 09:30 и 8 900 15 20"
        out = s.scrub(text)
        self.assertTrue(out.startswith("2026-10-05T12:00:00+03:00 или 5.11.2026 в 09:30"))

    def test_address(self):
        s = make()
        out = s.scrub("встреча на улице Ленина 12, кв. 5")
        self.assertNotIn("Ленина", out)
        self.assertTrue(out.startswith("встреча на улице "))

    def test_unknown_capitalised_and_context_names(self):
        s = make()
        out = s.scrub("Позвони Козловой завтра. поехали в Хабаровск, потом с зинаидой")
        self.assertNotIn("Козлов", out)
        self.assertNotIn("Хабаровск", out)
        self.assertIn("Позвони ", out)
        self.assertIn(" завтра", out)

    def test_common_words_and_typos_kept(self):
        s = make()
        text = "Завтра встреча с врачем, напомни про стенддап"
        self.assertEqual(s.scrub(text), text)

    def test_places_from_dictionary_use_context(self):
        s = make()
        out = s.scrub("перенеси встречу на Москве")
        self.assertNotIn("Москв", out)

    def test_leak_gate(self):
        s = make([("Игорь", "first"), ("Хабаровск", "place")])
        self.assertEqual(s.leaks(s.scrub("Игорь едет в Хабаровске")), [])
        self.assertTrue(s.leaks("Игорь едет"))
        self.assertTrue(s.leaks("Хабаровске"))

    def test_mapping_roundtrip_is_stable(self):
        s = make([("Игорь", "first")])
        first = s.scrub("Игорь")
        again = Scrubber(
            vocab=set(VOCAB),
            proper=set(PROPER),
            secret=b"other-secret-that-differs-xxxxxxx",
            mapping=s.export_mapping(),
        )
        again.add_entity("Игорь", "first")
        self.assertEqual(again.scrub("Игорь"), first)

    def test_english(self):
        s = make([("Anton", "first")])
        out = s.scrub("meet Anton and Anton's friend")
        self.assertNotIn("Anton", out)


if __name__ == "__main__":
    unittest.main()
