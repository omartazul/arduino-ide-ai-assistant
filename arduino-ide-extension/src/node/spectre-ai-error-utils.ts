export type ClassifiedError = {
  retryable: boolean;
  category: 'auth' | 'rate' | 'quota' | 'canceled' | 'other';
  message: string;
};

function isServerError(status: unknown): boolean {
  return typeof status === 'number' && status >= 500 && status < 600;
}

function isAuthError(status: unknown, message: string): boolean {
  return (
    status === 401 ||
    /UNAUTHENTICATED|permission|unauthorized|API key/i.test(message)
  );
}

function isRateError(status: unknown, message: string): boolean {
  return status === 429 || /rate|RESOURCE_EXHAUSTED/i.test(message);
}

function isQuotaError(message: string): boolean {
  return /quota/i.test(message) && /exceed|exhaust/i.test(message);
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getErrorStatus(err: any): unknown {
  return err && (err.status || err.code || err.statusCode);
}

export function classifyError(err: unknown): ClassifiedError {
  const message = getErrorMessage(err);
  const status = getErrorStatus(err);

  const checks: Array<() => ClassifiedError | null> = [
    () => (/abort/i.test(message) ? { retryable: false, category: 'canceled', message } : null),
    () => (isAuthError(status, message) ? { retryable: false, category: 'auth', message } : null),
    () => (isQuotaError(message) ? { retryable: false, category: 'quota', message } : null),
    () => (isRateError(status, message) ? { retryable: true, category: 'rate', message } : null),
    () => classifyGeminiSpecific(message),
    () => (isServerError(status) ? { retryable: true, category: 'other', message } : null),
  ];

  for (const check of checks) {
    const result = check();
    if (result) return result;
  }

  return { retryable: false, category: 'other', message };
}

function classifyGeminiSpecific(message: string): ClassifiedError | null {
  if (/overloaded|503|Service Unavailable/i.test(message)) {
    return {
      retryable: true,
      category: 'other',
      message: 'Gemini API overloaded - retrying...',
    };
  }
  if (/Failed to parse stream|parse.*stream/i.test(message)) {
    return {
      retryable: true,
      category: 'other',
      message: 'Network stream error - retrying...',
    };
  }
  if (/Error fetching/i.test(message)) {
    return {
      retryable: true,
      category: 'other',
      message: 'Network connection error - retrying...',
    };
  }
  return null;
}

function redactString(value: string): string {
  // Common Google API key prefix is AIza; redact anything that looks like a key.
  return value.replace(/AIza[0-9A-Za-z_\-]{20,}/g, '[REDACTED_API_KEY]');
}

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k === 'apikey' ||
    k === 'api_key' ||
    k === 'authorization' ||
    k === 'x-goog-api-key' ||
    k.includes('token') ||
    k.includes('secret')
  );
}

function sanitizeError(err: Error): Record<string, unknown> {
  return {
    name: err.name,
    message: redactString(err.message || ''),
    stack: err.stack ? redactString(err.stack) : undefined,
  };
}

function sanitizeArray(value: unknown[], seen: WeakSet<object>): unknown[] {
  return value.slice(0, 50).map((v) => sanitizeValue(v, seen));
}

function sanitizeObject(value: Record<string, unknown>, seen: WeakSet<object>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSensitiveKey(k) ? '[REDACTED]' : sanitizeValue(v, seen);
  }
  return out;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[Circular]';

  seen.add(value);

  if (value instanceof Error) return sanitizeError(value);
  if (Array.isArray(value)) return sanitizeArray(value, seen);

  return sanitizeObject(value as Record<string, unknown>, seen);
}

export function sanitizeForLogging(input: unknown): unknown {
  return sanitizeValue(input, new WeakSet<object>());
}
