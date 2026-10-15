import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, RefreshControl, ScrollView, ScrollViewProps, View } from 'react-native';
import {
  PULL_IDLE,
  PULL_TRIGGER,
  WHEEL_IDLE,
  WHEEL_IDLE_MS,
  pullEnd,
  pullMove,
  pullProgress,
  pullStart,
  wheelPull,
  type PullState,
  type WheelPullState,
} from '../services/pullToRefresh';
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
 * events (see services/pullToRefresh.ts) and floats a small badge over the list. Three inputs feed
 * it: touch drags (phones), trackpad / wheel pushes up at the top of the list (laptops), and a
 * mouse click-drag (desktop).
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
    let wheel: WheelPullState = WHEEL_IDLE;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let wheelIdleTimer: ReturnType<typeof setTimeout> | null = null;
    let suppressClickUntil = 0;

    const update = (next: PullState) => {
      state = next;
      setPull(next);
    };
    const startRefresh = () => {
      latestOnRefresh.current();
      setHolding(true);
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = setTimeout(() => setHolding(false), MIN_SPINNER_MS);
    };
    const finish = (cancelled: boolean) => {
      const { next, trigger } = pullEnd(state, cancelled);
      update(next);
      if (trigger) startRefresh();
      return trigger;
    };

    // Touch (phones).
    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (touch) update(pullStart(node.scrollTop, touch.clientY));
    };
    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (touch && state.phase === 'pulling') update(pullMove(state, node.scrollTop, touch.clientY));
    };
    const onTouchEnd = () => finish(false);
    const onTouchCancel = () => finish(true);

    // Wheel / trackpad (laptops): pushing up while already at the top.
    const onWheel = (e: WheelEvent) => {
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? node.clientHeight : 1;
      const { next, trigger } = wheelPull(wheel, e.deltaY * unit, node.scrollTop, performance.now());
      wheel = next;
      setPull(next.distance > 0 ? { phase: 'pulling', startY: 0, distance: next.distance } : PULL_IDLE);
      if (wheelIdleTimer) clearTimeout(wheelIdleTimer);
      wheelIdleTimer = setTimeout(() => {
        wheel = WHEEL_IDLE;
        setPull(PULL_IDLE);
      }, WHEEL_IDLE_MS + 40);
      if (trigger) startRefresh();
    };

    // Mouse click-drag (desktop). Touch pointers are left to the touch handlers above.
    const onPointerMove = (e: PointerEvent) => {
      if (state.phase !== 'pulling') return;
      const next = pullMove(state, node.scrollTop, e.clientY);
      if (next.phase === 'pulling' && next.distance > 0) window.getSelection()?.removeAllRanges();
      update(next);
    };
    const endMouseDrag = (cancelled: boolean) => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      // A drag that refreshed must not also "click" the card it happened to end over.
      if (finish(cancelled)) suppressClickUntil = performance.now() + 350;
    };
    const onPointerUp = () => endMouseDrag(false);
    const onPointerCancel = () => endMouseDrag(true);
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      update(pullStart(node.scrollTop, e.clientY));
      if (state.phase !== 'pulling') return;
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
    };
    const onClickCapture = (e: MouseEvent) => {
      if (performance.now() < suppressClickUntil) {
        e.stopPropagation();
        e.preventDefault();
      }
    };

    node.addEventListener('touchstart', onTouchStart, { passive: true });
    node.addEventListener('touchmove', onTouchMove, { passive: true });
    node.addEventListener('touchend', onTouchEnd, { passive: true });
    node.addEventListener('touchcancel', onTouchCancel, { passive: true });
    node.addEventListener('wheel', onWheel, { passive: true });
    node.addEventListener('pointerdown', onPointerDown);
    node.addEventListener('click', onClickCapture, true);
    return () => {
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', onTouchEnd);
      node.removeEventListener('touchcancel', onTouchCancel);
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('click', onClickCapture, true);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      if (holdTimer) clearTimeout(holdTimer);
      if (wheelIdleTimer) clearTimeout(wheelIdleTimer);
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
