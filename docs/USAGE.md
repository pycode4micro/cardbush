# Everyday workflows

[English](USAGE.md) · [简体中文](USAGE.zh-CN.md)

This is a product usage guide, not a declaration of a separate `usage` tool or portable workflow-package API. Use the capabilities actually present in your installed version.

## Start with a conversation

Configure a model, open a conversation and describe the desired result, working files and constraints. Choose a project folder for existing work; otherwise CardBush uses its managed workspace. A folder selection describes where work happens, not permission for every action. Review requested access or select the intended permission mode. See [models](MODEL_CONNECTIONS.en.md), [workspaces](TASK_WORKSPACES.en.md) and [permissions](PERMISSIONS.md).

Attach files or use references to supply context. Tool activity shows the agent's process; expand an execution when arguments, failures or archived output matter. File links and generated previews open the actual artifact. A screenshot or successful tool return does not by itself prove a correct deliverable: ask for checks suited to the result. See [references](FILE_REFERENCES.en.md), [tool interaction](TOOL_INTERACTION.en.md) and [execution history](execution-history.en.md).

While work runs, queue later work or send guidance for the current task. These are different actions: queued work starts later, guidance is applied at a safe loop boundary. Stop is explicit; closing a view or disconnecting an observer does not necessarily stop the underlying operation. Inspect uncertain results before submitting replacement work.

## Create a persistent workspace

Creation is a canvas combining HTML, Markdown, Office files, PDFs and media. Add files or ask the agent to arrange them. Content can update while item position, size and grouping remain stable. Pin a version for comparison, or select a region and continue discussing that exact content. Supported rendering depends on the file adapter; arbitrary imported HTML does not gain unrestricted host access.

Keep the canvas in its managed workspace while working, then export the board and resources to a chosen folder. A board is not required to start as a repository. Team members can update assigned regions while retaining layout. See [canvas](creation-canvas.en.md), [persistent desk](CREATION_DESK.en.md), [preview adapters](FILE_PREVIEW_ADAPTERS.en.md) and [document plugins](DOCUMENT_PLUGINS.en.md).

## Reuse skills, plugins and Team

Plugins supply executable capabilities and connections; Skills supply instructions and resources. Install/enable what you need, complete authentication where required and verify connection state. Installed, connected and business-operation success are separate facts. Plugin discovery does not authorize actions. Use a manual `/plugin:skill` or `$plugin:skill` invocation when that package permits it, or ask the agent to find a suitable capability. `/collect` prepares an editable request to turn current experience into an installable Skill; it does not silently publish one.

Team saves named employee definitions and dependency workflows. Use a child for a bounded assignment, Team for a reusable dependency graph, and the existing plan tool to track progress inside a task. A plan status is a declaration, not independent verification. Remote employees bind a verified worker connection; they retain their own model, files and policy. Follow-ups target the original child/task, not another same-named agent. See [Team](TEAM_NATIVE_WORKFLOWS.en.md), [plugin compatibility](PLUGIN_COMPATIBILITY.en.md) and [remote protocol](SUBAGENT_REMOTE_PROTOCOL.md).

## Browser and voice work

Enable Browser Use and approve the first local extension connection. Page grants and managed session groups still apply; personal tabs require explicit authorization/copy. Local App and CLI share the connector, and background tab creation avoids stealing focus by default. A remote worker has separate browser configuration. Repeated failures exhaust a retry budget and wait for manual retry, rather than reconnect forever. See [browser setup](CORE_BROWSER_COMPUTER_USE.en.md).

Click the persistent microphone for dictation into the draft; it does not send the transcript. Hold the main action button for a voice call, and use Stop to end the call. Calls and dictation have separate service/configuration paths. A call ending does not imply a delegated task was canceled. See [realtime voice](REALTIME_VOICE.en.md), [local voice models](LOCAL_VOICE_MODELS.en.md) and [assistant](PERSONAL_ASSISTANT.en.md).

## Automation, memory and terminal use

Create a schedule with complete requirements, model/workspace and permission expectations. Time-based execution uses a saved configuration and separate conversation; the scheduler's host must be running. Review unread results explicitly, including failures. Opening a result does not mark it read. See [automation](AUTOMATIONS.en.md) and [inbox](AUTOMATION_INBOX.md).

Long-context compression is automatic under pressure and retains original history for inspection. It is separate from optional habit memory and predictions. New sessions default those personalization features off; use explicit controls to enable them. Ordinary completion performs local maintenance, not an additional model-summary request. See [context and memory](CONTEXT_AND_MEMORY.md).

The [CLI](CLI.md) uses the same Runtime with terminal-friendly history, `/tools`, `/artifact`, `/source`, `/session`, queue and guidance. CLI chat is local to its host; remote execution is registered as a worker. Releases can differ across npm, Store and source, so check the resolved command/build before diagnosing a feature as missing.
