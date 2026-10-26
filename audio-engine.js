'use strict';

/*
 * NotaAudioEngine — синтезирует фортепианный тембр и планирует ноты.
 *
 * Звук ставится в расписание на аудиочасах Web Audio, поэтому перерисовка
 * страницы и задержки JavaScript не сдвигают ноты.
 */
class NotaAudioEngine {
  constructor() {
    this.context = null;          // AudioContext, создаётся при первом запуске
    this.buffers = new Map();     // midi-номер -> готовый звук ноты
    this.bus = null;              // текущая «сессия» воспроизведения
  }

  /** Создаёт аудиоконтекст и заранее синтезирует звуки всех нужных нот. */
  async prepare(notes) {
    if (!this.context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw Error('Этот браузер не поддерживает Web Audio.');

      this.context = new AudioContextClass({ latencyHint: 'interactive' });
      this.connectOutput();
    }

    await this.context.resume();
    if (this.context.state !== 'running') {
      throw Error('Браузер приостановил звук. Нажмите ▶ ещё раз.');
    }

    for (const midi of new Set(notes.map(note => note.midi))) {
      if (!this.buffers.has(midi)) this.buffers.set(midi, this.makePiano(midi));
    }
  }

  /** Выходная цепочка: громкость -> компрессор -> колонки, плюс лёгкая «комната». */
  connectOutput() {
    const ctx = this.context;

    this.output = ctx.createGain();
    this.output.gain.value = 0.7;

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -16;
    this.compressor.knee.value = 18;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.2;

    this.output.connect(this.compressor);
    this.compressor.connect(ctx.destination);

    // Тихий короткий хвост «комнаты» добавляет объём и не скрывает атаку нот.
    this.room = ctx.createConvolver();
    this.room.buffer = this.makeRoomImpulse();
    this.room.connect(this.output);
  }

  /** Импульс комнаты: затухающий шум. Генератор псевдослучайных чисел фиксирован, звук всегда одинаков. */
  makeRoomImpulse() {
    const ctx = this.context;
    const impulse = ctx.createBuffer(2, Math.ceil(ctx.sampleRate * 0.7), ctx.sampleRate);
    let seed = 23;

    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);

      for (let i = 0; i < data.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const noise = seed / 2147483648 - 1;
        const fade = Math.exp(-i / ctx.sampleRate * 10);
        data[i] = noise * fade * 0.12;
      }
    }

    return impulse;
  }

  /**
   * Синтез одной ноты: сумма затухающих гармоник струны.
   * Верхние гармоники затухают быстрее основного тона и слегка «расстроены».
   */
  makePiano(midi) {
    const ctx = this.context;
    const rate = ctx.sampleRate;
    const frequency = 440 * 2 ** ((midi - 69) / 12);

    const lengthSeconds = 8;
    const buffer = ctx.createBuffer(1, Math.ceil(rate * lengthSeconds), rate);
    const data = buffer.getChannelData(0);

    for (let partial = 1; partial <= 8; partial++) {
      const hz = frequency * partial * Math.sqrt(1 + 0.00008 * partial * partial);
      if (hz >= rate * 0.45) break; // выше этой частоты звук начал бы искажаться

      // Синусоида считается рекуррентной формулой — она быстрее, чем Math.sin на каждый отсчёт.
      const phase = 2 * Math.PI * hz / rate;
      const coefficient = 2 * Math.cos(phase);
      const decay = Math.exp(-(1.1 + partial * 0.42 + frequency / 2600) / rate);

      let previous = 0;
      let current = Math.sin(phase);
      let amplitude = 0.48 / partial ** 1.65;

      for (let i = 0; i < data.length; i++) {
        const attack = Math.min(1, i / (rate * 0.005)); // плавное начало, без щелчка
        data[i] += current * amplitude * attack;

        const next = coefficient * current - previous;
        previous = current;
        current = next;
        amplitude *= decay;
      }
    }

    return buffer;
  }

  /**
   * Планирует все ноты, начиная с позиции offset (в секундах партитуры).
   * @param speed  во сколько раз быстрее играть (1 = как в нотах)
   * @returns момент старта на аудиочасах — по нему считается позиция
   */
  start(notes, offset, speed) {
    this.stop();

    const ctx = this.context;
    const startTime = ctx.currentTime + 0.08; // небольшой запас, чтобы всё успело встать в расписание

    const bus = ctx.createGain();
    bus.connect(this.output);

    const wet = ctx.createGain();
    wet.gain.value = 0.16;
    bus.connect(wet);
    wet.connect(this.room);

    const session = { bus, wet, voices: new Set() };
    this.bus = session;

    try {
      for (const note of notes) {
        const noteEnd = note.time + note.duration;
        if (noteEnd <= offset) continue; // нота уже отзвучала до позиции старта

        this.scheduleNote(session, note, { startTime, offset, speed, noteEnd });
      }
    } catch (error) {
      this.stop();
      throw error;
    }

    return startTime;
  }

  /** Ставит в расписание один «голос» — одну ноту. */
  scheduleNote(session, note, { startTime, offset, speed, noteEnd }) {
    const ctx = this.context;
    const { bus, wet, voices } = session;

    const when = startTime + Math.max(0, note.time - offset) / speed;
    const duration = (noteEnd - Math.max(offset, note.time)) / speed;
    const holdUntil = when + Math.max(0.006, duration);

    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = this.buffers.get(note.midi);

    // Огибающая громкости: быстрая атака, удержание, короткое затухание.
    const velocity = Math.max(0.05, Math.min(1, note.velocity ?? 0.75));
    const level = velocity ** 1.4;
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(level, when + 0.006);
    gain.gain.setValueAtTime(level, holdUntil);
    gain.gain.exponentialRampToValueAtTime(0.0001, holdUntil + 0.22);

    source.connect(gain);
    gain.connect(bus);
    voices.add(source);

    // Когда звучит последний голос, убираем всю сессию.
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      voices.delete(source);

      if (!voices.size) {
        bus.disconnect();
        wet.disconnect();
        if (this.bus === session) this.bus = null;
      }
    };

    // Если стартуем с середины ноты, продолжаем затухающую струну, а не бьём по ней заново.
    const elapsed = Math.max(0, (offset - note.time) / speed);
    source.start(when, Math.min(elapsed, source.buffer.duration - 0.01));
    source.stop(when + duration + 0.23);
  }

  /** Мягко останавливает всё, что сейчас звучит или стоит в расписании. */
  stop() {
    const session = this.bus;
    if (!session) return;
    this.bus = null;

    const now = this.context.currentTime;
    session.bus.gain.cancelScheduledValues(now);
    session.bus.gain.setValueAtTime(session.bus.gain.value, now);
    session.bus.gain.linearRampToValueAtTime(0, now + 0.025);

    for (const source of session.voices) source.stop(now + 0.03);
  }

  /** Сколько секунд прошло с момента старта (с учётом задержки вывода). */
  position(start) {
    return Math.max(0, this.context.currentTime - (this.context.baseLatency || 0) - start);
  }
}

window.NotaAudioEngine = NotaAudioEngine;
