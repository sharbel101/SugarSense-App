import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Ellipse } from 'react-native-svg';
import { PrimaryButton, SecondaryButton } from '../../components/Buttons';
import { Card } from '../../components/Card';
import { Chip } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { carbEstimate, detectedItems } from '../../data/mockData';
import { ScanScreenProps } from '../../navigation/types';
import { colors, radius, spacing } from '../../theme';

export function MealReviewScreen({ navigation }: ScanScreenProps<'MealReview'>) {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ground }}>
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Pressable
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back to camera"
          style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="back" size={16} color={colors.ink} />
        </Pressable>
        <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 19, color: colors.ink }}>Meal review</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.xxxl, gap: 16 }}>
        <View style={{ height: 190, borderRadius: 22, backgroundColor: colors.divider, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' }}>
          <Svg width="100%" height="100%" viewBox="0 0 350 190">
            <Ellipse cx={175} cy={110} rx={120} ry={62} fill="#FBF8F2" stroke="#E7E1D3" strokeWidth={2} />
            <Ellipse cx={140} cy={118} rx={52} ry={26} fill="#F3ECD9" />
            <Ellipse cx={215} cy={100} rx={46} ry={30} fill="#D9A66B" />
            <Ellipse cx={222} cy={132} rx={30} ry={14} fill="#E9E0C8" />
            <Ellipse cx={112} cy={88} rx={20} ry={12} fill="#5FA777" />
            <Ellipse cx={95} cy={105} rx={16} ry={10} fill="#79BE8E" />
            <Circle cx={200} cy={118} r={6} fill="#D9772E" />
          </Svg>
          <View style={{ position: 'absolute', left: 14, bottom: 12, backgroundColor: 'rgba(22,33,61,0.55)' }}>
            <Text style={{ color: '#FFFFFF', fontFamily: 'Manrope_600SemiBold', fontSize: 11.5, paddingHorizontal: 10, paddingVertical: 4 }}>
              Captured photo
            </Text>
          </View>
        </View>

        <View>
          <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink, marginBottom: 8 }}>SugarSense detected</Text>
          <View style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.row }}>
            {detectedItems.map((item, index) => (
              <View
                key={item.name}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingHorizontal: 16,
                  paddingVertical: 13,
                  borderBottomWidth: index === detectedItems.length - 1 ? 0 : 1,
                  borderBottomColor: colors.divider,
                }}
              >
                <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14.5, color: colors.ink }}>{item.name}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>{item.carbs}g carbs</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Edit ${item.name}`}
                    style={{ width: 26, height: 26, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Icon name="edit" size={14} color={colors.ink3} />
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        </View>

        <Card>
          <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 13, color: colors.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Estimated carbohydrates
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 6 }}>
            <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 40, color: colors.ink }}>{carbEstimate.grams}g</Text>
            <Chip label={`Confidence: ${carbEstimate.confidence}`} bg={colors.green100} color={colors.green600} />
          </View>
        </Card>

        <View style={{ flexDirection: 'row', gap: 12 }}>
          <SecondaryButton label="Edit" onPress={() => {}} style={{ flex: 1 }} />
          <PrimaryButton label="Confirm" onPress={() => navigation.navigate('PostMeal')} style={{ flex: 1 }} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
