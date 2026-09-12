import {describe,it,expect} from 'vitest';
import {PerformanceGuard} from './performanceGuard';
const idle={recording:false,paused:false,noiseVolume:0,droneVolume:0,power:'on'};
describe('Pi update performance guard',()=>{
  it('allows an always-on idle kiosk only after the quiet grace period',()=>{
    let t=0;const g=new PerformanceGuard(()=>t,()=>t);
    expect(g.snapshot(idle).performanceActive).toBe(true);
    t=30001;expect(g.snapshot(idle).performanceActive).toBe(false);
    g.observeOnsets(1);expect(g.snapshot(idle).performanceActive).toBe(true);
    t+=30001;g.observeOnsets(1);expect(g.snapshot(idle).performanceActive).toBe(false);
  });
  it('defers for held notes even when there are no new onsets',()=>{
    let t=0;const g=new PerformanceGuard(()=>t,()=>t);
    g.noteOn('keyboard:1');t=120000;
    expect(g.snapshot(idle).performanceActive).toBe(true);
    g.noteOff('keyboard:1');t+=30001;
    expect(g.snapshot(idle).performanceActive).toBe(false);
  });
  it('defers while recording or an ambient bed is audible',()=>{
    let t=0;const g=new PerformanceGuard(()=>t,()=>t);t=40000;
    expect(g.snapshot({...idle,recording:true}).performanceActive).toBe(true);
    expect(g.snapshot({...idle,droneVolume:.1}).performanceActive).toBe(true);
    expect(g.snapshot({...idle,noiseVolume:.1}).performanceActive).toBe(true);
    expect(g.snapshot({...idle,paused:true,noiseVolume:.1}).performanceActive).toBe(false);
  });
});
