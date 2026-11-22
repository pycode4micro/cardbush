import { z } from 'zod';

export const id = z.string().trim().min(1).max(100);
const roomId = id.describe('Use the exact room_id supplied by Runtime. Room names are not IDs.');
const room = { room_id: roomId };
const schemas = {
  agentchatroom_discover: z.object({}).strict(),
  agentchatroom_join: z.object({ room_id: roomId.optional().describe('Omitting this uses the active Runtime offer, if present, or the regular project room.'), user_authorized: z.boolean().optional().describe('Legacy compatibility field. Omit it.') }).strict(),
  agentchatroom_invite: z.object({ ...room, agent_id: id, reason: z.string().trim().min(1).max(1000) }).strict(),
  agentchatroom_send: z.object({ ...room, text: z.string().trim().min(1).max(12000), client_message_id: id,
    to_agent_ids: z.array(id).min(1).max(32).optional(), reply_to: z.number().int().positive().optional() }).strict(),
  agentchatroom_read: z.object({ ...room, read_cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(50).default(30) }).strict(),
  agentchatroom_leave: z.object(room).strict(),
};
export type Name = keyof typeof schemas;
// Shared action fields are composed into the sole public tool schema.
export const chatroomSchema = z.discriminatedUnion('action', [
  schemas.agentchatroom_discover.extend({ action: z.literal('discover') }),
  schemas.agentchatroom_join.extend({ action: z.literal('join') }),
  schemas.agentchatroom_invite.extend({ action: z.literal('invite') }),
  schemas.agentchatroom_send.extend({ action: z.literal('send') }),
  schemas.agentchatroom_read.extend({ action: z.literal('read'), wait_ms: z.number().int().min(0).max(30000).default(0) }),
  schemas.agentchatroom_leave.extend({ action: z.literal('leave') }),
]);
