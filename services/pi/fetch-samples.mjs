// Run on the build computer. Assets stay on the Pi and require no runtime internet.
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { LAYERS } from 'smplr';
const root = new URL('../../.pi-samples/', import.meta.url);
const grand = 'https://smpldsnds.github.io/sfzinstruments-splendid-grand-piano/samples/';
const sf = 'https://gleitz.github.io/midi-js-soundfonts/MusyngKite/';
const names = ['electric_piano_1', 'drawbar_organ', 'acoustic_guitar_nylon', 'string_ensemble_1', 'vibraphone'];
const jobs = [
  ...names.map(n => [`${n}-mp3.js`, `${sf}${n}-mp3.js`]),
  ...[...new Set(LAYERS.flatMap(l => l.samples.map(([, name]) => name)))].map(n => [`grand/${n}.ogg`, `${grand}${encodeURIComponent(n)}.ogg`]),
];
await mkdir(new URL('grand/', root), {recursive:true});
let count = 0;
async function worker() {
  for (;;) {
    const job = jobs.pop(); if (!job) return;
    const [name, url] = job, path = new URL(name.replaceAll('#', '%23'), root);
    if ((await stat(path).catch(() => null))?.size > 0) continue;
    const response = await fetch(url);
    if (!response.ok) throw Error(`${response.status}: ${url}`);
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
    if (++count % 25 === 0) console.log(`Downloaded ${count} sample files`);
  }
}
await Promise.all(Array.from({length:8}, worker));
await writeFile(new URL('ATTRIBUTION.txt', root), `Splendid Grand Piano: public-domain AKAI samples, mapping by kinwie.\nhttps://github.com/smpldsnds/sfzinstruments-splendid-grand-piano\n\nMusyng Kite, rendered by gleitz/midi-js-soundfonts, unchanged instrument files.\nCreative Commons Attribution Share-Alike 3.0: https://creativecommons.org/licenses/by-sa/3.0/\nhttps://github.com/gleitz/midi-js-soundfonts\n`);
console.log('Pi sample bank ready');
