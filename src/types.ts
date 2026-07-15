export const TEMPLATE_NAME = "AGENTS.template.md";
export const OUTPUT_NAME = "AGENTS.md";
export const MAX_INCLUDE_DEPTH = 32;
export const MAX_SOURCE_BYTES = 1024 * 1024;
export const HTTP_TIMEOUT_MS = 15_000;
export const HTTP_MAX_REDIRECTS = 5;

export interface SourceDocument {
  content: string;
  context: SourceContext;
  key: string;
  display: string;
}

export type SourceContext = LocalContext | HttpContext | GitContext;

export interface LocalContext {
  kind: "local";
  filePath: string;
}

export interface HttpContext {
  kind: "http";
  url: string;
}

export interface GitContext {
  kind: "git";
  repositoryUrl: string;
  repositoryDisplay: string;
  repositoryCachePath: string;
  commit: string;
  filePath: string;
}

export interface RenderedOutput {
  templatePath: string;
  outputPath: string;
  content: string;
}
