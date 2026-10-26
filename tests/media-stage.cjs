// Uses a temporary copy of the repository's real MIDI library, never edits data/.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
let temp,server,browser,page,base,osmd,pieceId,errors=[];
before(async()=>{
 const root=path.join(__dirname,'..');
 temp=fs.mkdtempSync(path.join(os.tmpdir(),'nota-media-stage-'));
 fs.cpSync(path.join(root,'data'),path.join(temp,'data'),{recursive:true});
 osmd=process.env.OSMD_TEST_SCRIPT||path.join(temp,'osmd.js');
 if(process.env.OSMD_TEST_SCRIPT)fs.accessSync(osmd);
 else execFileSync('curl',['--fail','--silent','--show-error','--max-time','60','https://cdn.jsdelivr.net/npm/opensheetmusicdisplay@1.9.0/build/opensheetmusicdisplay.min.js','-o',osmd]);
 server=spawn('python3',['server.py','--port','0','--data-dir',path.join(temp,'data')],{cwd:root,stdio:['ignore','pipe','ignore']});
 base=await new Promise((resolve,reject)=>{server.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0])});server.on('error',reject);server.on('exit',code=>reject(Error('Server exited: '+code)))});
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 page=await browser.newPage({viewport:{width:1440,height:1080}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://**/*',route=>route.request().url().includes('opensheetmusicdisplay@1.9.0')?route.fulfill({path:osmd,contentType:'application/javascript'}):route.abort());
 await page.goto(base);await page.waitForFunction(()=>songs.some(p=>p.originalFile?.name==='Cutie Mew Mew Magic.mid'));
 pieceId=await page.evaluate(()=>songs.find(p=>p.originalFile?.name==='Cutie Mew Mew Magic.mid').id);
 await page.evaluate(id=>openReader(id),pieceId);await page.waitForSelector('#score svg');
});
after(async()=>{await browser?.close();server?.kill();if(temp)fs.rmSync(temp,{recursive:true,force:true})});
const saved=()=>page.evaluate(()=>studio.saving);

test('real Cutie GIFs keep transparency, follow cues and retain their size',async()=>{
 assert.equal(await page.locator('canvas').count(),0);
 await page.evaluate(()=>seek(.5));
 const firstId=await page.evaluate(()=>songs.find(p=>p.id===activeId).media.find(m=>m.name==='deltarune-pink.gif').id);
 const first=page.locator('#scoreMedia [data-media-id="'+firstId+'"]');
 await page.waitForFunction(id=>{const img=document.querySelector('#scoreMedia [data-media-id="'+id+'"] img');return img?.complete&&img.naturalWidth>0},firstId);
 assert.equal(await first.isVisible(),true);
 assert.equal(await first.locator('img').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
 const alpha=await first.locator('img').evaluate(img=>{const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);return ctx.getImageData(0,0,1,1).data[3]});
 assert.equal(alpha,0);
 const card=page.locator('.media-card[data-media-id="'+firstId+'"]');
 for(const [field,value] of Object.entries({layoutWidth:50,layoutHeight:240}))await card.locator('[data-field='+field+']').evaluate((el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))},String(value));
 await page.evaluate(()=>studio.saving);
 assert.equal(await first.locator('img').evaluate(el=>getComputedStyle(el).height),'240px');
 if(process.env.MEDIA_SCREENSHOT)await first.screenshot({path:process.env.MEDIA_SCREENSHOT});
 await page.evaluate(()=>seek(2));assert.equal(await first.isHidden(),true);
 await page.evaluate(()=>seek(45));assert.equal(await page.locator('#scoreMedia .stage-item:not(.hidden)').count(),1);
 await page.reload();await page.waitForFunction(()=>songs.length>0);await page.evaluate(id=>openReader(id),pieceId);await page.evaluate(()=>seek(.5));
 assert.equal(await first.locator('img').evaluate(el=>getComputedStyle(el).height),'240px');
 assert.equal(await card.locator('[data-field=layoutWidth]').inputValue(),'50');
 assert.deepEqual(errors,[]);
});
