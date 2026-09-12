"""Headless mido backend: no ALSA on the pod, so MIDI out is a no-op. Used via MIDO_BACKEND=nullmidi."""
from mido.ports import BaseInput, BaseOutput

def get_devices(**kwargs):
    return [{"name": "null", "is_input": True, "is_output": True}]

class Input(BaseInput):
    def _open(self, **kwargs): pass
    def _receive(self, block=True): return None

class Output(BaseOutput):
    def _open(self, **kwargs): pass
    def _send(self, message): pass
