const fs=require('node:fs'),assert=require('node:assert/strict'),B=require('../assets/raffle-batch.js');
const html=fs.readFileSync('index.html','utf8');
const template=JSON.parse(html.match(/const RAFFLE_TEST_TEMPLATE=(.*?);\n/)[1]);
const original=template.match(/<style>([\s\S]*?)<\/style>/)[1];
assert.equal(fs.readFileSync('assets/raffle-presentation.css','utf8').trim(),original.slice(original.indexOf('.raffle-live-overlay')).trim());
const preview=fs.readFileSync('raffle-batch-preview.html','utf8');
for(const id of ['raffleLiveOverlay','raffleLivePanel','raffleLiveKicker','raffleLivePrize','raffleLivePool','raffleLiveName','raffleLiveFoot','raffleConfetti'])assert(preview.includes('id="'+id+'"'));
assert(preview.includes('assets/raffle-presentation.css'));
assert(html.includes('plan.id.startsWith("event-story-")'));
function element(){return {children:[],className:'',dataset:{},textContent:'',hidden:false,attributes:{},classList:{toggle(){},remove(){}},append(...children){this.children.push(...children)},replaceChildren(){this.children=[];this.textContent=''},insertBefore(child){this.children.push(child)},setAttribute(k,v){this.attributes[k]=v},remove(){},get lastChild(){return this.children.at(-1)}}}
const nodes=Object.fromEntries(['raffleLivePanel','raffleLiveName','raffleLiveFoot','raffleConfetti'].map(id=>[id,element()]));
const doc={getElementById:id=>nodes[id],createElement:element};let now=1000,tick;
const realNow=Date.now,realInterval=global.setInterval,realClear=global.clearInterval;
Date.now=()=>now;global.setInterval=fn=>{tick=fn;return 1};global.clearInterval=()=>{};
try{
 const live={drawId:'qa',winners:[{name:'당첨자',generation:2}],candidates:[{name:'일반참가자',generation:9}],batch:{anchor:1000,elapsed:0,paused:false}};
 const stop=B.mount(doc,()=>live),stage=nodes.raffleLivePanel.children[0],current=stage.children[1];
 assert(current.className.includes('raffle-live-name'));assert(current.className.includes('countdown'));
 now=6000;tick();assert(current.className.includes('spinning'));assert.equal(current.children[0].textContent,'일반참가자');assert.equal(current.children[1].textContent,'9기');
 now=13000;tick();assert(current.className.includes('generation-reveal'));assert.match(current.children[1].textContent,/^\d+기$/);assert.notEqual(current.children[1].textContent,'2기');
 now=13000+B.SLOT_END+50;tick();assert.equal(current.children[1].textContent,'2기');assert(current.children[1].className.includes('slot-landed'));
 now=13000+B.ROULETTE_START+50;tick();assert.equal(current.children[2].hidden,false);assert.equal(current.children[2].textContent,'? ? ?');
 now=18000;tick();assert(current.className.includes('winner'));assert.equal(current.children[0].textContent,'당첨자');assert.equal(current.children[1].textContent,'2기');assert.equal(nodes.raffleConfetti.children.length,120);
 assert.equal(stage.children[2].children.length,1);stop();assert.equal(nodes.raffleLiveName.hidden,false);
}finally{Date.now=realNow;global.setInterval=realInterval;global.clearInterval=realClear;}
const roster={drawId:'d1',winners:[{name:'가',generation:3}],candidates:[{name:'가',generation:3},{name:'나',generation:3},{name:'다',generation:3},{name:'라',generation:4}]};
const names=B.rouletteNames(roster,0);assert.deepEqual([...names].sort(),['나','다']);assert.deepEqual(B.rouletteNames(roster,0),names);
assert(!B.slotValues(roster,0).includes(3));assert.deepEqual(B.slotValues(roster,0),B.slotValues(roster,0));
assert(B.SLOT_TICKS.every((t,i)=>!i||t>B.SLOT_TICKS[i-1])&&B.SLOT_TICKS.at(-1)<B.SLOT_END);
assert(B.ROULETTE_TICKS[0]===B.ROULETTE_START&&B.ROULETTE_TICKS.at(-1)<B.GENERATION);
assert(B.isGrand({prize:'삼성 갤럭시탭 S10'})&&!B.isGrand({prize:'위스키'}));
console.log('PASS: original presentation CSS, matching card states, name/generation, slot/roulette, confetti and story pool selection');
