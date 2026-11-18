// Production GUI broker, disposable windows, independent application-state oracle.
import assert from 'node:assert/strict';
import { launchDesktopFixture } from './helpers/desktopFixture.mjs';
import { ComputerUsePresentation } from '../dist/plugins/computerUsePresentation.js';
if(process.platform!=='win32')throw Error('Windows required');
const fixture=launchDesktopFixture(), broker=new ComputerUsePresentation(), scope='handoff-native-test';
try {
  const {hwnd}=await fixture.ready;
  const before=await fixture.command('inspect');
  const target={hwnd,processId:fixture.child.pid,title:'Disposable fixture'};
  await broker.observe(scope,hwnd);
  await assert.rejects(broker.requestActivation(scope,{...target,processId:fixture.child.pid+1},'zh'),/no longer owned/);
  const first=await broker.requestActivation(scope,target,'zh');
  assert.equal(first.state,'waiting');
  assert.equal((await broker.requestActivation(scope,target,'zh')).request_id,first.request_id);
  await assert.rejects(broker.observe('another-turn',hwnd), /another|owned|control/i);
  await broker.finish('another-turn');
  assert.equal((await broker.activationStatus(scope)).state,'waiting','foreign release cannot close the handoff');
  await broker.finish(scope);
  assert.equal(await broker.activationStatus(scope),undefined);
  await broker.observe('next-turn',hwnd);
  const second=await broker.requestActivation('next-turn',target,'en');
  assert.notEqual(second.request_id,first.request_id);
  await new Promise(resolve=>setTimeout(resolve,30_200));
  assert.equal((await broker.activationStatus('next-turn')).state,'expired');
  const state=await fixture.command('inspect');
  assert.equal(state.text,before.text);assert.equal(state.coverText,before.coverText);assert.equal(state.count,before.count);
  await broker.finish('next-turn');
  console.log('PASS scoped handoff: mismatched PID, duplicate request identity, foreign ownership/release, end-turn release, next-turn acquisition, expiry, zero input replay');
} finally {broker.dispose();fixture.close();}
