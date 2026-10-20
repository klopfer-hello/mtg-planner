// Shared bits of the scanner staging tests (scans, scans-capture, probe,
// learning, server-capture-api): index-style printings from the Scryfall
// fixtures and a tiny valid JPEG for upload routes.

/** A fixture Scryfall card as a card-index printing (non-foil + foil). */
export const asPrinting = (c, extra = {}) => ({
  id: c.id, oracle_id: c.oracle_id, name: c.name, printed_name: null, lang: c.lang, set_code: c.set, set_name: c.set_name,
  collector_number: c.collector_number, rarity: c.rarity, finishes: ["nonfoil", "foil"], faces: [], type_line: c.type_line,
  mana_cost: c.mana_cost, ...extra,
});

/** A 64x64 baseline JPEG header with filler (passes the upload checks; not decodable). */
export function fakeJpeg() {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x40, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(200, 0x55), Buffer.from([0xff, 0xd9])]);
}
