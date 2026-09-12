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

describe('#power-key right after the first render', () => {
  // Regression test for a bug where a click on #power-key landed during the
  // panel's drop-in animation and did nothing. The animation faded opacity
  // 0 -> 1 on the button's ancestor while a click could land in that window;
  // jsdom doesn't run CSS animations or hit-test opacity, so this test can
  // only prove the handler itself fires immediately after render (no
  // detach/re-wire race) — the opacity regression is covered by removing the
  // opacity keyframe in styles.css instead.
  it('calls the power action on the very first click, synchronously after render', () => {
    let powerCalls = 0;
    const actions: LiveActions = {
      power: () => {
        powerCalls++;
      },
      powerOff: () => {},
      toggle: () => {},
      setGenre: () => {},
      setEngine: () => {},
      setCreativity: () => {},
    };
    const store = new Store();
    const root = document.createElement('div');
    renderLive(root, store, actions);

    root.querySelector<HTMLButtonElement>('#power-key')!.click();

    expect(powerCalls).toBe(1);
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

describe('the live LCD reports what the band is doing with the player', () => {
  const noop = (): void => {};
  const actions: LiveActions = { power: noop, powerOff: noop, toggle: noop, setGenre: noop, setEngine: noop, setCreativity: noop };
  const dyn = (d: Partial<Store['state']['input']['dynamics']>): Store['state']['input']['dynamics'] =>
    ({ intensity: 0, space: false, fillDue: false, silenceBeats: 0, ...d });

  function render(
    dynamics: Store['state']['input']['dynamics'],
    rest: Partial<Store['state']> = {},
  ): { lcd: string; intensityWidth: string } {
    const store = new Store();
    const root = document.createElement('div');
    store.update({
      power: 'on',
      sources: { mic: 'on', midi: 'off' },
      locked: true,
      bar: 3,
      ...rest,
      input: { ...store.state.input, dynamics },
    });
    renderLive(root, store, actions);
    return {
      lcd: root.querySelector<HTMLElement>('#lcd')!.textContent!,
      intensityWidth: root.querySelector<HTMLElement>('#you-intensity')!.style.width,
    };
  }

  it('says nothing extra while the player is playing', () => {
    expect(render(dyn({ intensity: 0.9 })).lcd).toBe('LIVE · BAR 3');
  });

  it('announces the answer only when the lead is actually in', () => {
    const lead = { drums: true, bass: false, keys: false, lead: true };
    expect(render(dyn({ space: true }), { enabled: lead }).lcd).toBe('LIVE · BAR 3 · ANSWER');
    expect(render(dyn({ space: true })).lcd).toBe('LIVE · BAR 3');
  });

  it('flags the fill bar', () => {
    expect(render(dyn({ fillDue: true })).lcd).toBe('LIVE · BAR 3 · FILL');
  });

  it('drives the intensity bar from the effective intensity, not the raw activity', () => {
    expect(render(dyn({ intensity: 0.9 }), { effectiveIntensity: 0 }).intensityWidth).toBe('0%');
    expect(render(dyn({}), { effectiveIntensity: 0.42 }).intensityWidth).toBe('42%');
    expect(render(dyn({}), { effectiveIntensity: 1 }).intensityWidth).toBe('100%');
  });
});

describe('the MORPH controls', () => {
  const noop = (): void => {};
  function setup(state: Partial<Store['state']> = {}) {
    const store = new Store();
    const root = document.createElement('div');
    const cycles: string[] = [];
    const picked: (string | null)[] = [];
    const actions: LiveActions = {
      power: noop,
      powerOff: noop,
      toggle: noop,
      setGenre: noop,
      setEngine: noop,
      setCreativity: noop,
      cycleMorph: t => cycles.push(t),
      setMorphOutput: id => picked.push(id),
    };
    store.update({ power: 'on', ...state });
    renderLive(root, store, actions);
    return { root, store, actions, cycles, picked };
  }

  it('lists the output devices under an "off" entry, and remembers the choice', () => {
    const { root } = setup({
      audioOutputs: [
        { id: 'out1', label: 'Built-in Audio Analogue Stereo' },
        { id: 'out2', label: 'Scarlett 2i2 Analogue 3 + 4' },
      ],
      morphOut: 'out2',
    });
    const sel = root.querySelector<HTMLSelectElement>('#morph-out')!;
    expect(Array.from(sel.options).map(o => o.value)).toEqual(['', 'out1', 'out2']);
    expect(sel.options[0].textContent).toBe('off');
    expect(sel.value).toBe('out2');
  });

  it('says so instead of offering a picker where setSinkId is unsupported', () => {
    const { root } = setup({ morphSupported: false });
    expect(root.querySelector<HTMLSelectElement>('#morph-out')!.disabled).toBe(true);
    expect(root.querySelector<HTMLElement>('#morph-note')!.hidden).toBe(false);
  });

  it('gives every pad and the band engine an M key that cycles the route', () => {
    const { root, cycles } = setup();
    for (const id of ['#morph-drums', '#morph-bass', '#morph-keys', '#morph-lead', '#morph-band']) {
      root.querySelector<HTMLButtonElement>(id)!.click();
    }
    expect(cycles).toEqual(['drums', 'bass', 'keys', 'lead', 'band']);
  });

  it('lights the key only when the route actually reaches a device', () => {
    const routing = { drums: 'main', bass: 'morph', keys: 'both', lead: 'main', band: 'main' } as const;
    const dark = setup({ routing, morphOut: null }).root;
    expect(dark.querySelector('#morph-bass')!.classList.contains('on')).toBe(false);

    const lit = setup({ routing, morphOut: 'out1', audioOutputs: [{ id: 'out1', label: 'Interface' }] }).root;
    expect(lit.querySelector('#morph-bass')!.classList.contains('on')).toBe(true);
    expect(lit.querySelector('#morph-keys')!.classList.contains('both')).toBe(true);
    expect(lit.querySelector('#morph-drums')!.classList.contains('on')).toBe(false);
  });

  it('flags MORPH on the LCD only while something is routed to a real device', () => {
    const routed = { ...new Store().state.routing, keys: 'morph' as const };
    const off = setup({ routing: routed, sources: { mic: 'on', midi: 'off' } }).root;
    expect(off.querySelector('#lcd')!.textContent).not.toContain('MORPH');

    const on = setup({
      routing: routed,
      morphOut: 'out1',
      audioOutputs: [{ id: 'out1', label: 'Interface' }],
      sources: { mic: 'on', midi: 'off' },
    }).root;
    expect(on.querySelector('#lcd')!.textContent).toContain('· MORPH');
  });

  it('names the connected MIDI keyboard on the listening line', () => {
    const { root } = setup({
      sources: { mic: 'on', midi: 'on' },
      midiInputs: [{ id: 'a', label: 'Minilab3 MIDI' }],
    });
    expect(root.querySelector('#lcd')!.textContent).toContain('MIDI ✓ Minilab3 MIDI');
  });

  it('lists mic and MIDI inputs in their pickers', () => {
    const { root } = setup({
      audioInputs: [{ id: 'mic1', label: 'Scarlett 2i2' }],
      midiInputs: [{ id: 'a', label: 'Minilab3 MIDI' }],
    });
    const mic = root.querySelector<HTMLSelectElement>('#mic-in')!;
    const midi = root.querySelector<HTMLSelectElement>('#midi-in')!;
    expect(mic.options[0].textContent).toBe('default');
    expect(Array.from(mic.options).map(o => o.value)).toEqual(['', 'mic1']);
    expect(midi.options[0].textContent).toBe('all');
    expect(Array.from(midi.options).map(o => o.textContent)).toEqual(['all', 'Minilab3 MIDI']);
  });
});
