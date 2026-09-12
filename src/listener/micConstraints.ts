/**
 * getUserMedia audio constraints for the listener's mic.
 *
 * Instruments want the raw signal: no echo cancellation, noise suppression or auto gain,
 * all of which colour pitch and onsets. A phone is different: the band plays out of the
 * same box the mic sits in, so without the echo canceller the listener hears the band
 * and follows itself. iOS gets the canceller. Android does not: Chrome there implements
 * echo cancellation by switching the phone into call mode, which moves the band onto the
 * call-volume path and the earpiece, and the user hears nothing (seen on Android Chrome,
 * 2026-09-12). The other two stay off everywhere.
 */
/** True on a phone (iOS or Android's "Mobile" Chrome UA) — the one place both the mic
 *  constraints above and the vocal-monitor safety check need to agree on what a phone is. */
export function isPhoneUA(userAgent: string = navigator.userAgent): boolean {
  return /iPhone|iPod|Android.*Mobile/i.test(userAgent);
}

export function micConstraints(deviceId: string | null, userAgent: string = navigator.userAgent): MediaTrackConstraints {
  const ios = /iPhone|iPad|iPod/i.test(userAgent);
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: ios,
    noiseSuppression: false,
    autoGainControl: false,
  };
}
