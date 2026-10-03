import { useEffect, useRef, useState } from 'react';
import type { SpeakerLockStatus, SpeakerSampleInput } from '../../../electron/voiceTypes';
import { VoiceCapture } from './voiceAudio';
import { prepareVoiceRecording } from './voiceRecording';
import { endVoiceForEnrollment } from './voiceSession';
import { voiceError } from './voiceError';

export type SpeakerRecordingPhase = 'idle' | 'starting' | 'recording' | 'preparing' | 'preview' | 'saving';
/** A single explicit recording. No automatic next segment and no retained raw audio on disk. */
export function useSpeakerRecording(microphoneId: string, onNeedModel: () => void) {
  const api = window.cardbushDesktop?.voice;
  const [phase, setPhase] = useState<SpeakerRecordingPhase>('idle');
  const [seconds, setSeconds] = useState(0), [level, setLevel] = useState(0), [error, setError] = useState(''), [previewUrl, setPreviewUrl] = useState('');
  const capture = useRef<VoiceCapture | undefined>(undefined), timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const epoch = useRef(0), request = useRef(''), url = useRef(''), audio = useRef<ArrayBuffer | undefined>(undefined);
  const close = () => { clearInterval(timer.current); capture.current?.close(); capture.current = undefined; };
  const releasePreview = () => { if (url.current) URL.revokeObjectURL(url.current); url.current = ''; audio.current = undefined; };
  useEffect(() => () => { epoch.current++; close(); releasePreview(); if (request.current) void api?.cancel(request.current).catch(() => {}); }, [api]);
  const cancel = () => {
    epoch.current++; close(); releasePreview(); setPreviewUrl(''); setPhase('idle'); setLevel(0); setSeconds(0); setError('');
    if (request.current) void api?.cancel(request.current).catch(() => {}); request.current = '';
  };
  const finish = () => { clearInterval(timer.current); setPhase('preparing'); setLevel(0); capture.current?.finish(); };
  const begin = async () => {
    if (!api) return;
    cancel(); const current = epoch.current; setPhase('starting');
    try {
      const model = await api.modelStatus('speaker');
      if (current !== epoch.current) return;
      if (model.state !== 'installed') { onNeedModel(); throw Error('请先展开「本地模型」，下载并安装 CAMPPlus。'); }
      endVoiceForEnrollment();
      const recorder = new VoiceCapture('recording', {
        level: value => { if (current === epoch.current) setLevel(value); }, speech: () => {},
        error: message => { if (current === epoch.current) { epoch.current++; close(); setPhase('idle'); setLevel(0); setError(message); } },
        clip: blob => {
          if (current !== epoch.current) return;
          close(); setPhase('preparing'); setLevel(0);
          void prepareVoiceRecording(blob, 'system').then(prepared => {
            if (current !== epoch.current) return;
            audio.current = prepared.audio; url.current = URL.createObjectURL(blob); setPreviewUrl(url.current); setPhase('preview');
          }).catch(error => { if (current === epoch.current) { setPhase('idle'); setError(voiceError(error, '无法处理本段录音，请重录。')); } });
        },
      }, microphoneId);
      capture.current = recorder; await recorder.start();
      if (current !== epoch.current) { recorder.close(); return; }
      setPhase('recording'); const started = Date.now();
      timer.current = setInterval(() => {
        if (current !== epoch.current) return;
        const elapsed = Math.floor((Date.now() - started) / 1000); setSeconds(Math.min(12, elapsed));
        if (elapsed >= 12) finish();
      }, 200);
    } catch (error) { if (current === epoch.current) { close(); setPhase('idle'); setError(voiceError(error, '无法开始录音。')); } }
  };
  const save = async (input: Omit<SpeakerSampleInput, 'id' | 'audio'>): Promise<SpeakerLockStatus | undefined> => {
    if (!api || !audio.current || request.current) return;
    const current = epoch.current, id = crypto.randomUUID(); request.current = id; setPhase('saving'); setError('');
    try {
      const result = await api.saveSpeakerSample({ ...input, id, audio: audio.current });
      if (current !== epoch.current) return;
      releasePreview(); setPreviewUrl(''); setPhase('idle'); return result;
    } catch (error) { if (current === epoch.current) { setPhase('preview'); setError(voiceError(error, '本段未保存，可以重试或只重录这一段。')); } }
    finally { if (current === epoch.current) request.current = ''; }
  };
  return { phase, seconds, level, error, previewUrl, begin, finish, cancel, save };
}
