/**
 * React rendering helpers for SpectreWidget.
 * Extracted to reduce main widget file complexity.
 * 
 * @author Tazul Islam
 */
import * as React from '@theia/core/shared/react';
import { AgentTask } from '../agent/task-helpers';
import type { ConversationMemory } from '../memory/memory-types';

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
  renderAssistantMessage: (text: string, isStreaming: boolean) => React.ReactNode;
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
function renderTask(task: AgentTask): React.ReactNode {
  let statusIcon = '';
  let statusClass = '';

  switch (task.status) {
    case 'pending':
      statusIcon = '○';
      statusClass = 'task-pending';
      break;
    case 'in-progress':
      statusIcon = '⏳';
      statusClass = 'task-in-progress';
      break;
    case 'completed':
      statusIcon = '✓';
      statusClass = 'task-completed';
      break;
    case 'failed':
      statusIcon = '✗';
      statusClass = 'task-failed';
      break;
  }

  return (
    <div key={task.id} className={`spectre-task ${statusClass}`}>
      <span className="spectre-task-icon">{statusIcon}</span>
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
          <strong>Agent Mode:</strong> I can autonomously create/edit
          sketches, verify code, upload to boards, install/manage boards
          & libraries, and configure board settings.
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
      <div
        className={`spectre-bubble ${isUser ? 'user' : 'assistant'}`}
      >
        <div
          className="spectre-meta"
          style={{ textAlign: isUser ? 'right' : 'left' }}
        >
          {isUser ? 'You' : 'Spectre'}
        </div>
        {message.role === 'assistant' ? (
          <div style={{ position: 'relative' }}>
            {renderAssistantMessage(
              message.text,
              busy && isLastMessage
            )}
          </div>
        ) : (
          <div className="spectre-user-text">{message.text}</div>
        )}
        {/* Show loading indicator for last assistant message when busy */}
        {message.role === 'assistant' &&
          busy &&
          isLastMessage && (
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
export function renderCharacterLimitWarning(props: CharLimitWarningProps): React.ReactNode {
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
function getCharCountStatusClass(inputLength: number, charLimit: number): string {
  if (inputLength > charLimit) {
    return 'error';
  }
  if (inputLength > charLimit * 0.9) {
    return 'warning';
  }
  return '';
}

/**
 * Gets CSS class for send button based on state.
 */
function getSendButtonClass(busy: boolean, inputLength: number, charLimit: number): string {
  if (busy) {
    return 'spectre-inline-send spectre-stop';
  }
  if (inputLength > charLimit) {
    return 'spectre-inline-send spectre-send spectre-disabled';
  }
  return 'spectre-inline-send spectre-send';
}

/**
 * Gets aria-label for send button based on state.
 */
function getSendButtonAriaLabel(busy: boolean, inputLength: number, charLimit: number): string {
  if (inputLength > charLimit) {
    return `Message too long (${inputLength}/${charLimit})`;
  }
  return busy ? 'Stop response' : 'Send message';
}

/**
 * Gets title tooltip for send button based on state.
 */
function getSendButtonTitle(busy: boolean, inputLength: number, charLimit: number): string {
  if (inputLength > charLimit) {
    return `Message exceeds ${charLimit.toLocaleString()} character limit by ${(
      inputLength - charLimit
    ).toLocaleString()} characters. Please shorten your message.`;
  }
  return busy ? 'Stop response' : 'Send message';
}

/**
 * Gets icon/text for send button based on state.
 */
function getSendButtonContent(busy: boolean, inputLength: number, charLimit: number): string {
  if (busy) return '■';
  if (inputLength > charLimit) return '⚠';
  return '➤';
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
            <span className="spectre-chip compact">
              {model}
            </span>
            <span
              id="char-count-status"
              className={`spectre-chip compact ${getCharCountStatusClass(input.length, charLimit)}`}
              role="status"
              aria-live="polite"
              title={`Character count: ${input.length.toLocaleString()} / ${charLimit.toLocaleString()}`}
            >
              {input.length.toLocaleString()}/{charLimit.toLocaleString()}
            </span>
            {inlineQuota}
          </div>
          <button
            className={getSendButtonClass(busy, input.length, charLimit)}
            onClick={handleButtonClick}
            disabled={!busy && (!input.trim() || input.length > charLimit)}
            aria-label={getSendButtonAriaLabel(busy, input.length, charLimit)}
            aria-pressed={busy}
            title={getSendButtonTitle(busy, input.length, charLimit)}
          >
            {getSendButtonContent(busy, input.length, charLimit)}
          </button>
        </div>
        {memoryStats}
      </div>
    </div>
  );
}
