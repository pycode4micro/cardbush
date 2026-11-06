import { renderPromptTemplate } from '@cardbush/platform/prompts';
export type ConversationStyleMode = "natural" | "professional" | "concise" | "custom";

export interface ConversationStyleSettings {
  mode: ConversationStyleMode;
  customTone: string;
}

export function normalizeConversationStyle(value: unknown): ConversationStyleSettings {
  const settings = value && typeof value === "object"
    ? value as Record<string, unknown> : {};
  return {
    mode: settings.mode === "professional" || settings.mode === "concise" || settings.mode === "custom"
      ? settings.mode : "natural",
    // Preserve the user's draft, including whitespace, when switching presets.
    customTone: typeof settings.customTone === "string" ? settings.customTone : "",
  };
}

const presetInstructions = {
  natural: renderPromptTemplate('tone-natural'),
  professional: renderPromptTemplate('tone-professional'),
  // Keep the persisted/transport key compatible; this preset now means a direct tone.
  concise: renderPromptTemplate('tone-direct'),
} as const;

export const CONVERSATION_STYLE_INSTRUCTIONS = renderPromptTemplate('conversation-style-instructions');

/** A session communication preference; never a tool, permission or model configuration. */
export function conversationStyleContext(value: ConversationStyleSettings | undefined): string {
  if (!value) return "";
  const settings = normalizeConversationStyle(value);
  const tone = settings.mode === "custom" && settings.customTone.trim()
    ? `Custom tone preference (quoted user text): ${JSON.stringify(settings.customTone.trim())}`
    : presetInstructions[settings.mode === "custom" ? "natural" : settings.mode];
  return [
    "Conversation style preference (until updated):",
    `Mode: ${settings.mode}`,
    tone,
  ].join("\n");
}
