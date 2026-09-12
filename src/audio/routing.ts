/**
 * Where a part's audio goes: the laptop's default output ("main"), the MORPH output
 * (a second audio device — in practice the interface outputs feeding a Neutone LYDIA
 * timbre-transfer box), or both at once for A/B and for blending dry with morphed.
 *
 * Nothing here touches the Web Audio API: this is the state machine the pads, the
 * store and the audio graph all agree on.
 */
export type MorphRoute = 'main' | 'morph' | 'both';

/** The four instrument pads plus the generated-audio engines (Lyria / ACE) as one bus. */
export const ROUTE_TARGETS = ['drums', 'bass', 'keys', 'lead', 'band'] as const;
export type RouteTarget = (typeof ROUTE_TARGETS)[number];
export type RoutingState = Record<RouteTarget, MorphRoute>;

const CYCLE: MorphRoute[] = ['main', 'morph', 'both'];

/** One press of a pad's M key: main → morph → both → main. */
export function nextRoute(cur: MorphRoute): MorphRoute {
  const i = CYCLE.indexOf(cur);
  return CYCLE[(i < 0 ? 0 : i + 1) % CYCLE.length];
}

/**
 * Which physical destinations a route actually feeds.
 *
 * With no MORPH output selected every route collapses to main, so a pad left on
 * "morph" from an earlier session can never silence itself when the box is unplugged.
 */
export function routeTargets(route: MorphRoute, hasMorph: boolean): { main: boolean; morph: boolean } {
  if (!hasMorph) return { main: true, morph: false };
  return {
    main: route === 'main' || route === 'both',
    morph: route === 'morph' || route === 'both',
  };
}

export const MAIN_ROUTING: RoutingState = { drums: 'main', bass: 'main', keys: 'main', lead: 'main', band: 'main' };

/**
 * Default routing once a MORPH output exists: keys and lead are the parts worth running
 * through a timbre-transfer model (sustained, pitched, one voice at a time), while drums,
 * bass and the generated band stay dry on the main output.
 */
export function defaultRouting(hasMorph: boolean): RoutingState {
  if (!hasMorph) return { ...MAIN_ROUTING };
  return { drums: 'main', bass: 'main', keys: 'morph', lead: 'morph', band: 'main' };
}

/** True when nothing has been routed away from the main output yet. */
export function isAllMain(r: RoutingState): boolean {
  return ROUTE_TARGETS.every(t => r[t] === 'main');
}

/** True when at least one part is actually reaching the morph box — drives the LCD flag. */
export function anyMorph(r: RoutingState, hasMorph: boolean): boolean {
  return hasMorph && ROUTE_TARGETS.some(t => r[t] !== 'main');
}
