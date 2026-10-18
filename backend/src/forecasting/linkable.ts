import type { LinkableInsulin } from '../engine/coverage.js';
import type { InsulinRow } from './events.service.js';

/**
 * A dose the person named a meal for. When that meal does not count - WITHDRAWN (cancelled), or never confirmed (draft) - the naming means
 * nothing yet; typically the photo was scanned again and the first scan replaced - so the dose is read as if no meal had been named: it pairs with a meal
 * logged around it in time (the replacement), or else it is a lone dose. Either way it was taken, so it acts.
 */
export const declaredMealOf = (i: InsulinRow): string | null => (i.mealNotCounted ? null : i.mealId);

/** Only rapid / ultra-rapid (or unstated) insulin acts through the layer's kernel. */
export const isRapidActing = (type: string | null): boolean => type === null || type === 'rapid' || type === 'ultra_rapid';

export const toLinkable = (i: InsulinRow): LinkableInsulin => ({
  id: i.insulinId,
  tSec: i.administeredAtSec,
  unitsAdministered: i.unitsAdministered,
  kind: i.kind,
  confirmation: i.confirmation,
  declaredMealId: declaredMealOf(i),
  rapidActing: isRapidActing(i.insulinType),
});
