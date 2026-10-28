import type { MessageKey } from '../../i18n';
import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { normalizeIndividuation, summaryTokenThresholdSchema, type PersonalizationStatus } from '@cardbush/bush-protocol';
import type { AgentConnection } from '../../../electron/agentTypes';
import type { AppLanguage, AppSettingsState } from '../../types';
import { personalizationCommand, type MemoryManagementClient } from '../../backend/personalization';
import { MemoryRecordsPanel } from './MemoryRecordsPanel';
import { SettingsCard, SettingsSelect, SettingsSwitch } from './SettingsControls';
import './summarySettings.css';
import { settingsLabels } from './settingsNavigation';

export function SettingsSummaryPanel({language,settings,onSettingsChange,modelId='',modelLabel='',connections=[],call=personalizationCommand,memoryApi}:{
  language:AppLanguage;settings:AppSettingsState;modelId?:string;modelLabel?:string;connections?:AgentConnection[];
  onSettingsChange:(updater:(current:AppSettingsState)=>AppSettingsState)=>void;call?:typeof personalizationCommand;
  memoryApi?:MemoryManagementClient;
}) {
  const uiLanguage = language,memory=normalizeIndividuation(settings.individuation);
  const [connection,setConnection]=useState(''),[status,setStatus]=useState<PersonalizationStatus>();
  const [eventThreshold,setEventThreshold]=useState(String(memory.eventTokenThreshold));
  const [habitThreshold,setHabitThreshold]=useState(String(memory.habitTokenThreshold));
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0),[recordsRefresh,setRecordsRefresh]=useState(0);
  const [reading,setReading]=useState(false);
  const generation=useRef(0),requestSequence=useRef(0),acting=useRef(false);
  const latestStatus=useRef<PersonalizationStatus|undefined>(undefined);
  const readScope=JSON.stringify([connection,memory.habits,memory.predictions]);
  useEffect(()=>{setEventThreshold(String(memory.eventTokenThreshold));},[memory.eventTokenThreshold]);
  useEffect(()=>{setHabitThreshold(String(memory.habitTokenThreshold));},[memory.habitTokenThreshold]);
  useEffect(()=>{
    generation.current++;latestStatus.current=undefined;setStatus(undefined);setError('');
    return ()=>{generation.current++;};
  },[readScope]);
  function acceptStatus(value:PersonalizationStatus) {
    const previous=latestStatus.current;
    latestStatus.current=value;setStatus(value);
    if(value.running&&!previous?.running)setError('');
    // Polling a running job does not invalidate the records/editor on every tick.
    if(previous&&(previous.running&&!value.running||previous.lastSummaryAt!==value.lastSummaryAt))setRecordsRefresh(v=>v+1);
  }
  useEffect(()=>{
    const version=generation.current,sequence=++requestSequence.current;
    setReading(true);
    void call({action:'status',settings:memory},connection).then(value=>{
      if(version===generation.current&&sequence===requestSequence.current)acceptStatus(value);
    },()=>{
      if(version===generation.current&&sequence===requestSequence.current)setError(uiText(language)('settingsSummaryPanel.cannotReadMemoryStatusCheckTheConnection'));
    }).finally(()=>{if(version===generation.current&&sequence===requestSequence.current)setReading(false);});
  },[call,readScope,memory.eventTokenThreshold,memory.habitTokenThreshold,revision,uiLanguage]);
  // Poll only an observed running job, never an idle memory database.
  useEffect(()=>{if(reading||!status?.running&&!busy)return;const timer=setTimeout(()=>setRevision(v=>v+1),2000);return()=>clearTimeout(timer);},[status?.running,busy,reading,revision]);
  const update=(value:Partial<typeof memory>)=>onSettingsChange(current=>({...current,individuation:{...normalizeIndividuation(current.individuation),...value}}));
  function saveThreshold() {
    const events=summaryTokenThresholdSchema.safeParse(Number(eventThreshold)),habits=summaryTokenThresholdSchema.safeParse(Number(habitThreshold));
    if(!events.success||!habits.success) {setError(uiText(language)('settingsSummaryPanel.useAWholeNumberFrom1000'));return false;}
    setError('');if(events.data!==memory.eventTokenThreshold||habits.data!==memory.habitTokenThreshold)update({eventTokenThreshold:events.data,habitTokenThreshold:habits.data});return true;
  }
  async function summarize() {
    if(acting.current||!saveThreshold())return;
    const version=generation.current;acting.current=true;setBusy(true);setError('');
    try {
      const value=await call({action:'summarize',settings:{...memory,eventTokenThreshold:Number(eventThreshold),habitTokenThreshold:Number(habitThreshold)},modelId},connection);
      if(version===generation.current){requestSequence.current++;setReading(false);acceptStatus(value);setRecordsRefresh(value=>value+1);}
    } catch {
      if(version===generation.current){
        setError(uiText(language)('settingsSummaryPanel.consolidationDidNotFullyCompleteValidatedResults'));
        // Retrieve the persisted reason even if the command transport rejected.
        const sequence=++requestSequence.current;
        setReading(true);
        try {const value=await call({action:'status',settings:memory},connection);if(version===generation.current&&sequence===requestSequence.current)acceptStatus(value);} catch { /* Keep the last known snapshot and the error. */ }
        finally {if(version===generation.current&&sequence===requestSequence.current)setReading(false);}
      }
    }
    finally {acting.current=false;setBusy(false);}
  }
  const enabled=memory.habits||memory.predictions;
  return <div className="settings-stack summary-settings">
    <SettingsCard title={uiText(language)(settingsLabels.summary_for_user)} subtitle={uiText(language)('settingsSummaryPanel.keepConcisePreferencesAndPossibleFollowUps')}>
      <SettingsSwitch title={uiText(language)('settingsSummaryPanel.rememberAndUseHabits')} checked={memory.habits} onChange={habits=>update({habits})}
        subtitle={uiText(language)('settingsSummaryPanel.saveSupportedPreferencesAndCorrectionsWhenUseful')}/>
      <SettingsSwitch title={uiText(language)('settingsSummaryPanel.predictNextActions')} checked={memory.predictions} onChange={predictions=>update({predictions})}
        subtitle={uiText(language)('settingsSummaryPanel.offerEditableNextMessageSuggestionsAndExclude')}/>
      <SettingsSelect name="memory-recall-mode" title={uiText(language)('settingsSummaryPanel.memoryRecallMode')} value={memory.recallMode} onChange={value=>update({recallMode:value==='hint'?'hint':'context'})}
        subtitle={uiText(language)('settingsSummaryPanel.explicitLookupAlwaysAllowsRepeatReadsOnly')}>
        <option value="context">{uiText(language)('settingsSummaryPanel.includeAFewRelevantExcerpts')}</option>
        <option value="hint">{uiText(language)('settingsSummaryPanel.onlyHintAtCandidateCounts')}</option>
      </SettingsSelect>
    </SettingsCard>
    <SettingsCard title={uiText(language)('settingsSummaryPanel.memoryMaintenance')} subtitle={uiText(language)('settingsSummaryPanel.deduplicationExpiryFilteringAndArchivingEvidenceWith')}>
      <SettingsSelect name="summary-host" title={uiText(language)('settingsSummaryPanel.memoryHost')} value={connection} onChange={setConnection} disabled={busy}
        subtitle={uiText(language)('settingsSummaryPanel.memoryStaysOnItsHostAndIs')}>
        <option value="">{uiText(language)('settingsSummaryPanel.thisDevice')}</option>{connections.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
      </SettingsSelect>
      <div className="summary-memory-status" aria-live="polite">
        {status?<><strong>{status.estimatedTokens.toLocaleString()} {uiText(language)('settingsSummaryPanel.tokensOfActiveMemory')}</strong>
          <span>{uiText(language)('settingsSummaryPanel.predictionsNotesAndFeedback')} · {status.eventTokens.toLocaleString()} {uiText(language)('settingsSummaryPanel.tokens')}</span>
          <span>{uiText(language)('settingsSummaryPanel.habits')} · {status.habitTokens.toLocaleString()} {uiText(language)('settingsSummaryPanel.tokens')}</span>
          <span>{uiText(language)('settingsSummaryPanel.habitsPredictionsNotesFeedbackEvents', { value1: status.habits, value2: status.predictions, value3: status.notes, value4: status.feedback??0 })}</span>
          <span>{uiText(language)('settingsSummaryPanel.inactiveRecordsHistoryChanges', { value1: status.inactiveRecords??0, value2: status.historyChanges??0 })}</span>
          {(status.evidenceRecords??0)>0&&<small>{uiText(language)('settingsSummaryPanel.storedSeparatelyPendingEvidenceRecordsTokensOutside', { value1: status.evidenceRecords, value2: (status.evidenceTokens??0).toLocaleString() })}</small>}
          {status.running&&status.summaryProgress&&<span className="summary-memory-progress">{summaryProgressLabel(status.summaryProgress,uiLanguage)}</span>}
          </>:<span>{uiText(language)('settingsSummaryPanel.readingMemoryStatus')}</span>}
      </div>
      <div className="summary-memory-actions"><button className="secondary-button" disabled={busy} onClick={()=>{setRevision(v=>v+1);setRecordsRefresh(v=>v+1);}}>{uiText(language)('automationPanel.refresh')}</button></div>
      <details className="summary-manual-settings">
        <summary>{uiText(language)('settingsSummaryPanel.manualModelConsolidationOptional')}</summary>
        <p><small>{uiText(language)('settingsSummaryPanel.onlyAnExplicitRunUsesAModel')}</small></p>
        <label className="summary-threshold"><span>{uiText(language)('settingsSummaryPanel.predictionConsolidationThresholdTokens')}</span>
          <input aria-label={uiText(language)('settingsSummaryPanel.predictionConsolidationThreshold')} type="number" min={1000} max={200000} step={1000} value={eventThreshold}
            onChange={event=>setEventThreshold(event.target.value)} onBlur={saveThreshold} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();saveThreshold();}}}/></label>
        <label className="summary-threshold"><span>{uiText(language)('settingsSummaryPanel.habitCompactionThresholdTokens')}</span>
          <input aria-label={uiText(language)('settingsSummaryPanel.habitCompactionThreshold')} type="number" min={1000} max={200000} step={1000} value={habitThreshold}
            onChange={event=>setHabitThreshold(event.target.value)} onBlur={saveThreshold} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();saveThreshold();}}}/></label>
        <div className="summary-memory-actions"><button className="primary-button" disabled={busy||status?.running||!enabled||!(status?.records||(status?.evidenceRecords??0))||!modelId} onClick={()=>void summarize()}>
          {busy||status?.running?uiText(language)('settingsSummaryPanel.summarizing'):uiText(language)('settingsSummaryPanel.runModelConsolidation')}</button></div>
        <small>{uiText(language)('settingsSummaryPanel.manualSummariesUseTheSelectedModelModel', { value1: (modelId ? (modelLabel ? uiText(language)('settingsSummaryPanel.message', { value1: modelLabel }) : '') : uiText(language)('settingsSummaryPanel.configureOneFirst')) })}</small>
        {status&&<p><small>{uiText(language)('settingsSummaryPanel.historicalReviewsHitsRejected', { value1: status.hits, value2: status.misses })}</small></p>}
        {status?.lastSummaryAt&&<p><small>{uiText(language)('settingsSummaryPanel.lastModelConsolidation')}{new Date(status.lastSummaryAt).toLocaleString(language)}</small></p>}
        {status?.lastError&&!status.running&&!busy&&<details className="summary-memory-error"><summary>{summaryFailureLabel(status.lastError,uiLanguage)}</summary><small>{uiText(language)('settingsSummaryPanel.validatedResultsWereSavedRemainingOriginalRecords')}</small><pre>{status.lastError}</pre></details>}
      </details>
      {error&&<p role="alert">{error}</p>}
    </SettingsCard>
    <MemoryRecordsPanel settings={memory} connection={connection} uiLanguage={uiLanguage} refresh={recordsRefresh} onChanged={()=>{setRevision(value=>value+1);setRecordsRefresh(value=>value+1);}} api={memoryApi}/>
  </div>;
}

function summaryFailureLabel(error:string,uiLanguage:string) {
  const code=/memory_summary_([a-z_]+):/.exec(error)?.[1];
  if(code==='timeout'){
    if(error.includes('reason=first_response'))return uiText(uiLanguage)('settingsSummaryPanel.timedOutWaitingForTheFirstModel');
    if(error.includes('reason=idle'))return uiText(uiLanguage)('settingsSummaryPanel.theModelStoppedReturningNewContent');
    if(error.includes('reason=total'))return uiText(uiLanguage)('settingsSummaryPanel.theSummaryStageReachedItsTimeLimit');
  }
  if(code==='snapshot_changed'&&error.includes('reason=lease_'))return uiText(uiLanguage)('settingsSummaryPanel.theSummaryTaskCouldNotRetainIts');
  if(code==='invalid_summary'&&error.includes('reason=invalid_review')) {
    const reason=/reason=invalid_review\/([a-z_]+)/.exec(error)?.[1];
    const reviews:Record<string, MessageKey>={
      duplicate_pair:'settingsSummaryPanel.the_summary_reviewed_the_same_prediction_evidence' as const,
      unknown_record:'settingsSummaryPanel.the_summary_referenced_a_record_outside_this' as const,
      not_prediction:'settingsSummaryPanel.the_summary_tried_to_review_a_record' as const,
      not_user_evidence:'settingsSummaryPanel.the_summary_used_a_record_that_is' as const,
      evidence_not_subsequent:'settingsSummaryPanel.the_summary_used_evidence_that_does_not' as const,
      evidence_not_linked:'settingsSummaryPanel.the_summary_used_evidence_not_linked_to' as const,
    };
    return (reviews[reason??''] && uiText(uiLanguage)(reviews[reason??'']))??(uiText(uiLanguage)('settingsSummaryPanel.predictionReviewsDidNotPassEvidenceValidation'));
  }
  const labels:Record<string, MessageKey>={
    timeout:'settingsSummaryPanel.the_last_summary_stage_timed_out' as const,
    cancelled:'settingsSummaryPanel.consolidation_was_interrupted' as const,
    output_limit:'settingsSummaryPanel.the_model_reached_its_output_limit_before' as const,
    input_limit:'settingsSummaryPanel.a_complete_source_exceeds_the_maintenance_budget' as const,
    partial:'settingsSummaryPanel.some_entries_failed_validation_other_results_were' as const,
    invalid_json:'settingsSummaryPanel.the_model_did_not_return_complete_valid' as const,
    invalid_summary:'settingsSummaryPanel.the_model_summary_did_not_pass_memory' as const,
    snapshot_changed:'settingsSummaryPanel.the_source_memory_changed_and_needs_a' as const,
    provider_failure:'settingsSummaryPanel.the_model_request_failed_check_the_connection' as const,
  };
  return (labels[code??''] && uiText(uiLanguage)(labels[code??'']))??(uiText(uiLanguage)('settingsSummaryPanel.theLastConsolidationDidNotFullyComplete'));
}

function summaryProgressLabel(progress:NonNullable<PersonalizationStatus['summaryProgress']>,uiLanguage:string) {
  const stage=progress.stage==='events'?(uiText(uiLanguage)('settingsSummaryPanel.reviewingEvents')):(uiText(uiLanguage)('settingsSummaryPanel.compactingHabits'));
  const phase={waiting:uiText(uiLanguage)('settingsSummaryPanel.waitingForTheModel'),reasoning:uiText(uiLanguage)('settingsSummaryPanel.modelReasoning'),
    responding:uiText(uiLanguage)('settingsSummaryPanel.writingTheSummary'),retrying:uiText(uiLanguage)('modelActivity.waitingToRetry'),validating:uiText(uiLanguage)('settingsSummaryPanel.validatingAndSaving')}[progress.phase];
  const seconds=Math.max(0,Math.floor((Date.now()-progress.startedAt)/1000));
  const batch=progress.batch&&progress.batches?uiText(uiLanguage)('settingsSummaryPanel.batch', { value1: progress.batch, value2: progress.batches }):'';
  const received=[progress.reasoningChars?(uiText(uiLanguage)('settingsSummaryPanel.reasoningCharacters', { value1: progress.reasoningChars.toLocaleString() })):'',
    progress.textChars?(uiText(uiLanguage)('settingsSummaryPanel.summaryCharacters', { value1: progress.textChars.toLocaleString() })):''].filter(Boolean).join(' · ');
  return `${stage}${batch} · ${phase} · ${uiText(uiLanguage)('settingsSummaryPanel.sElapsedInThisBatch', { value1: seconds })}${received?' · '+received:''}`;
}
