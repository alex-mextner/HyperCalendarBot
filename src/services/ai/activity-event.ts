// src/services/ai/activity-event.ts

export type ActivityEvent =
  | { kind: 'button'; label: string; detail?: string }
  | { kind: 'command'; name: string }
  | { kind: 'bot'; text: string }
  | { kind: 'bot_edit'; text: string }
  | { kind: 'edited'; text: string };

export function formatActivityEvent(event: ActivityEvent): string {
  switch (event.kind) {
    case 'button':
      return `[Button: "${event.label}"]${event.detail ? ` (${event.detail})` : ''}`;
    case 'command':
      return `[Command: ${event.name}]`;
    case 'bot':
      return `[Bot: ${event.text}]`;
    case 'bot_edit':
      return `[Bot edited: ${event.text}]`;
    case 'edited':
      return `[Edited: ${event.text}]`;
  }
}
