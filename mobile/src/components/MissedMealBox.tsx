import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useMissedMeal } from '../services/MissedMealProvider';
import { radius, touch, useColors } from '../theme';
import { Icon } from './Icon';
import { useQuickAdd } from './QuickAdd';

/**
 * Under the graph on Home: shown only when glucose rose fast and no meal is logged around it. It states what the
 * readings show and asks; it never says a meal happened or what to take. Calm amber, not red.
 */
export function MissedMealBox() {
  const colors = useColors();
  const { summary, dismiss } = useMissedMeal();
  const { open } = useQuickAdd();
  if (!summary) return null;
  const small = { fontFamily: 'Manrope_700Bold', fontSize: 14 } as const;
  return (
    <View accessibilityRole="alert" style={{ backgroundColor: colors.amber100, borderRadius: radius.row, padding: 14, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="fork" size={18} color={colors.amberDark} />
        <Text accessibilityRole="header" style={{ flex: 1, fontFamily: 'Manrope_800ExtraBold', fontSize: 15, color: colors.amberDark }}>
          Possible missed meal log
        </Text>
      </View>
      <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.amberDark, lineHeight: 20 }}>
        {summary} If you ate or took insulin, please log it. A rise can have other causes.
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Pressable
          onPress={() => open({ mode: 'meal' })}
          accessibilityRole="button"
          accessibilityLabel="Log a meal"
          style={({ pressed }) => [{ minHeight: touch.min, paddingHorizontal: 16, borderRadius: radius.pill, backgroundColor: colors.amberDark, justifyContent: 'center' }, pressed ? { opacity: 0.85 } : null]}
        >
          <Text style={{ ...small, color: colors.amber100 }}>Log meal</Text>
        </Pressable>
        <Pressable
          onPress={() => open({ mode: 'insulin' })}
          accessibilityRole="button"
          accessibilityLabel="Log insulin"
          style={({ pressed }) => [{ minHeight: touch.min, paddingHorizontal: 16, borderRadius: radius.pill, borderWidth: 1.5, borderColor: colors.amberDark, justifyContent: 'center' }, pressed ? { opacity: 0.85 } : null]}
        >
          <Text style={{ ...small, color: colors.amberDark }}>Log insulin</Text>
        </Pressable>
        <Pressable
          onPress={dismiss}
          accessibilityRole="button"
          accessibilityLabel="Not a meal. Hide this for 3 hours"
          style={({ pressed }) => [{ minHeight: touch.min, paddingHorizontal: 12, justifyContent: 'center' }, pressed ? { opacity: 0.85 } : null]}
        >
          <Text style={{ ...small, color: colors.amberDark, textDecorationLine: 'underline' }}>Not a meal</Text>
        </Pressable>
      </View>
    </View>
  );
}
