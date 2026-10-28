// attach_pending_location_to_event: binds the pin the user just sent to an event through the
// location-verification service, then clears the pending pin so it cannot be reused.
import { t } from '../../../../config/constants.ts';
import { logger } from '../../../../utils/logger.ts';
import type { AgentContext, ToolResult } from '../../types.ts';
import type { AttachPendingLocationInput } from './types.ts';

export async function handleAttachPendingLocationToEvent(
  ctx: AgentContext,
  input: AttachPendingLocationInput,
): Promise<ToolResult> {
  if (!ctx.locationVerification || !ctx.pendingGeoStore) {
    return { success: false, error: 'Location verification is not available' };
  }

  const geo = await ctx.pendingGeoStore.get(ctx.user.telegram_id);
  if (!geo) {
    return {
      success: false,
      error: 'No pending location pin found. Ask the user to send a 📍 pin via Telegram, then try again.',
    };
  }

  const success = await ctx.locationVerification.resolveFromSharedLocation(input.event_id, geo, ctx.user.telegram_id);

  if (!success) {
    return { success: false, error: `Could not resolve geo to address for event ${input.event_id}` };
  }

  // Clear the pending pin so subsequent calls don't reuse stale data
  await ctx.pendingGeoStore.delete(ctx.user.telegram_id).catch((err) => {
    logger.warn({ err, userId: ctx.user.telegram_id }, 'Failed to clear pending geo after attach');
  });

  return {
    success: true,
    output: t(ctx.user.language).aiTools.events.locationAttached(input.event_id),
  };
}
