import * as ImagePicker from 'expo-image-picker';
import { StatusBar } from 'expo-status-bar';
import React, { useState } from 'react';
import { Linking, Platform, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CapturedPhoto } from '../../api/mealsApi';
import { PrimaryButton, RoundButton, SecondaryButton } from '../../components/Buttons';
import { Icon } from '../../components/Icon';
import { ScanScreenProps } from '../../navigation/types';
import { compressPhoto } from '../../services/photoCompression';
import { useColors } from '../../theme';

type CameraProblem = 'denied' | 'blocked' | null;

/**
 * Capture screen: one photo, uploaded as-is. The two-photo guided capture (top-down + oblique,
 * described in root CLAUDE.md section 9) is a separate, not-yet-built flow.
 *
 * The photo is taken with the phone's own camera screen (`launchCameraAsync`), not a live
 * in-app viewfinder. That is deliberate: the camera is open only while the person is taking the
 * picture and is released the moment they press the shutter, so the phone never shows the
 * "camera in use / recording" indicator while this screen is just sitting open. On the web the
 * system camera is a file input, which needs no permission prompt at all. On a phone the
 * permission is asked once; the operating system remembers the answer, and this screen only
 * asks again when it is still undecided.
 */
export function CameraScreen({ navigation }: ScanScreenProps<'Camera'>) {
  const colors = useColors();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<CameraProblem>(null);
  const [failed, setFailed] = useState(false);

  const goToReview = (photo: CapturedPhoto) => navigation.navigate('MealReview', { photo });

  const ensureCameraPermission = async (): Promise<CameraProblem | 'granted'> => {
    const current = await ImagePicker.getCameraPermissionsAsync();
    if (current.granted) return 'granted';
    if (!current.canAskAgain) return 'blocked';
    const asked = await ImagePicker.requestCameraPermissionsAsync();
    if (asked.granted) return 'granted';
    return asked.canAskAgain ? 'denied' : 'blocked';
  };

  const takePhoto = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const permission = await ensureCameraPermission();
      if (permission !== 'granted') {
        setProblem(permission);
        return;
      }
      setProblem(null);
      // quality: 1 (the system camera's own encoding, before our own resize/compress) so we start from
      // the best available source rather than compressing an already-lossy copy twice over.
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        cameraType: ImagePicker.CameraType.back,
        allowsEditing: false,
        quality: 1,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      goToReview(await compressPhoto(asset.uri));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const pickFromGallery = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permissionResult.granted) return;
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 1 });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      goToReview(await compressPhoto(asset.uri));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

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
              <Icon name="camera" size={40} color="#C7D2E6" />
            </View>
            <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 17, color: '#FFFFFF', textAlign: 'center' }}>
              Photograph your meal
            </Text>
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: 'rgba(255,255,255,0.72)', textAlign: 'center', lineHeight: 20 }}>
              Fit the whole plate in the photo, in good light. The camera opens only while you take the picture.
            </Text>

            {problem === 'denied' ? (
              <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: '#FFFFFF', textAlign: 'center', lineHeight: 20 }}>
                Camera access was not allowed. You can allow it, or choose a photo from your gallery instead.
              </Text>
            ) : null}
            {problem === 'blocked' ? (
              <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: '#FFFFFF', textAlign: 'center', lineHeight: 20 }}>
                Camera access is turned off for SugarSense. Turn it on in your phone settings, or choose a photo from your gallery.
              </Text>
            ) : null}
            {failed ? (
              <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: '#FFFFFF', textAlign: 'center', lineHeight: 20 }}>
                The photo could not be opened. Nothing was sent - try again, or enter the carbs by hand.
              </Text>
            ) : null}

            <View style={{ width: '100%', gap: 10, marginTop: 8 }}>
              {problem === 'blocked' && Platform.OS !== 'web' ? (
                <PrimaryButton label="Open settings" onPress={() => void Linking.openSettings()} />
              ) : (
                <PrimaryButton label="Take photo" onPress={() => void takePhoto()} loading={busy} />
              )}
              <SecondaryButton label="Choose from gallery" onPress={() => void pickFromGallery()} />
            </View>
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}
