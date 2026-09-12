import { PI_EDITION } from './device/profile';

// LAN clients control the Pi; only its loopback kiosk starts the audio runtime.
const loopback = ['127.0.0.1','localhost','[::1]'].includes(location.hostname);
const remote = new URLSearchParams(location.search).get('control') === 'pi' || (PI_EDITION && !loopback);
if (remote) {
  void import('./device/remote').then(({startRemoteUI})=>startRemoteUI(document.getElementById('app')!));
} else {
  void import('./main');
}
