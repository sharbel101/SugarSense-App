import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { useReducedMotionPreference } from '../services/reducedMotion';
import { ColorPalette, useColors } from '../theme';

/**
 * A tiny voxel/pixel-art SugarSense helper, idling while the meal-photo analysis call is in
 * flight. Drawn as plain `react-native-svg` rects at final display size (no scaling, so nothing
 * gets blurred/anti-aliased the way upscaling a small bitmap would) rather than Lottie or Rive:
 * both need an authored asset (an After Effects export / a .riv file from Rive's own editor)
 * that can't be produced from here, and Rive would also add a new native runtime for one small
 * idle loop. Every "frame" below is a hand-placed grid, and the loop hard-cuts between them on a
 * timer - no easing, no tweening, no continuous interpolation - which is what actually reads as
 * pixel-art (real sprite idles snap between a handful of frames; smoothly interpolating between
 * them is exactly the "AI-smooth" look this was asked not to have).
 */

type Pose = 'idle' | 'breathe' | 'glanceLeft' | 'glanceRight' | 'scan' | 'spark';

/** How long each authored frame holds before hard-cutting to the next. A loop, not a one-shot. */
const SEQUENCE: { pose: Pose; ms: number }[] = [
  { pose: 'idle', ms: 900 },
  { pose: 'breathe', ms: 850 },
  { pose: 'idle', ms: 900 },
  { pose: 'glanceLeft', ms: 550 },
  { pose: 'idle', ms: 800 },
  { pose: 'breathe', ms: 850 },
  { pose: 'glanceRight', ms: 550 },
  { pose: 'idle', ms: 800 },
  { pose: 'scan', ms: 1300 },
  { pose: 'idle', ms: 900 },
  { pose: 'breathe', ms: 850 },
  { pose: 'spark', ms: 450 },
  { pose: 'idle', ms: 1000 },
];

const CELL = 6; // one voxel, in on-screen dp - authored at final size, so nothing gets scaled/blurred
const COLS = 8;
const ROWS = 10;
const BODY_X = 14; // where the body grid sits inside the canvas, leaving room for the accessories
const BODY_Y = 8;
const CANVAS_W = BODY_X + COLS * CELL + 10;
const CANVAS_H = BODY_Y + ROWS * CELL + 8;

// The default stance, read top-to-bottom, left-to-right. '.' is empty. Kept to five colour keys -
// a limited palette on purpose (design direction: "limited color palette", "simple geometric shapes").
const IDLE_ROWS = [
  '..HHHH..',
  '.HHHHHH.',
  '.HEHHEH.',
  '.HHHHHH.',
  '..HHHH..',
  '..BBBB..',
  '.ABBBBA.',
  '.ABBBBA.',
  '..LL.LL.',
  '..LL.LL.',
];
// Eyes shifted one column - a stylised "glance" rather than a literal eye-tracking system, the
// same way a tiny game sprite conveys "looking" with 2-3 pixels, not a rendered gaze direction.
const GLANCE_LEFT_EYE_ROW = '.EHHHH..';
const GLANCE_RIGHT_EYE_ROW = '..HHHHE.';

function paletteFor(colors: ColorPalette): Record<string, string> {
  return {
    H: colors.blue600, // shell / head
    E: colors.onBlue, // eye pixels - bright against the shell
    B: colors.blue700, // torso panel, a shade darker for definition
    A: colors.blue700, // arms
    L: colors.ink3, // feet/base, grounds the sprite visually
  };
}

function BodyGrid({ pose, palette }: { pose: Pose; palette: Record<string, string> }) {
  const rows = IDLE_ROWS.slice();
  if (pose === 'glanceLeft') rows[2] = GLANCE_LEFT_EYE_ROW;
  if (pose === 'glanceRight') rows[2] = GLANCE_RIGHT_EYE_ROW;
  // "breathe": the whole sprite shifts up by exactly one voxel - a hard step, not an eased float.
  const yOffset = pose === 'breathe' ? BODY_Y - CELL : BODY_Y;

  const cells: React.ReactNode[] = [];
  rows.forEach((row, rowIndex) => {
    for (let col = 0; col < row.length; col++) {
      const ch = row[col];
      const fill = palette[ch];
      if (!fill) continue;
      cells.push(
        <Rect key={`${rowIndex}-${col}`} x={BODY_X + col * CELL} y={yOffset + rowIndex * CELL} width={CELL} height={CELL} fill={fill} />,
      );
    }
  });
  return <>{cells}</>;
}

/** A small blocky magnifying glass - a hollow square "lens" plus a short diagonal handle, built
 * from the same flat rects as the body so it matches the same crisp, geometric style. */
function ScanAccessory({ color }: { color: string }) {
  const x = BODY_X + COLS * CELL - CELL; // beside the character's raised arm
  const y = BODY_Y + 3 * CELL;
  const lens: [number, number][] = [
    [0, 0], [1, 0], [2, 0],
    [0, 1], [2, 1],
    [0, 2], [1, 2], [2, 2],
  ];
  return (
    <>
      {lens.map(([cx, cy]) => (
        <Rect key={`lens-${cx}-${cy}`} x={x + cx * CELL} y={y + cy * CELL} width={CELL} height={CELL} fill={color} />
      ))}
      <Rect x={x + 3 * CELL} y={y + 3 * CELL} width={CELL} height={CELL} fill={color} />
    </>
  );
}

export function PixelMascot() {
  const colors = useColors();
  const palette = paletteFor(colors);
  const reducedMotion = useReducedMotionPreference();
  const [poseIndex, setPoseIndex] = useState(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (reducedMotion) return; // static single frame below - no timers at all.
    const advance = () => {
      setPoseIndex((current) => {
        const next = (current + 1) % SEQUENCE.length;
        timeoutRef.current = setTimeout(advance, SEQUENCE[next].ms);
        return next;
      });
    };
    timeoutRef.current = setTimeout(advance, SEQUENCE[poseIndex].ms);
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
    // Runs once on mount (and once more if reducedMotion changes) - the sequence advances itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion]);

  const pose = reducedMotion ? 'idle' : SEQUENCE[poseIndex].pose;

  return (
    <View
      style={{ width: CANVAS_W, height: CANVAS_H, alignItems: 'center', justifyContent: 'center' }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width={CANVAS_W} height={CANVAS_H} viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}>
        <BodyGrid pose={pose} palette={palette} />
        {pose === 'scan' ? <ScanAccessory color={colors.ink3} /> : null}
        {pose === 'spark' ? (
          <Rect x={BODY_X + 3 * CELL} y={BODY_Y - CELL - 2} width={CELL - 1} height={CELL - 1} fill={colors.amber600} />
        ) : null}
      </Svg>
    </View>
  );
}
