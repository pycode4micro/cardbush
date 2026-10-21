export type ToolActionRules = Record<string, { required: readonly string[]; optional?: readonly string[] }>;

export function actionFieldSchema(rules: ToolActionRules, defaultAction?: string) {
  return { type: 'string', enum: Object.keys(rules), ...(defaultAction ? { default: defaultAction } : {}),
    description: Object.entries(rules).map(([action, rule]) => `${action}: ${rule.required.length ? `requires ${rule.required.join(', ')}` : 'no required fields'}${rule.optional?.length ? `; optional ${rule.optional.join(', ')}` : ''}; other fields are rejected.`).join(' ') };
}

/** Shared action/field contract; tools still own value and state validation. */
export function validateActionFields<R extends ToolActionRules>(input: Record<string, unknown>, rules: R, label: string, defaultAction?: keyof R): keyof R & string {
  const action = input.action === undefined ? defaultAction : input.action;
  if (typeof action !== 'string' || !Object.hasOwn(rules, action)) throw new Error(`Invalid ${label} action. Expected ${Object.keys(rules).join(', ')}.`);
  const rule = rules[action]!, fields = [...rule.required, ...rule.optional ?? []];
  if (Object.keys(input).some(key => key !== 'action' && !fields.includes(key))) throw new Error(`Invalid ${label} arguments for action=${action}. Accepted fields: ${fields.join(', ') || '(none)'}.`);
  for (const field of rule.required) if (input[field] === undefined) throw new Error(`${label} action=${action} requires ${field}.`);
  return action;
}
