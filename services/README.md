# GPU services

Two small WebSocket services run on one RunPod GPU pod and are reached only through the relay (`relay/`), which holds the pod URLs as secrets. Current pod, ports and costs: `DEPLOYED.md`. Rebuild from scratch: `pod-bootstrap.sh`.

## RunPod API

GraphQL at `https://api.runpod.io/graphql`, header `Authorization: Bearer $RUNPOD_API_KEY` (key in `~/.local/secrets/runpod.env`; never in git).

Create a pod (L4 first; alternatives A5000, 4090, A40):

```graphql
mutation { podFindAndDeployOnDemand(input: {
  name: "backline", cloudType: ALL, gpuTypeId: "NVIDIA L4", gpuCount: 1,
  imageName: "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04",
  containerDiskInGb: 40, volumeInGb: 0,
  ports: "22/tcp,8080/http,8081/http",
  env: [{ key: "PUBLIC_KEY", value: "<your ssh public key>" }]
}) { id } }
```

Find SSH and proxy ports: `query { pod(input:{podId:"<id>"}) { desiredStatus runtime { ports { ip publicPort privatePort type } } } }`.
HTTP ports are reachable at `https://<id>-<port>.proxy.runpod.net` (WebSockets pass; idle connections drop after 100 s, so both services ping every 30 s).
Stop billing: `mutation { podTerminate(input:{podId:"<id>"}) }`. Resume after a stop wipes the disk; rerun `pod-bootstrap.sh`.

Then point the relay at the pod: `cd relay && echo -n "wss://<id>-8080.proxy.runpod.net/ws" | npx wrangler secret put ACESTEP_UPSTREAM` (same with `-8081` for `AMT_UPSTREAM`).

## ACE service (`acestep/`, port 8080)

Wraps ACE-Step 1.5 (MIT). Generates the band's next block of audio; the browser plays only the generated parts.

Client → `{"type":"block", "seq":1, "bpm":100, "key":"A minor", "genre":"lofi|funk|rock|jazz", "instruments":["drums","bass","keys","lead"], "creativity":0.3, "bars":2, "chords":["Am","F","G","C"]}`
Server → one binary frame: 4-byte little-endian `seq` + PCM16 stereo 48 kHz, `bars × 240/bpm` seconds; then `{"type":"done","seq":1,"ms":2100}`.
`{"type":"ping"}` → `{"type":"pong"}`; errors as `{"type":"error","message":...}`.

Inside: first block `text2music`, later blocks `complete` from the previous block (continuity), prompt = genre + instrument words + "no vocals, no guitar" (the player's instrument is excluded) + chord progression; `inference_steps` 8, batch 1, `guidance_scale` from creativity. ~2 s per 2-bar block on an L4, 17 GB VRAM.

## AMT service (`amt/`, port 8081)

Wraps the Anticipatory Music Transformer (`stanford-crfm/music-small-800k`, Apache-2.0) with a lookahead/commit scheduler. Follows the player's notes and writes accompaniment a few beats ahead; the browser plays it through its own synths.

Client → `{"type":"start","bpm":100,"key":"A minor","genre":"lofi","lookaheadBeats":4,"commitBeats":2,"listenBeats":8}`, then `{"type":"notes","notes":[{"beat":12.5,"pitch":64,"dur":0.5,"vel":0.8}]}` as the player plays, a cue every half bar `{"type":"tick","beat":14}` (absolute beat the half bar started at; the server plans the `commitBeats` window one bar ahead, `[18,20)`), `{"type":"set","genre":...,"creativity":...,"instruments":[...],"chord":"Am"}`.
Server → `{"type":"ready","tick":true}` right after `start`, then per cue `{"type":"plan","fromBeat":18,"toBeat":20,"notes":[{"beat":18,"pitch":57,"dur":1,"vel":0.7,"voice":"bass|keys"}]}` and `{"type":"status","latencyMs":230,"tokensPerSec":70}`.
Compatibility: the older `{"type":"bar","bar":3}` cue at each bar start is still accepted and answers with the whole of bar 4 (`[16,20)`); a client only sends `tick` after it has seen `ready`, so against an older server it keeps cueing with `bar`.

Inside: the model gets the last 16 beats of the human part, samples the accompaniment instrument only (melody instrument masked), monophonic per bass onset / up to a 3-note chord voicing per keys onset; ~60–300 ms per bar on an L4 (also runs on CPU). Before `listenBeats` of human input arrives, bar 1 already gets a key-only fallback plan (bass on the chord root on beats 1 and 3, keys a sustained voiced chord on beat 1) built straight from the `key`/`chord` the client sent -- no melody needed and no change to `listenBeats` itself, which still gates the model's own first real answer.
