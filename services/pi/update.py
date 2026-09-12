#!/usr/bin/env python3
"""Fail-closed Pi updates, retaining complete assets and systemd rollback snapshots."""
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import uuid

HOME = Path(os.environ.get('DUET_UPDATE_HOME', '/home/test/duet-ai'))
UNITS = Path(os.environ.get('DUET_UPDATE_SYSTEMD', '/etc/systemd/system'))
STATE = HOME / '.updates'
BASE = 'https://github.com/w1ne/duet.ai/releases/download/pi-latest'
PATHS = ('site', 'services/pi', 'services/unoq', 'COMMIT')
SERVICES = ('duet-web.service', 'duet-browser.service', 'duet-lcd.service',
            'duet-arturia.service', 'duet-unoq.service', 'duet-update.timer',
            'PiMorpho.service', 'duet-amt.service')
UNIT_FILES = (*SERVICES, 'duet-update.service')


def run(*args, check=True):
    return subprocess.run(args, check=check, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def persist(path, content):
    """Publish the journal/commit atomically and flush before dependent mutations."""
    tmp = path.with_name(path.name + '.tmp')
    with tmp.open('w') as output:
        output.write(content)
        output.flush()
        os.fsync(output.fileno())
    tmp.replace(path)
    os.sync()


def status():
    try:
        value = json.loads(run('curl', '-fsSL', '--max-time', '3',
                               'http://127.0.0.1:8088/api/status').stdout)
        return value if isinstance(value, dict) else {}
    except (subprocess.CalledProcessError, ValueError):
        return {}


def idle():
    value = status()
    return value.get('online') is True and value.get('performanceActive') is False


def copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.is_symlink():
        target.symlink_to(os.readlink(source))
    elif source.is_dir():
        shutil.copytree(source, target, symlinks=True)
    elif source.exists():
        shutil.copy2(source, target)


def remove(path):
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def replace(source, target):
    # A complete backup and durable journal precede every runtime mutation.
    staged = target.with_name(target.name + '.update-new')
    remove(staged)
    copy(source, staged)
    if (staged.is_file() or staged.is_symlink()) and not (target.is_dir() and not target.is_symlink()):
        staged.replace(target)  # Keep the stable recovery entry point continuously present.
    else:
        remove(target)
        if staged.exists() or staged.is_symlink():
            staged.rename(target)


def snapshot(backup):
    backup.mkdir(parents=True)
    for name in PATHS:
        copy(HOME / name, backup / name)
    copy(STATE / 'update-runner.py', backup / 'update-runner.py')
    for name in UNIT_FILES:
        copy(UNITS / name, backup / 'units' / name)
    service_state = {}
    for name in SERVICES:
        enabled = run('systemctl', 'is-enabled', name, check=False).stdout.strip()
        active = run('systemctl', 'is-active', '--quiet', name, check=False).returncode == 0
        service_state[name] = {'enabled': enabled, 'active': active}
    persist(backup / 'service-state.json', json.dumps(service_state))


def stop_services():
    # Never stop this updater's service: its executing process owns recovery.
    for name in SERVICES:
        if run('systemctl', 'is-active', '--quiet', name, check=False).returncode == 0:
            run('systemctl', 'stop', name)


def rollback(backup):
    print('update: restoring known-good snapshot', backup, flush=True)
    stop_services()
    # Remove enablement links the failed installer may have introduced.
    for name in SERVICES:
        run('systemctl', 'disable', name, check=False)
    for name in PATHS:
        replace(backup / name, HOME / name)
    for name in UNIT_FILES:
        replace(backup / 'units' / name, UNITS / name)
    if (backup / 'update-runner.py').exists():
        replace(backup / 'update-runner.py', STATE / 'update-runner.py')
    run('systemctl', 'daemon-reload')
    for name, state in json.loads((backup / 'service-state.json').read_text()).items():
        if state['enabled'] in ('enabled', 'enabled-runtime'):
            args = ('--runtime',) if state['enabled'] == 'enabled-runtime' else ()
            run('systemctl', 'enable', *args, name)
        elif state['enabled'] == 'disabled':
            run('systemctl', 'disable', name)
        if state['active']:
            run('systemctl', 'start', name)
    (STATE / 'pending.json').unlink()
    os.sync()


def extract(archive, target, commit):
    with tarfile.open(archive, 'r:gz') as package:
        members = package.getmembers()
        for member in members:
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or not (member.isdir() or member.isfile()):
                raise ValueError('unsafe archive member: ' + member.name)
            allowed = (path == Path('.') or path == Path('COMMIT') or
                       path.parts[0] in ('site', 'services'))
            if not allowed:
                raise ValueError('unexpected archive member: ' + member.name)
        package.extractall(target, members=members)
    for name in ('site/backline/index.html', 'services/pi/install.sh', 'COMMIT'):
        if not (target / name).is_file():
            raise ValueError('release missing ' + name)
    if not (target / 'services/unoq').is_dir():
        raise ValueError('release missing services/unoq')
    if (target / 'COMMIT').read_text().strip() != commit:
        raise ValueError('archive COMMIT differs from discovered release; retry next timer')


def healthy():
    attempts = int(os.environ.get('DUET_UPDATE_HEALTH_ATTEMPTS', '30'))
    for attempt in range(attempts):
        value = status()
        if (value.get('online') is True and value.get('audioSuspended') is False
                and all(run('systemctl', 'is-active', '--quiet', name, check=False).returncode == 0
                        for name in ('duet-web.service', 'duet-browser.service'))):
            return True
        if attempt < attempts - 1:
            time.sleep(1)
    return False


def update():
    pending = STATE / 'pending.json'
    if pending.exists():
        rollback(Path(json.loads(pending.read_text())['backup']))
    if not idle():
        print('update: deferred; performance active or renderer status unavailable')
        return
    try:
        latest = run('curl', '-fsSL', '--max-time', '20', BASE + '/COMMIT').stdout.strip()
    except subprocess.CalledProcessError:
        print('update: release unreachable; retry next timer')
        return
    if not re.fullmatch(r'[0-9a-f]{40}', latest):
        raise ValueError('invalid release commit')
    current = (HOME / 'COMMIT').read_text().strip() if (HOME / 'COMMIT').exists() else ''
    if latest == current:
        return
    releases = STATE / 'releases'
    releases.mkdir(exist_ok=True)
    # Unique versioned directories are never overwritten, including after a failed retry.
    release = releases / (latest + '-' + uuid.uuid4().hex)
    with tempfile.TemporaryDirectory(prefix='.stage-', dir=STATE) as staging:
        staging = Path(staging)
        archive = staging / 'release.tar.gz'
        run('curl', '-fsSL', '--max-time', '600', '-o', str(archive), BASE + '/duet-pi.tar.gz')
        extract(archive, staging / 'package', latest)
        (staging / 'package').rename(release)
    if not idle():
        print('update: deferred; performance started during download')
        return
    previous = current if re.fullmatch(r'[0-9a-f]{40}', current) else 'unversioned'
    backup = STATE / 'backups' / (previous + '-' + uuid.uuid4().hex)
    snapshot(backup)
    # Recheck after the potentially slow snapshot, immediately before interruption.
    if not idle():
        print('update: deferred; performance started during snapshot')
        return
    persist(pending, json.dumps({'backup': str(backup), 'release': str(release)}))
    try:
        stop_services()
        for name in PATHS[:-1]:
            replace(release / name, HOME / name)
        # Installer retains its existing absolute path and UNO Q relative layout.
        run('bash', str(HOME / 'services/pi/install.sh'))
        if not healthy():
            raise RuntimeError('web/renderer health check failed')
        if (HOME / 'services/pi/update.py').is_file():
            replace(HOME / 'services/pi/update.py', STATE / 'update-runner.py')
        persist(HOME / 'COMMIT', latest + '\n')
        pending.unlink()
        os.sync()
        print('update: installed and validated', latest)
    except BaseException:
        rollback(backup)
        raise


def main():
    STATE.mkdir(parents=True, exist_ok=True)
    with (STATE / 'lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('update: another attempt is running')
            return
        update()


if __name__ == '__main__':
    main()
