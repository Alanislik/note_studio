// Uses a temporary copy of the repository's real MIDI library, never edits data/.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
let temp,server,browser,page,base,osmd,pieceId,errors=[];
before(async()=>{
 const root=path.join(__dirname,'..');
 temp=fs.mkdtempSync(path.join(os.tmpdir(),'nota-sunset-'));
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

test('real Sunset MIDI drives a deterministic scene, synchronized with player and seeking',async()=>{
 assert.equal(await page.locator('#sunsetEnabled').isChecked(),true);
 assert.equal(await page.locator('#sunsetScene').isVisible(),true);
 const timing=await page.evaluate(()=>({duration:totalDuration,notes:playback.length}));
 // The repository's stored XML includes four overfull bars from its older MIDI importer.
 // The visual must follow the existing player timeline, not a separate 96-second MIDI clock.
 assert.equal(timing.duration,97.125);assert.equal(timing.notes,1007);
 const signals=await page.evaluate(()=>[studio.visual.signalsAt(1),studio.visual.signalsAt(20)]);
 assert.notDeepEqual(signals[0],signals[1]);assert.ok(signals.some(s=>s.bass>0&&s.suns.some(n=>n>0)));
 const snapshots=await page.evaluate(()=>{seek(32);const a=$('#sunsetCanvas').toDataURL();seek(64);const b=$('#sunsetCanvas').toDataURL();seek(32);return[a,b,$('#sunsetCanvas').toDataURL()]});
 assert.notEqual(snapshots[0],snapshots[1]);assert.equal(snapshots[0],snapshots[2]);
 await page.locator('#sunsetSeek').evaluate(el=>{el.value=250;el.dispatchEvent(new Event('input',{bubbles:true}))});
 assert.equal(await page.evaluate(()=>pausedAt),32); // Drag previews without restarting the audio engine.
 await page.locator('#sunsetSeek').dispatchEvent('change');
 assert.ok(Math.abs(await page.evaluate(()=>pausedAt)-timing.duration*.25)<.02);
 const canvasBox=await page.locator('#sunsetCanvas').boundingBox();
 await page.locator('#sunsetCanvas').click({position:{x:canvasBox.width*.5,y:canvasBox.height*.6}});
 assert.ok(Math.abs(await page.evaluate(()=>pausedAt)-timing.duration*.5)<.2);
 await page.locator('#playBtn').click();await page.waitForFunction(()=>playing&&studio.visual.time>totalDuration*.5+.15);
 await page.locator('#playBtn').click();await page.waitForFunction(()=>!playing);
 const paused=await page.locator('#sunsetCanvas').evaluate(el=>el.toDataURL());
 // The UI can resize while paused; drawing the same score time stays identical.
 await page.evaluate(()=>studio.visual.render(pausedAt));
 assert.equal(await page.locator('#sunsetCanvas').evaluate(el=>el.toDataURL()),paused);
 if(process.env.SUNSET_SCREENSHOT){await page.locator('.score-shell').screenshot({path:process.env.SUNSET_SCREENSHOT});}
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.locator('#sunsetCanvas').scrollIntoViewIfNeeded();
 assert.ok(await page.locator('#sunsetCanvas').evaluate(el=>el.width>0&&el.width<=innerWidth*2));
 await page.setViewportSize({width:1440,height:1080});
 await page.locator('#sunsetIntensity').evaluate(el=>{el.value=25;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))});await saved();
 await page.locator('#sunsetEnabled').uncheck();await saved();
 await page.reload();await page.waitForFunction(()=>songs.length>0);await page.evaluate(id=>openReader(id),pieceId);
 assert.equal(await page.locator('#sunsetEnabled').isChecked(),false);assert.equal(await page.locator('#sunsetScene').isHidden(),true);
 assert.equal(await page.locator('#sunsetIntensity').inputValue(),'25');
 await page.locator('#sunsetEnabled').check();await saved();
 await page.locator('#backButton').click();assert.equal(await page.locator('#sunsetScene').isHidden(),true);
 assert.deepEqual(errors,[]);
});
