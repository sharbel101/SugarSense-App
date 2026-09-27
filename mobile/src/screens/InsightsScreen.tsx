import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar } from '../components/Avatar';
import { Card } from '../components/Card';
import { GhostButton } from '../components/Buttons';
import { Icon } from '../components/Icon';
import { insights } from '../data/mockData';
import { TabScreenProps } from '../navigation/types';
import { spacing, useColors } from '../theme';

export function InsightsScreen({ navigation }: TabScreenProps<'Insights'>) {
  const colors = useColors();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ground }} edges={['top']}>
      <View
        style={{
          paddingHorizontal: spacing.xl,
          paddingTop: spacing.lg,
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 22, color: colors.ink }}>
          Insights
        </Text>
        <Avatar onPress={() => navigation.navigate('Profile')} />
      </View>
      <Text style={{ paddingHorizontal: spacing.xl, marginTop: 6, fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink3 }}>
        What SugarSense is learning about you
      </Text>

      <ScrollView contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.xxxl, gap: 14 }}>
        {insights.map((item) => (
          <Card key={item.title}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: colors.purple100, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="sparkle" size={16} color={colors.purple600} />
              </View>
              <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>{item.title}</Text>
            </View>
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 21 }}>{item.text}</Text>
            <GhostButton
              label="Why am I seeing this?"
              onPress={() => {}}
              icon={<Icon name="chevronRight" size={13} color={colors.blue600} />}
            />
          </Card>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
