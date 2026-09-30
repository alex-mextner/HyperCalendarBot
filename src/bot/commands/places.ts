// src/bot/commands/places.ts
import { InlineKeyboard } from 'gramio';
import { CB, type Lang, t } from '../../config/constants.ts';
import type { ContactRepository } from '../../database/repositories/contact.repository.ts';
import type { ContactGroupRepository } from '../../database/repositories/contact-group.repository.ts';
import type { PlaceRepository } from '../../database/repositories/place.repository.ts';
import type { PlaceAliasRepository } from '../../database/repositories/place-alias.repository.ts';
import type { PlaceRoleOwner, PlaceRoleRepository } from '../../database/repositories/place-role.repository.ts';
import type { PlaceAlias, PlaceRoleName, PlaceRoleOwnerType, SavedPlace } from '../../database/types.ts';
import { isGroup } from '../group-context.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';

export interface PlacesDeps {
  placeRepo: PlaceRepository;
  placeAliasRepo: PlaceAliasRepository;
  placeRoleRepo: PlaceRoleRepository;
  contactRepo: ContactRepository;
  contactGroupRepo: ContactGroupRepository;
}

const PAGE_SIZE = 8;

// ── List ──

export function buildPlacesListKeyboard(places: SavedPlace[], lang: Lang, offset: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  const page = places.slice(offset, offset + PAGE_SIZE);
  for (const place of page) {
    const label = place.favorite === 1 ? `⭐ ${place.label}` : place.label;
    kb.text(label, `${CB.PLACES}:view:${place.id}:${offset}`).row();
  }
  if (offset > 0 || offset + PAGE_SIZE < places.length) {
    if (offset > 0) kb.text(t(lang).places.btnPrev, `${CB.PLACES}:list:${Math.max(0, offset - PAGE_SIZE)}`);
    if (offset + PAGE_SIZE < places.length) kb.text(t(lang).places.btnNext, `${CB.PLACES}:list:${offset + PAGE_SIZE}`);
  }
  return kb;
}

function formatPlacesListText(places: SavedPlace[], lang: Lang): string {
  if (places.length === 0) return t(lang).places.empty;
  return t(lang).places.listTitle;
}

// ── Place detail ──

export function buildPlaceDetailKeyboard(
  place: SavedPlace,
  aliases: PlaceAlias[],
  offset: number,
  lang: Lang,
): InlineKeyboard {
  const tr = t(lang).places;
  const kb = new InlineKeyboard();
  for (const alias of aliases) {
    kb.text(tr.btnDeleteAlias(alias.alias), `${CB.PLACES}:delalias:${place.id}:${alias.id}:${offset}`).row();
  }
  kb.text(place.favorite === 1 ? tr.btnFavoriteOff : tr.btnFavoriteOn, `${CB.PLACES}:fav:${place.id}:${offset}`).row();
  kb.text(tr.btnDeletePlace, `${CB.PLACES}:delplace:${place.id}:${offset}`).row();
  kb.text(tr.btnBack, `${CB.PLACES}:list:${offset}`);
  return kb;
}

export function formatPlaceDetailText(place: SavedPlace, aliases: PlaceAlias[], lang: Lang): string {
  const tr = t(lang).places;
  const lines = [tr.detailHeader(place.label), ''];
  if (place.venue_name) lines.push(`${tr.venueLabel} ${place.venue_name}`);
  if (place.address) lines.push(`${tr.addressLabel} ${place.address}`);
  if (place.map_url) lines.push(`${tr.mapLabel} ${place.map_url}`);
  if (place.latitude !== null && place.longitude !== null) {
    lines.push(`${tr.coordsLabel} ${place.latitude}, ${place.longitude}`);
  }
  lines.push(place.verification === 'confirmed' ? tr.verifiedLabel : tr.unverifiedLabel);
  if (place.favorite === 1) lines.push(tr.favoriteLabel);
  if (place.notes) lines.push(`${tr.notesLabel} ${place.notes}`);
  if (aliases.length > 0) {
    lines.push('', tr.aliasesLabel);
    for (const alias of aliases) lines.push(`• ${alias.alias}`);
  }
  return lines.join('\n');
}

function buildDeletePlaceConfirmKeyboard(placeId: number, offset: number, lang: Lang): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang).places.btnConfirmDelete, `${CB.PLACES}:delplaceok:${placeId}:${offset}`)
    .row()
    .text(t(lang).places.btnCancel, `${CB.PLACES}:view:${placeId}:${offset}`);
}

function buildPurgePlaceConfirmKeyboard(placeId: number, lang: Lang): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang).places.btnConfirmPurge, `${CB.PLACES}:purgeplaceok:${placeId}`)
    .row()
    .text(t(lang).places.btnCancel, `${CB.PLACES}:list:0`);
}

function buildRoleClearConfirmKeyboard(
  role: PlaceRoleName,
  ownerType: PlaceRoleOwnerType,
  ownerRefId: number,
  placeId: number,
  lang: Lang,
): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang).places.btnConfirmRoleClear, `${CB.PLACES}:roleclearok:${role}:${ownerType}:${ownerRefId}:${placeId}`)
    .row()
    .text(t(lang).places.btnCancel, `${CB.PLACES}:list:0`);
}

function parseId(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isRole(value: string | undefined): value is PlaceRoleName {
  return value === 'home' || value === 'work';
}

function isOwnerType(value: string | undefined): value is PlaceRoleOwnerType {
  return value === 'self' || value === 'contact' || value === 'group';
}

function roleOwner(ownerType: PlaceRoleOwnerType, ownerRefId: number | undefined): PlaceRoleOwner | null {
  if (ownerType === 'self') return { ownerType: 'self' };
  if (!ownerRefId) return null;
  return { ownerType, ownerRefId };
}

function roleOwnerLabel(userId: number, owner: PlaceRoleOwner, deps: PlacesDeps, lang: Lang): string | null {
  if (owner.ownerType === 'self') return t(lang).places.roleOwnerSelf;
  if (owner.ownerRefId === undefined) return null;
  if (owner.ownerType === 'contact') {
    const contact = deps.contactRepo.findById(userId, owner.ownerRefId);
    return contact ? (contact.preferred_name ?? contact.name) : null;
  }
  return deps.contactGroupRepo.findById(userId, owner.ownerRefId)?.alias ?? null;
}

function roleNameLabel(role: PlaceRoleName, lang: Lang): string {
  return role === 'home' ? t(lang).places.roleHome : t(lang).places.roleWork;
}

function isClearToken(value: string): boolean {
  return value === '-' || value.toLowerCase() === 'clear';
}

// ── Command entry ──

export async function handlePlaces(ctx: BotCommandContext, deps: PlacesDeps): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;
  const lang = user.language as Lang;
  if (isGroup(ctx)) {
    await ctx.send(t(lang).places.groupNotAllowed);
    return;
  }
  const userId = user.telegram_id;
  const rawArgs = ((ctx.args as string) ?? '').trim();

  if (!rawArgs) {
    const places = deps.placeRepo.list(userId);
    await ctx.send(formatPlacesListText(places, lang), {
      reply_markup: buildPlacesListKeyboard(places, lang, 0),
    });
    return;
  }

  const [head, ...rest] = rawArgs.split(/\s+/);
  const restText = rest.join(' ');

  if (head === 'add') {
    if (!restText) {
      await ctx.send(t(lang).places.addUsage);
      return;
    }
    const place = deps.placeRepo.create(userId, { label: restText, provenance: 'command' });
    await ctx.send(t(lang).places.added(place.label));
    return;
  }

  if (head === 'edit' || head === 'rename') {
    const placeId = parseId(rest[0]);
    const field = head === 'rename' ? 'label' : rest[1];
    const valueParts = head === 'rename' ? rest.slice(1) : rest.slice(2);
    const valueText = valueParts.join(' ').trim();
    const usage = head === 'rename' ? t(lang).places.renameUsage : t(lang).places.editUsage;
    if (!placeId || !field || !valueText) {
      await ctx.send(usage);
      return;
    }
    const place = deps.placeRepo.findById(userId, placeId);
    if (!place) {
      await ctx.send(t(lang).places.notFound);
      return;
    }

    let updated: SavedPlace | null = null;
    if (field === 'label') {
      if (isClearToken(valueText)) {
        await ctx.send(usage);
        return;
      }
      updated = deps.placeRepo.update(userId, placeId, { label: valueText });
    } else if (field === 'venue') {
      updated = deps.placeRepo.update(userId, placeId, { venueName: isClearToken(valueText) ? null : valueText });
    } else if (field === 'address') {
      updated = deps.placeRepo.update(userId, placeId, { address: isClearToken(valueText) ? null : valueText });
    } else if (field === 'map') {
      updated = deps.placeRepo.update(userId, placeId, { mapUrl: isClearToken(valueText) ? null : valueText });
    } else if (field === 'notes') {
      updated = deps.placeRepo.update(userId, placeId, { notes: isClearToken(valueText) ? null : valueText });
    } else if (field === 'coords') {
      if (isClearToken(valueText)) {
        updated = deps.placeRepo.update(userId, placeId, { latitude: null, longitude: null });
      } else {
        const normalized = valueText.replace(',', ' ');
        const parts = normalized.split(/\s+/).filter(Boolean);
        const latitude = Number(parts[0]);
        const longitude = Number(parts[1]);
        if (parts.length !== 2 || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          await ctx.send(t(lang).places.invalidCoords);
          return;
        }
        try {
          updated = deps.placeRepo.update(userId, placeId, { latitude, longitude });
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('PLACE_COORDS_INVALID:')) {
            await ctx.send(t(lang).places.invalidCoords);
            return;
          }
          throw error;
        }
      }
    } else {
      await ctx.send(usage);
      return;
    }

    await ctx.send(updated ? t(lang).places.updated(updated.label) : t(lang).places.notFound);
    return;
  }

  if (head === 'trash') {
    const trashed = deps.placeRepo.listTrash(userId);
    if (trashed.length === 0) {
      await ctx.send(t(lang).places.trashEmpty);
      return;
    }
    await ctx.send(
      `${t(lang).places.trashTitle}\n${trashed.map((place) => `• ${place.id} — ${place.label}`).join('\n')}`,
    );
    return;
  }

  if (head === 'restore') {
    const placeId = parseId(rest[0]);
    if (!placeId) {
      await ctx.send(t(lang).places.restoreUsage);
      return;
    }
    const place = deps.placeRepo.findById(userId, placeId, { includeDeleted: true });
    if (!place || place.deleted_at === null) {
      await ctx.send(t(lang).places.notFound);
      return;
    }
    deps.placeRepo.restore(userId, placeId);
    await ctx.send(t(lang).places.restoredPlace(place.label));
    return;
  }

  if (head === 'purge') {
    const placeId = parseId(rest[0]);
    if (!placeId) {
      await ctx.send(t(lang).places.purgeUsage);
      return;
    }
    const place = deps.placeRepo.findById(userId, placeId, { includeDeleted: true });
    if (!place) {
      await ctx.send(t(lang).places.notFound);
      return;
    }
    if (place.deleted_at === null) {
      await ctx.send(t(lang).places.purgeNeedsTrash);
      return;
    }
    await ctx.send(t(lang).places.confirmPurgePlace(place.label), {
      reply_markup: buildPurgePlaceConfirmKeyboard(place.id, lang),
    });
    return;
  }

  if (head === 'role') {
    const [action, roleRaw, ownerTypeRaw, ...tail] = rest;
    if (
      (action !== 'get' && action !== 'set' && action !== 'clear') ||
      !isRole(roleRaw) ||
      !isOwnerType(ownerTypeRaw)
    ) {
      await ctx.send(t(lang).places.roleUsage);
      return;
    }

    let ownerRefId: number | undefined;
    let placeIdRaw: string | undefined;
    if (ownerTypeRaw === 'self') {
      placeIdRaw = tail[0];
    } else {
      const parsedOwnerRef = parseId(tail[0]);
      if (!parsedOwnerRef) {
        await ctx.send(t(lang).places.roleUsage);
        return;
      }
      ownerRefId = parsedOwnerRef;
      placeIdRaw = tail[1];
    }

    const owner = roleOwner(ownerTypeRaw, ownerRefId);
    if (!owner) {
      await ctx.send(t(lang).places.roleUsage);
      return;
    }
    const ownerLabel = roleOwnerLabel(userId, owner, deps, lang);
    if (!ownerLabel) {
      await ctx.send(t(lang).places.roleOwnerNotFound);
      return;
    }
    const roleLabel = roleNameLabel(roleRaw, lang);

    if (action === 'get') {
      const place = deps.placeRoleRepo.getPlace(userId, roleRaw, owner);
      await ctx.send(
        place
          ? t(lang).places.roleCurrent(roleLabel, ownerLabel, place.label)
          : t(lang).places.roleUnset(roleLabel, ownerLabel),
      );
      return;
    }

    if (action === 'set') {
      const placeId = parseId(placeIdRaw);
      if (!placeId) {
        await ctx.send(t(lang).places.roleUsage);
        return;
      }
      const place = deps.placeRepo.findById(userId, placeId);
      if (!place) {
        await ctx.send(t(lang).places.notFound);
        return;
      }
      deps.placeRoleRepo.set(userId, roleRaw, owner, placeId);
      await ctx.send(t(lang).places.roleSet(roleLabel, ownerLabel, place.label));
      return;
    }

    const current = deps.placeRoleRepo.getPlace(userId, roleRaw, owner);
    if (!current) {
      await ctx.send(t(lang).places.roleUnset(roleLabel, ownerLabel));
      return;
    }
    await ctx.send(t(lang).places.confirmRoleClear(roleLabel, ownerLabel, current.label), {
      reply_markup: buildRoleClearConfirmKeyboard(roleRaw, ownerTypeRaw, ownerRefId ?? 0, current.id, lang),
    });
    return;
  }
  if (head === 'alias') {
    const [placeIdStr, ...aliasParts] = rest;
    const placeId = Number(placeIdStr);
    const aliasText = aliasParts.join(' ');
    if (!placeIdStr || !Number.isFinite(placeId) || !aliasText) {
      await ctx.send(t(lang).places.aliasUsage);
      return;
    }
    const place = deps.placeRepo.findById(userId, placeId);
    if (!place) {
      await ctx.send(t(lang).places.notFound);
      return;
    }
    try {
      const alias = deps.placeAliasRepo.add(userId, place.id, aliasText);
      await ctx.send(t(lang).places.aliasAdded(alias.alias, place.label));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('PLACE_ALIAS_CONFLICT:')) {
        await ctx.send(t(lang).places.aliasConflict(aliasText));
        return;
      }
      throw error;
    }
    return;
  }

  await ctx.send(t(lang).places.usage);
}

// ── Callback routing ──

export async function handlePlacesCallback(
  ctx: BotCallbackContext,
  payload: string,
  user: { telegram_id: number; language: Lang },
  deps: PlacesDeps,
): Promise<void> {
  const lang = user.language;
  const userId = user.telegram_id;
  const tr = t(lang).places;

  // GH-712: callback queries can outlive the command message or be delivered in a group.
  // Reject before parsing the payload or touching the private saved-place directory.
  if (isGroup(ctx)) {
    await ctx.answer({ text: tr.groupNotAllowed, show_alert: true });
    return;
  }

  const [sub, ...args] = payload.split(':');

  await ctx.answer();

  if (sub === 'list') {
    const offset = Number(args[0] ?? '0') || 0;
    const places = deps.placeRepo.list(userId);
    await ctx.editText(formatPlacesListText(places, lang), {
      reply_markup: buildPlacesListKeyboard(places, lang, offset),
    });
    return;
  }

  if (sub === 'view') {
    const placeId = Number(args[0]);
    const offset = Number(args[1] ?? '0') || 0;
    const place = deps.placeRepo.findById(userId, placeId);
    if (!place) {
      await ctx.editText(tr.notFound);
      return;
    }
    const aliases = deps.placeAliasRepo.listForPlace(userId, place.id);
    await ctx.editText(formatPlaceDetailText(place, aliases, lang), {
      reply_markup: buildPlaceDetailKeyboard(place, aliases, offset, lang),
    });
    return;
  }

  if (sub === 'fav') {
    const placeId = Number(args[0]);
    const offset = Number(args[1] ?? '0') || 0;
    const current = deps.placeRepo.findById(userId, placeId);
    if (!current) {
      await ctx.editText(tr.notFound);
      return;
    }
    deps.placeRepo.setFavorite(userId, placeId, current.favorite !== 1);
    const place = deps.placeRepo.findById(userId, placeId);
    if (!place) {
      await ctx.editText(tr.notFound);
      return;
    }
    const aliases = deps.placeAliasRepo.listForPlace(userId, place.id);
    await ctx.editText(formatPlaceDetailText(place, aliases, lang), {
      reply_markup: buildPlaceDetailKeyboard(place, aliases, offset, lang),
    });
    return;
  }

  if (sub === 'delalias') {
    const placeId = Number(args[0]);
    const aliasId = Number(args[1]);
    const offset = Number(args[2] ?? '0') || 0;
    deps.placeAliasRepo.delete(userId, placeId, aliasId);
    const place = deps.placeRepo.findById(userId, placeId);
    if (!place) {
      await ctx.editText(tr.notFound);
      return;
    }
    const aliases = deps.placeAliasRepo.listForPlace(userId, place.id);
    await ctx.editText(formatPlaceDetailText(place, aliases, lang), {
      reply_markup: buildPlaceDetailKeyboard(place, aliases, offset, lang),
    });
    return;
  }

  if (sub === 'delplace') {
    const placeId = Number(args[0]);
    const offset = Number(args[1] ?? '0') || 0;
    const place = deps.placeRepo.findById(userId, placeId);
    if (!place) {
      await ctx.editText(tr.notFound);
      return;
    }
    await ctx.editText(tr.confirmDeletePlace(place.label), {
      reply_markup: buildDeletePlaceConfirmKeyboard(placeId, offset, lang),
    });
    return;
  }

  if (sub === 'delplaceok') {
    const placeId = Number(args[0]);
    const offset = Number(args[1] ?? '0') || 0;
    const place = deps.placeRepo.findById(userId, placeId);
    const deleted = place ? deps.placeRepo.softDelete(userId, placeId) : false;
    if (!deleted || !place) {
      await ctx.editText(tr.notFound);
      return;
    }
    const places = deps.placeRepo.list(userId);
    await ctx.editText(`${tr.deletedPlace(place.label)}\n\n${formatPlacesListText(places, lang)}`, {
      reply_markup: buildPlacesListKeyboard(places, lang, Math.max(0, Math.min(offset, places.length - 1))),
    });
    return;
  }

  if (sub === 'roleclearok') {
    const [roleRaw, ownerTypeRaw, ownerRefRaw, expectedPlaceRaw] = args;
    if (!isRole(roleRaw) || !isOwnerType(ownerTypeRaw)) {
      await ctx.editText(tr.roleChanged);
      return;
    }
    const ownerRefId = ownerTypeRaw === 'self' ? undefined : (parseId(ownerRefRaw) ?? undefined);
    const expectedPlaceId = parseId(expectedPlaceRaw);
    const owner = roleOwner(ownerTypeRaw, ownerRefId);
    if (!owner || !expectedPlaceId) {
      await ctx.editText(tr.roleChanged);
      return;
    }
    const ownerLabel = roleOwnerLabel(userId, owner, deps, lang);
    if (!ownerLabel) {
      await ctx.editText(tr.roleOwnerNotFound);
      return;
    }
    const current = deps.placeRoleRepo.getPlace(userId, roleRaw, owner);
    if (!current || current.id !== expectedPlaceId) {
      await ctx.editText(tr.roleChanged);
      return;
    }
    deps.placeRoleRepo.clear(userId, roleRaw, owner);
    await ctx.editText(tr.roleCleared(roleNameLabel(roleRaw, lang), ownerLabel));
    return;
  }

  if (sub === 'purgeplaceok') {
    const placeId = parseId(args[0]);
    if (!placeId) {
      await ctx.editText(tr.notFound);
      return;
    }
    const place = deps.placeRepo.findById(userId, placeId, { includeDeleted: true });
    if (!place) {
      await ctx.editText(tr.notFound);
      return;
    }
    if (place.deleted_at === null) {
      await ctx.editText(tr.purgeNeedsTrash);
      return;
    }
    deps.placeRepo.purge(userId, placeId);
    await ctx.editText(tr.purgedPlace(place.label));
    return;
  }
}
