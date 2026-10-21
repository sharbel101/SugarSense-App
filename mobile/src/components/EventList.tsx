import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { InsulinView, MealView } from '../api/eventsApi';
import {
  formatEventTime,
  toHhmm,
  INSULIN_KINDS,
  parseNumber,
  resolveEventTime,
  type AbsorptionClass,
  type TimeChoice,
} from '../services/events';
import type { EventRecord } from '../services/eventQueue';
import { useEvents } from '../services/EventsProvider';
import { radius, touch, useColors } from '../theme';
import { IconButton, PrimaryButton, SecondaryButton } from './Buttons';
import { Icon } from './Icon';
import { AbsorptionChoice, CheckRow, EventTimePicker, FormField } from './FormField';

type Row =
  | { key: string; kind: 'meal'; time: string; view: MealView | null; record: EventRecord | null }
  | { key: string; kind: 'insulin'; time: string; view: InsulinView | null; record: EventRecord | null };

const KIND_LABEL: Record<string, string> = { bolus: 'With a meal', correction: 'Correction', basal: 'Long-acting / basal', other: 'Insulin' };

function carbsBadge(kind: MealView['carbs']['kind']): string {
  return kind === 'estimated' ? 'estimated' : kind === 'user_corrected' ? 'corrected' : kind === 'user_entered' ? 'entered' : 'carbs unknown';
}

/** Server entries (GET /events/recent) merged with the ones still only on this device, newest first. */
function buildRows(records: EventRecord[], meals: MealView[], insulin: InsulinView[]): Row[] {
  const rows: Row[] = [];
  const since = Date.now() - 24 * 3_600_000;
  const serverIds = new Set<string>();
  for (const m of meals) {
    serverIds.add(m.id);
    if (m.status === 'cancelled') continue; // removed from the forecast; kept in history on the server
    rows.push({ key: m.id, kind: 'meal', time: m.eatenAt, view: m, record: records.find((r) => r.serverId === m.id) ?? null });
  }
  for (const i of insulin) {
    serverIds.add(i.id);
    if (i.status === 'cancelled') continue;
    rows.push({ key: i.id, kind: 'insulin', time: i.administeredAt, view: i, record: records.find((r) => r.serverId === i.id) ?? null });
  }
  for (const r of records) {
    if (r.serverId && serverIds.has(r.serverId)) continue;
    if (r.status === 'saved') continue; // server has it but the list has not refreshed yet
    rows.push({ key: `local-${r.event.id}`, kind: r.event.kind, time: r.event.occurredAtUtc, view: null, record: r } as Row);
  }
  return rows.filter((r) => Date.parse(r.time) >= since).sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

export function EventList({ onDone }: { onDone: () => void }) {
  const colors = useColors();
  const { records, recent, refreshRecent, sendNow, saveAnyway, discard, editMeal, editInsulin } = useEvents();
  const [editing, setEditing] = useState<Row | null>(null);
  const [askingKey, setAskingKey] = useState<string | null>(null);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Trash = withdraw the entry: it stops acting in the forecast and stays in the history on the server.
  const removeEntry = async (row: Row) => {
    if (!row.view || removingKey) return;
    setRemoveError(null);
    setRemovingKey(row.key);
    const out =
      row.kind === 'meal'
        ? await editMeal(row.view.id, { status: 'cancelled', expectedRevision: row.view.revision })
        : await editInsulin(row.view.id, { status: 'cancelled', expectedRevision: row.view.revision });
    setRemovingKey(null);
    setAskingKey(null);
    if (out.result === 'updated' || out.result === 'unchanged' || out.result === 'exists') refreshRecent();
    else if (out.result === 'conflict') {
      refreshRecent();
      setRemoveError('This entry changed - please check it again.');
    } else if (out.result === 'invalid') setRemoveError("The server can't remove this entry yet.");
    else setRemoveError('Could not remove it right now. Nothing was changed - try again.');
  };

  useEffect(() => {
    refreshRecent();
  }, [refreshRecent]);

  const rows = useMemo(
    () => buildRows(records, recent.kind === 'ok' ? recent.meals : [], recent.kind === 'ok' ? recent.insulin : []),
    [records, recent],
  );

  if (editing) {
    return <EditEntry row={editing} onClose={() => setEditing(null)} />;
  }

  return (
    <>
      {recent.kind === 'loading' ? (
        <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>Loading what you logged...</Text>
      ) : null}
      {recent.kind === 'unavailable' ? (
        <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.amberDark }}>
          The list from the server is not available right now. Entries not sent yet are shown below.
        </Text>
      ) : null}
      {rows.length === 0 && recent.kind !== 'loading' ? (
        <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>Nothing logged in the last 24 hours.</Text>
      ) : null}
      {removeError ? (
        <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.red600 }}>
          {removeError}
        </Text>
      ) : null}
      {rows.map((row) => (
        <EventRow
          key={row.key}
          row={row}
          asking={askingKey === row.key}
          removing={removingKey === row.key}
          onAskRemove={() => setAskingKey(row.key)}
          onCancelRemove={() => setAskingKey(null)}
          onConfirmRemove={() => void removeEntry(row)}
          onEdit={() => setEditing(row)}
          onSendNow={sendNow}
          onSaveAnyway={() => row.record && saveAnyway(row.record.event.id)}
          onDiscard={() => row.record && discard(row.record.event.id)}
        />
      ))}
      <SecondaryButton label="Refresh" onPress={refreshRecent} />
      <PrimaryButton label="Done" onPress={onDone} />
    </>
  );
}

function EventRow({
  row,
  asking,
  removing,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
  onEdit,
  onSendNow,
  onSaveAnyway,
  onDiscard,
}: {
  row: Row;
  asking: boolean;
  removing: boolean;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
  onEdit: () => void;
  onSendNow: () => void;
  onSaveAnyway: () => void;
  onDiscard: () => void;
}) {
  const colors = useColors();
  let title: string;
  let detail: string;
  const status = row.view ? 'saved' : row.record?.awaitingDuplicateDecision ? 'duplicate' : row.record?.status === 'failed' ? 'failed' : 'not sent yet';

  if (row.kind === 'meal') {
    const v = row.view;
    if (v) {
      title = v.carbs.grams === null ? 'Meal - carbs unknown' : `Meal - ${Math.round(v.carbs.grams)} g carbs`;
      detail = `${carbsBadge(v.carbs.kind)}${v.status === 'cancelled' ? ' · cancelled' : ''}`;
    } else {
      const e = row.record?.event;
      title = e && e.kind === 'meal' ? `${e.label} - ${Math.round(e.carbsG)} g carbs` : 'Meal';
      detail = 'entered';
    }
  } else {
    const v = row.view;
    if (v) {
      title = v.confirmation === 'planned' ? 'Insulin - planned only (not taken)' : v.unitsTaken === 0 ? 'No insulin taken (you confirmed)' : v.unitsTaken === null ? 'Insulin - amount unknown' : `Insulin - ${v.unitsTaken} U`;
      detail = `${KIND_LABEL[v.kind] ?? 'Insulin'} · ${v.confirmation}`;
    } else {
      const e = row.record?.event;
      title = e && e.kind === 'insulin' ? (e.unitsAdministered === 0 ? 'No insulin taken (you confirmed)' : `Insulin - ${e.unitsAdministered} U`) : 'Insulin';
      detail = e && e.kind === 'insulin' ? `${INSULIN_KINDS.find((k) => k.value === e.insulinKind)?.label ?? 'Insulin'} · ${e.confirmation}` : '';
    }
  }
  const cancelled = row.kind === 'meal' && row.view?.status === 'cancelled';
  const canEdit = row.view !== null;
  const canRemove = row.view !== null;

  return (
    <View style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.row, padding: 14, gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Pressable
        onPress={canEdit ? onEdit : undefined}
        accessibilityRole={canEdit ? 'button' : 'text'}
        accessibilityLabel={`${title}, ${formatEventTime(row.time)}, ${status}`}
        style={{ flex: 1, minHeight: touch.min, justifyContent: 'center' }}
      >
        <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink, textDecorationLine: cancelled ? 'line-through' : 'none' }}>{title}</Text>
        <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>
          {formatEventTime(row.time)} · {detail} · {status}
        </Text>
        {canEdit ? <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.blue600 }}>Edit</Text> : null}
      </Pressable>
      {canRemove ? (
        <IconButton accessibilityLabel={`Remove ${title}`} onPress={onAskRemove} size={touch.min} bg={colors.red100}>
          <Icon name="trash" size={20} color={colors.red600} />
        </IconButton>
      ) : null}
      </View>
      {asking ? (
        <>
          <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink, lineHeight: 20 }}>
            {row.kind === 'meal' ? 'Remove this meal?' : 'Remove this insulin record?'} It stops counting in the forecast and stays in your history on the server.
          </Text>
          <PrimaryButton label="Remove" onPress={onConfirmRemove} loading={removing} />
          <SecondaryButton label="Keep it" onPress={onCancelRemove} />
        </>
      ) : null}
      {status === 'not sent yet' ? (
        <>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>Not sent yet - the forecast does not include it.</Text>
          <SecondaryButton label="Send now" onPress={onSendNow} />
        </>
      ) : null}
      {status === 'duplicate' ? (
        <>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.amberDark }}>{row.record?.reason}</Text>
          <PrimaryButton label="Save anyway" onPress={onSaveAnyway} />
          <SecondaryButton label="Don't save" onPress={onDiscard} />
        </>
      ) : null}
      {status === 'failed' ? (
        <>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.red600 }}>{row.record?.reason}</Text>
          <SecondaryButton label="Remove from this device" onPress={onDiscard} />
        </>
      ) : null}
    </View>
  );
}

// ------------------------------------------------------------------------------------------ editing

function EditEntry({ row, onClose }: { row: Row; onClose: () => void }) {
  return row.kind === 'meal' && row.view ? (
    <EditMeal view={row.view} onClose={onClose} />
  ) : row.kind === 'insulin' && row.view ? (
    <EditInsulin view={row.view} onClose={onClose} />
  ) : null;
}

const CONFLICT_TEXT = 'This entry changed - please check it again.';

function useEditOutcome() {
  const { refreshRecent } = useEvents();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const handle = (result: string, reason: string | undefined, onOk: () => void) => {
    setBusy(false);
    if (result === 'updated' || result === 'unchanged' || result === 'exists' || result === 'created') {
      refreshRecent();
      onOk();
    } else if (result === 'conflict') {
      refreshRecent();
      setMessage(CONFLICT_TEXT);
    } else if (result === 'invalid') setMessage(reason ?? 'The server rejected this change.');
    else if (result === 'not_found') setMessage('This entry no longer exists.');
    else setMessage('Could not reach the server. Nothing was changed - try again.');
  };
  return { message, setMessage, busy, setBusy, handle };
}

export function EditMeal({ view, onClose, showTitle = true }: { view: MealView; onClose: () => void; showTitle?: boolean }) {
  const colors = useColors();
  const { editMeal } = useEvents();
  const { message, setMessage, busy, setBusy, handle } = useEditOutcome();
  const [carbs, setCarbs] = useState(view.carbs.grams === null ? '' : String(view.carbs.grams));
  const [time, setTime] = useState<TimeChoice>({ mode: 'clock', hhmm: toHhmm(view.eatenAt) });
  const [hhmm, setHhmm] = useState(toHhmm(view.eatenAt));
  const [timeTouched, setTimeTouched] = useState(false);
  const [approximate, setApproximate] = useState(view.timeApproximateMin > 0);
  const [absorption, setAbsorption] = useState<AbsorptionClass | 'unset'>(view.absorptionClass ?? 'unset');
  const [error, setError] = useState<string | undefined>();
  const [timeError, setTimeError] = useState<string | undefined>();
  const cancelled = view.status === 'cancelled';

  const save = async () => {
    if (busy) return;
    const patch: Parameters<typeof editMeal>[1] = { expectedRevision: view.revision };
    const n = parseNumber(carbs);
    if (carbs.trim() !== '') {
      if (n === null || n <= 0 || n > 400) {
        setError('Carbohydrates must be a number above 0, up to 400 g.');
        return;
      }
      const rounded = Math.round(n * 10) / 10;
      if (rounded !== view.carbs.grams) patch.carbsG = rounded;
    }
    if (timeTouched) {
      const t = resolveEventTime(time, new Date());
      if ('error' in t) {
        setTimeError(t.error);
        return;
      }
      patch.eatenAt = t.utcIso;
    }
    if (approximate !== view.timeApproximateMin > 0) patch.timingUncertaintyMin = approximate ? 15 : 0;
    if (absorption !== 'unset' && absorption !== view.absorptionClass) patch.absorptionClass = absorption;
    if (Object.keys(patch).length === 1) {
      onClose();
      return;
    }
    setError(undefined);
    setTimeError(undefined);
    setMessage(null);
    setBusy(true);
    const out = await editMeal(view.id, patch);
    handle(out.result, out.reason, onClose);
  };

  const cancelMeal = async () => {
    if (busy) return;
    setMessage(null);
    setBusy(true);
    const out = await editMeal(view.id, { status: 'cancelled', expectedRevision: view.revision });
    handle(out.result, out.reason, onClose);
  };

  return (
    <>
      {showTitle ? <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.ink }}>Edit meal</Text> : null}
      {cancelled ? <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.amberDark }}>This meal is cancelled and not in the forecast.</Text> : null}
      {message ? <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.red600 }}>{message}</Text> : null}
      <FormField label="Carbohydrates" value={carbs} onChangeText={setCarbs} unit="g" keyboardType="decimal-pad" error={error} />
      <EventTimePicker
        value={time}
        hhmm={hhmm}
        onChange={(c) => {
          setTimeTouched(true);
          setTime(c);
        }}
        onChangeHhmm={setHhmm}
        error={timeError}
      />
      <CheckRow checked={approximate} onChange={setApproximate} label="The time is approximate" />
      <AbsorptionChoice value={absorption} onChange={setAbsorption} allowClear={view.absorptionClass === null} />
      <PrimaryButton label="Save changes" onPress={save} loading={busy} />
      {!cancelled ? <SecondaryButton label="Cancel this meal" onPress={cancelMeal} /> : null}
      <SecondaryButton label="Back" onPress={onClose} />
    </>
  );
}

export function EditInsulin({ view, onClose }: { view: InsulinView; onClose: () => void }) {
  const colors = useColors();
  const { editInsulin } = useEvents();
  const { message, setMessage, busy, setBusy, handle } = useEditOutcome();
  const [units, setUnits] = useState(view.unitsTaken === null ? '' : String(view.unitsTaken));
  const [time, setTime] = useState<TimeChoice>({ mode: 'clock', hhmm: toHhmm(view.administeredAt) });
  const [hhmm, setHhmm] = useState(toHhmm(view.administeredAt));
  const [timeTouched, setTimeTouched] = useState(false);
  const [notSure, setNotSure] = useState(view.confirmation === 'uncertain');
  const [error, setError] = useState<string | undefined>();
  const [timeError, setTimeError] = useState<string | undefined>();

  const save = async () => {
    if (busy) return;
    const patch: Parameters<typeof editInsulin>[1] = { expectedRevision: view.revision };
    const n = parseNumber(units);
    if (units.trim() === '' || n === null || n < 0 || n > 50 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
      setError('Units must be a number from 0 to 50, with at most 2 decimals.');
      return;
    }
    if (n !== view.unitsTaken) patch.unitsAdministered = n;
    if (timeTouched) {
      const t = resolveEventTime(time, new Date());
      if ('error' in t) {
        setTimeError(t.error);
        return;
      }
      patch.administeredAt = t.utcIso;
    }
    if (notSure !== (view.confirmation === 'uncertain')) {
      patch.confirmation = notSure ? 'uncertain' : 'confirmed';
      patch.timingUncertain = notSure;
    }
    if (Object.keys(patch).length === 1) {
      onClose();
      return;
    }
    setError(undefined);
    setTimeError(undefined);
    setMessage(null);
    setBusy(true);
    const out = await editInsulin(view.id, patch);
    handle(out.result, out.reason, onClose);
  };

  return (
    <>
      <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.ink }}>Edit insulin record</Text>
      <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 20 }}>
        Insulin records cannot be cancelled here. Correct the units or time instead. 0 means you confirm none was taken.
      </Text>
      {message ? <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.red600 }}>{message}</Text> : null}
      <FormField label="Units taken" value={units} onChangeText={setUnits} unit="U" keyboardType="decimal-pad" error={error} />
      <EventTimePicker
        value={time}
        hhmm={hhmm}
        onChange={(c) => {
          setTimeTouched(true);
          setTime(c);
        }}
        onChangeHhmm={setHhmm}
        error={timeError}
      />
      <CheckRow checked={notSure} onChange={setNotSure} label="I'm not sure of the amount or time" />
      <PrimaryButton label="Save changes" onPress={save} loading={busy} />
      <SecondaryButton label="Back" onPress={onClose} />
    </>
  );
}
