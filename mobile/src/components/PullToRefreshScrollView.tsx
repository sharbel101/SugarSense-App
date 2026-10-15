import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, RefreshControl, ScrollView, ScrollViewProps, View } from 'react-native';
import { PULL_IDLE, PULL_TRIGGER, pullEnd, pullMove, pullProgress, pullStart, type PullState } from '../services/pullToRefresh';
import { useColors } from '../theme';
import { Icon } from './Icon';

type Props = ScrollViewProps & {
  /** Called when the user pulls past the threshold and lets go. */
  onRefresh: () => void;
  /** Keeps the spinner up while the request this pull started is in flight. */
  refreshing: boolean;
};

const BADGE = 40;
/** On a fast connection the request returns in a few ms; keep the spinner long enough to be seen. */
const MIN_SPINNER_MS = 600;

/**
 * A ScrollView you can pull down from the top to refresh.
 *
 * Native uses the platform `RefreshControl`. react-native-web's `RefreshControl` is an empty stub
 * (it drops `refreshing` and `onRefresh`), so the web build recognises the pull itself from touch
 * events (see services/pullToRefresh.ts) and floats a small badge over the list.
 */
export function PullToRefreshScrollView(props: Props) {
  return Platform.OS === 'web' ? <WebPullToRefresh {...props} /> : <NativePullToRefresh {...props} />;
}

function NativePullToRefresh({ onRefresh, refreshing, ...rest }: Props) {
  const colors = useColors();
  return (
    <ScrollView
      {...rest}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.blue600}
          colors={[colors.blue600]}
          progressBackgroundColor={colors.surface}
        />
      }
    />
  );
}

function WebPullToRefresh({ onRefresh, refreshing, style, ...rest }: Props) {
  const colors = useColors();
  const scrollRef = useRef<ScrollView>(null);
  const latestOnRefresh = useRef(onRefresh);
  const [pull, setPull] = useState<PullState>(PULL_IDLE);
  const [holding, setHolding] = useState(false);

  useEffect(() => {
    latestOnRefresh.current = onRefresh;
  });

  useEffect(() => {
    const node = scrollRef.current?.getScrollableNode() as HTMLElement | undefined;
    if (!node) return;

    // Without this, Chrome on Android would reload the whole page on the same downward drag.
    node.style.overscrollBehaviorY = 'contain';

    let state: PullState = PULL_IDLE;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    const update = (next: PullState) => {
      state = next;
      setPull(next);
    };

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (touch) update(pullStart(node.scrollTop, touch.clientY));
    };
    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (touch && state.phase === 'pulling') update(pullMove(state, node.scrollTop, touch.clientY));
    };
    const finish = (cancelled: boolean) => {
      const { next, trigger } = pullEnd(state, cancelled);
      update(next);
      if (!trigger) return;
      latestOnRefresh.current();
      setHolding(true);
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = setTimeout(() => setHolding(false), MIN_SPINNER_MS);
    };
    const onTouchEnd = () => finish(false);
    const onTouchCancel = () => finish(true);

    node.addEventListener('touchstart', onTouchStart, { passive: true });
    node.addEventListener('touchmove', onTouchMove, { passive: true });
    node.addEventListener('touchend', onTouchEnd, { passive: true });
    node.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', onTouchEnd);
      node.removeEventListener('touchcancel', onTouchCancel);
      if (holdTimer) clearTimeout(holdTimer);
    };
  }, []);

  const spinning = refreshing || holding;
  const distance = pull.phase === 'pulling' ? pull.distance : 0;
  const progress = spinning ? 1 : pullProgress(pull);
  const visible = spinning || distance > 0;
  // At rest (spinning) the badge sits exactly where it was when the pull crossed the threshold.
  const translateY = (spinning ? PULL_TRIGGER : distance) - BADGE;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView ref={scrollRef} style={style} {...rest} />
      {visible ? (
        <View
          style={{ position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center', pointerEvents: 'none' }}
          accessibilityElementsHidden={!spinning}
          importantForAccessibility={spinning ? 'auto' : 'no-hide-descendants'}
        >
          <View
            accessibilityLabel={spinning ? 'Refreshing' : undefined}
            style={{
              width: BADGE,
              height: BADGE,
              borderRadius: BADGE / 2,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.border,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: progress,
              transform: [{ translateY }],
            }}
          >
            {spinning ? (
              <ActivityIndicator color={colors.blue600} />
            ) : (
              <View style={{ transform: [{ rotate: `${Math.round(progress * 180)}deg` }] }}>
                <Icon name="refresh" size={20} color={colors.blue600} />
              </View>
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}
