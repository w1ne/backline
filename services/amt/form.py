"""Song form: intro -> groove -> (lift | breakdown)* -> ending -> ended.

AMT owns this form; local pattern engines retain src/band/form.ts. Pure state driven by (bar, intensity,
silenceBeats, playerStopped) -- no clock access -- so the same sequence of
inputs always produces the same sequence of sections.
"""

INTRO_BARS = 2
# bars of sustained intensity before the form reacts
HYSTERESIS_BARS = 4
LIFT_INTENSITY = 0.7
BREAKDOWN_INTENSITY = 0.3
# four full 4-beat bars of silence: a singer's breath between phrases is two, and a
# false ending restarts with a count-in, which is far worse than a late one
ENDING_SILENCE_BEATS = 16
SECTION_BARS = 8
STEADY_SECTIONS = ("groove", "lift", "breakdown")

NO_ARRANGEMENT = {"intro": False, "lift": False, "breakdown": False, "ending": False}


def _arrangement_for(section):
    return {
        "intro": section == "intro",
        "lift": section == "lift",
        "breakdown": section == "breakdown",
        "ending": section == "ending",
    }


class SongForm:
    def __init__(self):
        self.reset()

    def reset(self, start_bar=0):
        """Start a new song while retaining the client's absolute transport."""
        self.section = "intro"
        self.high_streak = 0
        self.low_streak = 0
        self.last_bar = None
        self.last_result = None
        self.start_bar = start_bar

    def tick(self, bar, intensity, silence_beats, player_stopped=False):
        # Half-bar cues and retries cannot count as extra bars or consume the ending.
        if self.last_bar is not None and bar <= self.last_bar:
            return {**self.last_result, "arrangement": dict(self.last_result["arrangement"])}
        result = self._tick(max(0, bar - self.start_bar), intensity, silence_beats, player_stopped)
        self.last_bar = bar
        self.last_result = result
        return {**result, "arrangement": dict(result["arrangement"])}

    def _tick(self, bar, intensity, silence_beats, player_stopped=False):
        if self.section == "ending":
            # The ending bar has already played; this and every later tick until
            # reset() is idle.
            self.section = "ended"
            return {"section": "ended", "arrangement": NO_ARRANGEMENT, "shouldStop": False}
        if self.section == "ended":
            return {"section": "ended", "arrangement": NO_ARRANGEMENT, "shouldStop": False}

        self.high_streak = self.high_streak + 1 if intensity > LIFT_INTENSITY else 0
        self.low_streak = self.low_streak + 1 if intensity < BREAKDOWN_INTENSITY else 0

        if self.section == "intro":
            if bar >= INTRO_BARS:
                self.section = "groove"
            else:
                return {"section": "intro", "arrangement": _arrangement_for("intro"), "shouldStop": False}

        if player_stopped or silence_beats >= ENDING_SILENCE_BEATS:
            self.section = "ending"
            return {"section": "ending", "arrangement": _arrangement_for("ending"), "shouldStop": True}

        if self.high_streak >= HYSTERESIS_BARS:
            self.section = "lift"
        elif self.low_streak >= HYSTERESIS_BARS:
            self.section = "breakdown"
        else:
            # Sustained performer energy wins; otherwise develop an eight-bar arc.
            # Derive from transport bars so skipped cues do not slow the form.
            phase = max(0, bar - INTRO_BARS) // SECTION_BARS
            self.section = STEADY_SECTIONS[phase % len(STEADY_SECTIONS)]

        return {"section": self.section, "arrangement": _arrangement_for(self.section), "shouldStop": False}
