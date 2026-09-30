// src/bot/commands/places.ts
import { InlineKeyboard } from 'gramio';
import { CB, type Lang, t } from '../../config/constants.ts';
import type { PlaceRepository } from '../../database/repositories/place.repository.ts';
import type { PlaceAliasRepository } from '../../database/repositories/place-alias.repository.ts';
import type { PlaceAlias, SavedPlace } from '../../database/types.ts';
import { isGroup } from '../group-context.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';

export interface PlacesDeps {
  placeRepo: PlaceRepository;
  placeAliasRepo: PlaceAliasRepository;
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
  if (place.address) lines.push(`${tr.addressLabel} ${place.address}`);
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
}
