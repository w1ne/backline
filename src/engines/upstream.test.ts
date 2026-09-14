// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { engineSocketUrl, ownUpstream, resolveUpstream, saveOwnUpstream, withoutOwnUpstreams } from './upstream';

describe('resolveUpstream', () => {
  it('turns a RunPod pod id into that pod\'s proxied service socket', () => {
    expect(resolveUpstream('acestep', '6r2srn274qynf1')).toBe('wss://6r2srn274qynf1-8080.proxy.runpod.net/ws');
    expect(resolveUpstream('amt', ' 6r2srn274qynf1 ')).toBe('wss://6r2srn274qynf1-8081.proxy.runpod.net/ws');
  });
  it('accepts hosts and full urls, defaulting the /ws path and secure websockets', () => {
    expect(resolveUpstream('amt', 'mypod-8081.proxy.runpod.net')).toBe('wss://mypod-8081.proxy.runpod.net/ws');
    expect(resolveUpstream('amt', 'http://localhost:18081')).toBe('ws://localhost:18081/ws');
    expect(resolveUpstream('acestep', 'wss://gpu.example.org/custom')).toBe('wss://gpu.example.org/custom');
  });
  it('rejects empty and unusable input', () => {
    expect(resolveUpstream('amt', '')).toBeNull();
    expect(resolveUpstream('amt', 'ftp://x')).toBeNull();
    expect(resolveUpstream('amt', 'not a url at all')).toBeNull();
  });
});

describe('own upstream storage', () => {
  beforeEach(() => localStorage.clear());
  it('routes the engine socket to the saved pod and back to the relay when cleared', () => {
    expect(engineSocketUrl('amt', 'https://relay.example', '/amt')).toBe('wss://relay.example/amt');
    saveOwnUpstream('amt', 'abcdefghij12');
    expect(ownUpstream('amt')).toBe('abcdefghij12');
    expect(engineSocketUrl('amt', 'https://relay.example', '/amt')).toBe('wss://abcdefghij12-8081.proxy.runpod.net/ws');
    expect(withoutOwnUpstreams(['amt', 'acestep', 'lyria'])).toEqual(['acestep', 'lyria']);
    saveOwnUpstream('amt', '');
    expect(ownUpstream('amt')).toBe('');
    expect(withoutOwnUpstreams(['amt'])).toEqual(['amt']);
  });
});
