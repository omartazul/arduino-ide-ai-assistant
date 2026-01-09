/**
 * Rendering helpers for code blocks and markdown content.
 * Extracted from spectre-widget.tsx to reduce complexity.
 *
 * @author Tazul Islam
 */

import React from '@theia/core/shared/react';
import {
  ARDUINO_FENCED_BLOCK_REGEX,
  ANY_FENCED_BLOCK_SPLIT_REGEX,
} from './ui-utilities';

/**
 * Lazy-loaded ReactMarkdown component.
 *
 * `undefined` = not attempted
 * `null` = failed to load; use fallback rendering
 */
export let ReactMarkdownLazy: any | null | undefined = undefined;

export function setReactMarkdownLazy(component: any): void {
  ReactMarkdownLazy = component;
}

/**
 * Renders text content with markdown.
 */
function renderMarkdownText({
  text,
  key,
}: {
  text: string;
  key: string;
}): React.ReactNode {
  return (
    <div key={key} style={{ marginBottom: '8px' }}>
      {ReactMarkdownLazy ? (
        <ReactMarkdownLazy>{text}</ReactMarkdownLazy>
      ) : (
        <pre>{text}</pre>
      )}
    </div>
  );
}

/**
 * Processes explicit code blocks from text.
 */
export function processExplicitCodeBlocks(
  text: string,
  codeBlocks: Array<{
    code: string;
    type: 'block' | 'inline';
    language?: string;
  }>,
  renderSingleCodeBlock: (
    codeBlock: { code: string; type: 'block' | 'inline'; language?: string },
    index: number
  ) => React.ReactNode
): React.ReactNode[] {
  const splitRegex = ANY_FENCED_BLOCK_SPLIT_REGEX;
  let lastIndex = 0;
  const parts: React.ReactNode[] = [];
  let blockIndex = 0;

  let match;
  while (
    (match = splitRegex.exec(text)) !== null &&
    blockIndex < codeBlocks.length
  ) {
    const beforeCode = text.slice(lastIndex, match.index);

    // Add text before code block
    if (beforeCode.trim()) {
      parts.push(
        renderMarkdownText({ text: beforeCode, key: `text-${blockIndex}` })
      );
    }

    // Add code block
    const codeBlock = codeBlocks[blockIndex];
    if (codeBlock && codeBlock.code.trim() === match[1].trim()) {
      parts.push(renderSingleCodeBlock(codeBlock, blockIndex));
      blockIndex++;
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text after last code block
  const remainingText = text.slice(lastIndex);
  if (remainingText.trim()) {
    parts.push(
      <div key="text-final" style={{ marginTop: '8px' }}>
        {ReactMarkdownLazy ? (
          <ReactMarkdownLazy>{remainingText}</ReactMarkdownLazy>
        ) : (
          <pre>{remainingText}</pre>
        )}
      </div>
    );
  }

  return parts;
}

/**
 * Renders inline code blocks when no explicit blocks found.
 */
export function renderInlineCodeBlocks(
  text: string,
  codeBlocks: Array<{
    code: string;
    type: 'block' | 'inline';
    language?: string;
  }>,
  renderSingleCodeBlock: (
    codeBlock: { code: string; type: 'block' | 'inline'; language?: string },
    index: number
  ) => React.ReactNode
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];

  parts.push(
    <div key="text-main">
      {ReactMarkdownLazy ? (
        <ReactMarkdownLazy>{text}</ReactMarkdownLazy>
      ) : (
        <pre>{text}</pre>
      )}
    </div>
  );

  // Add the detected Arduino code blocks
  codeBlocks.forEach((codeBlock, index) => {
    parts.push(renderSingleCodeBlock(codeBlock, index));
  });

  return parts;
}

/**
 * Mapping of function names to icons.
 */
const ICON_BY_FUNCTION: Record<string, string> = {
  create_sketch: '📝',
  read_sketch: '📖',
  verify_sketch: '🔍',
  upload_sketch: '⬆️',
  install_library: '📦',
  uninstall_library: '🗑️',
  search_boards: '🔎',
  install_board: '💾',
  uninstall_board: '🗑️',
  select_board: '🎯',
  get_boards: '📋',
  select_port: '🔌',
  get_ports: '🔌',
  add_board_url: '🌐',
  remove_board_url: '🗑️',
  fetch_board_urls: '🔍',
  get_board_config: '⚙️',
  set_board_config: '⚙️',
};

/**
 * Gets icon for a function name.
 */
export function getFunctionIcon(functionName: string): string {
  return ICON_BY_FUNCTION[functionName] ?? '⚡';
}

/**
 * Mapping of function names to human-readable labels.
 */
const LABEL_BY_FUNCTION: Record<string, string> = {
  create_sketch: 'Creating sketch',
  read_sketch: 'Reading sketch',
  verify_sketch: 'Verifying sketch',
  upload_sketch: 'Uploading sketch',
  install_library: 'Installing library',
  uninstall_library: 'Uninstalling library',
  search_boards: 'Searching boards',
  install_board: 'Installing board',
  uninstall_board: 'Uninstalling board',
  select_board: 'Selecting board',
  get_boards: 'Getting boards list',
  select_port: 'Selecting port',
  get_ports: 'Getting ports list',
  add_board_url: 'Adding board URL',
  remove_board_url: 'Removing board URL',
  fetch_board_urls: 'Fetching board URLs',
  get_board_config: 'Getting board configuration',
  set_board_config: 'Setting board configuration',
};

/**
 * Gets label for a function name.
 */
export function getFunctionLabel(functionName: string): string {
  return LABEL_BY_FUNCTION[functionName] ?? functionName.replace(/_/g, ' ');
}

/**
 * Suppresses redundant code blocks from agent responses.
 */
export function suppressRedundantCodeBlocks(text: string): string {
  return text.replace(ARDUINO_FENCED_BLOCK_REGEX, (match, code) => {
    const lines = code.trim().split('\n');
    const lineCount = lines.length;

    // Keep small snippets (teaching/examples) - these are helpful
    if (lineCount <= 15) {
      return match; // Keep original code block
    }

    // Replace large code blocks with summary (agent just updated the sketch)
    // Check if it looks like a complete sketch (has setup/loop)
    const hasSetup = /void\s+setup\s*\(\s*\)/i.test(code);
    const hasLoop = /void\s+loop\s*\(\s*\)/i.test(code);

    if (hasSetup && hasLoop) {
      return `\n*✅ Updated sketch in editor (${lineCount} lines)*\n`;
    }

    // Generic large code block
    return `\n*✅ Updated code in editor (${lineCount} lines)*\n`;
  });
}
