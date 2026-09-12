import type { Chord } from '../types';
import type { EngineChoice } from '../ui/state';
import type { Section } from './form';

/** Bars a plan chord/section stays "fresh" before the local (fallback) path takes over
 *  again -- see docs/superpowers/specs/2026-09-12-one-brain-design.md step 3: the local
 *  SongForm and chord tick keep running under AMT too, but their results only apply when
 *  the service hasn't spoken up recently. */
const FRESH_BARS = 2;

/** Tracks the bar each of the AMT service's plan `chord` and `section` last arrived on, so
 *  the app can tell whether the local fallback should still defer to the service or take
 *  back over (service unreachable, or simply hasn't sent a plan in a while). */
export class PlanFreshness {
  private chordBar?: number;
  private sectionBar?: number;

  noteChord(bar: number): void {
    this.chordBar = bar;
  }

  noteSection(bar: number): void {
    this.sectionBar = bar;
  }

  /** Call whenever the band (re)starts, so a plan from a previous run never counts as fresh. */
  reset(): void {
    this.chordBar = undefined;
    this.sectionBar = undefined;
  }

  chordFresh(bar: number): boolean {
    return this.chordBar !== undefined && bar - this.chordBar < FRESH_BARS;
  }

  sectionFresh(bar: number): boolean {
    return this.sectionBar !== undefined && bar - this.sectionBar < FRESH_BARS;
  }
}

/** Picks which chord the band should actually use this tick: the service's plan chord
 *  while AMT is live and it's fresh, the browser's own detector otherwise. */
export function chooseChord(engine: EngineChoice, planFresh: boolean, planChord: Chord | null, localChord: Chord | null): Chord | null {
  return engine === 'amt' && planFresh && planChord ? planChord : localChord;
}

/** Same arbitration as {@link chooseChord}, for song-form section. */
export function chooseSection(engine: EngineChoice, planFresh: boolean, planSection: Section | null, localSection: Section): Section {
  return engine === 'amt' && planFresh && planSection ? planSection : localSection;
}
