// Uses a temporary copy of the repository's real MIDI library, never edits data/.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
let temp,server,browser,page,base,osmd,pieceId,errors=[];
before(async()=>{
 const root=path.join(__dirname,'..');
 temp=fs.mkdtempSync(path.join(os.tmpdir(),'nota-sunset-files-'));
 fs.cpSync(path.join(root,'data'),path.join(temp,'data'),{recursive:true});
 osmd=process.env.OSMD_TEST_SCRIPT||path.join(temp,'osmd.js');
 if(process.env.OSMD_TEST_SCRIPT)fs.accessSync(osmd);
 else execFileSync('curl',['--fail','--silent','--show-error','--max-time','60','https://cdn.jsdelivr.net/npm/opensheetmusicdisplay@1.9.0/build/opensheetmusicdisplay.min.js','-o',osmd]);
 server=spawn('python3',['server.py','--port','0','--data-dir',path.join(temp,'data')],{cwd:root,stdio:['ignore','pipe','ignore']});
 base=await new Promise((resolve,reject)=>{server.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0])});server.on('error',reject);server.on('exit',code=>reject(Error('Server exited: '+code)))});
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 page=await browser.newPage({viewport:{width:1440,height:1080}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://**/*',route=>route.request().url().includes('opensheetmusicdisplay@1.9.0')?route.fulfill({path:osmd,contentType:'application/javascript'}):route.abort());
 await page.goto(base);await page.waitForFunction(()=>songs.some(p=>p.originalFile?.name==='Sunset of Seven Suns.mid'));
 pieceId=await page.evaluate(()=>songs.find(p=>p.originalFile?.name==='Sunset of Seven Suns.mid').id);
 await page.evaluate(id=>openReader(id),pieceId);await page.waitForSelector('#score svg');
});
after(async()=>{await browser?.close();server?.kill();if(temp)fs.rmSync(temp,{recursive:true,force:true})});
const saved=()=>page.evaluate(()=>studio.saving);

test('Sunset uses downloaded editable files, follows cues and installs only once',async()=>{
 await page.waitForFunction(()=>document.querySelectorAll('.media-card').length===6);
 await page.evaluate(()=>studio.saving);
 assert.equal(await page.locator('canvas').count(),0);
 assert.equal(await page.locator('.media-source').count(),6);
 const original=await page.evaluate(()=>songs.find(p=>p.id===activeId).media.map(m=>m.id));
 await page.evaluate(()=>seek(5));
 assert.equal(await page.locator('#scoreMedia .stage-item:not(.hidden)').count(),1);
 await page.evaluate(()=>seek(45));
 assert.equal(await page.locator('#scoreMedia .stage-item:not(.hidden)').count(),4);
 await page.waitForFunction(()=>[...document.querySelectorAll('#scoreMedia .stage-item:not(.hidden) img')].every(img=>img.complete&&img.naturalWidth>0));
 const png=page.locator('#scoreMedia [data-role=sprite] img').first();
 assert.equal(await png.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
 const kris=await page.evaluate(()=>songs.find(p=>p.id===activeId).media.find(m=>m.name.includes('Крис')));
 const positionCard=page.locator('.media-card[data-media-id="'+kris.id+'"]');
 const positionSlot=page.locator('#scoreMedia [data-media-id="'+kris.id+'"]');
 const before=await positionSlot.boundingBox();
 for(const [field,value] of Object.entries({layoutOffsetX:85,layoutOffsetY:-22,layoutLayer:8}))await positionCard.locator('[data-field='+field+']').evaluate((el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))},String(value));
 await page.evaluate(()=>studio.saving);
 const shifted=await positionSlot.boundingBox();assert.ok(Math.abs(shifted.x-before.x-85)<1);assert.ok(Math.abs(shifted.y-before.y+22)<1);
 assert.equal(await positionSlot.evaluate(el=>getComputedStyle(el).zIndex),'8');
 await page.locator('#mediaPositionMode').click();await positionSlot.scrollIntoViewIfNeeded();
 const box=await positionSlot.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+40,box.y+box.height/2+25,{steps:5});await page.mouse.up();await page.evaluate(()=>studio.saving);
 assert.equal(await positionCard.locator('[data-field=layoutOffsetX]').inputValue(),'125');assert.equal(await positionCard.locator('[data-field=layoutOffsetY]').inputValue(),'3');
 // Pointer cancellation restores the preview and does not change the saved layout.
 const cancelBox=await positionSlot.boundingBox();await page.mouse.move(cancelBox.x+cancelBox.width/2,cancelBox.y+cancelBox.height/2);await page.mouse.down();await page.mouse.move(cancelBox.x+cancelBox.width/2+20,cancelBox.y+cancelBox.height/2+15,{steps:3});
 await page.evaluate(()=>$('#scoreMedia').dispatchEvent(new PointerEvent('pointercancel',{pointerId:studio.drag.pointerId,bubbles:true})));await page.mouse.up();
 assert.equal(await positionCard.locator('[data-field=layoutOffsetX]').inputValue(),'125');assert.equal(await positionCard.locator('[data-field=layoutOffsetY]').inputValue(),'3');

 await page.locator('#mediaPositionMode').click();assert.equal(await page.locator('#mediaPositionMode').getAttribute('aria-pressed'),'false');
 const data=await (await page.request.get(base+kris.url)).body();
 assert.deepEqual(data,fs.readFileSync(path.join(__dirname,'../assets/sunset/kris.png')));
 const frame=await page.locator('#scoreMedia [data-role=sprite]').first().getAttribute('style');
 await page.evaluate(()=>seek(46));const moved=await page.locator('#scoreMedia [data-role=sprite]').first().getAttribute('style');assert.notEqual(frame,moved);
 await page.evaluate(()=>studio.sync(46,false,1,true));assert.equal(await page.locator('#scoreMedia [data-role=sprite]').first().getAttribute('style'),moved);
 await page.locator('#playBtn').click();await page.waitForFunction(()=>playing&&currentPosition()>46.2);await page.locator('#playBtn').click();await page.waitForFunction(()=>!playing);
 const frozen=await page.locator('#scoreMedia [data-role=sprite]').first().getAttribute('style');await page.evaluate(()=>studio.sync(pausedAt,false,playSpeed,true));assert.equal(await page.locator('#scoreMedia [data-role=sprite]').first().getAttribute('style'),frozen);
 if(process.env.SUNSET_SCREENSHOT)await page.locator('#scoreMedia .file-scene').screenshot({path:process.env.SUNSET_SCREENSHOT});
 await positionCard.locator('[data-field=rate]').fill('2');await positionCard.locator('[data-field=rate]').dispatchEvent('change');await positionCard.locator('[data-field=loop]').uncheck();await page.evaluate(()=>studio.saving);
 const motionStart=kris.start;await page.evaluate(t=>seek(t+2.1),motionStart);const finishedMotion=await positionSlot.getAttribute('style');await page.evaluate(t=>seek(t+3),motionStart);assert.equal(await positionSlot.getAttribute('style'),finishedMotion);

 await page.evaluate(()=>seek(90));assert.equal(await page.locator('#scoreMedia .stage-item:not(.hidden)').count(),1);
 await page.reload();await page.waitForFunction(()=>songs.length>0);await page.evaluate(id=>openReader(id),pieceId);
 await page.waitForFunction(()=>document.querySelectorAll('.media-card').length===6);
 assert.deepEqual(await page.evaluate(()=>songs.find(p=>p.id===activeId).media.map(m=>m.id)),original);
 assert.equal(await positionCard.locator('[data-field=rate]').inputValue(),'2');assert.equal(await positionCard.locator('[data-field=loop]').isChecked(),false);
 assert.equal(await positionCard.locator('[data-field=layoutOffsetX]').inputValue(),'125');assert.equal(await positionCard.locator('[data-field=layoutOffsetY]').inputValue(),'3');assert.equal(await positionCard.locator('[data-field=layoutLayer]').inputValue(),'8');
 await positionCard.locator('[data-media-action=reset-position]').click();await page.evaluate(()=>studio.saving);
 assert.equal(await positionCard.locator('[data-field=layoutOffsetX]').inputValue(),'0');assert.equal(await positionCard.locator('[data-field=layoutOffsetY]').inputValue(),'0');assert.equal(await positionCard.locator('[data-field=layoutLayer]').inputValue(),'3');

 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.evaluate(()=>seek(45));assert.equal(await page.locator('#scoreMedia .stage-item:not(.hidden)').count(),4);
 // Deleting a preset attachment stays deleted on the next opening.
 page.on('dialog',dialog=>dialog.accept());
 await page.locator('.media-card[data-media-id="'+kris.id+'"]').locator('[data-media-action=delete]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.media-card').length===5);
 await page.reload();await page.waitForFunction(()=>songs.length>0);await page.evaluate(id=>openReader(id),pieceId);
 await page.waitForFunction(()=>document.querySelectorAll('.media-card').length===5);
 assert.equal((await page.request.get(base+kris.url)).status(),404);
 assert.deepEqual(errors,[]);
});
