import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Music theory lives in src/music and the patterns consume it; neither may reach into the
 *  analysis layer (src/listener) for it. */
describe('module boundaries', () => {
  for (const dir of ['music', 'patterns']) {
    it(`src/${dir} does not import from src/listener`, () => {
      const root = join(__dirname, '..', dir);
      const offenders = readdirSync(root)
        .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .filter(f => /from '(\.\.\/)+listener\//.test(readFileSync(join(root, f), 'utf8')))
        .map(f => `src/${dir}/${f}`);
      expect(offenders).toEqual([]);
    });
  }
});
