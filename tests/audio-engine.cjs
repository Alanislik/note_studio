// Run: node --test tests/audio-engine.cjs (requires Playwright and Chromium).
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const path=require('node:path');
let browser,page;
before(async()=>{
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 page=await browser.newPage();await page.addScriptTag({path:path.join(__dirname,'../audio-engine.js')});
});
after(async()=>{await browser?.close()});
async function render(notes,offset=0,speed=1,cancel=false){
 return page.evaluate(async({notes,offset,speed,cancel})=>{
  const engine=new NotaAudioEngine(),ctx=new OfflineAudioContext(1,44100*2,44100);
  engine.context=ctx;engine.connectOutput();
  engine.room.disconnect(); // Measure the dry signal through the real gain/compressor.
  for(const n of notes)engine.buffers.set(n.midi,engine.makePiano(n.midi));
  engine.start(notes,offset,speed);if(cancel)engine.stop();
  // Rendering/UI work stalls the main thread after notes have been scheduled.
  const deadline=performance.now()+180;while(performance.now()<deadline){}
  const audio=await ctx.startRendering(),samples=audio.getChannelData(0);
  const rms=(a,b)=>{let sum=0;for(let i=Math.floor(a*44100);i<Math.floor(b*44100);i++)sum+=samples[i]**2;return Math.sqrt(sum/((b-a)*44100))};
  return {before:rms(0,.07),first:rms(.09,.13),second:rms(.59,.63),late:rms(1.1,1.2),peak:Math.max(...Array.from(samples).map(Math.abs).slice(0,80000)),finite:samples.every(Number.isFinite)};
 },{notes,offset,speed,cancel});
}
test('notes render on the audio timeline despite a blocked main thread',async()=>{
 const r=await render([{midi:60,time:0,duration:.15},{midi:64,time:.5,duration:.15}]);
 assert.equal(r.before,0);assert.ok(r.first>.01);assert.ok(r.second>.01);assert.ok(r.late<.001);assert.ok(r.finite);
});
test('chords and repeated pitches have independent voices, without clipping',async()=>{
 const notes=[60,64,67,72].map(midi=>({midi,time:0,duration:.7}));notes.push({midi:60,time:.5,duration:.1});
 const r=await render(notes);assert.ok(r.second>.01);assert.ok(r.peak<1);assert.ok(r.finite);
});
test('stop cancels future notes before they sound',async()=>{
 const r=await render([{midi:60,time:0,duration:1},{midi:67,time:.5,duration:.5}],0,1,true);
 assert.equal(r.peak,0);
});
test('resume keeps the decay of a held note and skips completed notes',async()=>{
 const notes=[{midi:60,time:0,duration:1},{midi:67,time:.1,duration:.2}];
 const fresh=await render(notes),resumed=await render(notes,.75);
 assert.ok(resumed.first>0);assert.ok(resumed.first<fresh.first);assert.ok(resumed.second<.001);
});
test('tempo scales note starts and releases',async()=>{
 const r=await render([{midi:60,time:1,duration:.2}],0,2);
 assert.equal(r.first,0);assert.ok(r.second>.01);assert.ok(r.late<.001);
});
