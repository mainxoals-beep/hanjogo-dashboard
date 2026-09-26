const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
require('../assets/raffle-roster.js');const R=globalThis.HanjogoRaffle;
const sample={participantPayments:[{name:'가나다',generation:'2기',status:'paid'},{name:'가나다',generation:2,status:'paid'},{name:'위원가',generation:3,status:'exempt'},{name:'취소자',generation:4,status:'cancelled'}],committee:[{name:'위원가',gen:3}],donations:[{name:'가나다',generation:2},{name:'후원자',generation:5},{name:'취소자',generation:4}],sponsors:[{name:'브랜드 / 후원자(5기)'},{name:'개인 불명'}],raffleCenter:{storyEntries:[],history:[]}};
const roster=R.roster(sample,[{name:'운영가',generation:6}]);assert.equal(roster.entries.length,4);assert.equal(roster.skipped.length,1);assert.equal(roster.entries.find(x=>x.name==='위원가').weight,1);assert.equal(roster.entries.find(x=>x.name==='후원자').roles.length,2);
const counts={};const pair=[{name:'일반',generation:2,weight:2},{name:'위원',generation:2,weight:1}];for(let ticket=0;ticket<3;ticket++){const name=R.pick(pair,()=>ticket).name;counts[name]=(counts[name]||0)+1;}assert.deepEqual(counts,{일반:2,위원:1});assert.equal(R.pick([],()=>0),null);
sample.raffleCenter.storyEntries=[{name:'위원가',generation:3},{name:'위원가',generation:3}];assert.equal(R.pool(sample,[],'story').length,1);assert.equal(R.pool(sample,[],'story')[0].weight,1);sample.raffleCenter.history=[{winner:{name:'위원가',generation:3}}];assert.equal(R.pool(sample,[],'story',true).length,0);
// People receive tickets directly: larger generations do not lose individual tickets.
const uneven=[{name:'소수',generation:2,weight:2},...Array.from({length:10},(_,i)=>({name:'다수'+i,generation:3,weight:2}))];
const generationTickets={};for(let ticket=0;ticket<22;ticket++){const p=R.pick(uneven,n=>{assert.equal(n,22);return ticket;});generationTickets[p.generation]=(generationTickets[p.generation]||0)+1;}
assert.deepEqual(generationTickets,{2:2,3:20});
// Permanent exclusion survives history deletion and JSON save/reload, across pools.
const won={history:[{winner:{name:'위원가',generation:3}}],live:{},storyEntries:sample.raffleCenter.storyEntries};won.winnerKeys=R.winnerKeys(won);won.history=[];
const restored=JSON.parse(JSON.stringify({...sample,raffleCenter:won}));assert.equal(R.pool(restored,[],'story',false).length,0);assert(!R.pool(restored,[],'confirmed',false).some(p=>p.name==='위원가'));
// Same-generation peers are blocked across all pools, even after deleting display history.
restored.participantPayments.push({name:'같은기수',generation:3,status:'paid'});restored.raffleCenter.storyEntries.push({name:'같은기수',generation:3});
assert(!R.pool(restored,[],'confirmed').some(p=>p.generation===3));assert.equal(R.pool(restored,[],'story').length,0);
const allGenerations=R.roster(restored,[]).entries.map(p=>R.key(p));restored.raffleCenter.winnerKeys=allGenerations;
assert.equal(R.pool(restored,[],'confirmed').length,0);assert.equal(R.pick(R.pool(restored,[],'confirmed'),()=>{throw Error('must not draw');}),null);
const html=fs.readFileSync('index.html','utf8');for(const file of ['index.html','schedule.html'])for(const m of fs.readFileSync(file,'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))if(m[1].trim())new vm.Script(m[1]);
assert(!html.includes('가중치'));assert(!html.includes('raffleExcludeWinners'));assert(!fs.readFileSync('schedule.html','utf8').includes('가중치'));
const opHtml=html.slice(html.indexOf('id="body-operations-committee"'),html.indexOf('</section>',html.indexOf('id="body-operations-committee"')));
const operating=[...opHtml.matchAll(/class="member-card"><div[^>]*>([^<]+)<\/div><div[^>]*>(\d+)기/g)].map(m=>({name:m[1],generation:Number(m[2])}));assert.equal(operating.length,8);
const current=process.argv[2]?JSON.parse(fs.readFileSync(process.argv[2],'utf8')):structuredClone(sample);current.raffleCenter ||= {history:[],storyEntries:[],live:{status:'idle'}};
current.raffleCenter.live ||= {status:'idle'};
const initialHistory=JSON.stringify(current.raffleCenter.history||[]),initialLive=JSON.stringify(current.raffleCenter.live||{});
let writes=0,fail=false;const nodes=new Map(),handlers=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:true,textContent:'',innerHTML:'',focus(){},querySelectorAll:()=>[],addEventListener:(e,f)=>handlers.set(id+':'+e,f)});return nodes.get(id);};
const context=vm.createContext({state:structuredClone({...current,editMode:true}),DEFAULT_RAFFLE_CENTER:{history:[],storyEntries:[],live:{status:'idle'}},HanjogoRaffle:R,crypto:require('node:crypto').webcrypto,document:{getElementById:node,querySelectorAll:()=>operating.map(x=>({children:[{textContent:x.name},{textContent:x.generation+'기'}]}))},escapeHtml:x=>String(x??''),applyEditLock(){},uid:()=>String(Math.random()),setTimeout(){},DASHBOARD_TABLE:'dashboard_state',DASHBOARD_ID:'main',dSet:async()=>{writes++},sb:{from:()=>({select:()=>({eq:()=>({single:async()=>fail?{error:Error('offline')}:{data:structuredClone(current)}})})})}});
vm.runInContext(html.slice(html.indexOf('function raffleGeneration('),html.indexOf('document.getElementById("raffleResetDisplayBtn")')),context);
(async()=>{node('rafflePoolSelect').value='confirmed';await handlers.get('raffleTestBtn:click')();assert.equal(writes,0);assert.equal(JSON.stringify(context.state.raffleCenter.history),initialHistory);assert.equal(JSON.stringify(context.state.raffleCenter.live||{}),initialLive);assert(node('raffleTestResult').textContent.includes('[테스트 결과]'));
fail=true;await handlers.get('raffleDrawBtn:click')();assert.equal(writes,0);fail=false;node('rafflePrizeName').value='테스트 경품';await Promise.all([handlers.get('raffleDrawBtn:click')(),handlers.get('raffleDrawBtn:click')()]);assert.equal(writes,1);assert(context.state.raffleCenter.winnerKeys.includes(R.key(context.state.raffleCenter.live.winner)));
const liveRoster=R.roster(current,operating);console.log('PASS: dedup/cancellation, exact 2:1 odds, staff story odds, permanent cross-pool exclusion, person tickets, permanent generation exclusion, exhausted pool stop, hidden weight text, test zero writes, read failure stop, double-click guard, script syntax.');console.log('Roster:',liveRoster.entries.length,'staff:',liveRoster.entries.filter(x=>x.weight===1).length,'unresolved:',liveRoster.skipped.length);
})().catch(e=>{console.error(e);process.exit(1)});
