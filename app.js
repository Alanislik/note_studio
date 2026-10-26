'use strict';

/*
 * Nota Studio — основной файл приложения.
 *
 * Содержание:
 *   1. Состояние и мелкие помощники
 *   2. Хранилище произведений (IndexedDB или сервер)
 *   3. Демонстрационные произведения
 *   4. Навигация и библиотека
 *   5. Окно загрузки нот
 *   6. Разбор MusicXML и подготовка партитуры
 *   7. Показ партитуры и подсветка нот
 *   8. Перевод MIDI в MusicXML
 *   9. Чтение загруженных файлов
 *  10. Открытие произведения
 *  11. Плеер
 *  12. Обработчики событий и запуск
 */


/* ============================================================================
 * 1. Состояние и мелкие помощники
 * ========================================================================== */

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const GENRES = ['Все', 'Классика', 'Джаз', 'Поп', 'Рок', 'Саундтрек', 'Народная', 'Другое'];

// Библиотека и навигация
let songs = [];               // все произведения
let view = 'home';            // текущий экран
let lastView = 'library';     // куда вернуться кнопкой «Назад»
let selectedGenre = 'Все';
let search = '';
let activeId = null;          // id открытого произведения

// Партитура
let osmd = null;              // движок OpenSheetMusicDisplay
let zoom = 1;
let scoreTiming = null;       // результат parseMusicXML для открытого произведения
let visualNotes = [];         // ноты на экране: { el, time, end }
let scoreLines = [];          // строки (по одному такту): { index, top, bottom, time, ... }
let highlighted = new Set();  // сейчас подсвеченные элементы
let shownLine = -1;           // номер показанной строки
let resizeObserver = null;

// Плеер
let audioEngine = null;
let audioStarted = 0;         // момент старта на аудиочасах
let pausedAt = 0;             // позиция паузы, секунды партитуры
let playing = false;
let playSpeed = 1;
let playback = [];            // ноты для проигрывания
let totalDuration = 0;
let rafId = 0;

// Счётчики запросов: позволяют отбросить устаревший результат, если пользователь успел уйти
let readerRequest = 0;
let playRequest = 0;

const DB_NAME = 'nota-local-library';
const STORE = 'pieces';

const studio = new NotaStudio();

/** Короткое всплывающее сообщение внизу экрана. */
function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.remove('hidden');

  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add('hidden'), 3200);
}

/** Экранирует текст перед вставкой в HTML. */
function esc(value) {
  const replacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, char => replacements[char]);
}

/** Название ноты по MIDI-номеру: 60 -> C4. */
function noteName(midi) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(midi / 12) - 1;
  return names[((midi % 12) + 12) % 12] + octave;
}

/** Время в формате м:сс. */
function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}


/* ============================================================================
 * 2. Хранилище произведений
 *    С сервером (server.py) данные идут в папку data, без него — в IndexedDB.
 * ========================================================================== */

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Выполняет одну операцию с хранилищем IndexedDB и закрывает соединение. */
async function withStore(mode, operation) {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = operation(transaction.objectStore(STORE));

    transaction.oncomplete = () => {
      db.close();
      resolve(request?.result);
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

async function getAll() {
  if (studio.online) return studio.request('/api/pieces');
  return withStore('readonly', store => store.getAll());
}

async function putPiece(piece) {
  if (studio.online) return studio.save(piece);
  await withStore('readwrite', store => store.put(piece));
}

async function removePiece(id) {
  if (studio.online) {
    await studio.saving.catch(() => {}); // сначала дожидаемся незаконченных записей
    return studio.request('/api/pieces/' + encodeURIComponent(id), { method: 'DELETE' });
  }
  await withStore('readwrite', store => store.delete(id));
}


/* ============================================================================
 * 3. Демонстрационные произведения
 * ========================================================================== */

const DEMOS = [
  ['К маленькой Элизе', 'Людвиг ван Бетховен', 'Классика',
    'E5 D#5 E5 D#5 E5 B4 D5 C5 A4 C4 E4 A4 B4 E4 G#4 B4 C5 E4 E5 D#5 E5 D#5 E5 B4 D5 C5 A4'],
  ['Ода к радости', 'Людвиг ван Бетховен', 'Классика',
    'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4 D4 D4 E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4 C4 C4'],
  ['Утренняя мелодия', 'Nota Studio', 'Поп',
    'C5 E5 G5 E5 A4 C5 E5 C5 F4 A4 C5 A4 G4 B4 D5 B4 C5 E5 G5 E5'],
  ['Вечерний джаз', 'Nota Studio', 'Джаз',
    'D4 F4 A4 C5 B4 G4 F4 D4 E4 G4 B4 D5 C5 A4 G4 E4'],
  ['Мелодия ветра', 'Nota Studio', 'Саундтрек',
    'G4 A4 C5 D5 E5 D5 C5 A4 G4 E4 G4 A4 C5 A4 G4 E4'],
];

/** Одна четвертная нота в MusicXML. Название вида "D#5": буква, знак (# или b), октава. */
function demoNoteXml(name) {
  const match = name.match(/^([A-G])(#|b)?(\d)$/);
  if (!match) return null;

  const [, step, accidental, octave] = match;
  const alter = accidental ? `<alter>${accidental === '#' ? 1 : -1}</alter>` : '';

  return `<note><pitch><step>${step}</step>${alter}<octave>${octave}</octave></pitch>` +
    `<duration>1</duration><type>quarter</type></note>`;
}

/** Собирает MusicXML для демо: мелодия из четвертных нот, по четыре в такте. */
function demoXML(title, composer, notes) {
  const noteXml = notes.map(demoNoteXml).filter(Boolean);
  const measureCount = Math.ceil(notes.length / 4);

  // Атрибуты (тональность, размер, ключ, темп) нужны только в первом такте.
  const firstMeasureHeader =
    '<attributes><divisions>1</divisions><key><fifths>0</fifths></key>' +
    '<time><beats>4</beats><beat-type>4</beat-type></time>' +
    '<clef><sign>G</sign><line>2</line></clef></attributes>' +
    '<direction placement="above"><direction-type><metronome parentheses="no">' +
    '<beat-unit>quarter</beat-unit><per-minute>110</per-minute></metronome></direction-type>' +
    '<sound tempo="110" /></direction>';

  const measures = Array.from({ length: measureCount }, (_, k) => {
    const header = k === 0 ? firstMeasureHeader : '';
    const body = noteXml.slice(k * 4, k * 4 + 4).join('');
    return `<measure implicit="no" number="${k + 1}">${header}${body}</measure>`;
  }).join('');

  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<!DOCTYPE score-partwise  PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">' +
    '<score-partwise version="4.0">' +
    `<work><work-title>${esc(title)}</work-title></work>` +
    `<movement-title>${esc(title)}</movement-title>` +
    `<identification><creator type="composer">${esc(composer)}</creator></identification>` +
    '<defaults><scaling><millimeters>7</millimeters><tenths>40</tenths></scaling></defaults>' +
    '<part-list><score-part id="P1"><part-name>Piano</part-name><part-abbreviation>Pno</part-abbreviation>' +
    '<score-instrument id="I1"><instrument-name>Piano</instrument-name></score-instrument>' +
    '<midi-instrument id="I1"><midi-channel>1</midi-channel><midi-program>1</midi-program></midi-instrument>' +
    '</score-part></part-list>' +
    `<part id="P1">${measures}</part></score-partwise>`;
}

/** Загружает список из хранилища; если он пуст — добавляет демо-произведения. */
async function seed() {
  songs = await getAll();
  if (songs.length) return;

  for (let i = 0; i < DEMOS.length; i++) {
    const [title, author, genre, sequence] = DEMOS[i];

    await putPiece({
      id: 'demo-' + i,
      title,
      author,
      genre,
      kind: 'musicxml',
      xml: demoXML(title, author, sequence.split(' ')),
      favorite: false,
      created: Date.now() - i * 1000000,
      demo: true,
    });
  }

  songs = await getAll();
}


/* ============================================================================
 * 4. Навигация и библиотека
 * ========================================================================== */

function setView(name) {
  if (name !== 'reader') lastView = name;
  view = name;

  $$('.view').forEach(el => el.classList.toggle('hidden', el.id !== name + 'View'));
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === name));

  // Уходя с экрана произведения, останавливаем звук и медиа.
  if (name !== 'reader') {
    stop();
    studio.close();
  }

  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderGenreMenus() {
  $('#genreNav').innerHTML = GENRES.slice(1).map(genre => `
    <button class="genre-button" data-genre="${esc(genre)}">
      <span class="genre-circle"></span>${esc(genre)}
    </button>`).join('');

  $('#genreFilters').innerHTML = GENRES.map(genre => `
    <button class="chip ${genre === selectedGenre ? 'active' : ''}" data-filter="${esc(genre)}">${esc(genre)}</button>`
  ).join('');
}

/** Отбирает произведения по жанру и поиску и сортирует по выбранному порядку. */
function filterAndSort(list) {
  const result = list.filter(piece => {
    const genreMatches = selectedGenre === 'Все' || piece.genre === selectedGenre;
    const text = [piece.title, piece.author, piece.genre].join(' ').toLowerCase();
    return genreMatches && (!search || text.includes(search));
  });

  const order = $('#sortSelect').value;

  return result.sort((a, b) => {
    if (order === 'title') return a.title.localeCompare(b.title, 'ru');
    if (order === 'author') return a.author.localeCompare(b.author, 'ru');
    return b.created - a.created; // сначала новые
  });
}

/** Карточка произведения. Цвет и значок обложки зависят от id. */
function cardHtml(piece) {
  const artIndex = Math.abs([...piece.id].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % 5;
  const artSymbol = ['♫', '𝄞', '♬', '♪', '♩'][artIndex];
  const format = piece.kind === 'midi' ? 'MIDI' : 'MusicXML';

  return `
    <article class="music-card">
      <div class="card-art art-${artIndex}" data-open="${esc(piece.id)}">
        <span class="art-note">${artSymbol}</span>
        <button class="card-heart ${piece.favorite ? 'liked' : ''}" data-fav="${esc(piece.id)}"
                title="Добавить в избранное">${piece.favorite ? '♥' : '♡'}</button>
      </div>
      <div class="card-info" data-open="${esc(piece.id)}">
        <span class="genre-pill">${esc(piece.genre)}</span>
        <h3 title="${esc(piece.title)}">${esc(piece.title)}</h3>
        <p>${esc(piece.author || 'Неизвестный автор')}</p>
        <div class="card-foot">
          <span>${format} ${piece.demo ? '· Пример' : ''}</span>
          <span>Открыть ноты ↗</span>
        </div>
      </div>
    </article>`;
}

function renderGrid(selector, collection) {
  $(selector).innerHTML = collection.length
    ? collection.map(cardHtml).join('')
    : `<div class="empty-state">
         <div class="empty-icon">♫</div>
         <strong>Пока ничего не найдено</strong>
         <div>Попробуйте другой запрос или загрузите своё произведение.</div>
       </div>`;
}

function render() {
  renderGenreMenus();

  $('#statTotal').textContent = songs.length;
  $('#statGenres').textContent = new Set(songs.map(piece => piece.genre)).size;
  $('#statFavorites').textContent = songs.filter(piece => piece.favorite).length;

  renderGrid('#recentGrid', filterAndSort(songs).slice(0, 6));
  renderGrid('#libraryGrid', filterAndSort(songs));
  renderGrid('#favoritesGrid', filterAndSort(songs.filter(piece => piece.favorite)));

  studio.renderFiles();
}

async function toggleFavorite(id) {
  const piece = songs.find(p => p.id === id);
  if (!piece) return;

  piece.favorite = !piece.favorite;
  await putPiece(piece);
  render();

  if (activeId === id) $('#favoriteReader').textContent = piece.favorite ? '♥' : '♡';
}


/* ============================================================================
 * 5. Окно загрузки нот
 * ========================================================================== */

function modal(show) {
  $('#uploadModal').classList.toggle('hidden', !show);
  $('#uploadError').classList.add('hidden');

  if (!show) {
    $('#uploadForm').reset();
    $('#chosenFile').classList.add('hidden');
  }
}

/** Показывает выбранный файл и подставляет название из имени файла. */
function pickFile(file) {
  if (!file) return;

  const chosen = $('#chosenFile');
  chosen.textContent = `Выбран файл: ${file.name} (${(file.size / 1024).toFixed(1)} КБ)`;
  chosen.classList.remove('hidden');

  if (!$('#titleInput').value) {
    $('#titleInput').value = file.name
      .replace(/\.(musicxml|xml|mxl|midi|mid)$/i, '')
      .replaceAll('_', ' ');
  }
}

/** Обработка отправки формы загрузки. */
async function submitUpload(event) {
  event.preventDefault();

  const button = $('#uploadForm button[type=submit]');
  button.disabled = true;
  $('#uploadError').classList.add('hidden');

  try {
    const file = $('#fileInput').files[0];
    if (!file) throw Error('Выберите файл.');

    const title = $('#titleInput').value.trim();
    const author = $('#authorInput').value.trim();
    const genre = $('#genreInput').value;
    if (!title) throw Error('Введите название.');

    const info = await readUpload(file, title, author);
    const piece = {
      id: crypto.randomUUID(),
      title,
      author,
      genre,
      ...info,
      created: Date.now(),
      favorite: false,
    };

    await studio.create(piece, file);
    songs = await getAll();
    modal(false);
    render();
    toast('Произведение добавлено в вашу библиотеку');
    await openReader(piece.id);
  } catch (error) {
    $('#uploadError').textContent = error.message;
    $('#uploadError').classList.remove('hidden');
  } finally {
    button.disabled = false;
  }
}


/* ============================================================================
 * 6. Разбор MusicXML и подготовка партитуры
 * ========================================================================== */

/** Текст прямого дочернего тега (без поиска вглубь). */
const directText = (parent, tag) =>
  [...parent?.children || []].find(child => child.localName === tag)?.textContent?.trim() || '';

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');

  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'score-partwise') {
    throw Error('Файл не является корректным MusicXML (score-partwise).');
  }
  return doc;
}

/** Темп (ударов в минуту) из тега <direction>, либо 0, если темпа нет. */
function readTempo(direction) {
  const sound = direction.querySelector('sound[tempo]');
  const metronome = direction.querySelector('metronome');

  const bpm = Number(sound?.getAttribute('tempo'));
  if (bpm > 0 || !metronome) return bpm;

  // Темпа в <sound> нет — считаем по метроному, приводя к четвертным.
  const unitLength = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25 };
  const unit = unitLength[directText(metronome, 'beat-unit')] || 1;
  const dotted = metronome.querySelector('beat-unit-dot') ? 1.5 : 1;

  return Number(directText(metronome, 'per-minute')) * unit * dotted;
}

/**
 * Разбирает MusicXML: ноты, темпы, длины тактов.
 * Все времена — в секундах партитуры; по этим часам идут звук, подсветка и смена тактов.
 * Единица внутри — доля четвертной ноты («бит»).
 */
function parseMusicXML(text) {
  const doc = parseXml(text);
  const parts = [...doc.querySelectorAll('part')];

  const rawNotes = [];   // ноты с позицией внутри такта
  const tempos = [];     // изменения темпа (берутся из первой партии)
  const lengths = [];    // длина каждого такта в битах
  const labels = [];     // подписи тактов («1», «2», «X1» ...)

  for (const [partIndex, part] of parts.entries()) {
    let divisions = 1;   // сколько единиц длительности в четвертной ноте
    let beats = 4;       // размер: число долей
    let beatType = 4;    // размер: длина доли

    const measures = [...part.children].filter(node => node.localName === 'measure');

    measures.forEach((measure, index) => {
      let position = 0;   // текущая позиция внутри такта
      let lastStart = 0;  // начало последней ноты (нужно для аккордов)
      let extent = 0;     // самая дальняя позиция в такте

      labels[index] ??= measure.getAttribute('number') || String(index + 1);

      for (const node of measure.children) {
        const name = node.localName;

        if (name === 'attributes') {
          const newDivisions = Number(directText(node, 'divisions'));
          if (newDivisions > 0) divisions = newDivisions;

          const time = [...node.children].find(child => child.localName === 'time');
          if (time) {
            beats = directText(time, 'beats').split('+').reduce((sum, n) => sum + Number(n), 0) || beats;
            beatType = Number(directText(time, 'beat-type')) || beatType;
          }
        }

        if (name === 'direction' && partIndex === 0) {
          const bpm = readTempo(node);
          if (bpm > 0) {
            tempos.push({
              measure: index,
              beat: position + Number(directText(node, 'offset')) / divisions,
              bpm,
            });
          }
        }

        if (name === 'backup') {
          position -= Number(directText(node, 'duration')) / divisions;
          continue;
        }
        if (name === 'forward') {
          position += Number(directText(node, 'duration')) / divisions;
          extent = Math.max(extent, position);
          continue;
        }
        if (name !== 'note') continue;

        const isGrace = !!node.querySelector(':scope > grace');
        const isChord = !!node.querySelector(':scope > chord');
        const duration = isGrace ? 0 : Number(directText(node, 'duration')) / divisions;

        // Нота аккорда начинается там же, где предыдущая.
        const start = isChord ? lastStart : position;
        if (!isChord) lastStart = start;

        const pitch = node.querySelector(':scope > pitch');
        if (pitch && duration > 0) {
          const semitones = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
          const step = directText(pitch, 'step');

          if (step in semitones) {
            rawNotes.push({
              measure: index,
              beat: start,
              length: duration,
              midi: 12 * (Number(directText(pitch, 'octave')) + 1) + semitones[step] + Number(directText(pitch, 'alter')),
              voice: partIndex + ':' + (directText(node, 'voice') || '1') + ':' + (directText(node, 'staff') || '1'),
              tieStart: !!node.querySelector('tie[type="start"]'),
              tieStop: !!node.querySelector('tie[type="stop"]'),
            });
          }
        }

        // Тоны аккорда второй раз время вперёд не двигают.
        if (!isChord) position += duration;
        extent = Math.max(extent, start + duration, position);
      }

      // Затакт (и первый такт) может быть короче размера; остальные не короче размера.
      const isPickup = measure.getAttribute('implicit') === 'yes' || index === 0;
      const fullLength = beats * 4 / beatType;
      lengths[index] = Math.max(
        lengths[index] || 0,
        isPickup && extent > 0 ? extent : Math.max(extent, fullLength),
      );
    });
  }

  // Бит, с которого начинается каждый такт, и общая длина в битах.
  const measureStarts = [];
  let endBeat = 0;
  for (const length of lengths) {
    measureStarts.push(endBeat);
    endBeat += length;
  }

  // Таблица смены темпа: пересчёт битов в секунды.
  const tempoChanges = [
    { beat: 0, bpm: 120 },
    ...tempos.map(t => ({ beat: Math.max(0, measureStarts[t.measure] + t.beat), bpm: t.bpm })),
  ].sort((a, b) => a.beat - b.beat);

  const secondsAt = beat => {
    let seconds = 0;
    let lastBeat = 0;
    let bpm = 120;

    for (const change of tempoChanges) {
      if (change.beat > beat) break;
      seconds += (change.beat - lastBeat) * 60 / bpm;
      lastBeat = change.beat;
      bpm = change.bpm;
    }
    return seconds + (beat - lastBeat) * 60 / bpm;
  };

  const notes = mergeTiedNotes(rawNotes, measureStarts, secondsAt);

  return {
    notes,
    bpm: tempoChanges.filter(change => change.beat === 0).at(-1).bpm,
    duration: secondsAt(endBeat),
    secondsAt,
    measures: measureStarts.map((beat, i) => ({
      time: secondsAt(beat),
      end: secondsAt(beat + lengths[i]),
      label: labels[i],
    })),
  };
}

/** Переводит ноты в секунды и склеивает залигованные ноты в одну длинную. */
function mergeTiedNotes(rawNotes, measureStarts, secondsAt) {
  const notes = [];
  const openTies = new Map(); // «голос + высота» -> нота, к которой тянется лига

  const byPosition = (a, b) =>
    (measureStarts[a.measure] + a.beat) - (measureStarts[b.measure] + b.beat);

  for (const raw of [...rawNotes].sort(byPosition)) {
    const beat = measureStarts[raw.measure] + raw.beat;
    const time = secondsAt(beat);
    const end = secondsAt(beat + raw.length);
    const key = raw.voice + ':' + raw.midi;
    const previous = openTies.get(key);

    const continuesTie = raw.tieStop && previous && Math.abs(previous.time + previous.duration - time) < 0.001;

    if (continuesTie) {
      previous.duration = end - previous.time;
      if (!raw.tieStart) openTies.delete(key);
    } else {
      const note = { midi: raw.midi, time, duration: end - time, velocity: 0.75 };
      notes.push(note);

      if (raw.tieStart) openTies.set(key, note);
      else openTies.delete(key);
    }
  }

  return notes;
}

/** Готовит XML для показа: каждый такт начинается с новой строки (системы). */
function lineScoreXML(xml) {
  const doc = parseXml(xml);
  doc.querySelectorAll('print').forEach(node => node.remove());

  doc.querySelectorAll('part').forEach(part => {
    const measures = [...part.children].filter(node => node.localName === 'measure');

    measures.forEach((measure, index) => {
      if (index === 0) return;

      const print = doc.createElementNS(measure.namespaceURI, 'print');
      print.setAttribute('new-system', 'yes');
      measure.insertBefore(print, measure.firstChild);
    });
  });

  return new XMLSerializer().serializeToString(doc);
}


/* ============================================================================
 * 7. Показ партитуры и подсветка нот
 * ========================================================================== */

function clearHighlights() {
  highlighted.forEach(el => el.classList.remove('note-playing'));
  highlighted.clear();
}

/**
 * После отрисовки связывает ноты на экране со временем звучания
 * и запоминает границы каждой строки (такта).
 */
function buildScoreMap() {
  clearHighlights();
  visualNotes = [];
  scoreLines = [];
  shownLine = -1;

  const systems = osmd.GraphicSheet.MusicPages.flatMap(page => page.MusicSystems);
  const scale = 10 * zoom;

  for (const [index, measures] of osmd.GraphicSheet.MeasureList.entries()) {
    const firstStaff = measures.find(Boolean);
    if (!firstStaff) continue;

    const system = firstStaff.ParentMusicSystem;
    const box = system.PositionAndShape;
    const top = (box.AbsolutePosition.y + box.BorderTop) * scale;
    const bottom = (box.AbsolutePosition.y + box.BorderBottom) * scale;

    scoreLines.push({ index, system, top, bottom, ...scoreTiming.measures[index] });

    for (const staff of measures) {
      if (!staff) continue;

      for (const entry of staff.staffEntries) {
        const beat = entry.getAbsoluteTimestamp().RealValue * 4;

        for (const voice of entry.graphicalVoiceEntries) {
          for (const graphicNote of voice.notes) {
            const source = graphicNote.sourceNote;
            if (!source || source.isRest()) continue;

            const element = graphicNote.getSVGGElement?.();
            if (!element) continue;

            // VexFlow группирует аккорд: красим только головку этой ноты.
            const head = element.querySelectorAll('.vf-notehead')[graphicNote.vfnoteIndex || 0] || element;

            visualNotes.push({
              el: head,
              time: scoreTiming.secondsAt(beat),
              end: scoreTiming.secondsAt(beat + source.Length.RealValue * 4),
            });
          }
        }
      }
    }
  }

  // Обрезаем строку по зазору между системами, чтобы соседние строки не попадали в кадр.
  for (const line of scoreLines) {
    const i = systems.indexOf(line.system);
    const previous = systems[i - 1];
    const next = systems[i + 1];

    line.clipTop = Math.max(0, line.top - 16);
    line.clipBottom = line.bottom + 16;

    if (previous) {
      const box = previous.PositionAndShape;
      const previousBottom = (box.AbsolutePosition.y + box.BorderBottom) * scale;
      line.clipTop = Math.max(line.clipTop, (previousBottom + line.top) / 2);
    }
    if (next) {
      const box = next.PositionAndShape;
      const nextTop = (box.AbsolutePosition.y + box.BorderTop) * scale;
      line.clipBottom = Math.min(line.clipBottom, (line.bottom + nextTop) / 2);
    }
  }

  syncScore(pausedAt, false);
}

/**
 * Показывает нужный такт и подсвечивает звучащие ноты.
 * @param time   позиция в секундах партитуры
 * @param light  false — только показать такт, без подсветки
 */
function syncScore(time, light = true) {
  if (!scoreTiming || !scoreLines.length) return;

  const epsilon = 0.00001;

  // Какой такт сейчас идёт.
  let index = 0;
  for (let i = 0; i < scoreLines.length; i++) {
    if (scoreLines[i].time <= time + epsilon) index = i;
    else break;
  }

  const line = scoreLines[index];
  if (index !== shownLine) {
    shownLine = index;
    $('#scoreViewport').style.height = Math.max(100, line.clipBottom - line.clipTop) + 'px';
    $('#score').style.top = -line.clipTop + 'px';
    $('#scoreContainer').scrollLeft = 0;
    $('#measureLabel').textContent = `Такт ${line.label} · ${index + 1} / ${scoreLines.length}`;
  }

  // Подсветка: убираем у отзвучавших, добавляем звучащим.
  const isSounding = note => note.time <= time + epsilon && note.end > time + epsilon;
  const current = new Set(light ? visualNotes.filter(isSounding).map(note => note.el) : []);

  highlighted.forEach(el => {
    if (!current.has(el)) el.classList.remove('note-playing');
  });
  current.forEach(el => {
    if (!highlighted.has(el)) el.classList.add('note-playing');
  });
  highlighted = current;

  // Подпись «Звучит: C4 · E4».
  const sounding = light
    ? playback.filter(note => note.time <= time + epsilon && note.time + note.duration > time + epsilon)
    : [];
  const names = [...new Set(sounding.map(note => noteName(note.midi)))];

  $('#soundingNotes').textContent = names.length
    ? 'Звучит: ' + names.join(' · ')
    : light ? 'Пауза в нотах' : 'Нажмите ▶ для воспроизведения';
}

function renderScore() {
  if (!osmd || !scoreTiming) return;

  osmd.Zoom = zoom;
  osmd.render();
  buildScoreMap();
  syncScore(currentPosition(), playing || pausedAt > 0);
}

function zoomScore(delta) {
  if (!osmd) return;

  zoom = Math.max(0.5, Math.min(1.8, zoom + delta));
  renderScore();
  $('#zoomLabel').textContent = Math.round(zoom * 100) + '%';
}

/** Текущая позиция воспроизведения, секунды партитуры. */
function currentPosition() {
  const elapsed = playing && audioEngine ? Math.max(0, audioEngine.position(audioStarted)) : 0;
  return Math.min(totalDuration, pausedAt + elapsed * playSpeed);
}


/* ============================================================================
 * 8. Перевод MIDI в MusicXML
 *    Упрощённо: сетка в шестнадцатые, размер 4/4, без лиг и нескольких голосов.
 * ========================================================================== */

const NOTE_TYPES = { 16: 'whole', 8: 'half', 4: 'quarter', 2: 'eighth', 1: '16th' };
const SIXTEENTHS_PER_MEASURE = 16;
const MAX_MEASURES = 350;

/** Раскладывает длительность (в шестнадцатых) на стандартные: 16, 8, 4, 2, 1. */
function splitDuration(length) {
  const parts = [];

  for (const size of [16, 8, 4, 2, 1]) {
    while (length >= size) {
      parts.push(size);
      length -= size;
    }
  }
  return parts;
}

function restXml(length) {
  return splitDuration(length)
    .map(size => `<note><rest/><duration>${size}</duration><type>${NOTE_TYPES[size]}</type></note>`)
    .join('');
}

function pitchXml(midi, length, isChord) {
  const steps = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
  const sharps = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
  const tone = ((midi % 12) + 12) % 12;

  return `<note>${isChord ? '<chord/>' : ''}` +
    `<pitch><step>${steps[tone]}</step>${sharps[tone] ? '<alter>1</alter>' : ''}` +
    `<octave>${Math.floor(midi / 12) - 1}</octave></pitch>` +
    `<duration>${length}</duration><type>${NOTE_TYPES[length] || 'quarter'}</type></note>`;
}

/** Один такт: ноты, стартующие в одно время, превращаются в аккорд. */
function midiMeasureXml(notes, measureStart) {
  const inMeasure = notes.filter(n => n.tick >= measureStart && n.tick < measureStart + SIXTEENTHS_PER_MEASURE);

  // Группируем по времени начала внутри такта.
  const groups = new Map();
  for (const note of inMeasure) {
    const offset = note.tick - measureStart;
    if (!groups.has(offset)) groups.set(offset, []);
    groups.get(offset).push(note);
  }

  let position = 0;
  let xml = '';

  for (const [offset, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (offset > position) {
      xml += restXml(offset - position);
      position = offset;
    }

    // Аккорд звучит по самой короткой своей ноте, но не дольше конца такта.
    const length = Math.min(
      SIXTEENTHS_PER_MEASURE - offset,
      Math.max(1, Math.min(...group.map(n => n.len))),
    );

    group.slice(0, 16).forEach((note, i) => {
      xml += pitchXml(note.midi, length, i !== 0);
    });
    position = offset + length;
  }

  if (position < SIXTEENTHS_PER_MEASURE) xml += restXml(SIXTEENTHS_PER_MEASURE - position);
  return xml;
}

function midiToXml(midi, title, author) {
  const ppq = midi.header.ppq || 480;
  const bpm = Math.round(midi.header.tempos[0]?.bpm || 120);

  const tracks = midi.tracks.filter(track => track.notes.length);
  if (!tracks.length) throw Error('MIDI-файл не содержит нот.');

  let partList = '';
  let parts = '';

  tracks.slice(0, 12).forEach((track, trackIndex) => {
    const partId = `P${trackIndex + 1}`;

    partList += `<score-part id="${partId}">` +
      `<part-name>${esc(track.name || 'Инструмент ' + (trackIndex + 1))}</part-name>` +
      '<part-abbreviation>Pno</part-abbreviation>' +
      `<score-instrument id="I${trackIndex}"><instrument-name>Piano</instrument-name></score-instrument>` +
      '</score-part>';

    // Время и длительность в шестнадцатых долях.
    const notes = track.notes
      .map(note => ({
        tick: Math.max(0, Math.round(note.ticks / ppq * 4)),
        len: Math.max(1, Math.round(note.durationTicks / ppq * 4)),
        midi: note.midi,
      }))
      .sort((a, b) => a.tick - b.tick);

    const lastTick = Math.min(
      4 * 4 * MAX_MEASURES,
      Math.max(16, ...notes.map(note => note.tick + note.len)),
    );

    const firstMeasureHeader =
      '<attributes><divisions>4</divisions><key><fifths>0</fifths></key>' +
      '<time><beats>4</beats><beat-type>4</beat-type></time>' +
      '<clef><sign>G</sign><line>2</line></clef></attributes>' +
      '<direction><direction-type><metronome><beat-unit>quarter</beat-unit>' +
      `<per-minute>${bpm}</per-minute></metronome></direction-type>` +
      `<sound tempo="${bpm}"/></direction>`;

    let measures = '';
    for (let start = 0, number = 1; start < lastTick; start += SIXTEENTHS_PER_MEASURE, number++) {
      const header = number === 1 ? firstMeasureHeader : '';
      measures += `<measure number="${number}">${header}${midiMeasureXml(notes, start)}</measure>`;
    }

    parts += `<part id="${partId}">${measures}</part>`;
  });

  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<score-partwise version="4.0">' +
    `<work><work-title>${esc(title)}</work-title></work>` +
    `<movement-title>${esc(title)}</movement-title>` +
    `<identification><creator type="composer">${esc(author)}</creator></identification>` +
    `<part-list>${partList}</part-list>${parts}</score-partwise>`;
}


/* ============================================================================
 * 9. Чтение загруженных файлов
 * ========================================================================== */

const MAX_SCORE_FILE_SIZE = 15 * 1024 * 1024; // 15 МБ

/** MXL — это ZIP-архив; достаём из него основной файл MusicXML. */
async function extractMXL(buffer) {
  if (!window.JSZip) throw Error('Для формата MXL нужен интернет для загрузки библиотеки JSZip.');

  const zip = await JSZip.loadAsync(buffer);
  const fileName = Object.keys(zip.files)
    .find(name => /\.(musicxml|xml)$/i.test(name) && !name.startsWith('META-INF/'));

  if (!fileName) throw Error('В архиве MXL не найден файл MusicXML.');
  return zip.files[fileName].async('string');
}

/** Читает файл нот и возвращает { kind, xml, midiData? }. */
async function readUpload(file, title, author) {
  const extension = file.name.split('.').pop().toLowerCase();

  if (file.size > MAX_SCORE_FILE_SIZE) throw Error('Размер файла больше 15 МБ.');

  if (['mid', 'midi'].includes(extension)) {
    if (!window.Midi) throw Error('Библиотека MIDI недоступна. Проверьте подключение к интернету.');

    const midiData = await file.arrayBuffer();
    const xml = midiToXml(new Midi(midiData), title, author);
    parseXml(xml); // проверяем, что получился корректный XML

    return { kind: 'midi', xml, midiData };
  }

  if (['xml', 'musicxml', 'mxl'].includes(extension)) {
    const xml = extension === 'mxl' ? await extractMXL(await file.arrayBuffer()) : await file.text();
    parseXml(xml);

    return { kind: 'musicxml', xml };
  }

  throw Error('Поддерживаются только .mid, .midi, .musicxml, .xml, .mxl.');
}


/* ============================================================================
 * 10. Открытие произведения
 * ========================================================================== */

/** Сбрасывает всё, что относилось к ранее открытой партитуре. */
function resetScoreState() {
  resizeObserver?.disconnect();
  osmd?.clear();
  osmd = null;

  scoreTiming = null;
  scoreLines = [];
  visualNotes = [];
  playback = [];
  totalDuration = 0;
}

/** Заполняет заголовок и подписи экрана произведения. */
function fillReaderHeader(piece) {
  $('#readerTitle').textContent = piece.title;
  $('#readerAuthor').textContent = piece.author || 'Неизвестный композитор';
  $('#readerGenre').textContent = piece.genre.toUpperCase();
  $('#favoriteReader').textContent = piece.favorite ? '♥' : '♡';
  $('#scoreFormat').textContent = piece.kind.toUpperCase();

  $('#score').innerHTML = '';
  $('#score').style.top = '0';
  $('#scoreMessage').classList.add('hidden');
  $('#playBtn').disabled = true;
}

async function openReader(id) {
  const piece = songs.find(s => s.id === id);
  if (!piece) return;

  stop();
  const request = ++readerRequest;
  resetScoreState();

  activeId = id;
  fillReaderHeader(piece);
  setView('reader');
  studio.open(piece);

  zoom = 1;
  $('#zoomLabel').textContent = '100%';

  try {
    if (!window.opensheetmusicdisplay) {
      throw Error('Не удалось загрузить движок нот. Для первого запуска нужен интернет.');
    }

    osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay('score', {
      autoResize: false,
      backend: 'svg',
      drawingParameters: 'compact',
      drawTitle: false,
      drawComposer: false,
      drawPartNames: false,
      pageFormat: 'Endless',
      newSystemFromXML: true,
      newPageFromXML: false,
      renderSingleHorizontalStaffline: false,
    });

    await osmd.load(lineScoreXML(piece.xml));

    // Пока шла загрузка, пользователь мог открыть другое произведение или уйти.
    if (request !== readerRequest || view !== 'reader') return;

    scoreTiming = parseMusicXML(piece.xml);
    playback = scoreTiming.notes;
    totalDuration = scoreTiming.duration;
    studio.visual.setScore(scoreTiming);

    $('#tempoInput').value = Math.round(scoreTiming.bpm);
    renderScore();
    $('#durationTime').textContent = formatTime(totalDuration);
    $('#playBtn').disabled = !playback.length;
    if (!playback.length) toast('Ноты для проигрывания не найдены');

    watchScoreWidth();
  } catch (error) {
    if (request !== readerRequest) return;

    console.error(error);
    $('#scoreMessage').textContent = error.message;
    $('#scoreMessage').classList.remove('hidden');
    $('#playBtn').disabled = true;
  }
}

/** Перерисовывает ноты, когда меняется ширина окна. */
function watchScoreWidth() {
  const container = $('#scoreContainer');
  let width = container.clientWidth;

  resizeObserver = new ResizeObserver(() => {
    const next = container.clientWidth;
    if (next > 0 && next !== width) {
      width = next;
      renderScore();
    }
  });
  resizeObserver.observe(container);
}


/* ============================================================================
 * 11. Плеер
 * ========================================================================== */

function setPlayButton(symbol, title) {
  $('#playBtn').textContent = symbol;
  $('#playBtn').title = title;
}

function showProgress(time) {
  $('#currentTime').textContent = formatTime(time);
  $('#progressFill').style.width = `${Math.min(100, time / Math.max(totalDuration, 0.1) * 100)}%`;
}

function cancelSound(keepTail = false) {
  cancelAnimationFrame(rafId);
  if (!keepTail) audioEngine?.stop();
}

/** Остановка: возврат к первому такту. keepTail — дать последним нотам договорить. */
function stop(keepTail = false) {
  ++playRequest;
  cancelSound(keepTail);

  playing = false;
  pausedAt = 0;

  setPlayButton('▶', 'Воспроизвести');
  showProgress(0);
  clearHighlights();
  syncScore(0, false);
  studio.sync(0, false, playSpeed, true);
}

function pause() {
  pausedAt = currentPosition();
  ++playRequest;
  cancelSound();
  playing = false;

  setPlayButton('▶', 'Продолжить');
  syncScore(pausedAt);
  studio.sync(pausedAt, false, playSpeed, true);
}

/** Цикл кадров: обновляет полосу, подсветку и медиа, пока играют ноты. */
function updateProgress() {
  if (!playing) return;

  const time = currentPosition();
  showProgress(time);
  syncScore(time);
  studio.sync(time, true, playSpeed);

  if (time >= totalDuration) {
    stop(true);
    return;
  }
  rafId = requestAnimationFrame(updateProgress);
}

async function play() {
  if (!playback.length) return;

  if (playing) {
    pause();
    return;
  }

  const request = ++playRequest;

  try {
    if (!audioEngine) audioEngine = new NotaAudioEngine();
    await audioEngine.prepare(playback);

    // Пока готовился звук, пользователь мог нажать паузу или уйти с экрана.
    if (request !== playRequest || view !== 'reader') return;

    if (pausedAt >= totalDuration) pausedAt = 0;

    const requestedTempo = Number($('#tempoInput').value);
    playSpeed = Math.max(0.2, Math.min(4, requestedTempo / scoreTiming.bpm || 1));

    audioStarted = audioEngine.start(playback, pausedAt, playSpeed);
    playing = true;

    setPlayButton('Ⅱ', 'Пауза');
    updateProgress();
  } catch (error) {
    audioEngine?.stop();
    playing = false;
    setPlayButton('▶', 'Воспроизвести');
    toast('Не удалось запустить звук: ' + error.message);
  }
}

/** Перемотка в позицию time (секунды); если играло — продолжает играть. */
function seek(time) {
  const wasPlaying = playing;
  pause();

  pausedAt = Math.max(0, Math.min(totalDuration, time));
  showProgress(pausedAt);
  syncScore(pausedAt);
  studio.sync(pausedAt, false, playSpeed, true);

  if (wasPlaying) play();
}


/* ============================================================================
 * 12. Обработчики событий и запуск
 * ========================================================================== */

/** Клики по элементам с data-атрибутами: меню, фильтры, карточки, избранное. */
async function handleDocumentClick(event) {
  const target = event.target;

  const nav = target.closest('[data-view]');
  if (nav) {
    selectedGenre = 'Все';
    setView(nav.dataset.view);
  }

  const goButton = target.closest('[data-go]');
  if (goButton) {
    selectedGenre = 'Все';
    setView(goButton.dataset.go);
  }

  const filter = target.closest('[data-filter]');
  if (filter) {
    selectedGenre = filter.dataset.filter;
    render();
  }

  const genre = target.closest('[data-genre]');
  if (genre) {
    selectedGenre = genre.dataset.genre;
    setView('library');
  }

  const heart = target.closest('[data-fav]');
  if (heart) {
    event.stopPropagation();
    await toggleFavorite(heart.dataset.fav);
    return;
  }

  const card = target.closest('[data-open]');
  if (card) await openReader(card.dataset.open);

  if (target.dataset.close) modal(false);
}

function bindSearchAndHotkeys() {
  $('#searchInput').addEventListener('input', event => {
    search = event.target.value.toLowerCase().trim();
    if (search && view !== 'library') setView('library');
    else render();
  });

  $('#sortSelect').onchange = render;

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') modal(false);

    // «/» — быстрый переход к поиску (если не печатаем в поле).
    const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
    if (event.key === '/' && !typing) {
      event.preventDefault();
      $('#searchInput').focus();
    }
  });
}

function bindUploadModal() {
  for (const selector of ['#sidebarUpload', '#topUpload', '#heroUpload']) {
    $(selector).addEventListener('click', () => modal(true));
  }
  $('#modalClose').onclick = () => modal(false);
  $('#fileInput').onchange = event => pickFile(event.target.files[0]);

  // Перетаскивание файла в зону загрузки.
  const dropZone = $('#dropZone');
  dropZone.addEventListener('dragover', event => {
    event.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', event => {
    event.preventDefault();
    dropZone.classList.remove('dragover');

    const files = event.dataTransfer.files;
    if (files.length) {
      $('#fileInput').files = files;
      pickFile(files[0]);
    }
  });

  $('#uploadForm').addEventListener('submit', submitUpload);
}

function bindReaderControls() {
  $('#backButton').onclick = () => setView(lastView === 'reader' ? 'library' : lastView);
  $('#favoriteReader').onclick = () => toggleFavorite(activeId);

  $('#deleteReader').onclick = async () => {
    const piece = songs.find(s => s.id === activeId);
    if (!piece) return;
    if (!confirm(`Удалить «${piece.title}» из библиотеки?`)) return;

    await removePiece(activeId);
    songs = await getAll();
    setView('library');
    toast('Произведение удалено');
  };

  $('#playBtn').onclick = play;
  $('#stopBtn').onclick = () => stop();

  // Смена темпа во время игры: перезапускаем с текущей позиции.
  $('#tempoInput').onchange = () => {
    if (playing) {
      pause();
      play();
    }
  };

  // Клик по полосе прогресса — перемотка.
  $('#progressTrack').onclick = event => {
    if (!totalDuration) return;

    const track = event.currentTarget;
    const fraction = (event.clientX - track.getBoundingClientRect().left) / track.clientWidth;
    seek(totalDuration * Math.max(0, Math.min(1, fraction)));
  };

  $('#zoomIn').onclick = () => zoomScore(0.15);
  $('#zoomOut').onclick = () => zoomScore(-0.15);
}

function bind() {
  document.addEventListener('click', handleDocumentClick);
  bindSearchAndHotkeys();
  bindUploadModal();
  bindReaderControls();
}

async function init() {
  bind();

  try {
    await studio.init();
    await seed();
    renderGenreMenus();
    render();
  } catch (error) {
    console.error(error);
    toast('Не удалось открыть локальную библиотеку: ' + error.message);
  }
}

init();
