// Self-host the exact AMT soundfonts; never depend on a third-party CDN at playback.
import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {join} from 'node:path';

const defaultRoot = fileURLToPath(new URL('../public/samples/amt/', import.meta.url));
export async function fetchAmtSamples({root = defaultRoot, manifest, fetcher = fetch} = {}) {
  manifest ??= JSON.parse(await readFile(new URL('./amt-samples-manifest.json', import.meta.url), 'utf8'));
  await mkdir(root, {recursive:true});
  const jobs = Object.entries(manifest.files);
  const valid = (data, spec) => data.length === spec.bytes && createHash('sha256').update(data).digest('hex') === spec.sha256;
  async function worker() {
    for (;;) {
      const job = jobs.pop(); if (!job) return;
      const [name, spec] = job;
      const path = join(root, name);
      const cached = await readFile(path).catch(() => undefined);
      if (cached && valid(cached, spec)) continue;
      const url = `https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/${manifest.revision}/MusyngKite/${name}`;
      const response = await fetcher(url, {signal:AbortSignal.timeout(45_000)});
      if (!response.ok) throw new Error(`AMT sample ${response.status}: ${url}`);
      const data = Buffer.from(await response.arrayBuffer());
      if (!valid(data, spec)) throw new Error(`AMT sample integrity mismatch: ${name}`);
      await writeFile(`${path}.tmp`, data);
      await rename(`${path}.tmp`, path);
    }
  }
  await Promise.all(Array.from({length:4}, worker));
  await writeFile(join(root, 'ATTRIBUTION.txt'), `Musyng Kite soundfont, rendered by gleitz/midi-js-soundfonts.\nUnmodified instrument files at upstream commit ${manifest.revision}.\nCreative Commons Attribution Share-Alike 3.0\nhttps://creativecommons.org/licenses/by-sa/3.0/\nhttps://github.com/gleitz/midi-js-soundfonts\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await fetchAmtSamples();
  console.log('Verified bundled AMT sample bank');
}
