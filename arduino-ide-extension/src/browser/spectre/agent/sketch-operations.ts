/**
 * Consolidated Sketch Operations
 * 
 * This file consolidates:
 * - sketch-tools.ts
 * - sketch-file-collector.ts (from feature/)
 * 
 * @author Tazul Islam
 */

import { URI } from '@theia/core/lib/common/uri';
import { CurrentSketch } from '../../sketches-service-client-impl';
import { SKETCH_CONSTANTS, spectreWarn } from '../../../common/protocol/spectre-types';
import {
  fileNamesMatch,
  isArduinoFileExtension,
  isMainFile,
  isRelevantSketchFile,
  matchDecodedUris,
} from '../feature/sketch-utilities';

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
}

export interface SketchToolsContext {
  sketchesClient: { currentSketch(): Promise<any> };
  commands: { executeCommand(id: string, ...args: any[]): Promise<any> };
  editorManager: { currentEditor?: any };
  delay(ms: number): Promise<void>;
  timing: { AGENT_ERROR_DELAY: number };

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

async function handleExistingSketch(
  ctx: SketchToolsContext,
  currentSketch: any,
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

async function waitForSketchReady(ctx: SketchToolsContext): Promise<any> {
  let retries = SKETCH_CONSTANTS.MAX_SKETCH_CREATION_RETRIES;
  let sketch: any = null;

  while (retries > 0 && !CurrentSketch.isValid(sketch)) {
    sketch = await ctx.sketchesClient.currentSketch();
    if (!CurrentSketch.isValid(sketch)) {
      await ctx.delay(SKETCH_CONSTANTS.SKETCH_CREATION_RETRY_DELAY);
      retries--;
    }
  }

  return sketch;
}

export async function agentReadSketch(ctx: SketchToolsContext): Promise<string> {
  const currentSketch = await ctx.sketchesClient.currentSketch();

  if (!CurrentSketch.isValid(currentSketch)) {
    throw new Error('No sketch is currently open. Please create or open a sketch first.');
  }

  const currentEditor = ctx.editorManager.currentEditor;
  if (!currentEditor) {
    throw new Error('No editor is currently active.');
  }

  const document = currentEditor.editor.document;
  const code = document.getText();

  return `✅ Current sketch: ${currentSketch.name}\n\n\`\`\`cpp\n${code}\n\`\`\``;
}

export async function agentModifySketch(
  ctx: {
    delay(ms: number): Promise<void>;
    editorManager: { open(uri: any): Promise<any>; currentEditor?: any };
    timing: { SKETCH_SAVE_DELAY: number; SERVICE_READY_WAIT: number; PORT_SELECTION_DELAY: number };
    showInlineDiff(uri: any, filePath: string, oldCode: string, newCode: string): Promise<void>;
    getErrorMessage(error: unknown): string;
    logError(message: string, error: unknown): void;
  },
  filePath: string,
  content: string
): Promise<string> {
  try {
    const uri = new URI(filePath);

    if (!content || content.trim().length === 0) {
      return '❌ Cannot modify sketch: content is empty';
    }

    await ctx.delay(ctx.timing.SKETCH_SAVE_DELAY);

    const editor = await openEditorWithRetry(ctx, uri);
    if (!editor) {
      return '❌ Could not open file in editor - please ensure the sketch is open and try pasting the code manually';
    }

    return await applyEditorChanges(ctx, editor, uri, filePath, content);
  } catch (error: unknown) {
    ctx.logError('Sketch modification error:', error);
    return `❌ Failed to modify sketch content: ${ctx.getErrorMessage(error)}`;
  }
}

async function openEditorWithRetry(
  ctx: { editorManager: { open(uri: any): Promise<any> }; delay(ms: number): Promise<void>; timing: { SERVICE_READY_WAIT: number } },
  uri: any
): Promise<any> {
  let editor = await ctx.editorManager.open(uri);

  if (!editor) {
    await ctx.delay(ctx.timing.SERVICE_READY_WAIT);
    editor = await ctx.editorManager.open(uri);
  }

  return editor;
}

async function applyEditorChanges(
  ctx: {
    delay(ms: number): Promise<void>;
    timing: { PORT_SELECTION_DELAY: number };
    showInlineDiff(uri: any, filePath: string, oldCode: string, newCode: string): Promise<void>;
  },
  editor: any,
  uri: any,
  filePath: string,
  content: string
): Promise<string> {
  await ctx.delay(ctx.timing.PORT_SELECTION_DELAY);

  const monacoEditor = editor.editor;
  if (!('getControl' in monacoEditor)) {
    return '❌ Could not access Monaco editor model - editor may not be fully loaded';
  }

  const control = (monacoEditor as any).getControl();
  const model = control.getModel();
  if (!model) {
    return '❌ Could not access Monaco editor model - editor may not be fully loaded';
  }

  const oldCode = model.getValue();

  if (oldCode !== content) {
    await ctx.showInlineDiff(uri, filePath, oldCode, content);
    return `✅ Applied changes to: ${filePath}\n\n💡 Click "Keep" to accept or "Undo" to revert`;
  }

  return `✅ Code is already up to date: ${filePath}`;
}

// ============================================================================
// Sketch File Collection
// ============================================================================

export function collectOpenArduinoFiles(editorManager: any): SketchFile[] {
  const files: SketchFile[] = [];

  for (const editor of editorManager.all) {
    if (!editor.editor.uri || !editor.editor.document) continue;

    try {
      const editorUriStr = editor.editor.uri.toString();
      const decodedEditorUri = decodeURIComponent(editorUriStr);
      const editorUri = new URI(decodedEditorUri);

      if (isArduinoFileExtension(editorUri.path.ext)) {
        const content = editor.editor.document.getText();
        files.push({
          path: editorUri.path.name + editorUri.path.ext,
          content,
        });
      }
    } catch {
      // Ignore URI processing errors
    }
  }

  return files;
}

export function findMainEditor(editorManager: any, mainFileUri: string, mainUri: URI): any {
  return editorManager.all.find((editor: any) => {
    if (!editor.editor.uri) return false;
    const editorUriStr = editor.editor.uri.toString();

    if (editorUriStr === mainFileUri || editorUriStr === mainUri.toString()) {
      return true;
    }

    return matchDecodedUris(mainFileUri, editorUriStr);
  });
}

export function addMainSketchFile(files: SketchFile[], editorManager: any, mainFileUri: string, mainUri: URI): boolean {
  const mainEditor = findMainEditor(editorManager, mainFileUri, mainUri);

  if (mainEditor && mainEditor.editor.document) {
    const content = mainEditor.editor.document.getText();
    files.push({
      path: mainUri.path.name + mainUri.path.ext,
      content,
    });
    return true;
  }

  return addMainFileByName(files, editorManager, mainUri);
}

function addMainFileByName(files: SketchFile[], editorManager: any, mainUri: URI): boolean {
  const expectedMainFileName = mainUri.path.name + mainUri.path.ext;

  for (const editor of editorManager.all) {
    if (!editor.editor.uri || !editor.editor.document) continue;

    try {
      const editorUriStr = editor.editor.uri.toString();
      const decodedEditorUri = decodeURIComponent(editorUriStr);
      const editorUri = new URI(decodedEditorUri);
      const editorFileName = editorUri.path.name + editorUri.path.ext;

      if (fileNamesMatch(editorFileName, expectedMainFileName)) {
        const content = editor.editor.document.getText();
        files.push({
          path: editorFileName,
          content,
        });
        return true;
      }
    } catch {
      // Ignore URI processing errors
    }
  }

  spectreWarn(`Could not find main file: ${expectedMainFileName}`);
  return false;
}

export function addAdditionalSketchFiles(params: {
  files: SketchFile[];
  editorManager: any;
  mainFileUri: string;
  mainUri: URI;
  mainFileAdded: boolean;
}): void {
  const { files, editorManager, mainFileUri, mainUri, mainFileAdded } = params;

  for (const editor of editorManager.all) {
    if (!editor.editor.uri || !editor.editor.document) continue;

    try {
      const editorUriStr = editor.editor.uri.toString();
      const decodedEditorUri = decodeURIComponent(editorUriStr);
      const editorUri = new URI(decodedEditorUri);

      if (
        isMainFile({
          editorUriStr,
          editorUri,
          mainFileUri,
          mainUri,
          mainFileAdded,
        })
      ) {
        continue;
      }

      if (isRelevantSketchFile(editorUri, mainUri)) {
        const content = editor.editor.document.getText();
        files.push({
          path: editorUri.path.name + editorUri.path.ext,
          content,
        });
      }
    } catch {
      // Ignore URI processing errors
    }
  }
}
