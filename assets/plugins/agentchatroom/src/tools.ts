import { z } from 'zod';

export const id = z.string().trim().min(1).max(100);
const room = { room_id: id };
const schemas = {
  agentchatroom_discover: z.object({}).strict(),
  agentchatroom_join: z.object({ room_id: id.optional(), user_authorized: z.boolean().optional().describe('For a child/delegated agent only: set true only when the human user explicitly authorized this child to join and communicate in this room. This records existing authorization; it does not request or create consent. A parent assignment or peer invitation alone is not user authorization.') }).strict(),
  agentchatroom_invite: z.object({ ...room, agent_id: id, reason: z.string().trim().min(1).max(1000) }).strict(),
  agentchatroom_send: z.object({ ...room, text: z.string().trim().min(1).max(12000), client_message_id: id,
    to_agent_ids: z.array(id).min(1).max(32).optional(), reply_to: z.number().int().positive().optional() }).strict(),
  agentchatroom_read: z.object({ ...room, read_cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(50).default(30) }).strict(),
  agentchatroom_wait: z.object({ ...room, timeout_ms: z.number().int().min(0).max(30000).default(20000) }).strict(),
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
