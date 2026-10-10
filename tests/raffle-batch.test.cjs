const assert=require('node:assert/strict');
const B=require('../assets/raffle-batch.js');
const people=Array.from({length:5},(_,i)=>({name:'테스트'+i,generation:i+2}));
let live={drawId:'test',startedAt:1000,winners:people,batch:{elapsed:0,anchor:1000,paused:false,version:0}};
assert.equal(B.duration(5),37000);assert.equal(B.duration(2),19000);
assert.equal(B.frame(live,5999).phase,'countdown');assert.equal(B.frame(live,6000).phase,'spin');
for(let i=0;i<5;i++){
  let f=B.frame(live,8000+i*6000);assert.equal(f.phase,'generation');assert.equal(f.index,i);assert.equal(f.revealed,i);
  f=B.frame(live,10999+i*6000);assert.equal(f.phase,'generation');
  f=B.frame(live,11000+i*6000);assert.equal(f.phase,'name');assert.equal(f.revealed,i+1);
}
assert.equal(B.frame(live,38000).phase,'complete');
live=B.control(live,'pause',9500);assert.equal(B.elapsed(live,100000),8500);
assert.equal(B.frame(live,100000).phase,'generation');
live=B.control(live,'next',100000);assert.equal(B.frame(live,100000).phase,'name');assert(live.batch.paused);
live=B.control(live,'resume',100000);assert.equal(B.frame(live,103000).index,1);
const restored=JSON.parse(JSON.stringify(live));assert.deepEqual(B.frame(restored,106000),B.frame(live,106000));
assert.deepEqual(restored.winners,people);
console.log('PASS: 5/2-person timing, no early name reveal, pause/next/resume and reload continuity');
