export class AgentSnippetError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentSnippetError";
  }
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
