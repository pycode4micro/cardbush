import { voiceModelManifest } from './voiceModelManifest';
import { voiceModelLicenses } from './voiceModelLicenses';
import type { VoiceModelDefinition } from './voiceModelStore';

export const speakerVersion = 'campplus-2024-10-14-sherpa-1.13.8';
// Model digest measured from the official release over HTTPS, 2026-10-03.
// Runtime archive digest is the same pinned release already used by SenseVoice.
export function speakerDefinition(platform = process.platform, arch = process.arch): VoiceModelDefinition {
  const runtime = voiceModelManifest('win32', 'x64')[0];
  const root = 'sherpa-onnx-v1.13.8-win-x64-shared-MT-Release-no-tts';
  const weights = { entry: 'campplus.onnx', name: 'campplus.onnx', bytes: 28281138, sha256: 'f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11' };
  return {
    version: speakerVersion, model: 'CAMPPlus · 声纹验证',
    sources: [
      { title: 'CAMPPlus · 3D-Speaker', url: 'https://github.com/modelscope/3D-Speaker' },
      { title: 'sherpa-onnx 官方声纹模型', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models' },
      { title: '模型来源与许可', url: 'https://modelscope.cn/models/iic/speech_campplus_sv_zh-cn_16k-common' },
    ],
    archives: platform !== 'win32' || arch !== 'x64' ? [] : [
      { ...runtime, files: [
        ...runtime.files.filter(file => file.name.endsWith('.dll')),
        { entry: `${root}/lib/sherpa-onnx-c-api.dll`, name: 'sherpa-onnx-c-api.dll', bytes: 3249664, sha256: '86c7807d12982aa31c5cae57c686f30df9e5d5db4309b314d1efd5c873a8333c' },
      ] },
      { url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
        bytes: weights.bytes, sha256: weights.sha256, format: 'raw', files: [weights] },
    ],
    licenses: { 'sherpa-onnx-LICENSE.txt': voiceModelLicenses['sherpa-onnx-LICENSE.txt'], 'onnxruntime-LICENSE.txt': voiceModelLicenses['onnxruntime-LICENSE.txt'],
      'CAMPPlus-LICENSE.txt': voiceModelLicenses['sherpa-onnx-LICENSE.txt'] },
    attribution: 'CAMPPlus speaker embedding model by 3D-Speaker / Alibaba.\nModel conversion and runtime by sherpa-onnx.\nONNX Runtime by Microsoft.\n',
  };
}
