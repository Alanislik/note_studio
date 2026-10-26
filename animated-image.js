'use strict';

// Renders the uploaded GIF's own frames, retaining transparency and disposal rules.
// Bounded memory: only the current composed frame and one restore snapshot are kept.
class GifAnimation {
  constructor(url, canvases, onReady = () => {}, onError = () => {}) {
    this.canvases = canvases;
    this.onError = onError;
    this.abort = new AbortController();
    this.frame = -1;
    this.disposed = false;
    this.loaded = false;
    this.raf = 0;
    this.mode = 'sync';
    this.freeAt = 0;
    this.freeStarted = performance.now();
    this.rate = 1;
    this.loop = true;
    this.ready = this.load(url).then(() => {
      if (this.disposed) return null;
      this.loaded = true;
      this.render(0, false);
      onReady();
      return this;
    }).catch(error => {
      if (!this.disposed) this.onError(error);
      return null;
    });
  }

  async load(url) {
    const response = await fetch(url, { signal: this.abort.signal });
    if (!response.ok) throw Error('Не удалось загрузить GIF.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (this.disposed) return;
    this.reader = new GifReader(bytes);
    const { width, height } = this.reader;
    const count = this.reader.numFrames();
    if (!width || !height || width * height > 4_000_000 || !count || count > 4096)
      throw Error('GIF слишком большой для покадрового воспроизведения (до 4 Мп и 4096 кадров).');
    this.width = width; this.height = height;
    this.starts = []; this.duration = 0;
    for (let i = 0; i < count; i++) {
      const frame = this.reader.frameInfo(i);
      if (frame.x + frame.width > width || frame.y + frame.height > height)
        throw Error('Некорректные размеры кадра GIF.');
      this.starts.push(this.duration);
      // Match normal browser treatment of absent or implausibly short GIF delays.
      this.duration += frame.delay >= 2 ? frame.delay / 100 : .1;
    }
    this.pixels = new Uint8ClampedArray(width * height * 4);
    const palette = bytes[10] & 128 ? 13 + bytes[11] * 3 : -1;
    this.background = palette >= 0 ? [bytes[palette], bytes[palette + 1], bytes[palette + 2], 255] : [0,0,0,0];
    for (const canvas of this.canvases) { canvas.width = width; canvas.height = height; }
  }

  frameAt(time, loop) {
    const at = loop ? Math.max(0, time) % this.duration : Math.min(Math.max(0, time), this.duration - .000001);
    let low = 0, high = this.starts.length;
    while (low + 1 < high) { const mid = (low + high) >> 1; if (this.starts[mid] <= at) low = mid; else high = mid; }
    return low;
  }

  clearRect(frame) {
    const color = frame.transparent_index !== null ? [0,0,0,0] : this.background;
    for (let y = frame.y; y < frame.y + frame.height; y++)
      for (let x = frame.x; x < frame.x + frame.width; x++) this.pixels.set(color, (y * this.width + x) * 4);
  }

  render(time, loop) {
    if (!this.loaded || this.disposed) return;
    const index = this.frameAt(time, loop);
    if (this.frame === index) return;
    try {
      if (index < this.frame) { this.frame = -1; this.pixels.fill(0); this.restore = null; }
      while (this.frame < index) {
        if (this.frame >= 0) {
          const previous = this.reader.frameInfo(this.frame);
          if (previous.disposal === 2) this.clearRect(previous);
          else if (previous.disposal === 3 && this.restore) this.pixels.set(this.restore);
        }
        const next = this.frame + 1;
        const info = this.reader.frameInfo(next);
        this.restore = info.disposal === 3 ? this.pixels.slice() : null;
        this.reader.decodeAndBlitFrameRGBA(next, this.pixels);
        this.frame = next;
      }
      const image = new ImageData(this.pixels, this.width, this.height);
      for (const canvas of this.canvases) {
        canvas.getContext('2d').putImageData(image, 0, 0);
        canvas.dataset.frame = String(index);
      }
    } catch (error) { this.dispose(); this.onError(error); }
  }

  sync(time, loop) {
    cancelAnimationFrame(this.raf); this.raf = 0;
    this.mode = 'sync'; this.render(time, loop);
  }

  free(rate, loop) {
    const now = performance.now();
    if (this.mode !== 'free') { this.mode = 'free'; this.freeAt = 0; this.freeStarted = now; }
    else if (this.rate !== rate || this.loop !== loop) {
      this.freeAt = Math.min(!this.loop && this.loaded ? this.duration : Infinity, this.freeAt + (now - this.freeStarted) / 1000 * this.rate);
      this.freeStarted = now;
    }
    this.rate = rate; this.loop = loop;
    if (!this.raf && this.loaded) this.tick();
  }

  tick() {
    if (this.disposed || this.mode !== 'free') return;
    const time = this.freeAt + (performance.now() - this.freeStarted) / 1000 * this.rate;
    this.render(time, this.loop);
    if (this.disposed) return;
    this.raf = this.loop || time < this.duration ? requestAnimationFrame(() => this.tick()) : 0;
  }

  restart() {
    this.freeAt = 0; this.freeStarted = performance.now();
    this.render(0, this.loop);
    if (this.mode === 'free' && !this.raf) this.tick();
  }

  dispose() {
    this.disposed = true; this.abort.abort(); cancelAnimationFrame(this.raf); this.raf = 0;
    this.pixels = null; this.restore = null; this.reader = null;
  }
}
