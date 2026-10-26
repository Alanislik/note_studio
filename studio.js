'use strict';

/*
 * NotaStudio — всё, что связано с файлами произведения:
 *   - обмен с сервером (хранилище в папке data);
 *   - список загруженных нот в разделе «Мои файлы»;
 *   - медиавложения (аудио, видео, картинки) под нотами и их синхронизация с плеером;
 *   - эффекты звучащих нот (цвет, свечение, пульсация).
 *
 * Зависит от глобальных функций и переменных из app.js:
 * $, esc, toast, modal, putPiece, removePiece, getAll, songs, activeId, view,
 * playing, playSpeed, currentPosition(), openDB(), STORE.
 */

const MAX_MEDIA_SIZE = 100 * 1024 * 1024; // 100 МБ на файл
const MEDIA_EXTENSIONS = /\.(mp3|wav|ogg|flac|m4a|mp4|webm|mov|png|jpe?g|webp|gif)$/i;
const DEFAULT_NOTE_COLOR = '#8b4ce8';

const MEDIA_TYPE_LABELS = { image: 'Изображение', video: 'Видео', audio: 'Аудио' };

class NotaStudio {
  constructor() {
    this.online = false;          // true, если работает server.py и файлы лежат в папке data
    this.urls = [];               // временные blob-ссылки, которые нужно освободить
    this.media = [];              // отрисованные вложения: { item, el, card, type, ... }
    this.saving = Promise.resolve(); // очередь записи, чтобы быстрые правки не затирали друг друга
    this.lastPiece = null;
  }

  // ---------------------------------------------------------------------------
  // Связь с сервером
  // ---------------------------------------------------------------------------

  async request(path, options = {}) {
    const response = await fetch(path, options);

    if (!response.ok) {
      let message = 'Не удалось выполнить запрос.';
      try {
        message = (await response.json()).error || message;
      } catch {
        // Тело ответа не JSON — остаётся стандартное сообщение.
      }
      throw Error(message);
    }

    return response.json();
  }

  async init() {
    await this.detectStorage();
    this.showStorageInfo();
    this.bindEvents();
  }

  /** Спрашиваем сервер, где хранятся данные: в папке data или только в браузере. */
  async detectStorage() {
    try {
      const status = await this.request('/api/status');
      this.online = status.storage === 'folder';
    } catch {
      this.online = false;
    }
  }

  showStorageInfo() {
    $('#storageNotice').textContent = this.online
      ? 'Хранилище: папка data · оригиналы нот и медиа сохраняются отдельно от сайта'
      : 'Хранилище: этот браузер · для сохранения в папку data запустите python3 server.py';

    $('#storageDescription').textContent = this.online
      ? 'Файлы находятся в data/uploads на компьютере или сервере, где запущен сайт. Скачайте оригинал или откройте произведение.'
      : 'Сейчас данные находятся в IndexedDB этого браузера. Запустите python3 server.py, чтобы хранить оригиналы и медиа в отдельной папке data.';

    $('#importBrowser').hidden = !this.online;
  }

  bindEvents() {
    $('#filesUpload').onclick = () => modal(true);
    $('#importBrowser').onclick = () => this.importBrowser();
    $('#mediaInput').onchange = event => this.addMedia(event.target.files);

    // Эффекты нот сохраняются при любом изменении настроек.
    for (const id of ['noteColor', 'noteGlow', 'notePulse']) {
      $('#' + id).addEventListener('change', () => this.saveEffects());
    }
    $('#resetEffects').onclick = () => {
      this.applyEffects({});
      this.saveEffects();
    };

    // Один набор обработчиков на весь список вложений (делегирование событий).
    const list = $('#mediaList');
    list.addEventListener('input', event => { this.previewVolume(event); this.previewLayout(event); });
    list.addEventListener('change', event => this.changeMedia(event));
    list.addEventListener('click', event => this.mediaClick(event));

    // Когда пользователь возвращается на вкладку, подтягиваем медиа к позиции нот.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.sync(currentPosition(), playing, playSpeed, true);
    });
  }

  // ---------------------------------------------------------------------------
  // Сохранение произведений и файлов
  // ---------------------------------------------------------------------------

  /** Сохраняет произведение на сервере. Записи идут строго по очереди. */
  save(piece) {
    // MIDI-байты хранятся отдельным файлом и в JSON-документ не попадают.
    const { midiData, ...document } = piece;
    const body = JSON.stringify(document);
    const url = '/api/pieces/' + encodeURIComponent(piece.id);

    const pending = this.saving
      .catch(() => {}) // ошибка прошлой записи не должна блокировать следующую
      .then(() => this.request(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      }));

    this.saving = pending;
    return pending;
  }

  /** Загружает файл (оригинал нот или медиа) в папку произведения. */
  upload(pieceId, file) {
    const url = '/api/pieces/' + encodeURIComponent(pieceId) + '/files?name=' + encodeURIComponent(file.name);
    return this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
  }

  /** Создаёт новое произведение вместе с оригиналом файла. */
  async create(piece, file) {
    await putPiece(piece);
    if (!this.online) return;

    try {
      piece.originalFile = await this.upload(piece.id, file);
      await putPiece(piece);
    } catch (error) {
      // Без оригинала произведение не оставляем.
      await removePiece(piece.id);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Раздел «Мои файлы»
  // ---------------------------------------------------------------------------

  renderFiles() {
    const uploaded = songs.filter(piece => !piece.demo);
    const mediaCount = uploaded.reduce((sum, piece) => sum + (piece.media?.length || 0), 0);

    $('#filesSummary').textContent =
      `Загружено произведений: ${uploaded.length} · Медиафайлов: ${mediaCount}`;

    $('#uploadedFiles').innerHTML = uploaded.length
      ? uploaded.map(piece => this.fileRowHtml(piece)).join('')
      : `<div class="empty-state">
           <strong>Здесь будут ваши загруженные ноты</strong>
           <p>Демонстрационные произведения остаются в библиотеке.</p>
         </div>`;

    $('#uploadedFiles').querySelectorAll('[data-download-piece]').forEach(button => {
      button.onclick = () => this.downloadPiece(button.dataset.downloadPiece);
    });
  }

  fileRowHtml(piece) {
    const original = piece.originalFile;
    const originalName = original?.name || 'Оригинал не сохранён · можно скачать MusicXML';
    const originalSize = original ? ' · ' + this.size(original.size) : '';
    const location = this.online ? ' · data/uploads/' + esc(piece.id) : ' · этот браузер';

    return `
      <article class="file-row">
        <div>
          <strong>${esc(piece.title)}</strong>
          <small>${esc(originalName)} · ${esc(piece.kind.toUpperCase())}${originalSize}</small>
          <small>Медиа: ${piece.media?.length || 0}${location}</small>
        </div>
        <div class="file-actions">
          <button class="btn" data-open="${esc(piece.id)}">Открыть ноты</button>
          <button class="text-link" data-download-piece="${esc(piece.id)}">Скачать ${original ? 'оригинал' : 'MusicXML'}</button>
        </div>
      </article>`;
  }

  /** Человекочитаемый размер файла. */
  size(bytes) {
    return bytes < 1048576
      ? (bytes / 1024).toFixed(1) + ' КБ'
      : (bytes / 1048576).toFixed(1) + ' МБ';
  }

  download(url, name) {
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
  }

  downloadPiece(id) {
    const piece = songs.find(p => p.id === id);
    if (!piece) return;

    // Есть оригинал на сервере — отдаём его без изменений.
    if (piece.originalFile && this.online) {
      this.download(piece.originalFile.url + '?download=1', piece.originalFile.name);
      return;
    }

    // Иначе отдаём MusicXML, который хранится в браузере.
    const blob = new Blob([piece.xml], { type: 'application/vnd.recordare.musicxml+xml' });
    const url = URL.createObjectURL(blob);
    this.download(url, piece.title + '.musicxml');
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------------------------------------------------------------------
  // Открытие и закрытие произведения
  // ---------------------------------------------------------------------------

  async open(piece) {
    this.close();
    this.lastPiece = piece.id;
    this.applyEffects(piece.effects || {});
    this.renderMedia(piece);
  }

  /** Останавливает все вложения и освобождает ресурсы. */
  close() {
    for (const entry of this.media) entry.el?.pause?.();
    for (const url of this.urls) URL.revokeObjectURL(url);

    this.media = [];
    this.urls = [];
    this.lastPiece = null;
    $('#scoreMedia').classList.add('hidden');
  }

  // ---------------------------------------------------------------------------
  // Эффекты нот
  // ---------------------------------------------------------------------------

  applyEffects(effects) {
    const color = /^#[0-9a-f]{6}$/i.test(effects.color || '') ? effects.color : DEFAULT_NOTE_COLOR;
    const glow = effects.glow !== false; // свечение включено по умолчанию
    const pulse = !!effects.pulse;

    $('#noteColor').value = color;
    $('#noteGlow').checked = glow;
    $('#notePulse').checked = pulse;

    const score = $('#score');
    score.style.setProperty('--note-color', color);
    score.classList.toggle('effect-glow', glow);
    score.classList.toggle('effect-pulse', pulse);
  }

  async saveEffects() {
    const piece = songs.find(p => p.id === activeId);
    if (!piece) return;

    const previous = piece.effects;
    const effects = {
      color: $('#noteColor').value,
      glow: $('#noteGlow').checked,
      pulse: $('#notePulse').checked,
    };

    piece.effects = effects;
    this.applyEffects(effects);

    try {
      await putPiece(piece);
    } catch (error) {
      // Откатываем, только если за это время настройки не успели измениться снова.
      if (piece.effects === effects) {
        piece.effects = previous;
        this.applyEffects(previous || {});
      }
      toast(error.message);
    }
  }

  /** Dimensions describe the stage under the score; previews remain thumbnails. */
  layout(item) {
    const layout = item.layout || {};
    return {
      width: Number.isFinite(layout.width) ? Math.max(20, Math.min(100, layout.width)) : 100,
      height: Number.isFinite(layout.height) ? Math.max(80, Math.min(720, layout.height)) : 320,
      fit: layout.fit === 'cover' ? 'cover' : 'contain',
    };
  }

  applyLayout(entry, layout = this.layout(entry.item)) {
    for (const node of [entry.card, entry.slot]) {
      if (!node) continue;
      node.style.setProperty('--media-width', layout.width + '%');
      node.style.setProperty('--media-height', layout.height + 'px');
      node.style.setProperty('--media-fit', layout.fit);
    }
    if (entry.slot) entry.slot.style.width = layout.width + '%';
    const width = entry.card.querySelector('[data-layout-output=width]');
    const height = entry.card.querySelector('[data-layout-output=height]');
    if (width) width.textContent = layout.width + '%';
    if (height) height.textContent = layout.height + ' px';
  }

  readLayout(card) {
    return this.layout({ layout: {
      width: Number(card.querySelector('[data-field=layoutWidth]').value),
      height: Number(card.querySelector('[data-field=layoutHeight]').value),
      fit: card.querySelector('[data-field=layoutFit]').value,
    } });
  }

  previewLayout(event) {
    if (!event.target.dataset.field?.startsWith('layout')) return;
    const card = event.target.closest('[data-media-id]');
    const entry = this.media.find(m => m.card === card);
    if (entry) this.applyLayout(entry, this.readLayout(card));
  }

  async saveLayout(entry, piece) {
    const previous = entry.item.layout;
    const layout = this.readLayout(entry.card);
    entry.item.layout = layout;
    this.applyLayout(entry, layout);
    try { await putPiece(piece); }
    catch (error) {
      if (entry.item.layout === layout) {
        entry.item.layout = previous;
        const old = this.layout(entry.item);
        for (const [field, value] of Object.entries({ layoutWidth: old.width, layoutHeight: old.height, layoutFit: old.fit }))
          entry.card.querySelector('[data-field=' + field + ']').value = value;
        this.applyLayout(entry, old);
      }
      toast(error.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Медиавложения под нотами
  // ---------------------------------------------------------------------------

  /** Определяет тип вложения по MIME: image, video или audio. */
  mediaType(item) {
    if (item.type.startsWith('image/')) return 'image';
    if (item.type.startsWith('video/')) return 'video';
    return 'audio';
  }

  renderMedia(piece) {
    for (const entry of this.media) entry.el?.pause?.();
    this.media = [];

    $('#mediaInput').disabled = !this.online;
    $('#mediaStatus').textContent = this.online
      ? 'Файлы сохраняются в data/uploads/' + piece.id
      : 'Для добавления медиа запустите python3 server.py. Ноты из браузера можно перенести в разделе «Мои файлы».';

    const list = $('#mediaList');
    const stage = $('#scoreMedia');
    list.replaceChildren();
    stage.replaceChildren();

    for (const item of piece.media || []) {
      const entry = this.createMediaCard(item);
      list.append(entry.card);

      // Под нотами у изображений и видео есть своё место; оно скрыто, пока не наступит время.
      entry.slot = this.createStageSlot(entry);
      if (entry.slot) stage.append(entry.slot);
      if (entry.type !== 'audio') this.applyLayout(entry);

      this.media.push(entry);
    }

    // Показ медиа под нотами решает sync(): видно только то, что активно сейчас.
    this.sync(currentPosition(), playing, playSpeed, true);
  }

  /**
   * Место под нотами для изображения или видео. Сначала скрыто.
   * Изображению хватает собственной копии, а видео переезжает сюда из карточки (см. placeInStage).
   */
  createStageSlot(entry) {
    if (entry.type === 'audio') return null;

    const slot = document.createElement('div');
    slot.dataset.mediaId = entry.item.id;
    slot.className = 'stage-item hidden';

    if (entry.type === 'image') {
      const img = document.createElement('img');
      img.alt = entry.item.name;
      img.src = '/api/files/' + encodeURIComponent(entry.item.id);
      slot.append(img);
    }
    return slot;
  }

  /**
   * Показывает или прячет вложение под нотами.
   * Видео — один и тот же элемент: пока не его время, он лежит в карточке «Добавленных файлов»,
   * на своём отрезке переезжает под ноты. Переезд происходит на паузе, поэтому звук не прерывается.
   */
  placeInStage(entry, show) {
    const { slot, el, card, type } = entry;
    if (!slot) return;

    slot.classList.toggle('hidden', !show);
    if (type !== 'video') return;

    if (show && el.parentNode !== slot) {
      slot.append(el);
    } else if (!show && el.parentNode === slot) {
      el.pause();
      card.querySelector('.media-preview').append(el);
    }
  }

  /** Собирает карточку одного вложения и возвращает запись для this.media. */
  createMediaCard(item) {
    const type = this.mediaType(item);
    const volume = this.volume(item);
    // Ссылки всегда ведут на наш файловый эндпоинт, а не на произвольные адреса.
    const url = '/api/files/' + encodeURIComponent(item.id);

    const card = document.createElement('article');
    card.className = 'media-card media-' + type;
    card.dataset.mediaId = item.id;
    card.innerHTML = this.mediaCardHtml(item, type, volume, url);

    const el = this.createMediaElement(item, type, card, volume);
    el.src = url;
    card.querySelector('.media-preview').append(el);

    return { item, el, card, type, pending: false };
  }

  mediaCardHtml(item, type, volume, url) {
    const name = esc(item.name);

    const volumeControl = type === 'image' ? '' : `
      <label class="media-volume">Громкость
        <input type="range" min="0" max="1" step="0.01" value="${volume}"
               data-field="volume" aria-label="Громкость ${name}">
        <output>${Math.round(volume * 100)}%</output>
      </label>`;

    const layout = this.layout(item);
    const sizeControl = type === 'audio' ? '' : `
      <fieldset class="media-size-controls"><legend>Размер под нотами</legend>
        <label>Ширина <input type="range" min="20" max="100" step="1" value="${layout.width}" data-field="layoutWidth" aria-label="Ширина ${name}"><output data-layout-output="width">${layout.width}%</output></label>
        <label>Высота <input type="range" min="80" max="720" step="10" value="${layout.height}" data-field="layoutHeight" aria-label="Высота ${name}"><output data-layout-output="height">${layout.height} px</output></label>
        <label>Кадрирование <select data-field="layoutFit" aria-label="Кадрирование ${name}"><option value="contain" ${layout.fit === 'contain' ? 'selected' : ''}>Вписать целиком</option><option value="cover" ${layout.fit === 'cover' ? 'selected' : ''}>Заполнить с обрезкой</option></select></label>
        <button class="text-link" data-media-action="reset-layout">Сбросить размер</button>
      </fieldset>`;

    return `
      <div class="media-preview"></div>
      <div class="media-info">
        <strong>${name}</strong>
        <small>${MEDIA_TYPE_LABELS[type]} · ${this.size(item.size)}</small>
        ${volumeControl}
        ${sizeControl}
        <div class="media-timing">
          <label><input type="checkbox" data-field="sync" ${item.sync ? 'checked' : ''}> С плеером</label>
          <label>С <input type="number" min="0" step="0.1" data-field="start"
                          value="${Number(item.start) || 0}" aria-label="Начало ${name}"> сек</label>
          <label>До <input type="number" min="0" step="0.1" data-field="end"
                           value="${Number(item.end) || ''}" placeholder="конца"
                           aria-label="Конец ${name}"> сек</label>
        </div>
        <div class="media-actions">
          <button class="text-link" data-media-action="here">Начать отсюда</button>
          <a class="text-link" href="${url}?download=1" download>Скачать</a>
          <button class="text-link danger" data-media-action="delete">Удалить</button>
        </div>
        <p class="media-error" role="status"></p>
      </div>`;
  }

  /** Создаёт <img>, <video> или <audio> и подключает к нему обработчики. */
  createMediaElement(item, type, card, volume) {
    const errorLabel = card.querySelector('.media-error');

    if (type === 'image') {
      const img = document.createElement('img');
      img.alt = item.name;
      img.loading = 'lazy';
      return img;
    }

    const el = document.createElement(type);
    el.controls = true;
    el.preload = 'metadata';
    el.playsInline = true;
    el.volume = volume;

    el.addEventListener('loadedmetadata', () => {
      this.sync(currentPosition(), playing, playSpeed, true);
    });

    el.addEventListener('error', () => {
      errorLabel.textContent = 'Браузер не смог открыть этот формат. Можно скачать файл и открыть его отдельно.';
    });

    // Пользователь сам нажал play — снимаем блокировку автозапуска.
    el.addEventListener('play', () => {
      const entry = this.media.find(m => m.el === el);
      if (!entry) return;
      entry.blocked = false;
      errorLabel.textContent = '';
    });

    // Громкость поменяли штатным регулятором плеера — отражаем это в нашем ползунке.
    el.addEventListener('volumechange', () => {
      const entry = this.media.find(m => m.el === el);
      if (!entry || !card.isConnected || entry.previewVolume) return;

      const range = card.querySelector('[data-field=volume]');
      range.value = el.volume;
      card.querySelector('.media-volume output').textContent = Math.round(el.volume * 100) + '%';

      if (el.volume !== this.volume(item)) this.changeMedia({ target: range });
    });

    return el;
  }

  async addMedia(files) {
    const piece = songs.find(p => p.id === activeId);
    if (!piece || !this.online) return;

    const input = $('#mediaInput');
    input.disabled = true;
    const problems = [];

    for (const file of files) {
      let uploaded;
      try {
        if (!MEDIA_EXTENSIONS.test(file.name)) throw Error('Неподдерживаемый формат');
        if (file.size > MAX_MEDIA_SIZE) throw Error('Максимум 100 МБ');

        $('#mediaStatus').textContent = 'Сохраняется: ' + file.name;
        uploaded = await this.upload(piece.id, file);

        const item = { ...uploaded, start: 0, end: null, sync: false, volume: 1 };
        piece.media = [...(piece.media || []), item];

        try {
          await putPiece(piece);
        } catch (error) {
          piece.media = piece.media.filter(m => m.id !== item.id);
          throw error;
        }
      } catch (error) {
        // Файл не удалось записать в произведение — убираем его и с сервера.
        if (uploaded) {
          await this.request('/api/files/' + uploaded.id, { method: 'DELETE' }).catch(() => {});
        }
        problems.push(file.name + ': ' + error.message);
      }
    }

    input.value = '';
    input.disabled = false;

    if (activeId === piece.id && view === 'reader') this.renderMedia(piece);
    this.renderFiles();

    if (problems.length) toast(problems.join('; '));
  }

  /** Громкость вложения в пределах от 0 до 1. */
  volume(item) {
    return Number.isFinite(item.volume) ? Math.max(0, Math.min(1, item.volume)) : 1;
  }

  /** Пока ползунок громкости двигают, меняем звук сразу, но ещё не сохраняем. */
  previewVolume(event) {
    if (event.target.dataset.field !== 'volume') return;

    const card = event.target.closest('[data-media-id]');
    const entry = this.media.find(m => m.card === card);
    if (!entry) return;

    const volume = Number(event.target.value);
    if (!Number.isFinite(volume)) return;

    entry.previewVolume = true;
    entry.el.volume = Math.max(0, Math.min(1, volume));
    entry.el.muted = false;
    card.querySelector('.media-volume output').textContent = Math.round(entry.el.volume * 100) + '%';
  }

  /** Меняется любое поле вложения: громкость, «С плеером», начало, конец. */
  async changeMedia(event) {
    const field = event.target.dataset.field;
    const card = event.target.closest('[data-media-id]');
    if (!field || !card) return;

    const piece = songs.find(p => p.id === activeId);
    const item = piece?.media?.find(m => m.id === card.dataset.mediaId);
    if (!item) return;

    if (field.startsWith('layout')) {
      const entry = this.media.find(m => m.card === card);
      if (entry && entry.type !== 'audio') await this.saveLayout(entry, piece);
      return;
    }

    const previous = { ...item };
    const value = field === 'sync'
      ? event.target.checked
      : event.target.value === '' ? null : Number(event.target.value);

    if (field === 'volume') {
      if (!Number.isFinite(value) || value < 0 || value > 1) return;

      const entry = this.media.find(m => m.card === card);
      if (entry) {
        entry.previewVolume = false;
        entry.el.volume = value;
        entry.el.muted = false;
        card.querySelector('.media-volume output').textContent = Math.round(value * 100) + '%';
      }
    }

    item[field] = value;

    const badNumber = field !== 'sync' && value !== null && (!Number.isFinite(value) || value < 0);
    const endBeforeStart = item.end !== null && Number(item.end) <= Number(item.start);

    if (badNumber || endBeforeStart) {
      Object.assign(item, previous);
      event.target.value = previous[field] ?? '';
      toast('Конец должен быть позже начала; время не может быть отрицательным.');
      return;
    }

    try {
      await putPiece(piece);
      if (field !== 'volume') this.sync(currentPosition(), playing, playSpeed, true);
    } catch (error) {
      Object.assign(item, previous);
      this.renderMedia(piece);
      toast(error.message);
    }
  }

  /** Кнопки в карточке: «Начать отсюда» и «Удалить». */
  async mediaClick(event) {
    const action = event.target.dataset.mediaAction;
    const card = event.target.closest('[data-media-id]');
    if (!action || !card) return;

    const piece = songs.find(p => p.id === activeId);
    const item = piece?.media?.find(m => m.id === card.dataset.mediaId);
    if (!item) return;

    if (action === 'reset-layout') {
      const entry = this.media.find(m => m.card === card);
      if (!entry || entry.type === 'audio') return;
      card.querySelector('[data-field=layoutWidth]').value = 100;
      card.querySelector('[data-field=layoutHeight]').value = 320;
      card.querySelector('[data-field=layoutFit]').value = 'contain';
      await this.saveLayout(entry, piece);
      return;
    }

    if (action === 'here') {
      // Подставляем текущую позицию нот в поле «С».
      const field = card.querySelector('[data-field="start"]');
      field.value = currentPosition().toFixed(1);
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    if (action === 'delete') {
      if (!confirm('Удалить вложение «' + item.name + '»?')) return;

      const previous = piece.media;
      piece.media = piece.media.filter(m => m.id !== item.id);

      try {
        await putPiece(piece);
        await this.request('/api/files/' + item.id, { method: 'DELETE' });
        this.renderMedia(piece);
        this.renderFiles();
      } catch (error) {
        piece.media = previous;
        await putPiece(piece).catch(() => {});
        this.renderMedia(piece);
        toast(error.message);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Синхронизация медиа с плеером нот
  // ---------------------------------------------------------------------------

  /**
   * Подгоняет все привязанные вложения под текущую позицию нот.
   * @param time      позиция в секундах партитуры
   * @param isPlaying играют ли ноты сейчас
   * @param speed     скорость воспроизведения (1 = темп из файла)
   * @param force     принудительно перемотать, даже если расхождение небольшое
   */
  sync(time, isPlaying, speed = 1, force = false) {
    let stageHasContent = false;

    for (const entry of this.media) {
      const { item, el, card, type } = entry;

      const start = Number(item.start || 0);
      const active = time >= start && (item.end == null || time < Number(item.end));

      // Подсветка карточки: активна на своём участке, приглушена вне его.
      card.classList.toggle('media-active', !!item.sync && active);
      card.classList.toggle('media-outside', !!item.sync && !active);

      // Под нотами медиа видно только на своём отрезке плеера.
      const showInStage = !!item.sync && active;
      this.placeInStage(entry, showInStage);
      stageHasContent ||= showInStage && !!entry.slot;

      if (type === 'image') continue;

      // Без привязки к плееру медиа живёт своей жизнью.
      if (!item.sync) {
        if (entry.wasSync) {
          el.pause();
          entry.wasSync = false;
        }
        continue;
      }
      entry.wasSync = true;

      const target = Math.max(0, time - start);
      const hasDuration = Number.isFinite(el.duration);
      const seekTarget = hasDuration ? Math.min(target, el.duration) : target;
      const ended = hasDuration && target >= el.duration;

      if (!active || !isPlaying || ended) el.pause();

      // Перематываем, если медиа заметно расходится с нотами.
      if (el.readyState) {
        const drift = Math.abs(el.currentTime - seekTarget);
        const needsSeek = ((force || !isPlaying) && drift > 0.05) || drift > 0.35;
        if (needsSeek) {
          try {
            el.currentTime = seekTarget;
          } catch {
            // Браузер ещё не позволяет перематывать — попробуем при следующей синхронизации.
          }
        }
      }

      if (el.playbackRate !== speed) el.playbackRate = speed;

      const shouldPlay = active && isPlaying && !ended && el.paused && !entry.pending && !entry.blocked;
      if (shouldPlay) this.startMedia(entry);
    }

    $('#scoreMedia').classList.toggle('hidden', !stageHasContent);
  }

  /** Запускает воспроизведение; если браузер запретил автозапуск — просим нажать вручную. */
  startMedia(entry) {
    const { item, el, card } = entry;
    entry.pending = true;

    el.play()
      .catch(error => {
        if (error.name === 'AbortError') return;
        entry.blocked = true;
        card.querySelector('.media-error').textContent = 'Нажмите ▶ на медиа, чтобы разрешить воспроизведение.';
      })
      .finally(() => {
        entry.pending = false;
        if (!playing || !item.sync || !card.isConnected) el.pause();
      });
  }

  // ---------------------------------------------------------------------------
  // Перенос старой библиотеки из браузера на сервер
  // ---------------------------------------------------------------------------

  async importBrowser() {
    const button = $('#importBrowser');
    button.disabled = true;

    try {
      const pieces = await this.readBrowserLibrary();
      const existing = new Set(songs.map(p => p.id));
      let count = 0;

      for (const piece of pieces) {
        if (existing.has(piece.id)) continue; // уже перенесено — не перезаписываем

        if (piece.demo) {
          await this.save(piece);
        } else {
          const original = piece.midiData
            ? new File([piece.midiData], piece.title + '.mid')
            : new File([piece.xml], piece.title + '.musicxml');
          await this.create(piece, original);
        }
        count++;
      }

      songs = await getAll();
      render();
      toast('Перенесено произведений: ' + count + '. Исходная библиотека браузера сохранена.');
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  /** Читает все произведения из IndexedDB текущего браузера. */
  async readBrowserLibrary() {
    const db = await openDB();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE);
      const request = transaction.objectStore(STORE).getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => db.close();
    });
  }
}
