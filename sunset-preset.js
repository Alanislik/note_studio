'use strict';

// Downloaded media, not a procedural illustration. Every installed entry is an ordinary file.
const SunsetMediaPreset = {
  id: 'sunset-deltarune-files-v1',
  pending: new Map(),
  matches(piece) {
    return [piece.title, piece.originalFile?.name].some(name =>
      String(name || '').replace(/\.(mid|midi)$/i, '').trim().toLowerCase() === 'sunset of seven suns');
  },
  install(studio, piece) {
    if (this.pending.has(piece.id)) return this.pending.get(piece.id);
    const promise = this.create(studio, piece).finally(() => this.pending.delete(piece.id));
    this.pending.set(piece.id, promise);
    return promise;
  },
  async create(studio, piece) {
    if (piece.appliedPresets?.includes(this.id)) return;
    const sources = await studio.request('/assets/sunset/sources.json');
    const downloaded = new Map();
    for (const name of ['sunset.jpg', 'kris.png', 'susie.png', 'ralsei.png']) {
      const response = await fetch('/assets/sunset/' + name);
      if (!response.ok) throw Error('Не удалось загрузить файл сцены: ' + name);
      downloaded.set(name, await response.blob());
    }
    const timing = parseMusicXML(piece.xml);
    const first = Math.round(timing.duration / 8 * 10) / 10;
    const last = Math.round(timing.duration * 5 / 6 * 10) / 10;
    const source = name => ({url: sources.find(s => s.file === name).source,
      label: name === 'sunset.jpg' ? 'Фан-арт заката · источник' : 'Featherfall · спрайт персонажа'});
    const group = 'sunset-journey';
    const clips = [
      {file:'sunset.jpg',name:'01. Закат — общий план.jpg',start:0,end:first,
        scene:{group,role:'background',zoom:1},layout:{width:100,height:420,fit:'cover'}},
      {file:'sunset.jpg',name:'02. Пустыня — полёт.jpg',start:first,end:last,
        scene:{group,role:'background',zoom:2.3},layout:{width:100,height:420,fit:'cover'}},
      {file:'kris.png',name:'03. Крис — полёт.png',start:first,end:last,
        scene:{group,role:'sprite',x:58,y:45,order:3,motion:true},layout:{width:20,height:140,fit:'contain'}},
      {file:'susie.png',name:'04. Сьюзи — полёт.png',start:first,end:last,
        scene:{group,role:'sprite',x:44,y:54,order:2,motion:true},layout:{width:20,height:140,fit:'contain'}},
      {file:'ralsei.png',name:'05. Ральзей — полёт.png',start:first,end:last,
        scene:{group,role:'sprite',x:31,y:61,order:1,motion:true},layout:{width:20,height:120,fit:'contain'}},
      {file:'sunset.jpg',name:'06. Закат — финальный план.jpg',start:last,end:null,
        scene:{group,role:'background',zoom:1},layout:{width:100,height:420,fit:'cover'}},
    ];
    const uploaded = [], added = [];
    try {
      for (const clip of clips) {
        const saved = await studio.upload(piece.id, new File([downloaded.get(clip.file)], clip.name));
        uploaded.push(saved);
        added.push({...saved, start:clip.start,end:clip.end,sync:true,volume:1,
          layout:clip.layout,scene:clip.scene,preset:this.id,source:source(clip.file)});
      }
      const oldMedia = piece.media || [], oldPresets = piece.appliedPresets || [];
      piece.media = [...oldMedia, ...added];
      piece.appliedPresets = [...oldPresets, this.id];
      try { await putPiece(piece); }
      catch (error) {
        piece.media = (piece.media || []).filter(item => !added.some(a => a.id === item.id));
        piece.appliedPresets = oldPresets;
        throw error;
      }
    } catch (error) {
      await Promise.allSettled(uploaded.map(file => studio.request('/api/files/' + file.id, {method:'DELETE'})));
      throw error;
    }
  },
};
