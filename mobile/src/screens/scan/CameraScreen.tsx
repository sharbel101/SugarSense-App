import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../../components/Icon';
import { ScanScreenProps } from '../../navigation/types';
import { colors } from '../../theme';

/**
 * Camera-first capture screen. Deliberately minimal and immersive — no
 * bottom nav while the user is mid-capture, matching real camera UX.
 * "Take photo" is wired to the mock analysis flow in MealReviewScreen;
 * swap it for a real camera (e.g. expo-camera) and model call to go further.
 */
export function CameraScreen({ navigation }: ScanScreenProps<'Camera'>) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.camera }}>
      <SafeAreaView style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 8 }}>
          <Pressable
            onPress={() => navigation.getParent()?.navigate('Home')}
            accessibilityRole="button"
            accessibilityLabel="Close scan"
            style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="close" size={17} color="#FFFFFF" />
          </Pressable>
          <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: '#FFFFFF' }}>Scan meal</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Toggle flash"
            style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="flash" size={17} color="#FFFFFF" />
          </Pressable>
        </View>

        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: 270, height: 270, borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)', borderRadius: 28, borderStyle: 'dashed' }} />
          <Text style={{ marginTop: 24, fontFamily: 'Manrope_500Medium', fontSize: 13.5, color: 'rgba(255,255,255,0.72)' }}>
            Center your plate in the frame
          </Text>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 28, paddingBottom: 16 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Choose from gallery"
            style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: colors.cameraSurface, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="gallery" size={22} color="#C7D2E6" />
          </Pressable>

          <Pressable
            onPress={() => navigation.navigate('MealReview')}
            accessibilityRole="button"
            accessibilityLabel="Take photo"
            style={{ width: 80, height: 80, borderRadius: 40, borderWidth: 3, borderColor: 'rgba(255,255,255,0.45)', alignItems: 'center', justifyContent: 'center' }}
          >
            <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: '#FFFFFF' }} />
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Switch camera"
            style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: colors.cameraSurface, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="flipCamera" size={22} color="#C7D2E6" />
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}
