// Local PostgreSQL only. PGLITE_MODULE and RAFFLE_SELECTOR_SQL point at local test dependencies.
// The current private selector is read-only exported for this test; never commit it.
const fs=require('node:fs'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const selector=fs.readFileSync(process.env.RAFFLE_SELECTOR_SQL,'utf8');
const migration=fs.readFileSync('supabase/migrations/20261010120010_raffle_batch_reveal.sql','utf8');
(async()=>{
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema raffle_private;
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
 create table public.dashboard_state(id text primary key,data jsonb,updated_at timestamptz default now());
 create table public.raffle_prize_plan(id text primary key,owner_id uuid,part int,position int,prize text,winners int,units_per_winner int,finale boolean,draw_ids text[] default '{}');
 grant usage on schema raffle_private,auth to authenticated;
 select set_config('test.uid','11111111-1111-4111-8111-111111111111',false);`);
 const payments=Array.from({length:50},(_,i)=>({name:'가상참가자'+i,generation:2+i%24,status:'paid'}));
 const initial={participantPayments:payments,committee:[],donations:[],sponsors:[],raffleCenter:{winnerKeys:[],history:[],live:{status:'idle',drawId:''}}};
 await db.query('insert into dashboard_state(id,data) values ($1,$2)',['main',initial]);
 for(const [id,part,pos,prize,n,unit,last] of [
  ['event-prize-1',1,1,'ticket',2,2,false],['event-prize-2',1,2,'wine-a',3,1,false],['event-prize-3',1,3,'wine-b',1,1,false],
  ['event-prize-4',1,4,'spirit-a',1,1,false],['event-prize-5',2,1,'ticket',3,2,false],['event-prize-6',2,2,'wine-a',2,1,false],
  ['event-prize-7',2,3,'wine-b',1,1,false],['event-prize-8',2,4,'spirit-b',1,1,false],['event-story-pending',2,5,'story',2,1,false],['event-prize-9',2,6,'galaxy',1,1,true]])
  await db.query('insert into raffle_prize_plan(id,owner_id,part,position,prize,winners,units_per_winner,finale) values ($1,auth.uid(),$2,$3,$4,$5,$6,$7)',[id,part,pos,prize,n,unit,last]);
 await db.exec(selector);await db.exec(migration);
 const parts=(await db.query('select part,sum(winners)::int n from raffle_prize_plan group by part order by part')).rows;
 assert.deepEqual(parts,[{part:1,n:9},{part:2,n:8}]);
 const before=JSON.stringify((await db.query('select data from dashboard_state')).rows);
 const test=(await db.query("select public.perform_raffle_batch('event-prize-2','',true,'{}') r")).rows[0].r;
 assert.equal(test.live.winners.length,5);assert.equal(new Set(test.live.winners.map(p=>p.name+'|'+p.generation)).size,5);
 assert.equal(JSON.stringify((await db.query('select data from dashboard_state')).rows),before);
 const result=(await db.query("select public.perform_raffle_batch('event-prize-2','',false,'{}') r")).rows[0].r;
 assert.equal(result.center.history.length,5);assert.equal(result.center.live.winners.length,5);
 assert.equal(result.center.live.revealAt-result.center.live.startedAt,37000);
 assert.equal((await db.query("select cardinality(draw_ids) n from raffle_prize_plan where id='event-prize-2'")).rows[0].n,5);
 const replay=(await db.query("select public.perform_raffle_batch('event-prize-2','',false,'{}') r")).rows[0].r;
 assert.deepEqual(replay,result);
 const id=result.center.live.drawId;
 const paused=(await db.query("select public.control_raffle_batch($1,0,'pause') r",[id])).rows[0].r;
 assert(paused.center.live.batch.paused);
 await assert.rejects(db.query("select public.control_raffle_batch($1,0,'resume')",[id]));
 await assert.rejects(db.query("select public.perform_raffle_batch('event-prize-3',$1,false,'{}')",[id]));
 await db.query("select public.control_raffle_batch($1,1,'next')",[id]);
 await db.query("select public.control_raffle_batch($1,2,'resume')",[id]);
 await db.exec("select set_config('test.uid','22222222-2222-4222-8222-222222222222',false)");
 await assert.rejects(db.query("select public.perform_raffle_batch('event-prize-3','',true,'{}')"));
 await db.exec("select set_config('test.uid','11111111-1111-4111-8111-111111111111',false)");
 // Force exhaustion mid-batch; every earlier selection must roll back.
 const limited={...initial,participantPayments:[],raffleCenter:{...initial.raffleCenter,winnerKeys:[],history:[]}};
 await db.query('update dashboard_state set data=$1',[limited]);
 await db.exec("update raffle_prize_plan set winners=5 where id='event-prize-3'");
 await assert.rejects(db.query("select public.perform_raffle_batch('event-prize-3','',false,'{}')"));
 assert.equal((await db.query('select data from dashboard_state')).rows[0].data.raffleCenter.history.length,0);
 assert.equal((await db.query("select cardinality(draw_ids) n from raffle_prize_plan where id='event-prize-3'")).rows[0].n,0);
 const grants=(await db.query("select has_function_privilege('anon','public.perform_raffle_batch(text,text,boolean,text[])','execute') allowed")).rows[0];
 assert.equal(grants.allowed,false);
 await db.close();console.log('PASS: local PostgreSQL plan merge, selector reuse, atomic history, test isolation, retry, pause/version and authorization');
})().catch(e=>{console.error(e);process.exit(1)});
