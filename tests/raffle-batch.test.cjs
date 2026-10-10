const assert=require('node:assert/strict');
const B=require('../assets/raffle-batch.js');
const people=Array.from({length:5},(_,i)=>({name:'테스트'+i,generation:i+2}));
let live={drawId:'test',startedAt:1000,winners:people,batch:{elapsed:0,anchor:1000,paused:false,version:0}};
assert.equal(B.duration(5),82000);assert.equal(B.duration(2),37000);
for(let i=0;i<5;i++){
 const start=8000+i*15000;
 assert.equal(B.frame(live,start).phase,'transition');
 assert.equal(B.frame(live,start+3000).phase,'generation');
 assert.equal(B.frame(live,start+7999).revealed,i);
 assert.equal(B.frame(live,start+8000).phase,'name');
 assert.equal(B.frame(live,start+14999).revealed,i+1);
}
assert.equal(B.frame(live,83000).phase,'complete');
live=B.control(live,'pause',9500);assert.equal(B.elapsed(live,100000),8500);
live=B.control(live,'next',100000);assert.equal(B.frame(live,100000).phase,'generation');
live=B.control(live,'next',100000);assert.equal(B.frame(live,100000).phase,'name');
live=B.control(live,'resume',100000);assert.equal(B.frame(live,107000).phase,'transition');
assert.deepEqual(B.frame(JSON.parse(JSON.stringify(live)),108000),B.frame(live,108000));
console.log('PASS: slower reveal boundaries, no early names, pause/next/resume and reload');
