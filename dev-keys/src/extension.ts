import * as vscode from 'vscode';
import * as keychain from './keychain.js';
import { showSetupPanel } from './setup-panel.js';

const PROVIDER_ID = 'dev-api-keys';
const PROVIDER_LABEL = 'Dev API Keys (Keychain)';

function keyToSession(name: string, value: string): vscode.AuthenticationSession {
  return {
    id: name,
    accessToken: value,
    account: { id: name, label: name },
    scopes: [name],
  };
}

class DevKeysAuthProvider implements vscode.AuthenticationProvider {
  private _onDidChangeSessions = new vscode.EventEmitter<
    vscode.AuthenticationProviderAuthenticationSessionsChangeEvent
  >();

  readonly onDidChangeSessions = this._onDidChangeSessions.event;

  async getSessions(
    scopes?: readonly string[],
    _options?: vscode.AuthenticationProviderSessionOptions,
  ): Promise<vscode.AuthenticationSession[]> {
    if (scopes && scopes.length > 0) {
      const name = scopes[0];
      const value = await keychain.getKey(name);
      if (value) { return [keyToSession(name, value)]; }
      return [];
    }

    const names = await keychain.listKeys();
    const sessions: vscode.AuthenticationSession[] = [];
    for (const name of names) {
      const value = await keychain.getKey(name);
      if (value) { sessions.push(keyToSession(name, value)); }
    }
    return sessions;
  }

  async createSession(
    scopes: readonly string[],
    _options?: vscode.AuthenticationProviderSessionOptions,
  ): Promise<vscode.AuthenticationSession> {
    const name = scopes[0] ?? await vscode.window.showInputBox({
      prompt: 'Key name (e.g., openrouter, openai, anthropic)',
      placeHolder: 'openrouter',
    });
    if (!name) { throw new Error('Key name is required'); }

    const existing = await keychain.getKey(name);
    if (existing) { return keyToSession(name, existing); }

    const value = await vscode.window.showInputBox({
      prompt: `Enter API key for "${name}"`,
      password: true,
      placeHolder: 'sk-...',
    });
    if (!value) { throw new Error('API key value is required'); }

    await keychain.setKey(name, value);
    const session = keyToSession(name, value);
    this._onDidChangeSessions.fire({ added: [session], removed: undefined, changed: undefined });
    return session;
  }

  async removeSession(sessionId: string): Promise<void> {
    const value = await keychain.getKey(sessionId);
    if (value) {
      await keychain.deleteKey(sessionId);
      const session = keyToSession(sessionId, value);
      this._onDidChangeSessions.fire({ added: undefined, removed: [session], changed: undefined });
    }
  }

  fire(event: vscode.AuthenticationProviderAuthenticationSessionsChangeEvent): void {
    this._onDidChangeSessions.fire(event);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new DevKeysAuthProvider();

  const onKeysChanged = () => {
    provider.fire({ added: undefined, removed: undefined, changed: undefined });
  };

  context.subscriptions.push(
    vscode.authentication.registerAuthenticationProvider(
      PROVIDER_ID, PROVIDER_LABEL, provider,
      { supportsMultipleAccounts: true },
    ),
  );

  // Setup panel (floating modal UI)
  context.subscriptions.push(
    vscode.commands.registerCommand('dev-keys.setup', () => {
      showSetupPanel(context, onKeysChanged);
    }),
  );

  // Quick commands (retained for palette access)
  context.subscriptions.push(
    vscode.commands.registerCommand('dev-keys.addKey', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Key name (e.g., openrouter, openai, anthropic)',
        placeHolder: 'openrouter',
      });
      if (!name) { return; }
      const value = await vscode.window.showInputBox({
        prompt: `Enter API key for "${name}"`,
        password: true,
        placeHolder: 'sk-...',
      });
      if (!value) { return; }
      await keychain.setKey(name, value);
      onKeysChanged();
      vscode.window.showInformationMessage(`Stored key: ${name}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dev-keys.removeKey', async () => {
      const names = await keychain.listKeys();
      if (names.length === 0) {
        vscode.window.showInformationMessage('No keys stored.');
        return;
      }
      const name = await vscode.window.showQuickPick(names, { placeHolder: 'Select a key to remove' });
      if (!name) { return; }
      await provider.removeSession(name);
      vscode.window.showInformationMessage(`Removed key: ${name}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dev-keys.listKeys', async () => {
      const names = await keychain.listKeys();
      if (names.length === 0) {
        vscode.window.showInformationMessage('No keys stored.');
        return;
      }
      const items = names.map(n => ({ label: n, description: 'macOS Keychain' }));
      vscode.window.showQuickPick(items, { placeHolder: 'Stored API keys' });
    }),
  );
}

export function deactivate() {}
