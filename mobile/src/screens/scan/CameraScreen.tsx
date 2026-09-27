import { CameraType, CameraView, FlashMode, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { StatusBar } from 'expo-status-bar';
import React, { useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CapturedPhoto } from '../../api/mealsApi';
import { PrimaryButton, RoundButton, SecondaryButton } from '../../components/Buttons';
import { Icon } from '../../components/Icon';
import { ScanScreenProps } from '../../navigation/types';
import { compressPhoto } from '../../services/photoCompression';
import { useColors } from '../../theme';

/**
 * Camera-first capture screen: one photo, uploaded as-is. The two-photo guided capture (top-down
 * + oblique, described in root CLAUDE.md section 9) is a separate, not-yet-built flow - this is
 * deliberately the simpler single-photo version.
 */
export function CameraScreen({ navigation }: ScanScreenProps<'Camera'>) {
  const colors = useColors();
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>('back');
  const [flash, setFlash] = useState<FlashMode>('off');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mountError, setMountError] = useState<string | null>(null);
  const cameraRef = useRef<CameraView>(null);

  const goToReview = (photo: CapturedPhoto) => navigation.navigate('MealReview', { photo });

  const takePhoto = async () => {
    if (!ready || busy || mountError) return;
    setBusy(true);
    try {
      // No base64 requested here - compressPhoto below reads the uri and produces the base64
      // that actually gets uploaded, from the resized/compressed version, not the full-res original.
      const picture = await cameraRef.current?.takePictureAsync();
      if (!picture) return;
      goToReview(await compressPhoto(picture.uri));
    } finally {
      setBusy(false);
    }
  };

  const pickFromGallery = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permissionResult.granted) return;
      // quality: 1 (the picker's own encoding, before our own resize/compress) so we start from
      // the best available source rather than compressing an already-lossy copy twice over.
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 1 });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      goToReview(await compressPhoto(asset.uri));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.camera }}>
      {/* The viewfinder is dark in both schemes, so the status bar is always light here. */}
      <StatusBar style="light" />
      <SafeAreaView style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 8 }}>
          <RoundButton
            onPress={() => navigation.getParent()?.navigate('Home')}
            accessibilityLabel="Close scan"
            size={38}
            bg="rgba(255,255,255,0.12)"
            edge="start"
          >
            <Icon name="close" size={17} color="#FFFFFF" />
          </RoundButton>
          <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: '#FFFFFF' }}>Scan meal</Text>
          <RoundButton
            onPress={() => setFlash((current) => (current === 'off' ? 'on' : 'off'))}
            accessibilityLabel={flash === 'off' ? 'Turn flash on' : 'Turn flash off'}
            size={38}
            bg={flash === 'off' ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.3)'}
            edge="end"
          >
            <Icon name="flash" size={17} color="#FFFFFF" />
          </RoundButton>
        </View>

        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 }}>
          {!permission ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : !permission.granted ? (
            <PermissionRequest
              canAskAgain={permission.canAskAgain}
              onRequest={requestPermission}
              onUseGalleryInstead={pickFromGallery}
            />
          ) : (
            <>
              <View
                style={{
                  width: 270,
                  height: 270,
                  borderRadius: 28,
                  overflow: 'hidden',
                  borderWidth: 2,
                  borderColor: 'rgba(255,255,255,0.35)',
                }}
              >
                {mountError ? (
                  <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                    <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: 'rgba(255,255,255,0.8)', textAlign: 'center' }}>
                      {mountError}
                    </Text>
                  </View>
                ) : (
                  <CameraView
                    ref={cameraRef}
                    style={{ flex: 1 }}
                    facing={facing}
                    flash={flash}
                    onCameraReady={() => setReady(true)}
                    onMountError={(event) => setMountError(event.message || 'Camera unavailable on this device.')}
                  />
                )}
              </View>
              <Text style={{ marginTop: 24, fontFamily: 'Manrope_500Medium', fontSize: 14, color: 'rgba(255,255,255,0.72)' }}>
                Center your plate in the frame
              </Text>
            </>
          )}
        </View>

        {permission?.granted ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 28, paddingBottom: 16 }}>
            <Pressable
              onPress={pickFromGallery}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Choose from gallery"
              style={{
                width: 52,
                height: 52,
                borderRadius: 16,
                backgroundColor: colors.cameraSurface,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: busy ? 0.5 : 1,
              }}
            >
              <Icon name="gallery" size={22} color="#C7D2E6" />
            </Pressable>

            <Pressable
              onPress={takePhoto}
              disabled={!ready || busy || !!mountError}
              accessibilityRole="button"
              accessibilityLabel="Take photo"
              style={{
                width: 80,
                height: 80,
                borderRadius: 40,
                borderWidth: 3,
                borderColor: 'rgba(255,255,255,0.45)',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: !ready || !!mountError ? 0.5 : 1,
              }}
            >
              {busy ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: '#FFFFFF' }} />
              )}
            </Pressable>

            <RoundButton
              onPress={() => setFacing((current) => (current === 'back' ? 'front' : 'back'))}
              accessibilityLabel="Switch camera"
              size={52}
              bg={colors.cameraSurface}
            >
              <Icon name="flipCamera" size={22} color="#C7D2E6" />
            </RoundButton>
          </View>
        ) : null}
      </SafeAreaView>
    </View>
  );
}

function PermissionRequest({
  canAskAgain,
  onRequest,
  onUseGalleryInstead,
}: {
  canAskAgain: boolean;
  onRequest: () => void;
  onUseGalleryInstead: () => void;
}) {
  return (
    // width: '100%' matters here: without it this View shrink-wraps to the width of the wrapped
    // paragraph below, and the "full width" button block underneath then computes 100% of that
    // *shrunk* box instead of the screen - a narrow, packed-looking button floating in empty margin.
    <View style={{ width: '100%', alignItems: 'center', gap: 16 }}>
      <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 17, color: '#FFFFFF', textAlign: 'center' }}>Camera access needed</Text>
      <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: 'rgba(255,255,255,0.72)', textAlign: 'center', lineHeight: 20 }}>
        SugarSense needs your camera to photograph meals for carb estimation. You can also pick an existing photo instead.
      </Text>
      <View style={{ width: '100%', gap: 10, marginTop: 8 }}>
        {canAskAgain ? (
          <PrimaryButton label="Allow camera access" onPress={onRequest} />
        ) : (
          <PrimaryButton label="Open settings" onPress={() => Linking.openSettings()} />
        )}
        <SecondaryButton label="Choose from gallery" onPress={onUseGalleryInstead} />
      </View>
    </View>
  );
}
