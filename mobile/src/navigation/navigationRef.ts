import { createNavigationContainerRef } from '@react-navigation/native';

/**
 * One navigation ref for the whole app, so UI that lives outside the navigators (the add sheet,
 * rendered by QuickAddProvider) can still send the person somewhere.
 */
export const navRef = createNavigationContainerRef();

export function goToScan(): void {
  if (navRef.isReady()) (navRef.navigate as (...a: unknown[]) => void)('Tabs', { screen: 'Scan', params: { screen: 'Camera' } });
}

export function goToInsulinSettings(): void {
  if (navRef.isReady()) (navRef.navigate as (...a: unknown[]) => void)('InsulinSettings');
}
