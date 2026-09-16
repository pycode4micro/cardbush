// Explicit saved catalog for compatibility tests of pre-incremental sessions.
export const orderedCheckpointTool = {
  name: 'checkpoint_context', description: 'Fill the ordered summary slots requested by context_pressure.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['summaries'], properties: {
    summaries: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 6000 } },
  } },
};
