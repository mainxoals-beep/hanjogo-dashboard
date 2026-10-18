const assert=require('node:assert/strict');
const B=require('../assets/raffle-batch.js');
// 한 명씩 진행: 이름이 공개되면 멈추고, 진행자가 '다음'을 눌러야 다음 당첨자로 넘어갑니다.
const people=Array.from({length:3},(_,i)=>({name:'테스트'+i,generation:i+2}));
let live={drawId:'step',startedAt:0,winners:people,batch:{elapsed:0,anchor:0,paused:false,version:0,stepwise:true}};
const hold=i=>B.INTRO+(i+1)*B.STEP-1;
assert.equal(B.frame(live,hold(0)-5000).phase,'name');
assert.equal(B.elapsed(live,10*60*1000),hold(0));
assert.equal(B.frame(live,10*60*1000).phase,'name');assert.equal(B.frame(live,10*60*1000).revealed,1);
assert.equal(B.holdIn(live,1000),hold(0)-1000);assert.equal(B.holdIn(live,10*60*1000),0);
live=B.control(live,'next',10*60*1000);
assert.equal(live.batch.elapsed,B.INTRO+B.STEP);assert.equal(B.frame(live,10*60*1000).phase,'transition');assert.equal(B.frame(live,10*60*1000).index,1);
assert.equal(B.elapsed(live,10*60*1000+99999),hold(1));
live=B.control(live,"next",10*60*1000+99999);
assert.equal(B.frame(live,10*60*1000+99999).phase,'transition');assert.equal(B.frame(live,10*60*1000+99999).index,2);
// 마지막 당첨자 이름에서도 멈추고, 한 번 더 누르면 전체 당첨자 화면으로 갑니다.
assert.equal(B.frame(live,10*60*1000+999999).phase,'name');assert.equal(B.holdIn(live,10*60*1000+999999),0);
live=B.control(live,'next',10*60*1000+999999);
assert.equal(B.frame(live,10*60*1000+999999).phase,'complete');assert.equal(B.holdIn(live),Infinity);
// 예전 방식(stepwise 없음)은 그대로 자동 진행합니다.
const auto={drawId:'auto',startedAt:0,winners:people,batch:{elapsed:0,anchor:0,paused:false,version:0}};
assert.equal(B.frame(auto,B.duration(3)).phase,'complete');assert.equal(B.holdIn(auto,0),Infinity);
console.log('PASS: step-by-step draws hold on each name, next moves on, last next shows everyone, auto draws unchanged');
