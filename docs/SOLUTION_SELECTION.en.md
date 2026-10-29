# Solution Selection

[English](SOLUTION_SELECTION.en.md) · [简体中文](SOLUTION_SELECTION.md)

`solution_selection` is a constrained decision tool. First inspect the context, use available tools and exercise judgment. Use it only when a material direction or necessary information remains unresolved and choosing independently could cause a significant mistake. It is not for routine preference surveys, teaching questions, progress reports, permission requests or reconfirming authorized work.

Inputs are `prompt` and `options`: one actual unresolved direction and 1–3 distinct plain-text options. The prompt and each option are limited to 15 Unicode characters; do not truncate essential decision information. A recommendation may be written in the option itself. There is no recommendation field or injected Other option; the UI always provides free input.

The card replaces the owning conversation's composer. Clicking an option submits it, or the user can enter a custom answer. There is no default choice or timed submission. Switching conversations preserves the request, draft and unsubmitted answer. Closing returns explicit cancellation, not a default answer or permission. Stopping the task cancels the wait.

The Runtime owns pending requests. `runtime.list_solution_selections` restores active waits; `runtime.answer_solution_selection` validates request, session, turn and option IDs. Closing/reopening a view or reconnecting does not rerun the tool. Process exit follows normal interruption/recovery semantics. The actual choice or free text is stored as a tool result.

Each session permits one pending decision. Full access still requires a real reply. Child agents retain the declaration but are rejected when calling it; they must report unresolved dependencies to the parent.

`npm run test:solution-selection` covers Runtime/model tool loops, frontend IPC, composer replacement and both themes using isolated data, without live model calls or personal-task changes.
