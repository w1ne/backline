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
});
