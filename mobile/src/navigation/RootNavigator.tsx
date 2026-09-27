import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React, { useMemo } from 'react';
import { CustomTabBar } from '../components/CustomTabBar';
import { HomeScreen } from '../screens/HomeScreen';
import { InsightsScreen } from '../screens/InsightsScreen';
import { PredictScreen } from '../screens/PredictScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { SafetyScreen } from '../screens/SafetyScreen';
import { useTheme } from '../theme';
import { ScanNavigator } from './ScanNavigator';
import { RootStackParamList, TabParamList } from './types';

const Tab = createBottomTabNavigator<TabParamList>();
const RootStack = createNativeStackNavigator<RootStackParamList>();

function Tabs() {
  return (
    <Tab.Navigator
      screenOptions={{ headerShown: false }}
      tabBar={(props) => {
        // The Scan flow (camera → review → forecast) is a deliberately
        // immersive, nav-free experience — hide the bar for all of it
        // rather than just the camera screen.
        const focusedRoute = props.state.routes[props.state.index];
        if (focusedRoute.name === 'Scan') return null;
        return <CustomTabBar {...props} />;
      }}
      screenListeners={({ navigation, route }) => ({
        tabPress: () => {
          // Re-entering the Scan tab always starts a fresh capture, never a
          // stale meal-review or forecast screen from a previous scan.
          if (route.name === 'Scan') {
            navigation.navigate('Scan', { screen: 'Camera' });
          }
        },
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Predict" component={PredictScreen} />
      <Tab.Screen name="Scan" component={ScanNavigator} />
      <Tab.Screen name="Safety" component={SafetyScreen} />
      <Tab.Screen name="Insights" component={InsightsScreen} />
    </Tab.Navigator>
  );
}

export function RootNavigator() {
  const { isDark, colors } = useTheme();
  // Scene backgrounds and transitions read the navigation theme, so it must follow ours.
  const navTheme = useMemo(() => {
    const base = isDark ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: colors.blue600,
        background: colors.ground,
        card: colors.surface,
        text: colors.ink,
        border: colors.border,
      },
    };
  }, [isDark, colors]);

  return (
    <NavigationContainer theme={navTheme}>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        <RootStack.Screen name="Tabs" component={Tabs} />
        <RootStack.Screen
          name="Profile"
          component={ProfileScreen}
          options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
        />
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
