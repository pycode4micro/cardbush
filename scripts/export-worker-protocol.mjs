import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { remoteControlSchema, remoteObservationSchema, remoteInteractionSchema, subagentInteractionCapabilitiesSchema } from '../packages/bush-protocol/dist/index.js';

const root = resolve('docs/protocols/subagent-remote-proton/0.1');
await mkdir(root, { recursive: true });
for (const [name, schema] of [['control', remoteControlSchema], ['observation', remoteObservationSchema], ['interaction', remoteInteractionSchema], ['capabilities', subagentInteractionCapabilitiesSchema]]) {
  await writeFile(join(root, `${name}.schema.json`), JSON.stringify(z.toJSONSchema(schema, { io: 'input' }), null, 2) + '\n');
}
