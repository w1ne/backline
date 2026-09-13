/** Idle is musical inactivity, not the kiosk's always-on power state. */
export class PerformanceGuard {
  private held = new Set<string>();
  private lastAt: number;
  private lastWall: number;
  private lastOnsets = 0;
  constructor(private now = () => performance.now(), private wall = () => Date.now(), private graceMs = 30000) {
    // A freshly booted renderer must settle before the updater can restart it.
    this.lastAt = now(); this.lastWall = wall();
  }
  touch(): void { this.lastAt = this.now(); this.lastWall = this.wall(); }
  noteOn(id: string): void { this.held.add(id); this.touch(); }
  noteOff(id: string): void { this.held.delete(id); this.touch(); }
  observeOnsets(count: number): void {
    if (count > this.lastOnsets) this.touch();
    this.lastOnsets = count;
  }
  clear(): void { this.held.clear(); this.lastOnsets = 0; }
  snapshot(s: {recording:boolean;paused:boolean;noiseVolume:number;droneVolume:number;power:string}): {performanceActive:boolean;performanceLastAt:number} {
    const audibleBed = s.power === 'on' && !s.paused && (s.noiseVolume > 0 || s.droneVolume > 0);
    return {performanceActive:s.recording || audibleBed || this.held.size > 0 || this.now()-this.lastAt < this.graceMs,
      performanceLastAt:this.lastWall};
  }
}
