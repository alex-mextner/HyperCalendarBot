import type { ImageType, TemplateRenderer } from "./types.ts";
import { dailyAgendaTemplate } from "./daily-agenda.ts";
import { weeklyOverviewTemplate } from "./weekly-overview.ts";
import { eventCardTemplate } from "./event-card.ts";

const templates: Record<ImageType, TemplateRenderer<unknown>> = {
  "daily-agenda": dailyAgendaTemplate,
  "weekly-overview": weeklyOverviewTemplate,
  "event-card": eventCardTemplate,
};

export function getTemplate<T>(type: ImageType): TemplateRenderer<T> {
  const template = templates[type];
  if (!template) throw new Error(`Unknown template: ${type}`);
  return template as TemplateRenderer<T>;
}
