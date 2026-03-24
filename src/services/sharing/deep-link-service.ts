import { randomBytes } from 'node:crypto';
import type { DeepLinkRepository } from '../../database/repositories/deep-link.repository';
import type { DeepLink } from '../../database/types';

type ResolvedDeepLink =
  | { type: 'shared_event'; payload: { event_id: number }; createdBy: number }
  | { type: 'invitation'; payload: { invitation_id: number; event_id: number }; createdBy: number }
  | { type: 'group_context'; payload: { chat_id: number }; createdBy: number };

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

    return {
      type: link.type,
      payload: JSON.parse(link.payload) as ResolvedDeepLink['payload'],
      createdBy: link.created_by,
    } as ResolvedDeepLink;
  }

  generateUrl(code: string, botUsername: string): string {
    return `https://t.me/${botUsername}?start=${code}`;
  }
}
