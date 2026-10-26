"""Name, place and street pools of the real-history scrubber.

Two jobs: (1) a gazetteer, so a first name in a message is recognised even when it is in no database table;
(2) the pools the pseudonyms are drawn from. Everything here is public vocabulary, never data of a real person.
A pool entry that collides with a real entity of the corpus is skipped by the scrubber, so the pseudonym of a
person is never the name of another real person of the same corpus.
"""

# Full forms and diminutives are separate so a diminutive is replaced by a diminutive.
MALE_FULL = """Аркадий Борис Вадим Валентин Василий Виктор Виталий Владимир Всеволод Геннадий Георгий Глеб Григорий Даниил
Денис Дмитрий Евгений Егор Захар Игнат Кирилл Константин Леонид Максим Матвей Никита Николай Олег Роман Руслан
Семён Степан Тимофей Тимур Эдуард Юрий Ярослав Ян Артём Артур Богдан Вячеслав Герман Давид Данил Мирон Прохор
Родион Станислав Платон Эмиль Альберт Анатолий Аскольд Ефим Корней Марк Радик Савелий Тихон Лука Игорь Антон Иван
Алексей Андрей Сергей Михаил Александр Пётр Павел Фёдор Лев Илья Артемий Назар Святослав Мартин Ростислав Гордей
Елисей Влад Аристарх Ермолай Мстислав""".split()
MALE_DIM = """Саша Женя Миша Коля Вася Петя Витя Дима Лёша Алёша Толя Гоша Паша Серёжа Слава Стёпа Ваня Юра Гена Костя
Лёня Макс Тёма Данила Лёва Боря Гриша Жора Валя Тоша Антоша Вова Володя Серёга Санёк Ванька Димон Лёха Кеша
Шура Вадик Стас Марик Рома Руся Тима Яша Эдик""".split()
FEMALE_FULL = """Алла Алина Алиса Альбина Валентина Валерия Варвара Василиса Виктория Галина Дарья Диана Евгения Екатерина
Елена Елизавета Жанна Зинаида Инга Инна Ирина Карина Кира Клавдия Лариса Лидия Маргарита Милана Нина Оксана Олеся
Полина Раиса Регина Светлана Софья Тамара Татьяна Ульяна Фаина Эльвира Юлия Яна Анастасия Анна Александра Анжела
Антонина Арина Вероника Дина Ева Злата Изабелла Ильсияр Капитолина Кристина Ксения Любава Людмила Мария Марина
Надежда Наталья Ольга Софа Тая Эвелина Эмилия Ярослава Агата Берта Владислава Эльмира Гульнара Зарина Лейла Мадина
Оливия Рената Стелла Таисия Элина""".split()
FEMALE_DIM = """Аня Катя Оля Лена Таня Юля Ира Наташа Света Настя Вика Даша Лера Маша Саша Женя Надя Люда Ася Алёна Аллочка
Дуся Лиза Соня Тоня Фая Эля Яна Юляша Леся Лиля Милка Нюра Рита Тома Зоя Валя Вера Люба Ната Танюша Катюша
Машенька Оленька Анечка Ксюша Ксюня Полли Лика Лана""".split()

# Names that are also ordinary words: recognised as a name only when the database says so.
NAME_LIKE_COMMON_WORDS = frozenset(
    "вера надежда любовь роза мира лада марина весна мила слава лука герман платон давид марк мартин лев".split()
)

LATIN_MALE = """Adam Alan Alex Andrew Anthony Arthur Ben Brian Carl Chris Daniel David Dylan Edward Eric Ethan Felix Frank
George Henry Isaac Jack James Jason Jeff Kevin Leo Liam Luke Mark Martin Max Michael Neil Noah Oliver Oscar Patrick
Paul Peter Philip Ralph Robert Sam Simon Stephen Thomas Tim Tom Victor Walter William Zack Aaron Albert Austin
Blake Bruce Caleb Cole Colin Craig Dean Derek Dustin Elliot Evan Gavin Glen Grant Harold Hugo Ivan Jacob Joel Jonas
Keith Lance Logan Louis Marcus Nathan Nolan Owen Quentin Reed Ryan Scott Seth Trevor Tyler Wesley Xavier""".split()
LATIN_FEMALE = """Alice Amy Anna Anne Beth Carla Carol Claire Diana Elena Ella Emily Emma Eva Fiona Grace Hannah Helen Irene
Jane Jenny Julia Karen Kate Laura Lily Linda Lucy Maria Megan Mia Nancy Nina Olivia Rachel Rose Ruth Sara Sofia
Sophie Tina Vera Zoe Abby Alexa Bella Bianca Brenda Chloe Daisy Dora Edith Elsa Erin Faith Gina Heidi Holly Ida
Iris Jade Jill Joan Kara Lena Lola Mabel Maya Nora Opal Paige Quinn Rita Sally Tess Uma Vivian Wendy Yara""".split()

# Surnames (hard-declension stems with the masculine nominative; the feminine form is derived by the scrubber).
SURNAMES = """Воронов Тихонов Лебедев Захаров Киселёв Мартынов Овчинников Дроздов Беляев Комаров Селиверстов Жуков
Гаврилов Ершов Некрасов Рыбаков Булатов Маслов Анисимов Колесников Сорокин Прохоров Данилов Симонов Фомин
Широков Ларионов Блинов Субботин Родионов Ширяев Мельников Русаков Кудрявцев Горелов""".split()

# Places: invented-feeling picks among small real towns, so a place reads like a place. Hard/soft-declension lemmas.
PLACES = """Тверь Курск Омск Псков Тула Пенза Рязань Липецк Тамбов Саранск Ижевск Ульяновск Киров Курган Орёл Вологда
Калуга Брянск Смоленск Кострома Иваново Владимир Чебоксары Ставрополь Магадан Абакан Ухта Сургут Нальчик
Элиста Майкоп Черкесск Грозный Назрань""".split()
# Prepositional-case endings of the places differ, so the pool is listed with the paradigm class the scrubber
# derives from the lemma ending (see scrub.classify).

ORGANISATIONS = """Вектор Орион Альфатех Меридиан Стрела Кедр Лазурь Полюс Горизонт Север Зенит Маяк Квант Ладога Сфера
Радуга Ямал Арсенал Мозаика Фаворит Прогресс Элемент Атлас Бриз Аврора Байкал Витязь Гранит Динамо Заря Импульс
Кристалл Лотос Магнит Навигатор Олимп Парус Ракурс Сапфир Титан Урал Феникс Хорс Цитадель Шторм Эксперт Юпитер Яхонт
Алмаз Бастион Вега Гарант Дельта Эталон Жемчуг Звезда Идеал Колос Лидер Мустанг Нептун Оазис Пилот Родник Сигма
Тандем Универсал Фокус Хронос Чайка Шанс Эпоха Ювента Ясень Ампер Бирюза Волна Грифон Дубрава Ермак Журавль Зодиак
Исток Кедровка Лиман Мираж Нарцисс Оникс Пегас Рубин Скиф Топаз Улей Фрегат Хутор Цветок Шелк Эхо""".split()

STREETS = """Лесная Речная Заречная Луговая Садовая Тенистая Каштановая Ясная Просторная Зелёная Звёздная Тихая
Весенняя Кленовая Липовая Озёрная Рябиновая Сосновая Дальняя Светлая Ромашковая Ореховая Берёзовая Ветровая""".split()

# Words that look like names to the capitalisation heuristic but are not personal data.
SAFE_PROPER = frozenset(
    x.lower()
    for x in """Telegram Google Zoom Meet Skype WhatsApp Outlook Gmail Apple iPhone iPad Android Windows Linux YouTube
GPT ChatGPT Claude Gemini ИИ Бот Календарь Календарю Календаря Календаре Гугл Зум Телеграм Телеграмм Гугле Ютуб
Понедельник Вторник Среда Среду Четверг Пятница Пятницу Суббота Субботу Воскресенье Январь Февраль Март Апрель Май
Июнь Июль Август Сентябрь Октябрь Ноябрь Декабрь Января Февраля Марта Апреля Мая Июня Июля Августа Сентября Октября
Ноября Декабря Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July
August September October November December Mon Tue Wed Thu Fri Sat Sun Jan Feb Mar Apr Jun Jul Aug Sep Oct Nov Dec
Россия России Россию Украина Беларусь Казахстан Сербия Германия Италия Испания Франция
Today Tomorrow OK Ok UTC GMT PM AM ДР ВС ПН ВТ СР ЧТ ПТ СБ Да Нет Привет Спасибо Пожалуйста Здравствуйте""".split()
)

# Ordinary words that the heuristics once mistook for names (a title word, a sentence-initial verb form, an English
# interface word). Never registered as an entity and never replaced.
NEVER_ENTITY = frozenset(
    """bot calendar group hair happy ultra user при приглашен беды бит армии красной республики отключен ошибк
ошибка ошибки перелет планк промен разда склад утилит утилита утилите утилиту маркет прием приема приему""".split()
)
