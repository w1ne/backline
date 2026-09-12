/** Let the last bar finish, then require a new performer attack to re-arm. */
export class EndingGate {
  private timer?: ReturnType<typeof setTimeout>;
  private afterOnsets: number | null = null;
  finishAfter(delayMs: number, onsets: () => number, stop: () => void): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.afterOnsets = onsets();
      stop();
    }, Math.max(0, delayMs));
  }
  canStart(onsets: number): boolean {
    return this.timer === undefined && (this.afterOnsets === null || onsets > this.afterOnsets);
  }
  reset(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.afterOnsets = null;
  }
}
