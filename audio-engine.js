'use strict';

// Audio is scheduled on the audio clock, independently of rendering and JS timers.
class NotaAudioEngine {
 constructor(){this.context=null;this.buffers=new Map();this.bus=null}
 async prepare(notes){
  if(!this.context){
   const Audio=window.AudioContext||window.webkitAudioContext;
   if(!Audio)throw Error('Этот браузер не поддерживает Web Audio.');
   this.context=new Audio({latencyHint:'interactive'});
   this.connectOutput();
  }
  await this.context.resume();
  if(this.context.state!=='running')throw Error('Браузер приостановил звук. Нажмите ▶ ещё раз.');
  for(const midi of new Set(notes.map(n=>n.midi))){
   if(!this.buffers.has(midi))this.buffers.set(midi,this.makePiano(midi));
  }
 }
 connectOutput(){
   const ctx=this.context;
   this.output=ctx.createGain();this.output.gain.value=.7;
   this.compressor=ctx.createDynamicsCompressor();
   this.compressor.threshold.value=-16;this.compressor.knee.value=18;
   this.compressor.ratio.value=4;this.compressor.attack.value=.004;this.compressor.release.value=.2;
   this.output.connect(this.compressor);this.compressor.connect(ctx.destination);
   // A quiet, short room tail adds space without hiding note attacks.
   this.room=ctx.createConvolver();const impulse=ctx.createBuffer(2,Math.ceil(ctx.sampleRate*.7),ctx.sampleRate);
   let seed=23;
   for(let ch=0;ch<2;ch++){const data=impulse.getChannelData(ch);for(let i=0;i<data.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[i]=(seed/2147483648-1)*Math.exp(-i/ctx.sampleRate*10)*.12}}
   this.room.buffer=impulse;this.room.connect(this.output);
 }
 makePiano(midi){
  const ctx=this.context,rate=ctx.sampleRate,frequency=440*2**((midi-69)/12);
  const length=8,buffer=ctx.createBuffer(1,Math.ceil(rate*length),rate),data=buffer.getChannelData(0);
  // Damped, slightly inharmonic strings: upper partials die faster than the body.
  for(let partial=1;partial<=8;partial++){
   const hz=frequency*partial*Math.sqrt(1+.00008*partial*partial);
   if(hz>=rate*.45)break;
   const phase=2*Math.PI*hz/rate,coefficient=2*Math.cos(phase);
   const decay=Math.exp(-(1.1+partial*.42+frequency/2600)/rate);
   let previous=0,current=Math.sin(phase),amplitude=.48/partial**1.65;
   for(let i=0;i<data.length;i++){
    data[i]+=current*amplitude*Math.min(1,i/(rate*.005));
    const next=coefficient*current-previous;previous=current;current=next;amplitude*=decay;
   }
  }
  return buffer;
 }
 start(notes,offset,speed){
  this.stop();const ctx=this.context,start=ctx.currentTime+.08;
  const bus=ctx.createGain();bus.connect(this.output);
  const wet=ctx.createGain();wet.gain.value=.16;bus.connect(wet);wet.connect(this.room);
  const session={bus,wet,voices:new Set()};this.bus=session;
  try{
   for(const note of notes){
    const end=note.time+note.duration;if(end<=offset)continue;
    const when=start+Math.max(0,note.time-offset)/speed;
    const duration=(end-Math.max(offset,note.time))/speed;
    const source=ctx.createBufferSource(),gain=ctx.createGain();
    source.buffer=this.buffers.get(note.midi);
    const velocity=Math.max(.05,Math.min(1,note.velocity??.75));
    const level=velocity**1.4;
    gain.gain.setValueAtTime(0,when);gain.gain.linearRampToValueAtTime(level,when+.006);
    gain.gain.setValueAtTime(level,when+Math.max(.006,duration));
    gain.gain.exponentialRampToValueAtTime(.0001,when+Math.max(.006,duration)+.22);
    source.connect(gain);gain.connect(bus);session.voices.add(source);
    source.onended=()=>{source.disconnect();gain.disconnect();session.voices.delete(source);if(!session.voices.size){bus.disconnect();wet.disconnect();if(this.bus===session)this.bus=null}};
    // Resume within the decaying string, rather than hammering a held note again.
    const elapsed=Math.max(0,(offset-note.time)/speed);
    source.start(when,Math.min(elapsed,source.buffer.duration-.01));
    source.stop(when+duration+.23);
   }
  }catch(error){this.stop();throw error}
  return start;
 }
 stop(){
  const session=this.bus;if(!session)return;this.bus=null;
  const now=this.context.currentTime;
  session.bus.gain.cancelScheduledValues(now);session.bus.gain.setValueAtTime(session.bus.gain.value,now);
  session.bus.gain.linearRampToValueAtTime(0,now+.025);
  for(const source of session.voices)source.stop(now+.03);
 }
 position(start){return Math.max(0,this.context.currentTime-(this.context.baseLatency||0)-start)}
}
window.NotaAudioEngine=NotaAudioEngine;
