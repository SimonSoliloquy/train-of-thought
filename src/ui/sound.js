// Small synthesized sound effects (Web Audio, no files). Audio can only start after the player's
// first click or key press; a missing or suspended AudioContext is handled quietly. M mutes.
// The pure helpers at the top have no DOM or audio in them, so tests can run them.

const MUTE_KEY = 'tot-muted';
// Major pentatonic steps above the base note: a run of deliveries climbs without ever sounding wrong.
const STEPS = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

/** Pitch (Hz) of the delivery chime: rises with the streak, then stays at the top. */
export function streakPitch(streak, base = 523.25) {
  const i = Math.max(0, Math.min(STEPS.length - 1, Math.round(Number.isFinite(streak) ? streak : 1) - 1));
  return base * Math.pow(2, STEPS[i] / 12);
}

/**
 * A rate limiter: allowed(name) is true when `name` has not sounded within its own gap and
 * nothing at all has sounded within `globalGap` ms. Passing the clock in keeps it testable.
 */
export function createLimiter({ gaps = {}, defaultGap = 80, globalGap = 30, now = () => Date.now() } = {}) {
  const last = new Map();
  let lastAny = -Infinity;
  return function allowed(name) {
    const t = now();
    if (t - lastAny < globalGap) return false;
    if (t - (last.has(name) ? last.get(name) : -Infinity) < (gaps[name] ?? defaultGap)) return false;
    last.set(name, t);
    lastAny = t;
    return true;
  };
}

const GAPS = {
  coin: 400, thud: 400, chime: 70, flourish: 250, thunk: 200, whistle: 250, fall: 350, tick: 400,
};

function readMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveMuted(m) {
  try {
    localStorage.setItem(MUTE_KEY, m ? '1' : '0');
  } catch { /* storage may be blocked: the choice just lasts for this visit */ }
}

/**
 * @param {{game: import('../types.js').Game}} deps
 * @returns {{toggleMute: () => boolean, isMuted: () => boolean, update: (dt: number) => void}}
 */
export function createSound({ game }) {
  const state = game.state;
  let muted = readMuted();
  let ac = null;
  let master = null;
  let noise = null;
  const allowed = createLimiter({ gaps: GAPS });

  // ---------------------------------------------------------- starting audio on a gesture
  function ensure() {
    if (ac) return ac;
    const Ctor = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!Ctor) return null;
    try {
      ac = new Ctor();
      master = ac.createGain();
      master.gain.value = 0.5;
      let out = master;
      if (ac.createDynamicsCompressor) {
        const comp = ac.createDynamicsCompressor();
        master.connect(comp);
        out = comp;
      }
      out.connect(ac.destination);
    } catch {
      ac = null;
    }
    return ac;
  }

  function unlock() {
    const c = ensure();
    if (!c) return;
    if (c.state === 'running') return stopListening();
    try {
      const p = c.resume();
      if (p && p.then) p.then(() => { if (c.state === 'running') stopListening(); }, () => {});
    } catch { /* stay silent */ }
  }

  function stopListening() {
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  // ---------------------------------------------------------- synthesis
  const ready = () => !muted && ac && ac.state === 'running';

  /** One enveloped oscillator. freq2 slides the pitch to a second value over the note. */
  function tone({ type = 'sine', freq, freq2, at = 0, dur = 0.2, vol = 0.2, attack = 0.005 }) {
    const t0 = ac.currentTime + at;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (freq2) o.frequency.exponentialRampToValueAtTime(freq2, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  /** A short burst of filtered noise: the body of a thunk. */
  function thump({ at = 0, dur = 0.14, vol = 0.25, cutoff = 500 }) {
    if (!noise) {
      noise = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.3), ac.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t0 = ac.currentTime + at;
    const src = ac.createBufferSource();
    src.buffer = noise;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = ac.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f);
    f.connect(g);
    g.connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  const VOICES = {
    coin() {
      tone({ type: 'square', freq: 988, at: 0, dur: 0.08, vol: 0.07 });
      tone({ type: 'square', freq: 1319, at: 0.07, dur: 0.22, vol: 0.07 });
    },
    thud() {
      tone({ type: 'sine', freq: 130, freq2: 48, dur: 0.28, vol: 0.3 });
    },
    chime(streak) {
      const f = streakPitch(streak);
      tone({ type: 'sine', freq: f, dur: 0.4, vol: 0.14 });
      tone({ type: 'sine', freq: f * 2, dur: 0.22, vol: 0.04 });
    },
    flourish(kind) {
      const root = kind === 'route' ? 392 : 523.25;
      [0, 4, 7, 12].forEach((s, i) => tone({ type: 'triangle', freq: root * Math.pow(2, s / 12), at: i * 0.085, dur: i === 3 ? 0.55 : 0.2, vol: 0.13 }));
      tone({ type: 'sine', freq: root * 2 * Math.pow(2, 7 / 12), at: 0.26, dur: 0.5, vol: 0.05 });
    },
    thunk() {
      tone({ type: 'sine', freq: 170, freq2: 55, dur: 0.18, vol: 0.32 });
      thump({ dur: 0.1, vol: 0.2, cutoff: 700 });
    },
    whistle() {
      tone({ type: 'sine', freq: 1500, freq2: 1900, dur: 0.12, vol: 0.07 });
      tone({ type: 'sine', freq: 1900, freq2: 1700, at: 0.14, dur: 0.22, vol: 0.07 });
    },
    fall() {
      tone({ type: 'sine', freq: 420, freq2: 250, dur: 0.38, vol: 0.09 });
    },
    tick() {
      tone({ type: 'square', freq: 880, dur: 0.05, vol: 0.06, attack: 0.002 });
    },
  };

  function play(name, arg) {
    if (!ready() || !allowed(name)) return;
    try {
      VOICES[name](arg);
    } catch { /* never let a sound break the game */ }
  }

  // ---------------------------------------------------------- what makes which sound
  const on = (ev, fn) => game.on(ev, fn);
  on('payday', (e) => play(e && e.amount < 0 ? 'thud' : 'coin'));
  on('thoughtDelivered', (e) => play('chime', e && e.streak));
  on('goalDone', () => play('flourish', 'goal'));
  on('routeBonus', () => play('flourish', 'route'));
  on('stationBuilt', () => play('thunk'));
  on('trackUpgraded', () => play('whistle'));
  on('thoughtLost', () => play('fall'));

  let lastTick = null;
  return {
    isMuted: () => muted,
    toggleMute() {
      muted = !muted;
      saveMuted(muted);
      return muted;
    },
    /** The bankruptcy countdown ticks once a second. */
    update() {
      const left = state.bankruptIn;
      if (left == null) { lastTick = null; return; }
      const whole = Math.ceil(left);
      if (whole !== lastTick) {
        lastTick = whole;
        play('tick');
      }
    },
  };
}
