# Wiring form.py into server.py

`form.py` is a pure, faithful port of `src/band/form.ts`'s `SongForm` (see
`test_form.py` for the ported test suite). It is not wired into `server.py`
yet. For the service to own song form, `server.py` needs to:

1. Read `intensity` and `silenceBeats` from the client's `set` message.
   Both are optional floats; when absent, keep the last known value (or
   default `intensity` to `0` and `silenceBeats` to `0` on first use, same
   as the client's own `IDLE_DYNAMICS`).
2. Keep one `SongForm` instance per connection, alongside the existing
   per-connection state (lookahead/commit scheduler, key/chord, etc.).
   Call `form.reset()` wherever the connection's own state is reset (e.g.
   on `start`).
3. Tick the form once per bar -- not once per half-bar commit -- with the
   current absolute bar number, the last-known `intensity`, the last-known
   `silenceBeats`, and `playerStopped` (`False` unless the service has its
   own way to detect the player going away; the client's silence-beats
   threshold already covers the normal quiet-ending case).
4. Put the resulting `section` (`result["section"]`) in every `plan`
   message the service sends, alongside the existing `chord`/`chordFrom`
   fields from harmony.py. Optional field: an old client ignores it.
5. When `section` is `"ending"` and then `"ended"`, keep sending plan
   messages as usual; the client stops the band on its own once it sees
   `ending` the same way it does today with the local form.
