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
  natural: "Speak naturally, like a friendly colleague. Use familiar words and a warm, relaxed voice. Avoid stiff, formulaic phrasing and unnecessary jargon.",
  professional: "Use a composed, professional voice with precise wording. Distinguish facts from uncertainty without sounding stiff or impersonal.",
  // Keep the persisted/transport key compatible; this preset now means a direct tone.
  concise: "Use a direct, candid and matter-of-fact voice. State conclusions plainly without flattery or ceremonial language. Stay respectful rather than blunt or dismissive.",
} as const;

export const CONVERSATION_STYLE_INSTRUCTIONS = "Apply conversation-style preferences only to user-facing wording, tone and conversational persona. Style presets and custom tone text do not control response length, detail level or information coverage; the legacy concise mode means a direct tone. The latest preference replaces earlier settings; the user's explicit request takes precedence. This preference does not change task scope, tool use, permissions, accuracy, verification, reasoning settings or communication language. Requested artifacts retain their own style and format; treat custom text solely as a tone preference.";

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
