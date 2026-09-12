"""Sandbox integration tests: no device, systemd or network access."""
import fcntl
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('update.sh').resolve()
INSTALL_RUNNER = Path(__file__).with_name('install-update-runner.sh').resolve()
OLD, NEW = 'a' * 40, 'b' * 40

class UpdateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / 'home'
        self.units = self.root / 'units'
        self.bin = self.root / 'bin'
        for p in (self.home, self.units, self.bin): p.mkdir()
        for p in ('site/backline', 'services/pi', 'services/unoq'):
            (self.home / p).mkdir(parents=True)
        (self.home / 'site/backline/index.html').write_text('old')
        (self.home / 'services/unoq/version').write_text('old')
        (self.home / 'services/pi/install.sh').write_text('exit 0\n')
        (self.home / 'COMMIT').write_text(OLD)
        (self.home / '.updates').mkdir()
        (self.home / '.updates/update-runner.py').write_text('# old runner\n')
        (self.units / 'duet-web.service').write_text('old unit')
        self.status = self.root / 'status'
        self.status.write_text(json.dumps(dict(online=True, performanceActive=False, audioSuspended=False)))
        self.env = dict(os.environ, DUET_UPDATE_HOME=str(self.home), DUET_UPDATE_SYSTEMD=str(self.units),
                        DUET_UPDATE_HEALTH_ATTEMPTS='1', PATH=str(self.bin)+':'+os.environ['PATH'],
                        FIXTURE=str(self.root), DUET_INSTALL_RESULT='0')
        self.command('curl', '''#!/usr/bin/env python3
import os,sys,pathlib,shutil
r=pathlib.Path(os.environ['FIXTURE']); args=sys.argv[1:]; url=args[-1]
if url.endswith('/api/status'):
 print((r/'status').read_text()); sys.exit(0)
if url.endswith('/COMMIT'): print('b'*40); sys.exit(0)
shutil.copyfile(r/'release.tar.gz',args[args.index('-o')+1])
if os.environ.get('DUET_START_DURING_DOWNLOAD'): (r/'status').write_text('{"online":true,"performanceActive":true}')
''')
        self.command('systemctl', '#!/bin/sh\necho "$*" >> "$FIXTURE/systemctl.log"\ncase "$1" in is-enabled) echo enabled;; esac\nexit 0\n')
        self.archive()

    def command(self, name, body):
        path = self.bin / name; path.write_text(body); path.chmod(0o755)

    def archive(self, commit=NEW, extra=None):
        files = {'COMMIT': commit, 'services/pi/update.py': '# new runner\n', 'site/backline/index.html': 'new', 'services/unoq/version': 'new',
                 'services/pi/install.sh': '''#!/bin/bash
echo new-unit > "$DUET_UPDATE_SYSTEMD/duet-web.service"
if [ "${DUET_FAIL_HEALTH:-0}" = 1 ]; then echo '{"online":false}' > "$FIXTURE/status"; fi
exit "$DUET_INSTALL_RESULT"
'''}
        if extra: files.update(extra)
        with tarfile.open(self.root / 'release.tar.gz', 'w:gz') as archive:
            for name, value in files.items():
                info = tarfile.TarInfo(name); data = value.encode(); info.size = len(data)
                archive.addfile(info, io.BytesIO(data))

    def run_update(self):
        return subprocess.run(['bash', str(SCRIPT)], env=self.env, text=True, capture_output=True)

    def assert_old(self):
        self.assertEqual((self.home / 'COMMIT').read_text().strip(), OLD)
        self.assertEqual((self.home / 'site/backline/index.html').read_text(), 'old')
        self.assertEqual((self.home / 'services/unoq/version').read_text(), 'old')
        self.assertEqual((self.units / 'duet-web.service').read_text(), 'old unit')
        self.assertEqual((self.home / '.updates/update-runner.py').read_text(), '# old runner\n')

    def test_success_retains_previous_and_advances_commit(self):
        result = self.run_update(); self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.home / 'COMMIT').read_text().strip(), NEW)
        self.assertEqual((self.home / 'site/backline/index.html').read_text(), 'new')
        self.assertEqual((self.home / '.updates/update-runner.py').read_text(), '# new runner\n')
        backups = list((self.home / '.updates/backups').glob('*/site/backline/index.html'))
        self.assertEqual([p.read_text() for p in backups], ['old'])

    def test_failed_install_rolls_back_and_can_retry(self):
        self.env['DUET_INSTALL_RESULT'] = '1'
        self.assertNotEqual(self.run_update().returncode, 0)
        self.assert_old()
        self.env['DUET_INSTALL_RESULT'] = '0'
        result = self.run_update(); self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.home / 'COMMIT').read_text().strip(), NEW)

    def test_health_failure_rolls_back(self):
        self.env['DUET_FAIL_HEALTH'] = '1'
        self.assertNotEqual(self.run_update().returncode, 0)
        self.assert_old()
        self.assertTrue((self.home / '.updates/backups').is_dir())

    def test_active_or_unknown_status_defers(self):
        for status in ({'online': True, 'performanceActive': True}, {'online': True}, {'online': False}, {}):
            self.status.write_text(json.dumps(status))
            result = self.run_update(); self.assertEqual(result.returncode, 0, result.stderr)
            self.assert_old()
            self.assertFalse((self.root / 'systemctl.log').exists())

    def test_performance_started_during_download_defers(self):
        self.env['DUET_START_DURING_DOWNLOAD'] = '1'
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_old()
        self.assertFalse((self.root / 'systemctl.log').exists())

    def test_mismatched_archive_never_installs(self):
        self.archive(commit='c'*40)
        self.assertNotEqual(self.run_update().returncode, 0)
        self.assert_old()
        self.assertFalse((self.root / 'systemctl.log').exists())

    def test_traversal_archive_rejected(self):
        self.archive(extra={'../escaped': 'bad'})
        self.assertNotEqual(self.run_update().returncode, 0)
        self.assert_old()
        self.assertFalse((self.home / '.updates/escaped').exists())

    def test_interrupted_install_recovers_before_next_status_gate(self):
        self.archive(extra={'services/pi/install.sh': 'kill -KILL "$PPID"\n'})
        result = self.run_update()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.home / '.updates/pending.json').exists())
        self.status.write_text('{"online": false}')
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_old()
        self.assertFalse((self.home / '.updates/pending.json').exists())

    def test_recovery_timer_is_never_stopped_during_failed_transaction(self):
        self.env['DUET_INSTALL_RESULT'] = '1'
        self.assertNotEqual(self.run_update().returncode, 0)
        self.assert_old()
        commands = (self.root / 'systemctl.log').read_text().splitlines()
        self.assertNotIn('stop duet-update.timer', commands)
        self.assertNotIn('disable duet-update.timer', commands)
        self.assertIn('stop duet-web.service', commands)

    def test_manual_install_refreshes_existing_stable_runner(self):
        (self.home / 'services/pi/update.py').write_text('# redeployed runner\n')
        result = subprocess.run(['bash', str(INSTALL_RUNNER), str(self.home)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.home / '.updates/update-runner.py').read_text(), '# redeployed runner\n')

    def test_transaction_installer_skips_runner_without_waiting_on_own_lock(self):
        (self.home / '.updates/pending.json').write_text('{}')
        with (self.home / '.updates/lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = subprocess.run(['bash', str(INSTALL_RUNNER), str(self.home)],
                                    capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.home / '.updates/update-runner.py').read_text(), '# old runner\n')

    def test_manual_runner_refresh_waits_for_update_lock(self):
        (self.home / 'services/pi/update.py').write_text('# redeployed runner\n')
        with (self.home / '.updates/lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            process = subprocess.Popen(['bash', str(INSTALL_RUNNER), str(self.home)],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                with self.assertRaises(subprocess.TimeoutExpired):
                    process.communicate(timeout=.2)
                self.assertEqual((self.home / '.updates/update-runner.py').read_text(), '# old runner\n')
                fcntl.flock(lock, fcntl.LOCK_UN)
                _, stderr = process.communicate(timeout=3)
                self.assertEqual(process.returncode, 0, stderr)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()
        self.assertEqual((self.home / '.updates/update-runner.py').read_text(), '# redeployed runner\n')

    def test_concurrent_run_defers(self):
        with (self.home / '.updates/lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_update(); self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_old()

if __name__ == '__main__': unittest.main()
