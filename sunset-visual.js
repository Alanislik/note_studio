'use strict';

// An original, score-driven scene. No wall-clock animation: pause and seek are deterministic.
class SunsetVisual {
  constructor(canvas, onSeek) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSeek = onSeek;
    this.notes = [];
    this.duration = 0;
    this.time = 0;
    this.scrubTime = null;
    this.enabled = false;
    this.intensity = .7;
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.motionChanged = () => this.render(this.time);
    this.reducedMotion.addEventListener('change', this.motionChanged);
    this.observer = new ResizeObserver(() => this.render(this.time));
    this.observer.observe(canvas);
    // A click on the landscape scrubs to the corresponding point in the score.
    canvas.addEventListener('click', event => {
      if (!this.enabled || !this.duration) return;
      const rect = canvas.getBoundingClientRect();
      this.onSeek(Math.max(0, Math.min(1, (event.clientX - rect.left - 24) / Math.max(1, rect.width - 48))));
    });
  }

  static matches(piece) {
    return [piece.title, piece.originalFile?.name].some(name =>
      String(name || '').replace(/\.(mid|midi)$/i, '').trim().toLowerCase() === 'sunset of seven suns');
  }

  configure(piece) {
    this.notes = [];
    this.duration = 0;
    this.time = 0;
    this.scrubTime = null;
    const options = piece.visual || {};
    this.enabled = options.enabled ?? SunsetVisual.matches(piece);
    this.intensity = Number.isFinite(options.intensity) ? Math.max(0, Math.min(1, options.intensity)) : .7;
    $('#sunsetEnabled').checked = this.enabled;
    $('#sunsetIntensity').value = Math.round(this.intensity * 100);
    $('#sunsetIntensityValue').textContent = Math.round(this.intensity * 100) + '%';
    $('#sunsetScene').classList.toggle('hidden', !this.enabled);
    this.render(0);
  }

  setScore(timing) {
    this.notes = timing.notes;
    this.duration = timing.duration;
    $('#sunsetSeek').disabled = !this.duration;
    this.render(this.time);
  }

  clear() {
    this.scrubTime = null;
    this.enabled = false;
    this.notes = [];
    this.duration = 0;
    $('#sunsetScene').classList.add('hidden');
  }

  // Notes drive the seven sun envelopes; the lower piano part drives the water.
  signalsAt(time) {
    const suns = Array(7).fill(0);
    const particles = [];
    let bass = 0;
    for (const note of this.notes) {
      const age = time - note.time;
      if (age < 0) continue;
      if (age > Math.max(note.duration + .35, 2.5)) continue;
      const attack = Math.exp(-age * 4.5);
      const held = age < note.duration ? .24 : 0;
      const power = (attack + held) * (note.velocity ?? .75);
      if (note.midi < 55) bass += power;
      else suns[((note.midi - 55) % 7 + 7) % 7] += power;
      if (age < 2.5 && note.midi >= 55) particles.push({ age, midi: note.midi, power: Math.exp(-age * 1.4) });
    }
    return { suns: suns.map(n => 1 - Math.exp(-n)), bass: 1 - Math.exp(-bass * .5), particles };
  }

  render(time) {
    this.time = Math.max(0, Math.min(this.duration || 0, this.scrubTime ?? (time || 0)));
    if (!this.enabled || !this.ctx) return;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.round(rect.width * ratio), height = Math.round(rect.height * ratio);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width; this.canvas.height = height;
    }
    const ctx = this.ctx, w = rect.width, h = rect.height;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const progress = this.duration ? this.time / this.duration : 0;
    const signals = this.signalsAt(this.time);
    const motion = this.reducedMotion.matches ? 0 : this.time;
    const strength = this.reducedMotion.matches ? 0 : this.intensity;
    const horizon = h * .62;
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#11122e'); sky.addColorStop(.35, '#482049');
    sky.addColorStop(.61, '#b34f64'); sky.addColorStop(.64, '#f2a071'); sky.addColorStop(1, '#14162e');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);

    // Fixed star positions, softly changing with score time.
    for (let i = 0; i < 52; i++) {
      const x = ((i * 137.508) % 997) / 997 * w;
      const y = ((i * 67.13) % 101) / 101 * h * .39;
      ctx.globalAlpha = .15 + .25 * (.5 + .5 * Math.sin(i + motion * .5));
      ctx.fillStyle = '#fff0cd'; ctx.fillRect(x, y, i % 9 === 0 ? 2 : 1, 1);
    }
    ctx.globalAlpha = 1;
    const colors = ['#ffcd96', '#ffae85', '#f88f92', '#ffdcab', '#ef9eb1', '#d9a5d8', '#c8b3f3'];
    const positions = [];
    for (let i = 0; i < 7; i++) {
      const energy = signals.suns[i] * strength;
      const x = w * (.105 + i * .132);
      const y = h * (.35 + .075 * Math.cos(i * .95) + progress * .13);
      const radius = Math.min(w * .031, h * .088) * (1 + energy * .12);
      positions.push({ x, y, radius });
      const glow = ctx.createRadialGradient(x, y, radius * .3, x, y, radius * 4.5);
      glow.addColorStop(0, colors[i] + '80'); glow.addColorStop(.35, colors[i] + '24'); glow.addColorStop(1, colors[i] + '00');
      ctx.fillStyle = glow; ctx.fillRect(x - radius * 5, y - radius * 5, radius * 10, radius * 10);
      ctx.fillStyle = colors[i]; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = colors[i]; ctx.globalAlpha = .12 + energy * .55;
      ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(x, y, radius * (1.7 + energy * .6), radius * .53, -.2, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Distant silhouettes, drawn over the setting suns.
    for (let layer = 0; layer < 3; layer++) {
      ctx.fillStyle = ['#592b51', '#37223f', '#211d35'][layer];
      ctx.beginPath(); ctx.moveTo(0, horizon);
      for (let x = 0; x <= w + 6; x += 6) {
        const ridge = Math.sin(x / w * 13 + layer * 2) * .025 + Math.sin(x / w * 29 + layer) * .012;
        ctx.lineTo(x, h * (.54 + layer * .022 + ridge));
      }
      ctx.lineTo(w, horizon + 1); ctx.lineTo(0, horizon + 1); ctx.fill();
    }
    const sea = ctx.createLinearGradient(0, horizon, 0, h);
    sea.addColorStop(0, '#56304e'); sea.addColorStop(.16, '#25233f'); sea.addColorStop(1, '#0e152b');
    ctx.fillStyle = sea; ctx.fillRect(0, horizon, w, h - horizon);
    for (let row = 1; row <= 27; row++) {
      const depth = row / 27, y = horizon + depth ** 1.6 * (h - horizon);
      const drift = Math.sin(row * 1.7 + motion * .8) * (3 + depth * 9) * (1 + signals.bass * strength);
      for (let i = 0; i < 7; i++) {
        const size = positions[i].radius * (.6 + depth * 1.6) * (1 + signals.suns[i] * strength * .5);
        ctx.strokeStyle = colors[i]; ctx.globalAlpha = (1 - depth) * (.15 + signals.suns[i] * strength * .14);
        ctx.lineWidth = .6 + depth * 1.1;
        ctx.beginPath(); ctx.moveTo(positions[i].x - size + drift, y); ctx.lineTo(positions[i].x + size + drift, y); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    // Melody notes become drifting fireflies. Their age is derived from score time.
    if (!this.reducedMotion.matches) for (const mote of signals.particles) {
      const x = ((mote.midi - 50) / 45 * w + Math.sin(mote.midi + motion) * 8 + w) % w;
      const y = horizon - mote.age * h * .075 + Math.cos(mote.midi) * 15;
      ctx.globalAlpha = mote.power * strength * .65;
      ctx.fillStyle = '#ffe7b3'; ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // A discreet progress thread doubles as the landscape's scrub target.
    ctx.fillStyle = '#ffffff1c'; ctx.fillRect(24, h - 20, w - 48, 1);
    ctx.fillStyle = '#ffd9a1'; ctx.fillRect(24, h - 20, (w - 48) * progress, 1);
    ctx.beginPath(); ctx.arc(24 + (w - 48) * progress, h - 20, 3, 0, Math.PI * 2); ctx.fill();
    $('#sunsetSeek').value = Math.round(progress * 1000);
    $('#sunsetTime').textContent = this.format(this.time) + ' / ' + this.format(this.duration);
    this.canvas.dataset.scoreTime = this.time.toFixed(3);
  }

  format(time) { return Math.floor(time / 60) + ':' + String(Math.floor(time % 60)).padStart(2, '0'); }
}
