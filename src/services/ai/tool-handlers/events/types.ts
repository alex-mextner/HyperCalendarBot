// Tool-call argument shapes shared by the event handlers, plus the logger they all report through.
import { logger } from '../../../../utils/logger.ts';

export const eventsLogger = logger.child({ module: 'ai-tools' });

export type Scope = 'personal' | 'group';

export interface GetEventsInput {
  start_date: string;
  end_date: string;
  scope?: Scope;
  owner_id?: number;
}

export interface CreateEventInput {
  title: string;
  start_at: string;
  end_at?: string;
  description?: string;
  location?: string;
  location_abstract?: boolean;
  all_day?: boolean;
  recurrence_rule?: string;
  reminder_minutes?: number[];
  force?: boolean;
  scope?: Scope;
  owner_id?: number;
}

export interface UpdateEventInput {
  event_id: number;
  title?: string;
  start_at?: string;
  end_at?: string | null;
  description?: string | null;
  location?: string | null;
  location_abstract?: boolean;
  recurrence_rule?: string | null;
  scope?: Scope;
  owner_id?: number;
}

export interface DeleteEventInput {
  event_id: number;
  scope?: Scope;
  owner_id?: number;
}

export interface GetUpcomingInput {
  limit?: number;
  scope?: Scope;
  owner_id?: number;
}

export interface SnoozeEventInput {
  event_id: number;
  minutes?: number;
  scope?: Scope;
  owner_id?: number;
}

export interface GetEventInput {
  event_id: number;
  scope?: Scope;
  owner_id?: number;
}

export interface SearchEventsInput {
  query?: string;
  scope?: Scope;
  owner_id?: number;
  event_type?: 'birthday' | 'regular';
}

export interface AttachPendingLocationInput {
  event_id: number;
}

export interface NotifyParticipantsInput {
  event_id: number;
  message: string;
}
