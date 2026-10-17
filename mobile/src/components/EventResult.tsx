import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import type { EventRecord } from '../services/eventQueue';
import { useEvents } from '../services/EventsProvider';
import { PENDING_MESSAGE, savedMessage } from '../services/forecastView';
import { radius, useColors } from '../theme';
import { PrimaryButton, SecondaryButton } from './Buttons';

/**
 * What happened to the entry the person just submitted, read from the queue record: saved (and
 * whether the forecast was refreshed), still pending (not confirmed - never called saved), a
 * duplicate warning, or a server rejection. The form below stays filled in.
 */
export function ResultBanner({
  record,
  onSaveAnyway,
  onDiscardDuplicate,
  onEditAgain,
  onDone,
  onSendNow,
  hideDone = false,
  children,
}: {
  record: EventRecord;
  onSaveAnyway: () => void;
  onDiscardDuplicate: () => void;
  onEditAgain: () => void;
  onDone: () => void;
  onSendNow: () => void;
  /** The screen already has its own pinned Done button. */
  hideDone?: boolean;
  children?: React.ReactNode;
}) {
  const colors = useColors();
  if (record.status === 'saved') {
    return (
      <>
        <View accessibilityLiveRegion="polite" style={{ backgroundColor: colors.green100, borderRadius: radius.hero, padding: 18, gap: 6 }}>
          <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 17, color: colors.greenDark }}>{savedMessage(record.forecastReturned)}</Text>
        </View>
        {children}
        {hideDone ? null : <PrimaryButton label="Done" onPress={onDone} />}
      </>
    );
  }
  if (record.awaitingDuplicateDecision) {
    return (
      <>
        <View accessibilityLiveRegion="polite" style={{ backgroundColor: colors.amber100, borderRadius: radius.hero, padding: 18, gap: 6 }}>
          <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 16, color: colors.amberDark }}>Looks like an entry you already made</Text>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.amberDark, lineHeight: 20 }}>
            {record.reason ?? 'An entry with the same time and amount already exists.'}
          </Text>
        </View>
        <PrimaryButton label="Save anyway" onPress={onSaveAnyway} />
        <SecondaryButton label="Don't save" onPress={onDiscardDuplicate} />
      </>
    );
  }
  if (record.status === 'failed') {
    return (
      <>
        <View accessibilityLiveRegion="polite" style={{ backgroundColor: colors.red100, borderRadius: radius.hero, padding: 18, gap: 6 }}>
          <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 16, color: colors.red600 }}>The server could not accept this entry</Text>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.red600, lineHeight: 20 }}>{record.reason}</Text>
        </View>
        <PrimaryButton label="Edit and try again" onPress={onEditAgain} />
      </>
    );
  }
  return (
    <>
      <View accessibilityLiveRegion="polite" style={{ backgroundColor: colors.amber100, borderRadius: radius.hero, padding: 18, gap: 6 }}>
        <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 16, color: colors.amberDark }}>{PENDING_MESSAGE}</Text>
        <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.amberDark, lineHeight: 20 }}>
          Not sent to the server yet - the forecast does not include it. It is kept on this device and sent when the connection is back.
        </Text>
      </View>
      {children}
      <SecondaryButton label="Send now" onPress={onSendNow} />
      {hideDone ? null : <PrimaryButton label="Done" onPress={onDone} />}
    </>
  );
}

export function useRecord(id: string | null): EventRecord | null {
  const { records } = useEvents();
  return useMemo(() => (id ? records.find((r) => r.event.id === id) ?? null : null), [records, id]);
}

