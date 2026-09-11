import { describe, it, expect } from 'vitest';
import { Store } from './state';

describe('Store', () => {
  it('notifies subscribers with merged state', () => {
    const s = new Store();
    const seen: number[] = [];
    s.subscribe(st => seen.push(st.creativity));
    s.update({ creativity: 0.7 });
    expect(seen).toEqual([0.7]);
    expect(s.state.genre).toBe('lofi');
  });

  it('unsubscribe stops notifications', () => {
    const s = new Store();
    const seen: number[] = [];
    const unsub = s.subscribe(st => seen.push(st.bar));
    unsub();
    s.update({ bar: 5 });
    expect(seen).toEqual([]);
  });
});
