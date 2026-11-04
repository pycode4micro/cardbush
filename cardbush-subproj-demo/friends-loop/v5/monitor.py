from pathlib import Path
import sqlite3,json,time,subprocess,hashlib,datetime,sys
ROOT=Path(sys.argv[1])
def rows(q,args=()):
 with sqlite3.connect(ROOT/'state.sqlite',timeout=10) as c:
  c.row_factory=sqlite3.Row;return [dict(x) for x in c.execute(q,args)]
def meta(k):return json.loads(rows('SELECT value FROM meta WHERE key=?',(k,))[0]['value'])
def progress(state,**extra):
 x={'stage':state,'wall_time':datetime.datetime.now(datetime.timezone.utc).isoformat(),**extra}
 (ROOT/'test-progress.json').write_text(json.dumps(x,ensure_ascii=False,indent=2));print(json.dumps(x,ensure_ascii=False),flush=True)
try:
 started=time.time();previous=None;idle_start=None;idle_calls=None;idle_samples=[]
 while time.time()-started<1000:
  if not (ROOT/'heartbeat.json').exists():
   time.sleep(.5);continue
  hb=json.loads((ROOT/'heartbeat.json').read_text())
  reports=rows('SELECT * FROM reports ORDER BY created')
  running=rows("SELECT * FROM wakes WHERE status='running'")
  pending=rows("SELECT * FROM signals WHERE state='pending'")
  stage='delivering' if running else 'waiting_for_clock'
  if stage!=previous:progress(stage,model_requests=hb['model_requests'],reports=len(reports));previous=stage
  if not running and not pending and not reports:
   if idle_start is None:idle_start=time.time();idle_calls=hb['model_requests']
   idle_samples.append({'at':time.time(),'requests':hb['model_requests']})
  if reports and not running and not pending:break
  if rows("SELECT id FROM signals WHERE state='blocked'"):raise RuntimeError('BLOCKED_SIGNAL')
  if hb['phase']=='budget_paused':raise RuntimeError('MODEL_BUDGET_REACHED')
  time.sleep(1)
 else:raise TimeoutError('NO_FINAL_REPORT_WITHIN_SHORT_WINDOW')
 progress('first_reply_received',final_reply=reports[0]['final_text'])
 calls_before=rows('SELECT count(*) n FROM requests')[0]['n']
 time.sleep(30)
 calls_after=rows('SELECT count(*) n FROM requests')[0]['n']
 signals=rows('SELECT * FROM signals ORDER BY created')
 timers=[s for s in signals if s['kind']=='clock.reached']
 events=rows('SELECT * FROM events ORDER BY created')
 effects=rows('SELECT * FROM effects ORDER BY id')
 artifacts=rows('SELECT * FROM artifacts')
 target_ms=int(datetime.datetime.fromisoformat(json.loads(timers[0]['data'])['scheduled_at'].replace('Z','+00:00')).timestamp()*1000) if timers else None
 checks={
 'wall_clock':meta('clock')['mode']=='wall',
 'only_preset_habit':len(meta('preset_habits'))==1,
 'agent_created_events':bool(events) and all(e['created_by'].startswith('wake_') for e in events),
 'agent_registered_detector':any(x['name']=='detection_register' and json.loads(x['output']).get('status')=='registered' for x in effects),
 'agent_searched_sources':any(x['name']=='web_search' and json.loads(x['output']).get('status')=='ok' for x in effects),
 'agent_read_public_sources':any(x['name']=='web_read' and json.loads(x['output']).get('status')=='ok' for x in effects),
 'real_clock_fired':bool(timers),
 'trigger_within_two_seconds':bool(timers) and 0<=timers[0]['created']-target_ms<=2000,
 'no_early_report':bool(timers) and all(r['created']>=target_ms for r in reports),
 'actual_terminal_completed':all(rows('SELECT status FROM wakes WHERE id=?',(r['wake'],))[0]['status']=='completed' and bool(r['final_text'].strip()) for r in reports),
 'artifact_receipts_match':bool(artifacts) and all(hashlib.sha256(Path(a['path']).read_bytes()).hexdigest()==a['sha256'] for a in artifacts),
 'zero_user_signals':not any(s['origin'] in ['user','fixture_user'] for s in signals),
 'zero_user_role_messages':meta('user_model_message_count')==0,
 'idle_before_trigger_no_model_calls':len(idle_samples)>=30 and len(set(x['requests'] for x in idle_samples))==1,
 'no_duplicate_delivery':len(rows('SELECT * FROM reports'))==1,
 'idle_after_report_no_model_calls':calls_before==calls_after
 }
 result={'passed':all(checks.values()),'checks':checks,'final_reports':reports,'trigger_latency_ms':timers[0]['created']-target_ms if timers else None,'model_calls':calls_after,'idle_sample_seconds':len(idle_samples),'semantic_review':'pending_manual_source_review','test_is_real_time':True,'news_is_synthetic':False}
 (ROOT/'test-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
 subprocess.run(['systemctl','stop','friends-loop-demo-v5.service'],check=True,timeout=45)
 progress('stopped_after_short_test',passed=result['passed'],checks=len(checks),model_calls=calls_after)
except Exception as e:
 (ROOT/'test-results.json').write_text(json.dumps({'passed':False,'error':str(e)},ensure_ascii=False,indent=2))
 progress('failed',error=str(e))
 subprocess.run(['systemctl','stop','friends-loop-demo-v5.service'],timeout=45)
 raise
