/* Minimal libretro frontend shim, driven from JS. */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdarg.h>
#include <emscripten.h>
#include "libretro.h"

static uint16_t g_input[8];
static const void *g_fb; static unsigned g_w, g_h; static size_t g_pitch;
static int16_t *g_audio; static size_t g_audio_cap, g_audio_frames;
static unsigned g_pixfmt = RETRO_PIXEL_FORMAT_0RGB1555;
static char g_sysdir[]  = "/fbneo/system";
static char g_savedir[] = "/fbneo/save";

/* descriptors we capture so JS can build its own mapping */
#define MAXDESC 256
static struct { unsigned port, device, index, id; char desc[64]; } g_desc[MAXDESC];
static unsigned g_desc_n;

static void log_cb(enum retro_log_level lvl, const char *fmt, ...) {
  (void)lvl; va_list ap; va_start(ap, fmt); vprintf(fmt, ap); va_end(ap);
}

static bool env_cb(unsigned cmd, void *data) {
  switch (cmd) {
  case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: {
    unsigned f = *(const unsigned *)data;
    if (f == RETRO_PIXEL_FORMAT_XRGB8888 || f == RETRO_PIXEL_FORMAT_RGB565) { g_pixfmt = f; return true; }
    return false;
  }
  case RETRO_ENVIRONMENT_GET_VARIABLE: {
    struct retro_variable *v = (struct retro_variable *)data;
    if (v && v->key && !strcmp(v->key, "fbneo-allow-depth-32")) { v->value = "enabled"; return true; }
    if (v) v->value = 0;
    return false;
  }
  case RETRO_ENVIRONMENT_GET_CAN_DUPE:            *(bool*)data = true;  return true;
  case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:                             return true;
  case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:    *(const char**)data = g_sysdir;  return true;
  case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:      *(const char**)data = g_savedir; return true;
  case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
    ((struct retro_log_callback*)data)->log = log_cb; return true;
  case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS: {
    const struct retro_input_descriptor *d = (const struct retro_input_descriptor*)data;
    g_desc_n = 0;
    for (; d && d->description && g_desc_n < MAXDESC; d++, g_desc_n++) {
      g_desc[g_desc_n].port = d->port; g_desc[g_desc_n].device = d->device;
      g_desc[g_desc_n].index = d->index; g_desc[g_desc_n].id = d->id;
      snprintf(g_desc[g_desc_n].desc, 64, "%s", d->description);
    }
    return true;
  }
  default: return false;                /* everything else: unsupported */
  }
}

static void video_cb(const void *data, unsigned w, unsigned h, size_t pitch) {
  if (data) g_fb = data;                /* NULL == dupe previous frame */
  g_w = w; g_h = h; g_pitch = pitch;
}
static size_t audio_batch_cb(const int16_t *data, size_t frames) {
  if (frames * 2 > g_audio_cap) { g_audio_cap = frames * 4; g_audio = realloc(g_audio, g_audio_cap * 2); }
  memcpy(g_audio, data, frames * 4); g_audio_frames = frames; return frames;
}
static void audio_cb(int16_t l, int16_t r) { (void)l; (void)r; }
static void input_poll_cb(void) {}
static int16_t input_state_cb(unsigned port, unsigned device, unsigned index, unsigned id) {
  (void)index;
  if (device != RETRO_DEVICE_JOYPAD || port >= 8) return 0;
  if (id == RETRO_DEVICE_ID_JOYPAD_MASK) return (int16_t)g_input[port];
  return (g_input[port] >> id) & 1;
}

EMSCRIPTEN_KEEPALIVE void fe_install(void) {
  retro_set_environment(env_cb);
  retro_set_video_refresh(video_cb);
  retro_set_audio_sample(audio_cb);
  retro_set_audio_sample_batch(audio_batch_cb);
  retro_set_input_poll(input_poll_cb);
  retro_set_input_state(input_state_cb);
}
EMSCRIPTEN_KEEPALIVE int fe_load(const char *path) {
  struct retro_game_info gi; memset(&gi, 0, sizeof gi); gi.path = path;
  return retro_load_game(&gi) ? 1 : 0;
}
EMSCRIPTEN_KEEPALIVE void     fe_set_input(unsigned p, unsigned m) { if (p < 8) g_input[p] = (uint16_t)m; }
EMSCRIPTEN_KEEPALIVE const void* fe_fb(void)      { return g_fb; }
EMSCRIPTEN_KEEPALIVE unsigned    fe_w(void)       { return g_w; }
EMSCRIPTEN_KEEPALIVE unsigned    fe_h(void)       { return g_h; }
EMSCRIPTEN_KEEPALIVE unsigned    fe_pitch(void)   { return (unsigned)g_pitch; }
EMSCRIPTEN_KEEPALIVE unsigned    fe_pixfmt(void)  { return g_pixfmt; }
EMSCRIPTEN_KEEPALIVE const void* fe_audio(void)   { return g_audio; }
EMSCRIPTEN_KEEPALIVE unsigned    fe_audio_frames(void) { return (unsigned)g_audio_frames; }
EMSCRIPTEN_KEEPALIVE double      fe_fps(void)     { struct retro_system_av_info a; retro_get_system_av_info(&a); return a.timing.fps; }
EMSCRIPTEN_KEEPALIVE double      fe_srate(void)   { struct retro_system_av_info a; retro_get_system_av_info(&a); return a.timing.sample_rate; }
EMSCRIPTEN_KEEPALIVE unsigned    fe_ndesc(void)   { return g_desc_n; }
EMSCRIPTEN_KEEPALIVE const char* fe_desc(unsigned i, unsigned *port, unsigned *id) {
  if (i >= g_desc_n) return 0; *port = g_desc[i].port; *id = g_desc[i].id; return g_desc[i].desc;
}
