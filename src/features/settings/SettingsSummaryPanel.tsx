import { useEffect, useRef, useState } from 'react';
import { normalizeIndividuation, summaryTokenThresholdSchema, type PersonalizationStatus } from '@cardbush/bush-protocol';
import type { AgentConnection } from '../../../electron/agentTypes';
import type { AppLanguage, AppSettingsState } from '../../types';
import { personalizationCommand, type MemoryManagementClient } from '../../backend/personalization';
import { MemoryRecordsPanel } from './MemoryRecordsPanel';
import { SettingsCard, SettingsSelect, SettingsSwitch } from './SettingsControls';
import './summarySettings.css';

export function SettingsSummaryPanel({language,settings,onSettingsChange,modelId='',connections=[],call=personalizationCommand,memoryApi}:{
  language:AppLanguage;settings:AppSettingsState;modelId?:string;connections?:AgentConnection[];
  onSettingsChange:(updater:(current:AppSettingsState)=>AppSettingsState)=>void;call?:typeof personalizationCommand;
  memoryApi?:MemoryManagementClient;
}) {
  const zh=language==='zh',memory=normalizeIndividuation(settings.individuation);
  const [connection,setConnection]=useState(''),[status,setStatus]=useState<PersonalizationStatus>();
  const [threshold,setThreshold]=useState(String(memory.summaryTokenThreshold));
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0),[recordsRefresh,setRecordsRefresh]=useState(0);
  const generation=useRef(0),acting=useRef(false);
  useEffect(()=>{setThreshold(String(memory.summaryTokenThreshold));},[memory.summaryTokenThreshold]);
  useEffect(()=>{
    const version=++generation.current;setStatus(undefined);setError('');
    void call({action:'status',settings:memory},connection).then(value=>{if(version===generation.current)setStatus(value);},()=>{
      if(version===generation.current)setError(zh?'无法读取此环境的记忆状态，请检查连接或更新 Agent。':'Cannot read memory status. Check the connection or update this Agent.');
    });
    return ()=>{generation.current++;};
  },[call,connection,memory.habits,memory.predictions,memory.summaryTokenThreshold,revision,zh]);
  // Poll only an observed running job, never an idle memory database.
  useEffect(()=>{if(!status?.running||busy)return;const timer=setTimeout(()=>setRevision(v=>v+1),2000);return()=>clearTimeout(timer);},[status?.running,busy,revision]);
  const update=(value:Partial<typeof memory>)=>onSettingsChange(current=>({...current,individuation:{...normalizeIndividuation(current.individuation),...value}}));
  function saveThreshold() {
    const parsed=summaryTokenThresholdSchema.safeParse(Number(threshold));
    if(!parsed.success) {setError(zh?'阈值需为 1,000–200,000 之间的整数。':'Use a whole number from 1,000 to 200,000.');return false;}
    setError('');update({summaryTokenThreshold:parsed.data});return true;
  }
  async function summarize() {
    if(acting.current||!saveThreshold())return;
    const version=generation.current;acting.current=true;setBusy(true);setError('');
    try {
      const value=await call({action:'summarize',settings:{...memory,summaryTokenThreshold:Number(threshold)},modelId},connection);
      if(version===generation.current){setStatus(value);setRecordsRefresh(value=>value+1);}
    } catch { if(version===generation.current)setError(zh?'总结未完成，原有记忆已保留。请检查模型与连接后重试。':'Summary did not complete. Original memory was kept. Check the model and connection, then retry.'); }
    finally {acting.current=false;setBusy(false);}
  }
  const enabled=memory.habits||memory.predictions;
  return <div className="settings-stack summary-settings">
    <SettingsCard title="summary_for_user" subtitle={zh?'按需记录简洁的用户偏好与后续需求，在当前运行环境跨对话使用。工具调用由 Agent 自行决定。':'Keep concise preferences and possible follow-ups across conversations on this host. The agent decides when to use the tool.'}>
      <SettingsSwitch title={zh?'记住并参考用户习惯':'Remember and use habits'} checked={memory.habits} onChange={habits=>update({habits})}
        subtitle={zh?'按下方选项提供相关内容或数量提示，Agent 可用 check_habit 补查；关闭后暂停读取与写入。':'Use the recall mode below for relevant excerpts or candidate counts; check_habit can search further. Turning off pauses reads and writes.'}/>
      <SettingsSwitch title={zh?'预测下一步行为':'Predict next actions'} checked={memory.predictions} onChange={predictions=>update({predictions})}
        subtitle={zh?'用后续用户输入复盘预测。已验证的重复需求可归纳为习惯；预测不等于执行授权。':'Review predictions against later user input. Repeated verified needs can become habits; predictions do not authorize actions.'}/>
      <SettingsSelect name="memory-recall-mode" title={zh?'记忆提示方式':'Memory recall mode'} value={memory.recallMode} onChange={value=>update({recallMode:value==='hint'?'hint':'context'})}
        subtitle={zh?'显式检索始终可重复读取；仅自动参考会省略当前上下文里已有的记录。':'Explicit lookup always allows repeat reads. Only automatic references omit records already present in context.'}>
        <option value="context">{zh?'自动提供少量相关内容':'Include a few relevant excerpts'}</option>
        <option value="hint">{zh?'仅提示候选数量，按需读取':'Only hint at candidate counts'}</option>
      </SettingsSelect>
    </SettingsCard>
    <SettingsCard title={zh?'记忆整理':'Memory consolidation'} subtitle={zh?'累计到阈值后在后台整理有效记忆，旧记录保留在历史中；用户固定的条目不被模型改写。Token 数为本地估算。':'Consolidate active memory at the threshold, retaining originals in history. User-pinned records cannot be rewritten by the model. Token counts are local estimates.'}>
      <label className="summary-threshold"><span>{zh?'自动总结阈值（tokens）':'Automatic summary threshold (tokens)'}</span>
        <input aria-label={zh?'自动总结阈值':'Automatic summary threshold'} type="number" min={1000} max={200000} step={1000} value={threshold}
          onChange={event=>setThreshold(event.target.value)} onBlur={saveThreshold} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();saveThreshold();}}}/></label>
      <SettingsSelect name="summary-host" title={zh?'记忆所在环境':'Memory host'} value={connection} onChange={setConnection} disabled={busy}
        subtitle={zh?'各环境独立保存，习惯不会自动复制到其他主机。':'Memory stays on its host and is not copied to other hosts.'}>
        <option value="">{zh?'本机':'This device'}</option>{connections.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
      </SettingsSelect>
      <div className="summary-memory-status" aria-live="polite">
        {status?<><strong>{status.estimatedTokens.toLocaleString()} / {memory.summaryTokenThreshold.toLocaleString()} tokens</strong>
          <progress max={memory.summaryTokenThreshold} value={Math.min(status.estimatedTokens,memory.summaryTokenThreshold)}/>
          <span>{zh?`${status.habits} 条习惯 · ${status.predictions} 条预测 · ${status.notes} 条待整理笔记`:`${status.habits} habits · ${status.predictions} predictions · ${status.notes} notes`}</span>
          <span>{zh?`累计验证：${status.hits} 次命中 · ${status.misses} 次否定`:`Reviewed: ${status.hits} hits · ${status.misses} rejected`}</span>
          <span>{zh?`${status.inactiveRecords??0} 条失效记录 · ${status.historyChanges??0} 次历史变更`:`${status.inactiveRecords??0} inactive records · ${status.historyChanges??0} history changes`}</span>
          {status.lastSummaryAt&&<small>{zh?'上次总结：':'Last summarized: '}{new Date(status.lastSummaryAt).toLocaleString(language==='zh'?'zh-CN':'en-US')}</small>}
          {status.lastError&&<small role="alert">{zh?'上次总结未完成，原记录已保留，可手动重试。':'The last summary failed. Original records were kept; you can retry.'}</small>}</>:<span>{zh?'读取记忆状态…':'Reading memory status…'}</span>}
      </div>
      <div className="summary-memory-actions"><button className="primary-button" disabled={busy||status?.running||!enabled||!status?.records||!modelId} onClick={()=>void summarize()}>
        {busy||status?.running?zh?'正在总结…':'Summarizing…':zh?'立即总结':'Summarize now'}</button>
        <button className="secondary-button" disabled={busy} onClick={()=>setRevision(v=>v+1)}>{zh?'刷新':'Refresh'}</button></div>
      <small>{zh?`手动总结使用当前模型${modelId?`：${modelId}`:'，请先配置并选择模型'}。会产生模型用量。`:`Manual summaries use the selected model${modelId?`: ${modelId}`:' (configure one first)'}. Model usage applies.`}</small>
      {error&&<p role="alert">{error}</p>}
    </SettingsCard>
    <MemoryRecordsPanel settings={memory} connection={connection} zh={zh} refresh={revision+recordsRefresh} onChanged={()=>setRevision(value=>value+1)} api={memoryApi}/>
  </div>;
}
