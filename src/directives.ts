import { fromMarkdown } from "mdast-util-from-markdown";
import { safeAgentSnippetError } from "./errors.js";

export interface IncludeDirective {
  source: string;
  start: number;
  end: number;
  line: number;
}

interface AstNode {
  type: string;
  value?: string;
  position?: {
    start: { offset?: number; line: number };
    end: { offset?: number; line: number };
  };
  children?: AstNode[];
}

const DIRECTIVE_PATTERN = /^[\t ]{0,3}<!--\s*@agentsnippet\s+"([^"\r\n]+)"\s*-->[\t ]*$/;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?(?:-->|$)/g;

export function findIncludeDirectives(markdown: string, display: string): IncludeDirective[] {
  const tree = fromMarkdown(markdown) as unknown as AstNode;
  const directives: IncludeDirective[] = [];
  const seenLines = new Set<number>();

  visit(tree, (node) => {
    if (node.type !== "html" || !node.value?.includes("@agentsnippet") || !node.position) {
      return;
    }

    const nodeStart = node.position.start.offset;
    if (nodeStart === undefined) {
      throw safeAgentSnippetError(`Cannot locate an agentsnippet directive in ${display}.`);
    }

    for (const comment of node.value.matchAll(HTML_COMMENT_PATTERN)) {
      if (!comment[0].includes("@agentsnippet")) continue;
      const relativeStart = comment.index ?? 0;
      const commentStart = nodeStart + relativeStart;
      const commentEnd = commentStart + comment[0].length;
      const lineStart = markdown.lastIndexOf("\n", Math.max(0, commentStart - 1)) + 1;
      const nextNewline = markdown.indexOf("\n", commentEnd);
      const lineEnd = nextNewline === -1 ? markdown.length : nextNewline;
      const lineText = markdown.slice(lineStart, lineEnd);
      const line = node.position.start.line + countNewlines(node.value.slice(0, relativeStart));
      const match = DIRECTIVE_PATTERN.exec(lineText);

      if (!match?.[1]) {
        throw safeAgentSnippetError(
          `Malformed agentsnippet directive in ${display}:${line}. ` +
            'Expected <!-- @agentsnippet "<source>" --> on its own line.',
        );
      }

      if (!seenLines.has(lineStart)) {
        seenLines.add(lineStart);
        directives.push({
          source: match[1],
          start: lineStart,
          end: nextNewline === -1 ? lineEnd : lineEnd + 1,
          line,
        });
      }
    }
  });

  return directives.sort((left, right) => left.start - right.start);
}

function countNewlines(value: string): number {
  return value.split("\n").length - 1;
}

function visit(node: AstNode, callback: (node: AstNode) => void): void {
  callback(node);
  for (const child of node.children ?? []) {
    visit(child, callback);
  }
}
