'use strict';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const GENRES=['Все','Классика','Джаз','Поп','Рок','Саундтрек','Народная','Другое'];
let songs=[],view='home',selectedGenre='Все',search='',activeId=null,osmd=null,zoom=1, audioEngine=null,pausedAt=0,playing=false,playSpeed=1,playback=[],totalDuration=0,rafId=0,lastView='library';
let audioStarted=0;
let scoreTiming=null,visualNotes=[],scoreLines=[],highlighted=new Set(),shownLine=-1,readerRequest=0,playRequest=0,resizeObserver=null;
const DBNAME='nota-local-library',STORE='pieces';
const studio=new NotaStudio();
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DBNAME,1);r.onupgradeneeded=()=>r.result.createObjectStore(STORE,{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function getAll(){if(studio.online)return studio.request('/api/pieces');const db=await openDB();return new Promise((resolve,reject)=>{const t=db.transaction(STORE,'readonly'),r=t.objectStore(STORE).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);t.oncomplete=()=>db.close()})}
async function putPiece(p){if(studio.online)return studio.save(p);const db=await openDB();return new Promise((resolve,reject)=>{const t=db.transaction(STORE,'readwrite');t.objectStore(STORE).put(p);t.oncomplete=()=>{db.close();resolve()};t.onerror=()=>reject(t.error)})}
async function removePiece(id){if(studio.online){await studio.saving.catch(()=>{});return studio.request('/api/pieces/'+encodeURIComponent(id),{method:'DELETE'})}const db=await openDB();return new Promise((resolve,reject)=>{const t=db.transaction(STORE,'readwrite');t.objectStore(STORE).delete(id);t.oncomplete=()=>{db.close();resolve()};t.onerror=()=>reject(t.error)})}
function toast(message){$('#toast').textContent=message;$('#toast').classList.remove('hidden');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').classList.add('hidden'),3200)}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function noteName(m){return ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][((m%12)+12)%12]+(Math.floor(m/12)-1)}
function demoXML(title,composer,notes){let blocks='';notes.forEach((n,i)=>{const m=n.match(/^([A-G])(#|b)?(\d)$/);if(!m)return;blocks+=`<note><pitch><step>${m[1]}</step>${m[2]?`<alter>${m[2]==='#'?1:-1}</alter>`:''}<octave>${m[3]}</octave></pitch><duration>1</duration><type>quarter</type></note>`});return `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE score-partwise  PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd"><score-partwise version="4.0"><work><work-title>${esc(title)}</work-title></work><movement-title>${esc(title)}</movement-title><identification><creator type="composer">${esc(composer)}</creator></identification><defaults><scaling><millimeters>7</millimeters><tenths>40</tenths></scaling></defaults><part-list><score-part id="P1"><part-name>Piano</part-name><part-abbreviation>Pno</part-abbreviation><score-instrument id="I1"><instrument-name>Piano</instrument-name></score-instrument><midi-instrument id="I1"><midi-channel>1</midi-channel><midi-program>1</midi-program></midi-instrument></score-part></part-list><part id="P1">${Array.from({length:Math.ceil(notes.length/4)},(_,k)=>`<measure implicit="no" number="${k+1}">${k===0?'<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><direction placement="above"><direction-type><metronome parentheses="no"><beat-unit>quarter</beat-unit><per-minute>110</per-minute></metronome></direction-type><sound tempo="110" /></direction>':''}${blocks.split('</note>').slice(k*4,k*4+4).filter(Boolean).map(s=>s+'</note>').join('')}</measure>`).join('')}</part></score-partwise>`}
const demos=[['К маленькой Элизе','Людвиг ван Бетховен','Классика','E5 D#5 E5 D#5 E5 B4 D5 C5 A4 C4 E4 A4 B4 E4 G#4 B4 C5 E4 E5 D#5 E5 D#5 E5 B4 D5 C5 A4'],['Ода к радости','Людвиг ван Бетховен','Классика','E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4 D4 D4 E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4 C4 C4'],['Утренняя мелодия','Nota Studio','Поп','C5 E5 G5 E5 A4 C5 E5 C5 F4 A4 C5 A4 G4 B4 D5 B4 C5 E5 G5 E5'],['Вечерний джаз','Nota Studio','Джаз','D4 F4 A4 C5 B4 G4 F4 D4 E4 G4 B4 D5 C5 A4 G4 E4'],['Мелодия ветра','Nota Studio','Саундтрек','G4 A4 C5 D5 E5 D5 C5 A4 G4 E4 G4 A4 C5 A4 G4 E4']];
async function seed(){songs=await getAll();if(!songs.length){for(let i=0;i<demos.length;i++){const [title,author,genre,seq]=demos[i],p={id:'demo-'+i,title,author,genre,kind:'musicxml',xml:demoXML(title,author,seq.split(' ')),favorite:false,created:Date.now()-i*1000000,demo:true};await putPiece(p)}songs=await getAll()}}
function setView(v){if(v!=='reader')lastView=v;view=v;$$('.view').forEach(el=>el.classList.toggle('hidden',el.id!==v+'View'));$$('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.view===v));if(v!=='reader'){stop();studio.close()}render();window.scrollTo({top:0,behavior:'instant'})}
function genreHtml(){const h=GENRES.slice(1).map(g=>`<button class="genre-button" data-genre="${esc(g)}"><span class="genre-circle"></span>${esc(g)}</button>`).join('');$('#genreNav').innerHTML=h;$('#genreFilters').innerHTML=GENRES.map(g=>`<button class="chip ${g===selectedGenre?'active':''}" data-filter="${esc(g)}">${esc(g)}</button>`).join('')}
function matching(list){let result=list.filter(p=>(selectedGenre==='Все'||p.genre===selectedGenre)&&(!search||[p.title,p.author,p.genre].join(' ').toLowerCase().includes(search)));const order=$('#sortSelect').value;return result.sort((a,b)=>order==='title'?a.title.localeCompare(b.title,'ru'):order==='author'?a.author.localeCompare(b.author,'ru'):b.created-a.created)}
function card(p){const i=Math.abs([...p.id].reduce((n,c)=>n+c.charCodeAt(0),0))%5;return `<article class="music-card"><div class="card-art art-${i}" data-open="${esc(p.id)}"><span class="art-note">${['♫','𝄞','♬','♪','♩'][i]}</span><button class="card-heart ${p.favorite?'liked':''}" data-fav="${esc(p.id)}" title="Добавить в избранное">${p.favorite?'♥':'♡'}</button></div><div class="card-info" data-open="${esc(p.id)}"><span class="genre-pill">${esc(p.genre)}</span><h3 title="${esc(p.title)}">${esc(p.title)}</h3><p>${esc(p.author||'Неизвестный автор')}</p><div class="card-foot"><span>${p.kind==='midi'?'MIDI':'MusicXML'} ${p.demo?'· Пример':''}</span><span>Открыть ноты ↗</span></div></div></article>`}
function renderGrid(sel,collection){$(sel).innerHTML=collection.length?collection.map(card).join(''):`<div class="empty-state"><div class="empty-icon">♫</div><strong>Пока ничего не найдено</strong><div>Попробуйте другой запрос или загрузите своё произведение.</div></div>`}
function render(){genreHtml();$('#statTotal').textContent=songs.length;$('#statGenres').textContent=new Set(songs.map(p=>p.genre)).size;$('#statFavorites').textContent=songs.filter(p=>p.favorite).length;renderGrid('#recentGrid',matching(songs).slice(0,6));renderGrid('#libraryGrid',matching(songs));renderGrid('#favoritesGrid',matching(songs.filter(p=>p.favorite)));studio.renderFiles()}
async function favorite(id){const p=songs.find(x=>x.id===id);if(!p)return;p.favorite=!p.favorite;await putPiece(p);render();if(activeId===id)$('#favoriteReader').textContent=p.favorite?'♥':'♡'}
function modal(show){$('#uploadModal').classList.toggle('hidden',!show);$('#uploadError').classList.add('hidden');if(!show){$('#uploadForm').reset();$('#chosenFile').classList.add('hidden')}}
function pickFile(file){if(!file)return;$('#chosenFile').textContent=`Выбран файл: ${file.name} (${(file.size/1024).toFixed(1)} КБ)`;$('#chosenFile').classList.remove('hidden');if(!$('#titleInput').value)$('#titleInput').value=file.name.replace(/\.(musicxml|xml|mxl|midi|mid)$/i,'').replaceAll('_',' ')}
const directText=(parent,tag)=>[...parent?.children||[]].find(x=>x.localName===tag)?.textContent?.trim()||'';
function parseXml(str){const doc=new DOMParser().parseFromString(str,'application/xml');if(doc.querySelector('parsererror')||doc.documentElement.localName!=='score-partwise')throw Error('Файл не является корректным MusicXML (score-partwise).');return doc}
// All times are score seconds. Audio, highlighting and measure changes share this clock.
function parseMusicXML(str){
 const doc=parseXml(str),parts=[...doc.querySelectorAll('part')],raw=[],tempos=[],lengths=[],labels=[];
 for(const [partIndex,part] of parts.entries()){
  let divisions=1,beats=4,beatType=4;
  [...part.children].filter(n=>n.localName==='measure').forEach((measure,index)=>{
   let position=0,lastStart=0,extent=0;
   labels[index]??=measure.getAttribute('number')||String(index+1);
   for(const node of measure.children){
    if(node.localName==='attributes'){
     const d=Number(directText(node,'divisions'));if(d>0)divisions=d;
     const time=[...node.children].find(n=>n.localName==='time');
     if(time){beats=directText(time,'beats').split('+').reduce((a,b)=>a+Number(b),0)||beats;beatType=Number(directText(time,'beat-type'))||beatType}
    }
    if(node.localName==='direction'&&partIndex===0){
     const sound=node.querySelector('sound[tempo]'),met=node.querySelector('metronome');
     let bpm=Number(sound?.getAttribute('tempo'));
     if(!(bpm>0)&&met){const units={whole:4,half:2,quarter:1,eighth:.5,'16th':.25};bpm=Number(directText(met,'per-minute'))*(units[directText(met,'beat-unit')]||1)*(met.querySelector('beat-unit-dot')?1.5:1)}
     if(bpm>0)tempos.push({measure:index,beat:position+Number(directText(node,'offset'))/divisions,bpm});
    }
    if(node.localName==='backup'){position-=Number(directText(node,'duration'))/divisions;continue}
    if(node.localName==='forward'){position+=Number(directText(node,'duration'))/divisions;extent=Math.max(extent,position);continue}
    if(node.localName!=='note')continue;
    const grace=!!node.querySelector(':scope > grace'),chord=!!node.querySelector(':scope > chord');
    const duration=grace?0:Number(directText(node,'duration'))/divisions;
    const start=chord?lastStart:position;if(!chord)lastStart=start;
    const pitch=node.querySelector(':scope > pitch');
    if(pitch&&duration>0){
     const names={C:0,D:2,E:4,F:5,G:7,A:9,B:11},step=directText(pitch,'step');
     if(step in names)raw.push({measure:index,beat:start,length:duration,midi:12*(Number(directText(pitch,'octave'))+1)+names[step]+Number(directText(pitch,'alter')),voice:partIndex+':'+(directText(node,'voice')||'1')+':'+(directText(node,'staff')||'1'),tieStart:!!node.querySelector('tie[type="start"]'),tieStop:!!node.querySelector('tie[type="stop"]')});
    }
    // Chord tones never move the time cursor a second time.
    if(!chord)position+=duration;extent=Math.max(extent,start+duration,position);
   }
   const pickup=measure.getAttribute('implicit')==='yes'||index===0;
   lengths[index]=Math.max(lengths[index]||0,pickup&&extent>0?extent:Math.max(extent,beats*4/beatType));
  });
 }
 const starts=[];let endBeat=0;lengths.forEach(n=>{starts.push(endBeat);endBeat+=n});
 const changes=[{beat:0,bpm:120},...tempos.map(t=>({beat:Math.max(0,starts[t.measure]+t.beat),bpm:t.bpm}))].sort((a,b)=>a.beat-b.beat);
 const secondsAt=beat=>{let seconds=0,last=0,bpm=120;for(const c of changes){if(c.beat>beat)break;seconds+=(c.beat-last)*60/bpm;last=c.beat;bpm=c.bpm}return seconds+(beat-last)*60/bpm};
 const notes=[],ties=new Map();
 raw.sort((a,b)=>(starts[a.measure]+a.beat)-(starts[b.measure]+b.beat)).forEach(n=>{
  const beat=starts[n.measure]+n.beat,time=secondsAt(beat),end=secondsAt(beat+n.length),key=n.voice+':'+n.midi,previous=ties.get(key);
  if(n.tieStop&&previous&&Math.abs(previous.time+previous.duration-time)<.001){previous.duration=end-previous.time;if(!n.tieStart)ties.delete(key)}
  else {const note={midi:n.midi,time,duration:end-time,velocity:.75};notes.push(note);if(n.tieStart)ties.set(key,note);else ties.delete(key)}
 });
 return {notes,bpm:changes.filter(c=>c.beat===0).at(-1).bpm,duration:secondsAt(endBeat),secondsAt,measures:starts.map((beat,i)=>({time:secondsAt(beat),end:secondsAt(beat+lengths[i]),label:labels[i]}))};
}
// One system (including all instruments / both piano hands) per measure.
function lineScoreXML(xml){
 const doc=parseXml(xml);
 doc.querySelectorAll('print').forEach(n=>n.remove());
 doc.querySelectorAll('part').forEach(part=>[...part.children].filter(n=>n.localName==='measure').forEach((measure,i)=>{
  if(!i)return;const print=doc.createElementNS(measure.namespaceURI,'print');print.setAttribute('new-system','yes');measure.insertBefore(print,measure.firstChild);
 }));
 return new XMLSerializer().serializeToString(doc);
}
function clearHighlights(){highlighted.forEach(el=>el.classList.remove('note-playing'));highlighted.clear()}
function buildScoreMap(){
 clearHighlights();visualNotes=[];scoreLines=[];shownLine=-1;
 const systems=osmd.GraphicSheet.MusicPages.flatMap(page=>page.MusicSystems);
 for(const [index,measures] of osmd.GraphicSheet.MeasureList.entries()){
  const measure=measures.find(Boolean);if(!measure)continue;
  const system=measure.ParentMusicSystem,box=system.PositionAndShape;
  const scale=10*zoom,top=(box.AbsolutePosition.y+box.BorderTop)*scale,bottom=(box.AbsolutePosition.y+box.BorderBottom)*scale;
  scoreLines.push({index,system,top,bottom,...scoreTiming.measures[index]});
  for(const staff of measures){if(!staff)continue;
   for(const entry of staff.staffEntries){
    const beat=entry.getAbsoluteTimestamp().RealValue*4;
    for(const voice of entry.graphicalVoiceEntries)for(const g of voice.notes){
     const source=g.sourceNote;if(!source||source.isRest())continue;
     const el=g.getSVGGElement?.();if(!el)continue;
     // VexFlow groups a chord together: color only this tone's notehead.
     const head=el.querySelectorAll('.vf-notehead')[g.vfnoteIndex||0]||el;
     visualNotes.push({el:head,time:scoreTiming.secondsAt(beat),end:scoreTiming.secondsAt(beat+source.Length.RealValue*4)});
    }
   }
  }
 }
 // Clip in the gap between systems so neighbouring rows cannot leak into view.
 scoreLines.forEach(line=>{const i=systems.indexOf(line.system),prev=systems[i-1],next=systems[i+1];
  line.clipTop=Math.max(0,line.top-16);
  line.clipBottom=line.bottom+16;
  if(prev){const b=prev.PositionAndShape;line.clipTop=Math.max(line.clipTop,((b.AbsolutePosition.y+b.BorderBottom)*10*zoom+line.top)/2)}
  if(next){const b=next.PositionAndShape;line.clipBottom=Math.min(line.clipBottom,(line.bottom+(b.AbsolutePosition.y+b.BorderTop)*10*zoom)/2)}
 });
 syncScore(pausedAt,false);
}
function syncScore(time,light=true){
 if(!scoreTiming||!scoreLines.length)return;
 let index=0;for(let i=0;i<scoreLines.length;i++){if(scoreLines[i].time<=time+.00001)index=i;else break}
 const line=scoreLines[index];
 if(index!==shownLine){
  shownLine=index;$('#scoreViewport').style.height=Math.max(100,line.clipBottom-line.clipTop)+'px';
  $('#score').style.top=-line.clipTop+'px';$('#scoreContainer').scrollLeft=0;
  $('#measureLabel').textContent=`Такт ${line.label} · ${index+1} / ${scoreLines.length}`;
 }
 const current=new Set(light?visualNotes.filter(n=>n.time<=time+.00001&&n.end>time+.00001).map(n=>n.el):[]);
 highlighted.forEach(el=>{if(!current.has(el))el.classList.remove('note-playing')});
 current.forEach(el=>{if(!highlighted.has(el))el.classList.add('note-playing')});highlighted=current;
 const active=light?playback.filter(n=>n.time<=time+.00001&&n.time+n.duration>time+.00001):[];
 const names=[...new Set(active.map(n=>noteName(n.midi)))];
 $('#soundingNotes').textContent=names.length?'Звучит: '+names.join(' · '):light?'Пауза в нотах':'Нажмите ▶ для воспроизведения';
}
function renderScore(){if(!osmd||!scoreTiming)return;osmd.Zoom=zoom;osmd.render();buildScoreMap();syncScore(currentPosition(),playing||pausedAt>0)}
function currentPosition(){return Math.min(totalDuration,pausedAt+(playing?Math.max(0,audioEngine?audioEngine.position(audioStarted):0)*playSpeed:0))}
function midiToXml(midi,title,author){const ppq=midi.header.ppq||480,bpm=midi.header.tempos[0]?.bpm||120;const tracks=midi.tracks.filter(t=>t.notes.length);if(!tracks.length)throw Error('MIDI-файл не содержит нот.');let parts='';let partList='';tracks.slice(0,12).forEach((tr,idx)=>{const id=`P${idx+1}`;partList+=`<score-part id="${id}"><part-name>${esc(tr.name||'Инструмент '+(idx+1))}</part-name><part-abbreviation>Pno</part-abbreviation><score-instrument id="I${idx}"><instrument-name>Piano</instrument-name></score-instrument></score-part>`;const notes=tr.notes.map(n=>({tick:Math.max(0,Math.round(n.ticks/ppq*4)),len:Math.max(1,Math.round(n.durationTicks/ppq*4)),midi:n.midi})).sort((a,b)=>a.tick-b.tick);const maxTick=Math.min(4*4*350,Math.max(16,...notes.map(n=>n.tick+n.len)));let measures='';for(let start=0,no=1;start<maxTick;start+=16,no++){let pos=0,out='';const current=notes.filter(n=>n.tick>=start&&n.tick<start+16);let groups=new Map();for(const n of current){const t=n.tick-start;if(!groups.has(t))groups.set(t,[]);groups.get(t).push(n)}for(const [t,group] of [...groups.entries()].sort((a,b)=>a[0]-b[0])){if(t>pos){out+=xmlRest(t-pos);pos=t}let len=Math.min(16-t,Math.max(1,Math.min(...group.map(n=>n.len))));group.slice(0,16).forEach((n,j)=>{out+=xmlPitch(n.midi,len,j!==0)});pos=t+len}if(pos<16)out+=xmlRest(16-pos);measures+=`<measure number="${no}">${no===1?`<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(bpm)}</per-minute></metronome></direction-type><sound tempo="${Math.round(bpm)}"/></direction>`:''}${out}</measure>`}parts+=`<part id="${id}">${measures}</part>`});return `<?xml version="1.0" encoding="utf-8"?><score-partwise version="4.0"><work><work-title>${esc(title)}</work-title></work><movement-title>${esc(title)}</movement-title><identification><creator type="composer">${esc(author)}</creator></identification><part-list>${partList}</part-list>${parts}</score-partwise>`}
function chunks(n){let result=[];for(const x of [16,8,4,2,1])while(n>=x){result.push(x);n-=x}return result}
const durationType={16:'whole',8:'half',4:'quarter',2:'eighth',1:'16th'};
function xmlRest(n){return chunks(n).map(d=>`<note><rest/><duration>${d}</duration><type>${durationType[d]}</type></note>`).join('')}
function xmlPitch(midi,len,chord){const steps=['C','C','D','D','E','F','F','G','G','A','A','B'],alt=[0,1,0,1,0,0,1,0,1,0,1,0],t=((midi%12)+12)%12;return `<note>${chord?'<chord/>':''}<pitch><step>${steps[t]}</step>${alt[t]?'<alter>1</alter>':''}<octave>${Math.floor(midi/12)-1}</octave></pitch><duration>${len}</duration><type>${durationType[len]||'quarter'}</type></note>`}
async function extractMXL(buffer){if(!window.JSZip)throw Error('Для формата MXL нужен интернет для загрузки библиотеки JSZip.');const zip=await JSZip.loadAsync(buffer);let file=Object.keys(zip.files).find(n=>/\.(musicxml|xml)$/i.test(n)&&!n.startsWith('META-INF/'));if(!file)throw Error('В архиве MXL не найден файл MusicXML.');return zip.files[file].async('string')}
async function readUpload(file,title,author){const ext=file.name.split('.').pop().toLowerCase();if(file.size>15*1024*1024)throw Error('Размер файла больше 15 МБ.');if(['mid','midi'].includes(ext)){if(!window.Midi)throw Error('Библиотека MIDI недоступна. Проверьте подключение к интернету.');const array=await file.arrayBuffer();const midi=new Midi(array);const xml=midiToXml(midi,title,author);parseXml(xml);return {kind:'midi',xml,midiData:array}}if(['xml','musicxml','mxl'].includes(ext)){const xml=ext==='mxl'?await extractMXL(await file.arrayBuffer()):await file.text();parseXml(xml);return {kind:'musicxml',xml}}throw Error('Поддерживаются только .mid, .midi, .musicxml, .xml, .mxl.')}
async function openReader(id){
 const p=songs.find(s=>s.id===id);if(!p)return;
 stop();const request=++readerRequest;resizeObserver?.disconnect();osmd?.clear();osmd=null;scoreTiming=null;scoreLines=[];visualNotes=[];playback=[];totalDuration=0;
 activeId=id;$('#readerTitle').textContent=p.title;$('#readerAuthor').textContent=p.author||'Неизвестный композитор';$('#readerGenre').textContent=p.genre.toUpperCase();$('#favoriteReader').textContent=p.favorite?'♥':'♡';$('#scoreFormat').textContent=p.kind.toUpperCase();$('#score').innerHTML='';$('#score').style.top='0';$('#scoreMessage').classList.add('hidden');$('#playBtn').disabled=true;setView('reader');studio.open(p);zoom=1;$('#zoomLabel').textContent='100%';
 try{
  if(!window.opensheetmusicdisplay)throw Error('Не удалось загрузить движок нот. Для первого запуска нужен интернет.');
  const display=new opensheetmusicdisplay.OpenSheetMusicDisplay('score',{autoResize:false,backend:'svg',drawingParameters:'compact',drawTitle:false,drawComposer:false,drawPartNames:false,pageFormat:'Endless',newSystemFromXML:true,newPageFromXML:false,renderSingleHorizontalStaffline:false});
  osmd=display;await display.load(lineScoreXML(p.xml));if(request!==readerRequest||view!=='reader')return;
  scoreTiming=parseMusicXML(p.xml);playback=scoreTiming.notes;totalDuration=scoreTiming.duration;$('#tempoInput').value=Math.round(scoreTiming.bpm);
  renderScore();$('#durationTime').textContent=formatTime(totalDuration);$('#playBtn').disabled=!playback.length;
  if(!playback.length)toast('Ноты для проигрывания не найдены');
  let width=$('#scoreContainer').clientWidth;
  resizeObserver=new ResizeObserver(()=>{const next=$('#scoreContainer').clientWidth;if(next>0&&next!==width){width=next;renderScore()}});resizeObserver.observe($('#scoreContainer'));
 }catch(e){if(request!==readerRequest)return;console.error(e);$('#scoreMessage').textContent=e.message;$('#scoreMessage').classList.remove('hidden');$('#playBtn').disabled=true}
}
function formatTime(t){t=Math.max(0,Math.floor(t));return `${Math.floor(t/60)}:${String(t%60).padStart(2,'0')}`}
function cancelSound(tail=false){cancelAnimationFrame(rafId);if(!tail)audioEngine?.stop()}
function stop(tail=false){++playRequest;cancelSound(tail);playing=false;pausedAt=0;$('#playBtn').textContent='▶';$('#playBtn').title='Воспроизвести';$('#currentTime').textContent='0:00';$('#progressFill').style.width='0%';clearHighlights();syncScore(0,false);studio.sync(0,false,playSpeed,true)}
function pause(){pausedAt=currentPosition();++playRequest;cancelSound();playing=false;$('#playBtn').textContent='▶';$('#playBtn').title='Продолжить';syncScore(pausedAt);studio.sync(pausedAt,false,playSpeed,true)}
function updateProgress(){if(!playing)return;const t=currentPosition();$('#currentTime').textContent=formatTime(t);$('#progressFill').style.width=`${Math.min(100,t/Math.max(totalDuration,.1)*100)}%`;syncScore(t);studio.sync(t,true,playSpeed);if(t>=totalDuration){stop(true);return}rafId=requestAnimationFrame(updateProgress)}
async function play(){
 if(!playback.length)return;if(playing){pause();return}
 const request=++playRequest;
 try{
  if(!audioEngine)audioEngine=new NotaAudioEngine();
  await audioEngine.prepare(playback);if(request!==playRequest||view!=='reader')return;
  if(pausedAt>=totalDuration)pausedAt=0;
  playSpeed=Math.max(.2,Math.min(4,Number($('#tempoInput').value)/scoreTiming.bpm||1));
  audioStarted=audioEngine.start(playback,pausedAt,playSpeed);
  playing=true;$('#playBtn').textContent='Ⅱ';$('#playBtn').title='Пауза';updateProgress();
 }catch(e){audioEngine?.stop();playing=false;$('#playBtn').textContent='▶';toast('Не удалось запустить звук: '+e.message)}
}
function seek(time){const resume=playing;pause();pausedAt=Math.max(0,Math.min(totalDuration,time));$('#currentTime').textContent=formatTime(pausedAt);$('#progressFill').style.width=`${pausedAt/Math.max(.1,totalDuration)*100}%`;syncScore(pausedAt);studio.sync(pausedAt,false,playSpeed,true);if(resume)play()}
function bind(){document.addEventListener('click',async e=>{const nav=e.target.closest('[data-view]');if(nav){selectedGenre='Все';setView(nav.dataset.view)}const go=e.target.closest('[data-go]');if(go){selectedGenre='Все';setView(go.dataset.go)}const f=e.target.closest('[data-filter]');if(f){selectedGenre=f.dataset.filter;render()}const g=e.target.closest('[data-genre]');if(g){selectedGenre=g.dataset.genre;setView('library')}const heart=e.target.closest('[data-fav]');if(heart){e.stopPropagation();await favorite(heart.dataset.fav);return}const card=e.target.closest('[data-open]');if(card)await openReader(card.dataset.open);if(e.target.dataset.close)modal(false)});['#sidebarUpload','#topUpload','#heroUpload'].forEach(s=>$(s).addEventListener('click',()=>modal(true)));$('#modalClose').onclick=()=>modal(false);$('#searchInput').addEventListener('input',e=>{search=e.target.value.toLowerCase().trim();if(search&&view!=='library')setView('library');else render()});$('#sortSelect').onchange=render;document.addEventListener('keydown',e=>{if(e.key==='Escape')modal(false);if(e.key==='/'&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){e.preventDefault();$('#searchInput').focus()}});$('#fileInput').onchange=e=>pickFile(e.target.files[0]);const drop=$('#dropZone');drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('dragover')});drop.addEventListener('dragleave',()=>drop.classList.remove('dragover'));drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('dragover');const files=e.dataTransfer.files;if(files.length){$('#fileInput').files=files;pickFile(files[0])}});$('#uploadForm').addEventListener('submit',async e=>{e.preventDefault();const btn=$('#uploadForm button[type=submit]');btn.disabled=true;$('#uploadError').classList.add('hidden');try{const file=$('#fileInput').files[0];if(!file)throw Error('Выберите файл.');const title=$('#titleInput').value.trim(),author=$('#authorInput').value.trim(),genre=$('#genreInput').value;if(!title)throw Error('Введите название.');const info=await readUpload(file,title,author);const p={id:crypto.randomUUID(),title,author,genre,...info,created:Date.now(),favorite:false};await studio.create(p,file);songs=await getAll();modal(false);render();toast('Произведение добавлено в вашу библиотеку');await openReader(p.id)}catch(err){$('#uploadError').textContent=err.message;$('#uploadError').classList.remove('hidden')}finally{btn.disabled=false}});$('#backButton').onclick=()=>setView(lastView==='reader'?'library':lastView);$('#favoriteReader').onclick=()=>favorite(activeId);$('#deleteReader').onclick=async()=>{const p=songs.find(s=>s.id===activeId);if(!p)return;if(!confirm(`Удалить «${p.title}» из библиотеки?`))return;await removePiece(activeId);songs=await getAll();setView('library');toast('Произведение удалено')};$('#playBtn').onclick=play;$('#stopBtn').onclick=()=>stop();$('#tempoInput').onchange=()=>{if(playing){pause();play()}};$('#progressTrack').onclick=e=>{if(!totalDuration)return;const fraction=Math.max(0,Math.min(1,(e.clientX-e.currentTarget.getBoundingClientRect().left)/e.currentTarget.clientWidth));seek(totalDuration*fraction)};$('#zoomIn').onclick=()=>zoomScore(.15);$('#zoomOut').onclick=()=>zoomScore(-.15)}
function zoomScore(d){if(!osmd)return;zoom=Math.max(.5,Math.min(1.8,zoom+d));renderScore();$('#zoomLabel').textContent=Math.round(zoom*100)+'%'}
async function init(){bind();try{await studio.init();await seed();genreHtml();render()}catch(e){console.error(e);toast('Не удалось открыть локальную библиотеку: '+e.message)}}init();
