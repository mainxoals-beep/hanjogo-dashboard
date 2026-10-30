// 모임 결산·만족도 조사 계산 함수(문항 검사, 답 검사, 집계, 참가자 이메일 맞추기) 시험
const assert=require('node:assert/strict');
(async()=>{
const m=await import('../supabase/functions/hanjogo-event/event-survey.ts');
const Q=[{id:'overall',label:'전체 만족도',type:'rating',required:true},{id:'food',label:'식사',type:'rating',required:false},{id:'again',label:'다음 참석',type:'choice',required:true,options:['예','아니오','미정']},{id:'good',label:'좋았던 점',type:'text'}];
// 문항 검사
const q=m.cleanSurveyQuestions(Q);assert.equal(q.length,4);assert.equal(q[3].required,false);
assert.equal(m.cleanSurveyQuestions([{id:'A B',label:'x',type:'rating'}]),null,'잘못된 id');
assert.equal(m.cleanSurveyQuestions([{id:'a',label:'x',type:'rating'},{id:'a',label:'y',type:'rating'}]),null,'중복 id');
assert.equal(m.cleanSurveyQuestions([{id:'a',label:'x',type:'choice',options:['하나']}]),null,'선택지 부족');
assert.equal(m.cleanSurveyQuestions([{id:'a',label:'x',type:'star'}]),null,'알 수 없는 종류');
assert.equal(m.cleanSurveyQuestions('x'),null);assert.deepEqual(m.cleanSurveyQuestions([]),[]);
// 답 검사
let r=m.cleanSurveyAnswers(q,{overall:5,food:'4',again:'예',good:'  좋았어요  ',extra:'버려짐'});
assert.deepEqual(r.answers,{overall:5,food:4,again:'예',good:'좋았어요'});
assert.match(m.cleanSurveyAnswers(q,{food:3,again:'예'}).error,/answer_required:overall/);
assert.match(m.cleanSurveyAnswers(q,{overall:6,again:'예'}).error,/invalid_answer:overall/);
assert.match(m.cleanSurveyAnswers(q,{overall:3,again:'모름'}).error,/invalid_answer:again/);
assert.deepEqual(m.cleanSurveyAnswers(q,{overall:3,again:'미정',good:'   '}).answers,{overall:3,again:'미정'});
assert.equal(m.cleanSurveyAnswers(q,{overall:3,again:'예',good:'가'.repeat(2000)}).answers.good.length,1000);
// 집계
const rows=[{overall:5,food:4,again:'예'},{overall:4,again:'예'},{overall:3,food:2,again:'아니오'}].map(a=>({answers:a}));
const s=m.summarizeSurvey(q,rows);
assert.equal(s.responseCount,3);assert.equal(s.ratings[0].average,4);assert.equal(s.ratings[1].average,3);
assert.deepEqual(s.choices[0].counts,{'예':2,'아니오':1,'미정':0});assert.equal(s.overall,3.6);
assert.equal(m.summarizeSurvey(q,[]).overall,null);
// 참가자 이메일 맞추기
const people=[{name:'김철수',generation:4,email:'a@x.com'},{name:'이영희',generation:7,email:'b@x.com'},{name:'박민수',generation:7,email:'c@x.com'},{name:'박민수',generation:7,email:'d@x.com'}];
const res=m.matchParticipants([{name:'김철수',generation:'4기'},{name:'김철수 ',generation:4},{name:'이영희',generation:7},{name:'박민수',generation:7},{name:'최없음',generation:3},{name:'김철수',generation:5},{name:'',generation:1}],people);
assert.deepEqual(res.matched.map(p=>p.email),['a@x.com','b@x.com'],'같은 사람 중복·빈 이름 제외');
assert.deepEqual(res.ambiguous,[{name:'박민수',generation:7,count:2}]);
assert.deepEqual(res.unmatched,[{name:'최없음',generation:3,otherGenerations:[]},{name:'김철수',generation:5,otherGenerations:[4]}],'기수만 다른 동명이인 힌트');
// 복수 선택 문항과 기수별 평균
const M=m.cleanSurveyQuestions([{id:'overall',label:'전체',type:'rating',required:true},{id:'when',label:'시기',type:'multi',options:['상반기','하반기','연말','평일 저녁'],required:false}]);
assert.equal(M[1].type,'multi');
assert.deepEqual(m.cleanSurveyAnswers(M,{overall:4,when:['연말','상반기','연말']}).answers,{overall:4,when:['상반기','연말']},'선택지 순서대로 정리·중복 제거');
assert.match(m.cleanSurveyAnswers(M,{overall:4,when:['없는선택']}).error,/invalid_answer:when/);
assert.deepEqual(m.cleanSurveyAnswers(M,{overall:4,when:[]}).answers,{overall:4});
const ms=m.summarizeSurvey(M,[{answers:{overall:4,when:['상반기','연말']}},{answers:{overall:5,when:['연말']}}]);
assert.deepEqual(ms.choices[0].counts,{'상반기':1,'하반기':0,'연말':2,'평일 저녁':0});assert.equal(ms.choices[0].multi,true);
const g=m.summarizeByGeneration(M,[{generation:4,answers:{overall:5}},{generation:4,answers:{overall:3}},{generation:4,answers:{overall:4}},{generation:9,answers:{overall:1}},{generation:9,answers:{overall:2}},{generation:null,answers:{overall:5}}]);
assert.deepEqual(g,[{generation:4,responseCount:3,average:4}],'3명 미만 기수와 기수 없는 응답은 제외');
const sp=m.matchParticipants([{name:'박 정희',generation:2},{name:'유수현(임수현)',generation:'11'}],[{name:'박정희',generation:2,email:'p@x.com'},{name:'유수현',generation:11,email:'y@x.com'}]);
assert.deepEqual(sp.matched.map(p=>p.email),['p@x.com','y@x.com'],'이름 중간 공백·괄호 별칭 처리');
console.log('event-survey tests ok');
})().catch(e=>{console.error(e);process.exit(1);});
