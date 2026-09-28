// src/services/ai/tool-handlers/places.ts
import type { Messages } from '../../../config/constants.ts';
import { t } from '../../../config/constants.ts';
import type { PlaceAlias, PlaceRoleName, PlaceRoleOwnerType, SavedPlace } from '../../../database/types.ts';
import type { ResolvedFuzzyPlaceMatch, ResolvedPlaceMatch } from '../../places/place-resolver.ts';
import type { AgentContext, ToolHandlerMeta, ToolResult } from '../types.ts';

function confidenceLabel(confidence: number): string {
  return confidence >= 1 ? 'exact' : `${Math.round(confidence * 100)}%`;
}

function formatPlaceFields(place: SavedPlace): string {
  const parts = [`place_id: ${place.id}`, `label: ${place.label}`, `verification: ${place.verification}`];
  if (place.venue_name) parts.push(`venue_name: ${place.venue_name}`);
  if (place.address) parts.push(`address: ${place.address}`);
  if (place.latitude !== null && place.longitude !== null)
    parts.push(`coordinates: ${place.latitude},${place.longitude}`);
  if (place.map_url) parts.push(`map_url: ${place.map_url}`);
  if (place.notes) parts.push(`notes: ${place.notes}`);
  parts.push(`favorite: ${place.favorite === 1}`);
  return parts.join(', ');
}

function formatPlaceMatchLine(place: SavedPlace, matchedAlias: string, confidence: number): string {
  return `- place_id: ${place.id}, label: ${place.label}, matched: "${matchedAlias}" (${confidenceLabel(confidence)})`;
}

function formatPlaceAliasLine(alias: PlaceAlias): string {
  return `- ${alias.alias} [alias_id: ${alias.id}]`;
}

// ── Resolve ──────────────────────────────────────────────────────────────

/**
 * Single resolution entry point for the AI — same precedence rules PlaceResolver exposes to
 * `/places` and (once merged) GH-652's dialogue-v3 boundary. exact_unique / exact_ambiguous /
 * fuzzy_confirm / none — never a group case, saved places have no collective alias concept.
 */
export function handleResolvePlace(ctx: AgentContext, input: { query: string }): ToolResult {
  const tr = t(ctx.user.language).aiTools.meta;
  if (!ctx.placeDirectory) return { success: false, error: 'Places not configured.' };
  if (ctx.isGroup) return { success: false, error: tr.placesPrivateOnly };
  const userId = ctx.user.telegram_id;
  const result = ctx.placeDirectory.placeResolver.resolve(userId, input.query);

  if (result.kind === 'none') return { success: true, output: tr.resolvePlaceNone };

  if (result.kind === 'exact_unique') {
    return {
      success: true,
      output: tr.resolvePlaceUnique(result.place.label, result.matchedAlias),
    };
  }

  if (result.kind === 'exact_ambiguous') {
    const lines = result.candidates
      .map((candidate: ResolvedPlaceMatch) => formatPlaceMatchLine(candidate.place, candidate.alias, 1))
      .join('\n');
    return {
      success: true,
      output: tr.resolvePlaceAmbiguous(lines),
      agentHint: 'Multiple places share this exact label/alias — ask the user to pick one; never guess.',
    };
  }

  const lines = result.candidates
    .map((candidate: ResolvedFuzzyPlaceMatch) =>
      formatPlaceMatchLine(candidate.place, candidate.place.label, candidate.confidence),
    )
    .join('\n');
  return {
    success: true,
    output: tr.resolvePlaceFuzzy(lines),
    agentHint:
      'Fuzzy match only — confirm with the user before proceeding, even with a single candidate. ' +
      'After the user confirms, call manage_place action=add_alias so the same phrasing resolves exactly next time.',
  };
}
handleResolvePlace.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;

// ── manage_place ─────────────────────────────────────────────────────────

/**
 * AI-facing router for the consolidated `manage_place` tool (#655) — one action-based schema
 * covering CRUD/favorite/trash/aliases in place of eleven separate ones, to fit the tool
 * catalog's character/token budget (see test/services/ai/payload-budget.test.ts).
 */
export function handleManagePlace(
  ctx: AgentContext,
  input: {
    action:
      | 'add'
      | 'update'
      | 'list'
      | 'get'
      | 'set_favorite'
      | 'delete'
      | 'restore'
      | 'purge'
      | 'add_alias'
      | 'list_aliases'
      | 'delete_alias';
    place_id?: number;
    label?: string;
    venue_name?: string;
    address?: string;
    latitude?: number;
    longitude?: number;
    map_url?: string;
    notes?: string;
    confirmed?: boolean;
    favorite?: boolean;
    alias?: string;
    alias_id?: number;
  },
): ToolResult {
  const tr = t(ctx.user.language).aiTools.meta;
  if (!ctx.placeRepo || !ctx.placeDirectory) return { success: false, error: 'Places not configured.' };
  if (ctx.isGroup) return { success: false, error: tr.placesPrivateOnly };
  const userId = ctx.user.telegram_id;
  const placeRepo = ctx.placeRepo;
  const placeAliasRepo = ctx.placeDirectory.placeAliasRepo;

  const missing = (field: string, action: string): ToolResult => ({
    success: false,
    error: `${field} is required for action=${action}.`,
  });

  switch (input.action) {
    case 'add': {
      if (input.label === undefined) return missing('label', 'add');
      const place = placeRepo.create(userId, {
        label: input.label,
        venueName: input.venue_name,
        address: input.address,
        latitude: input.latitude,
        longitude: input.longitude,
        mapUrl: input.map_url,
        notes: input.notes,
        verification: input.confirmed === true ? 'confirmed' : undefined,
        provenance: 'ai_tool',
      });
      return { success: true, output: tr.placeCreated(place.label) };
    }

    case 'update': {
      if (input.place_id === undefined) return missing('place_id', 'update');
      const updated = placeRepo.update(userId, input.place_id, {
        label: input.label,
        venueName: input.venue_name,
        address: input.address,
        latitude: input.latitude,
        longitude: input.longitude,
        mapUrl: input.map_url,
        notes: input.notes,
        verification: input.confirmed === true ? 'confirmed' : undefined,
      });
      if (!updated) return { success: false, error: tr.placeNotFound };
      return { success: true, output: tr.placeUpdated(updated.label) };
    }

    case 'list': {
      const places = placeRepo.list(userId);
      if (places.length === 0) return { success: true, output: tr.placesEmpty };
      return { success: true, output: tr.placesList(places.map((p) => formatPlaceFields(p)).join('\n')) };
    }

    case 'get': {
      if (input.place_id === undefined) return missing('place_id', 'get');
      const place = placeRepo.findById(userId, input.place_id);
      if (!place) return { success: false, error: tr.placeNotFound };
      return { success: true, output: formatPlaceFields(place) };
    }

    case 'set_favorite': {
      if (input.place_id === undefined) return missing('place_id', 'set_favorite');
      if (input.favorite === undefined) return missing('favorite', 'set_favorite');
      const place = placeRepo.findById(userId, input.place_id);
      if (!place) return { success: false, error: tr.placeNotFound };
      placeRepo.setFavorite(userId, input.place_id, input.favorite);
      return { success: true, output: tr.placeFavoriteSet(place.label, input.favorite) };
    }

    case 'delete': {
      if (input.place_id === undefined) return missing('place_id', 'delete');
      const place = placeRepo.findById(userId, input.place_id);
      if (!place) return { success: false, error: tr.placeNotFound };
      placeRepo.softDelete(userId, input.place_id);
      return { success: true, output: tr.placeDeleted(place.label) };
    }

    case 'restore': {
      if (input.place_id === undefined) return missing('place_id', 'restore');
      const place = placeRepo.findById(userId, input.place_id, { includeDeleted: true });
      if (!place) return { success: false, error: tr.placeNotFound };
      placeRepo.restore(userId, input.place_id);
      return { success: true, output: tr.placeRestored(place.label) };
    }

    case 'purge': {
      if (input.place_id === undefined) return missing('place_id', 'purge');
      const place = placeRepo.findById(userId, input.place_id, { includeDeleted: true });
      if (!place) return { success: false, error: tr.placeNotFound };
      if (place.deleted_at === null) return { success: false, error: tr.placeNotTrashed };
      const purged = placeRepo.purge(userId, input.place_id);
      if (!purged) return { success: false, error: tr.placeNotFound };
      return { success: true, output: tr.placePurged(place.label) };
    }

    case 'add_alias': {
      if (input.place_id === undefined) return missing('place_id', 'add_alias');
      if (input.alias === undefined) return missing('alias', 'add_alias');
      const place = placeRepo.findById(userId, input.place_id);
      if (!place) return { success: false, error: tr.placeNotFound };
      try {
        const alias = placeAliasRepo.add(userId, place.id, input.alias);
        return { success: true, output: tr.placeAliasAdded(alias.alias, place.label) };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('PLACE_ALIAS_CONFLICT:')) {
          return { success: false, error: tr.placeAliasConflict(input.alias) };
        }
        throw error;
      }
    }

    case 'list_aliases': {
      if (input.place_id === undefined) return missing('place_id', 'list_aliases');
      const place = placeRepo.findById(userId, input.place_id);
      if (!place) return { success: false, error: tr.placeNotFound };
      const aliases = placeAliasRepo.listForPlace(userId, place.id);
      return { success: true, output: tr.placeAliasesList(place.label, aliases.map(formatPlaceAliasLine).join('\n')) };
    }

    case 'delete_alias': {
      if (input.place_id === undefined) return missing('place_id', 'delete_alias');
      if (input.alias_id === undefined) return missing('alias_id', 'delete_alias');
      const existing = placeAliasRepo.listForPlace(userId, input.place_id).find((a) => a.id === input.alias_id);
      if (!existing) return { success: false, error: tr.placeAliasNotFound };
      placeAliasRepo.delete(userId, input.place_id, input.alias_id);
      return { success: true, output: tr.placeAliasDeleted(existing.alias) };
    }
  }
}

// ── manage_place_role ────────────────────────────────────────────────────

function roleLabel(tr: Messages['aiTools']['meta'], role: PlaceRoleName): string {
  return role === 'home' ? tr.placeRoleHome : tr.placeRoleWork;
}

/**
 * AI-facing router for `manage_place_role` (#655, design §24) — links/unlinks a saved place as
 * someone's home/work. `owner_type: 'self'` is the caller's own; `'contact'` is a private note
 * about one of their contacts (never published, never needs that person's consent); `'group'` is
 * a household's agreed shared home (owner_ref_id is a #654 collective group_id).
 */
export function handleManagePlaceRole(
  ctx: AgentContext,
  input: {
    action: 'set' | 'get' | 'clear';
    role: PlaceRoleName;
    owner_type: PlaceRoleOwnerType;
    owner_ref_id?: number;
    place_id?: number;
  },
): ToolResult {
  const tr = t(ctx.user.language).aiTools.meta;
  if (!ctx.placeRepo || !ctx.placeDirectory) return { success: false, error: 'Places not configured.' };
  if (ctx.isGroup) return { success: false, error: tr.placesPrivateOnly };
  const userId = ctx.user.telegram_id;

  if (input.owner_type !== 'self' && input.owner_ref_id === undefined) {
    return { success: false, error: tr.placeRoleOwnerRefRequired };
  }
  // Existence is validated only for `set` — a NEW link must point at a real contact/group. Once
  // a link exists, `get`/`clear` must keep working even if the linked contact/group was later
  // deleted, so a role tied to a since-removed contact/group can still be read and cleared
  // instead of becoming a permanently stuck orphan row.
  if (input.action === 'set') {
    if (input.owner_type === 'contact' && input.owner_ref_id !== undefined && ctx.contactRepo) {
      if (!ctx.contactRepo.findById(userId, input.owner_ref_id)) {
        return { success: false, error: 'Contact not found in your address book.' };
      }
    }
    if (input.owner_type === 'group' && input.owner_ref_id !== undefined && ctx.contactDirectory) {
      if (!ctx.contactDirectory.contactGroupRepo.findById(userId, input.owner_ref_id)) {
        return { success: false, error: 'That group was not found.' };
      }
    }
  }

  const owner = { ownerType: input.owner_type, ownerRefId: input.owner_ref_id };
  const label = roleLabel(tr, input.role);

  switch (input.action) {
    case 'set': {
      if (input.place_id === undefined) return { success: false, error: 'place_id is required for action=set.' };
      try {
        ctx.placeDirectory.placeRoleRepo.set(userId, input.role, owner, input.place_id);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('PLACE_ROLE_PLACE_NOT_FOUND:')) {
          return { success: false, error: tr.placeNotFound };
        }
        throw error;
      }
      const place = ctx.placeRepo.findById(userId, input.place_id);
      return { success: true, output: tr.placeRoleSet(label, place?.label ?? String(input.place_id)) };
    }

    case 'get': {
      const place = ctx.placeDirectory.placeRoleRepo.getPlace(userId, input.role, owner);
      if (!place) return { success: true, output: tr.placeRoleUnset(label) };
      return { success: true, output: tr.placeRoleGet(label, place.label) };
    }

    case 'clear': {
      const cleared = ctx.placeDirectory.placeRoleRepo.clear(userId, input.role, owner);
      return { success: true, output: cleared ? tr.placeRoleCleared(label) : tr.placeRoleUnset(label) };
    }
  }
}
