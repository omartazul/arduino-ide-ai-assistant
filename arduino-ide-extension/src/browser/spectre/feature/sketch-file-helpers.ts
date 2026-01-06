/**
 * Helper utilities for sketch file collection and management.
 * Handles file gathering from editors, URI matching, and Arduino file detection.
 *
 * @author Tazul Islam
 */

import { URI } from '@theia/core';
import { spectreWarn } from '../../../common/protocol/spectre-types';

/**
 * File information structure.
 */
interface SketchFile {
  path: string;
  content: string;
}

/**
 * Helper class for sketch file operations.
 */
export class SketchFileHelper {
  /**
   * Checks if file extension is Arduino-related.
   */
  static isArduinoFileExtension(ext: string): boolean {
    return ext === '.ino' || ext === '.cpp' || ext === '.h' || ext === '.c';
  }

  /**
   * Collects all open Arduino files from editor manager.
   */
  static collectOpenArduinoFiles(editorManager: any): SketchFile[] {
    const files: SketchFile[] = [];

    for (const editor of editorManager.all) {
      if (!editor.editor.uri || !editor.editor.document) continue;

      try {
        const editorUriStr = editor.editor.uri.toString();
        const decodedEditorUri = decodeURIComponent(editorUriStr);
        const editorUri = new URI(decodedEditorUri);

        if (SketchFileHelper.isArduinoFileExtension(editorUri.path.ext)) {
          const content = editor.editor.document.getText();
          files.push({
            path: editorUri.path.name + editorUri.path.ext,
            content: content,
          });
        }
      } catch (e) {
        // Ignore URI processing errors
      }
    }

    return files;
  }

  /**
   * Finds the main editor by matching URIs.
   */
  static findMainEditor(editorManager: any, mainFileUri: string, mainUri: URI): any {
    return editorManager.all.find((editor: any) => {
      if (!editor.editor.uri) return false;
      const editorUriStr = editor.editor.uri.toString();

      // Try exact match first
      if (editorUriStr === mainFileUri || editorUriStr === mainUri.toString()) {
        return true;
      }

      // Try decoded comparison
      return SketchFileHelper.matchDecodedUris(mainFileUri, editorUriStr);
    });
  }

  /**
   * Matches URIs after decoding them.
   */
  static matchDecodedUris(mainFileUri: string, editorUriStr: string): boolean {
    try {
      const decodedMainUri = decodeURIComponent(mainFileUri);
      const decodedEditorUri = decodeURIComponent(editorUriStr);
      
      if (decodedMainUri === decodedEditorUri) return true;

      // Try path-based comparison
      const mainPath = new URI(decodedMainUri).path.toString();
      const editorPath = new URI(decodedEditorUri).path.toString();
      return mainPath === editorPath;
    } catch (e) {
      return false;
    }
  }

  /**
   * Adds the main sketch file to the files array.
   * Returns true if main file was successfully added.
   */
  static addMainSketchFile(
    files: SketchFile[],
    editorManager: any,
    mainFileUri: string,
    mainUri: URI
  ): boolean {
    // Try to find main editor by URI matching
    const mainEditor = SketchFileHelper.findMainEditor(editorManager, mainFileUri, mainUri);

    if (mainEditor && mainEditor.editor.document) {
      const content = mainEditor.editor.document.getText();
      files.push({
        path: mainUri.path.name + mainUri.path.ext,
        content: content,
      });
      return true;
    }

    // Fallback: find by filename
    return SketchFileHelper.addMainFileByName(files, editorManager, mainUri);
  }

  /**
   * Adds main file by searching for matching filename.
   * Returns true if file was found and added.
   */
  static addMainFileByName(
    files: SketchFile[],
    editorManager: any,
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

        if (SketchFileHelper.fileNamesMatch(editorFileName, expectedMainFileName)) {
          const content = editor.editor.document.getText();
          files.push({
            path: editorFileName,
            content: content,
          });
          return true;
        }
      } catch (e) {
        // Ignore URI processing errors
      }
    }

    spectreWarn(`Could not find main file: ${expectedMainFileName}`);
    return false;
  }

  /**
   * Compares file names case-insensitively.
   */
  static fileNamesMatch(fileName1: string, fileName2: string): boolean {
    return fileName1.toLowerCase() === fileName2.toLowerCase();
  }

  /**
   * Adds additional sketch files (tabs) to the files array.
   */
  static addAdditionalSketchFiles(
    files: SketchFile[],
    editorManager: any,
    mainFileUri: string,
    mainUri: URI,
    mainFileAdded: boolean
  ): void {
    for (const editor of editorManager.all) {
      if (!editor.editor.uri || !editor.editor.document) continue;

      try {
        const editorUriStr = editor.editor.uri.toString();
        const decodedEditorUri = decodeURIComponent(editorUriStr);
        const editorUri = new URI(decodedEditorUri);

        // Skip if this is the main file (already added)
        if (SketchFileHelper.isMainFile({
          editorUriStr,
          decodedEditorUri,
          editorUri,
          mainFileUri,
          mainUri,
          mainFileAdded,
        })) {
          continue;
        }

        // Add if it's a relevant sketch file
        if (SketchFileHelper.isRelevantSketchFile(editorUri, mainUri)) {
          const content = editor.editor.document.getText();
          files.push({
            path: editorUri.path.name + editorUri.path.ext,
            content: content,
          });
        }
      } catch (e) {
        // Ignore URI processing errors
      }
    }
  }

  /**
   * Checks if editor contains the main file.
   */
  static isMainFile(params: {
    editorUriStr: string;
    decodedEditorUri: string;
    editorUri: URI;
    mainFileUri: string;
    mainUri: URI;
    mainFileAdded: boolean;
  }): boolean {
    const { editorUriStr, editorUri, mainFileUri, mainUri, mainFileAdded } = params;

    if (editorUriStr === mainFileUri || editorUriStr === mainUri.toString()) {
      return true;
    }

    if (SketchFileHelper.matchDecodedUris(mainFileUri, editorUriStr)) {
      return true;
    }

    if (mainFileAdded) {
      const mainFileName = mainUri.path.name + mainUri.path.ext;
      const editorFileName = editorUri.path.name + editorUri.path.ext;
      if (SketchFileHelper.fileNamesMatch(editorFileName, mainFileName)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Checks if file is relevant to the sketch (same directory, Arduino extension).
   */
  static isRelevantSketchFile(editorUri: URI, mainUri: URI): boolean {
    // Check if in same directory
    const editorDir = editorUri.path.dir.toString();
    const mainDir = mainUri.path.dir.toString();
    if (editorDir !== mainDir) return false;

    // Check if Arduino file
    return SketchFileHelper.isArduinoFileExtension(editorUri.path.ext);
  }
}
