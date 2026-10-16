import React from 'react';
import Svg, { Circle, Line, Path, Polyline, Rect } from 'react-native-svg';
import { useColors } from '../theme';

export type IconName =
  | 'home'
  | 'trending'
  | 'camera'
  | 'shield'
  | 'sparkle'
  | 'chevronRight'
  | 'chevronDown'
  | 'back'
  | 'check'
  | 'alertTriangle'
  | 'gallery'
  | 'edit'
  | 'heart'
  | 'activity'
  | 'battery'
  | 'plus'
  | 'bell'
  | 'lock'
  | 'download'
  | 'target'
  | 'droplet'
  | 'fork'
  | 'person'
  | 'info'
  | 'close'
  | 'trash'
  | 'flash'
  | 'flipCamera'
  | 'refresh'
  | 'trendUp'
  | 'trendDown'
  | 'wifi';

type Props = {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
};

export function Icon({ name, size = 24, color: colorProp, strokeWidth = 1.8 }: Props) {
  const colors = useColors();
  const color = colorProp ?? colors.ink;
  const common = {
    fill: 'none' as const,
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  switch (name) {
    case 'home':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M4 11.5 12 4l8 7.5" {...common} />
          <Path d="M6 10v9a1 1 0 0 0 1 1h4v-6h2v6h4a1 1 0 0 0 1-1v-9" {...common} />
        </Svg>
      );
    case 'trending':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Polyline points="4 17 10 11 14 15 20 7" {...common} />
          <Polyline points="15 7 20 7 20 12" {...common} />
        </Svg>
      );
    case 'camera':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path
            d="M4 8a2 2 0 0 1 2-2h2l1.2-1.6A1 1 0 0 1 10 4h4a1 1 0 0 1 .8.4L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8z"
            {...common}
          />
          <Circle cx={12} cy={13} r={3.3} {...common} />
        </Svg>
      );
    case 'shield':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M12 3.5 19 6.5v5c0 5-3 8.3-7 9.5-4-1.2-7-4.5-7-9.5v-5z" {...common} />
        </Svg>
      );
    case 'sparkle':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path
            d="M12 3c.6 3.4 1.8 4.6 5.2 5.2-3.4.6-4.6 1.8-5.2 5.2-.6-3.4-1.8-4.6-5.2-5.2C10.2 7.6 11.4 6.4 12 3z"
            fill={color}
            stroke="none"
          />
          <Path
            d="M18.5 15c.3 1.7.9 2.3 2.6 2.6-1.7.3-2.3.9-2.6 2.6-.3-1.7-.9-2.3-2.6-2.6 1.7-.3 2.3-.9 2.6-2.6z"
            fill={color}
            stroke="none"
          />
        </Svg>
      );
    case 'chevronRight':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Polyline points="9 6 15 12 9 18" {...common} strokeWidth={2} />
        </Svg>
      );
    case 'chevronDown':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Polyline points="6 9 12 15 18 9" {...common} strokeWidth={2.2} />
        </Svg>
      );
    case 'back':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Polyline points="15 6 9 12 15 18" {...common} strokeWidth={2} />
        </Svg>
      );
    case 'check':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Polyline points="5 13 9 17 19 7" {...common} strokeWidth={2.4} />
        </Svg>
      );
    case 'alertTriangle':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M12 3.5 21.5 20h-19z" {...common} />
          <Line x1={12} y1={9.5} x2={12} y2={14} {...common} />
          <Circle cx={12} cy={17} r={0.9} fill={color} stroke="none" />
        </Svg>
      );
    case 'gallery':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Rect x={3} y={5} width={18} height={14} rx={2} {...common} />
          <Circle cx={8.5} cy={10} r={1.6} {...common} />
          <Path d="M4 17l5-5 3.5 3.5L16 12l4 5" {...common} />
        </Svg>
      );
    case 'edit':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M4 20h4l10-10-4-4L4 16z" {...common} />
        </Svg>
      );
    case 'heart':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" {...common} />
        </Svg>
      );
    case 'activity':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Polyline points="3 12 7 12 9 6 13 18 15 12 21 12" {...common} />
        </Svg>
      );
    case 'battery':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Rect x={2} y={9} width={17} height={7} rx={1.5} {...common} />
          <Rect x={20} y={11} width={2} height={3} fill={color} stroke="none" />
        </Svg>
      );
    case 'plus':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Line x1={12} y1={5} x2={12} y2={19} {...common} />
          <Line x1={5} y1={12} x2={19} y2={12} {...common} />
        </Svg>
      );
    case 'bell':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z" {...common} />
          <Path d="M9.5 19a2.5 2.5 0 0 0 5 0" {...common} />
        </Svg>
      );
    case 'lock':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Rect x={5} y={11} width={14} height={9} rx={2} {...common} />
          <Path d="M8 11V8a4 4 0 0 1 8 0v3" {...common} />
        </Svg>
      );
    case 'download':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M12 3v12" {...common} />
          <Polyline points="7 10 12 15 17 10" {...common} />
          <Line x1={5} y1={20} x2={19} y2={20} {...common} />
        </Svg>
      );
    case 'target':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Circle cx={12} cy={12} r={8} {...common} />
          <Circle cx={12} cy={12} r={4} {...common} />
        </Svg>
      );
    case 'droplet':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z" {...common} />
        </Svg>
      );
    case 'fork':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Line x1={7} y1={3} x2={7} y2={12} {...common} />
          <Line x1={5} y1={3} x2={5} y2={8} {...common} />
          <Line x1={9} y1={3} x2={9} y2={8} {...common} />
          <Line x1={7} y1={12} x2={7} y2={21} {...common} />
          <Path d="M16 3c-1.4 0-2.4 1.7-2.4 3.9 0 1.8.7 3.3 1.6 3.8v10.3" {...common} />
        </Svg>
      );
    case 'person':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Circle cx={12} cy={8} r={3.2} {...common} />
          <Path d="M5 20c0-3.9 3.1-6.5 7-6.5s7 2.6 7 6.5" {...common} />
        </Svg>
      );
    case 'info':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Circle cx={12} cy={12} r={9} {...common} />
          <Line x1={12} y1={11} x2={12} y2={16} {...common} />
          <Circle cx={12} cy={7.5} r={0.9} fill={color} stroke="none" />
        </Svg>
      );
    case 'trash':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M4 7h16" {...common} />
          <Path d="M9 7V4h6v3" {...common} />
          <Path d="M6 7l1 13h10l1-13" {...common} />
          <Line x1={10} y1={11} x2={10} y2={16} {...common} />
          <Line x1={14} y1={11} x2={14} y2={16} {...common} />
        </Svg>
      );
    case 'close':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Line x1={6} y1={6} x2={18} y2={18} {...common} strokeWidth={2} />
          <Line x1={18} y1={6} x2={6} y2={18} {...common} strokeWidth={2} />
        </Svg>
      );
    case 'flash':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M13 3 5 14h6l-1 7 9-12h-6z" {...common} />
        </Svg>
      );
    case 'flipCamera':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M4 9a8 8 0 0 1 13.5-4.5M20 15a8 8 0 0 1-13.5 4.5" {...common} />
          <Polyline points="17 3 17.5 4.5 16 5" {...common} />
          <Polyline points="7 21 6.5 19.5 8 19" {...common} />
        </Svg>
      );
    case 'refresh':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M4 11a8 8 0 0 1 14-5.3M20 13a8 8 0 0 1-14 5.3" {...common} />
          <Polyline points="17.5 3.5 18 6.2 15.3 6.5" {...common} />
          <Polyline points="6.5 20.5 6 17.8 8.7 17.5" {...common} />
        </Svg>
      );
    case 'trendUp':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Line x1={5} y1={18} x2={17} y2={6} {...common} strokeWidth={2.2} />
          <Polyline points="9 6 17 6 17 14" {...common} strokeWidth={2.2} />
        </Svg>
      );
    case 'trendDown':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Line x1={5} y1={6} x2={17} y2={18} {...common} strokeWidth={2.2} />
          <Polyline points="9 18 17 18 17 10" {...common} strokeWidth={2.2} />
        </Svg>
      );
    case 'wifi':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M4 16a11 11 0 0 1 16 0" {...common} />
          <Path d="M7.5 19a6.5 6.5 0 0 1 9 0" {...common} />
          <Circle cx={12} cy={21} r={1} fill={color} stroke="none" />
        </Svg>
      );
    default:
      return null;
  }
}
