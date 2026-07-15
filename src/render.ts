import { join } from "node:path";
import { findIncludeDirectives } from "./directives.js";
import { AgentSnippetError, TracedIncludeError } from "./errors.js";
import { redactUrl } from "./git-source.js";
import { SourceResolver } from "./sources.js";
import {
  MAX_INCLUDE_DEPTH,
  OUTPUT_NAME,
  type RenderedOutput,
  type SourceContext,
  type SourceDocument,
} from "./types.js";

interface IncludeFrame {
  key: string;
  display: string;
}

export async function renderTemplate(
  templatePath: string,
  resolver = new SourceResolver(),
): Promise<RenderedOutput> {
  const root = await resolver.loadRoot(templatePath);
  const content = await expand(root, resolver, []);
  return {
    templatePath,
    outputPath: join(templatePath, "..", OUTPUT_NAME),
    content: finalizeMarkdown(content),
  };
}

async function expand(
  document: SourceDocument,
  resolver: SourceResolver,
  stack: IncludeFrame[],
): Promise<string> {
  if (stack.length >= MAX_INCLUDE_DEPTH) {
    throw tracedError(
      `Include depth exceeds the limit of ${MAX_INCLUDE_DEPTH} at ${document.display}.`,
      [...stack, { key: document.key, display: document.display }],
    );
  }
  const cycleAt = stack.findIndex((frame) => frame.key === document.key);
  if (cycleAt !== -1) {
    throw tracedError(
      `Include cycle detected at ${document.display}.`,
      [...stack.slice(cycleAt), { key: document.key, display: document.display }],
    );
  }

  const activeStack = [...stack, { key: document.key, display: document.display }];
  const markdown = normalizeLineEndings(document.content);
  const directives = findIncludeDirectives(markdown, document.display);
  if (directives.length === 0) return markdown;

  const chunks: string[] = [];
  let cursor = 0;
  for (const directive of directives) {
    chunks.push(markdown.slice(cursor, directive.start));
    try {
      const included = await resolver.resolve(directive.source, document.context);
      const expanded = await expand(included, resolver, activeStack);
      const consumedLineEnding = markdown[directive.end - 1] === "\n";
      chunks.push(consumedLineEnding && !expanded.endsWith("\n") ? `${expanded}\n` : expanded);
    } catch (error) {
      if (error instanceof TracedIncludeError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new TracedIncludeError(
        `${message}\nInclude chain:\n${formatTrace(
          activeStack,
          document.display,
          document.context,
          directive.line,
          directive.source,
        )}`,
        error instanceof Error ? { cause: error } : undefined,
      );
    }
    cursor = directive.end;
  }
  chunks.push(markdown.slice(cursor));
  return chunks.join("");
}

function tracedError(message: string, stack: IncludeFrame[]): TracedIncludeError {
  return new TracedIncludeError(`${message}\nInclude chain:\n${stack.map((frame) => `  ${frame.display}`).join("\n")}`);
}

function formatTrace(
  stack: IncludeFrame[],
  parentDisplay: string,
  parentContext: SourceContext,
  line: number,
  reference: string,
): string {
  const frames = stack.map((frame) => `  ${frame.display}`);
  frames.push(`  ${parentDisplay}:${line} -> ${displayReference(reference, parentContext)}`);
  return frames.join("\n");
}

function displayReference(reference: string, parentContext: SourceContext): string {
  if (parentContext.kind === "http") {
    try {
      return redactUrl(new URL(reference, parentContext.url).toString());
    } catch {
      return "<redacted-source>";
    }
  }
  if (
    reference.startsWith("git+https://") ||
    reference.startsWith("git+ssh://") ||
    reference.startsWith("http://") ||
    reference.startsWith("https://")
  ) {
    return redactUrl(reference);
  }
  return reference;
}

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function finalizeMarkdown(value: string): string {
  return `${normalizeLineEndings(value).replace(/\n*$/, "")}\n`;
}
