/**
 * Generates a compact, human-readable title for a chat session.
 *
 * Extracted from `spectre-widget.tsx` to reduce module size.
 *
 * @author Tazul Islam
 */
export function autoTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();

  // Handle very short inputs
  if (clean.length <= 3) return clean;

  // Detect and handle URLs/file paths
  if (clean.match(/^https?:\/\/|^\/|^[A-Z]:\\/)) {
    const urlMatch = clean.match(/\/([^\/]+)(?:\.[^\/]*)?$/);
    if (urlMatch) return `File: ${urlMatch[1]}`;
    return clean.length <= 50 ? clean : clean.slice(0, 47) + '…';
  }

  // Arduino/IoT-specific keywords to preserve
  const arduinoKeywords =
    /\b(arduino|esp32|esp8266|raspberry\s*pi|sensor|led|pwm|analog|digital|pin|i2c|spi|uart|servo|motor|wifi|bluetooth|mqtt|http|json|temperature|humidity|pressure|ultrasonic|gyro|accelerometer|magnetometer|gps|lcd|oled|display|relay|transistor|resistor|capacitor|voltage|current|ohm|amp|volt|watt|frequency|baud|rate|interrupt|timer|delay|millis|micros|setup|loop|void|int|float|double|char|string|array|struct|class|library|include|define|ifdef|ifndef|endif)\b/gi;

  // Technical terms and units to preserve
  const technicalTerms =
    /\b(\d+(?:\.\d+)?\s*(?:v|a|ma|ua|hz|khz|mhz|ghz|mm|cm|m|km|kg|g|mg|°c|°f|k|rpm|ppm|db|lux|pa|bar|psi|mb|gb|kb|bits?|bytes?|mbit|gbit)\b|\d+(?:k|m|g)?(?:hz|bit|byte)s?\b)/gi;

  // Code detection patterns
  const codePatterns = [
    /\/\/|\/\*|\*\/|#include|#define|#ifdef/,
    /\bfunction\s+\w+|def\s+\w+|class\s+\w+/,
    /\b(?:const|let|var)\s+\w+\s*=/,
    /\bvoid\s+setup|void\s+loop/,
    /digitalWrite|digitalRead|analogWrite|analogRead/,
    /Serial\.print|Serial\.begin/,
    /\bfor\s*\(|while\s*\(|if\s*\(/,
  ];

  const isCode = codePatterns.some((pattern) => pattern.test(clean));

  // Handle code snippets with detection
  if (isCode) {
    const lines = clean.split('\n');

    // Look for comments with meaningful content
    const comment = lines.find((line) => {
      const trimmed = line.trim();
      const commentContent = trimmed.replace(/^(\/\/|\/\*|\*|#)\s*/, '').trim();
      return (
        (trimmed.startsWith('//') ||
          trimmed.startsWith('#') ||
          trimmed.startsWith('/*') ||
          trimmed.startsWith('*')) &&
        commentContent.length > 5 &&
        !commentContent.match(/^-+$|^\*+$|^=+$/)
      );
    });

    if (comment) {
      const commentText = comment
        .replace(/^(\/\/|\/\*|\*|#)\s*/, '')
        .replace(/\*\/.*$/, '')
        .trim();
      return commentText.length <= 50
        ? commentText
        : commentText.slice(0, 47) + '…';
    }

    // Look for Arduino-specific function calls
    const arduinoMatch = clean.match(
      /(digitalWrite|digitalRead|analogWrite|analogRead|Serial\.print|pinMode)\s*\([^)]*\)/
    );
    if (arduinoMatch) {
      return `Arduino: ${arduinoMatch[1]}`;
    }

    // Look for function definitions with better parsing
    const funcMatch = clean.match(
      /\b(?:function|def|void|int|float|double|bool|char|String)\s+(\w+)\s*\(/
    );
    if (funcMatch) {
      return `Function: ${funcMatch[1]}`;
    }

    // Look for variable declarations
    const varMatch = clean.match(
      /\b(?:const|let|var|int|float|double|bool|char|String)\s+(\w+)/
    );
    if (varMatch) {
      return `Declare: ${varMatch[1]}`;
    }

    // Fallback to first meaningful code line
    const meaningfulLine = lines.find((line) => {
      const trimmed = line.trim();
      return (
        trimmed.length > 5 &&
        !trimmed.match(/^[{}();,]*$/) &&
        !trimmed.match(/^\/\/\s*$|^#\s*$/)
      );
    });

    if (meaningfulLine) {
      const trimmed = meaningfulLine.trim();
      return trimmed.length <= 50 ? trimmed : trimmed.slice(0, 47) + '…';
    }
  }

  // Preserve important keywords and technical terms
  const preserveKeywords = (textToPreserve: string): string => {
    const words = textToPreserve.split(' ');
    const preserved: string[] = [];
    let totalLength = 0;

    for (const word of words) {
      // Always preserve Arduino/technical keywords
      if (word.match(arduinoKeywords) || word.match(technicalTerms)) {
        if (totalLength + word.length + 1 <= 45) {
          preserved.push(word);
          totalLength += word.length + 1;
        }
      } else if (preserved.length < 3 && totalLength + word.length + 1 <= 45) {
        // Include other important words up to limit
        preserved.push(word);
        totalLength += word.length + 1;
      }
    }

    return preserved.length > 0 ? preserved.join(' ') : textToPreserve;
  };

  // More nuanced prefix removal for different content types
  let cleaned = clean;

  // Question patterns - be more selective
  if (
    clean.match(
      /^(how do i|how to|what is|can you explain|could you help|please help)/i
    )
  ) {
    cleaned = clean.replace(
      /^(how do i|how to|what is|can you explain|could you help|please help)\s*/i,
      ''
    );
  }

  // Remove trailing question marks and common endings
  cleaned = cleaned
    .replace(/\?+$/, '')
    .replace(/\s+(please|thanks?|thank you)\.?$/i, '');

  // Use cleaned version if it's substantial enough
  const result =
    cleaned.length > 5 && cleaned.length >= clean.length * 0.6
      ? cleaned
      : clean;

  // Apply keyword preservation
  const keywordPreserved = preserveKeywords(result);
  if (keywordPreserved !== result && keywordPreserved.length > 10) {
    return (
      keywordPreserved + (keywordPreserved.length < result.length ? '…' : '')
    );
  }

  // If already short enough, return as-is
  if (result.length <= 50) return result;

  // Smart truncation with better break points
  const breakPoints =
    /[.!?;:]|\s(?:and|or|but|with|for|in|on|at|to|from|using|via|by|of|about)\s/gi;
  let match: RegExpExecArray | null;
  let lastGoodBreak = 0;

  while ((match = breakPoints.exec(result)) !== null) {
    if (match.index < 45 && match.index > 15) {
      // Ensure minimum meaningful length
      lastGoodBreak = match.index + match[0].length;
    } else if (match.index >= 45) {
      break;
    }
  }

  if (lastGoodBreak > 15) {
    const truncated = result.slice(0, lastGoodBreak).trim();
    return truncated + (truncated.length < result.length ? '…' : '');
  }

  // Smart word boundary truncation preserving important terms
  const words = result.split(' ');
  let title = '';
  let hasImportantTerm = false;

  for (const word of words) {
    const newLength = (title + ' ' + word).length;
    if (newLength > 47) {
      // If we haven't included any important terms yet, try to fit one more
      if (!hasImportantTerm && word.match(arduinoKeywords)) {
        title += (title ? ' ' : '') + word;
        hasImportantTerm = true;
      }
      break;
    }
    title += (title ? ' ' : '') + word;
    if (word.match(arduinoKeywords) || word.match(technicalTerms)) {
      hasImportantTerm = true;
    }
  }

  return title + (title.length < result.length ? '…' : '');
}
