(function(root){
  'use strict';
  const INTRO=7000, GENERATION=3000, HOLD=3000, STEP=GENERATION+HOLD;
  const duration=count=>INTRO+STEP*count;
  function elapsed(live,now=Date.now()){
    const b=live.batch||{};
    return Math.max(0,Number(b.elapsed||0)+(b.paused?0:Math.max(0,now-Number(b.anchor||live.startedAt))));
  }
  function frame(live,now=Date.now()){
    const people=live.winners||[],t=elapsed(live,now),total=duration(people.length);
    if(t>=total)return {phase:'complete',index:people.length-1,revealed:people.length,t};
    if(t<INTRO)return {phase:t<5000?'countdown':'spin',index:0,revealed:0,t};
    const index=Math.floor((t-INTRO)/STEP),name=(t-INTRO)%STEP>=GENERATION;
    return {phase:name?'name':'generation',index,revealed:index+(name?1:0),t};
  }
  function control(live,action,now=Date.now()){
    const b=live.batch,t=elapsed(live,now),end=duration(live.winners.length);
    let next=t,paused=b.paused;
    if(action==='pause')paused=true;
    else if(action==='resume')paused=false;
    else if(action==='next'){
      const f=frame(live,now);
      next=f.phase==='countdown'||f.phase==='spin'?INTRO:
        f.phase==='generation'?INTRO+f.index*STEP+GENERATION:Math.min(end,INTRO+(f.index+1)*STEP);
    }
    return {...live,batch:{...b,elapsed:Math.min(end,next),anchor:now,paused,version:Number(b.version||0)+1}};
  }
  function mount(doc,getLive){
    const host=doc.getElementById('raffleLivePanel');
    const name=doc.getElementById('raffleLiveName');
    if(!host||!name)return ()=>{};
    const stage=doc.createElement('div');stage.className='raffle-batch-stage';
    const current=doc.createElement('div'),list=doc.createElement('div');
    current.className='raffle-batch-current';list.className='raffle-batch-list';
    stage.append(current,list);host.insertBefore(stage,name);name.hidden=true;
    let last='',lastSpin=-1;
    const tick=()=>{
      const live=getLive(),people=live.winners||[],f=frame(live);
      const signature=[live.drawId,f.phase,f.index,f.revealed,!!live.batch.paused].join('|');
      if(signature!==last){
        last=signature;current.replaceChildren();list.replaceChildren();
        host.classList.toggle('suspense',f.phase==='generation');
        host.classList.toggle('celebrating',f.phase==='complete');
        people.slice(0,f.revealed).forEach((p,i)=>{
          const card=doc.createElement('div');card.className='raffle-batch-card';
          const gen=doc.createElement('span'),person=doc.createElement('strong');
          gen.textContent=(i+1)+'. '+p.generation+'기';person.textContent=p.name;
          card.append(gen,person);list.append(card);
        });
        const label=doc.createElement('span'),value=doc.createElement('strong');
        label.className='raffle-batch-label';value.className='raffle-batch-value';
        label.textContent=f.phase==='complete'?'당첨을 축하합니다!':(f.index+1)+' / '+people.length+'번째 당첨자';
        if(f.phase==='generation')value.textContent=people[f.index].generation+'기';
        if(f.phase==='name')value.textContent=people[f.index].name;
        if(f.phase==='complete')value.textContent=people.length+'명 모두 공개';
        current.append(label,value);
        const foot=doc.getElementById('raffleLiveFoot');
        if(foot)foot.textContent=live.batch.paused?'진행자가 잠시 공개를 멈췄습니다':
          f.phase==='generation'?'잠시 후 이름을 공개합니다…':f.phase==='complete'?'차례로 간단한 자기소개와 인사를 부탁드립니다.':'행운의 주인공을 차례로 공개합니다';
      }
      if(f.phase==='countdown')current.lastChild.textContent=String(Math.ceil((5000-f.t)/1000));
      if(f.phase==='spin'&&Math.floor(f.t/220)!==lastSpin){
        lastSpin=Math.floor(f.t/220);const candidates=live.candidates||[];
        const p=candidates[lastSpin%candidates.length];current.lastChild.textContent=p?p.name:'두근두근…';
      }
    };
    tick();const timer=setInterval(tick,50);
    return ()=>{clearInterval(timer);stage.remove();name.hidden=false;};
  }
  // PCM WAV keeps the mobile playback path used by the existing raffle sounds.
  const scores=new Map();
  function score(count){
    if(scores.has(count))return scores.get(count);
    const rate=22050,length=Math.ceil((duration(count)/1000+2)*rate),samples=new Float32Array(length);
    let seed=7349;
    function note(at,f,d,v,kind){
      const first=Math.floor(at*rate);
      for(let i=0;i<d*rate&&first+i<length;i++){
        const t=i/rate,env=Math.min(1,t/.005)*Math.pow(Math.max(0,1-t/d),1.7),p=2*Math.PI*f*t;
        seed=(Math.imul(seed,1664525)+1013904223)>>>0;const noise=seed/2147483648-1;
        const sound=kind==='snare'?noise*.75+Math.sin(p)*.25:
          kind==='tom'?Math.sin(p+5*(1-Math.exp(-t*28))):
          kind==='cymbal'?noise:Math.sin(p)+.25*Math.sin(p*2);
        samples[first+i]+=sound*env*v;
      }
    }
    for(let s=0;s<5;s++){note(s,523,.18,.23);note(s,65,.22,.35,'tom');}
    for(let s=5;s<7;s+=.18){note(s,155,.1,.25,'snare');note(s+.07,659,.1,.15);}
    for(let i=0;i<count;i++){
      const start=7+i*6,reveal=start+3;
      for(let s=start;s<reveal-.12;s+=Math.max(.035,.13-(s-start)*.035)){
        note(s,180,.09,.25+(s-start)*.035,'snare');
        note(s+.025,100+(i%3)*25,.15,.14,'tom');
      }
      note(reveal,55,.45,.45,'tom');note(reveal,320,1.4,.17,'cymbal');
      [523,659,784,1047].forEach((f,j)=>note(reveal+j*.18,f,.55,.21));
      [262,330,392].forEach(f=>note(reveal,f,1.3,.09));
    }
    const bytes=new ArrayBuffer(44+length*2),view=new DataView(bytes);
    function word(at,str){for(let i=0;i<str.length;i++)view.setUint8(at+i,str.charCodeAt(i));}
    word(0,'RIFF');view.setUint32(4,36+length*2,true);word(8,'WAVE');word(12,'fmt ');
    view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
    view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
    word(36,'data');view.setUint32(40,length*2,true);
    for(let i=0;i<length;i++)view.setInt16(44+i*2,Math.tanh(samples[i]*1.4)*32767,true);
    const url=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));scores.set(count,url);return url;
  }
  root.HanjogoBatch={INTRO,GENERATION,HOLD,STEP,duration,elapsed,frame,control,mount,score};
  if(typeof module!=='undefined')module.exports=root.HanjogoBatch;
})(typeof window!=='undefined'?window:globalThis);
