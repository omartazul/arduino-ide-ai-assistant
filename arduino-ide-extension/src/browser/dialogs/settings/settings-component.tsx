import React from '@theia/core/shared/react';
import { Tab, Tabs, TabList, TabPanel } from 'react-tabs';
import 'react-tabs/style/react-tabs.css';
import { Disable } from 'react-disable';
import { deepClone } from '@theia/core/lib/common/objects';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog/file-dialog-service';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import {
  AdditionalUrls,
  CompilerWarnings,
  CompilerWarningLiterals,
  Network,
  ProxySettings,
} from '../../../common/protocol';
import { nls } from '@theia/core/lib/common';
import { Settings, SettingsService } from './settings';
import { AdditionalUrlsDialog } from './settings-dialog';
import {
  AsyncLocalizationProvider,
  LanguageInfo,
} from '@theia/core/lib/common/i18n/localization';
import SettingsStepInput from './settings-step-input';
import { InterfaceScale } from '../../contributions/interface-scale';
import {
  userConfigurableThemes,
  themeLabelForSettings,
  arduinoThemeTypeOf,
} from '../../theia/core/theming';
import { Theme } from '@theia/core/lib/common/theme';
import { SpectreSecretsService } from '../../../common/protocol/spectre-secrets-service';
import { SpectreSecretsFrontendClient } from '../../spectre/spectre-secrets-frontend-client';

const maxScale = InterfaceScale.ZoomLevel.toPercentage(
  InterfaceScale.ZoomLevel.MAX
);
const minScale = InterfaceScale.ZoomLevel.toPercentage(
  InterfaceScale.ZoomLevel.MIN
);
const scaleStep = InterfaceScale.ZoomLevel.Step.toPercentage(
  InterfaceScale.ZoomLevel.STEP
);

const maxFontSize = InterfaceScale.FontSize.MAX;
const minFontSize = InterfaceScale.FontSize.MIN;
const fontSizeStep = InterfaceScale.FontSize.STEP;

export class SettingsComponent extends React.Component<
  SettingsComponent.Props,
  SettingsComponent.State
> {
  readonly toDispose = new DisposableCollection();

  constructor(props: SettingsComponent.Props) {
    super(props);
  }

  override componentDidUpdate(
    _: SettingsComponent.Props,
    prevState: SettingsComponent.State
  ): void {
    if (
      this.state &&
      prevState &&
      JSON.stringify(SettingsComponent.State.toSettings(this.state)) !==
        JSON.stringify(SettingsComponent.State.toSettings(prevState))
    ) {
      this.props.settingsService.update(
        SettingsComponent.State.toSettings(this.state),
        true
      );
    }
  }

  override componentDidMount(): void {
    // Initialize the component by loading settings and Spectre API key status.
    // This uses promise chaining to ensure initial state is set before loading
    // the API key status from the backend.
    this.props.settingsService
      .settings()
      .then((settings) => {
        const initialState = SettingsComponent.State.fromSettings(settings);
        this.setState(initialState);

        // Load Spectre API key status after initial state is set
        return this.props.secretsService.getStatus();
      })
      .then(({ hasApiKey }: { hasApiKey: boolean }) =>
        this.setState({ spectreHasApiKey: hasApiKey })
      )
      .catch(() => this.setState({ spectreHasApiKey: false }));
    this.toDispose.pushAll([
      this.props.settingsService.onDidChange((settings) =>
        this.setState((prevState) => ({
          ...SettingsComponent.State.merge(prevState, settings),
        }))
      ),
      this.props.settingsService.onDidReset((settings) => {
        const newState = SettingsComponent.State.fromSettings(settings);
        this.setState(newState);
        // Refresh Spectre status when dialog is reset/reopened
        this.props.secretsService
          .getStatus()
          .then(({ hasApiKey }: { hasApiKey: boolean }) =>
            this.setState({ spectreHasApiKey: hasApiKey })
          )
          .catch(() => this.setState({ spectreHasApiKey: false }));
      }),
      // Subscribe to API key status change events from backend
      this.props.secretsFrontendClient.onStatusChangeEvent((status) => {
        this.setState({ spectreHasApiKey: status.hasApiKey });
      }),
    ]);
  }

  override componentWillUnmount(): void {
    this.toDispose.dispose();
  }

  override render(): React.ReactNode {
    if (!this.state) {
      return <div />;
    }
    return (
      <Tabs onSelect={this.onTabSelect}>
        <TabList>
          <Tab>{nls.localize('vscode/settingsTree/settings', 'Settings')}</Tab>
          <Tab>{nls.localize('arduino/preferences/network', 'Network')}</Tab>
          <Tab>{nls.localize('arduino/preferences/spectre', 'Spectre')}</Tab>
        </TabList>
        <TabPanel>{this.renderSettings()}</TabPanel>
        <TabPanel>{this.renderNetwork()}</TabPanel>
        <TabPanel>{this.renderSpectre()}</TabPanel>
      </Tabs>
    );
  }

  /**
   * Called when a tab is selected. Refreshes Spectre API key status
   * when the Spectre tab (index 2) is selected to ensure UI displays
   * the most current backend state.
   */
  protected onTabSelect = (index: number): void => {
    // Spectre tab index is 2 (0=Settings, 1=Network, 2=Spectre)
    if (index === 2) {
      this.refreshSpectreStatus();
    }
  };

  protected renderSettings(): React.ReactNode {
    const scalePercentage = 100 + this.state.interfaceScale * 20;

    return (
      <div className="content noselect">
        {nls.localize(
          'arduino/preferences/sketchbook.location',
          'Sketchbook location'
        ) + ':'}
        <div className="flex-line">
          <input
            className="theia-input stretch"
            type="text"
            value={this.state.sketchbookPath}
            onChange={this.sketchpathDidChange}
          />
          <button
            className="theia-button shrink"
            onClick={this.browseSketchbookDidClick}
          >
            {nls.localize('arduino/preferences/browse', 'Browse')}
          </button>
        </div>
        <label className="flex-line">
          <input
            type="checkbox"
            checked={this.state.sketchbookShowAllFiles === true}
            onChange={this.sketchbookShowAllFilesDidChange}
          />
          {nls.localize(
            'arduino/preferences/files.inside.sketches',
            'Show files inside Sketches'
          )}
        </label>
        <div className="column-container">
          <div className="column">
            <div className="flex-line">
              {nls.localize(
                'arduino/preferences/editorFontSize',
                'Editor font size'
              ) + ':'}
            </div>
            <div className="flex-line">
              {nls.localize(
                'arduino/preferences/interfaceScale',
                'Interface scale'
              ) + ':'}
            </div>
            <div className="flex-line">
              {nls.localize(
                'vscode/themes.contribution/selectTheme.label',
                'Theme'
              ) + ':'}
            </div>
            <div className="flex-line">
              {nls.localize(
                'vscode/editorStatus/status.editor.mode',
                'Language'
              ) + ':'}
            </div>
            <div className="flex-line">
              {nls.localize(
                'arduino/preferences/showVerbose',
                'Show verbose output during'
              )}
            </div>
            <div className="flex-line">
              {nls.localize(
                'arduino/preferences/compilerWarnings',
                'Compiler warnings'
              )}
            </div>
          </div>
          <div className="column">
            <div className="flex-line">
              <SettingsStepInput
                key={`font-size-stepper-${String(this.state.editorFontSize)}`}
                initialValue={this.state.editorFontSize}
                setSettingsStateValue={this.setFontSize}
                step={fontSizeStep}
                maxValue={maxFontSize}
                minValue={minFontSize}
                classNames={{ input: 'theia-input small' }}
              />
            </div>
            <div className="flex-line">
              <label className="flex-line">
                <input
                  type="checkbox"
                  checked={this.state.autoScaleInterface}
                  onChange={this.autoScaleInterfaceDidChange}
                />
                {nls.localize('arduino/preferences/automatic', 'Automatic')}
              </label>
              <div>
                <SettingsStepInput
                  key={`scale-stepper-${String(scalePercentage)}`}
                  initialValue={scalePercentage}
                  setSettingsStateValue={this.setInterfaceScale}
                  step={scaleStep}
                  maxValue={maxScale}
                  minValue={minScale}
                  unitOfMeasure="%"
                  classNames={{
                    input: 'theia-input small with-margin',
                    buttonsContainer:
                      'settings-step-input-buttons-container-perc',
                  }}
                />
              </div>
            </div>
            <div className="flex-line">
              <select
                className="theia-select"
                value={this.currentThemeLabel}
                onChange={this.themeDidChange}
              >
                {this.themeSelectOptions}
              </select>
            </div>
            <div className="flex-line">
              <select
                className="theia-select"
                value={this.state.currentLanguage}
                onChange={this.languageDidChange}
              >
                {this.state.languages.map((label) =>
                  this.toSelectOptions(label)
                )}
              </select>
              <span style={{ marginLeft: '5px' }}>
                (
                {nls.localize(
                  'vscode/extensionsActions/reloadRequired',
                  'Reload required'
                )}
                )
              </span>
            </div>
            <div className="flex-line">
              <label className="flex-line">
                <input
                  type="checkbox"
                  checked={this.state.verboseOnCompile}
                  onChange={this.verboseOnCompileDidChange}
                />
                {nls.localize('arduino/preferences/compile', 'compile')}
              </label>
              <label className="flex-line">
                <input
                  type="checkbox"
                  checked={this.state.verboseOnUpload}
                  onChange={this.verboseOnUploadDidChange}
                />
                {nls.localize('arduino/preferences/upload', 'upload')}
              </label>
            </div>
            <div className="flex-line">
              <select
                className="theia-select"
                value={this.state.compilerWarnings}
                onChange={this.compilerWarningsDidChange}
              >
                {CompilerWarningLiterals.map((value) => (
                  <option key={value} value={value}>
                    {CompilerWarnings.labelOf(value)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
        <label className="flex-line">
          <input
            type="checkbox"
            checked={this.state.verifyAfterUpload}
            onChange={this.verifyAfterUploadDidChange}
          />
          {nls.localize(
            'arduino/preferences/verifyAfterUpload',
            'Verify code after upload'
          )}
        </label>
        <label className="flex-line">
          <input
            type="checkbox"
            checked={this.state.autoSave !== 'off'}
            onChange={this.autoSaveDidChange}
          />
          {nls.localize(
            'vscode/fileActions.contribution/miAutoSave',
            'Auto save'
          )}
        </label>
        <label className="flex-line">
          <input
            type="checkbox"
            checked={this.state.quickSuggestions.other === true}
            onChange={this.quickSuggestionsOtherDidChange}
          />
          {nls.localize(
            'arduino/preferences/editorQuickSuggestions',
            'Editor Quick Suggestions'
          )}
        </label>
        <div className="flex-line">
          {nls.localize(
            'arduino/preferences/additionalManagerURLs',
            'Additional boards manager URLs'
          ) + ':'}
          <input
            className="theia-input stretch with-margin"
            type="text"
            value={this.state.rawAdditionalUrlsValue}
            onChange={this.rawAdditionalUrlsValueDidChange}
          />
          <i
            className="fa fa-window-restore theia-button shrink"
            onClick={this.editAdditionalUrlDidClick}
          />
        </div>
      </div>
    );
  }

  private get currentThemeLabel(): string {
    const currentTheme = this.props.themeService.getCurrentTheme();
    return themeLabelForSettings(currentTheme);
  }

  private get separatedThemes(): (Theme | string)[] {
    const separatedThemes: (Theme | string)[] = [];
    const groupedThemes = userConfigurableThemes(this.props.themeService);
    for (const group of groupedThemes) {
      for (let i = 0; i < group.length; i++) {
        const theme = group[i];
        if (i === 0 && separatedThemes.length) {
          const arduinoThemeType = arduinoThemeTypeOf(theme);
          separatedThemes.push(`separator-${arduinoThemeType}`);
        }
        separatedThemes.push(theme);
      }
    }
    return separatedThemes;
  }

  private get themeSelectOptions(): React.ReactNode[] {
    return this.separatedThemes.map((item) => {
      if (typeof item === 'string') {
        return (
          // &#9472; -> BOX DRAWINGS LIGHT HORIZONTAL
          <option key={item} disabled>
            &#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;
          </option>
        );
      }
      const label = themeLabelForSettings(item);
      return (
        <option key={item.id} value={label}>
          {label}
        </option>
      );
    });
  }

  private toSelectOptions(language: string | LanguageInfo): JSX.Element {
    const plain = typeof language === 'string';
    const key = plain ? language : language.languageId;
    const value = plain ? language : language.languageId;
    const label = plain
      ? language === 'en'
        ? 'English'
        : language
      : language.localizedLanguageName ||
        language.languageName ||
        language.languageId;
    return (
      <option key={key} value={value}>
        {label}
      </option>
    );
  }

  protected renderNetwork(): React.ReactNode {
    return (
      <div className="content noselect">
        <form>
          <label className="flex-line">
            <input
              type="radio"
              checked={this.state.network === 'none'}
              onChange={this.noProxyDidChange}
            />
            {nls.localize('arduino/preferences/noProxy', 'No proxy')}
          </label>
          <label className="flex-line">
            <input
              type="radio"
              checked={this.state.network !== 'none'}
              onChange={this.manualProxyDidChange}
            />
            {nls.localize(
              'arduino/preferences/manualProxy',
              'Manual proxy configuration'
            )}
          </label>
        </form>
        {this.renderProxySettings()}
      </div>
    );
  }

  /**
   * Renders the Spectre tab panel containing API key management controls,
   * model selection, and mode configuration for the Spectre AI assistant.
   */
  protected renderSpectre(): React.ReactNode {
    return (
      <div className="content noselect">
        <div className="column-container">
          <div className="column">
            <div className="flex-line">
              {nls.localize('arduino/spectre/apiKey', 'Gemini API key') + ':'}
            </div>
            <div className="flex-line">
              {nls.localize('arduino/spectre/model', 'Model') + ':'}
            </div>
            <div className="flex-line">
              {nls.localize('arduino/spectre/mode', 'Mode') + ':'}
            </div>
          </div>
          <div className="column">
            <div className="flex-line">
              <input
                className="theia-input stretch"
                type="password"
                placeholder={
                  this.state.spectreHasApiKey
                    ? nls.localize('arduino/spectre/keyStored', 'Key stored')
                    : nls.localize('arduino/spectre/keyNotSet', 'Not set')
                }
                value={this.state.spectreApiKeyInput}
                onChange={(e) =>
                  this.setState({ spectreApiKeyInput: e.target.value })
                }
              />
              <button
                className="theia-button shrink"
                disabled={
                  this.state.spectreBusy ||
                  this.state.spectreApiKeyInput.trim() === ''
                }
                onClick={this.saveApiKeyDidClick}
              >
                {nls.localize('arduino/spectre/saveKey', 'Save key')}
              </button>
              <button
                className="theia-button shrink"
                disabled={
                  this.state.spectreBusy || !this.state.spectreHasApiKey
                }
                onClick={this.clearApiKeyDidClick}
              >
                {nls.localize('arduino/spectre/clearKey', 'Clear key')}
              </button>
            </div>
            <div className="flex-line">
              <select
                className="theia-select"
                value={this.state.spectreModel}
                onChange={(e) =>
                  this.setState({
                    spectreModel: e.target.value as Settings['spectreModel'],
                  })
                }
              >
                <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                <option value="gemini-2.5-flash-lite">
                  Gemini 2.5 Flash Lite
                </option>
              </select>
            </div>
            <div className="flex-line">
              <select
                className="theia-select"
                value={this.state.spectreMode}
                onChange={(e) =>
                  this.setState({
                    spectreMode: e.target.value as Settings['spectreMode'],
                  })
                }
              >
                <option value="basic">
                  {nls.localize('arduino/spectre/basic', 'Basic Ask Mode')}
                </option>
                <option value="agent">
                  {nls.localize('arduino/spectre/agent', 'Agent Mode')}
                </option>
              </select>
            </div>
          </div>
        </div>
      </div>
    );
  }

  protected renderProxySettings(): React.ReactNode {
    const disabled = this.state.network === 'none';
    return (
      <Disable disabled={disabled}>
        <div className="proxy-settings" aria-disabled={disabled}>
          <form className="flex-line">
            <input
              type="radio"
              checked={
                this.state.network === 'none'
                  ? true
                  : this.state.network.protocol === 'http'
              }
              onChange={this.httpProtocolDidChange}
            />
            HTTP
            <label className="flex-line">
              <input
                type="radio"
                checked={
                  this.state.network === 'none'
                    ? false
                    : this.state.network.protocol !== 'http'
                }
                onChange={this.socksProtocolDidChange}
              />
              SOCKS5
            </label>
          </form>
          <div className="flex-line proxy-settings">
            <div className="column">
              <div className="flex-line">{`${nls.localize(
                'arduino/preferences/proxySettings/hostname',
                'Host name'
              )}:`}</div>
              <div className="flex-line">{`${nls.localize(
                'arduino/preferences/proxySettings/port',
                'Port number'
              )}:`}</div>
              <div className="flex-line">{`${nls.localize(
                'arduino/preferences/proxySettings/username',
                'Username'
              )}:`}</div>
              <div className="flex-line">{`${nls.localize(
                'arduino/preferences/proxySettings/password',
                'Password'
              )}:`}</div>
            </div>
            <div className="column stretch">
              <div className="flex-line">
                <input
                  className="theia-input stretch with-margin"
                  type="text"
                  value={
                    this.state.network === 'none'
                      ? ''
                      : this.state.network.hostname
                  }
                  onChange={this.hostnameDidChange}
                />
              </div>
              <div className="flex-line">
                <input
                  className="theia-input small with-margin"
                  type="number"
                  pattern="[0-9]"
                  value={
                    this.state.network === 'none' ? '' : this.state.network.port
                  }
                  onKeyDown={this.numbersOnlyKeyDown}
                  onChange={this.portDidChange}
                />
              </div>
              <div className="flex-line">
                <input
                  className="theia-input stretch with-margin"
                  type="text"
                  value={
                    this.state.network === 'none'
                      ? ''
                      : this.state.network.username
                  }
                  onChange={this.usernameDidChange}
                />
              </div>
              <div className="flex-line">
                <input
                  className="theia-input stretch with-margin"
                  type="password"
                  value={
                    this.state.network === 'none'
                      ? ''
                      : this.state.network.password
                  }
                  onChange={this.passwordDidChange}
                />
              </div>
            </div>
          </div>
        </div>
      </Disable>
    );
  }

  private isControlKey(event: React.KeyboardEvent<HTMLInputElement>): boolean {
    return (
      !!event.key &&
      ['tab', 'delete', 'backspace', 'arrowleft', 'arrowright'].some(
        (key) => event.key.toLocaleLowerCase() === key
      )
    );
  }

  protected noopKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>
  ): void => {
    if (this.isControlKey(event)) {
      return;
    }
    event.nativeEvent.preventDefault();
    event.nativeEvent.returnValue = false;
  };

  protected numbersOnlyKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>
  ): void => {
    if (this.isControlKey(event)) {
      return;
    }
    const key = Number(event.key);
    if (isNaN(key) || event.key === null || event.key === ' ') {
      event.nativeEvent.preventDefault();
      event.nativeEvent.returnValue = false;
      return;
    }
  };

  protected browseSketchbookDidClick = async (): Promise<void> => {
    const uri = await this.props.fileDialogService.showOpenDialog({
      title: nls.localize(
        'arduino/preferences/newSketchbookLocation',
        'Select new sketchbook location'
      ),
      openLabel: nls.localize('arduino/preferences/choose', 'Choose'),
      canSelectFiles: false,
      canSelectMany: false,
      canSelectFolders: true,
      modal: true,
    });
    if (uri) {
      const sketchbookPath = await this.props.fileService.fsPath(uri);
      this.setState({ sketchbookPath });
    }
  };

  protected editAdditionalUrlDidClick = async (): Promise<void> => {
    const additionalUrls = await new AdditionalUrlsDialog(
      AdditionalUrls.parse(this.state.rawAdditionalUrlsValue, ','),
      this.props.windowService
    ).open();
    if (additionalUrls) {
      this.setState({
        rawAdditionalUrlsValue: AdditionalUrls.stringify(additionalUrls),
      });
    }
  };

  private setFontSize = (editorFontSize: number) => {
    this.setState({ editorFontSize });
  };

  protected rawAdditionalUrlsValueDidChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ): void => {
    this.setState({
      rawAdditionalUrlsValue: event.target.value,
    });
  };

  protected autoScaleInterfaceDidChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ): void => {
    this.setState({ autoScaleInterface: event.target.checked });
  };

  private setInterfaceScale = (percentage: number) => {
    const interfaceScale = InterfaceScale.ZoomLevel.fromPercentage(percentage);
    this.setState({ interfaceScale });
  };

  protected verifyAfterUploadDidChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ): void => {
    this.setState({ verifyAfterUpload: event.target.checked });
  };

  protected sketchbookShowAllFilesDidChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ): void => {
    this.setState({ sketchbookShowAllFiles: event.target.checked });
  };

  protected autoSaveDidChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ): void => {
    this.setState({
      autoSave: event.target.checked ? Settings.AutoSave.DEFAULT_ON : 'off',
    });
  };

  protected quickSuggestionsOtherDidChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ): void => {
    // need to persist react events through lifecycle https://reactjs.org/docs/events.html#event-pooling
    const newVal = event.target.checked ? true : false;

    this.setState((prevState) => {
      return {
        quickSuggestions: {
          ...prevState.quickSuggestions,
          other: newVal,
        },
      };
    });
  };

  protected themeDidChange = (
    event: React.ChangeEvent<HTMLSelectElement>
  ): void => {
    const { selectedIndex } = event.target.options;
    const theme = this.separatedThemes[selectedIndex];
    if (theme && typeof theme !== 'string') {
      this.setState({ themeId: theme.id });
      if (this.props.themeService.getCurrentTheme().id !== theme.id) {
        this.props.themeService.setCurrentTheme(theme.id);
      }
    }
  };

  protected languageDidChange = (
    event: React.ChangeEvent<HTMLSelectElement>
  ): void => {
    const selectedLanguage = event.target.value;
    this.setState({ currentLanguage: selectedLanguage });
  };

  protected compilerWarningsDidChange = (
    event: React.ChangeEvent<HTMLSelectElement>
  ): void => {
    const { selectedIndex } = event.target.options;
    const compilerWarnings = CompilerWarningLiterals[selectedIndex];
    if (compilerWarnings) {
      this.setState({ compilerWarnings });
    }
  };

  protected verboseOnCompileDidChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ): void => {
    this.setState({ verboseOnCompile: event.target.checked });
  };

  protected verboseOnUploadDidChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ): void => {
    this.setState({ verboseOnUpload: event.target.checked });
  };

  protected sketchpathDidChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ): void => {
    const sketchbookPath = event.target.value;
    if (sketchbookPath) {
      this.setState({ sketchbookPath });
    }
  };

  protected noProxyDidChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ): void => {
    if (event.target.checked) {
      this.setState({ network: 'none' });
    } else {
      this.setState({ network: Network.Default() });
    }
  };

  protected manualProxyDidChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ): void => {
    if (event.target.checked) {
      this.setState({ network: Network.Default() });
    } else {
      this.setState({ network: 'none' });
    }
  };

  protected httpProtocolDidChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ): void => {
    if (this.state.network !== 'none') {
      const network = this.cloneProxySettings;
      network.protocol = event.target.checked ? 'http' : 'socks5';
      this.setState({ network });
    }
  };

  protected socksProtocolDidChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ): void => {
    if (this.state.network !== 'none') {
      const network = this.cloneProxySettings;
      network.protocol = event.target.checked ? 'socks5' : 'http';
      this.setState({ network });
    }
  };

  protected hostnameDidChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ): void => {
    if (this.state.network !== 'none') {
      const network = this.cloneProxySettings;
      network.hostname = event.target.value;
      this.setState({ network });
    }
  };

  protected portDidChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ): void => {
    if (this.state.network !== 'none') {
      const network = this.cloneProxySettings;
      network.port = event.target.value;
      this.setState({ network });
    }
  };

  protected usernameDidChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ): void => {
    if (this.state.network !== 'none') {
      const network = this.cloneProxySettings;
      network.username = event.target.value;
      this.setState({ network });
    }
  };

  protected passwordDidChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ): void => {
    if (this.state.network !== 'none') {
      const network = this.cloneProxySettings;
      network.password = event.target.value;
      this.setState({ network });
    }
  };

  private get cloneProxySettings(): ProxySettings {
    const { network } = this.state;
    if (network === 'none') {
      throw new Error('Must be called when proxy is enabled.');
    }
    const copyNetwork = deepClone(network);
    return copyNetwork;
  }
  /**
   * Saves the Spectre API key to the backend secure storage.
   * After saving, clears the input field and refreshes the status
   * to confirm the key was successfully stored.
   */
  protected saveApiKeyDidClick = async (): Promise<void> => {
    const key = this.state.spectreApiKeyInput.trim();
    if (!key) {
      return;
    }
    try {
      this.setState({ spectreBusy: true });
      await this.props.secretsService.setApiKey(key);
      // Clear the input after saving; refresh status from backend to be sure
      const status = await this.props.secretsService.getStatus();
      this.setState({
        spectreHasApiKey: status.hasApiKey,
        spectreApiKeyInput: '',
      });
    } finally {
      this.setState({ spectreBusy: false });
    }
  };

  /**
   * Clears the Spectre API key from the backend secure storage.
   * After clearing, resets the UI state and refreshes the status.
   * Provides a fallback in case the status fetch fails.
   */
  protected clearApiKeyDidClick = async (): Promise<void> => {
    try {
      this.setState({ spectreBusy: true });
      await this.props.secretsService.clearApiKey();
      // Clear any typed value and refresh the status to avoid stale UI
      const status = await this.props.secretsService
        .getStatus()
        .catch(() => ({ hasApiKey: false }));
      this.setState({
        spectreHasApiKey: status.hasApiKey,
        spectreApiKeyInput: '',
      });
    } finally {
      this.setState({ spectreBusy: false });
    }
  };

  private async refreshSpectreStatus(): Promise<void> {
    try {
      const { hasApiKey } = await this.props.secretsService.getStatus();
      this.setState({ spectreHasApiKey: hasApiKey });
    } catch {
      // If backend is unavailable, assume no API key is configured
      this.setState({ spectreHasApiKey: false });
    }
  }
}
export namespace SettingsComponent {
  export interface Props {
    readonly settingsService: SettingsService;
    readonly fileService: FileService;
    readonly fileDialogService: FileDialogService;
    readonly windowService: WindowService;
    readonly localizationProvider: AsyncLocalizationProvider;
    readonly themeService: ThemeService;
    readonly secretsService: SpectreSecretsService;
    readonly secretsFrontendClient: SpectreSecretsFrontendClient;
  }
  export type State = Settings & {
    rawAdditionalUrlsValue: string;
    // Spectre UI-only state
    spectreApiKeyInput: string;
    spectreHasApiKey: boolean;
    spectreBusy: boolean;
  };
  export namespace State {
    export function fromSettings(settings: Settings): State {
      return {
        ...settings,
        rawAdditionalUrlsValue: AdditionalUrls.stringify(
          settings.additionalUrls
        ),
        spectreApiKeyInput: '',
        spectreHasApiKey: false,
        spectreBusy: false,
      };
    }
    export function toSettings(state: State): Settings {
      const parsedAdditionalUrls = AdditionalUrls.parse(
        state.rawAdditionalUrlsValue,
        ','
      );
      return {
        ...state,
        additionalUrls: AdditionalUrls.sameAs(
          state.additionalUrls,
          parsedAdditionalUrls
        )
          ? state.additionalUrls
          : parsedAdditionalUrls,
      };
    }
    export function merge(prevState: State, settings: Settings): State {
      const prevAdditionalUrls = AdditionalUrls.parse(
        prevState.rawAdditionalUrlsValue,
        ','
      );
      return {
        // Keep all persisted settings from backend/preferences
        ...settings,
        // Preserve UI-only state fields for Spectre (these are not persisted)
        // to maintain the current UI state during settings updates
        spectreApiKeyInput: prevState.spectreApiKeyInput,
        spectreHasApiKey: prevState.spectreHasApiKey,
        spectreBusy: prevState.spectreBusy,
        // Keep the raw text the user typed for additional URLs
        rawAdditionalUrlsValue: prevState.rawAdditionalUrlsValue,
        additionalUrls: AdditionalUrls.sameAs(
          prevAdditionalUrls,
          settings.additionalUrls
        )
          ? prevAdditionalUrls
          : settings.additionalUrls,
      };
    }
  }
}
