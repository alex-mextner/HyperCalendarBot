import type { EventDisplayMetadata } from '../../database/types.ts';
import { escapeHtml } from './helpers.ts';

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
/** Clip user-facing snippets before HTML encoding, without breaking a joined emoji. */
export function compactText(value: string | null | undefined, limit = 36): string {
  if (!value) return '';
  const text = value.replace(/\s+/g, ' ').trim();
  const parts: string[] = [];
  for (const { segment } of graphemes.segment(text)) {
    if (parts.length === limit) return `${parts.join('')}…`;
    parts.push(segment);
  }
  return parts.join('');
}

interface CompactEvent {
  location?: string;
  descriptionPreview?: string;
  displayMetadata?: EventDisplayMetadata;
}
export function renderCompactMetadata(event: CompactEvent, iconsOnly = false): string {
  const fields = [
    ['📍', event.location],
    ['✉️', event.displayMetadata?.invitationStatus],
    ['📝', event.descriptionPreview],
  ];
  const items = fields
    .filter(([, value]) => value?.trim())
    .map(
      ([icon, value]) =>
        `<span class="compact-item"><span class="compact-icon">${icon}</span>${iconsOnly ? '' : `<span class="compact-text">${escapeHtml(compactText(value))}</span>`}</span>`,
    );
  return items.length
    ? `<span class="compact-metadata${iconsOnly ? ' compact-metadata--icons' : ''}">${items.join('')}</span>`
    : '';
}

export const compactMetadataCSS = `
.compact-metadata { display:flex; gap:5px; min-width:0; max-width:100%; margin-top:3px; font-size:10px; line-height:1.3; }
.compact-item { display:flex; align-items:baseline; gap:2px; min-width:0; flex:1 1 0; overflow:hidden; }
.compact-icon { flex:none; }
.compact-text { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.event-pill .compact-metadata, .ev-dot .compact-metadata { display:grid; grid-template-columns:minmax(0,1fr); gap:1px; }
.compact-metadata--icons { display:inline-flex; flex:none; margin-top:0; }
.compact-metadata--icons .compact-item { flex:none; }
.event-block__heading { display:flex; align-items:center; gap:5px; min-width:0; }
.event-block__heading .event-block__title { flex:1; min-width:0; }
.event-block__heading > .compact-metadata--icons { display:none; }
.event-block--compact .event-block__heading > .compact-metadata--icons { display:inline-flex; }
.event-block--compact > .compact-metadata { display:none; }
.allday__content { flex:1; min-width:0; }
.allday__title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
`;
