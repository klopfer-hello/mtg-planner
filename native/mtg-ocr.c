/*
 * mtg-ocr: a long-lived Tesseract helper for lib/ocr.js.
 *
 * Why: spawning `tesseract` per crop spends 66-95% of every call on process
 * start-up and model loading (83 ms eng, 151 ms deu+eng on a blank image).
 * This helper keeps one initialised TessBaseAPI per language set and answers
 * requests over stdin/stdout, doing exactly what the CLI does for
 * `tesseract stdin stdout -l <lang> --psm <psm> [-c tessedit_char_whitelist=..] tsv`
 * (pixReadMem, Init with the "tsv" config, SetPageSegMode, SetImage,
 * Recognize, TSV header + GetTsvText(0)), so the output is byte-identical.
 *
 * Protocol (all integers u32 little-endian):
 *   request:  "MOCR" psm lang_len wl_len img_len | lang | whitelist | image (PGM/PNG/... bytes)
 *   response: "MOCR" status len | payload   (status 0: TSV text, 1: error message)
 * A malformed request header ends the process (exit 2): the caller restarts it.
 *
 * Env: MTG_OCR_MAX_LANGS (default 4) = initialised language sets kept (LRU).
 * Build: cc -O2 -o mtg-ocr mtg-ocr.c $(pkg-config --cflags --libs tesseract lept)
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <tesseract/capi.h>
#include <leptonica/allheaders.h>

#define MAX_LANG 256
#define MAX_WL 4096
#define MAX_IMG (128u * 1024u * 1024u)
#define MAX_APIS 16

static const char TSV_HEADER[] =
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n";

typedef struct {
  char lang[MAX_LANG + 1];
  TessBaseAPI *api;
  unsigned long used;
} Entry;

static Entry apis[MAX_APIS];
static int max_apis = 4;
static unsigned long tick = 0;

static int read_full(void *buf, size_t n) {
  size_t got = 0;
  while (got < n) {
    size_t r = fread((char *)buf + got, 1, n - got, stdin);
    if (r == 0) return got == 0 ? 0 : -1; /* 0 = clean EOF before a request */
    got += r;
  }
  return 1;
}

static uint32_t le32(const unsigned char *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static void put32(uint32_t v) {
  unsigned char b[4] = {v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255};
  fwrite(b, 1, 4, stdout);
}

static void respond(uint32_t status, const char *a, size_t alen, const char *b, size_t blen) {
  fwrite("MOCR", 1, 4, stdout);
  put32(status);
  put32((uint32_t)(alen + blen));
  if (alen) fwrite(a, 1, alen, stdout);
  if (blen) fwrite(b, 1, blen, stdout);
  fflush(stdout);
}

static void respond_error(const char *msg) { respond(1, msg, strlen(msg), NULL, 0); }

static int valid_lang(const char *s) {
  if (!*s) return 0;
  for (; *s; s++)
    if (!((*s >= 'a' && *s <= 'z') || (*s >= 'A' && *s <= 'Z') || (*s >= '0' && *s <= '9') || *s == '_' || *s == '+' || *s == '-'))
      return 0;
  return 1;
}

/* The API for `lang`, initialised like the CLI (datapath default, OEM default, config "tsv"). */
static TessBaseAPI *api_for(const char *lang) {
  int free_slot = -1, lru = -1;
  for (int i = 0; i < max_apis; i++) {
    if (apis[i].api && strcmp(apis[i].lang, lang) == 0) {
      apis[i].used = ++tick;
      return apis[i].api;
    }
    if (!apis[i].api) { if (free_slot < 0) free_slot = i; }
    else if (lru < 0 || apis[i].used < apis[lru].used) lru = i;
  }
  int slot = free_slot >= 0 ? free_slot : lru;
  if (apis[slot].api) {
    TessBaseAPIEnd(apis[slot].api);
    TessBaseAPIDelete(apis[slot].api);
    apis[slot].api = NULL;
  }
  TessBaseAPI *api = TessBaseAPICreate();
  char *configs[] = {"tsv"};
  if (TessBaseAPIInit1(api, NULL, lang, OEM_DEFAULT, configs, 1) != 0) {
    TessBaseAPIDelete(api);
    return NULL;
  }
  strcpy(apis[slot].lang, lang);
  apis[slot].api = api;
  apis[slot].used = ++tick;
  return api;
}

int main(void) {
  const char *m = getenv("MTG_OCR_MAX_LANGS");
  if (m && atoi(m) > 0) max_apis = atoi(m) > MAX_APIS ? MAX_APIS : atoi(m);
  char lang[MAX_LANG + 1], wl[MAX_WL + 1];
  unsigned char hdr[20];
  for (;;) {
    int r = read_full(hdr, sizeof hdr);
    if (r == 0) return 0;
    if (r < 0 || memcmp(hdr, "MOCR", 4) != 0) return 2;
    uint32_t psm = le32(hdr + 4), lang_len = le32(hdr + 8), wl_len = le32(hdr + 12), img_len = le32(hdr + 16);
    if (lang_len > MAX_LANG || wl_len > MAX_WL || img_len > MAX_IMG || psm > 13) return 2;
    unsigned char *img = malloc(img_len ? img_len : 1);
    if (!img) return 3;
    if (read_full(lang, lang_len) < 0 || read_full(wl, wl_len) < 0 || read_full(img, img_len) < 0) return 2;
    lang[lang_len] = 0;
    wl[wl_len] = 0;

    if (!valid_lang(lang)) { free(img); respond_error("invalid language"); continue; }
    PIX *pix = pixReadMem(img, img_len);
    free(img);
    if (!pix) { respond_error("unreadable image"); continue; }
    TessBaseAPI *api = api_for(lang);
    if (!api) { pixDestroy(&pix); respond_error("failed loading language"); continue; }

    TessBaseAPISetVariable(api, "tessedit_char_whitelist", wl);
    TessBaseAPISetPageSegMode(api, (TessPageSegMode)psm);
    TessBaseAPISetImage2(api, pix);
    char *tsv = TessBaseAPIRecognize(api, NULL) == 0 ? TessBaseAPIGetTsvText(api, 0) : NULL;
    if (tsv) {
      respond(0, TSV_HEADER, sizeof TSV_HEADER - 1, tsv, strlen(tsv));
      TessDeleteText(tsv);
    } else {
      respond_error("recognition failed");
    }
    TessBaseAPIClear(api);
    pixDestroy(&pix);
  }
}
