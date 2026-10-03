import fs from 'node:fs';
import path from 'node:path';
import { defaultCustomSpeechSettings, type CustomSpeechModelInfo, type CustomSpeechSettings } from './voiceTypes';

export function validateCustomSpeech(input?: CustomSpeechSettings): CustomSpeechSettings {
  const value = { ...defaultCustomSpeechSettings, ...input };
  for (const [field, limit] of [['directory', 4096], ['pythonPath', 4096], ['femaleVoice', 100], ['maleVoice', 100], ['instruction', 1000]] as const) {
    if (typeof value[field] !== 'string' || value[field].length > limit || /[\x00\r\n]/.test(value[field])) throw Error('自定义朗读配置无效。');
    value[field] = value[field].trim();
  }
  for (const field of ['directory', 'pythonPath'] as const) if (value[field] && !path.isAbsolute(value[field])) throw Error('请选择本机的完整模型或 Python 路径。');
  if (!['Auto', 'Chinese', 'English'].includes(value.language) || !['auto', 'cpu', 'cuda'].includes(value.device)) throw Error('自定义朗读语言或计算设备无效。');
  return value;
}

function file(directory: string, name: string, maxBytes = 16 * 1024 ** 3) {
  const target = path.join(directory, name);
  try { const stat = fs.statSync(target); if (stat.isFile() && stat.size > 0 && stat.size <= maxBytes) return stat; } catch {}
  throw Error(`模型目录缺少有效文件：${name}`);
}
function json(directory: string, name: string) {
  file(directory, name, 2 * 1024 * 1024);
  try { return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); }
  catch { throw Error(`模型配置无法读取：${name}`); }
}
function weights(directory: string) {
  if (fs.existsSync(path.join(directory, 'model.safetensors'))) { file(directory, 'model.safetensors'); return; }
  const index = json(directory, 'model.safetensors.index.json');
  if (!index?.weight_map || typeof index.weight_map !== 'object') throw Error('模型权重索引无效。');
  const names = [...new Set(Object.values(index.weight_map))];
  if (!names.length || names.length > 128) throw Error('模型权重索引无效。');
  for (const name of names) {
    if (typeof name !== 'string' || !/^[\w.-]+\.safetensors$/.test(name)) throw Error('模型权重索引包含不支持的路径。');
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
  if (!directory) throw Error('请先选择本地模型目录。');
  try { if (!fs.statSync(directory).isDirectory()) throw Error(); }
  catch { throw Error('模型目录不存在或无法访问，请重新选择。'); }
  if (fs.existsSync(path.join(directory, 'config.json'))) {
    const config = json(directory, 'config.json');
    if (config?.model_type !== 'qwen3_tts' || config.tts_model_type !== 'custom_voice' || config.tokenizer_type !== 'qwen3_tts_tokenizer_12hz') {
      throw Error('此入口支持 Qwen3-TTS 12Hz CustomVoice；Base、VoiceDesign 和其他架构暂不支持。');
    }
    for (const name of ['tokenizer_config.json', 'preprocessor_config.json', 'vocab.json', 'merges.txt', 'generation_config.json', 'speech_tokenizer/config.json', 'speech_tokenizer/preprocessor_config.json']) file(directory, name);
    // Model folders are data, not extension packages; forbid auto-loaded custom Python classes.
    for (const name of ['config.json', 'tokenizer_config.json', 'preprocessor_config.json', 'speech_tokenizer/config.json', 'speech_tokenizer/preprocessor_config.json']) {
      if (json(directory, name)?.auto_map) throw Error('该模型需要自定义 Python 类，当前本地模型入口不执行目录中的代码。');
    }
    weights(directory); weights(path.join(directory, 'speech_tokenizer'));
    const speakers = config.talker_config?.spk_id;
    if (!speakers || typeof speakers !== 'object' || Array.isArray(speakers)) throw Error('模型没有可用的预设音色。');
    const ids = Object.keys(speakers);
    if (!ids.length || ids.length > 512 || ids.some(id => !/^[a-zA-Z0-9_-]{1,80}$/.test(id))) throw Error('模型预设音色列表无效。');
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
  catch { throw Error('Kokoro 模型目录缺少 espeak-ng-data。'); }
  const bank = file(directory, 'voices.bin', 1024 ** 3), count = bank.size / (510 * 256 * 4);
  if (!Number.isInteger(count) || count < 1 || count > 512) throw Error('Kokoro voices.bin 不是支持的 sherpa-onnx 音色格式。');
  return { kind: 'kokoro', name: 'Kokoro (sherpa-onnx Chinese/English)', directory,
    voices: Array.from({ length: count }, (_, sid) => ({ id: String(sid), name: `sid ${sid}` })),
    defaultFemaleVoice: count === 103 ? '3' : '0', defaultMaleVoice: count === 103 ? '58' : '0', supportsInstructions: false, runtimeAvailable };
}
export function kokoroModelFile(directory: string) {
  return fs.existsSync(path.join(directory, 'model.int8.onnx')) ? 'model.int8.onnx' : 'model.onnx';
}
