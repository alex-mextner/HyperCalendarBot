// src/config/constants/messages/en/tips.ts
// Bot tips, productivity quote sets and contextual tips.

export const enTips = {
  botTips: {
    // ── Creating events ──
    voice_create: "💡 Send a voice message to quickly create an event — I'll understand!",
    add_command: '💡 Use /add to create a new event step by step.',
    natural_language: '💡 Just type naturally: "Dentist on Friday at 3pm" — I\'ll create the event.',
    recurring_events: '💡 I can create recurring events — try "standup every weekday at 10am".',
    complex_recurrence: '💡 "Lunch with Anna every other Thursday at 1pm" — I handle complex recurrences too.',
    ics_import: '💡 Import your existing calendar — just send an .ics file to this chat.',
    // ── Reminders & not forgetting ──
    call_before_flight: "💡 Don't want to miss a flight? Add your airport arrival time and ask me to call you!",
    multiple_reminders: '💡 Set multiple reminders: "remind me 1 day and 2 hours before the meeting".',
    voice_calls: '💡 I can call you on the phone before an important event — enable voice calls in /settings.',
    daily_medicine: '💡 "Remind me to take medicine every day at 8am" — I\'ll send a notification daily.',
    birthday_reminder: "💡 Set a reminder for a friend's birthday so you have time to pick a gift.",
    // ── Planning & overview ──
    week_overview: '💡 Ask "what\'s my week look like?" for a quick overview.',
    free_slots: '💡 "When am I free on Wednesday?" — I\'ll find open slots in your schedule.',
    month_view: '💡 Use /month to see a visual calendar of the whole month.',
    meeting_count: '💡 "How many meetings do I have this week?" — I can count and summarize.',
    morning_agenda:
      '💡 Set up a morning agenda to start every day knowing what\'s ahead — "set morning agenda to 7:30".',
    evening_review: '💡 Enable the evening review to prepare for tomorrow — "turn on evening review at 9pm".',
    // ── Sharing & collaboration ──
    share_schedule: '💡 Share your schedule: "share my week with @username" — they\'ll see your events.',
    invite_people: '💡 Invite people to events: "invite @anna to Friday\'s dinner".',
    accept_decline: '💡 When someone sends you an invitation, you can accept, decline, or propose a different time.',
    group_calendar: '💡 Add the bot to a group chat to manage a shared group calendar!',
    secretary_access: "💡 Give a colleague secretary access to manage your calendar when you're busy.",
    // ── Google Calendar ──
    connect_google: '💡 Connect Google Calendar with /connect_google — all your events will sync automatically.',
    google_sync: '💡 After connecting Google, events from all your Google calendars appear here.',
    // ── Life situations: Travel ──
    pack_suitcase: '💡 Planning a trip? Add "Pack suitcase" the day before and "Taxi to airport" with the exact time.',
    hotel_checkin: "💡 Add hotel check-in/check-out times to your calendar so you don't miss them.",
    visa_appointment:
      '💡 "Visa appointment on March 15 at 9am, remind me 1 week and 1 day before" — for documents prep.',
    timezone_change: '💡 Crossing time zones? Change your timezone: "set my timezone to America/New_York".',
    // ── Life situations: Health ──
    doctor_checkup: '💡 "Doctor appointment every 6 months" — I\'ll remind you to schedule checkups.',
    gym_sessions: '💡 Track gym sessions: "gym every Mon, Wed, Fri at 7pm" — see how consistent you are.',
    drink_water: '💡 "Remind me to drink water every 2 hours" — health habits as calendar events!',
    // ── Life situations: Work ──
    weekly_oneone: '💡 Weekly 1-on-1? "1-on-1 with manager every Tuesday at 4pm, remind 15 min before".',
    sprint_review: '💡 "Sprint review every other Friday at 3pm" — I handle biweekly schedules.',
    prep_time: '💡 Before a presentation, add prep time: "Prep slides — Friday 2pm to 4pm".',
    event_descriptions: '💡 Use event descriptions to keep meeting agendas and notes organized.',
    // ── Life situations: Personal ──
    anniversary: '💡 Never forget an anniversary — "Wedding anniversary every year on June 15".',
    movie_premieres: "💡 Add movie premieres, concert dates, or game releases you're excited about.",
    rent_payment: '💡 "Rent payment every month on the 1st" — financial deadlines stay on track.',
    subscriptions: '💡 Track subscriptions: "Netflix renewal every month on the 12th" — know when charges hit.',
    reading_challenge: '💡 Reading challenge? "Read for 30 min every evening at 9pm" — build a habit.',
    // ── Life situations: Family ──
    family_calendar: '💡 Share your family calendar in a group chat — everyone sees school events and activities.',
    kids_swimming: '💡 "Kids swimming class every Saturday at 10am" — family routines made easy.',
    school_events: '💡 Add school parent meetings, picture days, and holidays to the group calendar.',
    // ── Life situations: Social ──
    birthday_party: '💡 "Birthday party for Max — Saturday 6pm at The Pub" — then invite friends from contacts.',
    decline_propose: "💡 Can't make it? Decline an invitation and propose a better time — the organizer gets notified.",
    find_free_time: '💡 Use /free to find a time that works: "when am I free this Saturday afternoon?"',
    // ── Power features ──
    context_awareness: '💡 I remember context — say "move it to 3pm" and I\'ll know which event you mean.',
    automated_reminders: '💡 Schedule automated messages: "remind me every Friday at 5pm to submit timesheets".',
    public_holidays: "💡 Use /holidays to subscribe to public holidays — they'll appear in your calendar.",
    save_contacts: '💡 Save contacts (/contacts) and invite them to events by name — no need for usernames.',
    quiet_hours: "💡 Set up quiet hours so I don't disturb you at night — check /settings.",
    language_switch: '💡 I speak Russian and English — switch language anytime in /settings.',
    action_log: '💡 Send /log to see a full history of actions taken on your calendar.',
    past_events: '💡 "What did I have last Tuesday?" — I can look up past events too.',
    // ── Telegram connect ──
    connect_telegram:
      '📱 Connect your Telegram account so event invitations come from you personally — people respond much better. /connect_telegram',
  },
  gtdQuotes: [
    // David Allen, "Getting Things Done: The Art of Stress-Free Productivity" (2001/2015)
    // Quotes verified across multiple public sources (Goodreads, GTD Forums, official site)
    '📖 "Your mind is for having ideas, not holding them." — David Allen, GTD, ch. 1',
    '📖 "If you don\'t pay appropriate attention to what has your attention, it will take more of your attention than it deserves." — David Allen, GTD, ch. 2',
    '📖 "Your ability to generate power is directly proportional to your ability to relax." — David Allen, GTD, ch. 1',
    '📖 "You don\'t actually do a project; you can only do action steps related to it." — David Allen, GTD, ch. 3',
    '📖 "Much of the stress that people feel doesn\'t come from having too much to do. It comes from not finishing what they\'ve started." — David Allen, GTD, ch. 6',
    '📖 "It is easier to act yourself into a better way of feeling than to feel yourself into a better way of action." — David Allen, GTD, ch. 12',
    '📖 "Most people feel best about their work the week before their vacation, but it\'s not because of the vacation itself. What do you do the last week before you leave on a big trip? You clean up, close up, clarify, and renegotiate all your agreements with yourself and others. I just suggest that you do this weekly instead of yearly." — David Allen, GTD, ch. 8',
    '📖 "There is usually an inverse relationship between how much something is on your mind and how much it\'s getting done." — David Allen, GTD, ch. 1',
    '📖 "You can only feel good about what you\'re not doing when you know what you\'re not doing." — David Allen, GTD, ch. 9',
    "📖 \"Anything that does not belong where it is, the way it is, is an 'open loop,' which will be pulling on your attention if it's not appropriately managed.\" — David Allen, GTD, ch. 2",
    "📖 \"Getting things done requires two basic components: defining (1) what 'done' means (outcome) and (2) what 'doing' looks like (action).\" — David Allen, GTD, ch. 2",
    '📖 "Your head is for having ideas, not for holding them. That\'s what a trusted system is for." — David Allen, GTD, ch. 4',
    '📖 "The two-minute rule: if the next action can be done in two minutes or less, do it when you first pick the item up." — David Allen, GTD, ch. 6',
    '📖 "Think like a man of action, act like a man of thought." — Henri Bergson, quoted in GTD, ch. 3',
    '📖 "The big secret to efficient creative and productive thinking and action is to put the right things in your focus at the right time." — David Allen, GTD, ch. 9',
    '📖 "One of the best tricks for enhancing your productivity is having organized, ready-to-review action reminders." — David Allen, GTD, ch. 7',
    '📖 "The Weekly Review is the time to gather and process all your stuff, review your system, update your lists, and get clean, clear, current, and complete." — David Allen, GTD, ch. 8',
    '📖 "A great hammer doesn\'t make a great carpenter; but a great carpenter will always want to have a great hammer." — David Allen, GTD, ch. 5',
  ],
  atomicHabitsQuotes: [
    // James Clear, "Atomic Habits" (2018)
    '📖 "You do not rise to the level of your goals. You fall to the level of your systems." — James Clear, Atomic Habits, ch. 1',
    '📖 "Every action you take is a vote for the type of person you wish to become." — James Clear, Atomic Habits, ch. 2',
    '📖 "Habits are the compound interest of self-improvement." — James Clear, Atomic Habits, ch. 1',
    '📖 "The most effective way to change your habits is to focus not on what you want to achieve, but on who you wish to become." — James Clear, Atomic Habits, ch. 2',
    '📖 "Be the designer of your world and not merely the consumer of it." — James Clear, Atomic Habits, ch. 6',
    '📖 "When you fall in love with the process rather than the product, you don\'t have to wait to give yourself permission to be happy." — James Clear, Atomic Habits, ch. 1',
    '📖 "The task of breaking a bad habit is like uprooting a powerful oak within us." — James Clear, Atomic Habits, ch. 7',
    '📖 "Success is the product of daily habits — not once-in-a-lifetime transformations." — James Clear, Atomic Habits, ch. 1',
    '📖 "Time magnifies the margin between success and failure. It will multiply whatever you feed it." — James Clear, Atomic Habits, ch. 1',
    '📖 "You should be far more concerned with your current trajectory than with your current results." — James Clear, Atomic Habits, ch. 1',
    '📖 "The purpose of setting goals is to win the game. The purpose of building systems is to continue playing the game." — James Clear, Atomic Habits, ch. 1',
    '📖 "Missing once is an accident. Missing twice is the start of a new habit." — James Clear, Atomic Habits, ch. 16',
  ],
  deepWorkQuotes: [
    // Cal Newport, "Deep Work: Rules for Focused Success in a Distracted World" (2016)
    '📖 "If you don\'t produce, you won\'t thrive — no matter how skilled or talented you are." — Cal Newport, Deep Work, ch. 1',
    '📖 "Clarity about what matters provides clarity about what does not." — Cal Newport, Deep Work, ch. 4',
    '📖 "The ability to perform deep work is becoming increasingly rare at exactly the same time it is becoming increasingly valuable." — Cal Newport, Deep Work, intro',
    '📖 "Two core abilities for thriving in the new economy: the ability to quickly master hard things, and the ability to produce at an elite level." — Cal Newport, Deep Work, ch. 1',
    '📖 "Who you are, what you think, feel, and do, what you love — is the sum of what you focus on." — Cal Newport, Deep Work, ch. 3',
    '📖 "A deep life is a good life, any way you look at it." — Cal Newport, Deep Work, conclusion',
    '📖 "Efforts to deepen your focus will struggle if you don\'t simultaneously wean your mind from a dependence on distraction." — Cal Newport, Deep Work, rule 2',
    '📖 "The key to developing a deep work habit is to move beyond good intentions and add routines and rituals to your working life." — Cal Newport, Deep Work, rule 1',
    '📖 "Treat your time with respect. Schedule every minute of your day." — Cal Newport, Deep Work, rule 4',
    '📖 "Don\'t take breaks from distraction. Instead take breaks from focus." — Cal Newport, Deep Work, rule 2',
  ],
  sevenHabitsQuotes: [
    // Stephen R. Covey, "The 7 Habits of Highly Effective People" (1989)
    '📖 "The key is not to prioritize what\'s on your schedule, but to schedule your priorities." — Stephen Covey, 7 Habits, habit 3',
    '📖 "Begin with the end in mind." — Stephen Covey, 7 Habits, habit 2',
    '📖 "Put first things first." — Stephen Covey, 7 Habits, habit 3',
    '📖 "Most of us spend too much time on what is urgent and not enough time on what is important." — Stephen Covey, 7 Habits, habit 3',
    '📖 "The main thing is to keep the main thing the main thing." — Stephen Covey, 7 Habits, habit 3',
    '📖 "Sow a thought, reap an action; sow an action, reap a habit; sow a habit, reap a character; sow a character, reap a destiny." — Stephen Covey, 7 Habits, habit 1',
    '📖 "Between stimulus and response there is a space. In that space is our freedom and power to choose our response." — Stephen Covey, 7 Habits, habit 1',
    '📖 "Be proactive. Highly effective people don\'t just react to circumstances — they create them." — Stephen Covey, 7 Habits, habit 1',
    '📖 "Seek first to understand, then to be understood." — Stephen Covey, 7 Habits, habit 5',
    '📖 "Live out of your imagination, not your history." — Stephen Covey, 7 Habits, habit 2',
  ],
  contextualTips: {
    noEveningReview:
      '💡 Your mornings are set — how about evenings? Enable the evening review to prepare for tomorrow: "turn on evening review at 9pm".',
    noMorningAgenda: '💡 Want to start each day with a plan? Enable the morning agenda: "set morning agenda to 7:30".',
    noQuietHours: "💡 Protect your sleep — set up quiet hours so I don't disturb you at night. Check /settings.",
    noGoogleCalendar: '💡 Connect Google Calendar to see all your events in one place — /connect_google.',
    noCountry: '💡 Set your country to get public holidays in your calendar — /holidays.',
    noVoiceCalls: '💡 I can call you before important events so you never miss them. Enable voice calls in /settings.',
  },
} as const;
