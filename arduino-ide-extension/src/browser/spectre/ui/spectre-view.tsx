/**
 * Presentational view for the Spectre chat widget.
 *
 * @author Tazul Islam
 */

import React from '@theia/core/shared/react';

import * as WidgetRenderHelpers from './widget-rendering';
import type { ChatMessage, ChatSession } from './widget-rendering';
import type { AgentTask } from '../agent/agent-utils';
import type { MemoryStats } from '../chat/chat-session-manager';

export interface SpectreViewProps {
  mode: 'agent' | 'basic';
  model: string;
  busy: boolean;

  sessions: ChatSession[];
  active: number;

  input: string;
  charLimit: number;

  error?: string;
  retryable: boolean;

  tasks: AgentTask[];
  tasksExpanded: boolean;
  tasksClosed: boolean;

  quotaUsed: number;
  quotaCapacity: number;
  rpmUsed: number;
  rpmLimit: number;
  queueSize: number;
  nextAvailableMs: number;
  now: number;

  clientRpm: number;
  dailyStats: { requests: number; tokens: number };

  memoryStats?: MemoryStats;

  onSetActive: (index: number) => void;
  onToggleTasksExpand: () => void;
  onCloseTasks: () => void;

  onRetry: () => void;
  onSendClick: () => void;
  onCancelClick: () => void;

  onInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  inputRef: (el: HTMLTextAreaElement | null) => void;

  renderAssistantMessage: (
    text: string,
    isStreaming: boolean
  ) => React.ReactNode;
}

export function SpectreView(props: SpectreViewProps): React.ReactNode {
  const {
    mode,
    model,
    busy,
    sessions,
    active,
    input,
    charLimit,
    error,
    retryable,
    tasks,
    tasksExpanded,
    tasksClosed,
    quotaUsed,
    quotaCapacity,
    rpmUsed,
    rpmLimit,
    queueSize,
    nextAvailableMs,
    now,
    clientRpm,
    dailyStats,
    memoryStats,
    onSetActive,
    onToggleTasksExpand,
    onCloseTasks,
    onRetry,
    onSendClick,
    onCancelClick,
    onInputChange,
    onKeyDown,
    inputRef,
    renderAssistantMessage,
  } = props;

  const session = sessions[active];

  const taskList = WidgetRenderHelpers.renderTaskList({
    tasks,
    tasksExpanded,
    tasksClosed,
    onToggleExpand: onToggleTasksExpand,
    onClose: onCloseTasks,
  });

  const sessionTabs = WidgetRenderHelpers.renderSessionTabs({
    sessions,
    active,
    onSetActive,
  });

  const emptyState = WidgetRenderHelpers.renderEmptyState({
    isAgentMode: mode === 'agent',
  });

  const errorMessage = WidgetRenderHelpers.renderErrorMessage({
    error,
    retryable,
    onRetry,
  });

  const characterLimitWarning = WidgetRenderHelpers.renderCharacterLimitWarning(
    {
      inputLength: input.length,
      charLimit,
      busy,
    }
  );

  const inputArea = WidgetRenderHelpers.renderInputArea({
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
    inlineQuota: WidgetRenderHelpers.renderInlineQuota({
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
    }),
    memoryStats: WidgetRenderHelpers.renderMemoryStatsFooter({
      memoryStats,
    }),
  });

  return (
    <div className="content noselect arduino-spectre-widget" tabIndex={-1}>
      {sessionTabs}
      <div
        className="spectre-messages"
        data-spectre-scroll
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
      >
        {taskList}
        {session.messages.length === 0 && emptyState}
        {session.messages.map((m: ChatMessage, idx: number) =>
          WidgetRenderHelpers.renderMessage({
            message: m,
            idx,
            sessionLength: session.messages.length,
            busy,
            renderAssistantMessage,
          })
        )}
        <div data-spectre-anchor />
      </div>
      {errorMessage}
      {characterLimitWarning}
      {inputArea}
    </div>
  );
}
