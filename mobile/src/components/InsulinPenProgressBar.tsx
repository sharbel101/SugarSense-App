import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { useReducedMotionPreference } from '../services/reducedMotion';
import { useColors } from '../theme';

/**
 * A tiny pixel-art insulin pen that rides along a progress bar, nose pointed the way it's moving,
 * with a few grey speed-line streaks trailing behind it. Purely a loading-screen flourish for the
 * meal-analysis wait (root CLAUDE.md section 2: this is not a dosing UI - no number or arithmetic
 * is attached to it, only the analysis's own 0-100% progress).
 *
 * The body is drawn with a stepped silhouette - a wide cap, a straight cartridge body, then a real
 * step down to a thin ribbed collar and a hair-thin needle - rather than a smooth taper. At this
 * pixel count a shape has to be identifiable by silhouette alone before colour even registers, and
 * a uniform-height capsule reads as generic (dart, rocket, marker) no matter what's painted on it;
 * the needle stepping down out of a wider body is the one silhouette cue those don't have. The
 * trailing effect is plain grey streaks rather than fire for the same reason in reverse: flame
 * behind an elongated capsule reads as a rocket engine regardless of the capsule's own colours.
 *
 * `percent` is a plain controlled prop (0-100) - this component only draws it, it has no opinion
 * on where the number comes from. Today that's `useSimulatedProgress` (see simulatedProgress.ts),
 * since the backend has no real progress signal to report; if one ever exists, it plugs in here
 * unchanged.
 *
 * Drawn as `react-native-svg` rects at final display size (the same technique as PixelMascot) so
 * the sprite never gets scaled/blurred - only its horizontal position changes, never its size.
 */

const CELL = 4; // one voxel, in on-screen dp

// The pen body, needle at the right - the direction of travel. Legend: C cap, N neck, W dose
// window, w window tick, D cartridge shaft, B barrel, b barrel graduation tick, H/h ribbed collar
// (two shades for texture), T needle taper, P needle point. 18 cols x 7 rows.
const PEN_ROWS = [
  '..................',
  '.CC...............',
  'CCCNWWWDDDBbB.....',
  'CCCNWwWDDDBBBHhTTP',
  'CCCNWWWDDDBBB.....',
  '.CC...............',
  '..................',
];
const PEN_COLS = 18;
const PEN_ROWS_COUNT = PEN_ROWS.length;

const PEN_COLORS: Record<string, string> = {
  C: '#E8963C', // cap - same amber as the barrel, matching a real pen's colour-matched cap/cartridge
  N: '#3A3A3A', // neck
  W: '#FFFFFF', // dose window
  w: '#E8963C', // dose window indicator tick
  D: '#4A4A4A', // dark cartridge shaft
  B: '#E8963C', // barrel (the insulin itself)
  b: '#3A3A3A', // barrel graduation tick
  H: '#7A7A7A', // ribbed collar, shade 1
  h: '#5A5A5A', // ribbed collar, shade 2
  T: '#8A8A8A', // needle taper
  P: '#1A1A1A', // needle point
};

// Grey speed-line streaks trailing the pen's rear - not fire. 2 frames (longer/shorter) for a
// subtle pulse, never resized, only swapped, same hard-cut principle as PixelMascot's poses.
const TRAIL_FRAMES: string[][] = [
  ['..SSS', '.....', 'SSSSS', '.....', '..SSS'],
  ['...SS', '.....', '.SSSS', '.....', '...SS'],
];
const TRAIL_COLS = 5;
const TRAIL_ROWS = 5;
const TRAIL_COLORS: Record<string, string> = {
  S: '#9CA3AF',
};

const GAP = CELL; // space between the trail and the pen's rear
const SPRITE_W = TRAIL_COLS * CELL + GAP + PEN_COLS * CELL;
const SPRITE_H = Math.max(PEN_ROWS_COUNT, TRAIL_ROWS) * CELL;
const BAR_HEIGHT = 12; // "slightly thicker than a typical minimal bar", still compact

function Grid({ rows, colors, originX }: { rows: string[]; colors: Record<string, string>; originX: number }) {
  const cells: React.ReactNode[] = [];
  rows.forEach((row, rowIndex) => {
    for (let col = 0; col < row.length; col++) {
      const fill = colors[row[col]];
      if (!fill) continue;
      cells.push(<Rect key={`${rowIndex}-${col}`} x={originX + col * CELL} y={rowIndex * CELL} width={CELL} height={CELL} fill={fill} />);
    }
  });
  return <>{cells}</>;
}

export function InsulinPenProgressBar({ percent, height = BAR_HEIGHT }: { percent: number; height?: number }) {
  const colors = useColors();
  const reducedMotion = useReducedMotionPreference();
  const [trackWidth, setTrackWidth] = useState(240);
  const [trailFrame, setTrailFrame] = useState(0);

  useEffect(() => {
    if (reducedMotion) return; // freeze on the first frame - static streaks, not decoration in motion
    const id = setInterval(() => setTrailFrame((f) => (f + 1) % TRAIL_FRAMES.length), 140);
    return () => clearInterval(id);
  }, [reducedMotion]);

  const clamped = Math.max(0, Math.min(100, percent));
  const travel = Math.max(trackWidth - SPRITE_W, 0);
  const spriteX = (clamped / 100) * travel;
  const containerHeight = Math.max(height, SPRITE_H);
  const trailOriginX = 0;
  const penOriginX = TRAIL_COLS * CELL + GAP;

  return (
    <View
      style={{ width: '100%', height: containerHeight, justifyContent: 'center' }}
      onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
      accessibilityRole="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      accessibilityLabel="Analyzing your meal"
    >
      <View
        style={{
          height,
          borderRadius: height / 2,
          backgroundColor: colors.divider,
          borderWidth: 1,
          borderColor: colors.border,
          overflow: 'hidden',
        }}
      >
        <View style={{ height: '100%', width: `${clamped}%`, backgroundColor: colors.blue600, borderRadius: height / 2 }} />
      </View>

      <View
        style={{ position: 'absolute', left: spriteX, top: 0, bottom: 0, width: SPRITE_W, justifyContent: 'center' }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Svg width={SPRITE_W} height={SPRITE_H} viewBox={`0 0 ${SPRITE_W} ${SPRITE_H}`}>
          <Grid rows={TRAIL_FRAMES[trailFrame]} colors={TRAIL_COLORS} originX={trailOriginX} />
          <Grid rows={PEN_ROWS} colors={PEN_COLORS} originX={penOriginX} />
        </Svg>
      </View>
    </View>
  );
}
