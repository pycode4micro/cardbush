import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Pencil, Plus, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import type { SpeakerLockStatus, SpeakerProfileInfo, SpeakerSampleInfo } from '../../../electron/voiceTypes';
import { SettingsCard } from '../settings/SettingsControls';
import { SettingsDropdown } from '../settings/SettingsDropdown';
import { VoiceModelPanel } from './VoiceModelPanel';
import { SpeakerEnrollment } from './SpeakerEnrollment';
import { voiceError } from './voiceError';
import './speakerLock.css';

export function SpeakerLockPanel({ language, microphoneId, disabled }: { language: 'zh' | 'en'; microphoneId: string; disabled: boolean }) {
  const api = window.cardbushDesktop?.voice, zh = language === 'zh';
  const [status, setStatus] = useState<SpeakerLockStatus>(), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [recordingBusy, setRecordingBusy] = useState(false), [modelOpen, setModelOpen] = useState(false);
  const [viewedId, setViewedId] = useState(''), [nameForm, setNameForm] = useState<{ profileId?: string; name: string }>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void api?.speakerStatus().then(value => { if (alive.current) setStatus(value); }).catch(error => { if (alive.current) setError(voiceError(error, '无法读取声纹配置。')); });
    return () => { alive.current = false; };
  }, [api]);
  const profiles = status?.profiles ?? [];
  const viewed = profiles.find(profile => profile.id === viewedId) ?? profiles.find(profile => profile.id === status?.activeProfileId) ?? profiles[0];
  const active = profiles.find(profile => profile.id === status?.activeProfileId);
  const blocked = disabled || busy || recordingBusy;
  const run = async (action: () => Promise<SpeakerLockStatus>) => {
    setBusy(true); setError('');
    try { const next = await action(); if (alive.current) { setStatus(next); return next; } }
    catch (error) { if (alive.current) setError(voiceError(error, '无法更新声纹配置。')); }
    finally { if (alive.current) setBusy(false); }
  };
  const saveName = async () => {
    if (!api || !nameForm) return;
    const next = await run(() => api.saveSpeakerProfile(nameForm));
    if (next) { setViewedId(nameForm.profileId ?? next.profiles.at(-1)!.id); setNameForm(undefined); }
  };
  const removePerson = (profile: SpeakerProfileInfo) => {
    if (!api) return;
    const message = zh ? `删除「${profile.name}」及其全部声纹段落？${status?.activeProfileId === profile.id && status.enabled ? '此人正在使用，删除后将关闭声纹锁定。' : '其他人员不受影响。'}`
      : `Delete ${profile.name} and all their samples? ${status?.activeProfileId === profile.id && status.enabled ? 'This also disables the active voice lock.' : 'Other profiles are kept.'}`;
    if (window.confirm(message)) void run(() => api.removeSpeaker(profile.id));
  };
  const removeSample = (sample: SpeakerSampleInfo) => {
    if (!api || !viewed || !window.confirm(zh ? '删除这一段声纹？其他段落会保留。' : 'Delete this voice sample? Other samples will be kept.')) return;
    void run(() => api.removeSpeakerSample({ profileId: viewed.id, sampleId: sample.id }));
  };
  return <SettingsCard className="speaker-lock" title={zh ? '声纹锁定（可选）' : 'Voice lock (optional)'} subtitle={zh ? '管理多人声纹，每次只允许当前使用的一人。' : 'Manage several profiles. Only one selected person is accepted at a time.'}>
    <div className={`speaker-lock-summary${status?.enabled ? ' is-enabled' : ''}`}>
      <ShieldCheck size={22}/><div><strong>{status?.enabled ? zh ? `只允许 ${active?.name ?? '当前人员'}` : `Only ${active?.name ?? 'the selected person'}` : zh ? '声纹锁定未开启' : 'Voice lock is off'}</strong><small>{status?.enabled ? zh ? '通过声纹验证后，才会转写、发送或打断播报。' : 'Verify before transcribing, sending or interrupting playback.' : zh ? '未开启时，通话识别内容需先确认，再发送。' : 'When off, review recognized speech before sending it during a call.'}</small></div>
      <button type="button" role="switch" aria-checked={Boolean(status?.enabled)} disabled={blocked || !status?.enrolled} onClick={() => api && void run(() => api.configureSpeaker({ enabled: !status?.enabled, mode: status?.mode ?? 'strict' }))}>{status?.enabled ? zh ? '关闭锁定' : 'Disable' : zh ? '开启声纹锁定' : 'Enable voice lock'}</button>
    </div>
    <div className="speaker-section-heading"><div><strong>{zh ? '人员档案' : 'People'}</strong><small>{zh ? '选择卡片管理段落；点击「使用此人」才会切换。' : 'Select a card to manage clips. “Use this person” switches the lock.'}</small></div>
      <button type="button" disabled={blocked || profiles.length >= 8} onClick={() => setNameForm({ name: '' })}><Plus size={16}/>{zh ? '添加人员' : 'Add person'}</button>
    </div>
    {nameForm && <form className="speaker-name-form" onSubmit={event => { event.preventDefault(); void saveName(); }}>
      <label>{zh ? nameForm.profileId ? '修改人员名称' : '人员名称' : nameForm.profileId ? 'Rename person' : 'Person’s name'}<input aria-label={zh ? '人员名称' : 'Person’s name'} autoFocus maxLength={40} value={nameForm.name} disabled={blocked} placeholder={zh ? '例如：我、家人、同事' : 'For example: Me, family, colleague'} onChange={event => setNameForm({ ...nameForm, name: event.target.value })}/></label>
      <div className="voice-actions"><button type="submit" className="speaker-primary" disabled={blocked || !nameForm.name.trim()}>{busy ? zh ? '保存中…' : 'Saving…' : zh ? '保存人员' : 'Save person'}</button><button type="button" disabled={busy} onClick={() => setNameForm(undefined)}>{zh ? '取消' : 'Cancel'}</button></div>
    </form>}
    {profiles.length ? <div className="speaker-people" aria-label={zh ? '声纹人员列表' : 'Voice profiles'}>{profiles.map(profile => <button key={profile.id} type="button" className={`speaker-person${profile.id === viewed?.id ? ' is-viewed' : ''}`} aria-pressed={profile.id === viewed?.id} disabled={blocked} onClick={() => { setViewedId(profile.id); setError(''); setNameForm(undefined); }}>
      <UserRound size={18}/><span><strong>{profile.name}</strong><small>{zh ? `${profile.samples.length} 段 · ${profile.ready ? '已就绪' : '待完成'}` : `${profile.samples.length} clips · ${profile.ready ? 'Ready' : 'Incomplete'}`}</small></span>{profile.id === status?.activeProfileId && <span className="speaker-person-tag">{zh ? '当前使用' : 'Selected'}</span>}
    </button>)}</div> : !nameForm && <div className="speaker-empty"><UserRound size={28}/><strong>{zh ? '先给这份声音起个名字' : 'Give this voice a name'}</strong><p>{zh ? '每个人独立录入，段落可以逐个保存和重录。' : 'Each person has their own clips. Save and replace them individually.'}</p></div>}
    {viewed && <div className="speaker-profile-detail">
      <div className="speaker-section-heading"><div><strong>{viewed.name}</strong><small>{viewed.ready ? zh ? '声纹已就绪' : 'Voice profile ready' : zh ? `还需 ${3 - viewed.samples.length} 段有效语音` : `${3 - viewed.samples.length} more valid clips needed`}</small></div>
        <div className="speaker-person-actions"><button type="button" disabled={blocked} aria-label={zh ? '重命名人员' : 'Rename person'} onClick={() => setNameForm({ profileId: viewed.id, name: viewed.name })}><Pencil size={15}/></button><button type="button" className="speaker-danger" disabled={blocked} aria-label={zh ? '删除人员' : 'Delete person'} onClick={() => removePerson(viewed)}><Trash2 size={15}/></button></div>
      </div>
      <SpeakerEnrollment key={viewed.id} profile={viewed} language={language} microphoneId={microphoneId} disabled={disabled || busy} onChange={setStatus} onBusy={setRecordingBusy} onNeedModel={() => setModelOpen(true)} onRemove={removeSample}/>
      {viewed.id !== status?.activeProfileId && <div className="voice-actions"><button type="button" className="speaker-primary" disabled={blocked || !viewed.ready} onClick={() => api && void run(() => api.selectSpeakerProfile(viewed.id))}><Check size={16}/>{zh ? '使用此人' : 'Use this person'}</button><small className="voice-help">{zh ? '切换后仅此人的声音可以通过锁定。' : 'Only this person will pass the voice lock after switching.'}</small></div>}
    </div>}
    <div className="speaker-preferences"><div className="speaker-preference-control"><span>{zh ? '匹配程度' : 'Matching'}</span><SettingsDropdown label={zh ? '声纹严格程度' : 'Voice match strictness'} value={status?.mode ?? 'strict'} disabled={blocked || !status}
      onChange={value => api && void run(() => api.configureSpeaker({ enabled: Boolean(status?.enabled), mode: value as 'standard' | 'strict' }))}
      options={[{ value: 'strict', label: zh ? '严格（推荐）' : 'Strict (recommended)' }, { value: 'standard', label: zh ? '标准' : 'Standard' }]} /></div><span>{zh ? '更改立即生效' : 'Changes apply immediately'}</span></div>
    <details className="speaker-model-details" open={modelOpen} onToggle={event => setModelOpen(event.currentTarget.open)}><summary>{zh ? '本地模型 · 安装、卸载与来源' : 'Local model · Install, remove and sources'}<ChevronDown size={16}/></summary><VoiceModelPanel kind="speaker" language={language} selected={Boolean(status?.enabled)} disabled={blocked} select={() => {}}/></details>
    <p className="voice-help">{zh ? '录音只在保存前临时试听，保存的是本机加密声纹。支持多人分别录入，不支持同时混合讲话。录入会结束当前语音通话，不停止 Agent。' : 'Recordings can be previewed before saving; only encrypted voice features are retained. Enroll each person separately. Overlapping speakers are not supported. Enrollment ends the voice call, not the Agent task.'}</p>
    {error && <p className="voice-error" role="alert">{error}</p>}
    {error && !status && <div className="voice-actions"><button type="button" className="speaker-danger" disabled={blocked} onClick={() => { if (api && window.confirm(zh ? '清除本机全部声纹并关闭锁定？' : 'Clear all local voice profiles and disable the lock?')) void run(() => api.removeSpeaker()); }}>{zh ? '清除损坏的声纹配置' : 'Reset damaged voice profiles'}</button></div>}
  </SettingsCard>;
}
