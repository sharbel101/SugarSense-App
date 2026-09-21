import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';
import { CameraScreen } from '../screens/scan/CameraScreen';
import { MealReviewScreen } from '../screens/scan/MealReviewScreen';
import { PostMealScreen } from '../screens/scan/PostMealScreen';
import { ScanStackParamList } from './types';

const Stack = createNativeStackNavigator<ScanStackParamList>();

/**
 * The meal-capture flow lives in its own stack so it can be a focused,
 * immersive experience (camera-first, no bottom nav) while still nesting
 * inside the Scan tab.
 */
export function ScanNavigator() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Camera" component={CameraScreen} />
      <Stack.Screen name="MealReview" component={MealReviewScreen} />
      <Stack.Screen name="PostMeal" component={PostMealScreen} />
    </Stack.Navigator>
  );
}
