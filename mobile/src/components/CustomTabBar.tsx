import { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import React, { useMemo } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { beginCapture } from '../services/captureMeal';
import { shadow, useColors, withAlpha } from '../theme';
import { Icon, IconName } from './Icon';

const TAB_META: Record<string, { label: string; icon: IconName }> = {
  Home: { label: 'Home', icon: 'home' },
  Wearable: { label: 'Wearable', icon: 'watch' },
  Scan: { label: 'Scan', icon: 'camera' },
  Safety: { label: 'Safety', icon: 'shield' },
  Insights: { label: 'Insights', icon: 'sparkle' },
};

// Scan is the raised action in the notch, not a regular tab.
const ACTION_ROUTE = 'Scan';

const SIDE_MARGIN = 16;
const MAX_BAR_WIDTH = 440;
const BAR_HEIGHT = 72;

const FAB_SIZE = 54;
const NOTCH_RADIUS = 41; // FAB radius + a 14 dp gap
const NOTCH_DROP = 6; // how far the notch circle's centre sits below the bar's top edge
const FILLET = NOTCH_DROP; // rounding where the notch meets the top edge (see barPath)
const NOTCH_ZONE = 2 * (NOTCH_RADIUS + FILLET); // horizontal space reserved in the tab row
const FAB_OVERHANG = FAB_SIZE / 2 - NOTCH_DROP; // how far the FAB rises above the bar
const FAB_TOP = 6; // breathing room above the FAB
const CAPSULE_INSET = 5; // gap between the active capsule and the pill's edge

// Soft drop shadow, drawn as stacked strokes of the bar outline. Shadow style
// props can't follow the notch (and Android elevation ignores it), so this is
// what keeps the notch edge shaded identically on iOS, Android and web.
const SHADOW_COLOR = '#10214D';
const SHADOW_PEAK = 0.12; // opacity right at the bar's edge
const SHADOW_REACH = 26;
const SHADOW_DY = 6;
const SHADOW_STEPS = 12;
const CANVAS_PAD = SHADOW_REACH + SHADOW_DY; // keeps the blur from being clipped

// Layer k's stroke reaches k/SHADOW_STEPS of the way out, so the layers that
// cover a band sum to a quadratic fall-off from SHADOW_PEAK to nothing.
const SHADOW_LAYERS = Array.from({ length: SHADOW_STEPS }, (_, i) => {
  const k = i + 1;
  const alphaAt = (n: number) => SHADOW_PEAK * (1 - (n - 0.5) / SHADOW_STEPS) ** 2;
  const outerAlpha = k === SHADOW_STEPS ? 0 : alphaAt(k + 1);
  return {
    strokeWidth: (2 * k * SHADOW_REACH) / SHADOW_STEPS,
    opacity: 1 - (1 - alphaAt(k)) / (1 - outerAlpha),
  };
});

/**
 * Pill outline with a circular notch cut into the top edge, centred. The
 * fillets share the notch circle's centre height, which keeps every arc a
 * clean quarter or half circle. Offset by (ox, oy) so it can be drawn inside
 * the padded shadow canvas.
 */
function barPath(width: number, ox: number, oy: number) {
  const r = BAR_HEIGHT / 2;
  const left = ox;
  const right = ox + width;
  const top = oy;
  const bottom = oy + BAR_HEIGHT;
  const cx = ox + width / 2;
  const seat = oy + NOTCH_DROP;
  const outer = NOTCH_RADIUS + FILLET;
  return [
    `M ${left + r} ${top}`,
    `H ${cx - outer}`,
    `A ${FILLET} ${FILLET} 0 0 1 ${cx - NOTCH_RADIUS} ${seat}`,
    `A ${NOTCH_RADIUS} ${NOTCH_RADIUS} 0 0 0 ${cx + NOTCH_RADIUS} ${seat}`,
    `A ${FILLET} ${FILLET} 0 0 1 ${cx + outer} ${top}`,
    `H ${right - r}`,
    `A ${r} ${r} 0 0 1 ${right - r} ${bottom}`,
    `H ${left + r}`,
    `A ${r} ${r} 0 0 1 ${left + r} ${top}`,
    'Z',
  ].join(' ');
}

/**
 * Floating bottom navigation matching the SugarSense design: a white pill
 * with four destinations either side of a circular notch that cradles the
 * raised Scan action. The active destination sits on a lifted white capsule.
 */
export function CustomTabBar({ state, navigation }: BottomTabBarProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const barWidth = Math.min(screenWidth - SIDE_MARGIN * 2, MAX_BAR_WIDTH);

  const surfacePath = useMemo(() => barPath(barWidth, CANVAS_PAD, CANVAS_PAD), [barWidth]);
  const shadowPath = useMemo(() => barPath(barWidth, CANVAS_PAD, CANVAS_PAD + SHADOW_DY), [barWidth]);

  const press = (routeKey: string, routeName: string, isFocused: boolean) => {
    const event = navigation.emit({ type: 'tabPress', target: routeKey, canPreventDefault: true });
    if (!isFocused && !event.defaultPrevented) {
      navigation.navigate(routeName);
    }
  };

  const actionRoute = state.routes.find((route) => route.name === ACTION_ROUTE);
  const actionFocused = actionRoute ? state.routes[state.index].key === actionRoute.key : false;

  return (
    <View
      style={{
        backgroundColor: colors.ground,
        alignItems: 'center',
        paddingTop: FAB_OVERHANG + FAB_TOP,
        paddingBottom: Math.max(insets.bottom, 12),
        paddingHorizontal: SIDE_MARGIN,
      }}
    >
      <View style={{ width: barWidth, height: BAR_HEIGHT }}>
        <Svg
          width={barWidth + CANVAS_PAD * 2}
          height={BAR_HEIGHT + CANVAS_PAD * 2}
          style={{ position: 'absolute', left: -CANVAS_PAD, top: -CANVAS_PAD, pointerEvents: 'none' }}
        >
          {SHADOW_LAYERS.map((layer) => (
            <Path
              key={layer.strokeWidth}
              d={shadowPath}
              fill="none"
              stroke={SHADOW_COLOR}
              strokeOpacity={layer.opacity}
              strokeWidth={layer.strokeWidth}
            />
          ))}
          <Path d={surfacePath} fill={colors.surface} />
        </Svg>

        <View
          accessibilityRole="tablist"
          style={{ flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: CAPSULE_INSET }}
        >
          {state.routes.map((route, index) => {
            if (route.name === ACTION_ROUTE) {
              return <View key={route.key} style={{ width: NOTCH_ZONE }} />;
            }

            const isFocused = state.index === index;
            const meta = TAB_META[route.name] ?? { label: route.name, icon: 'home' as IconName };

            return (
              <Pressable
                key={route.key}
                onPress={() => press(route.key, route.name, isFocused)}
                accessibilityRole="tab"
                aria-selected={isFocused}
                accessibilityLabel={meta.label}
                style={({ pressed }) => [
                  { flex: 1, height: BAR_HEIGHT, alignItems: 'center', justifyContent: 'center' },
                  pressed && !isFocused ? { opacity: 0.6 } : null,
                ]}
              >
                {isFocused ? (
                  <View
                    style={[
                      {
                        position: 'absolute',
                        top: CAPSULE_INSET,
                        bottom: CAPSULE_INSET,
                        left: 1,
                        right: 1,
                        borderRadius: 999,
                        backgroundColor: colors.surfaceRaised,
                      },
                      shadow.lift,
                    ]}
                  />
                ) : null}
                {/* Wrapped in a View so it stacks above the capsule on web, where the
                    icon is a bare <svg> that would otherwise paint underneath it. */}
                <View style={{ alignItems: 'center', gap: 3 }}>
                  <Icon
                    name={meta.icon}
                    size={24}
                    color={isFocused ? colors.blue600 : colors.ink}
                    strokeWidth={isFocused ? 2.2 : 2}
                  />
                  <Text
                    numberOfLines={1}
                    maxFontSizeMultiplier={1.2}
                    style={{
                      fontFamily: isFocused ? 'Manrope_700Bold' : 'Manrope_600SemiBold',
                      fontSize: 11,
                      color: isFocused ? colors.blue600 : colors.ink,
                      ...(isFocused
                        ? {
                            textShadowColor: withAlpha(colors.blue600, 0.35),
                            textShadowOffset: { width: 0, height: 0 },
                            textShadowRadius: 8,
                          }
                        : null),
                    }}
                  >
                    {meta.label}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>

      {actionRoute ? (
        <View
          style={{ position: 'absolute', top: FAB_TOP, left: 0, right: 0, alignItems: 'center', pointerEvents: 'box-none' }}
        >
          <Pressable
            onPress={() => {
              // Open the camera right here, inside the tap: a phone browser only allows it from the tap itself.
              const here = state.routes[state.index].name;
              beginCapture('camera', { returnTab: here === ACTION_ROUTE ? 'Home' : here, returnOnCancel: true });
              press(actionRoute.key, actionRoute.name, actionFocused);
            }}
            accessibilityRole="button"
            accessibilityLabel="Scan a meal"
            style={({ pressed }) => [
              {
                width: FAB_SIZE,
                height: FAB_SIZE,
                borderRadius: FAB_SIZE / 2,
                backgroundColor: colors.blue600,
                alignItems: 'center',
                justifyContent: 'center',
              },
              shadow.fab,
              pressed ? { opacity: 0.9 } : null,
            ]}
          >
            <Icon name="camera" size={24} color={colors.onBlue} strokeWidth={1.8} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
