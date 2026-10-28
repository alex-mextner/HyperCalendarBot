// sharing tool handlers: privacy settings, share_agenda, set_event_visibility and propose_edit.
import { beforeEach, describe, expect, test } from 'bun:test';
import { EditProposalRepository } from '../../../../src/database/repositories/edit-proposal.repository.ts';
import { ParticipantRepository } from '../../../../src/database/repositories/participant.repository.ts';
import { handleManageSettings } from '../../../../src/services/ai/tool-handlers/settings.ts';
import {
  handleProposeEdit,
  handleSetEventVisibility,
  handleShareAgenda,
} from '../../../../src/services/ai/tool-handlers/sharing.ts';
import { createSharingFixture, OTHER_USER_ID, type SharingFixture, USER_ID } from './sharing-fixtures.ts';

describe('sharing tool handlers', () => {
  let db: SharingFixture['db'];
  let userRepo: SharingFixture['userRepo'];
  let eventService: SharingFixture['eventService'];
  let sharedEventRepo: SharingFixture['sharedEventRepo'];
  let invitationRepo: SharingFixture['invitationRepo'];
  let sharingSettingsRepo: SharingFixture['sharingSettingsRepo'];
  let invitationService: SharingFixture['invitationService'];
  let sharingService: SharingFixture['sharingService'];
  let privacyService: SharingFixture['privacyService'];
  let makeCtx: SharingFixture['makeCtx'];
  let sharingWithout: SharingFixture['sharingWithout'];

  beforeEach(() => {
    ({
      db,
      userRepo,
      eventService,
      sharedEventRepo,
      invitationRepo,
      sharingSettingsRepo,
      invitationService,
      sharingService,
      privacyService,
      makeCtx,
      sharingWithout,
    } = createSharingFixture());
  });

  // ── privacy settings via manage_settings ──

  describe('manage_settings privacy category', () => {
    test('returns error when sharingSettingsRepo is missing', async () => {
      const ctx = makeCtx({ sharing: sharingWithout('sharingSettingsRepo') });
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'privacy',
        updates: { default_visibility: 'full' },
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Sharing settings are not configured.');
    });

    test('returns error when no settings provided', async () => {
      const ctx = makeCtx();
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'privacy',
        updates: {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('updates');
    });

    test('updates default_visibility', async () => {
      const ctx = makeCtx();
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'privacy',
        updates: { default_visibility: 'full' },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('default_visibility');
      expect(result.output).toContain('full');

      const settings = sharingSettingsRepo.get(USER_ID);
      expect(settings).not.toBeNull();
      expect(settings!.default_visibility).toBe('full');
    });

    test('updates inline_mode_enabled as integer', async () => {
      const ctx = makeCtx();
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'privacy',
        updates: { inline_mode_enabled: false },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('inline_mode_enabled');
      expect(result.output).toContain('0');

      const settings = sharingSettingsRepo.get(USER_ID);
      expect(settings!.inline_mode_enabled).toBe(0);
    });

    test('updates allow_invitations as integer', async () => {
      const ctx = makeCtx();
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'privacy',
        updates: { allow_invitations: true },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('allow_invitations');
      expect(result.output).toContain('1');
    });

    test('updates multiple settings at once', async () => {
      const ctx = makeCtx();
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'privacy',
        updates: { default_visibility: 'free_busy', inline_mode_enabled: true, allow_invitations: false },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('default_visibility');
      expect(result.output).toContain('inline_mode_enabled');
      expect(result.output).toContain('allow_invitations');

      const settings = sharingSettingsRepo.get(USER_ID);
      expect(settings!.default_visibility).toBe('free_busy');
      expect(settings!.inline_mode_enabled).toBe(1);
      expect(settings!.allow_invitations).toBe(0);
    });
  });

  // ── handleShareAgenda ──

  describe('handleShareAgenda', () => {
    test('returns error when sharingService is missing', async () => {
      const ctx = makeCtx({ sharing: undefined });
      const result = handleShareAgenda(ctx, { period: 'today', target_type: 'user', target_id: OTHER_USER_ID });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Sharing is not configured.');
    });

    test('returns error when sharedEventRepo is missing', async () => {
      const ctx = makeCtx({ sharing: undefined });
      const result = handleShareAgenda(ctx, { period: 'today', target_type: 'user', target_id: OTHER_USER_ID });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Sharing is not configured.');
    });

    test('returns no events when agenda is empty', async () => {
      const ctx = makeCtx();
      const result = handleShareAgenda(ctx, { period: 'today', target_type: 'user', target_id: OTHER_USER_ID });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No visible events');
    });

    test('returns no events when all events are explicitly private', async () => {
      // Must explicitly set visibility to private — default is now 'full'
      sharingSettingsRepo.ensureDefaults(USER_ID);
      sharingSettingsRepo.update(USER_ID, { default_visibility: 'private' });
      const todayAt14 = new Date();
      todayAt14.setUTCHours(14, 0, 0, 0);
      eventService.createEvent({
        user_id: USER_ID,
        title: 'Secret Meeting',
        start_at: todayAt14.toISOString(),
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = handleShareAgenda(ctx, { period: 'today', target_type: 'user', target_id: OTHER_USER_ID });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No visible events');
    });

    test('shares today agenda with visible events', async () => {
      const todayAt14 = new Date();
      todayAt14.setUTCHours(14, 0, 0, 0);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Public Standup',
        start_at: todayAt14.toISOString(),
        timezone: 'UTC',
      });
      // Make it visible
      sharingSettingsRepo.setEventVisibility(event.id, 'full');
      const ctx = makeCtx();
      const result = handleShareAgenda(ctx, { period: 'today', target_type: 'user', target_id: OTHER_USER_ID });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Public Standup');
      expect(result.output).toContain('today');
      expect(result.output).toContain(`${OTHER_USER_ID}`);
    });

    test('shares tomorrow agenda', async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(14, 0, 0, 0);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Tomorrow Talk',
        start_at: tomorrow.toISOString(),
        timezone: 'UTC',
      });
      sharingSettingsRepo.setEventVisibility(event.id, 'full');
      const ctx = makeCtx();
      const result = handleShareAgenda(ctx, { period: 'tomorrow', target_type: 'group', target_id: -5000 });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Tomorrow Talk');
      expect(result.output).toContain('tomorrow');
      expect(result.output).toContain('group');
    });

    test('shares week agenda across multiple days', async () => {
      // Create events on day+1 and day+3
      const day1 = new Date();
      day1.setDate(day1.getDate() + 1);
      day1.setHours(10, 0, 0, 0);
      const day3 = new Date();
      day3.setDate(day3.getDate() + 3);
      day3.setHours(15, 0, 0, 0);
      const ev1 = eventService.createEvent({
        user_id: USER_ID,
        title: 'Monday Sync',
        start_at: day1.toISOString(),
        timezone: 'UTC',
      });
      const ev2 = eventService.createEvent({
        user_id: USER_ID,
        title: 'Wednesday Review',
        start_at: day3.toISOString(),
        timezone: 'UTC',
      });
      sharingSettingsRepo.setEventVisibility(ev1.id, 'full');
      sharingSettingsRepo.setEventVisibility(ev2.id, 'full');
      const ctx = makeCtx();
      const result = handleShareAgenda(ctx, { period: 'week', target_type: 'user', target_id: OTHER_USER_ID });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Monday Sync');
      expect(result.output).toContain('Wednesday Review');
      expect(result.output).toContain('2 events');
    });

    test('creates shared_event records for each event in agenda', async () => {
      const todayAt14 = new Date();
      todayAt14.setUTCHours(14, 0, 0, 0);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Track Me',
        start_at: todayAt14.toISOString(),
        timezone: 'UTC',
      });
      sharingSettingsRepo.setEventVisibility(event.id, 'full');
      const ctx = makeCtx();
      handleShareAgenda(ctx, { period: 'today', target_type: 'user', target_id: OTHER_USER_ID });

      const shares = sharedEventRepo.getByEvent(event.id);
      expect(shares.length).toBe(1);
      expect(shares[0]!.shared_to_type).toBe('user');
      expect(shares[0]!.shared_to_id).toBe(OTHER_USER_ID);
      expect(shares[0]!.share_type).toBe('agenda');
    });
  });

  // ── handleSetEventVisibility ──

  describe('handleSetEventVisibility', () => {
    test('returns error when sharingSettingsRepo is missing', async () => {
      const ctx = makeCtx({ sharing: sharingWithout('sharingSettingsRepo') });
      const result = handleSetEventVisibility(ctx, { event_id: 1, visibility: 'full' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Sharing settings are not configured.');
    });

    test('returns error when event not found', async () => {
      const ctx = makeCtx();
      const result = handleSetEventVisibility(ctx, { event_id: 9999, visibility: 'full' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('9999');
      expect(result.error).toContain('not found');
    });

    test('returns error when event belongs to another user', async () => {
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Not Mine',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = handleSetEventVisibility(ctx, { event_id: event.id, visibility: 'full' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('sets visibility to full', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Visible Event',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = handleSetEventVisibility(ctx, { event_id: event.id, visibility: 'full' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Visible Event');
      expect(result.output).toContain('"full"');

      const stored = sharingSettingsRepo.getEventVisibility(event.id);
      expect(stored).toBe('full');
    });

    test('sets visibility to free_busy', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Busy Event',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = handleSetEventVisibility(ctx, { event_id: event.id, visibility: 'free_busy' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('"free_busy"');
    });

    test('sets visibility to private', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Private Event',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      // First make it full, then set back to private
      handleSetEventVisibility(ctx, { event_id: event.id, visibility: 'full' });
      const result = handleSetEventVisibility(ctx, { event_id: event.id, visibility: 'private' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('"private"');

      const stored = sharingSettingsRepo.getEventVisibility(event.id);
      expect(stored).toBe('private');
    });

    test('output includes event id', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'ID Check',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = handleSetEventVisibility(ctx, { event_id: event.id, visibility: 'full' });
      expect(result.success).toBe(true);
      expect(result.output).toContain(`id: ${event.id}`);
    });
  });

  // ── handleProposeEdit ──

  describe('handleProposeEdit', () => {
    test('returns error when editProposalRepo is missing', async () => {
      const ctx = makeCtx({ sharing: sharingWithout('editProposalRepo') });
      const result = await handleProposeEdit(ctx, { event_id: 1, changes: { title: 'New' } });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    test('returns error when caller has no invitation and is not the owner', async () => {
      const editProposalRepo = new EditProposalRepository(db);
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Not My Event',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });

      const ctx = makeCtx({
        sharing: {
          sharedEventRepo,
          invitationRepo,
          invitationService,
          sharingSettingsRepo,
          sharingService,
          privacyService,
          editProposalRepo,
        },
      });
      const result = await handleProposeEdit(ctx, { event_id: event.id, changes: { title: 'Change' } });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not invited');
    });

    // Regression: group RSVP creates an event_participants row, but that must NOT grant
    // propose_edit access. Only a personal invitation (invitations table) or ownership does.
    test('group RSVP member without personal invitation is denied', async () => {
      const participantRepo = new ParticipantRepository(db);
      const editProposalRepo = new EditProposalRepository(db);
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Group Event',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });
      // Simulate group RSVP: participant row exists for USER_ID, but no invitation row.
      participantRepo.add(event.id, USER_ID, 'accepted');

      const ctx = makeCtx({
        participantRepo,
        sharing: {
          sharedEventRepo,
          invitationRepo,
          invitationService,
          sharingSettingsRepo,
          sharingService,
          privacyService,
          editProposalRepo,
        },
      });
      const result = await handleProposeEdit(ctx, { event_id: event.id, changes: { title: 'Change' } });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not invited');
    });

    test('personal invitee can propose edit', async () => {
      const editProposalRepo = new EditProposalRepository(db);
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Shared Event',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });
      invitationRepo.create({ event_id: event.id, inviter_id: OTHER_USER_ID, invitee_id: USER_ID });

      const ctx = makeCtx({
        sharing: {
          sharedEventRepo,
          invitationRepo,
          invitationService,
          sharingSettingsRepo,
          sharingService,
          privacyService,
          editProposalRepo,
        },
      });
      const result = await handleProposeEdit(ctx, {
        event_id: event.id,
        changes: { start_at: '2026-03-20T11:00:00Z' },
        reason: 'Conflict with another meeting',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('proposal submitted');

      const pending = editProposalRepo.getPendingForEvent(event.id);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.proposer_id).toBe(USER_ID);
      expect(JSON.parse(pending[0]!.changes)).toEqual({ start_at: '2026-03-20T11:00:00Z' });
      expect(pending[0]!.reason).toBe('Conflict with another meeting');
    });

    test('declined personal invitee can still propose edit', async () => {
      const editProposalRepo = new EditProposalRepository(db);
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Declined But Can Propose',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });
      const inv = invitationRepo.create({ event_id: event.id, inviter_id: OTHER_USER_ID, invitee_id: USER_ID });
      invitationRepo.updateStatus(inv.id, 'declined', 'pending');

      const ctx = makeCtx({
        sharing: {
          sharedEventRepo,
          invitationRepo,
          invitationService,
          sharingSettingsRepo,
          sharingService,
          privacyService,
          editProposalRepo,
        },
      });
      const result = await handleProposeEdit(ctx, { event_id: event.id, changes: { title: 'Actually Let Me In' } });
      expect(result.success).toBe(true);
      expect(result.output).toContain('proposal submitted');
    });

    // A declined invitation survives the event's delete (#505); it must not let the invitee, or the
    // owner, file a proposal against the deleted event and ping the owner about it.
    for (const caller of ['declined invitee', 'owner'] as const) {
      test(`${caller} cannot propose an edit to a deleted event`, async () => {
        const editProposalRepo = new EditProposalRepository(db);
        const event = eventService.createEvent({
          user_id: OTHER_USER_ID,
          title: 'Deleted Later',
          start_at: '2026-03-20T10:00:00Z',
          timezone: 'UTC',
        });
        const inv = invitationRepo.create({ event_id: event.id, inviter_id: OTHER_USER_ID, invitee_id: USER_ID });
        invitationRepo.updateStatus(inv.id, 'declined', 'pending');
        expect(eventService.deleteEvent(event.id, OTHER_USER_ID)).toBe(true);
        expect(invitationRepo.findActiveOrRespondedByEventAndInvitee(event.id, USER_ID)?.status).toBe('declined');

        const notified: number[] = [];
        const ctx = makeCtx({
          ...(caller === 'owner' ? { user: userRepo.findByTelegramId(OTHER_USER_ID)! } : {}),
          sharing: {
            sharedEventRepo,
            invitationRepo,
            invitationService,
            sharingSettingsRepo,
            sharingService,
            privacyService,
            editProposalRepo,
          },
          sender: {
            sendMessage: async () => ({ message_id: 1 }),
            editMessageText: async () => {},
            sendEditProposal: async (ownerId) => {
              notified.push(ownerId);
              return { message_id: 42 };
            },
          },
        });
        const result = await handleProposeEdit(ctx, { event_id: event.id, changes: { title: 'Revive It' } });
        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
        expect(editProposalRepo.getPendingForEvent(event.id)).toHaveLength(0);
        expect(notified).toEqual([]);
      });
    }

    test('cancelled invitation does not grant propose_edit access', async () => {
      const editProposalRepo = new EditProposalRepository(db);
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Cancelled Invite Event',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });
      const inv = invitationRepo.create({ event_id: event.id, inviter_id: OTHER_USER_ID, invitee_id: USER_ID });
      invitationRepo.updateStatus(inv.id, 'cancelled', 'pending');

      const ctx = makeCtx({
        sharing: {
          sharedEventRepo,
          invitationRepo,
          invitationService,
          sharingSettingsRepo,
          sharingService,
          privacyService,
          editProposalRepo,
        },
      });
      const result = await handleProposeEdit(ctx, { event_id: event.id, changes: { title: 'Sneaky Edit' } });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not invited');
    });

    // Regression: a newer cancelled row must supersede an older responded row.
    // Without fetching the latest row first, the old declined row would still grant access.
    test('re-invited-then-cancelled invitation does not grant propose_edit access', async () => {
      const editProposalRepo = new EditProposalRepository(db);
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Re-invite Then Cancel',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });
      // First invitation: user declined.
      const first = invitationRepo.create({ event_id: event.id, inviter_id: OTHER_USER_ID, invitee_id: USER_ID });
      invitationRepo.updateStatus(first.id, 'declined', 'pending');
      // Second invitation (re-invite, 1 second later so created_at differs): inviter then cancels.
      // Insert directly to control created_at and avoid the UNIQUE(event_id, invitee_id, created_at) collision.
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO invitations (event_id, inviter_id, invitee_id, status, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', datetime('now', '+1 second'), datetime('now', '+1 second'))`,
        )
        .run(event.id, OTHER_USER_ID, USER_ID);
      invitationRepo.updateStatus(Number(lastInsertRowid), 'cancelled', 'pending');

      const ctx = makeCtx({
        sharing: {
          sharedEventRepo,
          invitationRepo,
          invitationService,
          sharingSettingsRepo,
          sharingService,
          privacyService,
          editProposalRepo,
        },
      });
      const result = await handleProposeEdit(ctx, { event_id: event.id, changes: { title: 'Sneaky Re-edit' } });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not invited');
    });

    test('event owner can propose edit without invitation', async () => {
      const editProposalRepo = new EditProposalRepository(db);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'My Own Event',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });

      const ctx = makeCtx({
        sharing: {
          sharedEventRepo,
          invitationRepo,
          invitationService,
          sharingSettingsRepo,
          sharingService,
          privacyService,
          editProposalRepo,
        },
      });
      const result = await handleProposeEdit(ctx, { event_id: event.id, changes: { title: 'Updated Title' } });
      expect(result.success).toBe(true);
      expect(result.output).toContain('proposal submitted');
    });

    test('sends notification to event creator when sender available', async () => {
      const editProposalRepo = new EditProposalRepository(db);
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Creator Gets Notified',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });
      invitationRepo.create({ event_id: event.id, inviter_id: OTHER_USER_ID, invitee_id: USER_ID });

      let sentTo: number | undefined;
      const ctx = makeCtx({
        sharing: {
          sharedEventRepo,
          invitationRepo,
          invitationService,
          sharingSettingsRepo,
          sharingService,
          privacyService,
          editProposalRepo,
        },
        sender: {
          sendMessage: async () => ({ message_id: 1 }),
          editMessageText: async () => {},
          sendEditProposal: async (creatorId) => {
            sentTo = creatorId;
            return { message_id: 42 };
          },
        },
      });

      await handleProposeEdit(ctx, { event_id: event.id, changes: { title: 'Better Name' } });
      expect(sentTo).toBe(OTHER_USER_ID);
    });

    // The owner's Accept applies the stored changes verbatim, so a place the model claims in a
    // proposal would become a confirmed venue without the owner ever tapping a candidate (#620).
    describe('a proposal never carries a confirmed place (#620)', () => {
      const MODEL_PLACE = {
        resolved_address: 'Far Away 1, Sample City',
        latitude: '10.5',
        longitude: '20.5',
        google_maps_url: 'https://www.google.com/maps/search/?api=1&query=10.5,20.5',
        venue_name: 'Far Away Venue',
      };

      function proposalCtx(editProposalRepo: EditProposalRepository, notices: string[]) {
        return makeCtx({
          sharing: {
            sharedEventRepo,
            invitationRepo,
            invitationService,
            sharingSettingsRepo,
            sharingService,
            privacyService,
            editProposalRepo,
          },
          sender: {
            sendMessage: async () => ({ message_id: 1 }),
            editMessageText: async () => {},
            sendEditProposal: async (_ownerId, text) => {
              notices.push(text);
              return { message_id: 42 };
            },
          },
        });
      }

      function ownerEvent(): number {
        const event = eventService.createEvent({
          user_id: OTHER_USER_ID,
          title: 'Shared Place',
          start_at: '2026-03-20T10:00:00Z',
          timezone: 'UTC',
        });
        invitationRepo.create({ event_id: event.id, inviter_id: OTHER_USER_ID, invitee_id: USER_ID });
        return event.id;
      }

      for (const verified of ['true', '1']) {
        test(`location_verified "${verified}" and a made-up place are dropped from the proposal`, async () => {
          const editProposalRepo = new EditProposalRepository(db);
          const notices: string[] = [];
          const eventId = ownerEvent();
          const result = await handleProposeEdit(proposalCtx(editProposalRepo, notices), {
            event_id: eventId,
            changes: { location: 'Cafe Prague', location_verified: verified, ...MODEL_PLACE },
          });

          expect(result.success).toBe(true);
          const [pending] = editProposalRepo.getPendingForEvent(eventId);
          expect(JSON.parse(pending?.changes ?? 'null')).toEqual({ location: 'Cafe Prague' });
          expect(notices).toHaveLength(1);
          expect(notices[0]).toContain('location: Cafe Prague');
          expect(notices[0]).not.toContain('Far Away');
          expect(notices[0]).not.toContain('location_verified');
        });
      }

      test.each<[string, { [field: string]: string | null }]>([
        ['nothing but a claimed place', { location_verified: 'true', ...MODEL_PLACE }],
        ['no changes at all', {}],
      ])('a proposal of %s is refused and the owner is not pinged', async (_name, changes) => {
        const editProposalRepo = new EditProposalRepository(db);
        const notices: string[] = [];
        const eventId = ownerEvent();
        const result = await handleProposeEdit(proposalCtx(editProposalRepo, notices), { event_id: eventId, changes });

        expect(result.success).toBe(false);
        expect(result.mutationState).toBe('not_applied');
        expect(editProposalRepo.getPendingForEvent(eventId)).toEqual([]);
        expect(notices).toEqual([]);
      });
    });
  });
});
