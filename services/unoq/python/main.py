"""Runs on the UNO Q's Linux side. Polls the duet.ai pedal and drives the sketch's `beat` RPC.

The pedal is reached through the container's host-gateway alias (msgpack-rpc-router) and `adb reverse` set up by the Pi
(services/pi/unoq-sync.sh); DUET_STATUS_URL overrides that for a Wi-Fi setup."""
import json
import os
import threading
import time
from urllib.request import urlopen

from arduino.app_utils import App, Bridge

import hearts

STATUS_URL = os.environ.get('DUET_STATUS_URL', 'http://msgpack-rpc-router:8088/api/status')
sender = hearts.Sender(Bridge.call)
offline = {'online': False}


def fetch_status():
    try:
        with urlopen(STATUS_URL, timeout=1) as response:
            return json.load(response)
    except (OSError, ValueError):
        return offline


def loop():
    status = fetch_status()
    try:
        sender.push(status, int(time.time() * 1000))
    except Exception as error:  # a failed RPC must not kill the poller
        print('beat rpc failed: ' + str(error), flush=True)
        sender.last = None
    time.sleep(0.2)


def forever():
    while True:
        loop()


# Older app_utils (board image 0.1.x) has no user_loop; App.run() only blocks the main thread.
threading.Thread(target=forever, daemon=True).start()
App.run()
