import type { Arrangement, Dynamics } from '../types';

/** The song's current section. `ended` is terminal until {@link SongForm.reset} is called
 *  (which happens whenever the band (re)starts — see Bandleader.start and main.ts's
 *  first-lock restart path). */
export type Section = 'intro' | 'groove' | 'lift' | 'breakdown' | 'ending' | 'ended';

export interface FormInput {
  /** absolute bar number, 0-based, since the band last started */
  bar: number;
  dynamics: Dynamics;
  /** beats since the player's last onset; normally the same as dynamics.silenceBeats, kept
   *  as its own field so a caller without a full Dynamics reading can still drive endings */
  silenceBeats: number;
  /** true once the player is definitely gone (e.g. powered off), forcing an ending
   *  immediately rather than waiting out the silence window */
  playerStopped: boolean;
}

export interface FormResult {
  section: Section;
  arrangement: Arrangement;
  /** true on the one bar the band should play its ending hit and then stop itself */
  shouldStop: boolean;
}

const INTRO_BARS = 2;
/** bars of sustained intensity before the form reacts */
const HYSTERESIS_BARS = 4;
const LIFT_INTENSITY = 0.7;
const BREAKDOWN_INTENSITY = 0.3;
/** two full 4-beat bars of silence */
const ENDING_SILENCE_BEATS = 8;

const NO_ARRANGEMENT: Arrangement = { intro: false, lift: false, breakdown: false, ending: false };

function arrangementFor(section: Section): Arrangement {
  return {
    intro: section === 'intro',
    lift: section === 'lift',
    breakdown: section === 'breakdown',
    ending: section === 'ending',
  };
}

/**
 * Drives the song through intro -> groove -> (lift | breakdown)* -> ending. Pure state
 * driven by {@link FormInput} — no clock or player access — so the same sequence of inputs
 * always produces the same sequence of sections. That determinism is relied on: the
 * Bandleader runs one instance to shape the patterns, and the app runs a second, identically
 * driven instance purely to show the section name and to know when to stop the band; the two
 * never need to talk to each other.
 */
export class SongForm {
  private section: Section = 'intro';
  private highStreak = 0;
  private lowStreak = 0;

  /** Back to intro. Call whenever the band (re)starts. */
  reset(): void {
    this.section = 'intro';
    this.highStreak = 0;
    this.lowStreak = 0;
  }

  tick(input: FormInput): FormResult {
    const { bar, dynamics, silenceBeats, playerStopped } = input;

    if (this.section === 'ending') {
      // The ending bar has already played; this and every later tick until reset() is idle.
      this.section = 'ended';
      return { section: 'ended', arrangement: NO_ARRANGEMENT, shouldStop: false };
    }
    if (this.section === 'ended') return { section: 'ended', arrangement: NO_ARRANGEMENT, shouldStop: false };

    this.highStreak = dynamics.intensity > LIFT_INTENSITY ? this.highStreak + 1 : 0;
    this.lowStreak = dynamics.intensity < BREAKDOWN_INTENSITY ? this.lowStreak + 1 : 0;

    if (this.section === 'intro') {
      if (bar >= INTRO_BARS) this.section = 'groove';
      else return { section: 'intro', arrangement: arrangementFor('intro'), shouldStop: false };
    }

    if (playerStopped || silenceBeats >= ENDING_SILENCE_BEATS) {
      this.section = 'ending';
      return { section: 'ending', arrangement: arrangementFor('ending'), shouldStop: true };
    }

    if (this.highStreak >= HYSTERESIS_BARS) this.section = 'lift';
    else if (this.lowStreak >= HYSTERESIS_BARS) this.section = 'breakdown';
    else if (this.section === 'lift' || this.section === 'breakdown') this.section = 'groove';

    return { section: this.section, arrangement: arrangementFor(this.section), shouldStop: false };
  }
}
