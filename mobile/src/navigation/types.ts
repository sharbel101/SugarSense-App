import { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { CompositeScreenProps, NavigatorScreenParams } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { CapturedPhoto } from '../api/mealsApi';
import { ConfirmedMeal } from '../services/mealService';
import type { MealRef } from '../services/mealRefs';

export type ScanStackParamList = {
  Camera: undefined;
  MealReview: { photo: CapturedPhoto };
  PostMeal: { meal: ConfirmedMeal; mealRef: MealRef; forecastNote?: string | null };
};

export type TabParamList = {
  Home: undefined;
  /** `showGraph`: any new number scrolls the page to the insulin / carbs wear-off graph. */
  Predict: { showGraph?: number } | undefined;
  Scan: NavigatorScreenParams<ScanStackParamList>;
  Safety: undefined;
  Insights: undefined;
};

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList>;
  Profile: undefined;
  InsulinSettings: undefined;
  MealHistory: undefined;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}

export type TabScreenProps<T extends keyof TabParamList> = CompositeScreenProps<
  BottomTabScreenProps<TabParamList, T>,
  NativeStackScreenProps<RootStackParamList>
>;

export type ScanScreenProps<T extends keyof ScanStackParamList> = CompositeScreenProps<
  NativeStackScreenProps<ScanStackParamList, T>,
  TabScreenProps<'Scan'>
>;
