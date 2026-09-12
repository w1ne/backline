/** Hand a MIDI file to the browser as a download. */
export function downloadMidi(bytes: Uint8Array, filename: string): void {
  downloadBlob(new Blob([bytes as BlobPart], { type: 'audio/midi' }), filename);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
