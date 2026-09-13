// duet.ai hearts on the UNO Q 8x13 LED matrix. The Linux side (python/main.py) calls
// `beat(bpm, energy, mode, flags, sinceBarMs)` whenever the band changes; this sketch keeps
// its own beat clock and renders at ~40 fps so the pulse never depends on polling.
#include <Arduino_RouterBridge.h>

// The matrix driver lives in the board firmware; these are the symbols it exports
// (the Arduino_LED_Matrix library is a thin wrapper over them and is absent on older cores).
extern "C" void matrixBegin(void);
extern "C" void matrixSetGrayscaleBits(uint8_t bits);
extern "C" void matrixGrayscaleWrite(uint8_t* buf);

#define ROWS 8
#define COLS 13
#define LEVELS 7  // setGrayscaleBits(3): 0..7

enum Mode { OFFLINE = 0, LISTEN = 1, PLAY = 2 };
#define FLAG_FILL 1
#define FLAG_ANSWER 2

uint8_t frame[ROWS * COLS];

// Shared with the RPC callback; read once per frame.
volatile float g_bpm = 0;
volatile float g_energy = 0;
volatile int g_mode = OFFLINE;
volatile int g_flags = 0;
volatile unsigned long g_barRef = 0;   // millis() at which the current bar started
volatile unsigned long g_flagsAt = 0;

// Three heart sizes, centred on the 13-wide matrix; 'X' lit.
const char* HEART_S[] = {
  ".....X.X.....",
  "....XXXXX....",
  ".....XXX.....",
  "......X......",
};
const char* HEART_M[] = {
  "...XX...XX...",
  "..XXXX.XXXX..",
  "..XXXXXXXXX..",
  "...XXXXXXX...",
  "....XXXXX....",
  ".....XXX.....",
  "......X......",
};
const char* HEART_L[] = {
  ".XXXX...XXXX.",
  "XXXXXX.XXXXXX",
  "XXXXXXXXXXXXX",
  "XXXXXXXXXXXXX",
  ".XXXXXXXXXXX.",
  "..XXXXXXXXX..",
  "....XXXXX....",
  "......X......",
};

bool ping() { return true; }

volatile unsigned long g_demoStart = 0;
volatile unsigned long g_demoDuration = 0;

// A bounded preview uses its own clock, then returns to the latest band state.
bool demo(int seconds) {
  if (seconds < 0 || seconds > 3600) return false;
  g_demoStart = millis();
  g_demoDuration = (unsigned long)seconds * 1000;
  return true;
}

// Older UNO Q firmware does not export sinf, expf or fmodf to loaded sketches.
// Linking succeeds with those imports, but the runtime rejects the entire sketch.
float cyclePhase(float cycles) { return cycles - (unsigned long)cycles; }

float pulseDecay(float phase) {
  float remaining = 1.0f - phase;
  float squared = remaining * remaining;
  return squared * squared;
}

bool beat(float bpm, float energy, int mode, int flags, int sinceBarMs) {
  g_bpm = bpm;
  g_energy = energy;
  g_mode = mode;
  if (sinceBarMs >= 0) g_barRef = millis() - (unsigned long)sinceBarMs;
  if (flags != g_flags) g_flagsAt = millis();
  g_flags = flags;
  return true;
}

void clearFrame() { memset(frame, 0, sizeof(frame)); }

void px(int r, int c, int v) {
  if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return;
  if (v > LEVELS) v = LEVELS;
  if (v > frame[r * COLS + c]) frame[r * COLS + c] = v;
}

void blitHeart(const char** rows, int n, int level) {
  int top = (ROWS - n) / 2;
  for (int r = 0; r < n; r++)
    for (int c = 0; c < COLS; c++)
      if (rows[r][c] == 'X') px(top + r, c, level);
}

void drawHeart(float size, int level) {
  // size 0..1 picks S/M/L; the in-between sizes crossfade so the pulse reads as growth.
  if (size < 0.34f) blitHeart(HEART_S, 4, level);
  else if (size < 0.67f) blitHeart(HEART_M, 7, level);
  else blitHeart(HEART_L, 8, level);
}

uint32_t seed = 12345;
int rnd(int n) { seed = seed * 1103515245u + 12345u; return (seed >> 16) % n; }

void sparkles(int count, int level) {
  for (int i = 0; i < count; i++) px(rnd(ROWS), rnd(COLS), level);
}

// Small hearts rising from the bottom edge during a fill bar.
void burst(float t, int level) {
  for (int i = 0; i < 3; i++) {
    int c = 1 + i * 4 + ((i * 7) % 3);
    int r = ROWS - 1 - (int)(t * (ROWS + 3)) + i;
    px(r, c, level); px(r, c + 2, level); px(r + 1, c + 1, level);
  }
}

void render() {
  clearFrame();
  unsigned long now = millis();
  bool preview = g_demoDuration > 0 && now - g_demoStart < g_demoDuration;
  float e = preview ? 1.0f : g_energy;
  int mode = preview ? PLAY : g_mode;
  int flags = preview ? FLAG_ANSWER | (((now - g_demoStart) / 3000) % 2 ? FLAG_FILL : 0) : g_flags;
  switch (mode) {
    case OFFLINE:
      blitHeart(HEART_M, 7, 1);
      break;
    case LISTEN: {
      float breath = 0.5f + 0.5f * (float)sin((double)now / 1000.0 * 1.2);   // ~5 s cycle
      drawHeart(0.5f, 1 + (int)(breath * 4));
      break;
    }
    case PLAY: {
      float bpm = preview ? 156 : (g_bpm > 30 ? g_bpm : 120);
      float beatMs = 60000.0f / bpm;
      unsigned long sinceBar = now - (preview ? g_demoStart : g_barRef);
      float beatPhase = cyclePhase((float)sinceBar / beatMs);      // 0 at the beat
      float pulse = pulseDecay(beatPhase);                          // sharp attack, decay
      int beatIx = (int)(sinceBar / beatMs) % 4;
      float accent = beatIx == 0 ? 1.0f : 0.75f;                     // downbeat hits harder
      float size = 0.25f + 0.75f * e * pulse * accent;
      int level = 2 + (int)((LEVELS - 2) * (0.35f + 0.65f * pulse * accent));
      drawHeart(size, level);
      float barT = cyclePhase((float)sinceBar / (beatMs * 4));
      if (flags & FLAG_FILL) burst(barT, 3 + (int)(4 * pulse));
      if (flags & FLAG_ANSWER) sparkles(2 + (int)(4 * e), 4);
      break;
    }
  }
  matrixGrayscaleWrite(frame);
}

void setup() {
  Bridge.begin();
  matrixBegin();
  matrixSetGrayscaleBits(3);
  clearFrame();
  matrixGrayscaleWrite(frame);
}

// The router may not be ready to take registrations the instant setup() runs after a
// flash, so keep offering them until it accepts.
bool provided = false;
unsigned long lastProvide = 0;

void loop() {
  if (!provided && millis() - lastProvide > 500) {
    lastProvide = millis();
    provided = Bridge.provide("ping", ping) && Bridge.provide("beat", beat) && Bridge.provide("demo", demo);
  }
  render();
  delay(25);
}
