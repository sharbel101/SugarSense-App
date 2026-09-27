import React from 'react';
import { useColors } from '../theme';
import { IconButton } from './Buttons';
import { Icon } from './Icon';

export function Avatar({ onPress }: { onPress: () => void }) {
  const colors = useColors();
  return (
    <IconButton onPress={onPress} bg={colors.blue100} size={40} edge="end" accessibilityLabel="Profile and settings">
      <Icon name="person" size={20} color={colors.blue600} />
    </IconButton>
  );
}
