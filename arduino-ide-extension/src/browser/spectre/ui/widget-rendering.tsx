/**
 * React rendering helpers for SpectreWidget.
 * Extracted to reduce main widget file complexity.
 *
 * @author Tazul Islam
 */
import * as React from '@theia/core/shared/react';
import { AgentTask } from '../agent/agent-utils';
import type { ConversationMemory } from '../memory/memory-types';
import { TokenCounter } from '../utils/token-counter';

/**
 * Chat message interface for message rendering.
 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Chat session interface for tab rendering.
 */
export interface ChatSession {
  id: number;
  title: string;
  messages: ChatMessage[];
  memory?: ConversationMemory;
}

/**
 * Props for task list rendering.
 */
interface TaskListProps {
  tasks: AgentTask[];
  tasksExpanded: boolean;
  tasksClosed: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
}

/**
 * Props for session tabs rendering.
 */
interface SessionTabsProps {
  sessions: ChatSession[];
  active: number;
  onSetActive: (index: number) => void;
}

/**
 * Props for empty state rendering.
 */
interface EmptyStateProps {
  isAgentMode: boolean;
}

/**
 * Props for message rendering.
 */
interface MessageProps {
  message: ChatMessage;
  idx: number;
  sessionLength: number;
  busy: boolean;
  renderAssistantMessage: (
    text: string,
    isStreaming: boolean
  ) => React.ReactNode;
}

/**
 * Props for error message rendering.
 */
interface ErrorMessageProps {
  error?: string;
  retryable?: boolean;
  onRetry: () => void;
}

/**
 * Props for character limit warning rendering.
 */
interface CharLimitWarningProps {
  inputLength: number;
  charLimit: number;
  busy: boolean;
}

/**
 * Props for input area rendering.
 */
interface InputAreaProps {
  input: string;
  busy: boolean;
  mode: 'agent' | 'basic';
  model: string;
  charLimit: number;
  onInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSendClick: () => void;
  onCancelClick: () => void;
  inputRef: (el: HTMLTextAreaElement | null) => void;
  inlineQuota: React.ReactNode;
  memoryStats: React.ReactNode;
}

interface InlineQuotaProps {
  quotaUsed: number;
  quotaCapacity: number;
  rpmUsed: number;
  rpmLimit: number;
  queueSize: number;
  nextAvailableMs: number;
  now: number;
  clientRpm: number;
  dailyStats: { requests: number; tokens: number };
  model: string;
}

interface MemoryStatsFooterProps {
  memoryStats?: {
    recentMessages: number;
    summaries: number;
    totalTokens: number;
    isSummarizing?: boolean;
  };
}

/**
 * Checks if task list should be hidden.
 */
function shouldHideTaskList(tasks: AgentTask[], tasksClosed: boolean): boolean {
  return !tasks || tasks.length === 0 || tasksClosed;
}

/**
 * Renders the task list panel for agent mode.
 */
export function renderTaskList(props: TaskListProps): React.ReactNode {
  const { tasks, tasksExpanded, tasksClosed, onToggleExpand, onClose } = props;

  if (shouldHideTaskList(tasks, tasksClosed)) {
    return null;
  }

  const completedCount = tasks.filter((t) => t.status === 'completed').length;
  const totalCount = tasks.length;

  return (
    <div className="spectre-task-list">
      <div className="spectre-task-header">
        <div
          className="spectre-task-header-left"
          onClick={onToggleExpand}
          style={{
            cursor: 'pointer',
            userSelect: 'none',
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <span className="spectre-task-toggle">
            {tasksExpanded ? '▼' : '▶'}
          </span>
          <strong>
            📋 Tasks ({completedCount}/{totalCount})
          </strong>
        </div>
        <button
          className="spectre-task-close"
          onClick={onClose}
          aria-label="Close task list"
          title="Close task list"
          style={{
            cursor: 'pointer',
            padding: '2px 6px',
            background: 'transparent',
            border: 'none',
            color: 'var(--theia-foreground)',
            opacity: 0.6,
            fontSize: '16px',
          }}
        >
          ✕
        </button>
      </div>
      {tasksExpanded && tasks.map((task) => renderTask(task))}
    </div>
  );
}

/**
 * Renders a single task item.
 */
const TASK_STATUS_MAP: Record<AgentTask['status'], { icon: string; className: string }> = {
  'pending': { icon: '○', className: 'task-pending' },
  'in-progress': { icon: '⏳', className: 'task-in-progress' },
  'completed': { icon: '✓', className: 'task-completed' },
  'failed': { icon: '✗', className: 'task-failed' },
};

function renderTask(task: AgentTask): React.ReactNode {
  const { icon, className } = TASK_STATUS_MAP[task.status] || {
    icon: '',
    className: '',
  };

  return (
    <div key={task.id} className={`spectre-task ${className}`}>
      <span className="spectre-task-icon">{icon}</span>
      <span className="spectre-task-description">{task.description}</span>
      {task.error && (
        <div className="spectre-task-error">Error: {task.error}</div>
      )}
    </div>
  );
}

/**
 * Renders session tab navigation.
 */
export function renderSessionTabs(props: SessionTabsProps): React.ReactNode {
  const { sessions, active, onSetActive } = props;

  return (
    <div className="spectre-tabs" role="tablist" aria-label="Chat sessions">
      {sessions.map((s, i) => (
        <div
          key={s.id}
          role="tab"
          aria-selected={i === active}
          aria-label={`Chat session: ${s.title}`}
          className={i === active ? 'spectre-tab active' : 'spectre-tab'}
          onClick={() => onSetActive(i)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSetActive(i);
            }
          }}
          tabIndex={0}
          title={s.title}
        >
          {s.title}
        </div>
      ))}
    </div>
  );
}

/**
 * Renders empty state message when no messages exist.
 */
export function renderEmptyState(props: EmptyStateProps): React.ReactNode {
  const { isAgentMode } = props;

  return (
    <div className="spectre-empty">
      {isAgentMode ? (
        <div>
          <strong>Agent Mode:</strong> I can autonomously create/edit sketches,
          verify code, upload to boards, install/manage boards & libraries, and
          configure board settings.
          <br />
          Just ask me what you need - I&apos;ll execute IDE actions
          automatically.
        </div>
      ) : (
        <div>
          <strong>Basic Mode:</strong> Ask me anything about Arduino
          programming.
          <br />I can see your current sketch files and remember our
          conversation.
        </div>
      )}
      <div style={{ marginTop: '8px', fontSize: '12px', opacity: 0.7 }}>
        Requests over quota are queued automatically.
      </div>
    </div>
  );
}

/**
 * Renders a single message bubble (user or assistant).
 */
export function renderMessage(props: MessageProps): React.ReactNode {
  const { message, idx, sessionLength, busy, renderAssistantMessage } = props;
  const isUser = message.role === 'user';
  const isLastMessage = idx === sessionLength - 1;

  return (
    <div
      key={message.id}
      className={`spectre-row ${isUser ? 'user' : 'assistant'}`}
    >
      <div className={`spectre-bubble ${isUser ? 'user' : 'assistant'}`}>
        <div
          className="spectre-meta"
          style={{ textAlign: isUser ? 'right' : 'left' }}
        >
          {isUser ? 'You' : 'Spectre'}
        </div>
        {message.role === 'assistant' ? (
          <div style={{ position: 'relative' }}>
            {renderAssistantMessage(message.text, busy && isLastMessage)}
          </div>
        ) : (
          <div className="spectre-user-text">{message.text}</div>
        )}
        {/* Show loading indicator for last assistant message when busy */}
        {message.role === 'assistant' && busy && isLastMessage && (
          <div
            style={{
              marginTop: '8px',
              opacity: 0.7,
              fontSize: '12px',
            }}
          >
            ⏳ Processing...
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Renders error message with optional retry button.
 */
export function renderErrorMessage(props: ErrorMessageProps): React.ReactNode {
  const { error, retryable, onRetry } = props;

  if (!error) return null;

  return (
    <div className="spectre-error-message">
      <div>{error}</div>
      {retryable && (
        <button
          className="spectre-retry-button"
          onClick={onRetry}
          aria-label="Retry failed request"
          style={{
            marginTop: '8px',
            padding: '4px 8px',
            border: '1px solid var(--theia-button-border)',
            background: 'var(--theia-button-background)',
            color: 'var(--theia-button-foreground)',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '12px',
          }}
        >
          🔄 Retry
        </button>
      )}
    </div>
  );
}

/**
 * Renders character limit warning when approaching or exceeding limit.
 */
export function renderCharacterLimitWarning(
  props: CharLimitWarningProps
): React.ReactNode {
  const { inputLength, charLimit, busy } = props;

  if (inputLength <= charLimit * 0.9 || busy) return null;

  return (
    <div
      className={`spectre-warning ${
        inputLength > charLimit ? 'error' : 'warning'
      }`}
      role="alert"
      aria-live="assertive"
    >
      {inputLength > charLimit ? (
        <>
          ⚠️ Message exceeds limit by{' '}
          {(inputLength - charLimit).toLocaleString()} characters. Please
          shorten to send.
        </>
      ) : (
        <>
          ⚠️ Approaching character limit ({inputLength.toLocaleString()}/
          {charLimit.toLocaleString()})
        </>
      )}
    </div>
  );
}

/**
 * Gets CSS class for character count status chip.
 */
function getCharCountStatusClass(
  inputLength: number,
  charLimit: number
): string {
  if (inputLength > charLimit) {
    return 'error';
  }
  if (inputLength > charLimit * 0.9) {
    return 'warning';
  }
  return '';
}

/**
 * Aggregates send-button state into a single helper to avoid primitive-obsession
 * and reduce the number of small parameterized helper functions.
 */
interface SendButtonState {
  busy: boolean;
  input: string;
  charLimit: number;
}

/* Helper functions to simplify decision logic and reduce cyclomatic complexity */
interface SendButtonInternalState {
  busy: boolean;
  input: string;
  inputLength: number;
  charLimit: number;
  tooLong: boolean;
}

function getSendButtonClassName(state: Pick<SendButtonInternalState, 'busy' | 'tooLong'>): string {
  const { busy, tooLong } = state;
  if (busy) return 'spectre-inline-send spectre-stop';
  if (tooLong) return 'spectre-inline-send spectre-send spectre-disabled';
  return 'spectre-inline-send spectre-send';
}

function getSendButtonAriaLabel(
  state: Pick<SendButtonInternalState, 'inputLength' | 'charLimit' | 'busy' | 'tooLong'>
): string {
  const { inputLength, charLimit, busy, tooLong } = state;
  if (tooLong) {
    return `Message too long (${inputLength}/${charLimit})`;
  }
  if (busy) {
    return 'Stop response';
  }
  return 'Send message';
}

function getSendButtonTitle(
  state: Pick<SendButtonInternalState, 'inputLength' | 'charLimit' | 'busy' | 'tooLong'>
): string {
  const { inputLength, charLimit, busy, tooLong } = state;
  if (tooLong) {
    return `Message exceeds ${charLimit.toLocaleString()} character limit by ${(inputLength - charLimit).toLocaleString()} characters. Please shorten your message.`;
  }
  if (busy) {
    return 'Stop response';
  }
  return 'Send message';
}

function getSendButtonContent(state: Pick<SendButtonInternalState, 'busy' | 'tooLong'>): string {
  const { busy, tooLong } = state;
  if (busy) return '■';
  if (tooLong) return '⚠';
  return '➤';
}

function isSendButtonDisabled(state: Pick<SendButtonInternalState, 'busy' | 'input' | 'tooLong'>): boolean {
  const { busy, input, tooLong } = state;
  return !busy && (!input.trim() || tooLong);
}

function getSendButtonState(state: SendButtonState) {
  const { busy, input, charLimit } = state;
  const inputLength = input.length;
  const tooLong = inputLength > charLimit;

  const internalState: SendButtonInternalState = {
    busy,
    input,
    inputLength,
    charLimit,
    tooLong,
  };

  const className = getSendButtonClassName(internalState);
  const ariaLabel = getSendButtonAriaLabel(internalState);
  const title = getSendButtonTitle(internalState);
  const content = getSendButtonContent(internalState);
  const disabled = isSendButtonDisabled(internalState);

  return { className, ariaLabel, title, content, disabled };
}

/**
 * Renders the input area with textarea, status bar, and send button.
 */
export function renderInputArea(props: InputAreaProps): React.ReactNode {
  const {
    input,
    busy,
    mode,
    model,
    charLimit,
    onInputChange,
    onKeyDown,
    onSendClick,
    onCancelClick,
    inputRef,
    inlineQuota,
    memoryStats,
  } = props;

  const handleButtonClick = () => {
    if (busy) {
      onCancelClick();
    } else {
      onSendClick();
    }
  };

  const inputLength = input.length;
  const sendState = getSendButtonState({ busy, input, charLimit });

  return (
    <div className="spectre-input">
      <div className="input-wrap">
        <textarea
          rows={3}
          defaultValue={input}
          placeholder={busy ? 'Thinking…' : 'Type a message…'}
          onChange={onInputChange}
          onKeyDown={onKeyDown}
          disabled={busy}
          ref={inputRef}
          aria-label="Message input"
          aria-describedby="char-count-status"
        />
        <div className="spectre-input-bar">
          <div className="spectre-status-left">
            <span className="spectre-chip compact">
              {mode === 'agent' ? 'Agent' : 'Basic'}
            </span>
            <span className="spectre-chip compact">{model}</span>
            <span
              id="char-count-status"
              className={`spectre-chip compact ${getCharCountStatusClass(
                inputLength,
                charLimit
              )}`}
              role="status"
              aria-live="polite"
              title={`Character count: ${inputLength.toLocaleString()} / ${charLimit.toLocaleString()}`}
            >
              {inputLength.toLocaleString()}/{charLimit.toLocaleString()}
            </span>
            {inlineQuota}
          </div>
          <button
            className={sendState.className}
            onClick={handleButtonClick}
            disabled={sendState.disabled}
            aria-label={sendState.ariaLabel}
            aria-pressed={busy}
            title={sendState.title}
          >
            {sendState.content}
          </button>
        </div>
        {memoryStats}
      </div>
    </div>
  );
}

export function renderInlineQuota(props: InlineQuotaProps): React.ReactNode {
  const {
    quotaUsed,
    quotaCapacity,
    rpmUsed,
    rpmLimit,
    queueSize,
    nextAvailableMs,
    now,
    clientRpm,
    dailyStats,
    model,
  } = props;

  const pct = Math.min(100, Math.max(0, (quotaUsed / quotaCapacity) * 100));
  const remain = Math.max(0, nextAvailableMs - now);

  const rpmDisplay =
    queueSize > 0
      ? `Q:${queueSize} ${(remain / 1000).toFixed(1)}s`
      : `${rpmUsed}/${rpmLimit} RPM`;

  const title =
    `Model: ${model}\n` +
    `TPM Usage: ${quotaUsed.toLocaleString()}/${quotaCapacity.toLocaleString()} tokens (${pct.toFixed(
      1
    )}%)\n` +
    `RPM: ${rpmUsed}/${rpmLimit}\n` +
    `Client RPM (60s): ${clientRpm}/${rpmLimit}\n` +
    `Daily (Pacific): ${
      dailyStats.requests
    } requests, ${dailyStats.tokens.toLocaleString()} tokens`;

  return (
    <div className="spectre-inline-quota" title={title}>
      <QuotaRing percent={pct} used={quotaUsed} cap={quotaCapacity} />
      <span className="spectre-inline-quota-text">{rpmDisplay}</span>
    </div>
  );
}

function shouldHideMemoryStats(
  memoryStats: MemoryStatsFooterProps['memoryStats']
): boolean {
  return (
    !memoryStats ||
    (memoryStats.recentMessages === 0 && memoryStats.summaries === 0)
  );
}

export function renderMemoryStatsFooter(
  props: MemoryStatsFooterProps
): React.ReactNode {
  const { memoryStats } = props;

  if (shouldHideMemoryStats(memoryStats)) {
    return null;
  }

  const { recentMessages, summaries, totalTokens, isSummarizing } =
    memoryStats!;
  const memoryBankCap = 50000;
  const percent = Math.min(
    100,
    Math.max(0, (totalTokens / memoryBankCap) * 100)
  );

  let statusClass = 'memory-ok';
  if (percent >= 90) {
    statusClass = 'memory-high';
  } else if (percent >= 70) {
    statusClass = 'memory-medium';
  }

  const statusText =
    summaries > 0
      ? `${recentMessages} msgs + ${summaries} summaries`
      : `${recentMessages} messages`;

  const tokenText = `${TokenCounter.formatCount(
    totalTokens
  )}/${TokenCounter.formatCount(memoryBankCap)}`;

  return (
    <div
      className={`spectre-memory-footer ${statusClass}`}
      title={
        `Conversation Memory:\n` +
        `Recent Messages: ${recentMessages}\n` +
        `Summaries: ${summaries}\n` +
        `Total Tokens: ${totalTokens.toLocaleString()}/${memoryBankCap.toLocaleString()} (${percent.toFixed(
          1
        )}%)\n\n` +
        `The AI maintains context by keeping recent messages and compressing older ones into summaries. ` +
        `This allows long conversations without hitting token limits.`
      }
    >
      <span className="memory-icon">💾</span>
      <span className="memory-text">
        {statusText} • {tokenText}
      </span>
      {isSummarizing && (
        <span
          className="memory-status"
          title="Compressing conversation history..."
        >
          ⏳ Summarizing...
        </span>
      )}
    </div>
  );
}

interface QuotaRingProps {
  percent: number;
  used: number;
  cap: number;
}

// eslint-disable-next-line react/prop-types
const QuotaRing: React.FC<QuotaRingProps> = ({ percent, used, cap }) => {
  const r = 12;
  const c = 2 * Math.PI * r;

  const minPercent = percent > 0 && percent < 2 ? 2 : percent;
  const dash = (minPercent / 100) * c;

  let progressColor = 'var(--theia-charts-green, #89D185)';
  if (percent >= 90) {
    progressColor = 'var(--theia-errorForeground, #f48771)';
  } else if (percent >= 70) {
    progressColor = 'var(--theia-charts-orange, #d18616)';
  }

  return (
    <svg width={30} height={30} viewBox="0 0 30 30" style={{ marginRight: 6 }}>
      <circle
        cx={15}
        cy={15}
        r={r}
        stroke="var(--theia-input-border, rgba(128, 128, 128, 0.5))"
        strokeWidth={3}
        fill="none"
        opacity={0.3}
      />
      <circle
        cx={15}
        cy={15}
        r={r}
        stroke={progressColor}
        strokeWidth={3}
        fill="none"
        strokeDasharray={`${dash.toFixed(2)} ${c.toFixed(2)}`}
        strokeLinecap="round"
        transform="rotate(-90 15 15)"
        opacity={percent > 0 ? 1 : 0}
      />
      <text
        x="15"
        y="19"
        fontSize="9"
        fontWeight="600"
        textAnchor="middle"
        fill="var(--theia-foreground)"
        style={{ userSelect: 'none' }}
      >
        {Math.round(percent)}
      </text>
      <title>{`TPM: ${used.toLocaleString()} / ${cap.toLocaleString()} tokens (${Math.round(
        percent
      )}%)`}</title>
    </svg>
  );
};
