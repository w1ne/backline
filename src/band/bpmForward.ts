/** Dirty-check for forwarding a follow-mode tempo change to a band engine: forward the
 * first value seen, or any value that differs from the last one sent by at least `step`. */
export function forwardBpm(prevSent: number | undefined, next: number, step: number): boolean {
  return prevSent === undefined || Math.abs(next - prevSent) >= step;
}
