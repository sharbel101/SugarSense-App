import { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { CompositeScreenProps, NavigatorScreenParams } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { CapturedPhoto } from '../api/mealsApi';
import { ConfirmedMeal } from '../services/mealService';

export type ScanStackParamList = {
  Camera: undefined;
  MealReview: { photo: CapturedPhoto };
  PostMeal: { meal: ConfirmedMeal };
};

export type TabParamList = {
  Home: undefined;
  Predict: undefined;
  Scan: NavigatorScreenParams<ScanStackParamList>;
  Safety: undefined;
  Insights: undefined;
};

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList>;
  Profile: undefined;
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
