/** The Source protocol and the chat plugin: what translates a host's events into Triggers and writes its replies back. */
export type {
  AdmissionRowView,
  ContextMessage,
  ContextPart,
  ContextPartName,
  FieldSpec,
  SourceKind,
  SourcePolicyPart,
} from "./kind";
export type { ChatEvent, ChatStreamSink, SourceContext, SourceState } from "./host";
export { SourceRegistry } from "./registry";
export {
  CHAT_READ_CURSOR,
  CHAT_SCOPE_ROW,
  CHAT_SOURCE_KIND,
  chatBlockId,
  chatFrame,
  chatSourceKind,
  chatTrigger,
  pollChat,
  type ChatSourceConfig,
  type PollResult,
} from "./chat";
