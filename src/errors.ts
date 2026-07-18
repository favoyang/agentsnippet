export class AgentSnippetError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentSnippetError";
  }
}

const safeErrors = new WeakSet<AgentSnippetError>();

export function safeAgentSnippetError(message: string, options?: ErrorOptions): AgentSnippetError {
  const error = new AgentSnippetError(message, options);
  safeErrors.add(error);
  return error;
}

export function isSafeAgentSnippetError(error: unknown): error is AgentSnippetError {
  return error instanceof AgentSnippetError && safeErrors.has(error);
}

export class UsageError extends AgentSnippetError {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export class TracedIncludeError extends AgentSnippetError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TracedIncludeError";
  }
}
