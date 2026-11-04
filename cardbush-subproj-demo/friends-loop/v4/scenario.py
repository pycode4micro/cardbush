from pathlib import Path
import sqlite3,json,time,subprocess,traceback,hashlib
BASE=Path('/opt/friends-loop-demo-20261104/v4')
RUN=BASE/'runs/nba-01'
checks=[]
def db():
 c=sqlite3.connect(RUN/'state.sqlite',timeout=10);c.row_factory=sqlite3.Row;return c
def rows(sql,args=()):
 with db() as c:return [dict(r) for r in c.execute(sql,args)]
def progress(stage,**extra):
 data={'stage':stage,'wall_at':time.time(),**extra}
 (RUN/'test-progress.json').write_text(json.dumps(data,ensure_ascii=False,indent=2))
 print(json.dumps(data,ensure_ascii=False),flush=True)
def check(name,value,details=None):
 checks.append({'name':name,'passed':bool(value),'details':details})
 if not value:raise AssertionError(name+': '+str(details))
def count(table):return rows('SELECT count(*) n FROM '+table)[0]['n']
def atomic(path,text):
 temp=path.with_suffix(path.suffix+'.tmp');temp.write_text(text);temp.replace(path)
def clock(iso):
 atomic(RUN/'clock.json',json.dumps({'now':iso}))
 progress('clock_advanced',virtual_at=iso)
def settle(timeout=340):
 end=time.time()+timeout;stable=None
 while time.time()<end:
  if rows("SELECT id FROM signals WHERE state='blocked'"):raise RuntimeError('BLOCKED_SIGNAL')
  hb=json.loads((RUN/'heartbeat.json').read_text()) if (RUN/'heartbeat.json').exists() else {}
  running=rows("SELECT id FROM wakes WHERE status='running'")
  pending=rows("SELECT id FROM signals WHERE state='pending'")
  if hb.get('phase')=='budget_paused':raise RuntimeError('BUDGET_PAUSED')
  if not running and not pending and hb.get('phase')=='watching':
   if stable is None:stable=time.time()
   if time.time()-stable>=3:return
  else:stable=None
  time.sleep(.5)
 raise TimeoutError('activation did not settle')
def wait_reports(n,timeout=340):
 end=time.time()+timeout
 while time.time()<end:
  if count('reports')>=n:settle();return
  if rows("SELECT id FROM signals WHERE state='blocked'"):raise RuntimeError('BLOCKED_SIGNAL')
  time.sleep(1)
 raise TimeoutError('no terminal reply')
def restart():
 oldpid=int((RUN/'daemon.lock').read_text())
 r=subprocess.run(['node',str(BASE/'main.mjs'),'stop',str(RUN)],capture_output=True,text=True,timeout=10)
 if r.returncode:raise RuntimeError(r.stderr)
 end=time.time()+20
 while (RUN/'daemon.lock').exists() and time.time()<end:time.sleep(.2)
 if (RUN/'daemon.lock').exists():raise RuntimeError('STOP_TIMEOUT')
 log=open(RUN/'daemon.log','ab',buffering=0)
 p=subprocess.Popen(['nice','-n','10','node',str(BASE/'main.mjs'),'serve',str(RUN)],cwd=BASE,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 time.sleep(2);settle()
 return oldpid,p.pid
def data(name,text):atomic(RUN/'inbox'/name,text)
try:
 progress('waiting_for_autonomous_bootstrap')
 settle()
 events=rows('SELECT * FROM events')
 registrations=rows('SELECT * FROM registrations WHERE active=1')
 check('habit_created_event_without_user_message',len(events)>=1 and all(e['created_by'].startswith('wake_') for e in events))
 check('agent_registered_time_and_directory_detectors',{'at_time','directory_change'} <= {r['kind'] for r in registrations})
 check('event_respects_habit_time',any(e['not_before']=='2026-11-04T09:00:00.000Z' for e in events),events)
 check('no_premature_report_at_bootstrap',count('reports')==0)
 initial_calls=count('requests')
 progress('bootstrap_verified',events=len(events),registrations=len(registrations),model_calls=initial_calls)
 clock('2026-11-04T16:56:00+08:00')
 data('2026-11-04-basketball.md','# NBA 合成测试资料 A\n日期：2026-11-04\n来源：测试通讯社 A（人工合成资料，不是真实新闻）\n主题：NBA\n赛事演示记录：勇士对湖人，初步记录的比分为 112:108。该比分为初报。\n')
 data('2026-11-04-other.md','# 天气合成资料\n日期：2026-11-04\n来源：测试气象台\n主题：天气\n明日演示城市有小雨。\n')
 time.sleep(5);settle()
 check('source_files_detected_without_user_input',len(rows("SELECT * FROM observations WHERE source='inbox'"))>=2)
 check('no_early_report_with_documents',count('reports')==0)
 ids_before=[r['id'] for r in rows('SELECT * FROM registrations WHERE active=1')]
 calls_before_restart=count('requests')
 old,new=restart()
 check('restart_keeps_registered_conditions',ids_before==[r['id'] for r in rows('SELECT * FROM registrations WHERE active=1')],{'old_pid':old,'new_pid':new})
 check('idle_restart_does_not_call_model',calls_before_restart==count('requests'))
 progress('restart_verified')
 clock('2026-11-04T16:59:00+08:00')
 data('2026-11-04-correction.md','# NBA 合成测试资料 B：比分更正\n日期：2026-11-04\n来源：测试通讯社 B（人工合成资料，不是真实新闻）\n主题：NBA\n关于资料 A 同一场勇士对湖人的演示比赛，最终核对比分为 112:110，勇士获胜。此前的 112:108 为录入错误；本条是该比赛的更正记录。\n')
 time.sleep(4);settle()
 check('no_early_report_one_minute_before',count('reports')==0)
 clock('2026-11-04T17:00:00+08:00')
 wait_reports(1)
 first=rows('SELECT * FROM reports ORDER BY created')[0]
 artifacts=rows('SELECT * FROM artifacts')
 first_text=first['final_text']
 check('clock_detector_woke_loop',bool(rows("SELECT id FROM signals WHERE kind='clock.reached'")))
 check('directory_change_woke_loop',bool(rows("SELECT id FROM signals WHERE kind='directory.changed'")))
 check('first_actual_terminal_reply',bool(first_text.strip()) and rows('SELECT status FROM wakes WHERE id=?',(first['wake'],))[0]['status']=='completed')
 check('first_reply_uses_corrected_score',('112' in first_text and '110' in first_text),first_text)
 check('unrelated_weather_not_reported',all(x not in first_text for x in ['小雨','测试气象台']))
 check('synthetic_fixture_disclosed',any(x in first_text for x in ['合成','测试','演示','虚构']),first_text)
 check('real_artifact_matches_receipt',all(hashlib.sha256(Path(a['path']).read_bytes()).hexdigest()==a['sha256'] for a in artifacts))
 future=rows("SELECT * FROM events WHERE state IN ('waiting','planned','active') AND not_before>?",('2026-11-04T09:00:00.000Z',))
 check('agent_prepared_next_occurrence',bool(future),future)
 progress('day_one_passed',final_reply=first_text,next_events=len(future))
 before=count('requests')
 # Touch identical contents; there must be no duplicate work or reply.
 for path in (RUN/'inbox').glob('*.md'):data(path.name,path.read_text())
 time.sleep(25);settle()
 check('unchanged_directory_uses_no_model_calls',count('requests')==before,{'before':before,'after':count('requests')})
 check('no_duplicate_final_reply',count('reports')==1)
 # A second daily occurrence verifies continuation, rather than only the bootstrap.
 clock('2026-11-05T16:59:00+08:00')
 data('2026-11-05-basketball.md','# NBA 合成测试资料 C\n日期：2026-11-05\n来源：测试通讯社 C（人工合成资料，不是真实新闻）\n主题：NBA\n新的演示比赛：凯尔特人对雄鹿，最终比分 105:101，凯尔特人获胜。\n')
 time.sleep(4);settle()
 check('second_occurrence_not_reported_early',count('reports')==1)
 clock('2026-11-05T17:00:00+08:00')
 wait_reports(2)
 second=rows('SELECT * FROM reports ORDER BY created')[1]
 check('second_day_new_result',('105' in second['final_text'] and '101' in second['final_text']),second['final_text'])
 check('second_day_does_not_repeat_previous_news','112' not in second['final_text'],second['final_text'])
 check('all_events_model_created',all(e['created_by'].startswith('wake_') for e in rows('SELECT * FROM events')))
 check('zero_user_signals',not rows("SELECT id FROM signals WHERE origin IN ('user','fixture_user')"))
 messages=rows("SELECT value FROM meta WHERE key='user_model_message_count'")
 check('zero_user_role_model_messages',int(json.loads(messages[0]['value']))==0)
 check('continued_future_registration',bool(rows("SELECT id FROM registrations WHERE active=1 AND kind='at_time'")))
 progress('day_two_passed',final_reply=second['final_text'])
 before=count('requests');time.sleep(15);settle()
 check('idle_after_second_result_no_model_calls',before==count('requests'))
 result={'passed':all(c['passed'] for c in checks),'checks':checks,'reports':rows('SELECT * FROM reports ORDER BY created'),'calls':count('requests'),'user_signals':0,'fixture':True,'accelerated_clock':True}
 (RUN/'test-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
 progress('completed',passed=result['passed'],checks=len(checks),calls=result['calls'])
except Exception as e:
 result={'passed':False,'checks':checks,'error':str(e),'traceback':traceback.format_exc()}
 (RUN/'test-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
 progress('failed',error=str(e))
 raise
