import anthropicLogo from '../../assets/model-logos/anthropic.svg';
import azureLogo from '../../assets/model-logos/azure.svg';
import claudeLogo from '../../assets/model-logos/claude.svg';
import deepseekLogo from '../../assets/model-logos/deepseek.svg';
import geminiLogo from '../../assets/model-logos/gemini.svg';
import googleLogo from '../../assets/model-logos/google.svg';
import huggingfaceLogo from '../../assets/model-logos/huggingface.svg';
import metaLogo from '../../assets/model-logos/meta.svg';
import minimaxLogo from '../../assets/model-logos/minimax.svg';
import mistralLogo from '../../assets/model-logos/mistral.svg';
import moonshotLogo from '../../assets/model-logos/moonshot.svg';
import nvidiaLogo from '../../assets/model-logos/nvidia.svg';
import ollamaLogo from '../../assets/model-logos/ollama.svg';
import openaiLogo from '../../assets/model-logos/openai.svg';
import openrouterLogo from '../../assets/model-logos/openrouter.svg';
import perplexityLogo from '../../assets/model-logos/perplexity.svg';
import qwenLogo from '../../assets/model-logos/qwen.svg';
import xaiLogo from '../../assets/model-logos/xai.svg';
import xiaomiLogo from '../../assets/model-logos/xiaomi.svg';
import zhipuLogo from '../../assets/model-logos/zhipu.svg';

export type ModelLogoInfo = {
  id: string;
  label: string;
  src: string;
};

const modelLogoRules: Array<{
  id: string;
  label: string;
  src: string;
  patterns: RegExp[];
}> = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    src: deepseekLogo,
    patterns: [/deepseek/i],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    src: openaiLogo,
    patterns: [/\b(gpt|chatgpt|openai|o[1345](?:-|$))/i],
  },
  {
    id: 'claude',
    label: 'Claude',
    src: claudeLogo,
    patterns: [/claude/i],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    src: anthropicLogo,
    patterns: [/anthropic/i],
  },
  {
    id: 'zhipu',
    label: 'Zhipu AI',
    src: zhipuLogo,
    patterns: [/\bglm\b/i, /zhipu/i, /智谱/i, /bigmodel/i, /chatglm/i],
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    src: minimaxLogo,
    patterns: [/minimax/i, /abab/i, /\bmm-?0?1\b/i],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    src: geminiLogo,
    patterns: [/gemini/i],
  },
  {
    id: 'qwen',
    label: 'Qwen',
    src: qwenLogo,
    patterns: [/qwen/i, /\bqwq\b/i, /dashscope/i, /tongyi/i, /通义/i],
  },
  {
    id: 'xiaomi',
    label: 'Xiaomi',
    src: xiaomiLogo,
    patterns: [/\bmimo\b/i, /mi-?mo/i, /xiaomi/i, /小米/i],
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    src: mistralLogo,
    patterns: [/mistral/i, /mixtral/i, /codestral/i],
  },
  {
    id: 'moonshot',
    label: 'Moonshot AI',
    src: moonshotLogo,
    patterns: [/moonshot/i, /\bkimi\b/i],
  },
  {
    id: 'xai',
    label: 'xAI',
    src: xaiLogo,
    patterns: [/\bgrok\b/i, /\bxai\b/i, /x-ai/i],
  },
  {
    id: 'meta',
    label: 'Meta',
    src: metaLogo,
    patterns: [/llama/i, /\bmeta\b/i],
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    src: perplexityLogo,
    patterns: [/perplexity/i, /\bsonar\b/i],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    src: openrouterLogo,
    patterns: [/openrouter/i],
  },
  {
    id: 'ollama',
    label: 'Ollama',
    src: ollamaLogo,
    patterns: [/ollama/i],
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    src: huggingfaceLogo,
    patterns: [/huggingface/i, /\bhf[/:]/i],
  },
  {
    id: 'nvidia',
    label: 'NVIDIA',
    src: nvidiaLogo,
    patterns: [/nvidia/i, /nemotron/i],
  },
  {
    id: 'azure',
    label: 'Azure',
    src: azureLogo,
    patterns: [/azure/i],
  },
  {
    id: 'google',
    label: 'Google',
    src: googleLogo,
    patterns: [/palm/i, /vertex/i, /\bgoogle\b/i],
  },
];

export function modelLogoFor(modelName: string): ModelLogoInfo | null {
  const normalized = modelName.trim();
  if (!normalized) {
    return null;
  }
  const match = modelLogoRules.find((rule) =>
    rule.patterns.some((pattern) => pattern.test(normalized)),
  );
  return match
    ? {
        id: match.id,
        label: match.label,
        src: match.src,
      }
    : null;
}
