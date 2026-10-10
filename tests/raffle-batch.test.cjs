const assert=require('node:assert/strict');
const B=require('../assets/raffle-batch.js');
const people=Array.from({length:5},(_,i)=>({name:'테스트'+i,generation:i+2}));
let live={drawId:'test',startedAt:1000,winners:people,batch:{elapsed:0,anchor:1000,paused:false,version:0}};
assert.equal(B.duration(5),94000);assert.equal(B.duration(2),43000);
for(let i=0;i<5;i++){
 const start=10000+i*17000;
 assert.equal(B.frame(live,start).phase,'transition');
 assert.equal(B.frame(live,start+3000).phase,'generation');
 assert.equal(B.frame(live,start+9999).revealed,i);
 assert.equal(B.frame(live,start+10000).phase,'name');
 assert.equal(B.frame(live,start+16999).revealed,i+1);
}
assert.equal(B.frame(live,95000).phase,'complete');
live=B.control(live,'pause',11500);assert.equal(B.elapsed(live,100000),10500);
live=B.control(live,'next',100000);assert.equal(B.frame(live,100000).phase,'generation');
live=B.control(live,'next',100000);assert.equal(B.frame(live,100000).phase,'name');
live=B.control(live,'resume',100000);assert.equal(B.frame(live,107000).phase,'transition');
assert.deepEqual(B.frame(JSON.parse(JSON.stringify(live)),108000),B.frame(live,108000));
console.log('PASS: slower reveal boundaries, no early names, pause/next/resume and reload');

assert.equal(B.frame({winners:people,batch:{anchor:1000}},6000).phase,'spin');
assert.equal(B.frame({winners:people,batch:{anchor:1000}},9999).phase,'spin');
const candidates=[{name:'당첨자',generation:2},{name:'다른참가자',generation:7}];
assert.equal(B.spinPerson(candidates,'당첨자|2').name,'다른참가자');
assert.equal(B.spinPerson([],''),null);
assert.equal(B.spinPerson([candidates[1]],'다른참가자|7').generation,7);
