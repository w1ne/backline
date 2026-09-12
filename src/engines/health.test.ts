import { describe, expect, it } from 'vitest';
import { parseHealth } from './health';

describe('parseHealth', () => {
  it('marks every engine the relay did not vouch for as offline', () => {
    expect(parseHealth('{"relay":"ok","amt":false,"acestep":true,"lyria":true}')).toEqual(['amt']);
  });
  it('treats a missing field as offline', () => {
    expect(parseHealth('{"relay":"ok"}')).toEqual(['amt', 'acestep', 'lyria']);
  });
  it('yields null for the legacy plain body', () => {
    expect(parseHealth('ok')).toBeNull();
  });
});
