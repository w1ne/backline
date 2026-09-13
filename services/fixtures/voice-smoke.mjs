/** Generated test signal: one sustained, voiced A4; no licensed recordings or network. */
export function heldVoiceWav(seconds = 30) {
  const rate = 48000;
  const samples = rate * seconds;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const phase = 2 * Math.PI * 440 * t;
    const envelope = Math.min(1, t / .05);
    const sample = envelope * .22 * (Math.sin(phase) + .3 * Math.sin(2 * phase) + .12 * Math.sin(3 * phase));
    wav.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  return wav;
}

/** Deterministic AMT protocol fixture, deliberately gated on real captured held input.
 * It replaces inference only. The app still captures pitch, starts its transport,
 * sends notes, loads its shipped GM soundfont, and schedules native WebAudio. */
export function attachAmtFixture(socket, evidence, fault) {
  let start;
  const held = new Set();
  socket.send(JSON.stringify({type: 'ready', tick: true, performanceEvents: true, setBpm: true}));
  socket.on('message', data => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'start') { start = msg; evidence.starts.push(msg); }
    if (msg.type === 'notes') {
      evidence.notes.push(...msg.notes);
      if (fault !== 'held') for (const n of msg.notes) if (n.held && n.id) held.add(n.id);
    }
    if (msg.type === 'note_updates') for (const n of msg.notes) held.delete(n.id);
    if (!start || !['tick', 'bar'].includes(msg.type)) return;
    const beat = msg.type === 'tick' ? msg.beat : msg.bar * 4;
    const fromBeat = beat + start.lookaheadBeats;
    const toBeat = fromBeat + start.commitBeats;
    const notes = held.size && fromBeat >= start.listenBeats ? [
      {beat: fromBeat, dur: .75, pitch: 60, gmInstr: 40, voice: 'keys', vel: .65},
    ] : [];
    if (notes.length) evidence.playablePlans++;
    socket.send(JSON.stringify({type: 'plan', fromBeat, toBeat, notes, section: 'groove',
      cueId: msg.cueId, latestCaptureTimeSec: msg.latestCaptureTimeSec}));
    socket.send(JSON.stringify({type: 'status', latencyMs: 1, requestAgeMs: 1}));
  });
}
