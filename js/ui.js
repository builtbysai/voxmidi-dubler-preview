/* VOXMIDI UI: onboarding wizard + tabbed studio (Play / Train / Setup).
 * Browser-only. The DSP engine (engine.js) is untouched; this file owns
 * the Dubler-style performance screen around it. */
import { AudioEngine, SCALES, NOTE_NAMES } from './engine.js';
import { midiToName } from './pitch.js';
import { extractFeatures, DEFAULT_TEMPLATES } from './drums.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const store = {
  get(k, d) { try { const v = localStorage.getItem('voxmidi.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('voxmidi.' + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem('voxmidi.' + k); } catch (e) {} },
};

const app = {
  engine: null,
  step: 0,
  lockedNote: null,   // first stable note in the hum test
  lastNote: null,
  roll: [],           // {midi, start, end} session notes for the piano roll
  training: null,     // {kind, takes:[], need}
  tab: 'play',
  wheelPc: null,      // detected pitch class 0..11 (from onPitch)
  wheelCents: 0,
  wheelNote: '–',     // note name shown in wheel center
  activePc: null,     // pitch class of the sounding note (from onNote)
  lastAriaNote: '',
};

function fmtNote(midi) {
  const n = midiToName(Math.round(midi));
  return { letter: n.slice(0, -1), octave: n.slice(-1), pc: ((Math.round(midi) % 12) + 12) % 12 };
}

/* ---------------- onboarding (unchanged flow) ---------------- */

const STEPS = ['welcome', 'mic', 'level', 'hum'];

function showStep(i) {
  app.step = i;
  $$('.ob-step').forEach(el => el.hidden = true);
  $('#ob-' + STEPS[i]).hidden = false;
  $$('.ob-dot').forEach((d, j) => d.classList.toggle('on', j <= i));
  $('#ob-back').style.visibility = i === 0 ? 'hidden' : 'visible';
}

function enterStudio() {
  store.set('onboarded', true);
  $('#onboarding').hidden = true;
  $('#studio').hidden = false;
  sizeCanvases();
  paintScale();
  refreshMicUI();
  refreshStatus();
  app.engine.ui.onState(app.engine.running ? 'live' : 'idle');
}

async function refreshMicUI() {
  const btns = [$('#btn-mic-studio'), $('#btn-train-mic')].filter(Boolean);
  const status = $('#mic-studio-status');
  const sel = $('#mic-select-studio');
  const note = $('#train-mic-note');
  if (app.engine.running) {
    btns.forEach(b => { b.textContent = b.id === 'btn-train-mic' ? 'Enable it' : 'Stop microphone'; });
    $('#btn-mic-studio').textContent = 'Stop microphone';
    status.textContent = 'Microphone is live.';
    note.hidden = true;
    try {
      const mics = await app.engine.listMics();
      if (mics.length > 1) {
        sel.hidden = false;
        $('#mic-select-studio-label').hidden = false;
        sel.innerHTML = '';
        mics.forEach(m => {
          const o = document.createElement('option');
          o.value = m.id; o.textContent = m.label;
          sel.appendChild(o);
        });
      }
    } catch (e) {}
  } else {
    $('#btn-mic-studio').textContent = 'Enable microphone';
    status.textContent = 'Microphone is off.';
    sel.hidden = true;
    $('#mic-select-studio-label').hidden = true;
    note.hidden = false;
  }
  refreshStatus();
}

async function enableMic() {
  const btn = $('#btn-mic');
  btn.disabled = true;
  btn.textContent = 'Waiting for the browser…';
  try {
    await app.engine.startMic($('#mic-select').value || null);
    const mics = await app.engine.listMics();
    const sel = $('#mic-select');
    sel.innerHTML = '';
    mics.forEach(m => {
      const o = document.createElement('option');
      o.value = m.id; o.textContent = m.label;
      sel.appendChild(o);
    });
    sel.hidden = mics.length < 2 ? true : false;
    $('#mic-select-label').hidden = mics.length < 2;
    $('#mic-hint').textContent = mics.length + (mics.length === 1 ? ' microphone found.' : ' microphones found.');
    btn.textContent = 'Microphone on';
    $('#btn-to-level').disabled = false;
    showStep(2);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Enable microphone';
    $('#mic-error').hidden = false;
    $('#mic-error').textContent = 'The browser blocked microphone access. Click the camera icon in the address bar, allow the microphone, then try again.';
  }
}

async function toggleStudioMic() {
  const btn = $('#btn-mic-studio');
  if (app.engine.running) {
    app.engine.stop();
  } else {
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = 'Waiting for the browser…';
    try {
      await app.engine.startMic($('#mic-select-studio').value || null);
    } catch (e) {
      $('#mic-studio-status').textContent = 'The browser blocked microphone access. Allow it in the address bar and try again.';
    }
    btn.disabled = false;
    btn.textContent = old;
  }
  refreshMicUI();
}

/* ---------------- tabs ---------------- */

const TABS = ['play', 'train', 'setup'];

function selectTab(name, focusBtn = false) {
  app.tab = name;
  for (const t of TABS) {
    const btn = $('#tabbtn-' + t);
    const panel = $('#tab-' + t);
    const on = t === name;
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    btn.tabIndex = on ? 0 : -1;
    panel.hidden = !on;
    if (on && focusBtn) btn.focus();
  }
  if (name === 'play') { sizeCanvases(); }
}

function wireTabs() {
  const bar = $('.tabs');
  TABS.forEach((t, i) => {
    $('#tabbtn-' + t).addEventListener('click', () => selectTab(t));
  });
  bar.addEventListener('keydown', (e) => {
    const i = TABS.indexOf(app.tab);
    let n = null;
    if (e.key === 'ArrowRight') n = TABS[(i + 1) % TABS.length];
    else if (e.key === 'ArrowLeft') n = TABS[(i - 1 + TABS.length) % TABS.length];
    else if (e.key === 'Home') n = TABS[0];
    else if (e.key === 'End') n = TABS[TABS.length - 1];
    if (n) { e.preventDefault(); selectTab(n, true); }
  });
}

/* ---------------- pitch wheel ---------------- */

function sizeCanvases() {
  const wheel = $('#wheel');
  if (wheel) {
    const r = wheel.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const s = Math.max(50, Math.min(r.width, 680) * dpr);
    wheel.width = s; wheel.height = s;
  }
  const roll = $('#roll');
  if (roll) {
    const r = roll.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    roll.width = Math.max(50, r.width * dpr);
    roll.height = Math.max(50, r.height * dpr);
  }
}

function inScalePcs() {
  const s = app.engine.settings;
  const iv = SCALES[s.scale] || SCALES.Chromatic;
  return new Set(iv.map(i => (((s.key + i) % 12) + 12) % 12));
}

function drawWheel() {
  const c = $('#wheel');
  if (!c || !c.width || $('#tab-play').hidden) return;
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) / 2 - W * 0.04;
  g.clearRect(0, 0, W, H);

  const inScale = inScalePcs();
  const seg = (Math.PI * 2) / 12;
  // C at top, clockwise chromatic.
  const ang = (pc) => -Math.PI / 2 + pc * seg;

  // Segment tracks.
  for (let pc = 0; pc < 12; pc++) {
    const a0 = ang(pc) - seg / 2 + seg * 0.06;
    const a1 = ang(pc) + seg / 2 - seg * 0.06;
    g.beginPath();
    g.arc(cx, cy, R, a0, a1);
    const hot = pc === app.wheelPc;
    const act = pc === app.activePc;
    g.strokeStyle = act ? '#35e0c5'
      : hot ? '#f5b02e'
      : inScale.has(pc) ? 'rgba(245,176,46,0.45)' : 'rgba(255,255,255,0.10)';
    g.lineWidth = act || hot ? W * 0.035 : W * 0.018;
    if (hot || act) { g.shadowColor = act ? '#35e0c5' : '#f5b02e'; g.shadowBlur = W * 0.03; }
    g.stroke();
    g.shadowBlur = 0;
    // Pitch-class label.
    const lx = cx + Math.cos(ang(pc)) * R * 0.82;
    const ly = cy + Math.sin(ang(pc)) * R * 0.82;
    g.fillStyle = inScale.has(pc) ? 'rgba(238,241,246,0.85)' : 'rgba(138,147,166,0.5)';
    g.font = `700 ${Math.max(10, W * 0.032)}px ${getComputedStyle(document.body).fontFamily}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(NOTE_NAMES[pc], lx, ly);
  }

  // Trail: recent pitch history as fading dots.
  const hist = app.engine.pitchHistory;
  const n = Math.min(hist.length, 48);
  for (let i = 0; i < n; i++) {
    const m = hist[hist.length - n + i];
    const pc = ((Math.round(m) % 12) + 12) % 12;
    const a = ang(pc);
    const rr = R * 0.62;
    const alpha = (i / n) * 0.5;
    g.beginPath();
    g.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, W * 0.008, 0, 7);
    g.fillStyle = `rgba(53,224,197,${alpha.toFixed(3)})`;
    g.fill();
  }

  // Center: note readout.
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const has = app.wheelNote !== '–';
  g.fillStyle = has ? '#eef1f6' : '#5d6678';
  g.font = `800 ${W * 0.16}px ${getComputedStyle(document.body).fontFamily}`;
  g.fillText(app.wheelNote, cx, cy - H * 0.03);
  const cents = Math.max(-50, Math.min(50, Math.round(app.wheelCents)));
  g.fillStyle = '#8a93a6';
  g.font = `500 ${W * 0.045}px ui-monospace, monospace`;
  g.fillText(has ? (cents >= 0 ? '+' : '') + cents + ' ct' : 'LISTENING', cx, cy + H * 0.09);
}

function updateReadout(midiFloat, cents) {
  const r = fmtNote(midiFloat);
  app.wheelPc = r.pc;
  app.wheelCents = cents;
  app.wheelNote = r.letter + r.octave;
  const label = 'Pitch wheel: ' + app.wheelNote;
  if (label !== app.lastAriaNote) {
    app.lastAriaNote = label;
    $('#wheel').setAttribute('aria-label', label);
  }
}

function clearReadout() {
  app.wheelPc = null;
  app.wheelNote = '–';
  app.wheelCents = 0;
  $('#wheel').setAttribute('aria-label', 'Pitch wheel: no note detected');
}

/* ---------------- piano roll (session strip) ---------------- */

function drawRoll() {
  const c = $('#roll');
  if (!c || !c.width || $('#tab-play').hidden) return;
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const now = performance.now() / 1000;
  const window = 30;
  const lo = 24, hi = 96;
  const xOf = (t) => W - ((now - t) / window) * W;
  const yOf = (m) => H - ((m - lo) / (hi - lo)) * H;
  const h = Math.max(3, (H / (hi - lo)) * 0.8);
  for (const n of app.roll) {
    const x0 = xOf(n.start), x1 = xOf(n.end ?? now);
    if (x1 < 0 || x0 > W) continue;
    g.fillStyle = n.live ? '#f5b02e' : 'rgba(139,123,255,0.75)';
    const y = yOf(n.midi) - h / 2;
    const w = Math.max(2, x1 - x0);
    g.beginPath();
    if (g.roundRect) g.roundRect(Math.max(0, x0), y, Math.min(w, W - Math.max(0, x0)), h, 3);
    else g.rect(Math.max(0, x0), y, Math.min(w, W - Math.max(0, x0)), h);
    g.fill();
  }
  g.fillStyle = 'rgba(255,255,255,0.25)';
  g.fillRect(W - 2, 0, 2, H);
}

/* ---------------- keyboard: real buttons ---------------- */

function buildKeyboard() {
  const kb = $('#keyboard');
  kb.innerHTML = '';
  for (let m = 48; m <= 71; m++) { // C3..B4
    const pc = m % 12;
    const black = [1, 3, 6, 8, 10].includes(pc);
    const r = fmtNote(m);
    const k = document.createElement('button');
    k.type = 'button';
    k.className = 'key ' + (black ? 'black' : 'white');
    k.dataset.midi = m;
    k.setAttribute('aria-label', 'Play ' + r.letter + r.octave);
    const lbl = document.createElement('span');
    lbl.className = 'klabel';
    lbl.setAttribute('aria-hidden', 'true');
    lbl.textContent = r.letter + r.octave;
    k.appendChild(lbl);
    kb.appendChild(k);
  }
}

function paintScale() {
  const inScale = inScalePcs();
  $$('#keyboard .key').forEach(k => {
    const pc = ((+k.dataset.midi % 12) + 12) % 12;
    k.classList.toggle('inscale', inScale.has(pc));
  });
}

function lightKey(midi, on) {
  $$('#keyboard .key').forEach(k => {
    k.classList.toggle('active', on && +k.dataset.midi === midi);
  });
}

function wireKeyboard() {
  $$('#keyboard .key').forEach(k => {
    const midi = +k.dataset.midi;
    const down = async (e) => {
      e.preventDefault();
      await app.engine.init();
      app.engine.auditionNote(midi);
      lightKey(midi, true);
    };
    const up = () => {
      app.engine.auditionNoteOff(midi);
      if (app.lastNote !== midi) lightKey(midi, false);
    };
    k.addEventListener('pointerdown', down);
    k.addEventListener('pointerup', up);
    k.addEventListener('pointerleave', up);
    k.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) down(e);
    });
    k.addEventListener('keyup', (e) => {
      if (e.key === 'Enter' || e.key === ' ') up();
    });
    // Screen-reader users get the same press behavior via click.
    k.addEventListener('click', async () => {
      await app.engine.init();
      app.engine.auditionNote(midi);
      setTimeout(() => { app.engine.auditionNoteOff(midi); lightKey(midi, false); }, 350);
    });
  });
}

/* ---------------- controls ---------------- */

function buildScaleControls() {
  const keySel = $('#key-select');
  NOTE_NAMES.forEach((n, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = n;
    keySel.appendChild(o);
  });
  const scSel = $('#scale-select');
  Object.keys(SCALES).forEach(s => {
    const o = document.createElement('option');
    o.value = s; o.textContent = s;
    scSel.appendChild(o);
  });
}

function applySettingsToUI() {
  const s = app.engine.settings;
  $('#key-select').value = s.key;
  $('#scale-select').value = s.scale;
  $('#tgl-quantize').checked = s.quantize;
  $('#bend-select').value = s.bend;
  $('#octave-select').value = s.octave;
  $('#gain-range').value = Math.round(s.gate * 1000);
  $('#gain-val').textContent = (s.gate * 100).toFixed(1) + '%';
  $('#tgl-drums').checked = s.drums;
  $('#tgl-velocity').checked = s.velocityOn;
  $('#tgl-local').checked = s.localSound;
  $('#drum-strip').classList.toggle('off', !s.drums);
}

function saveSettings() {
  const s = app.engine.settings;
  store.set('settings', {
    gate: s.gate, key: s.key, scale: s.scale, quantize: s.quantize,
    bend: s.bend, octave: s.octave, drums: s.drums,
    velocityOn: s.velocityOn, localSound: s.localSound,
    midiOut: app.engine.midi.output ? app.engine.midi.output.id : null,
  });
}

function loadSettings() {
  const s = store.get('settings', null);
  if (!s) return;
  Object.assign(app.engine.settings, s);
  app.engine.setGate(app.engine.settings.gate);
  const tpl = store.get('templates', null);
  if (tpl) app.engine.setTemplates(tpl);
}

function refreshStatus() {
  const e = app.engine;
  const mic = $('#st-mic');
  mic.textContent = e.running ? 'Mic live' : 'Mic off';
  mic.className = e.running ? 'on' : 'off';
  const midi = $('#st-midi');
  if (!e.midi.supported) midi.textContent = 'MIDI: not supported here';
  else if (e.midi.output) midi.textContent = 'MIDI: ' + (e.midi.output.name || 'device');
  else midi.textContent = 'MIDI: Built-in synth';
  const syn = $('#st-synth');
  syn.textContent = e.settings.localSound ? 'Synth on' : 'Synth off';
  syn.className = e.settings.localSound ? 'on' : 'off';
}

/* ---------------- drums ---------------- */

const DRUM_LABEL = { kick: 'Kick', snare: 'Snare', hat: 'Hat' };

function flashPad(kind) {
  const pad = $('#pad-' + kind);
  if (!pad) return;
  pad.classList.remove('hit');
  void pad.offsetWidth;
  pad.classList.add('hit');
}

function renderTrainRows() {
  const custom = store.get('templates', null);
  $('#train-rows').innerHTML = '';
  for (const kind of ['kick', 'snare', 'hat']) {
    const row = document.createElement('div');
    row.className = 'train-row';
    const isCustom = custom && custom[kind];
    row.innerHTML =
      '<div class="train-name">' + DRUM_LABEL[kind] +
      (isCustom ? ' <span class="badge">trained</span>' : '') + '</div>' +
      '<div class="train-status" id="train-status-' + kind + '">Default sound model</div>' +
      '<button class="btn small" data-train="' + kind + '">Train</button>';
    $('#train-rows').appendChild(row);
  }
  $$('#train-rows [data-train]').forEach(b =>
    b.addEventListener('click', () => startTraining(b.dataset.train)));
}

function startTraining(kind) {
  if (!app.engine.running) {
    $('#train-hint').textContent = 'Enable the microphone first, then train.';
    return;
  }
  app.training = { kind, takes: [], need: 3 };
  $('#train-status-' + kind).textContent = 'Make your ' + kind + ' sound 3 times… (0/3)';
  $('#train-hint').textContent = 'Listening for sharp hits. Beatbox into the mic.';
}

function feedTraining(rms) {
  const t = app.training;
  if (!t) return;
  const frame = app.engine.frame;
  if (!frame || rms < 0.06) return;
  const now = performance.now();
  if (t.last && now - t.last < 250) return;
  const feat = extractFeatures(frame, app.engine.sampleRate);
  if (!feat) return;
  t.last = now;
  t.takes.push(feat);
  const n = t.takes.length;
  $('#train-status-' + t.kind).textContent =
    'Make your ' + t.kind + ' sound 3 times… (' + n + '/3)';
  flashPad(t.kind);
  if (n >= t.need) {
    const avg = { centroid: 0, lowR: 0, midR: 0, highR: 0 };
    t.takes.forEach(f => { avg.centroid += f.centroid; avg.lowR += f.lowR; avg.midR += f.midR; avg.highR += f.highR; });
    avg.centroid = Math.round(avg.centroid / n);
    avg.lowR /= n; avg.midR /= n; avg.highR /= n;
    const tpl = Object.assign({}, app.engine.templates);
    tpl[t.kind] = avg;
    app.engine.setTemplates(tpl);
    store.set('templates', tpl);
    $('#train-status-' + t.kind).textContent = 'Trained. Centroid ' + avg.centroid + ' Hz.';
    app.training = null;
    renderTrainRows();
  }
}

/* ---------------- MIDI devices ---------------- */

async function refreshMidiUI() {
  const midi = app.engine.midi;
  const ok = await midi.enable();
  const wrap = $('#midi-select-wrap');
  if (!ok || !midi.supported) {
    $('#midi-status').textContent = 'MIDI output needs Chrome, Edge, or Firefox. Your built-in synth is ready either way.';
    wrap.hidden = true;
    refreshStatus();
    return;
  }
  const paint = (list) => {
    const sel = $('#midi-select');
    const cur = sel.value;
    sel.innerHTML = '<option value="">Built-in synth only</option>';
    list.forEach(d => {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.name;
      sel.appendChild(o);
    });
    if (list.some(d => d.id === cur)) sel.value = cur;
    $('#midi-status').textContent = list.length
      ? list.length + (list.length === 1 ? ' MIDI output found.' : ' MIDI outputs found.')
      : 'No MIDI outputs found. Plug in a device or a virtual MIDI port.';
    refreshStatus();
  };
  midi.onDevices = paint;
  midi._emit();
}

/* ---------------- record ---------------- */

function setRecording(on) {
  const btn = $('#btn-record');
  btn.classList.toggle('rec', on);
  btn.querySelector('.rec-label').textContent = on ? 'Stop' : 'Record';
  $('#btn-midi-dl').disabled = !(!on && app.engine.recorder.count > 0);
  $('#rec-dot').className = 'dot ' + (on ? 'recording' : 'idle');
  $('#rec-count').textContent = on ? 'Recording…' : app.engine.recorder.count + ' notes';
}

/* ---------------- boot ---------------- */

function renderLoop() {
  drawWheel();
  drawRoll();
  requestAnimationFrame(renderLoop);
}

export function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('fresh') === '1') {
    ['onboarded', 'settings', 'templates'].forEach(k => store.del(k));
  }

  app.engine = new AudioEngine({
    onLevel: (rms) => {
      const pct = Math.min(100, Math.round((rms / 0.3) * 100));
      const el = document.getElementById('ob-meter-fill');
      if (el) {
        el.style.width = pct + '%';
        el.classList.toggle('hot', pct > 85);
      }
      const ls = $('#level-state');
      if (ls) {
        const ok = rms > app.engine.settings.gate;
        ls.textContent = ok ? 'Good level. I hear you.' : 'Make some noise…';
        ls.classList.toggle('good', ok);
      }
      feedTraining(rms);
    },
    onPitch: (midiFloat, cents) => {
      updateReadout(midiFloat, cents);
      if (!$('#studio').hidden) return;
      const r = fmtNote(midiFloat);
      $('#hum-note').textContent = r.letter + r.octave;
      if (app.lockedNote === null && Math.abs(cents) < 40) {
        app.stable = (app.stable || 0) + 1;
        if (app.stable > 20) {
          app.lockedNote = Math.round(midiFloat);
          $('#hum-status').textContent = 'Locked on. Nice.';
          $('#hum-status').classList.add('good');
          const b = $('#btn-start');
          b.disabled = false;
          b.textContent = 'Start playing';
        }
      } else if (Math.abs(cents) >= 40) {
        app.stable = 0;
      }
    },
    onNote: (midi, vel, on) => {
      const now = performance.now() / 1000;
      const pc = ((midi % 12) + 12) % 12;
      if (on) {
        app.roll.push({ midi, start: now, end: null, live: true });
        app.lastNote = midi;
        app.activePc = pc;
        lightKey(midi, true);
      } else {
        const n = [...app.roll].reverse().find(n => n.midi === midi && n.end === null);
        if (n) { n.end = now; n.live = false; }
        if (app.lastNote === midi) { app.lastNote = null; app.activePc = null; lightKey(midi, false); }
      }
      if (app.roll.length > 400) app.roll.splice(0, app.roll.length - 400);
      if (app.engine.recorder.recording) {
        $('#rec-count').textContent = 'Recording… ' + app.engine.recorder.count + ' notes';
      }
    },
    onDrum: (kind, vel) => flashPad(kind),
    onState: (s) => {
      $('#status-dot').className = 'dot ' + s;
      refreshStatus();
    },
  });

  loadSettings();
  buildKeyboard();
  wireKeyboard();
  buildScaleControls();
  applySettingsToUI();
  wireTabs();
  renderTrainRows();

  /* onboarding wiring */
  $('#btn-begin').addEventListener('click', () => showStep(1));
  $('#ob-back').addEventListener('click', () => showStep(Math.max(0, app.step - 1)));
  $$('[data-skip]').forEach(b => b.addEventListener('click', enterStudio));
  $('#btn-mic').addEventListener('click', enableMic);
  $('#btn-to-level').addEventListener('click', () => showStep(2));
  $('#mic-select').addEventListener('change', (e) => {
    app.engine.stop();
    app.engine.startMic(e.target.value).catch(() => {});
  });
  $('#btn-to-hum').addEventListener('click', () => showStep(3));
  $('#btn-start').addEventListener('click', enterStudio);

  /* mic controls (setup + train tabs) */
  $('#btn-mic-studio').addEventListener('click', toggleStudioMic);
  $('#btn-train-mic').addEventListener('click', toggleStudioMic);
  $('#mic-select-studio').addEventListener('change', (e) => {
    app.engine.stop();
    app.engine.startMic(e.target.value).then(refreshMicUI).catch(() => {});
  });

  /* play controls */
  $('#gain-range').addEventListener('input', (e) => {
    const g = (+e.target.value) / 1000;
    app.engine.setGate(g);
    $('#gain-val').textContent = (g * 100).toFixed(1) + '%';
    saveSettings();
  });
  const keyScaleChanged = () => { paintScale(); saveSettings(); };
  $('#key-select').addEventListener('change', (e) => { app.engine.settings.key = +e.target.value; keyScaleChanged(); });
  $('#scale-select').addEventListener('change', (e) => { app.engine.settings.scale = e.target.value; keyScaleChanged(); });
  $('#octave-select').addEventListener('change', (e) => { app.engine.settings.octave = +e.target.value; saveSettings(); });

  /* setup controls */
  $('#tgl-quantize').addEventListener('change', (e) => { app.engine.settings.quantize = e.target.checked; saveSettings(); });
  $('#bend-select').addEventListener('change', (e) => { app.engine.settings.bend = e.target.value; saveSettings(); });
  $('#tgl-drums').addEventListener('change', (e) => {
    app.engine.settings.drums = e.target.checked;
    $('#drum-strip').classList.toggle('off', !e.target.checked);
    saveSettings();
  });
  $('#tgl-velocity').addEventListener('change', (e) => { app.engine.settings.velocityOn = e.target.checked; saveSettings(); });
  $('#tgl-local').addEventListener('change', (e) => {
    app.engine.settings.localSound = e.target.checked;
    if (app.engine.synth) app.engine.synth.localOn = e.target.checked;
    refreshStatus();
    saveSettings();
  });
  $('#midi-select').addEventListener('change', (e) => {
    const dev = app.engine.midi.select(e.target.value);
    if (dev) {
      app.engine.settings.localSound = false;
      app.engine.synth.localOn = false;
      $('#tgl-local').checked = false;
    }
    refreshStatus();
    saveSettings();
  });

  /* transport */
  $('#btn-panic').addEventListener('click', () => {
    app.engine.panic();
    app.roll.forEach(n => { if (n.end === null) n.end = performance.now() / 1000; n.live = false; });
    app.activePc = null;
    lightKey(-1, false);
  });
  $('#btn-record').addEventListener('click', () => {
    const rec = app.engine.recorder;
    if (rec.recording) { rec.stop(); setRecording(false); }
    else { app.roll = []; rec.start(); setRecording(true); }
  });
  $('#btn-midi-dl').addEventListener('click', () => {
    const blob = app.engine.recorder.toBlob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'voxmidi-session.mid';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  $('#btn-clear-roll').addEventListener('click', () => { app.roll = []; });

  /* drums */
  $('#btn-goto-train').addEventListener('click', () => selectTab('train', true));
  $('#train-reset').addEventListener('click', () => {
    store.del('templates');
    app.engine.setTemplates(JSON.parse(JSON.stringify(DEFAULT_TEMPLATES)));
    renderTrainRows();
  });
  $$('#drum-strip .pad').forEach(p => {
    const kind = p.id.replace('pad-', '');
    p.addEventListener('pointerdown', async () => {
      await app.engine.init();
      app.engine.auditionDrum(kind);
      flashPad(kind);
    });
  });

  /* help */
  $('#btn-help').addEventListener('click', () => { $('#help-modal').hidden = false; });
  $('#help-close').addEventListener('click', () => { $('#help-modal').hidden = true; });
  $$('.modal').forEach(m => m.addEventListener('click', (e) => {
    if (e.target === m) m.hidden = true;
  }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#help-modal').hidden) $('#help-modal').hidden = true;
  });

  window.addEventListener('resize', sizeCanvases);

  if (params.get('screen') === 'studio' || store.get('onboarded', false)) {
    enterStudio();
  } else {
    showStep(0);
  }

  refreshMidiUI();
  renderLoop();
  window.voxmidi = app; // for scripted testing
}

document.addEventListener('DOMContentLoaded', boot);
