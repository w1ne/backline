import { it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fetchAmtSamples } from './fetch-amt-samples.mjs';

it('verifies cached sample bytes and repairs corrupt cache before packaging', async () => {
 const root = await mkdtemp(join(tmpdir(), 'amt-samples-'));
 const body = Buffer.from('sample-data');
 const manifest = {revision:'abc',files:{'violin-ogg.js':{bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')}}};
 let requests=0;
 const fetcher=async()=>{requests++;return new Response(body);};
 try {
  await fetchAmtSamples({root,manifest,fetcher});
  await fetchAmtSamples({root,manifest,fetcher});
  expect(requests).toBe(1);
  await writeFile(join(root,'violin-ogg.js'),'broken');
  await fetchAmtSamples({root,manifest,fetcher});
  expect(requests).toBe(2);
  expect(await readFile(join(root,'violin-ogg.js'))).toEqual(body);
 } finally {await rm(root,{recursive:true,force:true});}
});

it('fails the build when upstream sample integrity differs', async () => {
 const root = await mkdtemp(join(tmpdir(), 'amt-samples-'));
 try {
  await expect(fetchAmtSamples({root,manifest:{revision:'abc',files:{'violin-ogg.js':{bytes:2,sha256:'wrong'}}},fetcher:async()=>new Response('bad')})).rejects.toThrow('integrity');
 } finally {await rm(root,{recursive:true,force:true});}
});

it('pins all AMT GM assets and keeps each file within the hosting size limit', async () => {
 const manifest = JSON.parse(await readFile(new URL('./amt-samples-manifest.json', import.meta.url),'utf8'));
 const catalog = await readFile(new URL('../src/players/gmInstruments.ts', import.meta.url),'utf8');
 const names = [...catalog.matchAll(/name: '([^']+)'/g)].map(match => `${match[1]}-ogg.js`).sort();
 expect(Object.keys(manifest.files).sort()).toEqual(names);
 expect(manifest.revision).toMatch(/^[a-f0-9]{40}$/);
 for (const spec of Object.values(manifest.files)) {
  expect(spec.bytes).toBeGreaterThan(0);
  expect(spec.bytes).toBeLessThan(25 * 1024 * 1024);
  expect(spec.sha256).toMatch(/^[a-f0-9]{64}$/);
 }
});
