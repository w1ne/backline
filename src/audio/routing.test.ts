import { describe, it, expect } from 'vitest';
import {
  anyMorph,
  defaultRouting,
  isAllMain,
  MAIN_ROUTING,
  nextRoute,
  ROUTE_TARGETS,
  routeTargets,
  type MorphRoute,
} from './routing';

describe('nextRoute', () => {
  it('cycles main → morph → both → main', () => {
    expect(nextRoute('main')).toBe('morph');
    expect(nextRoute('morph')).toBe('both');
    expect(nextRoute('both')).toBe('main');
  });

  it('returns to where it started after three presses, from any start', () => {
    for (const start of ['main', 'morph', 'both'] as MorphRoute[]) {
      expect(nextRoute(nextRoute(nextRoute(start)))).toBe(start);
    }
  });
});

describe('routeTargets', () => {
  it('feeds the outputs each route names', () => {
    expect(routeTargets('main', true)).toEqual({ main: true, morph: false });
    expect(routeTargets('morph', true)).toEqual({ main: false, morph: true });
    expect(routeTargets('both', true)).toEqual({ main: true, morph: true });
  });

  it('never silences a part when there is no morph output', () => {
    // A pad left on "morph" from a previous session, with the box unplugged, must
    // still come out of the laptop rather than going quiet.
    for (const route of ['main', 'morph', 'both'] as MorphRoute[]) {
      expect(routeTargets(route, false)).toEqual({ main: true, morph: false });
    }
  });
});

describe('defaultRouting', () => {
  it('sends keys and lead to the box once there is one, and nothing else', () => {
    const r = defaultRouting(true);
    expect(r).toEqual({ drums: 'main', bass: 'main', keys: 'morph', lead: 'morph', band: 'main' });
  });

  it('keeps everything on the main output with no morph device', () => {
    expect(defaultRouting(false)).toEqual(MAIN_ROUTING);
    expect(isAllMain(defaultRouting(false))).toBe(true);
  });

  it('hands back a fresh object each time, so the store cannot mutate the constant', () => {
    const r = defaultRouting(false);
    r.drums = 'both';
    expect(MAIN_ROUTING.drums).toBe('main');
  });
});

describe('anyMorph', () => {
  it('is false while everything is on main', () => {
    expect(anyMorph(MAIN_ROUTING, true)).toBe(false);
  });

  it('is true as soon as one part is routed away, for every target', () => {
    for (const t of ROUTE_TARGETS) {
      expect(anyMorph({ ...MAIN_ROUTING, [t]: 'morph' }, true)).toBe(true);
      expect(anyMorph({ ...MAIN_ROUTING, [t]: 'both' }, true)).toBe(true);
    }
  });

  it('is false without an output device, however the pads are set', () => {
    expect(anyMorph(defaultRouting(true), false)).toBe(false);
  });
});
