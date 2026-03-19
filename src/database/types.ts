// src/database/types.ts

// ── Sync enums ──

export type SyncStatus = 'local_only' | 'synced' | 'pending_push' | 'pending_pull' | 'conflict' | 'push_failed';
export type GoogleSyncStatusValue = 'active' | 'revoked' | 'expired';
export type GoogleAccessRole = 'owner' | 'writer' | 'reader' | 'freeBusyReader';

// ── Row types (match SQLite columns exactly) ──

export interface User {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  language: 'en' | 'ru';
  timezone: string;
  country_code: string | null;
  google_refresh_token_enc: string | null;
  google_calendar_id: string | null;
  onboarding_completed: number; // 0 | 1
  timezone_updated_at: string | null;
  voice_response_enabled: number | null;
  default_event_duration_minutes: number;
  created_at: string;
  updated_at: string;
}

export interface CalendarEvent {
  id: number;
  user_id: number;
  title: string;
  description: string | null;
  category: string | null;
  start_at: string;
  end_at: string | null;
  all_day: number; // 0 | 1
  timezone: string;
  location: string | null;
  recurrence_rule: string | null;
  recurrence_end_at: string | null;
  parent_event_id: number | null;
  original_start_at: string | null;
  is_cancelled: number; // 0 | 1
  reminder_overrides: string | null; // JSON array "[5, 30]"
  google_event_id: string | null;
  google_calendar_id: string | null;
  google_etag: string | null;
  sync_status: SyncStatus;
  sync_version: number;
  owner_type: 'user' | 'group';
  group_id: number | null;
  created_by: number | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Reminder {
  id: number;
  event_id: number;
  minutes_before: number;
  created_at: string;
}

// ── Input types ──

export interface CreateUserData {
  telegram_id: number;
  username?: string;
  first_name?: string;
  language?: 'en' | 'ru';
  timezone?: string;
  country_code?: string;
}

export interface UpdateUserData {
  username?: string;
  first_name?: string;
  language?: 'en' | 'ru';
  timezone?: string;
  country_code?: string;
  onboarding_completed?: number;
  voice_response_enabled?: number | null;
  default_event_duration_minutes?: number;
}

export interface CreateEventData {
  user_id: number;
  title: string;
  description?: string;
  category?: string;
  start_at: string; // ISO 8601 UTC
  end_at?: string;
  all_day?: boolean;
  timezone: string;
  location?: string;
  recurrence_rule?: string;
  recurrence_end_at?: string;
  reminder_minutes?: number[];
  owner_type?: 'user' | 'group';
  group_id?: number;
  created_by?: number;
}

export interface UpdateEventData {
  title?: string;
  description?: string | null;
  category?: string | null;
  start_at?: string;
  end_at?: string | null;
  all_day?: boolean;
  timezone?: string;
  location?: string | null;
  recurrence_rule?: string | null;
  recurrence_end_at?: string | null;
  reminder_overrides?: string | null;
  google_calendar_id?: string | null;
  google_event_id?: string | null;
  google_etag?: string | null;
  sync_status?: SyncStatus;
  sync_version?: number;
  last_synced_at?: string | null;
}

export interface ChatHistoryMessage {
  id: number;
  user_id: number;
  role: 'user' | 'assistant' | 'tool';
  content: string; // plain text for user, JSON content blocks for assistant/tool
  chat_id: number | null;
  created_at: string;
}

// ── Google Sync row types ──

export interface GoogleSyncState {
  user_id: number;
  access_token: string | null;
  expires_at: string | null;
  scopes: string;
  status: GoogleSyncStatusValue;
  created_at: string;
  updated_at: string;
}

export interface GoogleCalendar {
  id: number;
  user_id: number;
  google_calendar_id: string;
  calendar_name: string;
  color: string | null;
  is_primary: number;
  sync_enabled: number;
  access_role: GoogleAccessRole;
  sync_token: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoogleWatchChannel {
  id: number;
  google_calendar_row_id: number;
  channel_id: string;
  resource_id: string;
  expiration: string;
  created_at: string;
}

export interface SyncLogEntry {
  id: number;
  user_id: number;
  event_id: number | null;
  google_event_id: string | null;
  direction: 'push' | 'pull';
  action: 'create' | 'update' | 'delete' | 'conflict_resolve';
  details: string | null;
  created_at: string;
}

// ── Computed types ──

export interface EventOccurrence {
  event: CalendarEvent;
  occurrence_start: string;
  occurrence_end: string | null;
  is_exception: boolean;
}

// --- Sharing & Social (sub-project 06) ---

export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'maybe' | 'cancelled' | 'expired';
export type Visibility = 'private' | 'free_busy' | 'full';
export type SharedToType = 'user' | 'group';
export type ShareType = 'card' | 'image' | 'agenda';
export type ParticipantStatus = 'pending' | 'accepted' | 'declined' | 'maybe';
export type ParticipantRole = 'organizer' | 'attendee';

export interface EventParticipant {
  id: number;
  event_id: number;
  user_id: number;
  status: ParticipantStatus;
  role: ParticipantRole;
  created_at: string;
  updated_at: string;
}
export type DeepLinkType = 'shared_event' | 'invitation' | 'group_context';

export interface Invitation {
  id: number;
  event_id: number;
  inviter_id: number;
  invitee_id: number;
  status: InvitationStatus;
  message_id: number | null;
  chat_id: number | null;
  deep_link_code: string | null;
  invitee_username: string | null;
  created_at: string;
  updated_at: string;
  responded_at: string | null;
  proposed_time: string | null;
}

export interface SharedEvent {
  id: number;
  event_id: number;
  shared_by: number;
  shared_to_type: SharedToType;
  shared_to_id: number;
  share_type: ShareType;
  message_id: number | null;
  deep_link_code: string | null;
  created_at: string;
}

export interface SharingSettings {
  user_id: number;
  default_visibility: Visibility;
  inline_mode_enabled: number;
  allow_invitations: number;
  share_location: number;
  share_description: number;
  updated_at: string;
}

export interface EventVisibilityRow {
  event_id: number;
  visibility: Visibility;
  updated_at: string;
}

export interface GroupChat {
  chat_id: number;
  title: string | null;
  added_by: number;
  added_at: string;
  is_active: number;
  pin_hint_shown: number;
  timezone: string | null;
  country: string | null;
  invite_link: string | null;
}

export interface GroupSharedEvent {
  id: number;
  chat_id: number;
  event_id: number;
  shared_by: number;
  message_id: number | null;
  created_at: string;
}

export interface DeepLink {
  code: string;
  type: DeepLinkType;
  payload: string;
  created_by: number;
  created_at: string;
  expires_at: string | null;
  used_count: number;
}

export interface CreateInvitationData {
  event_id: number;
  inviter_id: number;
  invitee_id: number;
  message_id?: number;
  chat_id?: number;
  deep_link_code?: string;
  invitee_username?: string;
}

export interface CreateSharedEventData {
  event_id: number;
  shared_by: number;
  shared_to_type: SharedToType;
  shared_to_id: number;
  share_type: ShareType;
  message_id?: number;
  deep_link_code?: string;
}

export interface CreateDeepLinkData {
  code: string;
  type: DeepLinkType;
  payload: string;
  created_by: number;
  expires_at?: string;
}

export interface CreateGroupChatData {
  chat_id: number;
  title?: string;
  added_by: number;
}

// --- Intent Automation ---

export type IntentStatus = 'pending' | 'approved' | 'rejected';

export interface Intent {
  id: number;
  canonical_name: string;
  phrases: string; // JSON array
  trigger_words: string; // JSON array
  pattern: string | null;
  workflow: string; // JSON
  format: string;
  status: IntentStatus;
  source_message: string | null;
  created_at: string;
}

export interface CreateIntentData {
  canonical_name: string;
  phrases: string[];
  trigger_words?: string[];
  pattern?: string;
  workflow: Record<string, unknown>;
  format: string;
  source_message?: string;
}

// --- Feedback System ---

export type FeedbackThreadStatus = 'open' | 'closed';
export type FeedbackType = 'bug' | 'feature' | 'question' | 'other';

export interface FeedbackThread {
  id: number;
  user_id: number;
  status: FeedbackThreadStatus;
  type: FeedbackType;
  subject: string;
  created_at: string;
  closed_at: string | null;
}

export interface FeedbackMessage {
  id: number;
  thread_id: number;
  sender: 'user' | 'admin';
  text: string;
  telegram_message_id: number | null;
  created_at: string;
}

export interface CreateFeedbackThreadData {
  user_id: number;
  type: FeedbackType;
  subject: string;
}

export interface CreateFeedbackMessageData {
  thread_id: number;
  sender: 'user' | 'admin';
  text: string;
  telegram_message_id?: number;
}

// --- Voice Call Reminders (sub-project 07) ---

// --- Edit Proposals ---

export type EditProposalStatus = 'pending' | 'accepted' | 'rejected';

export interface EditProposal {
  id: number;
  event_id: number;
  proposer_id: number;
  changes: string; // JSON
  reason: string | null;
  status: EditProposalStatus;
  created_at: string;
}

export interface CreateEditProposalData {
  event_id: number;
  proposer_id: number;
  changes: string; // JSON
  reason?: string;
}

// --- Secretary Access ---

export type SecretaryStatus = 'pending' | 'active' | 'revoked' | 'declined' | 'expired';
export type SecretaryPermission = 'read' | 'write';

export interface CalendarSecretary {
  id: number;
  owner_id: number;
  secretary_id: number;
  permission: SecretaryPermission;
  status: SecretaryStatus;
  dm_message_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSecretaryData {
  owner_id: number;
  secretary_id: number;
  permission: SecretaryPermission;
}

// --- Group Proposals ---

export type ProposalStatus = 'pending' | 'accepted' | 'declined' | 'expired';
export type ProposalAction = 'create' | 'update' | 'delete';

export interface CalendarProposal {
  id: number;
  group_chat_id: number;
  group_chat_title: string | null;
  proposer_id: number;
  target_id: number;
  action: ProposalAction;
  payload: string; // JSON
  summary: string;
  status: ProposalStatus;
  group_message_id: number | null;
  dm_message_id: number | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface CreateProposalData {
  group_chat_id: number;
  group_chat_title?: string;
  proposer_id: number;
  target_id: number;
  action: ProposalAction;
  payload: string;
  summary: string;
  expires_at: string;
}

// --- Voice Call Reminders (sub-project 07) ---

export type CallStatus =
  | 'queued'
  | 'ringing'
  | 'connected'
  | 'completed'
  | 'failed'
  | 'no_answer'
  | 'busy'
  | 'cancelled';

export interface UserCallSettings {
  user_id: number;
  enabled: number;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  max_daily_calls: number;
  language: string;
  important_only: number;
  updated_at: string;
}

export interface CallLog {
  id: number;
  user_id: number;
  event_id: number | null;
  status: CallStatus;
  duration_sec: number | null;
  tts_text: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}
