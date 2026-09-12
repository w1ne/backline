// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { tileLabel, renderLive } from './live';
import { Store } from './state';
import type { LiveActions } from './live';

describe('tileLabel', () => {
  // Regression test for the bug where clicking an instrument tile "kept
  // reporting off". `locked` (has the band found a tempo yet?) was folded into
  // the same label as `on` (is this instrument un-muted?), so before the band
  // locked, every tile read "off" no matter how many times it was toggled —
  // while the tile itself was lit and store.state.enabled said true.
  describe('before the band locks a tempo', () => {
    it('an enabled instrument does not read "off"', () => {
      expect(tileLabel(true, false, false, false)).not.toBe('off');
    });

    it('reports the instrument as armed, and a muted one as off', () => {
      expect(tileLabel(true, false, false, false)).toBe('ready');
      expect(tileLabel(false, false, false, false)).toBe('off');
    });

    it('toggling on/off four times alternates the label every time', () => {
      const labels: string[] = [];
      let on = true;
      for (let click = 0; click < 4; click++) {
        on = !on;
        labels.push(tileLabel(on, /* locked */ false, false, false));
      }
      expect(labels).toEqual(['off', 'ready', 'off', 'ready']);
    });
  });

  describe('once locked', () => {
    it('bar-accurate engines announce the join, then play', () => {
      expect(tileLabel(true, true, false, true)).toBe('joins next bar');
      expect(tileLabel(true, true, false, false)).toBe('playing');
    });

    it('latency engines show the settle state in both directions', () => {
      expect(tileLabel(true, true, true, false)).toBe('joining…');
      expect(tileLabel(false, true, true, false)).toBe('leaving…');
    });

    it('a muted instrument reads off', () => {
      expect(tileLabel(false, true, false, false)).toBe('off');
    });
  });

  it('never reports a lit tile as off, in any combination', () => {
    for (const locked of [false, true]) {
      for (const pending of [false, true]) {
        for (const justJoined of [false, true]) {
          expect(tileLabel(true, locked, pending, justJoined)).not.toBe('off');
        }
      }
    }
  });
});

describe('the listening LCD', () => {
  const noop = (): void => {};
  const actions: LiveActions = { power: noop, powerOff: noop, toggle: noop, setGenre: noop, setEngine: noop, setCreativity: noop };

  function lcd(input: Partial<Store['state']['input']>, rest: Partial<Store['state']> = {}): string {
    const store = new Store();
    const root = document.createElement('div');
    store.update({ power: 'on', sources: { mic: 'on', midi: 'off' }, ...rest, input: { ...store.state.input, ...input } });
    renderLive(root, store, actions);
    return root.querySelector<HTMLElement>('#lcd')!.textContent!;
  }

  it('counts onsets towards the lock', () => {
    expect(lcd({ onsets: 3 })).toBe('LISTENING · MIC ✓ MIDI ✗ · 3/12');
  });

  it('shows the running estimate as soon as there is one', () => {
    expect(lcd({ onsets: 7, pendingBpm: 98.4 })).toBe('LISTENING · MIC ✓ MIDI ✗ · 7/12 · ~98 BPM');
  });

  it('drops the estimate once the band is live', () => {
    expect(lcd({ onsets: 12, pendingBpm: 98.4 }, { locked: true, bar: 2 })).toBe('LIVE · BAR 2');
  });
});

describe('the YOU strip note label', () => {
  const noop = (): void => {};
  const actions: LiveActions = { power: noop, powerOff: noop, toggle: noop, setGenre: noop, setEngine: noop, setCreativity: noop };

  function note(pitch: Store['state']['input']['pitch']): { text: string; stable: boolean } {
    const store = new Store();
    const root = document.createElement('div');
    store.update({ power: 'on', sources: { mic: 'on', midi: 'off' }, input: { ...store.state.input, pitch } });
    renderLive(root, store, actions);
    const el = root.querySelector<HTMLElement>('#you-note')!;
    return { text: el.textContent!, stable: el.classList.contains('stable') };
  }

  it('shows a dash when there is no stable pitch', () => {
    expect(note(null)).toEqual({ text: '—', stable: false });
  });

  it('shows note name, octave and cents, tinted stable when locked in', () => {
    expect(note({ midi: 57, cents: 7, stable: true })).toEqual({ text: 'A3 +7¢', stable: true });
  });

  it('is dim when the reading is not yet stable', () => {
    expect(note({ midi: 60, cents: -3, stable: false })).toEqual({ text: 'C4 -3¢', stable: false });
  });
});

describe('engine and genre controls while power is off', () => {
  const noop = (): void => {};
  const actions: LiveActions = {
    power: noop,
    powerOff: noop,
    toggle: noop,
    setGenre: g => store.state.genre = g,
    setEngine: e => store.state.engine = e,
    setCreativity: noop,
  };
  let store: Store;

  function setup(): HTMLElement {
    store = new Store();
    const root = document.createElement('div');
    renderLive(root, store, actions);
    return root;
  }

  it('clicking the Lyria engine switch updates store.state.engine while off', () => {
    const root = setup();
    expect(store.state.power).toBe('off');
    root.querySelector<HTMLButtonElement>('#engine-lyria')!.click();
    expect(store.state.engine).toBe('lyria');
  });

  it('clicking a genre chip updates store.state.genre while off', () => {
    const root = setup();
    expect(store.state.power).toBe('off');
    root.querySelector<HTMLButtonElement>('#genre-chips .chip[data-genre="funk"]')!.click();
    expect(store.state.genre).toBe('funk');
  });

  it('flags ACE/Lyria as offline in the switch but keeps them clickable', () => {
    const root = setup();
    store.update({ offlineEngines: ['acestep', 'lyria'] });
    renderLive(root, store, actions);

    const ace = root.querySelector<HTMLButtonElement>('#engine-acestep')!;
    const lyria = root.querySelector<HTMLButtonElement>('#engine-lyria')!;
    const patterns = root.querySelector<HTMLButtonElement>('#engine-patterns')!;
    expect(ace.title).toBe('OFFLINE');
    expect(lyria.title).toBe('OFFLINE');
    expect(patterns.title).toBe('');
    expect(ace.querySelector('.engine-led')!.classList.contains('offline')).toBe(true);

    ace.click();
    expect(store.state.engine).toBe('acestep');
  });
});
