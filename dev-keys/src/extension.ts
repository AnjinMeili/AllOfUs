import * as vscode from 'vscode';
import * as keychain from './keychain.js';

const PROVIDER_ID = 'dev-api-keys';
const PROVIDER_LABEL = 'Dev API Keys (Keychain)';

/**
 * Maps a key name to an AuthenticationSession.
 * Scopes carry the key name — consumers call:
 *   vscode.authentication.getSession('dev-api-keys', ['openrouter'], { createIfNone: true })
 * and get back a session whose accessToken is the API key.
 */
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
    // If scopes provided, return only the matching key
    if (scopes && scopes.length > 0) {
      const name = scopes[0];
      const value = await keychain.getKey(name);
      if (value) {
        return [keyToSession(name, value)];
      }
      return [];
    }

    // No scopes — return all keys
    const names = await keychain.listKeys();
    const sessions: vscode.AuthenticationSession[] = [];
    for (const name of names) {
      const value = await keychain.getKey(name);
      if (value) {
        sessions.push(keyToSession(name, value));
      }
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

    if (!name) {
      throw new Error('Key name is required');
    }

    // Check if it already exists in Keychain
    const existing = await keychain.getKey(name);
    if (existing) {
      return keyToSession(name, existing);
    }

    // Prompt for the value
    const value = await vscode.window.showInputBox({
      prompt: `Enter API key for "${name}"`,
      password: true,
      placeHolder: 'sk-...',
    });

    if (!value) {
      throw new Error('API key value is required');
    }

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

  /** Refresh a session from Keychain (e.g., after CLI update) */
  async refresh(name: string): Promise<void> {
    const value = await keychain.getKey(name);
    if (value) {
      const session = keyToSession(name, value);
      this._onDidChangeSessions.fire({ added: undefined, removed: undefined, changed: [session] });
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new DevKeysAuthProvider();

  context.subscriptions.push(
    vscode.authentication.registerAuthenticationProvider(
      PROVIDER_ID,
      PROVIDER_LABEL,
      provider,
      { supportsMultipleAccounts: true },
    ),
  );

  // Command: Add a key
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
      provider.refresh(name);
      vscode.window.showInformationMessage(`Stored key: ${name}`);
    }),
  );

  // Command: Remove a key
  context.subscriptions.push(
    vscode.commands.registerCommand('dev-keys.removeKey', async () => {
      const names = await keychain.listKeys();
      if (names.length === 0) {
        vscode.window.showInformationMessage('No keys stored.');
        return;
      }

      const name = await vscode.window.showQuickPick(names, {
        placeHolder: 'Select a key to remove',
      });
      if (!name) { return; }

      await provider.removeSession(name);
      vscode.window.showInformationMessage(`Removed key: ${name}`);
    }),
  );

  // Command: List keys
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
