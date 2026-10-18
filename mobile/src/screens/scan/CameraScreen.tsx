import { useIsFocused } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { ActivityIndicator, Linking, Platform, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PrimaryButton, RoundButton, SecondaryButton } from '../../components/Buttons';
import { Icon } from '../../components/Icon';
import { ScanScreenProps } from '../../navigation/types';
import { beginCapture, consumeCaptureOutcome, useCaptureState } from '../../services/captureMeal';
import { useColors } from '../../theme';

/**
 * Capture screen: one photo, uploaded as-is. The two-photo guided capture (top-down + oblique,
 * described in root CLAUDE.md section 9) is a separate, not-yet-built flow.
 *
 * The camera is NOT started here. It is started by the tap that asks for it (the floating camera
 * button, the photo widget in the add sheet, "Retake photo"), because a phone browser only opens
 * its camera from the tap itself. This screen just picks up the result: a photo goes on to the
 * review, closing the camera without a photo returns to where the person was, and a camera that
 * could not start is explained here with a way to try again or pick from the gallery.
 *
 * The photo is taken with the phone's own camera screen, not a live in-app viewfinder, so the
 * camera is open only while the person takes the picture and is released the moment they press
 * the shutter. Camera permission is asked only while it is still undecided.
 */
export function CameraScreen({ navigation }: ScanScreenProps<'Camera'>) {
  const colors = useColors();
  const isFocused = useIsFocused();
  const capture = useCaptureState();

  useEffect(() => {
    if (!isFocused || !capture.outcome) return;
    const outcome = consumeCaptureOutcome();
    if (!outcome) return;
    if (outcome.kind === 'photo') {
      navigation.navigate('MealReview', { photo: outcome.photo });
    } else if (outcome.kind === 'cancelled' && capture.returnOnCancel) {
      (navigation.getParent() as { navigate: (name: string) => void } | undefined)?.navigate(capture.returnTab);
    }
  }, [isFocused, capture.outcome, capture.returnOnCancel, capture.returnTab, navigation]);

  const processing = capture.phase === 'processing';

  return (
    <View style={{ flex: 1, backgroundColor: colors.camera }}>
      {/* The screen is dark in both schemes, so the status bar is always light here. */}
      <StatusBar style="light" />
      <SafeAreaView style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 8, gap: 12 }}>
          <RoundButton
            onPress={() => navigation.getParent()?.navigate('Home')}
            accessibilityLabel="Close scan"
            size={38}
            bg="rgba(255,255,255,0.12)"
            edge="start"
          >
            <Icon name="close" size={17} color="#FFFFFF" />
          </RoundButton>
          <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: '#FFFFFF' }}>
            Scan meal
          </Text>
        </View>

        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 }}>
          <View style={{ width: '100%', alignItems: 'center', gap: 16 }}>
            <View
              style={{
                width: 96,
                height: 96,
                borderRadius: 28,
                backgroundColor: colors.cameraSurface,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {processing ? <ActivityIndicator color="#FFFFFF" size="large" /> : <Icon name="camera" size={40} color="#C7D2E6" />}
            </View>

            {processing ? (
              <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_700Bold', fontSize: 17, color: '#FFFFFF', textAlign: 'center' }}>
                Preparing your photo...
              </Text>
            ) : (
              <>
                <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 17, color: '#FFFFFF', textAlign: 'center' }}>
                  Photograph your meal
                </Text>
                <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: 'rgba(255,255,255,0.72)', textAlign: 'center', lineHeight: 20 }}>
                  Fit the whole plate in the photo, in good light. The camera opens only while you take the picture.
                </Text>

                {capture.problem === 'denied' ? (
                  <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: '#FFFFFF', textAlign: 'center', lineHeight: 20 }}>
                    Camera access was not allowed. You can allow it, or choose a photo from your gallery instead.
                  </Text>
                ) : null}
                {capture.problem === 'blocked' ? (
                  <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: '#FFFFFF', textAlign: 'center', lineHeight: 20 }}>
                    Camera access is turned off for SugarSense. Turn it on in your phone settings, or choose a photo from your gallery.
                  </Text>
                ) : null}
                {capture.problem === 'failed' ? (
                  <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: '#FFFFFF', textAlign: 'center', lineHeight: 20 }}>
                    The photo could not be opened. Nothing was sent - try again, or enter the carbs by hand.
                  </Text>
                ) : null}

                <View style={{ width: '100%', gap: 10, marginTop: 8 }}>
                  {capture.problem === 'blocked' && Platform.OS !== 'web' ? (
                    <PrimaryButton label="Open settings" onPress={() => void Linking.openSettings()} />
                  ) : (
                    <PrimaryButton label="Take photo" onPress={() => beginCapture('camera')} />
                  )}
                  <SecondaryButton label="Choose from gallery" onPress={() => beginCapture('gallery')} />
                </View>
              </>
            )}
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}
