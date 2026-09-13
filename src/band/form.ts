import type { Arrangement, Dynamics } from '../types';

/** The song's current section. `ended` is terminal until {@link SongForm.reset} is called
 *  (which happens whenever the band (re)starts — see Bandleader.start and main.ts's
 *  first-lock restart path). */
export type Section = 'intro' | 'groove' | 'lift' | 'breakdown' | 'ending' | 'ended';

/** What the status line says for each section. */
export const SECTION_LABEL: Record<Section, string> = {
  intro: 'Intro',
  groove: 'Groove',
  lift: 'Lift',
  breakdown: 'Breakdown',
  ending: 'Ending',
  ended: 'Ended · sing to start again',
};

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
/** four full 4-beat bars of silence: a singer's breath between phrases is two, and a
 *  false ending restarts with a count-in, which is far worse than a late one */
const ENDING_SILENCE_BEATS = 16;

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
 * driven by {@link FormInput} — no clock or player access. The Bandleader owns the one
 * instance and reports each bar's result through `onFormCb`, which is how the app shows the
 * section name and learns when the band has stopped itself.
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
