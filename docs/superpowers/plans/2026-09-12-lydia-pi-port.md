# duet.ai web and LYDIA Pi editions

**Goal:** Preserve the public web application and run the same listener, accompaniment,
and synthesis code autonomously on LYDIA, with local controls and restartable services.

**Architecture:** `VITE_DEVICE=lydia` selects a build profile; ordinary `npm run build`
remains the public web edition. Pi Chromium runs on localhost with real audio capture
and playback. A Python service serves the build, relays bounded control commands and
stores runtime status. An independent LCD process uses the existing LYDIA drivers.
The Pi defaults to offline Patterns; local AMT is selected only after measured validation.

**Tech stack:** existing TypeScript/Tone.js/Vite; Python standard library HTTP;
Chromium, PipeWire/ALSA, systemd; isolated optional PyTorch AMT environment.

- [x] Profile: add `src/device/profile.ts` and test that public defaults are untouched,
  while Pi uses offline instruments, default physical I/O and main-only routing.
- [x] Runtime control: `src/device/runtime.ts` exchanges status and commands with
  `/api/status` and `/api/commands`; reuse the same actions as the web panel.
- [x] Device host: `services/pi/server.py` validates commands, bounds queue/body sizes,
  restricts runtime-only endpoints to loopback, serves static assets and a remote controller.
  Exercise validation, queue delivery and static traversal in Python tests.
- [x] Startup: Pi web and browser services run as test, bind the browser debugger only
  to loopback, choose LYDIAAudio through PipeWire, and restart after failure. Installer
  stages files under `/home/test/duet-ai` without overwriting vendor firmware.
- [x] Hardware UI: isolated `services/pi/lcd.py`, status display and selected controls;
  test with fake display and actual driver. Keep original bento MIDI bridge alive.
- [x] AMT: isolated local installation and real inference benchmark. Record measured
  latency and resource usage; retain working Patterns if AMT cannot meet its deadline.
- [x] Verify both build profiles and regressions, then verify on-device mic access,
  audio playback, note scheduling, network controls and service restart. Document URLs,
  model limitations and the restore-morpho.sh recovery command.

Do not deploy a Pi profile to public hosting. Preserve vendor files. The later user request authorized Wi-Fi setup alongside Ethernet;
WiFi@Berghotel now connects automatically as duet-venue-wifi. Preserve the existing uncommitted accompaniment fixes in the source checkout.
