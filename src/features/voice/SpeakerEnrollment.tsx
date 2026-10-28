import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { Check, CheckCircle2, Circle, LoaderCircle, Mic, Plus, RotateCcw, Square, Trash2 } from 'lucide-react';
import type { SpeakerLockStatus, SpeakerProfileInfo, SpeakerSampleInfo } from '../../../electron/voiceTypes';
import { useSpeakerRecording } from './useSpeakerRecording';

const prompts = (['speakerEnrollment.i_am_speaking_naturally_at_my_computer', 'speakerEnrollment.please_organize_today_s_tasks_review_the', 'speakerEnrollment.i_can_speak_softly_or_clearly_check'] as const);
interface Props {
  profile: SpeakerProfileInfo; language: string; microphoneId: string; disabled: boolean;
  onChange(status: SpeakerLockStatus): void; onBusy(busy: boolean): void; onNeedModel(): void;
  onRemove(sample: SpeakerSampleInfo): void;
}
export function SpeakerEnrollment({ profile, language, microphoneId, disabled, onChange, onBusy, onNeedModel, onRemove }: Props) {
  const recording = useSpeakerRecording(microphoneId, onNeedModel);
  const [editor, setEditor] = useState<{ sampleId?: string; index: number }>();
  const [prompt, setPrompt] = useState(''), [notice, setNotice] = useState('');
  const audio = useRef<HTMLAudioElement>(null), editorElement = useRef<HTMLDivElement>(null);
  const { phase, seconds, level } = recording, occupied = phase !== 'idle';
  useEffect(() => { onBusy(occupied); return () => onBusy(false); }, [occupied, onBusy]);
  useEffect(() => { if (phase !== 'preview') audio.current?.pause(); }, [phase]);
  useEffect(() => { if (editor) editorElement.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' }); }, [editor, phase]);
  const edit = (index: number, sample?: SpeakerSampleInfo) => {
    recording.cancel(); setNotice(''); setEditor({ index, sampleId: sample?.id });
    setPrompt(sample?.prompt || uiText(language)(prompts[index % prompts.length]));
  };
  const save = async () => {
    if (!editor) return;
    const next = await recording.save({ profileId: profile.id, sampleId: editor.sampleId, prompt });
    if (!next) return;
    onChange(next); setEditor(undefined);
    const updated = next.profiles.find(person => person.id === profile.id)!;
    setNotice(updated.ready ? next.activeProfileId === profile.id
      ? uiText(language)('speakerEnrollment.savedProfileReady', { value1: (next.enabled ? uiText(language)('speakerEnrollment.thisPersonSVoiceLockIsActive') : uiText(language)('speakerEnrollment.youCanNowEnableVoiceLock')) })
      : uiText(language)('speakerEnrollment.savedThisProfileIsReadySelectUse')
      : uiText(language)('speakerEnrollment.savedMoreClipsNeededClickRecordNext', { value1: 3 - updated.samples.length }));
  };
  const status = phase === 'starting' ? uiText(language)('speakerEnrollment.openingMicrophone')
    : phase === 'recording' ? uiText(language)('speakerEnrollment.recordingReadTheTextBelow')
    : phase === 'preparing' ? uiText(language)('speakerEnrollment.recordingStoppedPreparingPreview')
    : phase === 'preview' ? uiText(language)('speakerEnrollment.recordedWaitingForYouToSave')
    : phase === 'saving' ? uiText(language)('speakerEnrollment.checkingAndSavingVoiceFeatures')
    : uiText(language)('speakerEnrollment.clickStartWhenReadyRecordingIsAlways');
  return <div className="speaker-enrollment">
    <div className="speaker-section-heading"><div><strong>{uiText(language)('speakerEnrollment.voiceSamples')}</strong><small>{uiText(language)('speakerEnrollment.saved3RequiredUpTo8', { value1: profile.samples.length })}</small></div>
      <div className="speaker-steps" aria-label={uiText(language)('speakerEnrollment.progress3', { value1: Math.min(3, profile.samples.length) })}>{[0, 1, 2].map(i => i < profile.samples.length ? <CheckCircle2 key={i} size={18}/> : <Circle key={i} size={18}/>)}</div>
    </div>
    <p className="voice-help">{uiText(language)('speakerEnrollment.startEachClipYourselfItStopsAfter')}</p>
    <div className="speaker-samples">{profile.samples.map((sample, index) => <div className="speaker-sample" key={sample.id}>
      <CheckCircle2 size={17}/><div><strong>{uiText(language)('speakerEnrollment.clip', { value1: index + 1 })}<small>{uiText(language)('modelsSettingsPanel.saved')}{sample.voicedSeconds ? ` · ${sample.voicedSeconds.toFixed(1)}s` : ''}</small></strong><p>{sample.prompt || (uiText(language)('speakerEnrollment.migratedFromYourPreviousVoiceProfile'))}</p></div>
      <button type="button" disabled={disabled || occupied} aria-label={uiText(language)('speakerEnrollment.manageClip', { value1: index + 1 })} title={uiText(language)('speakerEnrollment.viewEditTextAndReRecord')} onClick={() => edit(index, sample)}><RotateCcw size={15}/></button>
      <button type="button" className="speaker-danger" disabled={disabled || occupied} aria-label={uiText(language)('speakerEnrollment.deleteClip', { value1: index + 1 })} onClick={() => { if (editor?.sampleId === sample.id) setEditor(undefined); onRemove(sample); }}><Trash2 size={15}/></button>
    </div>)}</div>
    {!editor && profile.samples.length < 8 && <button type="button" className="speaker-add-clip" disabled={disabled || occupied} onClick={() => edit(profile.samples.length)}><Plus size={16}/>{(profile.samples.length === 0 ? uiText(language)('speakerEnrollment.prepareFirstClip') : (profile.ready ? uiText(language)('speakerEnrollment.addAnotherClip') : uiText(language)('speakerEnrollment.recordNextClip')))}</button>}
    {editor && <div className={`speaker-recorder is-${phase}`} ref={editorElement}>
      <div className="speaker-section-heading"><strong>{uiText(language)('speakerEnrollment.clip_f07c43a', { value1: profile.name, value2: editor.index + 1 })}</strong><span className="speaker-timer">{String(seconds).padStart(2, '0')} {uiText(language)('speakerEnrollment.12s')}</span></div>
      <div className="speaker-recording-status" role="status">{phase === 'saving' || phase === 'starting' || phase === 'preparing' ? <LoaderCircle className="speaker-spinner" size={18}/> : phase === 'preview' ? <CheckCircle2 size={18}/> : <Mic size={18}/>}<strong>{status}</strong></div>
      <div className="speaker-meter" aria-hidden="true">{[.45, .7, 1, .8, .55, .9, .6, .8, .5].map((weight, i) => <i key={i} style={{ transform: `scaleY(${.12 + level * weight * .88})` }}/>)}</div>
      <label className="speaker-prompt">{uiText(language)('speakerEnrollment.readingTextEditable')}<textarea aria-label={uiText(language)('speakerEnrollment.readingText')} maxLength={500} rows={3} value={prompt} disabled={occupied} onChange={event => setPrompt(event.target.value)}/></label>
      <p className="voice-help">{phase === 'recording' ? uiText(language)('speakerEnrollment.speakNaturallyOrClickFinishThisClip')
        : phase === 'preview' ? uiText(language)('speakerEnrollment.previewFirstReRecordOnlyThisClip')
        : editor.sampleId ? uiText(language)('speakerEnrollment.theOldSampleStaysValidUntilThe')
        : uiText(language)('speakerEnrollment.speakNaturallyFor812SecondsThis')}</p>
      {recording.previewUrl && phase === 'preview' && <audio ref={audio} aria-label={uiText(language)('speakerEnrollment.previewThisRecording')} controls src={recording.previewUrl}/>}
      {recording.error && <p className="voice-error" role="alert">{recording.error}</p>}
      <div className="voice-actions">
        {phase === 'idle' && <button type="button" className="speaker-primary" disabled={disabled || !prompt.trim()} onClick={() => void recording.begin()}><Mic size={16}/>{uiText(language)('speakerEnrollment.startThisRecording')}</button>}
        {phase === 'recording' && <button type="button" className="speaker-primary" onClick={recording.finish}><Square size={14}/>{uiText(language)('speakerEnrollment.finishThisClip')}</button>}
        {phase === 'preview' && <><button type="button" className="speaker-primary" onClick={() => void save()}><Check size={16}/>{uiText(language)('speakerEnrollment.useThisClip')}</button><button type="button" onClick={() => void recording.begin()}><RotateCcw size={15}/>{uiText(language)('speakerEnrollment.reRecordThisClip')}</button></>}
        <button type="button" onClick={() => { recording.cancel(); setEditor(undefined); }}>{(occupied ? uiText(language)('speakerEnrollment.cancelThisClip') : uiText(language)('speakerEnrollment.close'))}</button>
      </div>
    </div>}
    {notice && !editor && <p className="speaker-success" role="status"><CheckCircle2 size={16}/>{notice}</p>}
  </div>;
}
