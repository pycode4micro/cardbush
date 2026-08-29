import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BUSH_ACTION_MANIFEST_PROTOCOL,
  BUSH_MODEL_REQUEST_PROTOCOL,
  BUSH_TOOL_CALL_PROTOCOL,
} from '@cardbush/bush-protocol';
import { ToolRegistry } from '@cardbush/bush-runtime';
import { registerProductHostTools } from '../dist-electron/runtimeProductTools.mjs';

const root = await mkdtemp(join(tmpdir(), 'cardbush-runtime-product-tools-'));
try {
  const file = join(root, 'deliver.txt');
  await writeFile(file, 'deliver', 'utf8');
  const invoked = [];
  const registry = new ToolRegistry();
  registerProductHostTools(registry, async (request) => {
    invoked.push(request);
    return request.toolName === 'computer_use'
      ? {
          success: true,
          output: { path: 'C:\\captures\\screen.png' },
          paths: ['C:\\captures\\screen.png'],
          artifacts: [{
            artifact_id: 'artifact_screen',
            type: 'image',
            path: 'C:\\captures\\screen.png',
            metadata: { model_input: true },
          }],
        }
      : { success: true, output: { delivered: [file] }, paths: [file] };
  });

  const screenshot = registry.resolve('computer_use');
  const screenshotInput = screenshot.decodeInput({ action: 'screenshot' });
  const screenshotContext = context('computer_use', screenshot, screenshotInput, root);
  assert.deepEqual(await screenshot.authorize(screenshotContext), { kind: 'allow' });
  const screenshotResult = await screenshot.execute({ ...screenshotContext, capabilityIds: [] });
  assert.equal(screenshotResult.success, true);
  assert.equal(screenshotResult.artifacts[0].metadata.model_input, true);

  const clickInput = screenshot.decodeInput({ action: 'click', x: 10, y: 20 });
  const clickAdmission = await screenshot.authorize(context('computer_use', screenshot, clickInput, root));
  assert.equal(clickAdmission.kind, 'ask');
  assert.deepEqual(clickAdmission.request.actions, ['desktop.click']);

  const delivery = registry.resolve('transport_deliver');
  const deliveryInput = delivery.decodeInput({ deliverables: [{ path: 'deliver.txt' }], channel: 'telegram' });
  const deliveryContext = context('transport_deliver', delivery, deliveryInput, root);
  const deliveryAdmission = await delivery.authorize(deliveryContext);
  assert.equal(deliveryAdmission.kind, 'ask');
  assert.deepEqual(deliveryAdmission.request.resources, [file]);
  const deliveryResult = await delivery.execute({
    ...deliveryContext,
    capabilityIds: deliveryAdmission.request.capabilityIds,
  });
  assert.equal(deliveryResult.success, true);
  assert.equal(invoked.at(-1).input.paths[0], file);
  assert.equal(invoked.at(-1).input.channel, 'telegram');
  assert.throws(() => delivery.decodeInput({ deliverables: [] }), /between 1 and 6/);
  process.stdout.write('Runtime Product Host tools contract passed\n');
} finally {
  await rm(root, { recursive: true, force: true });
}

function context(name, registration, input, projectDir) {
  const toolCall = {
    protocol: BUSH_TOOL_CALL_PROTOCOL,
    id: `call_${name}`,
    name,
    argumentsText: '{}',
  };
  return {
    requestId: 'request',
    sessionId: 'session',
    turnId: 'turn',
    toolCall,
    input,
    actionManifest: {
      protocol: BUSH_ACTION_MANIFEST_PROTOCOL,
      manifest_id: `manifest_${name}`,
      ...registration.manifest,
    },
    turn: {
      request: {
        protocol: BUSH_MODEL_REQUEST_PROTOCOL,
        requestId: 'request',
        sessionId: 'session',
        turnId: 'turn',
        model: 'model',
        messages: [],
        tools: [],
        toolChoice: 'auto',
        metadata: { projectDir, permissionMode: 'task_free' },
      },
      contextMessages: [],
    },
  };
}
