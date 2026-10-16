import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { radius, touch, useColors } from '../theme';
import { TimeChoice } from '../services/events';
import { Icon } from './Icon';

type FieldProps = {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  error?: string;
  unit?: string;
  placeholder?: string;
  keyboardType?: 'default' | 'decimal-pad' | 'numbers-and-punctuation';
  multiline?: boolean;
  required?: boolean;
  maxLength?: number;
};

/** Labelled text input with a field-level error line. Numeric fields pass `keyboardType="decimal-pad"`. */
export function FormField({
  label,
  value,
  onChangeText,
  error,
  unit,
  placeholder,
  keyboardType = 'default',
  multiline,
  required,
  maxLength,
}: FieldProps) {
  const colors = useColors();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>
        {label}
        {required ? ' *' : ''}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.ink3}
          keyboardType={keyboardType}
          multiline={multiline}
          maxLength={maxLength}
          accessibilityLabel={label}
          aria-invalid={!!error}
          style={{
            flex: 1,
            minHeight: touch.min,
            fontFamily: 'Manrope_600SemiBold',
            fontSize: 16,
            color: colors.ink,
            borderWidth: 1,
            borderColor: error ? colors.red600 : colors.border,
            borderRadius: radius.chip,
            paddingHorizontal: 14,
            paddingVertical: 10,
            ...(multiline ? { minHeight: 72, textAlignVertical: 'top' as const } : null),
          }}
        />
        {unit ? <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 15, color: colors.ink2 }}>{unit}</Text> : null}
      </View>
      {error ? (
        <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.red600 }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/** A row of single-choice chips, each a full 48 dp touch target. */
export function ChoiceChips<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const colors = useColors();
  return (
    <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            onPress={() => onChange(option.value)}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            aria-checked={selected}
            style={{
              minHeight: touch.min,
              minWidth: touch.min,
              paddingHorizontal: 16,
              justifyContent: 'center',
              alignItems: 'center',
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: selected ? colors.blue600 : colors.border,
              backgroundColor: selected ? colors.blue600 : colors.surface,
            }}
          >
            <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: selected ? colors.onBlue : colors.ink }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const MINUTES_AGO: { value: number | 'clock'; label: string }[] = [
  { value: 0, label: 'Now' },
  { value: 15, label: '15 min ago' },
  { value: 30, label: '30 min ago' },
  { value: 60, label: '1 h ago' },
  { value: 120, label: '2 h ago' },
  { value: 'clock', label: 'Other time' },
];

/** When it happened: defaults to now; quick past offsets or a typed HH:MM (today, else yesterday). */
export function EventTimePicker({
  value,
  hhmm,
  onChange,
  onChangeHhmm,
  error,
}: {
  value: TimeChoice;
  hhmm: string;
  onChange: (choice: TimeChoice) => void;
  onChangeHhmm: (text: string) => void;
  error?: string;
}) {
  const colors = useColors();
  const selected: number | 'clock' = value.mode === 'clock' ? 'clock' : value.minutes;
  const known = MINUTES_AGO.some((o) => o.value === selected);
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>When</Text>
      <ChoiceChips
        options={MINUTES_AGO}
        value={known ? selected : 0}
        onChange={(v) => onChange(v === 'clock' ? { mode: 'clock', hhmm } : { mode: 'minutesAgo', minutes: v })}
      />
      {value.mode === 'clock' ? (
        <FormField
          label="Time (24 h, local)"
          value={hhmm}
          onChangeText={(t) => {
            onChangeHhmm(t);
            onChange({ mode: 'clock', hhmm: t });
          }}
          placeholder="14:30"
          keyboardType="numbers-and-punctuation"
          error={error}
        />
      ) : error ? (
        <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.red600 }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/** A checkbox row with a text label and an optional field-level error. 48 dp tall. */
export function CheckRow({
  checked,
  onChange,
  label,
  error,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  error?: string;
}) {
  const colors = useColors();
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        onPress={() => onChange(!checked)}
        accessibilityRole="checkbox"
        aria-checked={checked}
        accessibilityLabel={label}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: touch.min }}
      >
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            borderWidth: 2,
            borderColor: checked ? colors.blue600 : colors.ink3,
            backgroundColor: checked ? colors.blue600 : 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {checked ? <Icon name="check" size={16} color={colors.onBlue} /> : null}
        </View>
        <Text style={{ flex: 1, fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink, lineHeight: 20 }}>{label}</Text>
      </Pressable>
      {error ? (
        <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.red600 }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
