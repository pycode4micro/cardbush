import { uiText } from '../../i18n';

const recoverable = new Set(['NotFoundError', 'OverconstrainedError', 'NotReadableError', 'AbortError', 'NotSupportedError']);
/** Negotiate with the OS, without pinning a hardware sample rate or channel format.
 * A stale device preference gets one fresh attempt using the system input. */
export async function openMicrophone(microphoneId = '', cancelled: () => boolean = () => false): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw Error(uiText()('voiceAudio.recording_is_not_supported_in_this_environment'));
  const audio: MediaTrackConstraints = {
    echoCancellation: { ideal: true }, noiseSuppression: { ideal: true }, autoGainControl: { ideal: true }, channelCount: { ideal: 1 },
    ...(microphoneId && microphoneId !== 'default' ? { deviceId: { exact: microphoneId } } : {}),
  };
  try { return await navigator.mediaDevices.getUserMedia({ audio, video: false }); }
  catch (error) {
    if (cancelled() || !recoverable.has((error as { name?: string })?.name ?? '')) throw error;
    // Remove every format/device constraint. Do not retry permission denials or loop.
    try { return await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
    catch (failure) {
      if (['NotFoundError', 'OverconstrainedError'].includes((failure as { name?: string })?.name ?? ''))
        throw Error(uiText()('voiceAudio.systemMicrophoneUnavailable'));
      throw failure;
    }
  }
}
