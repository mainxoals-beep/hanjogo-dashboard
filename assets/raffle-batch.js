(function(root){
  'use strict';
  const INTRO=9000, TRANSITION=3000, GENERATION=5000, HOLD=7000, STEP=TRANSITION+GENERATION+HOLD;
  const duration=count=>INTRO+STEP*count;
  function elapsed(live,now=Date.now()){
    const b=live.batch||{};
    return Math.max(0,Number(b.elapsed||0)+(b.paused?0:Math.max(0,now-Number(b.anchor||live.startedAt))));
  }
  function frame(live,now=Date.now()){
    const people=live.winners||[],t=elapsed(live,now),total=duration(people.length);
    if(t>=total)return {phase:'complete',index:people.length-1,revealed:people.length,t};
    if(t<INTRO)return {phase:t<5000?'countdown':'spin',index:0,revealed:0,t};
    const index=Math.floor((t-INTRO)/STEP),offset=(t-INTRO)%STEP,name=offset>=TRANSITION+GENERATION;
    return {phase:offset<TRANSITION?'transition':name?'name':'generation',index,revealed:index+(name?1:0),t};
  }
  function control(live,action,now=Date.now()){
    const b=live.batch,t=elapsed(live,now),end=duration(live.winners.length);
    let next=t,paused=b.paused;
    if(action==='pause')paused=true;
    else if(action==='resume')paused=false;
    else if(action==='next'){
      const f=frame(live,now);
      next=f.phase==='countdown'||f.phase==='spin'?INTRO:
        f.phase==='transition'?INTRO+f.index*STEP+TRANSITION:
        f.phase==='generation'?INTRO+f.index*STEP+TRANSITION+GENERATION:Math.min(end,INTRO+(f.index+1)*STEP);
    }
    return {...live,batch:{...b,elapsed:Math.min(end,next),anchor:now,paused,version:Number(b.version||0)+1}};
  }
  function spinPerson(candidates,previous){
    if(!candidates.length)return null;
    const options=candidates.length>1?candidates.filter(p=>p.name+'|'+p.generation!==previous):candidates;
    const pool=options.length?options:candidates;
    return pool[Math.floor(Math.random()*pool.length)];
  }
  function celebrate(doc){
    const confetti=doc.getElementById('raffleConfetti');if(!confetti)return;
    confetti.replaceChildren();
    const colors=['#ffe395','#e2d7ff','#ffabc9','#b3f0e7','#ffffff','#ffca70'];
    for(let i=0;i<120;i++){
      const piece=doc.createElement('i');
      piece.setAttribute('style','--x:'+(i*37%100)+'%;--c:'+colors[i%6]+';--s:'+(5+i%7)+'px;--t:'+(3.8+i%9*.12)+'s;--d:'+(Math.floor(i/40)*.7+i%8*.07)+'s;--drift:'+((i%2?1:-1)*(25+i%65))+'px;--r:'+((i%2?1:-1)*(400+i*13))+'deg');
      confetti.append(piece);
    }
  }
  function mount(doc,getLive){
    const host=doc.getElementById('raffleLivePanel'),name=doc.getElementById('raffleLiveName');
    if(!host||!name)return ()=>{};
    const stage=doc.createElement('div'),progress=doc.createElement('div'),current=doc.createElement('div'),list=doc.createElement('div');
    stage.className='raffle-batch-stage';progress.className='raffle-live-pool raffle-batch-progress';
    current.className='raffle-live-name raffle-batch-current';list.className='raffle-batch-list';
    stage.append(progress,current,list);host.insertBefore(stage,name);name.hidden=true;
    let last='',lastSpin=-1,lastPerson='';
    function personCard(person,animate=false){
      current.replaceChildren();
      const value=doc.createElement('span'),generation=doc.createElement('span');
      value.className='raffle-person-name';generation.className='raffle-person-gen';
      value.textContent=person.name;generation.textContent=person.generation+'기';current.append(value,generation);
      if(animate&&!(root.matchMedia?.('(prefers-reduced-motion: reduce)').matches))
        value.animate?.([{transform:'translateY(22px)',opacity:.12},{transform:'translateY(0)',opacity:1}],{duration:180,easing:'cubic-bezier(.16,1,.3,1)'});
    }
    const tick=()=>{
      const live=getLive(),people=live.winners||[],f=frame(live);
      const signature=[live.drawId,f.phase,f.index,f.revealed,!!live.batch.paused].join('|');
      if(signature!==last){
        last=signature;current.replaceChildren();list.replaceChildren();stage.dataset.phase=f.phase;
        current.className='raffle-live-name raffle-batch-current'+
          (f.phase==='countdown'?' countdown':f.phase==='spin'?' spinning':f.phase==='generation'?' generation-reveal':f.phase==='transition'?' pre-generation':f.phase==='name'||f.phase==='complete'?' winner':'');
        host.classList.toggle('suspense',f.phase==='generation'||f.phase==='transition');
        host.classList.toggle('celebrating',f.phase==='name'||f.phase==='complete');
        progress.textContent=f.phase==='complete'?'전체 당첨자':(f.index+1)+' / '+people.length+'번째 당첨자';
        list.hidden=!f.revealed;
        people.slice(0,f.revealed).forEach((p,i)=>{
          const card=doc.createElement('div'),gen=doc.createElement('span'),person=doc.createElement('strong');
          card.className='raffle-batch-card';gen.textContent=(i+1)+'. '+p.generation+'기';person.textContent=p.name;card.append(gen,person);list.append(card);
        });
        if(f.phase==='name')personCard(people[f.index]);
        else{
          const label=doc.createElement('span'),value=doc.createElement('strong');
          label.className='raffle-generation-label';value.className=f.phase==='generation'?'raffle-generation-value':'raffle-person-name';
          if(f.phase==='generation'){label.textContent='당첨자의 기수는';value.textContent=people[f.index].generation+'기';}
          if(f.phase==='transition')value.textContent=f.index===0?'첫 행운의 주인공은…':'다음 행운의 주인공은…';
          if(f.phase==='complete'){label.textContent='당첨을 축하합니다!';value.textContent=people.length+'명 모두 공개';}
          current.append(label,value);
        }
        if(f.phase==='name'||f.phase==='complete')celebrate(doc);
        else doc.getElementById('raffleConfetti')?.replaceChildren();
        const foot=doc.getElementById('raffleLiveFoot');
        if(foot)foot.textContent=live.batch.paused?'진행자가 잠시 공개를 멈췄습니다':f.phase==='generation'?'잠시 후 이름을 공개합니다…':f.phase==='complete'?'차례로 간단한 자기소개와 인사를 부탁드립니다.':f.phase==='name'?'축하합니다! 박수 부탁드립니다.':'행운의 주인공은…';
      }
      if(f.phase==='countdown')current.lastChild.textContent=String(Math.ceil((5000-f.t)/1000));
      if(f.phase==='spin'&&Math.floor(f.t/220)!==lastSpin){
        lastSpin=Math.floor(f.t/220);const p=spinPerson(live.candidates||[],lastPerson);
        if(p){lastPerson=p.name+'|'+p.generation;personCard(p,true);}else current.textContent='두근두근…';
      }
    };
    tick();const timer=setInterval(tick,50);
    return ()=>{clearInterval(timer);stage.remove();name.hidden=false;host.classList.remove('suspense','celebrating');doc.getElementById('raffleConfetti')?.replaceChildren();};
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
    for(let s=5;s<INTRO/1000;s+=.18){note(s,155,.1,.25,'snare');note(s+.07,659,.1,.15);}
    for(let i=0;i<count;i++){
      const transition=INTRO/1000+i*STEP/1000,start=transition+TRANSITION/1000,reveal=start+GENERATION/1000;
      [0,.65,1.3,2.1].forEach((t,j)=>note(transition+t,80+j*20,.28,.24,'tom'));
      note(start,110,.45,.35,'tom');
      for(let s=start;s<reveal-.12;s+=Math.max(.035,.16-(s-start)*.025)){
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
  root.HanjogoBatch={INTRO,TRANSITION,GENERATION,HOLD,STEP,duration,elapsed,frame,control,spinPerson,mount,score};
  if(typeof module!=='undefined')module.exports=root.HanjogoBatch;
})(typeof window!=='undefined'?window:globalThis);
