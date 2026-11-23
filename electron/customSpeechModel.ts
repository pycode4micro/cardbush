import { NativeVoiceError } from './voiceUiError';
import fs from 'node:fs';
import path from 'node:path';
import { defaultCustomSpeechSettings, type CustomSpeechModelInfo, type CustomSpeechSettings } from './voiceTypes';

export function validateCustomSpeech(input?: CustomSpeechSettings): CustomSpeechSettings {
  const value = { ...defaultCustomSpeechSettings, ...input };
  for (const [field, limit] of [['directory', 4096], ['pythonPath', 4096], ['femaleVoice', 100], ['maleVoice', 100], ['instruction', 1000]] as const) {
    if (typeof value[field] !== 'string' || value[field].length > limit || /[\x00\r\n]/.test(value[field])) throw new NativeVoiceError('voiceNative.customSpeechInvalid');
    value[field] = value[field].trim();
  }
  for (const field of ['directory', 'pythonPath'] as const) if (value[field] && !path.isAbsolute(value[field])) throw new NativeVoiceError('voiceNative.customPathAbsolute');
  if (!['Auto', 'Chinese', 'English'].includes(value.language) || !['auto', 'cpu', 'cuda'].includes(value.device)) throw new NativeVoiceError('voiceNative.customDeviceInvalid');
  return value;
}

function file(directory: string, name: string, maxBytes = 16 * 1024 ** 3) {
  const target = path.join(directory, name);
  try { const stat = fs.statSync(target); if (stat.isFile() && stat.size > 0 && stat.size <= maxBytes) return stat; } catch {}
  throw new NativeVoiceError('voiceNative.customModelFileMissing', { name });
}
function json(directory: string, name: string) {
  file(directory, name, 2 * 1024 * 1024);
  try { return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); }
  catch { throw new NativeVoiceError('voiceNative.customModelConfigUnreadable', { name }); }
}
function weights(directory: string) {
  if (fs.existsSync(path.join(directory, 'model.safetensors'))) { file(directory, 'model.safetensors'); return; }
  const index = json(directory, 'model.safetensors.index.json');
  if (!index?.weight_map || typeof index.weight_map !== 'object') throw new NativeVoiceError('voiceNative.customModelIndexInvalid');
  const names = [...new Set(Object.values(index.weight_map))];
  if (!names.length || names.length > 128) throw new NativeVoiceError('voiceNative.customModelIndexInvalid');
  for (const name of names) {
    if (typeof name !== 'string' || !/^[\w.-]+\.safetensors$/.test(name)) throw new NativeVoiceError('voiceNative.customModelIndexPathInvalid');
    file(directory, name);
  }
}
function nearbyPython(directory: string) {
  let parent = directory;
  for (let level = 0; level < 4; level++) {
    const candidate = path.join(parent, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
    const next = path.dirname(parent); if (next === parent) break; parent = next;
  }
  return undefined;
}

/** Inspect data files only. Never import code or download files from a selected directory. */
export function inspectCustomSpeechModel(directory: string, runtimeAvailable = false): CustomSpeechModelInfo {
  directory = validateCustomSpeech({ ...defaultCustomSpeechSettings, directory }).directory;
  if (!directory) throw new NativeVoiceError('voiceNative.customModelDirectoryRequired');
  try { if (!fs.statSync(directory).isDirectory()) throw Error(); }
  catch { throw new NativeVoiceError('voiceNative.customModelDirectoryUnavailable'); }
  if (fs.existsSync(path.join(directory, 'config.json'))) {
    const config = json(directory, 'config.json');
    if (config?.model_type !== 'qwen3_tts' || config.tts_model_type !== 'custom_voice' || config.tokenizer_type !== 'qwen3_tts_tokenizer_12hz') {
      throw new NativeVoiceError('voiceNative.qwenArchitectureUnsupported');
    }
    for (const name of ['tokenizer_config.json', 'preprocessor_config.json', 'vocab.json', 'merges.txt', 'generation_config.json', 'speech_tokenizer/config.json', 'speech_tokenizer/preprocessor_config.json']) file(directory, name);
    // Model folders are data, not extension packages; forbid auto-loaded custom Python classes.
    for (const name of ['config.json', 'tokenizer_config.json', 'preprocessor_config.json', 'speech_tokenizer/config.json', 'speech_tokenizer/preprocessor_config.json']) {
      if (json(directory, name)?.auto_map) throw new NativeVoiceError('voiceNative.customModelCodeUnsupported');
    }
    weights(directory); weights(path.join(directory, 'speech_tokenizer'));
    const speakers = config.talker_config?.spk_id;
    if (!speakers || typeof speakers !== 'object' || Array.isArray(speakers)) throw new NativeVoiceError('voiceNative.customModelNoVoices');
    const ids = Object.keys(speakers);
    if (!ids.length || ids.length > 512 || ids.some(id => !/^[a-zA-Z0-9_-]{1,80}$/.test(id))) throw new NativeVoiceError('voiceNative.customModelVoicesInvalid');
    const suggestedPythonPath = nearbyPython(directory);
    return { kind: 'qwen3-customvoice', name: `Qwen3-TTS CustomVoice (${config.tts_model_size === '1b7' ? '1.7B' : config.tts_model_size === '0b6' ? '0.6B' : 'local'})`,
      directory, voices: ids.map(id => ({ id, name: id })), defaultFemaleVoice: ids.includes('serena') ? 'serena' : ids[0],
      defaultMaleVoice: ids.includes('uncle_fu') ? 'uncle_fu' : ids[0], supportsInstructions: config.tts_model_size === '1b7',
      suggestedPythonPath, runtimeAvailable: Boolean(suggestedPythonPath) };
  }
  const modelFile = kokoroModelFile(directory);
  file(directory, modelFile);
  for (const name of ['tokens.txt', 'lexicon-us-en.txt', 'lexicon-zh.txt', 'date-zh.fst', 'number-zh.fst', 'phone-zh.fst']) file(directory, name);
  try { if (!fs.statSync(path.join(directory, 'espeak-ng-data')).isDirectory()) throw Error(); }
  catch { throw new NativeVoiceError('voiceNative.customKokoroEspeakMissing'); }
  const bank = file(directory, 'voices.bin', 1024 ** 3), count = bank.size / (510 * 256 * 4);
  if (!Number.isInteger(count) || count < 1 || count > 512) throw new NativeVoiceError('voiceNative.customKokoroVoicesInvalid');
  return { kind: 'kokoro', name: 'Kokoro (sherpa-onnx Chinese/English)', directory,
    voices: Array.from({ length: count }, (_, sid) => ({ id: String(sid), name: `sid ${sid}` })),
    defaultFemaleVoice: count === 103 ? '3' : '0', defaultMaleVoice: count === 103 ? '58' : '0', supportsInstructions: false, runtimeAvailable };
}
export function kokoroModelFile(directory: string) {
  return fs.existsSync(path.join(directory, 'model.int8.onnx')) ? 'model.int8.onnx' : 'model.onnx';
}
