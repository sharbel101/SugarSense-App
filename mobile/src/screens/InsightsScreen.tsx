import { useFocusEffect } from '@react-navigation/native';
import React, { useCallback } from 'react';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Insight } from '../api/insightsContract';
import { Avatar } from '../components/Avatar';
import { SecondaryButton } from '../components/Buttons';
import { Card } from '../components/Card';
import { Icon, type IconName } from '../components/Icon';
import { PullToRefreshScrollView } from '../components/PullToRefreshScrollView';
import { useTabScreenBottomPadding } from '../components/QuickAdd';
import { TabScreenProps } from '../navigation/types';
import { formatAge, formatClock } from '../services/glucoseState';
import { useInsights } from '../services/InsightsProvider';
import { spacing, useColors } from '../theme';

/** Neutral icons only: nothing here is an alert. Unknown categories get the generic sparkle. */
const CATEGORY_ICON: Record<string, IconName> = {
  episode_digest: 'activity',
  episode_context: 'activity',
  episode_time_pattern: 'activity',
  meal_response: 'fork',
  recurring_meal_response: 'fork',
  forecast_outlook: 'trending',
  previous_day_context: 'activity',
  data_quality: 'info',
  data_availability: 'info',
  exercise_association: 'heart',
  sleep_association: 'moon',
  insulin_timing_association: 'droplet',
};

const TRIGGER_LABEL = { morning: 'Morning briefing', evening: 'Evening recap', event: 'Just now' } as const;

const body = { fontFamily: 'Manrope_500Medium', fontSize: 14, lineHeight: 21 } as const;

export function InsightsScreen({ navigation }: TabScreenProps<'Insights'>) {
  const colors = useColors();
  const bottomPad = useTabScreenBottomPadding();
  const { view, refresh, refreshing, load } = useInsights();

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const updated = view.kind === 'ok' ? updatedText(view.generatedAt ?? (view.fetchedAtMs ? new Date(view.fetchedAtMs).toISOString() : null)) : null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ground }} edges={['top']}>
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.lg, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 22, color: colors.ink }}>
          Insights
        </Text>
        <Avatar onPress={() => navigation.navigate('Profile')} />
      </View>
      <Text style={{ paddingHorizontal: spacing.xl, marginTop: 6, fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink3 }}>
        What SugarSense is learning about you
      </Text>

      <PullToRefreshScrollView
        onRefresh={refresh}
        refreshing={refreshing}
        contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: bottomPad, gap: 14 }}
      >
        {view.kind === 'loading' ? (
          <Card>
            <View aria-busy accessibilityLabel="Loading insights" style={{ gap: 6 }}>
              <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>Loading insights…</Text>
              <Text style={{ ...body, color: colors.ink2 }}>Fetching your latest insights.</Text>
            </View>
          </Card>
        ) : null}

        {view.kind === 'ok' ? (
          <>
            <Text style={{ ...body, color: view.refreshFailed ? colors.amberDark : colors.ink3, fontFamily: view.refreshFailed ? 'Manrope_600SemiBold' : 'Manrope_500Medium' }}>
              {view.refreshFailed ? `Couldn't refresh, showing the last update from ${updated ?? 'earlier'}` : updated ? `Updated ${updated}` : ''}
            </Text>
            {view.insights.map((insight, i) => (
              <InsightCard key={insight.id || String(i)} insight={insight} />
            ))}
            {view.notice ? <Text style={{ ...body, color: colors.ink3 }}>{view.notice}</Text> : null}
          </>
        ) : null}

        {view.kind === 'empty' ? (
          <>
            <StateCard
              title={view.reason === 'not_generated_yet' ? 'No insights yet' : 'No current insights'}
              text={
                view.reason === 'not_generated_yet'
                  ? 'Your first insights will appear once SugarSense has a day of your data.'
                  : 'No current insights. New ones arrive with your morning briefing and evening recap.'
              }
            />
            {view.refreshFailed ? <Text style={{ ...body, color: colors.amberDark }}>Couldn&apos;t refresh just now.</Text> : null}
            {view.notice ? <Text style={{ ...body, color: colors.ink3 }}>{view.notice}</Text> : null}
          </>
        ) : null}

        {view.kind === 'unavailable' ? (
          <StateCard title="Insights aren't available right now." text="Pull down to try again, or tap Retry." onRetry={refresh} retrying={refreshing} />
        ) : null}

        {view.kind === 'offline' ? (
          <StateCard title="You're offline" text="Insights need a connection. Check it and try again." onRetry={refresh} retrying={refreshing} />
        ) : null}
      </PullToRefreshScrollView>
    </SafeAreaView>
  );
}

function updatedText(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return formatAge(Math.max(0, Math.round((Date.now() - ms) / 60000)));
}

function StateCard({ title, text, onRetry, retrying }: { title: string; text: string; onRetry?: () => void; retrying?: boolean }) {
  const colors = useColors();
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: colors.purple100, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="sparkle" size={16} color={colors.purple600} />
        </View>
        <Text accessibilityRole="header" style={{ flex: 1, fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>
          {title}
        </Text>
      </View>
      <Text style={{ ...body, color: colors.ink2 }}>{text}</Text>
      {onRetry ? (
        <View style={{ marginTop: 12 }}>
          <SecondaryButton label={retrying ? 'Retrying…' : 'Retry'} onPress={onRetry} disabled={retrying} />
        </View>
      ) : null}
    </Card>
  );
}

/** One insight, read as headline, facts, explanation, limitations. Facts are shown as received. */
const InsightCard = React.memo(function InsightCard({ insight }: { insight: Insight }) {
  const colors = useColors();
  const icon = CATEGORY_ICON[insight.category] ?? 'sparkle';
  const when = insight.createdAt ? formatClock(insight.createdAt) : '';
  const meta = [insight.trigger ? TRIGGER_LABEL[insight.trigger] : null, when || null].filter(Boolean).join(' · ');
  const label = [insight.headline, ...insight.facts, insight.explanation, ...insight.limitations].filter(Boolean).join('. ');
  return (
    <Card>
      <View accessible accessibilityLabel={label} style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: colors.purple100, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={icon} size={16} color={colors.purple600} />
          </View>
          <Text accessibilityRole="header" style={{ flex: 1, fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.ink }}>
            {insight.headline}
          </Text>
        </View>
        {insight.facts.map((f, i) => (
          <Text key={i} style={{ ...body, color: colors.ink }}>
            {f}
          </Text>
        ))}
        {insight.explanation ? (
          <View style={{ gap: 2 }}>
            <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 13, color: colors.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>In plain words</Text>
            <Text style={{ ...body, color: colors.ink2 }}>{insight.explanation}</Text>
          </View>
        ) : null}
        {insight.limitations.length > 0 ? (
          <View style={{ gap: 2 }}>
            <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 13, color: colors.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>What this can&apos;t tell you</Text>
            {insight.limitations.map((l, i) => (
              <Text key={i} style={{ ...body, color: colors.ink2 }}>
                {l}
              </Text>
            ))}
          </View>
        ) : null}
        {meta ? <Text style={{ ...body, color: colors.ink3 }}>{meta}</Text> : null}
      </View>
    </Card>
  );
});
