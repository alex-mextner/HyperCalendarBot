export interface TemplateRenderer<TData> {
  render(data: TData): string;
}

export interface Theme {
  name: string;
  bg: string;
  cardBg: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
  border: string;
  eventColors: string[];
}

export interface AgendaEvent {
  id: number;
  title: string;
  startMinutes: number; // minutes since midnight in user TZ
  endMinutes: number;
  location?: string;
  calendarColor: string;
  calendarName?: string;
  isAllDay: boolean;
  emoji?: string;
}

export interface DailyAgendaData {
  date: string; // ISO "2026-03-11"
  dayOfWeek: string; // "Wednesday" / "Среда"
  dateFormatted: string; // "March 11, 2026" / "11 марта 2026"
  relativeDay?: string; // "Today" / "Сегодня"
  eventCount: number;
  currentTimeMinutes?: number;
  isHoliday?: boolean;
  holidayName?: string;
  allDayEvents: AgendaEvent[];
  timedEvents: AgendaEvent[];
  theme: Theme;
  locale: 'ru' | 'en';
}

export interface MiniEvent {
  title: string;
  startMinutes: number;
  endMinutes: number;
  color: string;
  isAllDay: boolean;
}

export interface WeekDay {
  dayNumber: number;
  dayName: string;
  eventCount: number;
  isWeekend: boolean;
  events: MiniEvent[];
}

export interface WeeklyOverviewData {
  weekLabel: string;
  days: WeekDay[];
  todayIndex?: number;
  theme: Theme;
  locale: 'ru' | 'en';
}

export interface EventCardData {
  title: string;
  dateFormatted: string;
  timeFormatted: string;
  duration: string;
  location?: string;
  description?: string;
  attendees?: string[];
  attendeeOverflow?: number;
  conferenceLink?: string;
  calendarName: string;
  calendarColor: string;
  isAllDay: boolean;
  theme: Theme;
  locale: 'ru' | 'en';
}

export interface MonthDay {
  dayNumber: number;
  isOtherMonth: boolean;
  isWeekend: boolean;
  isToday: boolean;
  eventCount: number;
  events: MiniEvent[];
}

export interface MonthlyCalendarData {
  monthLabel: string;
  weekDays: string[];
  weeks: MonthDay[][];
  theme: Theme;
  locale: 'ru' | 'en';
}

export type ImageType = 'daily-agenda' | 'weekly-overview' | 'event-card' | 'monthly-calendar' | 'conflict-schedule';
