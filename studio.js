'use strict';

class NotaStudio {
 constructor(){this.online=false;this.urls=[];this.media=[];this.saving=Promise.resolve();this.lastPiece=null}
 async request(path,options={}){
  const response=await fetch(path,options);
  if(!response.ok){let message='Не удалось выполнить запрос.';try{message=(await response.json()).error||message}catch{}throw Error(message)}
  return response.json();
 }
 async init(){
  try{const status=await this.request('/api/status');this.online=status.storage==='folder'}catch{this.online=false}
  $('#storageNotice').textContent=this.online?'Хранилище: папка data · оригиналы нот и медиа сохраняются отдельно от сайта':'Хранилище: этот браузер · для сохранения в папку data запустите python3 server.py';
  $('#storageDescription').textContent=this.online?'Файлы находятся в data/uploads на компьютере или сервере, где запущен сайт. Скачайте оригинал или откройте произведение.':'Сейчас данные находятся в IndexedDB этого браузера. Запустите python3 server.py, чтобы хранить оригиналы и медиа в отдельной папке data.';
  $('#importBrowser').hidden=!this.online;
  $('#filesUpload').onclick=()=>modal(true);
  $('#importBrowser').onclick=()=>this.importBrowser();
  $('#mediaInput').onchange=e=>this.addMedia(e.target.files);
  for(const id of ['noteColor','noteGlow','notePulse'])$('#'+id).addEventListener('change',()=>this.saveEffects());
  $('#resetEffects').onclick=()=>{this.applyEffects({});this.saveEffects()};
  $('#mediaList').addEventListener('change',e=>this.changeMedia(e));
  $('#mediaList').addEventListener('click',e=>this.mediaClick(e));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)this.sync(currentPosition(),playing,playSpeed,true)});
 }
 save(piece){
  // Serialize writes so rapid settings changes cannot overwrite newer state.
  const {midiData,...document}=piece;
  const body=JSON.stringify(document);
  const pending=this.saving.catch(()=>{}).then(()=>this.request('/api/pieces/'+encodeURIComponent(piece.id),{method:'PUT',headers:{'Content-Type':'application/json'},body}));
  this.saving=pending;return pending;
 }
 async upload(pieceId,file){return this.request('/api/pieces/'+encodeURIComponent(pieceId)+'/files?name='+encodeURIComponent(file.name),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file})}
 async create(piece,file){
  await putPiece(piece);
  if(!this.online)return;
  try{piece.originalFile=await this.upload(piece.id,file);await putPiece(piece)}
  catch(error){await removePiece(piece.id);throw error}
 }
 renderFiles(){
  const uploaded=songs.filter(p=>!p.demo);
  $('#filesSummary').textContent=`Загружено произведений: ${uploaded.length} · Медиафайлов: ${uploaded.reduce((n,p)=>n+(p.media?.length||0),0)}`;
  $('#uploadedFiles').innerHTML=uploaded.length?uploaded.map(p=>{
   const original=p.originalFile;return `<article class="file-row"><div><strong>${esc(p.title)}</strong><small>${esc(original?.name||'Оригинал не сохранён · можно скачать MusicXML')} · ${esc(p.kind.toUpperCase())}${original?' · '+this.size(original.size):''}</small><small>Медиа: ${p.media?.length||0}${this.online?' · data/uploads/'+esc(p.id):' · этот браузер'}</small></div><div class="file-actions"><button class="btn" data-open="${esc(p.id)}">Открыть ноты</button><button class="text-link" data-download-piece="${esc(p.id)}">Скачать ${original?'оригинал':'MusicXML'}</button></div></article>`;
  }).join(''):'<div class="empty-state"><strong>Здесь будут ваши загруженные ноты</strong><p>Демонстрационные произведения остаются в библиотеке.</p></div>';
  $('#uploadedFiles').querySelectorAll('[data-download-piece]').forEach(button=>button.onclick=()=>this.downloadPiece(button.dataset.downloadPiece));
 }
 size(n){return n<1048576?(n/1024).toFixed(1)+' КБ':(n/1048576).toFixed(1)+' МБ'}
 download(url,name){const link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove()}
 downloadPiece(id){const piece=songs.find(p=>p.id===id);if(!piece)return;
  if(piece.originalFile&&this.online){this.download(piece.originalFile.url+'?download=1',piece.originalFile.name);return}
  const url=URL.createObjectURL(new Blob([piece.xml],{type:'application/vnd.recordare.musicxml+xml'}));this.download(url,piece.title+'.musicxml');setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 close(){for(const item of this.media)item.el?.pause?.();for(const url of this.urls)URL.revokeObjectURL(url);this.media=[];this.urls=[];this.lastPiece=null}
 async open(piece){this.close();this.lastPiece=piece.id;this.applyEffects(piece.effects||{});this.renderMedia(piece)}
 applyEffects(effects){
  const color=/^#[0-9a-f]{6}$/i.test(effects.color||'')?effects.color:'#8b4ce8';
  $('#noteColor').value=color;$('#noteGlow').checked=effects.glow!==false;$('#notePulse').checked=!!effects.pulse;
  $('#score').style.setProperty('--note-color',color);$('#score').classList.toggle('effect-glow',effects.glow!==false);$('#score').classList.toggle('effect-pulse',!!effects.pulse);
 }
 async saveEffects(){
  const piece=songs.find(p=>p.id===activeId);if(!piece)return;
  const previous=piece.effects;
  const effects={color:$('#noteColor').value,glow:$('#noteGlow').checked,pulse:$('#notePulse').checked};
  piece.effects=effects;this.applyEffects(effects);
  try{await putPiece(piece)}catch(error){if(piece.effects===effects){piece.effects=previous;this.applyEffects(previous||{})}toast(error.message)}
 }
 renderMedia(piece){
  for(const item of this.media)item.el?.pause?.();this.media=[];
  $('#mediaInput').disabled=!this.online;
  $('#mediaStatus').textContent=this.online?'Файлы сохраняются в data/uploads/'+piece.id:'Для добавления медиа запустите python3 server.py. Ноты из браузера можно перенести в разделе «Мои файлы».';
  const list=$('#mediaList');list.replaceChildren();
  for(const item of piece.media||[]){
   const card=document.createElement('article');card.className='media-card';card.dataset.mediaId=item.id;
   const type=item.type.startsWith('image/')?'image':item.type.startsWith('video/')?'video':'audio';
   // Media URLs always point to our own file endpoint, never to arbitrary HTML.
   const url='/api/files/'+encodeURIComponent(item.id);
   card.innerHTML=`<div class="media-preview"></div><div class="media-info"><strong>${esc(item.name)}</strong><small>${type==='image'?'Изображение':type==='video'?'Видео':'Аудио'} · ${this.size(item.size)}</small><div class="media-timing"><label><input type="checkbox" data-field="sync" ${item.sync?'checked':''}> С плеером</label><label>С <input type="number" min="0" step="0.1" data-field="start" value="${Number(item.start)||0}" aria-label="Начало ${esc(item.name)}"> сек</label><label>До <input type="number" min="0" step="0.1" data-field="end" value="${Number(item.end)||''}" placeholder="конца" aria-label="Конец ${esc(item.name)}"> сек</label></div><div class="media-actions"><button class="text-link" data-media-action="here">Начать отсюда</button><a class="text-link" href="${url}?download=1" download>Скачать</a><button class="text-link danger" data-media-action="delete">Удалить</button></div><p class="media-error" role="status"></p></div>`;
   let el;
   if(type==='image'){el=document.createElement('img');el.alt=item.name;el.loading='lazy'}
   else{el=document.createElement(type);el.controls=true;el.preload='metadata';el.playsInline=true;el.addEventListener('loadedmetadata',()=>this.sync(currentPosition(),playing,playSpeed,true));el.addEventListener('error',()=>card.querySelector('.media-error').textContent='Браузер не смог открыть этот формат. Можно скачать файл и открыть его отдельно.')}
   if(type!=='image')el.addEventListener('play',()=>{const entry=this.media.find(m=>m.el===el);if(entry){entry.blocked=false;card.querySelector('.media-error').textContent=''}});
   el.src=url;card.querySelector('.media-preview').append(el);list.append(card);
   this.media.push({item,el,card,type,pending:false});
  }
  if(!this.media.length)list.innerHTML='<div class="media-empty">Пока нет вложений. Добавьте видео исполнения, аудиозапись или иллюстрации.</div>';
  this.sync(currentPosition(),playing,playSpeed,true);
 }
 async addMedia(files){
  const piece=songs.find(p=>p.id===activeId);if(!piece||!this.online)return;
  const input=$('#mediaInput');input.disabled=true;const problems=[];
  for(const file of files){
   let uploaded;
   try{
    if(!/\.(mp3|wav|ogg|flac|m4a|mp4|webm|mov|png|jpe?g|webp|gif)$/i.test(file.name))throw Error('Неподдерживаемый формат');
    if(file.size>100*1024*1024)throw Error('Максимум 100 МБ');
    $('#mediaStatus').textContent='Сохраняется: '+file.name;
    uploaded=await this.upload(piece.id,file);
    const item={...uploaded,start:0,end:null,sync:false};piece.media=[...(piece.media||[]),item];
    try{await putPiece(piece)}catch(error){piece.media=piece.media.filter(m=>m.id!==item.id);throw error}
   }catch(error){if(uploaded)await this.request('/api/files/'+uploaded.id,{method:'DELETE'}).catch(()=>{});problems.push(file.name+': '+error.message)}
  }
  input.value='';input.disabled=false;
  if(activeId===piece.id&&view==='reader')this.renderMedia(piece);this.renderFiles();
  if(problems.length)toast(problems.join('; '));
 }
 async changeMedia(event){
  const field=event.target.dataset.field,card=event.target.closest('[data-media-id]');if(!field||!card)return;
  const piece=songs.find(p=>p.id===activeId),item=piece?.media?.find(m=>m.id===card.dataset.mediaId);if(!item)return;
  const previous={...item};const value=field==='sync'?event.target.checked:event.target.value===''?null:Number(event.target.value);
  item[field]=value;
  if((field!=='sync'&&value!==null&&(!Number.isFinite(value)||value<0))||(item.end!==null&&Number(item.end)<=Number(item.start))){Object.assign(item,previous);event.target.value=previous[field]??'';toast('Конец должен быть позже начала; время не может быть отрицательным.');return}
  try{await putPiece(piece);this.sync(currentPosition(),playing,playSpeed,true)}catch(error){Object.assign(item,previous);this.renderMedia(piece);toast(error.message)}
 }
 async mediaClick(event){
  const action=event.target.dataset.mediaAction,card=event.target.closest('[data-media-id]');if(!action||!card)return;
  const piece=songs.find(p=>p.id===activeId),item=piece?.media?.find(m=>m.id===card.dataset.mediaId);if(!item)return;
  if(action==='here'){
   const field=card.querySelector('[data-field="start"]');field.value=currentPosition().toFixed(1);field.dispatchEvent(new Event('change',{bubbles:true}));return;
  }
  if(action==='delete'){
   if(!confirm('Удалить вложение «'+item.name+'»?'))return;
   const previous=piece.media;piece.media=piece.media.filter(m=>m.id!==item.id);
   try{await putPiece(piece);await this.request('/api/files/'+item.id,{method:'DELETE'});this.renderMedia(piece);this.renderFiles()}catch(error){piece.media=previous;await putPiece(piece).catch(()=>{});this.renderMedia(piece);toast(error.message)}
  }
 }
 sync(time,isPlaying,speed=1,force=false){
  for(const entry of this.media){
   const {item,el,card,type}=entry;
   const active=time>=Number(item.start||0)&&(item.end==null||time<Number(item.end));
   card.classList.toggle('media-active',!!item.sync&&active);
   card.classList.toggle('media-outside',!!item.sync&&!active);
   if(type==='image')continue;
   if(!item.sync){if(entry.wasSync){el.pause();entry.wasSync=false}continue}
   entry.wasSync=true;
   const target=Math.max(0,(time-Number(item.start||0)));
   const seekTarget=Number.isFinite(el.duration)?Math.min(target,el.duration):target;
   const ended=Number.isFinite(el.duration)&&target>=el.duration;
   if(!active||!isPlaying||ended)el.pause();
   if(el.readyState&&((force||!isPlaying)&&Math.abs(el.currentTime-seekTarget)>.05||Math.abs(el.currentTime-seekTarget)>.35)){
    try{el.currentTime=seekTarget}catch{}
   }
   if(el.playbackRate!==speed)el.playbackRate=speed;
   if(active&&isPlaying&&!ended&&el.paused&&!entry.pending&&!entry.blocked){
    entry.pending=true;el.play().catch(error=>{if(error.name!=='AbortError'){entry.blocked=true;card.querySelector('.media-error').textContent='Нажмите ▶ на медиа, чтобы разрешить воспроизведение.'}}).finally(()=>{entry.pending=false;if(!playing||!item.sync||!card.isConnected)el.pause()});
   }
  }
 }
 async importBrowser(){
  const button=$('#importBrowser');button.disabled=true;
  try{
   const db=await openDB();const pieces=await new Promise((resolve,reject)=>{const tx=db.transaction(STORE);const r=tx.objectStore(STORE).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);tx.oncomplete=()=>db.close()});
   const existing=new Set(songs.map(p=>p.id));let count=0;
   for(const piece of pieces){if(existing.has(piece.id))continue;
    if(!piece.demo){const original=piece.midiData?new File([piece.midiData],piece.title+'.mid'):new File([piece.xml],piece.title+'.musicxml');await this.create(piece,original)}else await this.save(piece);count++;
   }
   songs=await getAll();render();toast('Перенесено произведений: '+count+'. Исходная библиотека браузера сохранена.');
  }catch(error){toast(error.message)}finally{button.disabled=false}
 }
}
