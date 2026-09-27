import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { CapturedPhoto } from '../api/mealsApi';

/**
 * Resizes and compresses a captured photo before upload. A full-resolution phone photo is often
 * 10-15+ MB raw, which used to trip `MAX_BASE64_CHARS` (mealsApi.ts) on plenty of ordinary meal
 * photos. A 1600px-wide JPEG at 0.8 quality typically lands a food photo at 1-3 MB raw -
 * comfortably under the ~7.5 MB the cap allows, not just barely under it. The cap itself stays in
 * place as a safety net for the rare photo still large after this (see mealService.ts); the
 * "too large, please retake" state should now be reached far less often, not never.
 *
 * Uses the current (non-deprecated) object-oriented ImageManipulator API - `manipulateAsync` still
 * works in this SDK but is marked deprecated in favor of this one.
 */
const RESIZE_WIDTH = 1600;
const COMPRESS_QUALITY = 0.8;

export async function compressPhoto(uri: string): Promise<CapturedPhoto> {
  const rendered = await ImageManipulator.manipulate(uri).resize({ width: RESIZE_WIDTH }).renderAsync();
  const result = await rendered.saveAsync({ compress: COMPRESS_QUALITY, format: SaveFormat.JPEG, base64: true });
  if (!result.base64) {
    throw new Error('Photo compression did not return base64 data.');
  }
  // Always JPEG: the compression step above is the one source of truth for the uploaded bytes'
  // format now, regardless of what the camera or gallery originally produced.
  return { uri: result.uri, base64: result.base64, mimeType: 'image/jpeg' };
}
