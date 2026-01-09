/**
 * UI utilities for the Spectre widget.
 *
 * Includes helpers for code extraction, language detection, and diff visualization.
 *
 * @author Tazul Islam
 */

import { extractExplicitCodeBlocks as extractFencedBlocks } from './ui-utilities';

/**
 * Code block type with metadata.
 */
interface CodeBlock {
  code: string;
  type: 'block' | 'inline';
  language?: string;
}

/**
 * Helper class for UI-related operations.
 */
export class UIHelper {
  /**
   * Detects if text contains Arduino code patterns.
   */
  static containsArduinoCode(text: string): boolean {
    const lines = text.split('\n');
    let codeLines = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed || UIHelper.isEmptyLineOrComment(trimmed)) {
        continue;
      }

      if (UIHelper.hasArduinoPattern(trimmed)) {
        codeLines++;
      }
    }

    return codeLines >= 2;
  }

  private static isEmptyLineOrComment(trimmed: string): boolean {
    return (
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*')
    );
  }

  private static hasArduinoPattern(trimmed: string): boolean {
    const arduinoPatterns = [
      /\b(void|int|float|char|boolean|byte|String)\s+\w+\s*\(/,
      /\b(pinMode|digitalWrite|digitalRead|analogWrite|analogRead)\s*\(/,
      /\b(Serial\.(begin|print|println|available|read))\s*\(/,
      /\b(delay|millis|micros)\s*\(/,
      /\b(setup|loop)\s*\(\s*\)\s*\{/,
      /^#include\s+[<"]/,
      /^#define\s+\w+/,
      /\b(HIGH|LOW|INPUT|OUTPUT|INPUT_PULLUP)\b/,
      /\b(for|while|if|else|switch|case)\s*\(/,
      /\w+\s*=\s*\w+\s*;/,
      /\w+\s*\(\s*\)\s*;/,
    ];

    return arduinoPatterns.some((pattern) => pattern.test(trimmed));
  }

  /**
   * Extracts explicit code blocks (```cpp, ```c, ```arduino, ```ino, or plain ```).
   */
  static extractExplicitCodeBlocks(text: string): CodeBlock[] {
    return extractFencedBlocks(text);
  }

  /**
   * Checks if a line is a strong code indicator.
   */
  static isCodeLine(line: string): boolean {
    const codeIndicators = [
      /^\s*(void|int|float|char|boolean|String)\s+\w+/,
      /^\s*#include\s+[<"]/,
      /^\s*#define\s+\w+/,
      /^\s*(pinMode|digitalWrite|digitalRead|analogWrite|analogRead)\s*\(/,
      /^\s*(Serial\.(begin|print|println))\s*\(/,
      /^\s*for\s*\(/,
      /^\s*while\s*\(/,
      /^\s*if\s*\(/,
      /\{\s*$/,
      /;\s*$/,
    ];

    return codeIndicators.some((pattern) => pattern.test(line));
  }

  /**
   * Checks if line should be added to code section.
   */
  static shouldAddToCodeSection(params: {
    line: string;
    trimmed: string;
    inCodeSection: boolean;
    isCode: boolean;
    isExplanation: boolean;
    codeStarted: boolean;
  }): { add: boolean; continueSection: boolean } {
    const { trimmed, inCodeSection, isCode, isExplanation, codeStarted } =
      params;

    if (!trimmed) {
      return { add: inCodeSection, continueSection: inCodeSection };
    }

    if (isCode) {
      return { add: true, continueSection: true };
    }

    if (isExplanation && !codeStarted) {
      return { add: false, continueSection: false };
    }

    if (inCodeSection && !isExplanation) {
      return { add: true, continueSection: true };
    }

    return { add: false, continueSection: false };
  }

  /**
   * Checks if a line looks like explanatory text rather than code.
   */
  static isExplanatoryText(line: string, isCodeLine: boolean): boolean {
    if (isCodeLine) return false;

    const explanationPatterns = [
      /^(here|this|the|you|we|it|to|for|in|and|or|but|with|that)\s+/i,
      /\?$/,
      /^(note|example|explanation|description|comment):/i,
    ];

    return explanationPatterns.some((pattern) => pattern.test(line.trim()));
  }

  /**
   * Extracts inline code from mixed text by analyzing line patterns.
   */
  static extractInlineCode(text: string): string | null {
    const lines = text.split('\n');
    const codeLines = UIHelper.processCodeLines(lines);
    return UIHelper.validateExtractedCode(codeLines);
  }

  private static processCodeLines(lines: string[]): string[] {
    const codeLines: string[] = [];
    let inCodeSection = false;
    let codeStarted = false;

    for (const line of lines) {
      const trimmed = line.trim();
      const isCode = UIHelper.isCodeLine(line);
      const isExplanation = UIHelper.isExplanatoryText(line, isCode);

      const result = UIHelper.shouldAddToCodeSection({
        line,
        trimmed,
        inCodeSection,
        isCode,
        isExplanation,
        codeStarted,
      });

      if (result.add) {
        codeLines.push(line);
        if (isCode) codeStarted = true;
      }

      inCodeSection = result.continueSection;
    }

    return codeLines;
  }

  private static validateExtractedCode(codeLines: string[]): string | null {
    if (codeLines.length === 0) return null;

    const code = codeLines.join('\n').trim();

    if (code.length < 20) return null;
    if (!UIHelper.containsArduinoCode(code)) return null;

    return code;
  }

  /**
   * Extracts Arduino code from text (looks for code blocks or detects Arduino patterns).
   */
  static extractArduinoCode(text: string): CodeBlock[] {
    const explicitBlocks = UIHelper.extractExplicitCodeBlocks(text);
    if (explicitBlocks.length > 0) {
      return explicitBlocks;
    }

    const inlineCode = UIHelper.extractInlineCode(text);
    if (inlineCode) {
      return [{ code: inlineCode, type: 'inline', language: 'cpp' }];
    }

    return [];
  }

  /**
   * Gets the programming language for syntax highlighting based on file extension.
   */
  static getFileLanguage(filePath: string): string {
    const FILE_LANGUAGE_MAP: { [key: string]: string } = {
      ino: 'cpp',
      cpp: 'cpp',
      cc: 'cpp',
      cxx: 'cpp',
      h: 'cpp',
      hpp: 'cpp',
      c: 'c',
      js: 'javascript',
      py: 'python',
    };

    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    return FILE_LANGUAGE_MAP[ext] || 'text';
  }

  /**
   * Finds matching lines using lookahead to detect additions/deletions.
   */
  static findLineMatch(params: {
    oldLines: string[];
    newLines: string[];
    oldIdx: number;
    newIdx: number;
    decorations: any[];
    contentWidgets: any[];
  }): { oldIdx: number; newIdx: number } {
    const { oldLines, newLines, oldIdx, newIdx, decorations, contentWidgets } =
      params;

    // Try deletion check
    const deletionResult = UIHelper.checkDeletion({
      oldLines,
      newLines,
      oldIdx,
      newIdx,
      contentWidgets,
    });
    if (deletionResult) return deletionResult;

    // Try addition check
    const additionResult = UIHelper.checkAddition({
      oldLines,
      newLines,
      oldIdx,
      newIdx,
      decorations,
    });
    if (additionResult) return additionResult;

    // Direct replacement
    return UIHelper.handleDirectReplacement({
      oldLines,
      newLines,
      oldIdx,
      newIdx,
      decorations,
      contentWidgets,
    });
  }

  private static checkDeletion(params: {
    oldLines: string[];
    newLines: string[];
    oldIdx: number;
    newIdx: number;
    contentWidgets: any[];
  }): { oldIdx: number; newIdx: number } | null {
    const { oldLines, newLines, oldIdx, newIdx, contentWidgets } = params;
    const lookahead = UIHelper.tryLookaheadMatch(
      newLines[newIdx],
      oldLines,
      oldIdx + 1,
      3
    );

    if (lookahead !== -1) {
      // Deletion detected: old line removed from new text.
      // Render the deleted line as a view-zone above the current new line.
      contentWidgets.push({ lineNumber: newIdx + 1, text: oldLines[oldIdx] });
      return { oldIdx: oldIdx + 1, newIdx };
    }

    return null;
  }

  private static checkAddition(params: {
    oldLines: string[];
    newLines: string[];
    oldIdx: number;
    newIdx: number;
    decorations: any[];
  }): { oldIdx: number; newIdx: number } | null {
    const { oldLines, newLines, oldIdx, newIdx, decorations } = params;
    const lookahead = UIHelper.tryLookaheadMatch(
      oldLines[oldIdx],
      newLines,
      newIdx + 1,
      3
    );

    if (lookahead !== -1) {
      // Addition detected: new line inserted into new text.
      UIHelper.addAdditionDecoration(decorations, newIdx + 1);
      return { oldIdx, newIdx: newIdx + 1 };
    }

    return null;
  }

  private static handleDirectReplacement(params: {
    oldLines: string[];
    newLines: string[];
    oldIdx: number;
    newIdx: number;
    decorations: any[];
    contentWidgets: any[];
  }): { oldIdx: number; newIdx: number } {
    const { oldIdx, newIdx, decorations, contentWidgets } = params;

    // Replacement: show deleted above added
    contentWidgets.push({
      lineNumber: newIdx + 1,
      text: params.oldLines[oldIdx],
    });
    UIHelper.addAdditionDecoration(decorations, newIdx + 1);

    return { oldIdx: oldIdx + 1, newIdx: newIdx + 1 };
  }

  /**
   * Performs lookahead matching to find line correspondence.
   */
  static tryLookaheadMatch(
    currentLine: string,
    searchLines: string[],
    searchStartIdx: number,
    maxLookahead: number
  ): number {
    for (
      let i = 0;
      i < maxLookahead && searchStartIdx + i < searchLines.length;
      i++
    ) {
      if (searchLines[searchStartIdx + i] === currentLine) {
        return searchStartIdx + i;
      }
    }
    return -1;
  }

  /**
   * Adds decoration for an added line.
   */
  static addAdditionDecoration(decorations: any[], lineNumber: number): void {
    decorations.push({
      range: {
        startLineNumber: lineNumber,
        startColumn: 1,
        endLineNumber: lineNumber,
        endColumn: 1,
      },
      options: {
        isWholeLine: true,
        className: 'spectre-diff-line-added',
        glyphMarginClassName: 'spectre-diff-glyph-add',
      },
    });
  }

  /**
   * Computes diff decorations and content widgets for line-by-line comparison.
   */
  static computeDiffElements(
    oldLines: string[],
    newLines: string[]
  ): { decorations: any[]; contentWidgets: any[] } {
    const decorations: any[] = [];
    const contentWidgets: any[] = [];
    let oldIdx = 0;
    let newIdx = 0;

    while (oldIdx < oldLines.length || newIdx < newLines.length) {
      if (oldIdx >= oldLines.length) {
        // Only new lines left
        UIHelper.addAdditionDecoration(decorations, newIdx + 1);
        newIdx++;
      } else if (newIdx >= newLines.length) {
        // Only old lines left (deletions at end)
        oldIdx++;
      } else if (oldLines[oldIdx] === newLines[newIdx]) {
        // Lines match, move forward
        oldIdx++;
        newIdx++;
      } else {
        // Lines differ, find match
        const result = UIHelper.findLineMatch({
          oldLines,
          newLines,
          oldIdx,
          newIdx,
          decorations,
          contentWidgets,
        });
        oldIdx = result.oldIdx;
        newIdx = result.newIdx;
      }
    }

    return { decorations, contentWidgets };
  }

  /**
   * Applies simple edit to Monaco editor model.
   */
  static applySimpleEdit(control: any, model: any, newCode: string): void {
    const fullRange = model.getFullModelRange();
    control.executeEdits('spectre-agent', [
      {
        range: fullRange,
        text: newCode,
      },
    ]);
  }

  /**
   * Creates view zones for removed lines.
   */
  static createViewZones(control: any, contentWidgets: any[]): string[] {
    const zoneIds: string[] = [];
    control.changeViewZones((changeAccessor: any) => {
      for (const widget of contentWidgets) {
        try {
          const container = document.createElement('div');
          container.style.cssText = `
            background: rgba(255, 129, 130, 0.15) !important;
            border-left: 4px solid #ff0000 !important;
            padding: 4px 8px !important;
            font-family: var(--monaco-monospace-font), monospace !important;
            font-size: var(--monaco-font-size, 14px) !important;
            line-height: var(--monaco-line-height, 19px) !important;
            color: #a31515 !important;
            width: 100% !important;
            box-sizing: border-box !important;
          `;

          const lineText = document.createElement('span');
          lineText.textContent = widget.text ?? widget.deletedLine ?? '';
          lineText.style.cssText = 'opacity: 0.8;';
          container.appendChild(lineText);

          const zoneId = changeAccessor.addZone({
            afterLineNumber: widget.lineNumber - 1,
            heightInLines: 1,
            domNode: container,
            suppressMouseDown: true,
          });
          zoneIds.push(zoneId);
        } catch (e) {
          // Ignore zone creation errors
        }
      }
    });
    return zoneIds;
  }

  /**
   * Gets language display name and line count for a code block.
   */
  static getCodeBlockMetadata(codeBlock: CodeBlock): {
    language: string;
    lineCount: number;
  } {
    const lineCount = codeBlock.code.split('\n').length;
    const language = codeBlock.language
      ? codeBlock.language.toUpperCase()
      : 'ARDUINO';
    return { language, lineCount };
  }
}
