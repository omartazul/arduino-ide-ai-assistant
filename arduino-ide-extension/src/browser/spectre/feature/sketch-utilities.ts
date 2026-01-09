/**
 * Consolidated sketch utilities.
 * Utilities for building sketch context and collecting current sketch files.
 *
 * @author Tazul Islam
 */

import { URI } from '@theia/core/lib/common/uri';
import { spectreWarn } from '../../../common/protocol/spectre-types';
import { CurrentSketch } from '../../sketches-service-client-impl';
import { UIHelper } from '../ui/ui-helper';

// ============================================================================
// Types and Interfaces
// ============================================================================

interface MonacoEditor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uri: any;
  document: {
    getText: () => string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    uri: any;
  };
}

interface EditorWidget {
  editor: MonacoEditor;
}

interface EditorManager {
  all: EditorWidget[];
}

export interface SketchFile {
  path: string;
  content: string;
}

// ============================================================================
// Sketch Context Building
// ============================================================================

/**
 * Builds sketch context string from sketch files.
 * Formats each file with path and language-tagged code block.
 */
export function buildSketchContext(sketchFiles: SketchFile[]): string {
  if (sketchFiles.length === 0) {
    return 'No Arduino sketch is currently open in the IDE.';
  }

  return sketchFiles
    .map(
      (file) =>
        `**${file.path}:**\n\`\`\`${UIHelper.getFileLanguage(file.path)}\n${
          file.content
        }\n\`\`\``
    )
    .join('\n\n');
}

// ============================================================================
// URI Matching Utilities
// ============================================================================

/**
 * Checks if a file extension is an Arduino file type.
 */
export function isArduinoFileExtension(ext: string): boolean {
  return ext === '.ino' || ext === '.cpp' || ext === '.h' || ext === '.c';
}

/**
 * Case-insensitive filename comparison.
 */
export function fileNamesMatch(fileName1: string, fileName2: string): boolean {
  return fileName1.toLowerCase() === fileName2.toLowerCase();
}

/**
 * Checks if two URIs match after decoding.
 */
export function matchDecodedUris(
  mainFileUri: string,
  editorUriStr: string
): boolean {
  try {
    const decodedMainUri = decodeURIComponent(mainFileUri);
    const decodedEditorUri = decodeURIComponent(editorUriStr);

    if (decodedMainUri === decodedEditorUri) return true;

    const mainPath = new URI(decodedMainUri).path.toString();
    const editorPath = new URI(decodedEditorUri).path.toString();
    return mainPath === editorPath;
  } catch {
    return false;
  }
}

/**
 * Checks if the given editor/URI context represents the main sketch file.
 */
export function isMainFile(params: {
  editorUriStr: string;
  editorUri: URI;
  mainFileUri: string;
  mainUri: URI;
  mainFileAdded: boolean;
}): boolean {
  const { editorUriStr, editorUri, mainFileUri, mainUri, mainFileAdded } =
    params;

  if (editorUriStr === mainFileUri || editorUriStr === mainUri.toString()) {
    return true;
  }

  if (matchDecodedUris(mainFileUri, editorUriStr)) {
    return true;
  }

  if (!mainFileAdded) {
    return false;
  }

  const mainFileName = mainUri.path.name + mainUri.path.ext;
  const editorFileName = editorUri.path.name + editorUri.path.ext;
  return fileNamesMatch(editorFileName, mainFileName);
}

/**
 * Checks if an editor URI is a relevant sketch file (same directory, Arduino extension).
 */
export function isRelevantSketchFile(editorUri: URI, mainUri: URI): boolean {
  const editorDir = editorUri.path.dir.toString();
  const mainDir = mainUri.path.dir.toString();
  if (editorDir !== mainDir) return false;

  return isArduinoFileExtension(editorUri.path.ext);
}

// ============================================================================
// Current Sketch Files Collection
// ============================================================================

/**
 * Gets all files from the currently open sketch.
 */
export async function getCurrentSketchFiles(params: {
  sketchesClient: { tryGetCurrentSketch(): CurrentSketch | undefined };
  editorManager: EditorManager;
}): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];

  try {
    const sketch = params.sketchesClient.tryGetCurrentSketch();

    if (!CurrentSketch.isValid(sketch)) {
      return collectOpenArduinoFiles(params.editorManager);
    }

    const mainFileUri = sketch.mainFileUri || sketch.uri;
    const mainUri = new URI(mainFileUri);

    const mainFileAdded = addMainSketchFile(
      files,
      params.editorManager,
      mainFileUri,
      mainUri
    );

    addAdditionalSketchFiles({
      files,
      editorManager: params.editorManager,
      mainFileUri,
      mainUri,
      mainFileAdded,
    });
  } catch (error) {
    spectreWarn('Spectre: Failed to collect sketch files:', error);
  }

  return files;
}

// ============================================================================
// File Collection Logic (Moved from agent/sketch-operations.ts)
// ============================================================================

export function collectOpenArduinoFiles(
  editorManager: EditorManager
): SketchFile[] {
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

export function findMainEditor(
  editorManager: EditorManager,
  mainFileUri: string,
  mainUri: URI
): EditorWidget | undefined {
  return editorManager.all.find((editor) => {
    if (!editor.editor.uri) return false;
    const editorUriStr = editor.editor.uri.toString();

    if (editorUriStr === mainFileUri || editorUriStr === mainUri.toString()) {
      return true;
    }

    return matchDecodedUris(mainFileUri, editorUriStr);
  });
}

export function addMainSketchFile(
  files: SketchFile[],
  editorManager: EditorManager,
  mainFileUri: string,
  mainUri: URI
): boolean {
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

function addMainFileByName(
  files: SketchFile[],
  editorManager: EditorManager,
  mainUri: URI
): boolean {
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
  editorManager: EditorManager;
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
