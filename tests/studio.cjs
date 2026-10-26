// Run: node --test tests/studio.cjs. Requires Playwright, Chromium, Python 3 and curl.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
let server,browser,page,base,temp,osmd,errors=[];
before(async()=>{
 temp=fs.mkdtempSync(path.join(os.tmpdir(),'nota-studio-test-'));
 osmd=process.env.OSMD_TEST_SCRIPT||path.join(temp,'osmd.js');
 if(process.env.OSMD_TEST_SCRIPT)fs.accessSync(osmd);
 if(!process.env.OSMD_TEST_SCRIPT)execFileSync('curl',['--fail','--silent','--show-error','--max-time','60','https://cdn.jsdelivr.net/npm/opensheetmusicdisplay@1.9.0/build/opensheetmusicdisplay.min.js','-o',osmd]);
 server=spawn('python3',['server.py','--port','0','--data-dir',path.join(temp,'data')],{cwd:path.join(__dirname,'..'),stdio:['ignore','pipe','pipe']});
 base=await new Promise((resolve,reject)=>{let out='';server.stdout.on('data',chunk=>{out+=chunk;const match=out.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0])});server.on('error',reject);server.on('exit',code=>reject(Error('Server exited: '+code)))});
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://**/*',route=>route.request().url().includes('opensheetmusicdisplay@1.9.0')?route.fulfill({path:osmd,contentType:'application/javascript'}):route.abort());
 await page.goto(base);await page.waitForFunction(()=>songs.length===5);
});
after(async()=>{await browser?.close();server?.kill();fs.rmSync(temp,{recursive:true,force:true})});
const waitSaved=()=>page.evaluate(()=>studio.saving);
function wav(){const samples=44100*4,b=Buffer.alloc(44+samples*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(44100,24);b.writeUInt32LE(88200,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40);for(let i=0;i<samples;i++)b.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*220/44100)*1000),44+i*2);return b}

test('originals, multiple media, cues and note effects persist and work together',async()=>{
 const xml=await page.evaluate(()=>demoXML('Studio test','Test',Array(24).fill('C4')));
 await page.locator('#topUpload').click();await page.locator('#fileInput').setInputFiles({name:'studio.musicxml',mimeType:'application/xml',buffer:Buffer.from(xml)});
 await page.locator('#titleInput').fill('Studio test');await page.locator('#uploadForm button[type=submit]').click();
 await page.waitForSelector('#score svg');
 const id=await page.evaluate(()=>activeId),piece=()=>page.evaluate(id=>songs.find(p=>p.id===id),id);
 const original=(await piece()).originalFile;
 assert.ok(original);assert.equal(await (await page.request.get(base+original.url)).text(),xml);
 await page.locator('#noteColor').fill('#00ffaa');await page.locator('#noteColor').dispatchEvent('change');await page.locator('#notePulse').check();await waitSaved();
 await page.reload();await page.waitForFunction(()=>songs.length===6);
 await page.locator('#recentGrid [data-open="'+id+'"]').first().click();await page.waitForSelector('#score svg');
 assert.equal(await page.locator('#noteColor').inputValue(),'#00ffaa');assert.equal(await page.locator('#notePulse').isChecked(),true);
 const video=await page.evaluate(async()=>{
  const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;
  const stream=canvas.captureStream(10),recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks=[];
  return new Promise(resolve=>{recorder.ondataavailable=e=>chunks.push(e.data);recorder.onstop=async()=>{stream.getTracks().forEach(t=>t.stop());resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer())))};recorder.start();let frame=0;const timer=setInterval(()=>{const ctx=canvas.getContext('2d');ctx.fillStyle=frame%2?'purple':'white';ctx.fillRect(0,0,160,90);if(++frame===25){clearInterval(timer);recorder.stop()}},100)})
 });
 await page.locator('#mediaInput').setInputFiles([
  {name:'cover.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVqkAAAAASUVORK5CYII=','base64')},
  {name:'recording.wav',mimeType:'audio/wav',buffer:wav()},
  {name:'performance.webm',mimeType:'video/webm',buffer:Buffer.from(video)}
 ]);
 await page.waitForFunction(()=>document.querySelectorAll('.media-card').length===3);await waitSaved();
 await page.waitForFunction(()=>document.querySelector('.media-card img').naturalWidth>0&&document.querySelector('audio').readyState>0&&document.querySelector('video').readyState>0);
 const audioCard=page.locator('.media-card').filter({has:page.locator('audio')}),videoCard=page.locator('.media-card').filter({hasText:'performance.webm'}); // видео может уехать под ноты, ищем карточку по имени
 const imageCard=page.locator('.media-card').filter({hasText:'cover.png'});
 async function resize(card,width,height,fit){
  for(const [field,value] of Object.entries({layoutWidth:width,layoutHeight:height,layoutFit:fit}))
   await card.locator('[data-field='+field+']').evaluate((el,value)=>{el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))},value);
  await waitSaved();
 }
 await resize(videoCard,60,180,'cover');await resize(imageCard,40,220,'contain');
 assert.equal(await audioCard.locator('.media-size-controls').count(),0);
 await imageCard.locator('[data-field=sync]').check();await waitSaved();
 const imageId=await imageCard.getAttribute('data-media-id');
 const imageStage=page.locator('#scoreMedia [data-media-id="'+imageId+'"] img');
 assert.equal(await imageStage.evaluate(el=>getComputedStyle(el).height),'220px');
 assert.equal(await imageStage.evaluate(el=>getComputedStyle(el).objectFit),'contain');
 const widthRatio=await imageStage.evaluate(el=>el.getBoundingClientRect().width/(el.closest('#scoreMedia').clientWidth-parseFloat(getComputedStyle(el.closest('#scoreMedia')).paddingLeft)-parseFloat(getComputedStyle(el.closest('#scoreMedia')).paddingRight)));
 assert.ok(Math.abs(widthRatio-.4)<.01);
 await imageCard.locator('[data-field=sync]').uncheck();await waitSaved();

 const layout=await page.evaluate(()=>{const score=document.querySelector('.score-shell').getBoundingClientRect(),media=document.querySelector('[aria-labelledby=mediaTitle]').getBoundingClientRect(),player=document.querySelector('.player').getBoundingClientRect();return score.bottom<=media.top&&media.bottom<=player.top});assert.equal(layout,true);
 assert.equal(await page.locator('#scoreMedia').isHidden(),true); // без привязки к плееру под нотами ничего нет
 assert.equal(await page.locator('.media-card').filter({has:page.locator('img')}).locator('[data-field=volume]').count(),0);
 await audioCard.locator('[data-field=volume]').evaluate(el=>{el.value='0.35';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))});
 await videoCard.locator('[data-field=volume]').evaluate(el=>{el.value='0.7';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))});await waitSaved();
 assert.equal(await page.locator('audio').evaluate(el=>el.volume),.35);assert.equal(await page.locator('video').evaluate(el=>el.volume),.7);
 assert.equal(await audioCard.locator('.media-volume output').textContent(),'35%');

 await audioCard.locator('[data-field=start]').fill('0.5');await audioCard.locator('[data-field=start]').dispatchEvent('change');
 await audioCard.locator('[data-field=end]').fill('2');await audioCard.locator('[data-field=end]').dispatchEvent('change');
 await audioCard.locator('[data-field=sync]').check();await videoCard.locator('[data-field=sync]').check();await waitSaved();
 await page.locator('#playBtn').click();await page.waitForFunction(()=>playing&&currentPosition()>.65&&!document.querySelector('.media-card audio').paused&&!document.querySelector('video').paused);
 assert.equal(await page.locator('#scoreMedia video').count(),1); // привязанное видео показано под нотами
 assert.equal(await page.locator('#scoreMedia video').evaluate(el=>getComputedStyle(el).height),'180px');assert.equal(await page.locator('#scoreMedia video').evaluate(el=>getComputedStyle(el).objectFit),'cover');
 assert.equal(await page.locator('#score .note-playing').first().evaluate(el=>getComputedStyle(el).fill),'rgb(0, 255, 170)');
 assert.equal(await page.locator('#score .note-playing').first().evaluate(el=>getComputedStyle(el).animationName),'note-pulse');
 assert.match(await page.locator('#score .note-playing').first().evaluate(el=>getComputedStyle(el).filter),/drop-shadow/);
 await audioCard.locator('[data-field=volume]').evaluate(el=>{el.value='0';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))});await waitSaved();
 assert.equal(await page.locator('audio').evaluate(el=>el.volume),0);assert.equal(await page.locator('video').evaluate(el=>el.volume),.7);assert.equal(await page.evaluate(()=>playing),true);
 await page.locator('#playBtn').click();await page.waitForFunction(()=>!playing&&document.querySelector('audio').paused&&document.querySelector('video').paused);
 await page.evaluate(()=>seek(1.3));assert.ok(Math.abs(await page.locator('audio').evaluate(el=>el.currentTime)-.8)<.1);
 await page.locator('#tempoInput').fill('160');await page.locator('#playBtn').click();await page.waitForFunction(()=>playing&&document.querySelector('audio').playbackRate>1.4);
 await page.waitForFunction(()=>currentPosition()>2.1&&document.querySelector('audio').paused);
 await page.locator('#stopBtn').click();await page.waitForFunction(()=>!playing&&pausedAt===0&&document.querySelector('video').paused);
 if(process.env.STUDIO_SCREENSHOT)await page.screenshot({path:process.env.STUDIO_SCREENSHOT,fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.setViewportSize({width:1440,height:1000});
 await page.locator('#backButton').click();await page.locator('.top-actions [data-view=files]').click();
 assert.match(await page.locator('#uploadedFiles').textContent(),/studio.musicxml/);
 await page.reload();await page.waitForFunction(()=>songs.length===6);await page.locator('#recentGrid [data-open="'+id+'"]').first().click();await page.waitForSelector('#score svg');
 assert.equal(await page.locator('.media-card').count(),3);
 assert.equal(await videoCard.locator('[data-field=layoutWidth]').inputValue(),'60');assert.equal(await videoCard.locator('[data-field=layoutHeight]').inputValue(),'180');assert.equal(await videoCard.locator('[data-field=layoutFit]').inputValue(),'cover');
 await videoCard.locator('[data-media-action=reset-layout]').click();await waitSaved();assert.equal(await videoCard.locator('[data-field=layoutWidth]').inputValue(),'100');assert.equal(await videoCard.locator('[data-field=layoutHeight]').inputValue(),'320');
 assert.equal(await audioCard.locator('[data-field=volume]').inputValue(),'0');assert.equal(await page.locator('audio').evaluate(el=>el.volume),0);
 assert.equal(await videoCard.locator('[data-field=volume]').inputValue(),'0.7');assert.equal(await page.locator('video').evaluate(el=>el.volume),.7);
 await page.locator('video').evaluate(el=>el.volume=.25);await page.waitForFunction(()=>[...document.querySelectorAll('.media-card')].find(c=>c.textContent.includes('performance.webm')).querySelector('[data-field=volume]').value==='0.25');await waitSaved();
 assert.equal(await audioCard.locator('[data-field=start]').inputValue(),'0.5');assert.equal(await audioCard.locator('[data-field=sync]').isChecked(),true);
 const attached=(await piece()).media;page.on('dialog',dialog=>dialog.accept());
 await audioCard.locator('[data-media-action=delete]').click();await page.waitForFunction(()=>document.querySelectorAll('.media-card').length===2);
 assert.equal((await page.request.get(base+attached.find(m=>m.name==='recording.wav').url)).status(),404);
 await page.locator('#deleteReader').click();await page.waitForFunction(()=>songs.length===5);
 assert.equal((await page.request.get(base+original.url)).status(),404);
 for(const file of attached)assert.equal((await page.request.get(base+file.url)).status(),404);
 assert.deepEqual(errors,[]);
});

test('browser library can be copied into data without erasing the old copy',async()=>{
 await page.evaluate(async()=>{const db=await openDB();await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put({id:'legacy-test',title:'Legacy score',author:'Test',genre:'Классика',kind:'musicxml',xml:demoXML('Legacy','Test',['C4','D4','E4','F4']),created:Date.now(),favorite:true});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close()});
 await page.locator('.top-actions [data-view=files]').click();await page.locator('#importBrowser').click();await page.waitForFunction(()=>songs.some(p=>p.id==='legacy-test'));
 const piece=await page.evaluate(()=>songs.find(p=>p.id==='legacy-test'));assert.ok(piece.originalFile);assert.equal(piece.favorite,true);
 assert.equal((await page.request.get(base+piece.originalFile.url)).status(),200);
 const remains=await page.evaluate(async()=>{const db=await openDB();return new Promise(resolve=>{const tx=db.transaction(STORE);const req=tx.objectStore(STORE).get('legacy-test');req.onsuccess=()=>resolve(!!req.result);tx.oncomplete=()=>db.close()})});assert.equal(remains,true);
 await page.locator('#importBrowser').click();await page.waitForFunction(()=>!document.querySelector('#importBrowser').disabled);
 assert.equal(await page.evaluate(()=>songs.filter(p=>p.id==='legacy-test').length),1);
});
