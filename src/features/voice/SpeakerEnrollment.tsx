import { useEffect, useRef, useState } from 'react';
import { Check, CheckCircle2, Circle, LoaderCircle, Mic, Plus, RotateCcw, Square, Trash2 } from 'lucide-react';
import type { SpeakerLockStatus, SpeakerProfileInfo, SpeakerSampleInfo } from '../../../electron/voiceTypes';
import { useSpeakerRecording } from './useSpeakerRecording';

const prompts = {
  zh: ['今天我在自己的电脑前，用自然的声音和助手交流。请帮我安排今天的工作，完成正在进行的任务。', '请帮我整理今天的任务，查看项目进展，再打开浏览器，继续处理需要完成的事情。', '我也会说一些英文，比如 open the browser, check my calendar, and continue the task.'],
  en: ['I am speaking naturally at my computer. Help me plan my day and finish the tasks I am working on.', 'Please organize today’s tasks, review the project, open the browser, and continue our work.', 'I can speak softly or clearly. Check my calendar, organize the files, and continue the task.'],
};
interface Props {
  profile: SpeakerProfileInfo; language: 'zh' | 'en'; microphoneId: string; disabled: boolean;
  onChange(status: SpeakerLockStatus): void; onBusy(busy: boolean): void; onNeedModel(): void;
  onRemove(sample: SpeakerSampleInfo): void;
}
export function SpeakerEnrollment({ profile, language, microphoneId, disabled, onChange, onBusy, onNeedModel, onRemove }: Props) {
  const zh = language === 'zh', recording = useSpeakerRecording(microphoneId, onNeedModel);
  const [editor, setEditor] = useState<{ sampleId?: string; index: number }>();
  const [prompt, setPrompt] = useState(''), [notice, setNotice] = useState('');
  const audio = useRef<HTMLAudioElement>(null), editorElement = useRef<HTMLDivElement>(null);
  const { phase, seconds, level } = recording, occupied = phase !== 'idle';
  useEffect(() => { onBusy(occupied); return () => onBusy(false); }, [occupied, onBusy]);
  useEffect(() => { if (phase !== 'preview') audio.current?.pause(); }, [phase]);
  useEffect(() => { if (editor) editorElement.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' }); }, [editor, phase]);
  const edit = (index: number, sample?: SpeakerSampleInfo) => {
    recording.cancel(); setNotice(''); setEditor({ index, sampleId: sample?.id });
    setPrompt(sample?.prompt || prompts[language][index % 3]);
  };
  const save = async () => {
    if (!editor) return;
    const next = await recording.save({ profileId: profile.id, sampleId: editor.sampleId, prompt });
    if (!next) return;
    onChange(next); setEditor(undefined);
    const updated = next.profiles.find(person => person.id === profile.id)!;
    setNotice(updated.ready ? next.activeProfileId === profile.id
      ? zh ? `本段已保存，声纹已就绪。${next.enabled ? '正在使用此人的声纹锁定。' : '可以开启声纹锁定。'}` : `Saved. Profile ready. ${next.enabled ? 'This person’s voice lock is active.' : 'You can now enable voice lock.'}`
      : zh ? '本段已保存，声纹已就绪。点击「使用此人」可切换；录音不会自动继续。' : 'Saved. This profile is ready. Select “Use this person” to switch; recording never continues automatically.'
      : zh ? `本段已保存，还需 ${3 - updated.samples.length} 段。请点击「录制下一段」继续。` : `Saved. ${3 - updated.samples.length} more clips needed. Click “Record next clip” to continue.`);
  };
  const status = phase === 'starting' ? zh ? '正在打开麦克风…' : 'Opening microphone…'
    : phase === 'recording' ? zh ? '正在录音，请朗读下面的文字' : 'Recording — read the text below'
    : phase === 'preparing' ? zh ? '录音已停止，正在准备试听…' : 'Recording stopped. Preparing preview…'
    : phase === 'preview' ? zh ? '本段已录好，等待你确认保存' : 'Recorded. Waiting for you to save'
    : phase === 'saving' ? zh ? '正在校验并保存声纹…' : 'Checking and saving voice features…'
    : zh ? '准备好了再点击开始，不会自动录音' : 'Click Start when ready. Recording is always manual';
  return <div className="speaker-enrollment">
    <div className="speaker-section-heading"><div><strong>{zh ? '录入段落' : 'Voice samples'}</strong><small>{zh ? `已保存 ${profile.samples.length} 段 · 至少 3 段，最多 8 段` : `${profile.samples.length} saved · 3 required, up to 8`}</small></div>
      <div className="speaker-steps" aria-label={zh ? `录入进度 ${Math.min(3, profile.samples.length)} / 3` : `Progress ${Math.min(3, profile.samples.length)} / 3`}>{[0, 1, 2].map(i => i < profile.samples.length ? <CheckCircle2 key={i} size={18}/> : <Circle key={i} size={18}/>)}</div>
    </div>
    <p className="voice-help">{zh ? '每段单独开始，12 秒自动停止。试听后点击「使用这一段」，再手动开始下一段。' : 'Start each clip yourself; it stops after 12 seconds. Preview, choose “Use this clip”, then start the next one manually.'}</p>
    <div className="speaker-samples">{profile.samples.map((sample, index) => <div className="speaker-sample" key={sample.id}>
      <CheckCircle2 size={17}/><div><strong>{zh ? `第 ${index + 1} 段` : `Clip ${index + 1}`}<small>{zh ? '已保存' : 'Saved'}{sample.voicedSeconds ? ` · ${sample.voicedSeconds.toFixed(1)}s` : ''}</small></strong><p>{sample.prompt || (zh ? '从原有声纹迁移的段落' : 'Migrated from your previous voice profile')}</p></div>
      <button type="button" disabled={disabled || occupied} aria-label={zh ? `管理第 ${index + 1} 段` : `Manage clip ${index + 1}`} title={zh ? '查看、编辑文字并重录' : 'View, edit text and re-record'} onClick={() => edit(index, sample)}><RotateCcw size={15}/></button>
      <button type="button" className="speaker-danger" disabled={disabled || occupied} aria-label={zh ? `删除第 ${index + 1} 段` : `Delete clip ${index + 1}`} onClick={() => { if (editor?.sampleId === sample.id) setEditor(undefined); onRemove(sample); }}><Trash2 size={15}/></button>
    </div>)}</div>
    {!editor && profile.samples.length < 8 && <button type="button" className="speaker-add-clip" disabled={disabled || occupied} onClick={() => edit(profile.samples.length)}><Plus size={16}/>{zh ? profile.samples.length === 0 ? '准备第一段' : profile.ready ? '补充一段语音' : '录制下一段' : profile.samples.length === 0 ? 'Prepare first clip' : profile.ready ? 'Add another clip' : 'Record next clip'}</button>}
    {editor && <div className={`speaker-recorder is-${phase}`} ref={editorElement}>
      <div className="speaker-section-heading"><strong>{zh ? `${profile.name} · 第 ${editor.index + 1} 段` : `${profile.name} · Clip ${editor.index + 1}`}</strong><span className="speaker-timer">{String(seconds).padStart(2, '0')} / 12s</span></div>
      <div className="speaker-recording-status" role="status">{phase === 'saving' || phase === 'starting' || phase === 'preparing' ? <LoaderCircle className="speaker-spinner" size={18}/> : phase === 'preview' ? <CheckCircle2 size={18}/> : <Mic size={18}/>}<strong>{status}</strong></div>
      <div className="speaker-meter" aria-hidden="true">{[.45, .7, 1, .8, .55, .9, .6, .8, .5].map((weight, i) => <i key={i} style={{ transform: `scaleY(${.12 + level * weight * .88})` }}/>)}</div>
      <label className="speaker-prompt">{zh ? '朗读文字（可以自行修改）' : 'Reading text (editable)'}<textarea aria-label={zh ? '朗读文字' : 'Reading text'} maxLength={500} rows={3} value={prompt} disabled={occupied} onChange={event => setPrompt(event.target.value)}/></label>
      <p className="voice-help">{phase === 'recording' ? zh ? '请正常说话，也可以提前点击「结束本段」。停止后不会自动开始下一段。' : 'Speak naturally, or click “Finish this clip” early. The next clip will not start automatically.'
        : phase === 'preview' ? zh ? '可以先试听。不满意只重录本段；点击使用后才会校验并保存。' : 'Preview first. Re-record only this clip if needed; verification starts when you choose to use it.'
        : editor.sampleId ? zh ? '原段落保持有效，只有新录音校验成功后才替换。原始录音未保留，无法回放已保存的段落。' : 'The old sample stays valid until the replacement passes verification. Saved raw recordings are not retained for playback.'
        : zh ? '建议每段说 8–12 秒，保持自然语气。这是当前人员的独立段落。' : 'Speak naturally for 8–12 seconds. This sample belongs only to the selected person.'}</p>
      {recording.previewUrl && phase === 'preview' && <audio ref={audio} aria-label={zh ? '试听本段录音' : 'Preview this recording'} controls src={recording.previewUrl}/>}
      {recording.error && <p className="voice-error" role="alert">{recording.error}</p>}
      <div className="voice-actions">
        {phase === 'idle' && <button type="button" className="speaker-primary" disabled={disabled || !prompt.trim()} onClick={() => void recording.begin()}><Mic size={16}/>{zh ? '开始本段录音' : 'Start this recording'}</button>}
        {phase === 'recording' && <button type="button" className="speaker-primary" onClick={recording.finish}><Square size={14}/>{zh ? '结束本段' : 'Finish this clip'}</button>}
        {phase === 'preview' && <><button type="button" className="speaker-primary" onClick={() => void save()}><Check size={16}/>{zh ? '使用这一段' : 'Use this clip'}</button><button type="button" onClick={() => void recording.begin()}><RotateCcw size={15}/>{zh ? '重录这一段' : 'Re-record this clip'}</button></>}
        <button type="button" onClick={() => { recording.cancel(); setEditor(undefined); }}>{zh ? occupied ? '取消本段' : '收起' : occupied ? 'Cancel this clip' : 'Close'}</button>
      </div>
    </div>}
    {notice && !editor && <p className="speaker-success" role="status"><CheckCircle2 size={16}/>{notice}</p>}
  </div>;
}
