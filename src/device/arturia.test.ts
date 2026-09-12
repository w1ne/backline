import { describe, expect, it, vi } from 'vitest';
import { arturiaCommand, applyArturiaCommand, LOCAL_SOUNDS } from './arturia';

describe('MiniLab control mapping', () => {
  it('offers real sampled instruments', () => {
    expect(LOCAL_SOUNDS).toEqual(['grand', 'electric_piano_1', 'drawbar_organ', 'acoustic_guitar_nylon', 'string_ensemble_1', 'vibraphone']);
  });
  it('uses the main encoder for relative sound selection and ignores the fader', () => {
    expect(arturiaCommand('Minilab3 MIDI', [0xb0,114,65])).toEqual({field:'soundStep',value:1});
    expect(arturiaCommand('Minilab3 MIDI', [0xb0,114,63])).toEqual({field:'soundStep',value:-1});
    expect(arturiaCommand('Minilab3 MIDI', [0xb0,28,65])).toEqual({field:'soundStep',value:1});
    expect(arturiaCommand('Minilab3 MIDI', [0xb0,86,127])).toEqual({field:'noiseVolume',value:1});
    expect(arturiaCommand('Minilab3 MIDI', [0xb0,114,64])).toBeNull();
    expect(arturiaCommand('Minilab3 MIDI', [0xb0,82,127])).toBeNull();
    const setSound = vi.fn();
    applyArturiaCommand({field:'soundStep',value:1}, {sound:LOCAL_SOUNDS[LOCAL_SOUNDS.length - 1]}, {setSound} as never);
    expect(setSound).toHaveBeenCalledWith(LOCAL_SOUNDS[0]);
  });
  it('leaves keys, pads, sustain, other devices and MCU ports alone', () => {
    for (const [name, data] of [['Minilab3 MIDI',[0x90,60,100]],['Minilab3 MIDI',[0xb0,64,127]],['MIDI out',[0xb0,82,127]],['Minilab3 MCU/HUI',[0xb0,82,127]]] as const)
      expect(arturiaCommand(name, data)).toBeNull();
  });
  it('maps control values and program changes without transport actions', () => {
    expect(arturiaCommand('Minilab3 MIDI',[0xb0,74,127])).toEqual({field:'noiseVolume',value:1});
    expect(arturiaCommand('Minilab3 MIDI',[0xb0,71,0])).toEqual({field:'droneVolume',value:0});
    expect(arturiaCommand('Minilab3 MIDI',[0xb0,87,127])).toEqual({field:'droneVolume',value:1});
    expect(arturiaCommand('Minilab3 MIDI',[0xc0,2])).toEqual({field:'sound',value:LOCAL_SOUNDS[2]});
    expect(arturiaCommand('Minilab3 MIDI',[0xc0,127])).toBeNull();
  });
  it('does not rebuild an already selected instrument', () => {
    const setSound=vi.fn();
    applyArturiaCommand({field:'sound',value:'synth'}, {sound:'synth'}, {setSound} as never);
    expect(setSound).not.toHaveBeenCalled();
    applyArturiaCommand({field:'sound',value:'synth_bell'}, {sound:'synth'}, {setSound} as never);
    expect(setSound).toHaveBeenCalledWith('synth_bell');
  });
});
