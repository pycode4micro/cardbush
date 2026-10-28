import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Pencil, Plus, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import type { SpeakerLockStatus, SpeakerProfileInfo, SpeakerSampleInfo } from '../../../electron/voiceTypes';
import { SettingsCard } from '../settings/SettingsControls';
import { SettingsDropdown } from '../settings/SettingsDropdown';
import { VoiceModelPanel } from './VoiceModelPanel';
import { SpeakerEnrollment } from './SpeakerEnrollment';
import { voiceError } from './voiceError';
import './speakerLock.css';

export function SpeakerLockPanel({ language, microphoneId, disabled }: { language: string; microphoneId: string; disabled: boolean }) {
  const api = window.cardbushDesktop?.voice;
  const [status, setStatus] = useState<SpeakerLockStatus>(), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [recordingBusy, setRecordingBusy] = useState(false), [modelOpen, setModelOpen] = useState(false);
  const [viewedId, setViewedId] = useState(''), [nameForm, setNameForm] = useState<{ profileId?: string; name: string }>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void api?.speakerStatus().then(value => { if (alive.current) setStatus(value); }).catch(error => { if (alive.current) setError(voiceError(error, uiText(language)('speakerLockPanel.could_not_load_the_voiceprint_settings'))); });
    return () => { alive.current = false; };
  }, [api]);
  const profiles = status?.profiles ?? [];
  const viewed = profiles.find(profile => profile.id === viewedId) ?? profiles.find(profile => profile.id === status?.activeProfileId) ?? profiles[0];
  const active = profiles.find(profile => profile.id === status?.activeProfileId);
  const blocked = disabled || busy || recordingBusy;
  const run = async (action: () => Promise<SpeakerLockStatus>) => {
    setBusy(true); setError('');
    try { const next = await action(); if (alive.current) { setStatus(next); return next; } }
    catch (error) { if (alive.current) setError(voiceError(error, uiText(language)('speakerLockPanel.could_not_update_the_voiceprint_settings'))); }
    finally { if (alive.current) setBusy(false); }
  };
  const saveName = async () => {
    if (!api || !nameForm) return;
    const next = await run(() => api.saveSpeakerProfile(nameForm));
    if (next) { setViewedId(nameForm.profileId ?? next.profiles.at(-1)!.id); setNameForm(undefined); }
  };
  const removePerson = (profile: SpeakerProfileInfo) => {
    if (!api) return;
    const message = uiText(language)('speakerLockPanel.deleteAndAllTheirSamples', { value1: profile.name, value2: (status?.activeProfileId === profile.id && status.enabled ? uiText(language)('speakerLockPanel.thisAlsoDisablesTheActiveVoiceLock') : uiText(language)('speakerLockPanel.otherProfilesAreKept')) });
    if (window.confirm(message)) void run(() => api.removeSpeaker(profile.id));
  };
  const removeSample = (sample: SpeakerSampleInfo) => {
    if (!api || !viewed || !window.confirm(uiText(language)('speakerLockPanel.deleteThisVoiceSampleOtherSamplesWill'))) return;
    void run(() => api.removeSpeakerSample({ profileId: viewed.id, sampleId: sample.id }));
  };
  return <SettingsCard className="speaker-lock" title={uiText(language)('speakerLockPanel.voiceLockOptional')} subtitle={uiText(language)('speakerLockPanel.manageSeveralProfilesOnlyOneSelectedPerson')}>
    <div className={`speaker-lock-summary${status?.enabled ? ' is-enabled' : ''}`}>
      <ShieldCheck size={22}/><div><strong>{status?.enabled ? uiText(language)('speakerLockPanel.only', { value1: (active?.name ?? uiText(language)('speakerLockPanel.theSelectedPerson')) }) : uiText(language)('speakerLockPanel.voiceLockIsOff')}</strong><small>{status?.enabled ? uiText(language)('speakerLockPanel.verifyBeforeTranscribingSendingOrInterruptingPlayback') : uiText(language)('speakerLockPanel.whenOffCallersAreNotDistinguishedAnd')}</small></div>
      <button type="button" role="switch" aria-checked={Boolean(status?.enabled)} disabled={blocked || !status?.enrolled} onClick={() => api && void run(() => api.configureSpeaker({ enabled: !status?.enabled, mode: status?.mode ?? 'strict' }))}>{status?.enabled ? uiText(language)('speakerLockPanel.disable') : uiText(language)('speakerLockPanel.enableVoiceLock')}</button>
    </div>
    <div className="speaker-section-heading"><div><strong>{uiText(language)('speakerLockPanel.people')}</strong><small>{uiText(language)('speakerLockPanel.selectACardToManageClipsUse')}</small></div>
      <button type="button" disabled={blocked || profiles.length >= 8} onClick={() => setNameForm({ name: '' })}><Plus size={16}/>{uiText(language)('speakerLockPanel.addPerson')}</button>
    </div>
    {nameForm && <form className="speaker-name-form" onSubmit={event => { event.preventDefault(); void saveName(); }}>
      <label>{(nameForm.profileId ? uiText(language)('speakerLockPanel.renamePerson') : uiText(language)('speakerLockPanel.personSName'))}<input aria-label={uiText(language)('speakerLockPanel.personSName')} autoFocus maxLength={40} value={nameForm.name} disabled={blocked} placeholder={uiText(language)('speakerLockPanel.forExampleMeFamilyColleague')} onChange={event => setNameForm({ ...nameForm, name: event.target.value })}/></label>
      <div className="voice-actions"><button type="submit" className="speaker-primary" disabled={blocked || !nameForm.name.trim()}>{busy ? uiText(language)('automationPanel.saving') : uiText(language)('speakerLockPanel.savePerson')}</button><button type="button" disabled={busy} onClick={() => setNameForm(undefined)}>{uiText(language)('agentConnectionForm.cancel')}</button></div>
    </form>}
    {profiles.length ? <div className="speaker-people" aria-label={uiText(language)('speakerLockPanel.voiceProfiles')}>{profiles.map(profile => <button key={profile.id} type="button" className={`speaker-person${profile.id === viewed?.id ? ' is-viewed' : ''}`} aria-pressed={profile.id === viewed?.id} disabled={blocked} onClick={() => { setViewedId(profile.id); setError(''); setNameForm(undefined); }}>
      <UserRound size={18}/><span><strong>{profile.name}</strong><small>{uiText(language)('speakerLockPanel.clips', { value1: profile.samples.length, value2: (profile.ready ? uiText(language)('runtimeStreamPreTest.ready') : uiText(language)('speakerLockPanel.incomplete')) })}</small></span>{profile.id === status?.activeProfileId && <span className="speaker-person-tag">{uiText(language)('speakerLockPanel.selected')}</span>}
    </button>)}</div> : !nameForm && <div className="speaker-empty"><UserRound size={28}/><strong>{uiText(language)('speakerLockPanel.giveThisVoiceAName')}</strong><p>{uiText(language)('speakerLockPanel.eachPersonHasTheirOwnClipsSave')}</p></div>}
    {viewed && <div className="speaker-profile-detail">
      <div className="speaker-section-heading"><div><strong>{viewed.name}</strong><small>{viewed.ready ? uiText(language)('speakerLockPanel.voiceProfileReady') : uiText(language)('speakerLockPanel.moreValidClipsNeeded', { value1: 3 - viewed.samples.length })}</small></div>
        <div className="speaker-person-actions"><button type="button" disabled={blocked} aria-label={uiText(language)('speakerLockPanel.renamePerson_dda0f87')} onClick={() => setNameForm({ profileId: viewed.id, name: viewed.name })}><Pencil size={15}/></button><button type="button" className="speaker-danger" disabled={blocked} aria-label={uiText(language)('speakerLockPanel.deletePerson')} onClick={() => removePerson(viewed)}><Trash2 size={15}/></button></div>
      </div>
      <SpeakerEnrollment key={viewed.id} profile={viewed} language={language} microphoneId={microphoneId} disabled={disabled || busy} onChange={setStatus} onBusy={setRecordingBusy} onNeedModel={() => setModelOpen(true)} onRemove={removeSample}/>
      {viewed.id !== status?.activeProfileId && <div className="voice-actions"><button type="button" className="speaker-primary" disabled={blocked || !viewed.ready} onClick={() => api && void run(() => api.selectSpeakerProfile(viewed.id))}><Check size={16}/>{uiText(language)('speakerLockPanel.useThisPerson')}</button><small className="voice-help">{uiText(language)('speakerLockPanel.onlyThisPersonWillPassTheVoice')}</small></div>}
    </div>}
    <div className="speaker-preferences"><div className="speaker-preference-control"><span>{uiText(language)('speakerLockPanel.matching')}</span><SettingsDropdown label={uiText(language)('speakerLockPanel.voiceMatchStrictness')} value={status?.mode ?? 'strict'} disabled={blocked || !status}
      onChange={value => api && void run(() => api.configureSpeaker({ enabled: Boolean(status?.enabled), mode: value as 'standard' | 'strict' }))}
      options={[{ value: 'strict', label: uiText(language)('speakerLockPanel.strictRecommended') }, { value: 'standard', label: uiText(language)('componentsApp.standard') }]} /></div><span>{uiText(language)('speakerLockPanel.changesApplyImmediately')}</span></div>
    <details className="speaker-model-details" open={modelOpen} onToggle={event => setModelOpen(event.currentTarget.open)}><summary>{uiText(language)('speakerLockPanel.localModelInstallRemoveAndSources')}<ChevronDown size={16}/></summary><VoiceModelPanel kind="speaker" language={language} selected={Boolean(status?.enabled)} disabled={blocked} select={() => {}}/></details>
    <p className="voice-help">{uiText(language)('speakerLockPanel.recordingsCanBePreviewedBeforeSavingOnly')}</p>
    {error && <p className="voice-error" role="alert">{error}</p>}
    {error && !status && <div className="voice-actions"><button type="button" className="speaker-danger" disabled={blocked} onClick={() => { if (api && window.confirm(uiText(language)('speakerLockPanel.clearAllLocalVoiceProfilesAndDisable'))) void run(() => api.removeSpeaker()); }}>{uiText(language)('speakerLockPanel.resetDamagedVoiceProfiles')}</button></div>}
  </SettingsCard>;
}
