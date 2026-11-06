export type Model = {
  id: string;
  name: string;
  model: string;
  baseURL: string;
  apiProtocol: string;
  enabled: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
  reasoningEffort: string | null;
  hasApiKey: boolean;
};
export type Settings = {
  revision: number;
  defaultModelId: string;
  models: Model[];
  imageModel: { model: string; hasApiKey: boolean } | null;
};

export type ModelEditorProps = {
  value: Model | null;
  isDefault: boolean;
  busy: boolean;
  error: string;
  close: () => void;
  save: (model: unknown) => Promise<boolean>;
};
export type ImageModelProps = {
  value: Settings["imageModel"];
  busy: boolean;
  save: (input: Record<string, unknown>) => Promise<boolean>;
};
