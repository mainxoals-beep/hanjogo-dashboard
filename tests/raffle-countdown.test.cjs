const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
// 공개 페이지의 한 명 추첨도 일괄 추첨과 같은 화면(HanjogoBatch.mount)으로 진행됩니다.
const source=fs.readFileSync('schedule.html','utf8');let now=0,tick;const nodes=new Map();
function element(){const classes=new Set();return {className:'',textContent:'',innerHTML:'',hidden:false,dataset:{},children:[],setAttribute(){},remove(){},
 replaceChildren(...c){this.children=[...c];this.textContent='';},append(...c){this.children.push(...c);},insertBefore(c){this.children.unshift(c);},
 get lastChild(){return this.children.at(-1)},classList:{add:(...v)=>v.forEach(x=>classes.add(x)),remove:(...v)=>v.forEach(x=>classes.delete(x)),contains:x=>classes.has(x),toggle:(x,on)=>{if(on===undefined?!classes.has(x):on)classes.add(x);else classes.delete(x);}}};}
const node=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
const text=el=>el.children.length?el.children.filter(c=>!c.hidden).map(text).join(' · '):String(el.textContent);
const Batch=require('../assets/raffle-batch.js');
const ctx=vm.createContext({Date:{now:()=>now},Math,HanjogoBatch:Batch,document:{getElementById:node,createElement:element},rafflePreviewMode:false,raffleDrumAt:0,raffleStopSound(){},rafflePlayScore(){},matchMedia:()=>({matches:true}),raffleAnimationTimer:null,raffleRevealTimer:null,
 publicRaffleCenter:{live:{status:'drawing',drawId:'d1',prize:'테스트 경품',winner:{name:'당첨예시',generation:2},candidates:[{name:'후보',generation:7},{name:'같은기수',generation:2}],revealAt:11000}},clearInterval(){},setTimeout:()=>2,clearTimeout(){}});
const realNow=Date.now,realInterval=global.setInterval;Date.now=()=>now;global.setInterval=f=>{tick=f;return 1;};
try{
 ctx.raffleBatchStop=null;
 vm.runInContext(source.slice(source.indexOf('function closeRaffleOverlay('),source.indexOf('function raffleEventStarted(')),ctx);
 ctx.openRaffleOverlay();const current=node('raffleLivePanel').children[0].children[1];
 assert.equal(node('raffleLiveName').hidden,true);assert.equal(text(current),'5');
 now=1000;tick();assert.equal(text(current),'4');now=4999;tick();assert.equal(text(current),'1');
 now=5000;tick();assert(current.className.includes('spinning'));
 now=7300;tick();assert(current.className.includes('generation-reveal'));assert.match(current.children[1].textContent,/^\d+기$/);
 now=7000+1600;tick();assert.equal(current.children[1].textContent,'2기');
 now=7000+2100;tick();assert.equal(current.children[2].textContent,'같은기수');
 now=10999;tick();assert(!current.className.includes('winner'));
 now=11000;tick();assert.equal(text(current),'당첨예시 · 2기');assert(current.className.includes('winner'));assert.equal(node('raffleConfetti').children.length,120);
 assert.equal(node('raffleLiveFoot').textContent,'축하합니다! 현장에서 경품을 받아주세요.');
 ctx.publicRaffleCenter.live={...ctx.publicRaffleCenter.live,drawId:'preview-1'};now=11100;tick();assert(node('raffleLiveFoot').textContent.includes('실제 당첨이 아닙니다'));
 // 갤럭시탭: 18초 공개, 10~12초 예고, 12초부터 기수
 const g={status:'drawing',drawId:'g',prize:'갤럭시탭 S10',winner:{name:'탭당첨',generation:5},revealAt:18000};
 assert.equal(Batch.frame(g,9999).phase,'spin');assert.equal(Batch.frame(g,10000).phase,'transition');assert.equal(Batch.frame(g,12000).phase,'generation');assert.equal(Batch.frame(g,18000).phase,'name');
}finally{Date.now=realNow;global.setInterval=realInterval;}
vm.runInContext(source.slice(source.indexOf('async function loadPublicRaffle('),source.indexOf('document.getElementById("raffleWatchBtn")',source.indexOf('async function loadPublicRaffle('))),ctx);
ctx.loadPublicRaffle().then(()=>console.log('PASS: single draw uses the shared screen: countdown, spin, 기수 slot, same-기수 roulette, winner/confetti, preview label, 갤럭시탭 timing'));
