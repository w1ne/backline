AMT sampled playback uses the eleven Musyng Kite instruments listed in
`src/players/gmInstruments.ts`. The browser and Pi load them from the app's own
`samples/amt/` directory. There are no runtime soundfont CDN requests.

Run `npm run samples:amt` to download and verify the bank. `npm run dev`,
`npm run build`, and `npm run build:pi` run this automatically. Workflows that
invoke Vite directly fetch first. A manual `npx vite` invocation must also run
`npm run samples:amt` first.

`amt-samples-manifest.json` pins an upstream commit, SHA-256 digest, and byte size
for every unchanged instrument file. The fetcher verifies cached files, replaces
corrupt ones atomically, and fails the build on download or integrity errors.
Downloaded files are ignored by Git and included by Vite through `public/`.
Attribution and the CC BY-SA 3.0 license link ship with the assets.

To update samples, review the upstream commit and file hashes, update the
manifest, and run the sample-fetch tests and browser audio smoke check. The
manifest test also verifies catalog coverage and the per-file hosting limit.

Playback downloads time out after 15 seconds, including the response body.
Failed sampler instances are removed so a later plan can retry. The
`Players.onSampleError` hook reports the failure. Notes whose scheduled times
pass during loading remain dropped; they never play as a late burst.
