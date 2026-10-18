import * as ImagePicker from 'expo-image-picker';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import type { CapturedPhoto } from '../api/mealsApi';
import { createCaptureStore, type CaptureOutcome, type CaptureProblem, type CaptureSource } from './captureStore';
import { compressPhoto } from './photoCompression';

/**
 * Takes the meal photo with the phone's own camera (or picks one from the gallery) and prepares it
 * for upload. Start it with `beginCapture(...)` from the tap that asks for it, so the camera opens
 * at once; the Scan screen reads the result with `useCaptureState()`.
 *
 * The camera is open only while the person takes the picture and is released the moment they
 * press the shutter. Camera permission is asked only while it is still undecided: once allowed
 * (or refused) the operating system remembers, and this code never asks again. On the web the
 * system camera is a file input, which needs no permission and must be opened directly inside the
 * tap, so nothing is awaited before it on the web.
 */

async function ensureCameraPermission(): Promise<'granted' | CaptureProblem> {
  const current = await ImagePicker.getCameraPermissionsAsync();
  if (current.granted) return 'granted';
  if (!current.canAskAgain) return 'blocked';
  const asked = await ImagePicker.requestCameraPermissionsAsync();
  if (asked.granted) return 'granted';
  return asked.canAskAgain ? 'denied' : 'blocked';
}

async function runCapture(source: CaptureSource, markProcessing: () => void): Promise<CaptureOutcome<CapturedPhoto>> {
  try {
    if (source === 'camera' && Platform.OS !== 'web') {
      const permission = await ensureCameraPermission();
      if (permission !== 'granted') return { kind: permission };
    }
    // quality: 1 (the system camera's own encoding, before our own resize/compress) so we start from
    // the best available source rather than compressing an already-lossy copy twice over.
    const result =
      source === 'camera'
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], cameraType: ImagePicker.CameraType.back, allowsEditing: false, quality: 1 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 1 });
    const asset = result.canceled ? null : result.assets[0];
    if (!asset) return { kind: 'cancelled' };
    markProcessing();
    return { kind: 'photo', photo: await compressPhoto(asset.uri) };
  } catch {
    return { kind: 'failed' };
  }
}

const store = createCaptureStore<CapturedPhoto>(runCapture);

export const beginCapture = store.begin;
export const consumeCaptureOutcome = store.consume;

export function useCaptureState() {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
