import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { apiContext } from '../api/apiContext';
import {
  getTherapyHistory,
  getTherapySettings,
  putTherapySettings,
  validateTherapyForm,
  type TherapyFormErrors,
  type TherapyRowInput,
  type TherapySettingsView,
  type TherapySource,
} from '../api/therapyApi';
import { BackButton, PrimaryButton, SecondaryButton } from '../components/Buttons';
import { Card } from '../components/Card';
import { ChoiceChips, FormField } from '../components/FormField';
import { RootStackParamList } from '../navigation/types';
import { radius, spacing, useColors } from '../theme';

const SOURCES: { value: TherapySource; label: string }[] = [
  { value: 'clinician_prescribed', label: 'Prescribed by my care team' },
  { value: 'user_entered', label: 'Entered by me' },
];
const INSULIN: { value: 'rapid' | 'ultra_rapid'; label: string }[] = [
  { value: 'rapid', label: 'Rapid-acting' },
  { value: 'ultra_rapid', label: 'Ultra-rapid' },
];

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '');

/**
 * Insulin-to-carb ratio and correction factor, as the values the person or their care team entered.
 * Never pre-filled, suggested or adjusted by the app; each save is a new version on the server.
 */
export function InsulinSettingsScreen({ navigation }: NativeStackScreenProps<RootStackParamList, 'InsulinSettings'>) {
  const colors = useColors();
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [current, setCurrent] = useState<TherapySettingsView | null>(null);
  const [history, setHistory] = useState<TherapySettingsView[]>([]);
  const [rows, setRows] = useState<TherapyRowInput[]>([{ startTime: '00:00', icr: '', isf: '' }]);
  const [source, setSource] = useState<TherapySource | null>(null);
  const [insulinType, setInsulinType] = useState<'rapid' | 'ultra_rapid' | null>(null);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<TherapyFormErrors | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const fetchAll = () => Promise.all([getTherapySettings(apiContext), getTherapyHistory(apiContext)]);

  const apply = useCallback(
    ([cur, hist]: Awaited<ReturnType<typeof fetchAll>>) => {
      setLoading(false);
      if (cur.kind !== 'ok') {
        setUnavailable(true);
        return;
      }
      setUnavailable(false);
      setCurrent(cur.value);
      if (hist.kind === 'ok') setHistory(hist.value);
      // Show what is currently saved (the person's own values), never a default.
      if (cur.value.status === 'set') {
        setRows(
          cur.value.icrSegments.map((s, i) => ({
            startTime: s.startTime,
            icr: String(s.gramsPerUnit),
            isf: cur.value.isfSegments[i] ? String(cur.value.isfSegments[i].mgdlPerUnit) : '',
          })),
        );
        setSource(cur.value.source);
        setInsulinType(cur.value.insulinType);
      }
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    void Promise.all([getTherapySettings(apiContext), getTherapyHistory(apiContext)]).then((r) => {
      if (alive) apply(r);
    });
    return () => {
      alive = false;
    };
  }, [apply]);

  const load = () => void fetchAll().then(apply);

  const setRow = (i: number, patch: Partial<TherapyRowInput>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const save = async () => {
    if (saving) return;
    const result = validateTherapyForm({ rows, source, insulinType, note });
    if (!result.ok) {
      setErrors(result.errors);
      setMessage(null);
      return;
    }
    setErrors(null);
    setSaving(true);
    const out = await putTherapySettings(apiContext, result.body);
    setSaving(false);
    if (out.kind === 'ok') {
      setMessage(`Saved as version ${out.value.version}. Earlier forecasts keep the values they used.`);
      load();
    } else if (out.kind === 'invalid') {
      setMessage(out.reason);
    } else {
      setMessage('Could not save right now. Your entries are still here - try again.');
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ground }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <BackButton onPress={() => navigation.goBack()} accessibilityLabel="Back" />
          <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 20, color: colors.ink }}>
            Insulin settings
          </Text>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.xl, gap: 16 }}>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 20 }}>
            The values you or your care team entered. SugarSense never fills in, suggests or changes these.
          </Text>

          {loading ? <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>Loading...</Text> : null}
          {unavailable ? (
            <View style={{ backgroundColor: colors.amber100, borderRadius: radius.hero, padding: 16, gap: 8 }}>
              <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.amberDark }}>Settings are not available right now</Text>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.amberDark, lineHeight: 20 }}>
                The server cannot save settings yet. Nothing has been changed.
              </Text>
              <SecondaryButton label="Try again" onPress={() => { setLoading(true); load(); }} />
            </View>
          ) : null}

          {current?.status === 'not_set' ? (
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 20 }}>{current.whenMissing}</Text>
          ) : null}
          {current?.status === 'set' ? (
            <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>
              Current: version {current.version}, from {fmt(current.effectiveFrom)}
            </Text>
          ) : null}

          {!unavailable ? (
            <>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 20 }}>
                Insulin-to-carb ratio: grams of carbohydrate covered by 1 unit of rapid-acting insulin (for example 1 unit : 10 g). Correction
                factor: how many mg/dL 1 unit lowers glucose.
              </Text>
              {rows.map((r, i) => (
                <Card key={i}>
                  <View style={{ gap: 12 }}>
                    <FormField
                      label={i === 0 ? 'From (24 h, first must be 00:00)' : 'From (24 h)'}
                      value={r.startTime}
                      onChangeText={(t) => setRow(i, { startTime: t })}
                      placeholder="00:00"
                      keyboardType="numbers-and-punctuation"
                      error={errors?.rows[i]?.startTime}
                    />
                    <FormField label="Grams covered by 1 unit" required value={r.icr} onChangeText={(t) => setRow(i, { icr: t })} unit="g" keyboardType="decimal-pad" error={errors?.rows[i]?.icr} />
                    <FormField label="mg/dL lowered by 1 unit" value={r.isf} onChangeText={(t) => setRow(i, { isf: t })} unit="mg/dL" keyboardType="decimal-pad" error={errors?.rows[i]?.isf} />
                    {rows.length > 1 ? <SecondaryButton label="Remove this time of day" onPress={() => setRows((x) => x.filter((_, j) => j !== i))} /> : null}
                  </View>
                </Card>
              ))}
              {rows.length < 8 ? <SecondaryButton label="Add a time of day" onPress={() => setRows((x) => [...x, { startTime: '', icr: '', isf: '' }])} /> : null}
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>
                Leave the correction factor blank to keep the one already saved.
              </Text>

              <View style={{ gap: 8 }}>
                <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>Where do these values come from? *</Text>
                <ChoiceChips options={SOURCES} value={source ?? ('' as TherapySource)} onChange={setSource} />
                {errors?.source ? <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.red600 }}>{errors.source}</Text> : null}
              </View>
              <View style={{ gap: 8 }}>
                <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>Insulin type (optional)</Text>
                <ChoiceChips options={INSULIN} value={insulinType ?? ('' as 'rapid')} onChange={setInsulinType} />
              </View>
              <FormField label="Note (optional)" value={note} onChangeText={setNote} multiline maxLength={500} error={errors?.note} />

              {errors?.general ? <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.red600 }}>{errors.general}</Text> : null}
              {message ? (
                <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.ink }}>
                  {message}
                </Text>
              ) : null}
              <PrimaryButton label="Save as a new version" onPress={save} loading={saving} />
              {current?.disclaimer ? <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3, lineHeight: 18 }}>{current.disclaimer}</Text> : null}
            </>
          ) : null}

          {history.length > 0 ? (
            <View style={{ gap: 8 }}>
              <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>Earlier versions (read only)</Text>
              {history.map((h) => (
                <View key={h.version} style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.row, padding: 12 }}>
                  <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.ink }}>
                    Version {h.version} · from {fmt(h.effectiveFrom)}
                  </Text>
                  <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>
                    {h.icrSegments.map((s) => `${s.startTime}: 1 U : ${s.gramsPerUnit} g`).join(' · ')}
                  </Text>
                  {h.isfSegments.length > 0 ? (
                    <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>
                      {h.isfSegments.map((s) => `${s.startTime}: ${s.mgdlPerUnit} mg/dL per U`).join(' · ')}
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
