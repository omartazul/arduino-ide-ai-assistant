/**
 * View contribution for Spectre AI assistant.
 * Registers commands, toolbar items, and ensures widget appears in sidebar on startup.
 *
 * @author Tazul Islam
 */

import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution, codicon } from '@theia/core/lib/browser';
import { Command, CommandRegistry } from '@theia/core';
import {
  TabBarToolbarContribution,
  TabBarToolbarRegistry,
} from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { SpectreWidget } from './spectre-widget';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';

/**
 * Namespace containing all Spectre AI assistant command definitions.
 * These commands control the Spectre widget visibility and chat management.
 */
export namespace SpectreCommands {
  export const TOGGLE: Command = { id: 'spectre.toggle', label: 'Spectre' };
  export const NEW_CHAT: Command = {
    id: 'spectre.newChat',
    label: 'New Chat',
    iconClass: codicon('add'),
  };
  export const CLEAR_CHAT: Command = {
    id: 'spectre.clearChat',
    label: 'Clear Chat',
    iconClass: codicon('clear-all'),
  };
  export const CLOSE_CHAT: Command = {
    id: 'spectre.closeChat',
    label: 'Close Chat',
    iconClass: codicon('close'),
  };
}

/**
 * View contribution for the Spectre AI assistant widget.
 * Manages widget registration, toolbar items, commands, and ensures the Spectre icon
 * appears in the left sidebar on IDE startup.
 */
@injectable()
export class SpectreViewContribution
  extends AbstractViewContribution<SpectreWidget>
  implements TabBarToolbarContribution, FrontendApplicationContribution
{
  constructor() {
    super({
      widgetId: SpectreWidget.ID,
      widgetName: SpectreWidget.LABEL,
      defaultWidgetOptions: { area: 'left' },
      toggleCommandId: SpectreCommands.TOGGLE.id,
    });
  }

  /**
   * Registers toolbar items for the Spectre widget.
   * Adds New Chat, Clear Chat, and Close Chat buttons to the widget's toolbar.
   */
  registerToolbarItems(registry: TabBarToolbarRegistry): void {
    registry.registerItem({
      id: SpectreCommands.NEW_CHAT.id,
      command: SpectreCommands.NEW_CHAT.id,
    });
    registry.registerItem({
      id: SpectreCommands.CLEAR_CHAT.id,
      command: SpectreCommands.CLEAR_CHAT.id,
    });
    registry.registerItem({
      id: SpectreCommands.CLOSE_CHAT.id,
      command: SpectreCommands.CLOSE_CHAT.id,
    });
  }

  /**
   * Registers all Spectre commands.
   * Includes the toggle command from the parent class and chat management commands
   * (new, clear, close) that operate on the SpectreWidget instance.
   */
  override registerCommands(commands: CommandRegistry): void {
    // Register the toggle command defined by AbstractViewContribution
    super.registerCommands(commands);
    commands.registerCommand(SpectreCommands.NEW_CHAT, {
      isEnabled: (widget) => widget instanceof SpectreWidget,
      isVisible: (widget) => widget instanceof SpectreWidget,
      execute: (widget) => {
        if (widget instanceof SpectreWidget) {
          widget.newChat();
        }
      },
    });
    commands.registerCommand(SpectreCommands.CLEAR_CHAT, {
      isEnabled: (widget) => widget instanceof SpectreWidget,
      isVisible: (widget) => widget instanceof SpectreWidget,
      execute: (widget) => {
        if (widget instanceof SpectreWidget) {
          widget.clearChat();
        }
      },
    });
    commands.registerCommand(SpectreCommands.CLOSE_CHAT, {
      isEnabled: (widget) => widget instanceof SpectreWidget,
      isVisible: (widget) => widget instanceof SpectreWidget,
      execute: (widget) => {
        if (widget instanceof SpectreWidget) {
          widget.closeChat();
        }
      },
    });
  }

  /**
   * Called when the frontend application starts.
   * Ensures the Spectre view is created so the icon appears in the left panel.
   * Uses deferred execution to avoid blocking IDE startup.
   */
  async onStart(): Promise<void> {
    // Defer, and swallow any error to avoid blocking startup
    Promise.resolve().then(() =>
      this.openView({ activate: false, reveal: true }).catch(() => undefined)
    );
  }
}
