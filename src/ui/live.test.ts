// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { tileLabel, renderLive, accompPresetMuted } from './live';
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
    it('requires activity evidence before reporting playback', () => {
      expect(tileLabel(true, true, false, true)).toBe('joins next bar');
      expect(tileLabel(true, true, false, false)).toBe('ready');
      expect(tileLabel(true, true, false, false, true)).toBe('playing');
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
  const actions: LiveActions = { wake: noop, toggle: noop, setGenre: noop, setEngine: noop, setCreativity: noop };

  function lcd(input: Partial<Store['state']['input']>, rest: Partial<Store['state']> = {}): string {
    const store = new Store();
    const root = document.createElement('div');
    store.update({ power: 'on', sources: { mic: 'on', midi: 'off' }, ...rest, input: { ...store.state.input, ...input } });
    renderLive(root, store, actions);
    return root.querySelector<HTMLElement>('#lcd')!.textContent!;
  }

  // A keyboard's onsets are beats: the detected tempo starts the band, and the LCD counts
  // the onsets towards the lock (unchanged by the mic-only count-in default).
  const midi = { sources: { mic: 'on' as const, midi: 'on' as const } };

  it('counts onsets towards the lock', () => {
    expect(lcd({ onsets: 3 }, midi)).toBe('LISTENING · MIC ✓ MIDI ✓ · 3/12');
  });

  it('shows the running estimate as soon as there is one', () => {
    expect(lcd({ onsets: 7, pendingBpm: 98.4 }, midi)).toBe('LISTENING · MIC ✓ MIDI ✓ · 7/12 · ~98 BPM');
  });

  it('invites singing with count-in off too', () => {
    expect(lcd({ onsets: 7, pendingBpm: 98.4 }, { countIn: false })).toBe('LISTENING · MIC ✓ MIDI ✗ · SING TO START');
  });

  it('invites a solo singer to start without a tempo setting', () => {
    expect(lcd({ onsets: 7, pendingBpm: 140.4 })).toBe('LISTENING · MIC ✓ MIDI ✗ · SING TO START');
    expect(lcd({ onsets: 0 })).toBe('LISTENING · MIC ✓ MIDI ✗ · SING TO START');
    expect(lcd({ onsets: 20, pendingBpm: 140.4, voiceBpm: 96.2 })).toBe('LISTENING · MIC ✓ MIDI ✗ · SING TO START');
  });

  it('drops the estimate once the band is live', () => {
    expect(lcd({ onsets: 12, pendingBpm: 98.4 }, { locked: true, bar: 2 })).toBe('LIVE · BAR 2');
  });

  it('shows the count-in beat ahead of the band entering', () => {
    expect(lcd({}, { countInBeat: 3 })).toBe('COUNT-IN · · · 3 ·');
  });
});

describe('waking the audio context', () => {
  it('forwards every tap on the panel to wake(), and has no power key', () => {
    let wakes = 0;
    const actions: LiveActions = {
      wake: () => {
        wakes++;
      },
      toggle: () => {},
      setGenre: () => {},
      setEngine: () => {},
      setCreativity: () => {},
    };
    const store = new Store();
    const root = document.createElement('div');
    renderLive(root, store, actions);
    root.querySelector<HTMLElement>('#inst-tiles .pad-btn')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(wakes).toBe(1);
    expect(root.querySelector('#power-key')).toBeNull();
  });

  it('asks for a tap on the LCD while the context is suspended', () => {
    const store = new Store();
    store.update({ power: 'on', audioSuspended: true });
    const root = document.createElement('div');
    renderLive(root, store, { wake: () => {}, toggle: () => {}, setGenre: () => {}, setEngine: () => {}, setCreativity: () => {} });
    expect(root.querySelector('#lcd')!.textContent).toBe('TAP ANYWHERE TO ENABLE SOUND');
  });
});

describe('engine and genre controls while power is off', () => {
  const noop = (): void => {};
  const actions: LiveActions = {
    wake: noop,
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

  it('clicking the AMT engine switch updates store.state.engine while off', () => {
    const root = setup();
    expect(store.state.power).toBe('off');
    root.querySelector<HTMLButtonElement>('#engine-amt')!.click();
    expect(store.state.engine).toBe('amt');
  });

  it('clicking a genre chip updates store.state.genre while off', () => {
    const root = setup();
    expect(store.state.power).toBe('off');
    root.querySelector<HTMLButtonElement>('#genre-chips .chip[data-genre="funk"]')!.click();
    expect(store.state.genre).toBe('funk');
  });

  it('does not show a playback pill in the browser', () => {
    const root = setup();
    renderLive(root, store, actions);
    const pill = root.querySelector<HTMLElement>('#playback-target')!;
    expect(pill.style.display).toBe('none');
    expect(pill.textContent).toBe('');
  });

  it('offers every engine as a selectable model', () => {
    const root = setup();
    renderLive(root, store, actions);
    expect(root.querySelector<HTMLButtonElement>('#engine-acestep')!.hidden).toBe(false);
    expect(root.querySelector<HTMLButtonElement>('#engine-amt')!.hidden).toBe(false);
    expect(root.querySelector<HTMLButtonElement>('#engine-patterns')!.hidden).toBe(false);
  });

  it('flags ACE/AMT as offline in the switch but keeps them clickable', () => {
    const root = setup();
    store.update({ offlineEngines: ['acestep', 'amt'] });
    renderLive(root, store, actions);

    const ace = root.querySelector<HTMLButtonElement>('#engine-acestep')!;
    const amt = root.querySelector<HTMLButtonElement>('#engine-amt')!;
    const patterns = root.querySelector<HTMLButtonElement>('#engine-patterns')!;
    expect(ace.title).toBe('OFFLINE');
    expect(amt.title).toBe('OFFLINE');
    expect(patterns.title).toBe('');
    expect(ace.querySelector('.engine-led')!.classList.contains('offline')).toBe(true);

    ace.click();
    expect(store.state.engine).toBe('acestep');
  });
});

describe('the live LCD reports what the band is doing with the player', () => {
  const noop = (): void => {};
  const actions: LiveActions = { wake: noop, toggle: noop, setGenre: noop, setEngine: noop, setCreativity: noop };
  const dyn = (d: Partial<Store['state']['input']['dynamics']>): Store['state']['input']['dynamics'] =>
    ({ intensity: 0, space: false, fillDue: false, silenceBeats: 0, ...d });

  function render(
    dynamics: Store['state']['input']['dynamics'],
    rest: Partial<Store['state']> = {},
  ): { lcd: string } {
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

});

describe('the listening line', () => {
  const noop = (): void => {};
  function setup(state: Partial<Store['state']> = {}) {
    const store = new Store();
    const root = document.createElement('div');
    const actions: LiveActions = {
      wake: noop,
        toggle: noop,
      setGenre: noop,
      setEngine: noop,
      setCreativity: noop,
    };
    store.update({ power: 'on', ...state });
    renderLive(root, store, actions);
    return { root, store, actions };
  }




  it('names the connected MIDI keyboard on the listening line', () => {
    const { root } = setup({
      sources: { mic: 'on', midi: 'on' },
      midiInputs: [{ id: 'a', label: 'Minilab3 MIDI' }],
    });
    expect(root.querySelector('#lcd')!.textContent).toContain('MIDI ✓ Minilab3 MIDI');
  });

});


describe('instrument controls and model feedback', () => {
  it('offers an explicit audio start button and forwards sound layers', () => {
    const store = new Store();
    store.update({ power: 'on', audioSuspended: true });
    const root = document.createElement('div');
    const calls: unknown[] = [];
    renderLive(root, store, { wake: () => calls.push('wake'), toggle: () => {}, setGenre: () => {}, setEngine: () => {}, setCreativity: () => {}, setNoiseVolume: v => calls.push(v), setDroneVolume: v => calls.push(v) });
    root.querySelector<HTMLButtonElement>('#enable-audio')!.click();
    for (const id of ['noise-volume', 'drone-volume']) {
      const input = root.querySelector<HTMLInputElement>('#' + id)!;
      input.value = '0.3';
      input.dispatchEvent(new Event('input'));
    }
    expect(calls).toEqual(['wake', 0.3, 0.3]);
  });

  it('shows the output latency next to the model latency', () => {
    const store = new Store();
    store.update({ power: 'on', outputLatencyMs: 42 });
    const root = document.createElement('div');
    renderLive(root, store, { wake: () => {}, toggle: () => {}, setGenre: () => {}, setEngine: () => {}, setCreativity: () => {} });
    expect(root.querySelector('#output-latency')!.textContent).toBe('Output latency: 42 ms');
  });

  it('shows model status and latency without inventing activity', () => {
    const store = new Store();
    store.update({ power: 'on', locked: true, accompanimentStatus: 'Waiting for a model phrase', modelLatencyMs: 1234, activeParts: {} });
    const root = document.createElement('div');
    const actions = { wake: () => {}, toggle: () => {}, setGenre: () => {}, setEngine: () => {}, setCreativity: () => {} };
    renderLive(root, store, actions);
    store.update({ bar: 2 });
    renderLive(root, store, actions);
    expect(root.querySelector('#band-status')!.textContent).toContain('Waiting for a model phrase');
    expect(root.querySelector('#model-latency')!.textContent).toContain('1234 ms');
    expect(root.querySelector('[data-inst="drums"] .st-text')!.textContent).toBe('ready');
    expect(root.querySelector('[data-inst="drums"] .meter')).toBeNull();
  });
});


it('does not show an unavailable selected model as connected', () => {
  const store = new Store();
  store.update({ power: 'on', engine: 'amt', offlineEngines: ['amt'], engineConnecting: false });
  const root = document.createElement('div');
  renderLive(root, store, { wake: () => {}, toggle: () => {}, setGenre: () => {}, setEngine: () => {}, setCreativity: () => {} });
  expect(root.querySelector('[data-engine-led="amt"]')!.classList.contains('online')).toBe(false);
});


describe('tap tempo', () => {
  it('flashes the beat dots and forwards the tap to actions().tap()', () => {
    let taps = 0;
    const store = new Store();
    const root = document.createElement('div');
    renderLive(root, store, {
      wake: () => {}, toggle: () => {}, setGenre: () => {}, setEngine: () => {}, setCreativity: () => {},
      tap: () => { taps++; return null; },
    });
    const beats = root.querySelector<HTMLElement>('#beats')!;
    root.querySelector<HTMLButtonElement>('#tap-tempo')!.click();
    expect(taps).toBe(1);
    expect(beats.classList.contains('tap-flash')).toBe(true);
  });

  it('fills the bpm field once tap() reports an adopted tempo', () => {
    const store = new Store();
    const root = document.createElement('div');
    renderLive(root, store, {
      wake: () => {}, toggle: () => {}, setGenre: () => {}, setEngine: () => {}, setCreativity: () => {},
      tap: () => ({ bpm: 128, downbeat: 3 }),
    });
    root.querySelector<HTMLButtonElement>('#tap-tempo')!.click();
    expect(root.querySelector<HTMLInputElement>('#bpm')!.value).toBe('128');
  });

  it('reflects the countIn flag on the toggle button', () => {
    const store = new Store();
    store.update({ countIn: false });
    const root = document.createElement('div');
    renderLive(root, store, { wake: () => {}, toggle: () => {}, setGenre: () => {}, setEngine: () => {}, setCreativity: () => {} });
    expect(root.querySelector('#count-in-toggle')!.classList.contains('on')).toBe(false);
    store.update({ countIn: true });
    renderLive(root, store, { wake: () => {}, toggle: () => {}, setGenre: () => {}, setEngine: () => {}, setCreativity: () => {} });
    expect(root.querySelector('#count-in-toggle')!.classList.contains('on')).toBe(true);
  });
});

describe('the VOICE chip', () => {
  const noop = (): void => {};
  const baseActions: LiveActions = { wake: noop, toggle: noop, setGenre: noop, setEngine: noop, setCreativity: noop };

  it('is off by default, sits next to MIC, and shows the state MIC uses', () => {
    const store = new Store();
    const root = document.createElement('div');
    renderLive(root, store, baseActions);
    const voice = root.querySelector<HTMLButtonElement>('#voice-monitor')!;
    expect(voice).not.toBeNull();
    expect(voice.classList.contains('on')).toBe(false);
    expect(voice.previousElementSibling!.id).toBe('mic-mute');
  });

  it('calls setVoiceMonitor with the flipped value on click', () => {
    const calls: boolean[] = [];
    const store = new Store();
    const root = document.createElement('div');
    renderLive(root, store, { ...baseActions, setVoiceMonitor: v => calls.push(v) });
    root.querySelector<HTMLButtonElement>('#voice-monitor')!.click();
    expect(calls).toEqual([true]);
  });

  it('reflects store.voiceMonitor once toggled on', () => {
    const store = new Store();
    store.update({ voiceMonitor: true });
    const root = document.createElement('div');
    renderLive(root, store, baseActions);
    expect(root.querySelector<HTMLButtonElement>('#voice-monitor')!.classList.contains('on')).toBe(true);
  });

  it('hides alongside MIC when there is no mic source at all', () => {
    const store = new Store();
    store.update({ sources: { mic: 'none', midi: 'off' } });
    const root = document.createElement('div');
    renderLive(root, store, baseActions);
    expect(root.querySelector<HTMLButtonElement>('#voice-monitor')!.hidden).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('#mic-mute')!.hidden).toBe(true);
  });

  it('carries a headphones-only tooltip', () => {
    const store = new Store();
    const root = document.createElement('div');
    renderLive(root, store, baseActions);
    const voice = root.querySelector<HTMLButtonElement>('#voice-monitor')!;
    expect(voice.title.length).toBeGreaterThan(0);
  });
});

it('only offers RunPod models and offline Patterns', () => {
  const root = document.createElement('div');
  renderLive(root, new Store(), { wake: () => {}, toggle: () => {}, setGenre: () => {}, setEngine: () => {}, setCreativity: () => {} });
  expect(root.querySelector('#engine-lyria')).toBeNull();
  expect(Array.from(root.querySelectorAll('[data-engine]')).map(button => button.getAttribute('data-engine')).sort()).toEqual(['acestep', 'amt', 'patterns']);
});

it('labels a selected preset muted when all of its roles are disabled, even with stale activity', () => {
  const store = new Store();
  store.update({engine:'amt',accompPresets:['strings','sax'],accompActive:{strings:true,sax:true},
    enabled:{drums:false,bass:false,keys:false,lead:false}});
  const root=document.createElement('div');
  const actions={wake:()=>{},toggle:()=>{},setGenre:()=>{},setEngine:()=>{},setCreativity:()=>{}};
  renderLive(root,store,actions);
  expect(root.querySelector('[data-preset="strings"] .st-text')!.textContent).toBe('muted');
  expect(root.querySelector('[data-preset="sax"] .st-text')!.textContent).toBe('muted');
  expect(root.querySelector('[data-preset="sax"]')!.classList.contains('active')).toBe(false);
  store.update({enabled:{...store.state.enabled,bass:true},accompActive:{}});
  renderLive(root,store,actions);
  expect(root.querySelector('[data-preset="strings"] .st-text')!.textContent).toBe('ready');
  expect(root.querySelector('[data-preset="sax"] .st-text')!.textContent).toBe('muted');
});


it('treats the guitar preset as muted only by its Lead role', () => {
  expect(accompPresetMuted('guitar', {drums:true,bass:true,keys:true,lead:false})).toBe(true);
  expect(accompPresetMuted('guitar', {drums:false,bass:false,keys:false,lead:true})).toBe(false);
});
