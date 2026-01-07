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
import { addAdditionalSketchFiles, addMainSketchFile, collectOpenArduinoFiles } from '../agent/sketch-operations';

// ============================================================================
// Types and Interfaces
// ============================================================================

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
        `**${file.path}:**\n\`\`\`${UIHelper.getFileLanguage(file.path)}\n${file.content}\n\`\`\``
    )
    .join('\n\n');
}

// ============================================================================
// Current Sketch Files Collection
// ============================================================================

/**
 * Gets all files from the currently open sketch.
 */
export async function getCurrentSketchFiles(params: {
  sketchesClient: { tryGetCurrentSketch(): CurrentSketch | undefined };
  editorManager: any;
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
export function matchDecodedUris(mainFileUri: string, editorUriStr: string): boolean {
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
 * Checks if the given editor URI represents the main sketch file.
 */
export function isMainFile(params: {
  editorUriStr: string;
  editorUri: URI;
  mainFileUri: string;
  mainUri: URI;
  mainFileAdded: boolean;
}): boolean {
  const { editorUriStr, editorUri, mainFileUri, mainUri, mainFileAdded } = params;

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
