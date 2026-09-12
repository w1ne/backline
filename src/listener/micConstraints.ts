/**
 * getUserMedia audio constraints for the listener's mic.
 *
 * Instruments want the raw signal: no echo cancellation, noise suppression or auto gain,
 * all of which colour pitch and onsets. A phone is different: the band plays out of the
 * same box the mic sits in, so without the echo canceller the listener hears the band
 * and follows itself. Phones get the canceller; the other two stay off everywhere.
 */
export function micConstraints(deviceId: string | null, userAgent: string = navigator.userAgent): MediaTrackConstraints {
  const phone = /iPhone|iPad|iPod|Android/i.test(userAgent);
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: false, // TEST: Android call-mode routing
    noiseSuppression: false,
    autoGainControl: false,
  };
}
