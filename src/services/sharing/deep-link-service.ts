import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { DeepLinkRepository } from '../../database/repositories/deep-link.repository';
import type { DeepLink, DeepLinkType } from '../../database/types';

const SharedEventPayloadSchema = z.object({ event_id: z.number() });
const InvitationPayloadSchema = z.object({ invitation_id: z.number(), event_id: z.number() });
const GroupContextPayloadSchema = z.object({ chat_id: z.number() });

export type ResolvedDeepLink =
  | { type: 'shared_event'; payload: z.infer<typeof SharedEventPayloadSchema>; createdBy: number }
  | { type: 'invitation'; payload: z.infer<typeof InvitationPayloadSchema>; createdBy: number }
  | { type: 'group_context'; payload: z.infer<typeof GroupContextPayloadSchema>; createdBy: number };

export class DeepLinkService {
  constructor(private repo: DeepLinkRepository) {}

  createShareLink(eventId: number, createdBy: number, expiresAt?: string): DeepLink {
    const code = `s_${randomBytes(8).toString('base64url')}`;
    return this.repo.create({
      code,
      type: 'shared_event',
      payload: JSON.stringify({ event_id: eventId }),
      created_by: createdBy,
      expires_at: expiresAt,
    });
  }

  createInvitationLink(invitationId: number, eventId: number, createdBy: number): DeepLink {
    const code = `i_${randomBytes(8).toString('base64url')}`;
    return this.repo.create({
      code,
      type: 'invitation',
      payload: JSON.stringify({ invitation_id: invitationId, event_id: eventId }),
      created_by: createdBy,
    });
  }

  createGroupContextLink(chatId: number, createdBy: number): DeepLink {
    const code = `g_${randomBytes(8).toString('base64url')}`;
    return this.repo.create({
      code,
      type: 'group_context',
      payload: JSON.stringify({ chat_id: chatId }),
      created_by: createdBy,
    });
  }

  resolve(code: string): ResolvedDeepLink | null {
    const link = this.repo.findByCode(code);
    if (!link) return null;

    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return null;
    }

    this.repo.incrementUsedCount(code);

    const raw: unknown = JSON.parse(link.payload);

    switch (link.type as DeepLinkType) {
      case 'shared_event':
        return { type: 'shared_event', payload: SharedEventPayloadSchema.parse(raw), createdBy: link.created_by };
      case 'invitation':
        return { type: 'invitation', payload: InvitationPayloadSchema.parse(raw), createdBy: link.created_by };
      case 'group_context':
        return { type: 'group_context', payload: GroupContextPayloadSchema.parse(raw), createdBy: link.created_by };
      default:
        return null;
    }
  }

  generateUrl(code: string, botUsername: string): string {
    return `https://t.me/${botUsername}?start=${code}`;
  }
}
