import { isPhoneUA } from '../listener/micConstraints';

/** What monitorAllowed() needs to decide, kept separate from any real device/UA lookup
 *  so the rule itself stays a pure function. */
export interface MonitorEnv {
  userAgent: string;
  /** the singer flipped the VOICE chip on */
  optedIn: boolean;
  /** an audio output device has been explicitly chosen (headphones/interface), as
   *  opposed to the browser's unset default (often the built-in speaker) */
  outputDeviceId: string | null;
}

/**
 * True only when playing the mic back out cannot feed back into itself: never on a
 * phone's built-in speaker (the mic sits right next to it), and even then only once the
 * singer has opted in or picked a real output device — an explicit choice either way,
 * never a silent default.
 */
export function monitorAllowed(env: MonitorEnv): boolean {
  if (isPhoneUA(env.userAgent)) return false;
  return env.optedIn || !!env.outputDeviceId;
}
