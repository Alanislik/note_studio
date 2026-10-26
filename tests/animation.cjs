const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {GifWriter}=require('../vendor/omggif.js');
const path=require('node:path');
let browser,page;
before(async()=>{browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});page=await browser.newPage();await page.addScriptTag({path:path.join(__dirname,'../vendor/omggif.js')});await page.addScriptTag({path:path.join(__dirname,'../animated-image.js')});});
after(async()=>{await browser?.close()});
function fixture(disposal=false){const bytes=Buffer.alloc(4096),writer=new GifWriter(bytes,2,2,{palette:[0,0xff0000,0x00ff00,0x0000ff],loop:0});writer.addFrame(0,0,2,2,[0,1,1,1],{delay:10,transparent:0,disposal:1});if(disposal){writer.addFrame(0,0,1,1,[2],{delay:20,disposal:3});writer.addFrame(1,1,1,1,[3],{delay:30,disposal:1});}else{writer.addFrame(0,0,2,2,[0,2,2,2],{delay:20,transparent:0,disposal:2});writer.addFrame(0,0,2,2,[0,3,3,3],{delay:30,transparent:0,disposal:2});}return Array.from(bytes.subarray(0,writer.end()));}
async function render(bytes,times,loop){return page.evaluate(async({bytes,times,loop})=>{const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'image/gif'}));const a=document.createElement('canvas'),b=document.createElement('canvas'),gif=new GifAnimation(url,[a,b]);await gif.ready;const snapshots=times.map(time=>{gif.sync(time,loop);return {frame:gif.frame,a:Array.from(a.getContext('2d').getImageData(0,0,2,2).data),b:Array.from(b.getContext('2d').getImageData(0,0,2,2).data)}});gif.dispose();URL.revokeObjectURL(url);return snapshots;},{bytes,times,loop});}
test('GIF frame timings, repeat, seek backwards and transparent preview match',async()=>{const frames=await render(fixture(),[.05,.15,.4,.65,.15],true);assert.deepEqual(frames.map(f=>f.frame),[0,1,2,0,1]);for(const f of frames){assert.deepEqual(f.a,f.b);assert.equal(f.a[3],0)}assert.deepEqual(frames[1].a,frames[4].a);});
test('GIF without repeat freezes on its last frame',async()=>{const frames=await render(fixture(),[.4,.65,5],false);assert.deepEqual(frames.map(f=>f.frame),[2,2,2]);assert.deepEqual(frames[0].a,frames[2].a);});
test('GIF restore-to-previous disposal removes the temporary patch',async()=>{const frames=await render(fixture(true),[.15,.4],false);assert.deepEqual(frames[0].a.slice(0,4),[0,255,0,255]);assert.equal(frames[1].a[3],0);assert.deepEqual(frames[1].a.slice(12,16),[0,0,255,255]);});

test('independent GIF playback stops once, restarts and disposes its animation loop',async()=>{
 await page.evaluate(async bytes=>{const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'image/gif'}));const canvas=document.createElement('canvas');window.freeGif=new GifAnimation(url,[canvas]);await freeGif.ready;window.freeGifUrl=url;freeGif.free(4,false)},fixture());
 await page.waitForFunction(()=>freeGif.frame===2&&freeGif.raf===0);
 assert.equal(await page.evaluate(()=>{freeGif.restart();return freeGif.frame}),0);
 const closed=await page.evaluate(()=>{freeGif.dispose();URL.revokeObjectURL(freeGifUrl);return freeGif.raf===0&&freeGif.pixels===null});assert.equal(closed,true);
});
