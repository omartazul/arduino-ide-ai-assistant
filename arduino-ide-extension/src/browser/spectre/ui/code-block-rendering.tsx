/**
 * Code-block rendering and copy/paste helpers for Spectre chat.
 *
 * @author Tazul Islam
 */

import React from 'react';

import { EditorManager } from '../../theia/editor/editor-manager';
import { spectreWarn } from '../../../common/protocol/spectre-types';

import * as RenderingHelpers from './message-rendering';
import { UIHelper } from './ui-helper';

export interface CodeBlockRenderingDeps {
  editorManager: EditorManager;
  feedbackTimers: Set<number>;
  copyFeedbackDurationMs: number;
  isBasicMode: boolean;
}

export type ExtractedCodeBlock = {
  code: string;
  type: 'block' | 'inline';
  language?: string;
};

/**
 * Extracts Arduino code from text (looks for code blocks or detects Arduino patterns).
 */
export function extractArduinoCode(text: string): ExtractedCodeBlock[] {
  return UIHelper.extractArduinoCode(text);
}

/**
 * Copies text to clipboard.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    // Fallback for older browsers
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.select();
    const success = document.execCommand('copy');
    document.body.removeChild(textArea);
    return success;
  }
}

function pasteToMonacoEditor(monacoEditor: any, code: string): boolean {
  const model = monacoEditor.getModel();

  if (model) {
    // Replace all content with the new code
    const fullRange = model.getFullModelRange();
    monacoEditor.executeEdits('paste-arduino-code', [
      {
        range: fullRange,
        text: code,
      },
    ]);

    // Position cursor at the beginning
    monacoEditor.setPosition({ lineNumber: 1, column: 1 });
    monacoEditor.focus();

    return true;
  }

  return false;
}

async function fallbackToClipboard(params: {
  code: string;
  deps: Pick<CodeBlockRenderingDeps, 'editorManager'>;
  editor?: any;
}): Promise<boolean> {
  const { code, deps, editor } = params;

  spectreWarn(
    'Could not access Monaco editor directly, falling back to clipboard'
  );
  const success = await copyToClipboard(code);
  const hasValidEditor = success && editor?.editor;
  if (hasValidEditor) {
    editor.editor.focus();
  } else {
    deps.editorManager.currentEditor?.editor?.focus();
  }
  return success;
}

/**
 * Pastes code to the current editor, replacing all content.
 */
export async function pasteToEditor(params: {
  code: string;
  deps: Pick<CodeBlockRenderingDeps, 'editorManager'>;
}): Promise<boolean> {
  const { code, deps } = params;

  try {
    const editor = deps.editorManager.currentEditor;
    if (!editor || !editor.editor) {
      return false;
    }

    const textEditor = editor.editor;

    // Check if it's a Monaco editor and access the Monaco instance
    if (
      'getControl' in textEditor &&
      typeof (textEditor as any).getControl === 'function'
    ) {
      const monacoEditor = (textEditor as any).getControl();
      const success = pasteToMonacoEditor(monacoEditor, code);

      if (success) {
        return true;
      }
    }

    // Fallback: copy to clipboard and focus editor
    return await fallbackToClipboard({ code, deps, editor });
  } catch (error) {
    spectreWarn('Failed to paste to editor, falling back to clipboard:', error);
    // Fallback: copy to clipboard and focus editor
    return await fallbackToClipboard({
      code,
      deps,
      editor: deps.editorManager.currentEditor,
    });
  }
}

export function renderSingleCodeBlock(params: {
  deps: CodeBlockRenderingDeps;
  codeBlock: ExtractedCodeBlock;
  index: number;
}): React.ReactNode {
  const { deps, codeBlock, index } = params;
  const { language, lineCount } = UIHelper.getCodeBlockMetadata(codeBlock);

  return (
    <div key={`code-${index}`} className="spectre-code-container">
      <div className="spectre-code-header">
        <div className="spectre-code-language">
          {language} • {lineCount} line{lineCount !== 1 ? 's' : ''}
        </div>
        <div className="spectre-code-actions">
          <button
            className="spectre-code-action-btn"
            onClick={async () => {
              const success = await copyToClipboard(codeBlock.code);
              const button = document.activeElement as HTMLButtonElement;
              if (button && success) {
                const originalHTML = button.innerHTML;
                button.classList.add('success');
                button.innerHTML = '✓ Copied';
                const timerId = window.setTimeout(() => {
                  deps.feedbackTimers.delete(timerId);
                  button.classList.remove('success');
                  button.innerHTML = originalHTML;
                }, deps.copyFeedbackDurationMs);
                deps.feedbackTimers.add(timerId);
              }
            }}
            aria-label="Copy code to clipboard"
            title="Copy code to clipboard"
          >
            📋 Copy
          </button>
          <button
            className="spectre-code-action-btn"
            onClick={async () => {
              const success = await pasteToEditor({
                code: codeBlock.code,
                deps,
              });
              const button = document.activeElement as HTMLButtonElement;
              if (button && success) {
                const originalHTML = button.innerHTML;
                button.classList.add('success');
                button.innerHTML = '✓ Ready to Paste';
                const timerId = window.setTimeout(() => {
                  deps.feedbackTimers.delete(timerId);
                  button.classList.remove('success');
                  button.innerHTML = originalHTML;
                }, deps.copyFeedbackDurationMs);
                deps.feedbackTimers.add(timerId);
              }
            }}
            aria-label="Copy code and focus editor for pasting"
            title="Copy code and focus editor for pasting"
          >
            📝 Paste
          </button>
        </div>
      </div>
      <div className="spectre-code-content">
        <pre>
          <code>{codeBlock.code}</code>
        </pre>
      </div>
    </div>
  );
}

/**
 * Renders assistant message content with integrated Arduino code blocks.
 */
export function renderAssistantMessage(params: {
  deps: CodeBlockRenderingDeps;
  text: string;
  isStreaming: boolean;
}): React.ReactNode {
  const { deps, text } = params;

  // Always render markdown for consistency (streaming or not)
  // Modern markdown parsers are optimized and fast enough
  // This prevents jarring visual changes when stream completes

  // For completed messages, check if we should use custom code block rendering
  const codeBlocks = extractArduinoCode(text);

  if (codeBlocks.length > 0 && deps.isBasicMode) {
    const renderBlock = (
      codeBlock: ExtractedCodeBlock,
      index: number
    ): React.ReactNode => renderSingleCodeBlock({ deps, codeBlock, index });

    const parts = RenderingHelpers.processExplicitCodeBlocks(
      text,
      codeBlocks,
      renderBlock
    );

    if (parts.length === 0 && codeBlocks.length > 0) {
      return (
        <div>
          {RenderingHelpers.renderInlineCodeBlocks(
            text,
            codeBlocks,
            renderBlock
          )}
        </div>
      );
    }

    return <div>{parts}</div>;
  }

  const ReactMarkdown = RenderingHelpers.ReactMarkdownLazy;
  return ReactMarkdown ? (
    <ReactMarkdown>{text}</ReactMarkdown>
  ) : (
    <pre style={{ whiteSpace: 'pre-wrap' }}>{text}</pre>
  );
}
