export type BrowserOpenCommand = {
  command: string;
  args: string[];
};

export function getSecureStoreLabel(platformName: NodeJS.Platform | string = process.platform): string {
  switch (platformName) {
    case 'darwin':
      return 'macOS Keychain';
    case 'linux':
      return 'Linux Secret Service';
    case 'win32':
      return 'Windows Credential Manager';
    default:
      return 'secure OS credential store';
  }
}

export function getBrowserOpenCommand(
  url: string,
  platformName: NodeJS.Platform | string = process.platform,
): BrowserOpenCommand | undefined {
  switch (platformName) {
    case 'darwin':
      return { command: 'open', args: [url] };
    case 'win32':
      return { command: 'cmd', args: ['/c', 'start', '', url] };
    case 'linux':
    case 'freebsd':
    case 'openbsd':
    case 'sunos':
      return { command: 'xdg-open', args: [url] };
    default:
      return undefined;
  }
}
