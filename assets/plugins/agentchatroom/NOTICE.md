The room journal, credential validation, signed read cursors, idempotent sends and asynchronous room waits in src/vendor are reused from CardBush AgentChatroom 0.1.1 (Apache-2.0).

The portable runtime bundle also includes Zod under the MIT license; see ZOD_LICENSE.

This bundled edition adds Runtime-owned identity, project discovery, explicit cross-project invitations and bounded conversation wake. Its tools never accept another member's token. It does not open a network listener or expose unrelated conversation transcripts. The older standalone service and its data are left intact; CardBush uses the bundled plugin for this plugin ID.
