/* VOXMIDI MIDI file writer: session note events -> Standard MIDI File.
 * Pure logic, no DOM. Node-testable. */

function writeVLQ(value, out) {
  let v = Math.max(0, Math.round(value));
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) { bytes.unshift((v & 0x7f) | 0x80); v >>= 7; }
  // Set continuation bits on all but the last byte.
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
  for (const b of bytes) out.push(b & 0xff);
}

function writeU16(v, out) { out.push((v >> 8) & 0xff, v & 0xff); }
function writeU32(v, out) {
  out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}
function writeAscii(s, out) { for (const c of s) out.push(c.charCodeAt(0) & 0x7f); }

/**
 * events: [{t: seconds, type: 'on'|'off', note: 0-127, vel: 0-127, ch: 0-15}]
 * Returns Uint8Array with a complete Type-0 SMF (one track, 120 BPM default).
 */
export function eventsToSMF(events, opts = {}) {
  const bpm = opts.bpm ?? 120;
  const tpq = opts.tpq ?? 480;
  const defaultCh = (opts.channel ?? 0) & 0x0f;

  const sorted = [...events].sort((a, b) => a.t - b.t || (a.type === 'off' ? -1 : 1));
  const ticksPerSec = tpq * (bpm / 60);

  const track = [];
  // Tempo meta event: microseconds per quarter note.
  writeVLQ(0, track);
  track.push(0xff, 0x51, 0x03);
  const mpq = Math.round(60000000 / bpm);
  track.push((mpq >> 16) & 0xff, (mpq >> 8) & 0xff, mpq & 0xff);
  // Track name.
  writeVLQ(0, track);
  const name = 'VOXMIDI';
  track.push(0xff, 0x03, name.length);
  writeAscii(name, track);

  let lastTick = 0;
  for (const e of sorted) {
    const tick = Math.round(e.t * ticksPerSec);
    writeVLQ(Math.max(0, tick - lastTick), track);
    lastTick = tick;
    const note = Math.max(0, Math.min(127, Math.round(e.note)));
    const ch = (e.ch ?? defaultCh) & 0x0f;
    if (e.type === 'on') {
      track.push(0x90 | ch, note, Math.max(1, Math.min(127, e.vel ?? 90)));
    } else {
      track.push(0x80 | ch, note, 0x40);
    }
  }
  // End of track.
  writeVLQ(0, track);
  track.push(0xff, 0x2f, 0x00);

  const out = [];
  writeAscii('MThd', out); writeU32(6, out); writeU16(0, out);
  writeU16(1, out); writeU16(tpq, out);
  writeAscii('MTrk', out); writeU32(track.length, out);
  out.push(...track);
  return Uint8Array.from(out);
}

/** Quick structural check used by tests: returns {ok, tracks, tpq}. */
export function inspectSMF(bytes) {
  const s = String.fromCharCode(...bytes.slice(0, 4));
  if (s !== 'MThd') return { ok: false };
  const format = (bytes[8] << 8) | bytes[9];
  const tracks = (bytes[10] << 8) | bytes[11];
  const tpq = (bytes[12] << 8) | bytes[13];
  const t = String.fromCharCode(...bytes.slice(14, 18));
  return { ok: t === 'MTrk', format, tracks, tpq };
}
