/** Decode the browser recording on this device for the Windows dictation engine. */
export async function prepareVoiceRecording(blob: Blob, engine: 'system' | 'sensevoice' | 'cloud') {
  const audio = await blob.arrayBuffer();
  if (engine === 'cloud') return { audio, mimeType: blob.type };
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(audio);
    if (!decoded.length || decoded.duration > 121) throw Error('录音过长，请缩短到两分钟以内。');
    const rendering = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
    const source = rendering.createBufferSource(); source.buffer = decoded; source.connect(rendering.destination); source.start();
    const converted = await rendering.startRendering();
    return { audio: pcmWave(converted.getChannelData(0), 16000), mimeType: 'audio/wav' };
  } finally { await context.close(); }
}

export function pcmWave(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const audio = new ArrayBuffer(44 + samples.length * 2), view = new DataView(audio);
  const label = (offset: number, text: string) => [...text].forEach((value, index) => view.setUint8(offset + index, value.charCodeAt(0)));
  label(0, 'RIFF'); view.setUint32(4, audio.byteLength - 8, true); label(8, 'WAVE'); label(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  label(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const value = Math.max(-1, Math.min(1, samples[i])); view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true); }
  return audio;
}
