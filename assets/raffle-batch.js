(function(root){
  'use strict';
  const INTRO=9000, TRANSITION=3000, GENERATION=5000, HOLD=7000, STEP=TRANSITION+GENERATION+HOLD;
  // Inside the generation phase: the 기수 slot lands at SLOT_END, then same-기수 names roll until the reveal.
  const SLOT_END=1800, ROULETTE_START=2100;
  function slowing(start,end,first,grow){
    let count=1,sum=first;
    while(sum+first*Math.pow(grow,count)<=end-start){sum+=first*Math.pow(grow,count);count++;}
    const out=[],scale=(end-start)/sum;let at=start;
    for(let i=0;i<count;i++){out.push(Math.round(at));at+=first*Math.pow(grow,i)*scale;}
    return out;
  }
  const SLOT_TICKS=slowing(0,SLOT_END,40,1.13),ROULETTE_TICKS=slowing(ROULETTE_START,GENERATION,60,1.12);
  const duration=count=>INTRO+STEP*count;
  const isGrand=live=>/갤럭시\s*탭|Galaxy\s*Tab/i.test(live?.prize||'');
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
  // Seeded by drawId and winner index so every screen rolls the same values in the same order.
  function shuffled(list,key){
    const out=list.slice();let h=2166136261;
    for(const c of String(key))h=Math.imul(h^c.charCodeAt(0),16777619)>>>0;
    for(let i=out.length-1;i>0;i--){h=(Math.imul(h,1664525)+1013904223)>>>0;const j=h%(i+1);[out[i],out[j]]=[out[j],out[i]];}
    return out;
  }
  function slotValues(live,index){
    const winner=live.winners[index],own=Number(winner.generation);
    let gens=[...new Set((live.candidates||[]).concat(live.winners).map(p=>Number(p.generation)).filter(g=>g>0&&g!==own))];
    if(gens.length<3)gens=Array.from({length:20},(_,i)=>i+1).filter(g=>g!==own);
    return shuffled(gens,live.drawId+'|slot|'+index);
  }
  function rouletteNames(live,index){
    const winner=live.winners[index];
    const names=[...new Set((live.candidates||[]).filter(p=>Number(p.generation)===Number(winner.generation)&&p.name!==winner.name).map(p=>p.name))];
    return names.length?shuffled(names,live.drawId+'|names|'+index):['? ? ?'];
  }
  const countAt=(ticks,t)=>{let n=0;while(n<ticks.length&&ticks[n]<=t)n++;return n;};
  const calm=()=>!!root.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  function celebrate(doc,grand){
    const confetti=doc.getElementById('raffleConfetti');if(!confetti)return;
    confetti.replaceChildren();
    const colors=grand?['#ffe395','#fff4ce','#eabb57','#ffffff','#f4ce75','#ffca70']:['#ffe395','#e2d7ff','#ffabc9','#b3f0e7','#ffffff','#ffca70'];
    for(let i=0;i<(grand?200:120);i++){
      const piece=doc.createElement('i');
      piece.setAttribute('style','--x:'+(i*37%100)+'%;--c:'+colors[i%6]+';--s:'+(5+i%7)+'px;--t:'+(3.8+i%9*.12)+'s;--d:'+(Math.floor(i/40)*.7+i%8*.07)+'s;--drift:'+((i%2?1:-1)*(25+i%65))+'px;--r:'+((i%2?1:-1)*(400+i*13))+'deg');
      confetti.append(piece);
    }
  }
  function flash(doc,fx,grand){
    const light=doc.createElement('div');light.className='raffle-reveal-flash';fx.append(light);
    const colors=grand?['#ffe395','#fff4ce','#eabb57','#ffffff']:['#ffe395','#e2d7ff','#ffabc9','#b3f0e7'];
    for(let i=0;i<(grand?14:9);i++){
      const burst=doc.createElement('b');burst.className='raffle-burst';
      burst.setAttribute('style','--x:'+(10+i*29%80)+'%;--y:'+(12+i*19%64)+'%;--c:'+colors[i%4]+';--d:'+(.05+i*.16)+'s');fx.append(burst);
    }
  }
  function mount(doc,getLive){
    const host=doc.getElementById('raffleLivePanel'),name=doc.getElementById('raffleLiveName');
    if(!host||!name)return ()=>{};
    const overlay=doc.getElementById('raffleLiveOverlay');
    const stage=doc.createElement('div'),progress=doc.createElement('div'),current=doc.createElement('div'),list=doc.createElement('div'),fx=doc.createElement('div');
    stage.className='raffle-batch-stage';progress.className='raffle-live-pool raffle-batch-progress';
    current.className='raffle-live-name raffle-batch-current';list.className='raffle-batch-list';fx.className='raffle-batch-fx';
    stage.append(progress,current,list);host.insertBefore(stage,name);host.append(fx);name.hidden=true;
    let last='',lastSpin=-1,lastPerson='',lastCount='',lastRoll='',roll=null,shake=0;
    function slide(node,from){
      if(!calm())node.animate?.([{transform:'translateY('+from+')',opacity:.15},{transform:'translateY(0)',opacity:1}],{duration:150,easing:'cubic-bezier(.16,1,.3,1)'});
    }
    function personCard(person,animate=false){
      current.replaceChildren();
      const value=doc.createElement('span'),generation=doc.createElement('span');
      value.className='raffle-person-name';generation.className='raffle-person-gen';
      value.textContent=person.name;generation.textContent=person.generation+'기';current.append(value,generation);
      if(animate)slide(value,'22px');
    }
    const tick=()=>{
      const live=getLive(),people=live.winners||[],f=frame(live),grand=isGrand(live);
      const signature=[live.drawId,f.phase,f.index,f.revealed,!!live.batch.paused].join('|');
      if(signature!==last){
        last=signature;lastCount='';lastRoll='';roll=null;current.replaceChildren();list.replaceChildren();fx.replaceChildren();stage.dataset.phase=f.phase;
        current.className='raffle-live-name raffle-batch-current'+
          (f.phase==='countdown'?' countdown':f.phase==='spin'?' spinning':f.phase==='generation'?' generation-reveal':f.phase==='transition'?' pre-generation':f.phase==='name'||f.phase==='complete'?' winner':'');
        host.classList.toggle('grand',grand);
        host.classList.toggle('suspense',f.phase==='generation'||f.phase==='transition');
        host.classList.toggle('celebrating',f.phase==='name'||f.phase==='complete');
        overlay?.classList.toggle('raffle-spotlight',f.phase==='generation'||f.phase==='transition');
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
          if(f.phase==='generation'){label.textContent='당첨자의 기수는';roll=doc.createElement('span');roll.className='raffle-roulette-name';roll.hidden=true;}
          if(f.phase==='transition'){
            value.textContent=f.index===0?'첫 행운의 주인공은…':'다음 행운의 주인공은…';value.className+=' raffle-heartbeat';
            value.setAttribute('style','animation-delay:-'+((f.t-INTRO)%STEP%1000)+'ms');
          }
          if(f.phase==='complete'){label.textContent='당첨을 축하합니다!';value.textContent=people.length+'명 모두 공개';}
          current.append(label,value);if(roll)current.append(roll);
        }
        if(f.phase==='name'||f.phase==='complete')celebrate(doc,grand);
        else doc.getElementById('raffleConfetti')?.replaceChildren();
        // Only screens that are watching at the moment of the reveal get the flash and shake.
        if(f.phase==='name'&&(f.t-INTRO)%STEP-TRANSITION-GENERATION<1500&&!live.batch.paused){
          flash(doc,fx,grand);
          if(!calm()){clearTimeout(shake);host.classList.toggle('reveal-shake',true);shake=setTimeout(()=>host.classList.toggle('reveal-shake',false),grand?900:650);}
        }
        const foot=doc.getElementById('raffleLiveFoot');
        if(foot)foot.textContent=live.batch.paused?'진행자가 잠시 공개를 멈췄습니다':f.phase==='generation'?'잠시 후 이름을 공개합니다…':f.phase==='complete'?'차례로 간단한 자기소개와 인사를 부탁드립니다.':f.phase==='name'?'축하합니다! 박수 부탁드립니다.':'행운의 주인공은…';
      }
      if(f.phase==='countdown'){
        const n=String(Math.ceil((5000-f.t)/1000));
        if(n!==lastCount){
          lastCount=n;const number=doc.createElement('strong');
          number.className='raffle-person-name raffle-count-number'+(n==='1'?' final':'');number.textContent=n;
          current.replaceChildren(number);
        }
      }
      if(f.phase==='spin'&&Math.floor(f.t/220)!==lastSpin){
        lastSpin=Math.floor(f.t/220);const p=spinPerson(live.candidates||[],lastPerson);
        if(p){lastPerson=p.name+'|'+p.generation;personCard(p,true);}else current.textContent='두근두근…';
      }
      if(f.phase==='generation'&&roll){
        const g=f.t-INTRO-f.index*STEP-TRANSITION,value=current.children[1],slot=countAt(SLOT_TICKS,g),names=countAt(ROULETTE_TICKS,g);
        const key=g<SLOT_END?'s'+slot:'r'+names;
        if(key!==lastRoll){
          const landing=g>=SLOT_END&&lastRoll[0]!=='r';lastRoll=key;
          current.classList.toggle('slot-rolling',g<SLOT_END);current.classList.toggle('name-rolling',g>=SLOT_END);
          if(g<SLOT_END){
            const gens=slotValues(live,f.index);value.textContent=gens[(slot-1)%gens.length]+'기';value.className='raffle-generation-value slot-roll';slide(value,'-45%');
          }else{
            value.textContent=people[f.index].generation+'기';
            if(landing)value.className='raffle-generation-value slot-landed';
            if(names){const list=rouletteNames(live,f.index);roll.hidden=false;roll.textContent=list[(names-1)%list.length];slide(roll,'40%');}
          }
        }
      }
    };
    tick();const timer=setInterval(tick,30);
    return ()=>{clearInterval(timer);clearTimeout(shake);stage.remove();fx.remove();name.hidden=false;host.classList.remove('suspense','celebrating','reveal-shake');overlay?.classList.remove('raffle-spotlight');doc.getElementById('raffleConfetti')?.replaceChildren();};
  }
  // PCM WAV keeps the mobile playback path used by the existing raffle sounds.
  // Every winner uses the same pre-rendered segment, so long draws stay cheap to build on phones.
  const scores=new Map(),parts=new Map(),voices=new Map(),RING=[523,769,1067,1381,1777,2141],RATE=24000,TAU=2*Math.PI,SINE=new Float32Array(4096);
  for(let i=0;i<4096;i++)SINE[i]=Math.sin(TAU*i/4096);
  // Table sine in cycles: phase 1 is one full turn.
  const sn=x=>SINE[(x*4096|0)&4095];
  function reverb(wet){
    const out=new Float32Array(wet.length);
    [1130,1173,1082,1032].forEach(size=>{
      const line=new Float32Array(size);let at=0,low=0;
      for(let i=0;i<wet.length;i++){const y=line[at];low+=.25*(y-low);line[at]=wet[i]+low*.8;out[i]+=y*.25;at=(at+1)%size;}
    });
    [403,320].forEach(size=>{
      const line=new Float32Array(size);let at=0;
      for(let i=0;i<out.length;i++){const y=line[at],x=out[i];line[at]=x+y*.5;out[i]=y-x*.5;at=(at+1)%size;}
    });
    return out;
  }
  function render(seconds,build,seed){
    const length=Math.ceil(seconds*RATE),dry=new Float32Array(length),wet=new Float32Array(length);
    const rnd=()=>(seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2147483648-1;
    const env=(t,a,d)=>Math.min(1,t/a)*Math.exp(-t/d);
    // Repeated hits share one rendered buffer (keyed), so a long score costs little more than a short one.
    function put(at,d,v,send,fn,key){
      let buf=key&&voices.get(key);
      if(!buf){buf=new Float32Array(Math.ceil(d*RATE));for(let i=0;i<buf.length;i++)buf[i]=fn(i/RATE);if(key)voices.set(key,buf);}
      const first=Math.round(at*RATE);
      for(let i=Math.max(0,-first);i<buf.length&&first+i<length;i++){const x=buf[i]*v;dry[first+i]+=x;wet[first+i]+=x*send;}
    }
    const pick=n=>Math.floor((rnd()+1)/2*n)%n;
    // Low drums are saturated so phone speakers still hear the harmonics.
    const kick=(at,v=1)=>put(at,.5,v,.05,t=>Math.tanh(2.2*sn((48*t+110/18*(1-Math.exp(-18*t)))))*env(t,.002,.15)+(t<.004?rnd()*.5:0),'kick');
    const boom=(at,v=1,d=1.4)=>put(at,d*3,v,.2,t=>Math.tanh(1.8*sn((42*t+40/6*(1-Math.exp(-6*t)))))*env(t,.004,d),'boom'+d);
    const heart=(at,v=1)=>[[0,1],[.22,.72]].forEach(([o,a])=>put(at+o,.4,v*a,.08,t=>Math.tanh(3*sn((52*t+38/14*(1-Math.exp(-14*t)))))*env(t,.006,.075),'heart'));
    const snare=(at,v=1,tone=190)=>{let low=0;put(at,.25,v,.15,t=>{const n=rnd();low+=.35*(n-low);return (n-low)*env(t,.001,.055)*1.2+sn(tone*t)*env(t,.001,.03)*.6;},'snare'+tone+'|'+pick(4));};
    const hat=(at,v=1,d=.03)=>{let low=0;put(at,d*5,v,.05,t=>{const n=rnd();low+=.6*(n-low);return (n-low)*env(t,.0005,d);},'hat'+d+'|'+pick(4));};
    const tom=(at,f,v=1)=>put(at,.6,v,.12,t=>Math.tanh(1.6*sn((f*t+f*.8/12*(1-Math.exp(-12*t)))))*env(t,.002,.17),'tom'+f.toFixed(1));
    const crash=(at,v=1,d=1.5)=>{let low=0;put(at,d*3.2,v,.35,t=>{
      const n=rnd();low+=.5*(n-low);let ring=0;for(let k=0;k<6;k++)ring+=RING[k]*t%1<.5?1:-1;
      return ((n-low)*.85+ring*.035)*env(t,.002,d)*(1+2*Math.exp(-t*14));},'crash'+d);};
    const beep=(at,f,d,v=1)=>put(at,d+.03,v,.25,t=>(sn(f*t)+.35*sn(2*f*t)+.18*sn(3*f*t))*Math.min(1,t/.004,Math.max(0,(d-t)/.02)),'beep'+f+'|'+d);
    const click=(at,f,v=1)=>put(at,.07,v,.08,t=>(sn(f*t)*.7+sn(f*2.76*t)*.3)*env(t,.0005,.013),'click'+f);
    const bell=(at,f,d,v=1,ratio=3.5)=>put(at,d*4,v,.5,t=>sn(f*t+.35*Math.exp(-t*3)*sn(f*ratio*t))*env(t,.002,d),'bell'+f+'|'+d+'|'+ratio);
    const brass=(at,f,d,v=1)=>put(at,d+.35,v,.32,t=>{
      const a=Math.min(1,t/.035)*(t<d?1:Math.exp(-(t-d)/.09)),bright=.3+.62*Math.min(1,t/.09),vib=1+.005*sn(5.6*t)*Math.min(1,t/.35);
      let s=0,k=1;for(let h=1;h<=6;h++){s+=sn(f*h*vib*t)*k/h;k*=bright;}return s*a*.55;},'brass'+f.toFixed(2)+'|'+d);
    const pad=(at,f,d,v=1)=>put(at,d+.4,v,.45,t=>{
      const a=Math.min(1,t/(d*.45))*(t<d?1:Math.exp(-(t-d)/.12));let s=0;
      for(let h=1;h<=5;h++)s+=(sn(f*h*t)+sn(f*1.006*h*t))/h;return s*a*(.8+.2*sn(6*t))*.28;});
    const bass=(at,f,v=1)=>put(at,.3,v,0,t=>(sn(f*t)+.5*sn(2*f*t)+.25*sn(3*f*t))*env(t,.003,.09));
    function riser(at,d,v=1){
      let b1=0,b2=0;
      put(at,d,v,.3,t=>{
        const u=t/d,f=300*Math.pow(14,u),q=Math.min(.9,TAU*f/RATE),n=rnd();
        b1+=q*(n-b1-b2*.6);b2+=q*b1;
        return (b1*.8+.35*sn((150*d/Math.log(6))*Math.pow(6,u)))*u*u;
      });
    }
    function clap(at,v=1){
      const kind=pick(12);let a=0,b=0;const k1=.45+kind%4*.04,k2=.12+kind%3*.025,gap=.006+kind%5*.002;
      put(at,.06,v,.3,t=>{const n=rnd();a+=k1*(n-a);b+=k2*(n-b);return (a-b)*(env(t,.0006,.009)+(t>gap?.6*env(t-gap,.0006,.012):0))*2.4;},'clap'+kind);
    }
    function whistle(at,v=1){const kind=pick(4),f=2300+kind*90;put(at,.75,v,.35,t=>sn(f*t+380*t*t-(t>.45?(t-.45)*(t-.45)*1400:0))*Math.min(1,t/.03,Math.max(0,(.75-t)/.08)),'whistle'+kind);}
    function crowd(at,d,v=1){
      let b1=0,b2=0,c1=0,c2=0;
      put(at,d,v,.4,t=>{
        const u=t/d,shape=Math.min(1,u/.12)*Math.min(1,(1-u)/.45),n=rnd(),f1=(650+250*Math.min(1,u*3))*TAU/RATE,f2=(1500+500*Math.min(1,u*3))*TAU/RATE;
        b1+=f1*(n-b1-b2*.35);b2+=f1*b1;c1+=f2*(n-c1-c2*.5);c2+=f2*c1;
        return (b1*.9+c1*.5)*shape;
      });
      for(let k=0;k<7;k++){
        const f=230+(rnd()+1)*130,o=(rnd()+1)*.25;
        put(at+o,d*.7,v*.08,.4,t=>{const u=t/(d*.7),g=f*(1+.3*Math.min(1,u*4)),p=g*t*(1+.01*sn(5*t));return (sn(p)+.6*sn(2*p)+.4*sn(3*p)+.25*sn(4*p))*Math.min(1,u/.1)*Math.max(0,1-u);});
      }
    }
    function applause(at,d,v=1,density=1){
      const n=Math.round(d*55*density);
      for(let k=0;k<n;k++){const u=(rnd()+1)/2,shape=Math.min(1,u/.08)*Math.min(1,(1-u)/.5);if((rnd()+1)/2<shape)clap(at+u*d,v*(.5+(rnd()+1)*.25));}
      crowd(at,d*.85,v*.7);
    }
    build({rnd,kick,boom,heart,snare,hat,tom,crash,beep,click,bell,brass,pad,bass,riser,applause,whistle});
    const verb=reverb(wet);for(let i=0;i<length;i++)dry[i]+=verb[i];
    return dry;
  }
  function fanfare(x,at,root,grand){
    const r=root;
    x.kick(at,1);x.boom(at,grand?1:.7,grand?2:1.2);x.crash(at,grand?.9:.7,grand?2.2:1.6);
    [1,1.25,1.5,2].forEach(m=>x.brass(at,r*m,.32,.16));x.brass(at,r/2,.32,.16);
    [.36,.52,.68].forEach(o=>{x.brass(at+o,r*2,.11,.17);x.snare(at+o,.35);});
    const hold=at+.86;
    x.kick(hold,.9);x.crash(hold,.55,1.8);
    [1,1.25,1.5,2,2.5].forEach(m=>x.brass(hold,r*m,grand?2.4:1.5,.13));x.brass(hold,r/2,grand?2.4:1.5,.16);
    x.pad(hold,r/2,grand?2.6:1.8,.22);x.pad(hold,r*.75,grand?2.6:1.8,.14);
    if(grand){
      [1047,1319,1568,2093,1568,2093,2637,3136].forEach((f,i)=>x.brass(hold+.2+i*.16,f*r/523.25/2,.3,.11));
      x.bell(at,98,1.6,.35,1.41);x.crash(hold+1.4,.6,2);x.kick(hold+1.4,.7);
    }
    for(let i=0;i<(grand?18:10);i++)x.bell(hold+.15+i*.12,[4,5,6,8,10,12][i%6]*r,.35,.08);
  }
  function winnerSegment(root,grand,seed){
    const T=TRANSITION/1000,G=T,R=T+GENERATION/1000;
    return render(STEP/1000+3,x=>{
      [0,1,2].forEach(s=>x.heart(s,grand?1:.8));
      if(grand)[2.5,2.75].forEach(s=>x.heart(s,.6));
      x.pad(0,110,T,.28);x.pad(0,164.81,T,.18);
      x.pad(G,116.54,R-G-.15,.28);x.pad(G,174.61,R-G-.15,.2);x.pad(G,233.08,R-G-.15,.12);
      SLOT_TICKS.forEach((ms,i)=>x.click(G+ms/1000,i%2?1700:1500,.42));
      const land=G+SLOT_END/1000;
      x.bell(land,1568,.5,.35,1.4);x.bell(land,2093,.45,.2,1.4);x.kick(land,.7);x.crash(land,.25,.6);
      [1,1.25,1.5].forEach(m=>x.brass(land,root*2*m,.14,.1));
      ROULETTE_TICKS.forEach(ms=>{x.click(G+ms/1000,1100,.5);x.hat(G+ms/1000,.25);});
      const rollEnd=R-.8;
      for(let s=G+ROULETTE_START/1000,u;s<rollEnd;s+=Math.max(.034,.12-u*.09)){
        u=(s-G)/(rollEnd-G);x.snare(s,.12+u*.4+(grand?.1:0));if(grand&&Math.round(s*20)%3===0)x.tom(s,90+u*40,.25);
      }
      [220,180,150,120].forEach((f,i)=>x.tom(R-.75+i*.15,f*(grand?.85:1),.55+i*.07));
      x.riser(R-(grand?3.2:2.4),(grand?3.2:2.4)-.15,grand?.55:.42);
      fanfare(x,R,root,grand);
      x.applause(R+.12,grand?6.5:4.6,grand?.6:.48,grand?1.6:1);
      [.6,1.7].concat(grand?[1.1,2.5,3.4]:[]).forEach(o=>x.whistle(R+o,.12));
    },seed);
  }
  const PARTS={
    intro:()=>render(INTRO/1000+3,x=>{
      for(let s=0;s<5;s++){x.beep(s,s<4?880:1318.5,s<4?.16:.4,s<4?.28:.36);x.kick(s,.55+s*.08);if(s<4)x.click(s+.5,1200,.22);}
      x.pad(0,110,5,.22);x.pad(0,220,5,.12);x.riser(3,1.92,.38);
      x.kick(5,1);x.crash(5,.65);[1,1.25,1.5,2].forEach(m=>x.brass(5,261.63*m,.3,.12));
      for(let k=Math.ceil(5/.22);k*.22<INTRO/1000-.15;k++)x.click(k*.22,1600,.3);
      for(let s=5;s<8.2;s+=.25){
        const beat=Math.round((s-5)/.25);x.hat(s,.22);x.bass(s,beat%4<2?110:130.81,.22);
        if(beat%2===0)x.kick(s,.6);if(beat%4===2)x.snare(s,.42);
      }
      for(let s=8.2;s<8.85;s+=.05)x.snare(s,.15+(s-8.2)*.6);
    },11),
    a:()=>winnerSegment(261.63,false,31),
    b:()=>winnerSegment(293.66,false,47),
    grand:()=>winnerSegment(261.63,true,23),
    finale:()=>render(9,x=>{
      [523.25,659.25,783.99,1046.5,987.77,1174.66,1318.51,1567.98].forEach((f,i)=>x.brass(.1+i*.15,f/2,.25,.12));
      fanfare(x,1.4,261.63,false);x.applause(.2,7,.5,1.4);[1,2.2,3.1].forEach(o=>x.whistle(o,.12));
    },59)
  };
  const part=name=>parts.get(name)||(parts.set(name,PARTS[name]()),parts.get(name));
  // Renders the shared pieces one at a time while the page is idle, so starting the draw does not stall phones.
  function prepare(grand=false){
    const queue=['intro',...(grand?['grand']:['a','b']),'finale'].filter(name=>!parts.has(name));
    const next=()=>{const name=queue.shift();if(!name)return;part(name);setTimeout(next,60);};
    if(queue.length)setTimeout(next,0);
  }
  function score(count,grand=false){
    const key=count+'|'+(grand?1:0);
    if(scores.has(key))return scores.get(key);
    const end=duration(count)/1000,length=Math.ceil((end+9)*RATE),samples=new Float32Array(length);
    const mix=(segment,at)=>{const first=Math.round(at*RATE);for(let i=0;i<segment.length&&first+i<length;i++)samples[first+i]+=segment[i];};
    mix(part('intro'),0);
    const segments=grand?[part('grand')]:[part('a'),part('b')];
    for(let i=0;i<count;i++)mix(segments[i%segments.length],(INTRO+i*STEP)/1000);
    mix(part('finale'),end);
    let peak=0;for(let i=0;i<length;i++)peak=Math.max(peak,Math.abs(samples[i]));
    const gain=Math.min(3,1.6/(peak||1)),bytes=new ArrayBuffer(44+length*2),view=new DataView(bytes);
    function word(at,str){for(let i=0;i<str.length;i++)view.setUint8(at+i,str.charCodeAt(i));}
    word(0,'RIFF');view.setUint32(4,36+length*2,true);word(8,'WAVE');word(12,'fmt ');
    view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
    view.setUint32(24,RATE,true);view.setUint32(28,RATE*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
    word(36,'data');view.setUint32(40,length*2,true);
    const pcm=new Int16Array(bytes,44,length);
    for(let i=0;i<length;i++){const x=Math.max(-3,Math.min(3,samples[i]*gain));pcm[i]=x*(27+x*x)/(27+9*x*x)*30800;}
    const blob=new Blob([bytes],{type:'audio/wav'}),url=typeof URL!=='undefined'&&URL.createObjectURL?URL.createObjectURL(blob):blob;
    scores.set(key,url);return url;
  }
  root.HanjogoBatch={INTRO,TRANSITION,GENERATION,HOLD,STEP,SLOT_END,ROULETTE_START,SLOT_TICKS,ROULETTE_TICKS,duration,elapsed,frame,control,spinPerson,slotValues,rouletteNames,isGrand,mount,prepare,score};
  if(typeof module!=='undefined')module.exports=root.HanjogoBatch;
})(typeof window!=='undefined'?window:globalThis);
