import {
  BUSH_TOOL_CALL_PROTOCOL,
  type ModelEvent,
  type ToolCall,
} from "@cardbush/bush-protocol";

interface PartialToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

export class ToolCallAccumulator {
  readonly #calls = new Map<number, PartialToolCall>();

  accept(event: ModelEvent): void {
    if (event.kind !== "tool_call_delta") {
      return;
    }
    const current = this.#calls.get(event.index) ?? {
      id: "",
      name: "",
      argumentsText: "",
    };
    if (event.toolCallId) {
      current.id = event.toolCallId;
    }
    current.name += event.nameDelta ?? "";
    current.argumentsText += event.argumentsDelta ?? "";
    this.#calls.set(event.index, current);
  }

  completed(): ToolCall[] {
    return [...this.#calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, call]) => {
        if (!call.id || !call.name) {
          throw new Error(`incomplete tool call at index ${index}`);
        }
        return {
          protocol: BUSH_TOOL_CALL_PROTOCOL,
          id: call.id,
          name: call.name,
          argumentsText: call.argumentsText,
        };
      });
  }
}
