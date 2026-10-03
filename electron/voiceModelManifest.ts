import type { VoiceDownload } from './voiceModelDownload';

export interface VoiceModelFile extends Pick<VoiceDownload, 'bytes' | 'sha256'> { entry: string; name: string }
export interface VoiceModelArchive extends VoiceDownload { files: VoiceModelFile[]; allFilesInOrder?: boolean }
// Archive digests are pinned from the upstream GitHub Release API. File digests
// were derived only after those archives passed verification (2026-10-03).
export const voiceModelVersion = 'sensevoice-2024-07-17-sherpa-1.13.8';
export const voiceModelSources = [
  { title: 'SenseVoice · FunAudioLLM / Alibaba', url: 'https://github.com/QwenAudio/SenseVoice' },
  { title: 'sherpa-onnx · 官方运行库与模型转换', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.8' },
  { title: '模型许可证', url: 'https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE' },
];
// The 2025-09-09 package is a Cantonese fine-tune, not the bilingual base model.
const modelRoot = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
const model: VoiceModelArchive = {
  url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${modelRoot}.tar.bz2`,
  bytes: 163002883, sha256: '7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e',
  files: [
    { entry: `${modelRoot}/model.int8.onnx`, name: 'model.int8.onnx', bytes: 239233841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
    { entry: `${modelRoot}/tokens.txt`, name: 'tokens.txt', bytes: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' },
  ],
};
export function voiceModelManifest(platform = process.platform, arch = process.arch): VoiceModelArchive[] {
  if (arch !== 'x64') return [];
  const root = platform === 'win32' ? 'sherpa-onnx-v1.13.8-win-x64-shared-MT-Release-no-tts' : 'sherpa-onnx-v1.13.8-linux-x64-shared-no-tts';
  if (platform === 'win32') return [{
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/${root}.tar.bz2`,
    bytes: 23271851, sha256: '4b0a94f7b5c606b1b64a19a831c2127559e4b3d34e195465ebc7be73d9ed4783',
    files: [
      { entry: `${root}/bin/sherpa-onnx-offline.exe`, name: 'sherpa-onnx-offline.exe', bytes: 2421760, sha256: 'e93182fc262658b5bc31afc98ba952b104440a6c8f3d44dd43a2fc20eb400455' },
      { entry: `${root}/bin/onnxruntime.dll`, name: 'onnxruntime.dll', bytes: 17799168, sha256: '7f66f939a881baf4f46a2216496798edf4a1429878b646d12674aa62f27d8a25' },
      { entry: `${root}/bin/onnxruntime_providers_shared.dll`, name: 'onnxruntime_providers_shared.dll', bytes: 104960, sha256: '551d0e1fe4c227d8542314ba718d52f4379e0c7bfe729a37c59833a884e27b4d' },
    ],
  }, model];
  if (platform === 'linux') return [{
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/${root}.tar.bz2`,
    bytes: 24802494, sha256: 'd0f96c8b65c6cd0974fada22737e337de81bc8cd2abbec2e39caf358b1eec5fc',
    files: [
      { entry: `${root}/bin/sherpa-onnx-offline`, name: 'sherpa-onnx-offline', bytes: 2509672, sha256: '95fb2157ba97830a57197129b19fbd93416b5c24be0ce5a23c47c834d8766aba' },
      { entry: `${root}/lib/libonnxruntime.so`, name: 'libonnxruntime.so', bytes: 27026609, sha256: '4b3607aebd1784b26b6f9b20e4bd974c7ab8287043e4d095cb7d2cb40b5e566e' },
    ],
  }, model];
  return [];
}
