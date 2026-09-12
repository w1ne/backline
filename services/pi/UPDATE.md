# Recoverable Pi updates

`duet-update.timer` retries every two minutes. The root-owned updater uses a
nonblocking flock at `/home/test/duet-ai/.updates/lock`; overlapping attempts exit
without changes. No package installation is attempted unless `/api/status` reports
both `online: true` and `performanceActive: false`. The renderer computes activity
from real performance, including a quiet grace period, rather than its always-on
listening power state. Missing, malformed, disconnected, or old status defers.
The first deployment must bootstrap both the new renderer status and installer.

The public `pi-latest` COMMIT is discovery only. For a versioned installation the
GitHub compare API must confirm the candidate is ahead of the installed COMMIT;
behind, diverged, unknown and unavailable comparisons defer without downloading or
changing runtime files. Unversioned bootstrap has no ancestry to compare. An archive is unpacked into a private
staging directory; absolute paths, traversal, links and special files are rejected.
Required web, Pi and UNO Q paths and the exact 40-character COMMIT are validated.
A rolling-release upload race therefore fails without installing. The validated
package moves to a unique `.updates/releases/<commit>-<id>` directory and is never
modified. This binds the staged contents to the archive's COMMIT; it is not a
cryptographic signature or independent authenticity check.

Before installation the updater snapshots `site`, `services/pi`, `services/unoq`,
COMMIT, explicit renderer preferences, affected systemd unit files, and service enabled/active states under
`.updates/backups/<previous-commit>-<id>`. It rechecks performance after downloading
and after copying the snapshot. A durable `pending.json` records recovery before
runtime paths change. Those existing absolute paths are preserved for the installer,
web service and UNO Q sync. Release and backup copies are retained even on failure;
there is no automatic pruning. Operators must monitor disk space and remove only
unneeded historical directories when no update is running.

Installation must return success, then web and browser units must be active and
fresh renderer status must report `online: true` and `audioSuspended: false`.
Before COMMIT advances, the updater restores sound, genre, engine, creativity,
amount, ambient levels, enabled roles, mic mute, accompaniment presets and explicit
BPM/key overrides through local commands, then waits for matching renderer status.
Detected input, playback/power and recording are never replayed; missing override
fields from older renderers are not inferred. Rollback restores these preferences
too, while old journals without preference snapshots remain compatible. Toggle
commands are sent once per restoration, never retried on an ambiguous response.
Only then does COMMIT advance. Any failure restores the prior assets, COMMIT, unit
files and service state. Failed recovery retains its journal for the next retry.
The update timer stays active throughout installation and recovery, so an
interrupted updater process still has an automatic retry. An interrupted transaction
is recovered before checking performance status on the next invocation. Recovery deliberately precedes deferral because the runtime may
already be partially replaced or stopped.

The installer atomically refreshes `.updates/update-runner.py` under the update lock
on bootstrap/manual redeploy. During a pending transaction it skips that refresh
without taking the already-held lock; the updater publishes it after health passes.
The update service executes
that stable path so interrupted replacement of `services/pi` cannot remove its next
recovery entry point. A validated update replaces the stable runner. The shell entry
point remains available for manual invocation. Initial installation of these changes
must run `services/pi/install.sh` to install the new service definition.

Limits: this is a directory-copy transaction with a journal, not an atomic whole
filesystem swap. Playback can start between the final status sample and stopping
services; a future coordinated renderer maintenance lease could close this race.
Power-loss recovery occurs on the next updater invocation, not during boot before
other services start. Filesystem corruption, disk failure, arbitrary installer side
effects (such as apt packages), and external UNO Q firmware state cannot be undone by
these snapshots. The known installer does not update firmware. Health confirms local
web/renderer readiness, not audible output or remote model availability.

Run `python3 -m unittest discover -s services/pi -p test_update.py` for isolated
integration tests with mocked curl, systemctl and release installer. Optional
`DUET_UPDATE_HOME`, `DUET_UPDATE_SYSTEMD`, and `DUET_UPDATE_HEALTH_ATTEMPTS` settings
exist for sandbox tests; normal services use the fixed device defaults.
