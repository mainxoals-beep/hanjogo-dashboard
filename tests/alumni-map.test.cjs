const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('alumni-map.html','utf8'),code=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
function harness(result){const elements=new Map(),queries=[];function el(id){if(!elements.has(id))elements.set(id,{dataset:{},value:'',textContent:'',innerHTML:'',hidden:false,disabled:false,classList:{remove(){},toggle(){}},setAttribute(name,value){this.dataset[name]=String(value)},close(){},showModal(){},addEventListener(){},scrollIntoView(){},reportValidity(){return true}});return elements.get(id)}const sb={auth:{onAuthStateChange(){},getSession:async()=>({data:{session:null}})},from(table){queries.push(table);const q={select(){return q},eq(){return q},order:async()=>result};return q;}};for(const id of ['regionFilter','categoryFilter','generationFilter','addressFilter']){el(id).value='all';el(id).options=[{textContent:'전체'}];el(id).selectedIndex=0;}const context=vm.createContext({window:{supabase:{createClient:()=>sb}},document:{getElementById:el,querySelectorAll:()=>[]},URL,location:{origin:'https://example.com',pathname:'/alumni-map.html'},console:{error(){}},alert(){},confirm:()=>false,localStorage:{store:new Map(),getItem(k){return this.store.has(k)?this.store.get(k):null},setItem(k,v){this.store.set(k,String(v))}}});vm.runInContext(code,context);return{context,elements,queries,el};}
test('uses existing published places schema and restores all rows',async()=>{const rows=Array.from({length:30},(_,i)=>({id:i+1,name:'업장 '+i,owner_generation:'2기',region:'서울'}));const h=harness({data:rows,error:null});await new Promise(setImmediate);assert.deepEqual(h.queries,['hanjogo_alumni_places']);assert.equal((h.el('grid').innerHTML.match(/<article /g)||[]).length,30);assert.ok(!h.el('grid').innerHTML.includes('2기기'));h.el('q').value='업장 29';vm.runInContext('draw()',h.context);assert.equal((h.el('grid').innerHTML.match(/<article /g)||[]).length,1);});
test('API error stays visible instead of appearing as an empty list',async()=>{const h=harness({data:null,error:new Error('missing relation')});await new Promise(setImmediate);assert.equal(h.el('retryBtn').hidden,false);assert.match(h.el('loadStatus').textContent,/불러오지 못/);});
test('unsafe links are rejected and owner matching requires confirmed email',()=>{const h=harness({data:[],error:null});assert.equal(vm.runInContext("safeUrl('javascript:alert(1)')",h.context),'');assert.equal(vm.runInContext("safeUrl('https://instagram.com/test')",h.context),'https://instagram.com/test');// 담당 업장 목록은 서버(place_mine)가 알려줍니다. 공개 조회에는 담당자 이메일이 없습니다.
assert.equal(vm.runInContext("myPlaceIds=new Set([7]);session={user:{email:'owner@example.com'}};mine({id:7})",h.context),false,'이메일 인증 전에는 수정 권한이 없어야 합니다');
assert.equal(vm.runInContext("session={user:{email:'owner@example.com',email_confirmed_at:'2026-10-05'}};mine({id:7})",h.context),true);
assert.equal(vm.runInContext("mine({id:8})",h.context),false,'담당하지 않는 업장은 수정할 수 없어야 합니다');});

test('combines region, category, cohort, address and multiword search; reset restores rows',async()=>{const rows=[{id:1,name:'렁팡스',owner_name:'김태민',owner_generation:'2기',region:'서울',category:'레스토랑',is_address_verified:true},{id:2,name:'카페 하나',owner_name:'김하나',owner_generation:'2기',region:'서울',category:'카페·디저트',is_address_verified:false},{id:3,name:'미확인 업장',category:'기타'}];const h=harness({data:rows,error:null});await new Promise(setImmediate);h.el('q').value='김태민 2기';h.el('regionFilter').value='서울';h.el('categoryFilter').value='restaurant';h.el('generationFilter').value='2';h.el('addressFilter').value='verified';assert.equal(vm.runInContext('filtered().length',h.context),1);h.el('addressFilter').value='pending';assert.equal(vm.runInContext('filtered().length',h.context),0);vm.runInContext('resetFilters()',h.context);assert.equal(vm.runInContext('filtered().length',h.context),3);h.el('regionFilter').value='unknown';assert.equal(vm.runInContext('filtered()[0].id',h.context),3);});
test('mixed categories match each relevant group',()=>{const h=harness({data:[],error:null});assert.equal(vm.runInContext("categoryMatches({category:'카페·디저트'},'cafe') && categoryMatches({category:'카페·디저트'},'bakery')",h.context),true);});

// 즐겨찾기: 브라우저에 계정별로 저장하고, 목록을 즐겨찾기만으로 좁힐 수 있어야 합니다.
test('favorites persist per account, filter the list and survive a missing localStorage',async()=>{
  const rows=[{id:1,name:'렁팡스',owner_name:'김태민',owner_generation:'2기',region:'서울'},
              {id:2,name:'쥬네스',owner_name:'손혜지',owner_generation:'7기',region:'서울'}];
  const h=harness({data:rows,error:null});
  await new Promise(setImmediate);
  const run=expr=>vm.runInContext(expr,h.context);

  // 처음에는 비어 있고, 전체가 보입니다.
  assert.equal(run('favoriteIds.size'),0);
  assert.equal(run('filtered().length'),2);

  // 별을 누르면 저장되고, 다시 누르면 해제됩니다.
  run('toggleFavorite(2)');
  assert.deepEqual([...run('favoriteIds')],['2']);
  assert.equal(run("isFavorite({id:2})"),true);
  assert.equal(run("isFavorite({id:1})"),false);

  // 즐겨찾기만 보기.
  run('favoritesOnly=true');
  assert.deepEqual(run('filtered().map(p=>p.name)'),['쥬네스']);
  run('filterSummary()');
  assert.equal(h.el('favoritesBtn').textContent,'★ 즐겨찾기 1');
  assert(h.el('filterSummary').textContent.includes('즐겨찾기만'));

  // 필터 초기화는 즐겨찾기 보기도 함께 끕니다(즐겨찾기 자체는 지우지 않습니다).
  run('resetFilters()');
  assert.equal(run('favoritesOnly'),false);
  assert.equal(run('favoriteIds.size'),1,'필터를 초기화해도 즐겨찾기는 남아야 합니다');
  assert.equal(run('filtered().length'),2);

  // 저장은 계정별로 나뉩니다.
  assert.equal(run('favoritesKey()'),'hanjogo_place_favorites:guest');
  run("session={user:{email:'A@Example.com'}}");
  assert.equal(run('favoritesKey()'),'hanjogo_place_favorites:a@example.com');
  run('loadFavorites()');
  assert.equal(run('favoriteIds.size'),0,'다른 계정의 즐겨찾기가 보이면 안 됩니다');
  run("session=null;loadFavorites()");
  assert.deepEqual([...run('favoriteIds')],['2'],'원래 계정으로 돌아오면 다시 보여야 합니다');

  // 비공개 모드처럼 저장이 막혀도 화면은 동작해야 합니다.
  run("localStorage.setItem=()=>{throw new Error('blocked')};localStorage.getItem=()=>{throw new Error('blocked')}");
  run('toggleFavorite(1)');
  assert.equal(run('favoriteIds.has("1")'),true);
  run('loadFavorites()');
  assert.equal(run('favoriteIds.size'),0);
});

// 운영자 상태(표시)와 인증 신청(버튼)은 서로 구분되어야 합니다.
// 둘 다 "운영자 인증"으로 보이면, 보는 사람이 인증된 건지 신청하는 건지 알 수 없습니다.
test('owner status reads as a state, and only an unclaimed place offers the request button',async()=>{
  const rows=[{id:1,name:'내 가게',owner_name:'김태민',owner_generation:'2기',region:'서울',owner_linked:true},
              {id:2,name:'남의 가게',owner_name:'손혜지',owner_generation:'7기',region:'서울',owner_linked:true},
              {id:3,name:'주인 없는 가게',owner_name:'이서현',owner_generation:'19기',region:'경기',owner_linked:false}];
  const h=harness({data:rows,error:null});
  await new Promise(setImmediate);
  const run=expr=>vm.runInContext(expr,h.context);
  run("myPlaceIds=new Set([1]);session={user:{email:'me@example.com',email_confirmed_at:'2026-10-05'}};draw()");
  const html=h.el('grid').innerHTML;
  const card=name=>html.split('<article').find(part=>part.includes(name))||'';

  // 내 업장: 상태 표시 + 수정 버튼
  assert(card('내 가게').includes('내 업장</span>'),'내 업장임을 표시해야 합니다');
  assert(card('내 가게').includes('data-action="edit"'));

  // 남의 업장이 이미 인증된 경우: 표시만 있고 신청 버튼은 없어야 합니다.
  assert(card('남의 가게').includes('운영자 확인됨'),'인증된 업장은 상태를 표시해야 합니다');
  assert(!card('남의 가게').includes('data-action="claim"'),'이미 인증된 업장에 신청 버튼을 두면 눌러도 오류만 납니다');

  // 주인 없는 업장: 상태 표시 없이 신청 버튼만.
  assert(!card('주인 없는 가게').includes('owner-tag'),'미연결 업장에 인증 표시가 있으면 안 됩니다');
  assert(card('주인 없는 가게').includes('data-action="claim"'));
  assert(card('주인 없는 가게').includes('요청'),'버튼 문구에 요청임이 드러나야 합니다');

  // 상태 표시는 버튼이 아니어야 합니다.
  assert(!/<button[^>]*class="[^"]*owner-tag/.test(html),'상태 표시가 버튼이면 다시 헷갈립니다');
});

// 이메일 연락: 서버가 알려준(연락을 허용한) 업장에만 버튼이 나오고, 내 업장에는 나오지 않습니다.
test('email contact button only for owners who allowed contact, never on my own place',async()=>{
  const rows=[{id:1,name:'내 가게',owner_name:'김태민',owner_generation:'2기',region:'서울',owner_linked:true},
              {id:2,name:'연락 허용 가게',owner_name:'손혜지',owner_generation:'7기',region:'서울',owner_linked:true},
              {id:3,name:'연락 비허용 가게',owner_name:'이서현',owner_generation:'19기',region:'경기',owner_linked:true}];
  const h=harness({data:rows,error:null});
  await new Promise(setImmediate);
  const run=expr=>vm.runInContext(expr,h.context);
  // 로그인 전에는 아무 업장에도 연락 버튼이 없습니다.
  assert(!h.el('grid').innerHTML.includes('이메일로 연락'));
  run("myPlaceIds=new Set([1]);session={user:{email:'me@example.com',email_confirmed_at:'2026-10-05'}};placeContacts=new Map([['1','me@example.com'],['2','owner@example.com']]);contactMe={name:'김태민',generation:2};draw()");
  const html=h.el('grid').innerHTML;
  const card=name=>html.split('<article').find(part=>part.includes(name))||'';
  assert(card('연락 허용 가게').includes('이메일로 연락'));
  assert(card('연락 허용 가게').includes('mailto:owner@example.com?subject='));
  assert(!card('연락 비허용 가게').includes('이메일로 연락'),'허용하지 않은 업장에는 버튼이 없어야 합니다');
  assert(!card('내 가게').includes('이메일로 연락'),'내 업장에는 연락 버튼이 없어야 합니다');
  const href=run("contactHref(places[1])");
  assert(decodeURIComponent(href).includes('7기 손혜지 동문님 안녕하세요.'));
  assert(decodeURIComponent(href).includes('저는 2기 김태민입니다.'));
});
