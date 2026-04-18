import * as vscode from 'vscode';
import { createKeyStore } from './keystore.js';
import { removeCustomService } from './service-metadata.js';
import { showSetupPanel } from './setup-panel.js';
import { validateKey, validateStoredKey } from './validation.js';

const keyStore = createKeyStore();

const PROVIDER_ID = 'dev-api-keys';
const PROVIDER_LABEL = 'Dev API Keys (Keychain)';

// Scope convention: exactly one scope, which is the Keychain key name
// (e.g. "openrouter"). Multi-scope OAuth semantics are not supported —
// callers must request one key at a time.
const VALID_KEY_NAME = /^[a-z0-9_-]{1,64}$/i;

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

  /**
   * Return a session for the requested key, or an empty array.
   *
   * Contract differs from most AuthenticationProviders: we require exactly
   * one scope (the key name). Calls with zero scopes, multiple scopes, or
   * an invalid name return []. We deliberately do NOT dump every stored
   * key for an unscoped probe, so an extension that calls
   * `vscode.authentication.getSessions('dev-api-keys')` cannot exfiltrate
   * every API key the user has stored.
   */
  async getSessions(
    scopes?: readonly string[],
    _options?: vscode.AuthenticationProviderSessionOptions,
  ): Promise<vscode.AuthenticationSession[]> {
    if (!scopes || scopes.length !== 1) { return []; }
    const name = scopes[0];
    if (!VALID_KEY_NAME.test(name)) { return []; }
    const value = await keyStore.get(name);
    return value ? [keyToSession(name, value)] : [];
  }

  async createSession(
    scopes: readonly string[],
    _options?: vscode.AuthenticationProviderSessionOptions,
  ): Promise<vscode.AuthenticationSession> {
    if (scopes.length > 1) {
      throw new Error('dev-api-keys supports exactly one scope (the key name).');
    }

    let name = scopes[0];
    if (!name) {
      name = await vscode.window.showInputBox({
        prompt: 'Key name (e.g., openrouter, openai, anthropic)',
        placeHolder: 'openrouter',
        validateInput: (v) => VALID_KEY_NAME.test(v) ? null : 'Use [a-z0-9_-], 1-64 chars',
      }) ?? '';
    }
    if (!name || !VALID_KEY_NAME.test(name)) {
      throw new Error('Valid key name is required (use [a-z0-9_-], 1-64 chars).');
    }

    const existing = await keyStore.get(name);
    if (existing) { return keyToSession(name, existing); }

    const value = await vscode.window.showInputBox({
      prompt: `Enter API key for "${name}"`,
      password: true,
      placeHolder: 'sk-...',
    });
    if (!value) { throw new Error('API key value is required'); }

    await keyStore.set(name, value);
    const validation = await validateKey(name, value);
    if (validation.ok) {
      void vscode.window.showInformationMessage(validation.message);
    } else {
      void vscode.window.showWarningMessage(validation.message);
    }
    const session = keyToSession(name, value);
    this._onDidChangeSessions.fire({ added: [session], removed: undefined, changed: undefined });
    return session;
  }

  async removeSession(sessionId: string): Promise<void> {
    if (!VALID_KEY_NAME.test(sessionId)) { return; }
    const value = await keyStore.get(sessionId);
    if (value) {
      await keyStore.delete(sessionId);
      removeCustomService(sessionId);
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
      await keyStore.set(name, value);
      onKeysChanged();
      const validation = await validateKey(name, value);
      const message = `Stored key: ${name}. ${validation.message}`;
      if (validation.ok) {
        vscode.window.showInformationMessage(message);
      } else {
        vscode.window.showWarningMessage(message);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dev-keys.removeKey', async () => {
      const names = await keyStore.list();
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
      const names = await keyStore.list();
      if (names.length === 0) {
        vscode.window.showInformationMessage('No keys stored.');
        return;
      }
      const items = names.map(n => ({ label: n, description: 'Secure keystore · select to validate' }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Stored API keys' });
      if (!picked) { return; }
      const result = await validateStoredKey(picked.label, keyStore);
      if (result.ok) {
        vscode.window.showInformationMessage(result.message);
      } else {
        vscode.window.showWarningMessage(result.message);
      }
    }),
  );
}

export function deactivate() {}
