import { PERSONALIZATION_COMMAND, personalizationStatusSchema, memoryListSchema, memoryHistorySchema, memoryMutationSchema,
  type IndividuationSettings, type MemoryChange, type MemoryList, type MemoryHistory, type MemoryMutation, type PersonalizationStatus } from '@cardbush/bush-protocol';
import { createDesktopRuntimeSession } from '../runtime-client/ElectronRuntimeSession';

async function command(input:unknown,connectionId='') {
  if(connectionId) return window.cardbushDesktop!.agents!.call(connectionId,'runtime.command',{kind:PERSONALIZATION_COMMAND,payload:input});
  const runtime=createDesktopRuntimeSession();
  try { return await runtime.client.command({kind:PERSONALIZATION_COMMAND,payload:input},value=>value); }
  finally { runtime.dispose(); }
}
export async function personalizationCommand(input:{action:'status'|'summarize';settings:IndividuationSettings;modelId?:string},connectionId='') {
  return personalizationStatusSchema.parse(await command(input,connectionId));
}
export type MemoryManagementClient={
  list(settings:IndividuationSettings,connection:string,cursor?:number,includeInactive?:boolean):Promise<MemoryList>;
  history(settings:IndividuationSettings,connection:string,cursor?:number):Promise<MemoryHistory>;
  change(settings:IndividuationSettings,connection:string,change:MemoryChange):Promise<MemoryMutation>;
  undo(settings:IndividuationSettings,connection:string,changeId:string):Promise<MemoryMutation>;
  purge(settings:IndividuationSettings,connection:string):Promise<PersonalizationStatus>;
};
export const memoryManagementClient:MemoryManagementClient={
  list:async(settings,connection,cursor=0,includeInactive=false)=>memoryListSchema.parse(await command({action:'list',settings,cursor,includeInactive},connection)),
  history:async(settings,connection,cursor=0)=>memoryHistorySchema.parse(await command({action:'history',settings,cursor},connection)),
  change:async(settings,connection,change)=>memoryMutationSchema.parse(await command({action:'change',settings,change,operationId:crypto.randomUUID()},connection)),
  undo:async(settings,connection,changeId)=>memoryMutationSchema.parse(await command({action:'undo',settings,changeId,operationId:crypto.randomUUID()},connection)),
  purge:async(settings,connection)=>personalizationStatusSchema.parse(await command({action:'purge_history',settings},connection)),
};
