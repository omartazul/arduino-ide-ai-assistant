/**
 * Rendering helpers for code blocks and markdown content.
 * Extracted from spectre-widget.tsx to reduce complexity.
 *
 * @author Tazul Islam
 */

import React from '@theia/core/shared/react';

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
function renderMarkdownText(text: string, key: string): React.ReactNode {
  return (
    <div key={key} style={{ marginBottom: '8px' }}>
      {ReactMarkdownLazy ? <ReactMarkdownLazy>{text}</ReactMarkdownLazy> : <pre>{text}</pre>}
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
  const codeBlockRegex = /```(?:cpp|c|arduino|ino)?\n?([\s\S]*?)\n?```/g;
  let lastIndex = 0;
  const parts: React.ReactNode[] = [];
  let blockIndex = 0;

  let match;
  while (
    (match = codeBlockRegex.exec(text)) !== null &&
    blockIndex < codeBlocks.length
  ) {
    const beforeCode = text.slice(lastIndex, match.index);

    // Add text before code block
    if (beforeCode.trim()) {
      parts.push(renderMarkdownText(beforeCode, `text-${blockIndex}`));
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
      {ReactMarkdownLazy ? <ReactMarkdownLazy>{text}</ReactMarkdownLazy> : <pre>{text}</pre>}
    </div>
  );

  // Add the detected Arduino code blocks
  codeBlocks.forEach((codeBlock, index) => {
    parts.push(renderSingleCodeBlock(codeBlock, index));
  });

  return parts;
}

/**
 * Gets icon for a function name.
 */
export function getFunctionIcon(functionName: string): string {
  switch (functionName) {
    case 'create_sketch':
      return '📝';
    case 'read_sketch':
      return '📖';
    case 'verify_sketch':
      return '🔍';
    case 'upload_sketch':
      return '⬆️';
    case 'install_library':
      return '📦';
    case 'uninstall_library':
      return '🗑️';
    case 'search_boards':
      return '🔎';
    case 'install_board':
      return '💾';
    case 'uninstall_board':
      return '🗑️';
    case 'select_board':
      return '🎯';
    case 'get_boards':
      return '📋';
    case 'select_port':
      return '🔌';
    case 'get_ports':
      return '🔌';
    case 'add_board_url':
      return '🌐';
    case 'remove_board_url':
      return '🗑️';
    case 'fetch_board_urls':
      return '🔍';
    case 'get_board_config':
      return '⚙️';
    case 'set_board_config':
      return '⚙️';
    default:
      return '⚡';
  }
}

/**
 * Gets label for a function name.
 */
export function getFunctionLabel(functionName: string): string {
  switch (functionName) {
    case 'create_sketch':
      return 'Creating sketch';
    case 'read_sketch':
      return 'Reading sketch';
    case 'verify_sketch':
      return 'Verifying sketch';
    case 'upload_sketch':
      return 'Uploading sketch';
    case 'install_library':
      return 'Installing library';
    case 'uninstall_library':
      return 'Uninstalling library';
    case 'search_boards':
      return 'Searching boards';
    case 'install_board':
      return 'Installing board';
    case 'uninstall_board':
      return 'Uninstalling board';
    case 'select_board':
      return 'Selecting board';
    case 'get_boards':
      return 'Getting boards list';
    case 'select_port':
      return 'Selecting port';
    case 'get_ports':
      return 'Getting ports list';
    case 'add_board_url':
      return 'Adding board URL';
    case 'remove_board_url':
      return 'Removing board URL';
    case 'fetch_board_urls':
      return 'Fetching board URLs';
    case 'get_board_config':
      return 'Getting board configuration';
    case 'set_board_config':
      return 'Setting board configuration';
    default:
      return functionName.replace(/_/g, ' ');
  }
}

/**
 * Suppresses redundant code blocks from agent responses.
 */
export function suppressRedundantCodeBlocks(text: string): string {
  // Match code blocks with cpp/arduino/c/ino language tags
  const codeBlockRegex = /```(?:cpp|c|arduino|ino)\n([\s\S]*?)\n```/gi;

  return text.replace(codeBlockRegex, (match, code) => {
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
