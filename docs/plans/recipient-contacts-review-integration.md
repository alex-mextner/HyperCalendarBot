# Recipient/contact review integration

Preserve the privacy PR's `ToolResult.audit.targetUserId` and executor preference for that resolved numeric target, particularly for username-only `send_invitation`. This work adds no competing audit-result field or send-invitation audit implementation. Its input-based `telegram_id` extraction records `get_user_info` metadata mutations; retain it as a fallback when combining the changes.

Profile inspection is an audited mutation with a separate throttle exemption so each call checks access. Its cache contains only metadata, scoped to the caller context and numeric ID (30-second lifetime, at most 32 entries, bounded 20-second inspection). Numeric invitation delivery waits at most one event-loop turn for optional metadata. Explicit username resolution remains fresh.

Confirmation continuation failures can retry an unconsumed token. Once consumed, a failure cannot restore it; another approval is required. Completed continuations discard unused approval. Existing accepted invitations remain protected against send/resend.
