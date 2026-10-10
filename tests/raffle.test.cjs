const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
require('../assets/raffle-roster.js');const R=globalThis.HanjogoRaffle;
// 실제 당첨자 선택(준비위원 확률 절반, 준비위원 당첨 최대 2명, 1기 제외 등)은 서버 함수 raffle_private.draw가 합니다.
// 이 테스트는 화면 쪽 명단 정리와, 화면이 서버 추첨을 올바르게 부르는지만 확인합니다.
const sample={participantPayments:[{name:'가나다',generation:'2기',status:'paid'},{name:'가나다',generation:2,status:'paid'},{name:'위원가',generation:3,status:'exempt'},{name:'취소자',generation:4,status:'cancelled'}],committee:[{name:'위원가',gen:3}],donations:[{name:'가나다',generation:2},{name:'후원자',generation:5},{name:'취소자',generation:4}],sponsors:[{name:'브랜드 / 후원자(5기)'},{name:'개인 불명'}],raffleCenter:{storyEntries:[],history:[]}};

// 명단: 중복 합치기, 취소자 제외, 역할 합치기, 이름/기수 없는 항목은 확인 필요로 분리.
const roster=R.roster(sample,[{name:'운영가',generation:6}]);
assert.deepEqual(roster.entries.map(p=>p.name),['가나다','위원가','후원자','운영가']);
assert.equal(roster.skipped.length,1);
assert(!roster.entries.some(p=>p.name==='취소자'));
assert.deepEqual(roster.entries.find(x=>x.name==='위원가').roles,['참가자','준비위원']);
assert.deepEqual(roster.entries.find(x=>x.name==='후원자').roles,['후원','협찬']);
assert.deepEqual(roster.entries.find(x=>x.name==='운영가').roles,['운영위원']);
// 화면 명단은 준비위원 가중치를 계산하지 않습니다(서버가 처리).
assert(roster.entries.every(p=>p.weight===2));

// 추첨권: weight 2는 2장, weight 1은 1장. 기수 인원이 많아도 사람별 장수는 그대로.
const counts={};const pair=[{name:'일반',generation:2,weight:2},{name:'위원',generation:2,weight:1}];for(let ticket=0;ticket<3;ticket++){const name=R.pick(pair,()=>ticket).name;counts[name]=(counts[name]||0)+1;}assert.deepEqual(counts,{일반:2,위원:1});assert.equal(R.pick([],()=>0),null);
const uneven=[{name:'소수',generation:2,weight:2},...Array.from({length:10},(_,i)=>({name:'다수'+i,generation:3,weight:2}))];
const generationTickets={};for(let ticket=0;ticket<22;ticket++){const p=R.pick(uneven,n=>{assert.equal(n,22);return ticket;});generationTickets[p.generation]=(generationTickets[p.generation]||0)+1;}
assert.deepEqual(generationTickets,{2:2,3:20});
assert.throws(()=>R.pick(pair,()=>3),/invalid_ticket/);

// 스토리 참여자: 같은 사람이 두 번 등록돼도 한 번만.
sample.raffleCenter.storyEntries=[{name:'위원가',generation:3},{name:'위원가',generation:3}];assert.equal(R.pool(sample,[],'story').length,1);
// 이미 당첨된 사람은 기록을 지우거나 저장/불러오기를 해도 모든 추첨에서 빠집니다.
const won={history:[{winner:{name:'위원가',generation:3}}],live:{},storyEntries:sample.raffleCenter.storyEntries};won.winnerKeys=R.winnerKeys(won);won.history=[];
const restored=JSON.parse(JSON.stringify({...sample,raffleCenter:won}));assert.equal(R.pool(restored,[],'story').length,0);assert(!R.pool(restored,[],'confirmed').some(p=>p.name==='위원가'));
// 같은 기수 다른 사람은 화면 명단에서 빠지지 않습니다(같은 기수 확률 조정은 서버가 처리).
restored.participantPayments.push({name:'같은기수',generation:3,status:'paid'});assert(R.pool(restored,[],'confirmed').some(p=>p.name==='같은기수'));
// 모두 당첨되면 추첨 대상이 없습니다.
restored.raffleCenter.winnerKeys=R.roster(restored,[]).entries.map(p=>R.key(p));
assert.equal(R.pool(restored,[],'confirmed').length,0);assert.equal(R.pick(R.pool(restored,[],'confirmed'),()=>{throw Error('must not draw');}),null);

// 페이지 스크립트 문법, 가중치 문구 비노출.
const html=fs.readFileSync('index.html','utf8');for(const file of ['index.html','schedule.html'])for(const m of fs.readFileSync(file,'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))if(m[1].trim())new vm.Script(m[1]);
assert(!html.includes('가중치'));assert(!html.includes('raffleExcludeWinners'));assert(!fs.readFileSync('schedule.html','utf8').includes('가중치'));
const opHtml=html.slice(html.indexOf('id="body-operations-committee"'),html.indexOf('</section>',html.indexOf('id="body-operations-committee"')));
const operating=[...opHtml.matchAll(/class="member-card"><div[^>]*>([^<]+)<\/div><div[^>]*>(\d+)기/g)].map(m=>({name:m[1],generation:Number(m[2])}));assert(operating.length>0);

// 대시보드 추첨 버튼: 서버 함수(perform_raffle)를 가짜로 바꿔서 화면 동작만 확인합니다.
const current=process.argv[2]?JSON.parse(fs.readFileSync(process.argv[2],'utf8')):structuredClone(sample);current.raffleCenter ||= {history:[],storyEntries:[],live:{status:'idle'}};
current.raffleCenter.live ||= {status:'idle'};
const initialHistory=JSON.stringify(current.raffleCenter.history||[]);
const testStorage=new Map();
let writes=0,fail=false;const rpcCalls=[];const nodes=new Map(),handlers=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:true,textContent:'',innerHTML:'',focus(){},querySelectorAll:()=>[],addEventListener:(e,f)=>handlers.set(id+':'+e,f)});return nodes.get(id);};
const serverDraw=async(name,args)=>{
  rpcCalls.push({name,args:structuredClone(args)});await new Promise(r=>setImmediate(r));
  const taken=new Set([...R.winnerKeys(current.raffleCenter),...(args.p_test?args.p_test_keys:[])]);
  const winner=R.roster(current,operating).entries.find(p=>!taken.has(R.key(p)));
  const picked=winner?{name:winner.name,generation:winner.generation}:null;
  if(args.p_test)return {data:{winner:picked}};
  return {data:{center:{...current.raffleCenter,winnerKeys:[...taken,R.key(picked)],history:[...(current.raffleCenter.history||[]),{id:'draw-test',prize:args.p_prize,winner:picked}],live:{status:'drawing',drawId:'draw-test',prize:args.p_prize,winner:picked,revealAt:Date.now()+11000}}}};
};
const context=vm.createContext({sessionStorage:{getItem:k=>testStorage.get(k)||null,setItem:(k,v)=>testStorage.set(k,v)},state:structuredClone({...current,editMode:true}),DEFAULT_RAFFLE_CENTER:{history:[],storyEntries:[],live:{status:'idle'}},HanjogoRaffle:R,crypto:require('node:crypto').webcrypto,document:{getElementById:node,querySelectorAll:()=>operating.map(x=>({children:[{textContent:x.name},{textContent:x.generation+'기'}]}))},escapeHtml:x=>String(x??''),applyEditLock(){},uid:()=>String(Math.random()),setTimeout(){},DASHBOARD_TABLE:'dashboard_state',DASHBOARD_ID:'main',dSet:async()=>{writes++},sb:{from:()=>({select:()=>({eq:()=>({single:async()=>fail?{error:Error('offline')}:{data:structuredClone(current)}})})})},sbAdmin:{auth:{onAuthStateChange(){}},rpc:serverDraw,from:()=>({select:()=>({order:()=>({order:async()=>({data:[]})})})})}});
context.window={addEventListener(){}};
context.HanjogoBatch=require('../assets/raffle-batch.js');
for(const id of ['raffleBatchControls','raffleTestPreview']){node(id).dataset={};node(id).removeAttribute=()=>{};}
vm.runInContext(html.slice(html.indexOf('function raffleGeneration('),html.indexOf('document.getElementById("raffleResetDisplayBtn")')),context);
(async()=>{
  // 테스트 추첨: 서버에 p_test로 요청, 실제 기록·저장 없음, 앞선 테스트 당첨자는 다음 요청에 제외 목록으로 전달.
  node('rafflePoolSelect').value='confirmed';await handlers.get('raffleTestBtn:click')();
  assert.equal(rpcCalls.length,1);assert.equal(rpcCalls[0].name,'perform_raffle');assert.equal(rpcCalls[0].args.p_test,true);
  assert.equal(writes,0);assert.equal(JSON.stringify(context.state.raffleCenter.history),initialHistory);
  assert(node('raffleTestResult').textContent.includes('[테스트 결과]'));
  const firstKeys=JSON.parse(testStorage.get('hanjogo-raffle-test-v1'));assert.equal(firstKeys.length,1);
  assert(node('raffleTestPreview').srcdoc.includes(firstKeys[0].split('|')[0]));assert.equal(node('raffleTestPreview').hidden,false);
  await handlers.get('raffleTestBtn:click')();
  assert.deepEqual(rpcCalls[1].args.p_test_keys,firstKeys);
  const secondKeys=JSON.parse(testStorage.get('hanjogo-raffle-test-v1'));assert.equal(secondKeys.length,2);assert.notEqual(secondKeys[0],secondKeys[1]);
  assert.equal(writes,0);
  handlers.get('raffleTestResetBtn:click')();assert.equal(JSON.parse(testStorage.get('hanjogo-raffle-test-v1')).length,0);assert.equal(JSON.stringify(context.state.raffleCenter.history),initialHistory);
  // 실제 추첨: 명단을 못 읽으면 서버에 요청하지 않음.
  const before=rpcCalls.length;
  fail=true;node('rafflePrizeName').value='테스트 경품';await handlers.get('raffleDrawBtn:click')();assert.equal(rpcCalls.length,before);fail=false;
  // 경품명이 없으면 요청하지 않음.
  node('rafflePrizeName').value='';await handlers.get('raffleDrawBtn:click')();assert.equal(rpcCalls.length,before);
  // 두 번 연달아 눌러도 서버 요청은 한 번.
  node('rafflePrizeName').value='테스트 경품';
  await Promise.all([handlers.get('raffleDrawBtn:click')(),handlers.get('raffleDrawBtn:click')()]);
  const draws=rpcCalls.slice(before);assert.equal(draws.length,1);assert.equal(draws[0].args.p_test,false);assert.equal(draws[0].args.p_prize,'테스트 경품');
  assert.equal(writes,0);
  assert(context.state.raffleCenter.winnerKeys.includes(R.key(context.state.raffleCenter.live.winner)));
  const liveRoster=R.roster(current,operating);
  console.log('PASS: dedup/cancellation, roles, ticket counts, story dedup, permanent cross-pool exclusion, exhausted pool stop, script syntax, hidden weight text, server test draw (no writes, test keys passed), read failure stop, empty prize stop, double-click guard.');
  console.log('Roster:',liveRoster.entries.length,'staff:',liveRoster.entries.filter(x=>x.roles.some(r=>r==='준비위원'||r==='운영위원')).length,'unresolved:',liveRoster.skipped.length);
})().catch(e=>{console.error(e);process.exit(1)});
