/**
 * Consolidated Sketch Operations
 *
 * Sketch creation, reading, and file collection utilities used by agent mode.
 *
 * @author Tazul Islam
 */

import { URI } from '@theia/core/lib/common/uri';
import { CurrentSketch } from '../../sketches-service-client-impl';
import { Sketch } from '../../../common/protocol/sketches-service';
import { SKETCH_CONSTANTS } from '../../../common/protocol/spectre-types';
import { executeAgentAction } from './agent-utils';

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface SketchFile {
  path: string;
  content: string;
}

export interface SketchToolsTiming {
  AGENT_ERROR_DELAY: number;
  SKETCH_CREATION_RETRY_DELAY?: number;
  SKETCH_SAVE_DELAY: number;
  SERVICE_READY_WAIT: number;
  PORT_SELECTION_DELAY: number;
}

export interface EditorWidget {
  editor: {
    document?: { getText(): string };
    getControl?: () => {
      getModel(): { getValue(): string } | null;
    };
  };
}

export interface SketchToolsContext {
  sketchesClient: { currentSketch(): Promise<Sketch> };
  commands: {
    executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
  };
  editorManager: {
    currentEditor?: EditorWidget;
    open(uri: URI): Promise<EditorWidget | undefined>;
  };
  delay(ms: number): Promise<void>;
  timing: SketchToolsTiming;

  // Optional methods used by specific operations
  showInlineDiff(
    uri: URI,
    filePath: string,
    oldCode: string,
    newCode: string
  ): Promise<void>;
  getErrorMessage(error: unknown): string;
  logError(message: string, error: unknown): void;

  // Self-reference for recursive calls or strict typing if needed
  agentModifySketch(filePath: string, content: string): Promise<string>;
}

// ============================================================================
// Sketch Creation and Modification
// ============================================================================

export async function agentCreateSketch(
  ctx: SketchToolsContext,
  name?: string,
  code?: string
): Promise<string> {
  return executeAgentAction(
    {
      logPrefix: 'Create sketch',
      actionDesc: 'create sketch',
    },
    async () => {
      const currentSketch = await ctx.sketchesClient.currentSketch();

      if (CurrentSketch.isValid(currentSketch)) {
        return await handleExistingSketch(ctx, currentSketch, code);
      }

      await ctx.commands.executeCommand('arduino-new-sketch');

      if (code) {
        return await createNewSketchWithCode(ctx, code);
      }

      return `✅ COMPLETED: New blank sketch created and ready in the editor. DO NOT call create_sketch again. If you need to add code, use create_sketch with the full updated sketch code.`;
    }
  );
}

async function handleExistingSketch(
  ctx: SketchToolsContext,
  currentSketch: Sketch,
  code?: string
): Promise<string> {
  if (code) {
    await ctx.agentModifySketch(
      `${currentSketch.uri}/${currentSketch.name}.ino`,
      code
    );
    return `✅ COMPLETED: Updated existing sketch "${currentSketch.name}" with the requested code. The sketch is now ready in the editor. DO NOT call create_sketch again - the task is complete.`;
  }

  return `✅ COMPLETED: Sketch "${currentSketch.name}" already exists and is open in the editor. DO NOT create it again - it is ready for use. If you need to modify it, use the code in the current sketch.`;
}

async function createNewSketchWithCode(
  ctx: SketchToolsContext,
  code: string
): Promise<string> {
  await ctx.delay(ctx.timing.AGENT_ERROR_DELAY);

  const sketch = await waitForSketchReady(ctx);

  if (CurrentSketch.isValid(sketch)) {
    await ctx.agentModifySketch(`${sketch.uri}/${sketch.name}.ino`, code);
    return `✅ COMPLETED: Created new sketch "${sketch.name}" with your MQ-5 sensor code. The sketch is now open in the editor with all the code you requested. DO NOT call create_sketch again - the task is finished. If you need to verify or upload, use those specific functions.`;
  }

  return `❌ ERROR: Sketch creation succeeded but could not access the sketch file after ${SKETCH_CONSTANTS.MAX_SKETCH_CREATION_RETRIES} retries. Please try manually creating a new sketch (File → New Sketch) and then ask me to add the code.`;
}

async function waitForSketchReady(ctx: SketchToolsContext): Promise<Sketch> {
  let retries = SKETCH_CONSTANTS.MAX_SKETCH_CREATION_RETRIES;
  let sketch: Sketch | undefined;

  while (retries > 0) {
    sketch = await ctx.sketchesClient.currentSketch();
    if (CurrentSketch.isValid(sketch)) {
      return sketch;
    }
    await ctx.delay(SKETCH_CONSTANTS.SKETCH_CREATION_RETRY_DELAY);
    retries--;
  }
  throw new Error('Timed out waiting for sketch to be ready');
}

export async function agentReadSketch(
  ctx: SketchToolsContext
): Promise<string> {
  return executeAgentAction(
    {
      logPrefix: 'Read sketch',
      actionDesc: 'read sketch',
    },
    async () => {
      const currentSketch = await ctx.sketchesClient.currentSketch();

      if (!CurrentSketch.isValid(currentSketch)) {
        throw new Error(
          'No sketch is currently open. Please create or open a sketch first.'
        );
      }

      const currentEditor = ctx.editorManager.currentEditor;
      if (!currentEditor) {
        throw new Error('No editor is currently active.');
      }

      const document = currentEditor.editor.document;
      if (!document) {
        throw new Error('Editor document is not available.');
      }
      const code = document.getText();

      return `✅ Current sketch: ${currentSketch.name}\n\n\`\`\`cpp\n${code}\n\`\`\``;
    }
  );
}

export async function agentModifySketch(
  ctx: SketchToolsContext,
  filePath: string,
  content: string
): Promise<string> {
  return executeAgentAction(
    {
      logPrefix: 'Sketch modification',
      actionDesc: 'modify sketch content',
      getErrorMessage: ctx.getErrorMessage,
      logError: ctx.logError,
    },
    async () => {
      const uri = new URI(filePath);

      if (!content || content.trim().length === 0) {
        return '❌ Cannot modify sketch: content is empty';
      }

      await ctx.delay(ctx.timing.SKETCH_SAVE_DELAY);

      const editor = await openEditorWithRetry(ctx, uri);
      if (!editor) {
        return '❌ Could not open file in editor - please ensure the sketch is open and try pasting the code manually';
      }

      return await applyEditorChanges(ctx, { editor, uri, filePath, content });
    }
  );
}

async function openEditorWithRetry(
  ctx: SketchToolsContext,
  uri: URI
): Promise<EditorWidget | undefined> {
  let editor = await ctx.editorManager.open(uri);

  if (!editor) {
    await ctx.delay(ctx.timing.SERVICE_READY_WAIT);
    editor = await ctx.editorManager.open(uri);
  }

  return editor;
}

async function applyEditorChanges(
  ctx: SketchToolsContext,
  opts: {
    editor: EditorWidget;
    uri: URI;
    filePath: string;
    content: string;
  }
): Promise<string> {
  await ctx.delay(ctx.timing.PORT_SELECTION_DELAY);

  const monacoEditor = opts.editor.editor;

  if (!monacoEditor.getControl) {
    return '❌ Could not access Monaco editor model - editor may not be fully loaded';
  }

  const control = monacoEditor.getControl();
  if (!control) {
    return '❌ Could not access Monaco editor model - editor may not be fully loaded';
  }

  const model = control.getModel();
  if (!model) {
    return '❌ Could not access Monaco editor model - editor may not be fully loaded';
  }

  const oldCode = model.getValue();

  if (oldCode !== opts.content) {
    await ctx.showInlineDiff(opts.uri, opts.filePath, oldCode, opts.content);
    return `✅ Applied changes to: ${opts.filePath}\n\n💡 Click "Keep" to accept or "Undo" to revert`;
  }

  return `✅ Code is already up to date: ${opts.filePath}`;
}

// ============================================================================
// Sketch File Collection
// ============================================================================
// Logic moved to ../feature/sketch-utilities.ts to resolve circular dependency
