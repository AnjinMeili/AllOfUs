import { execFile } from 'node:child_process';

const SERVICE = 'dev-api-keys';

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('security', args, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function getKey(name: string): Promise<string | undefined> {
  try {
    const value = await run([
      'find-generic-password', '-s', SERVICE, '-a', name, '-w',
    ]);
    return value.trim();
  } catch {
    return undefined;
  }
}

export async function setKey(name: string, value: string): Promise<void> {
  // Delete first — security add-generic-password fails on duplicates
  await deleteKey(name).catch(() => {});
  await run([
    'add-generic-password', '-s', SERVICE, '-a', name, '-w', value, '-U',
  ]);
}

export async function deleteKey(name: string): Promise<void> {
  await run(['delete-generic-password', '-s', SERVICE, '-a', name]);
}

export async function listKeys(): Promise<string[]> {
  try {
    const dump = await run(['dump-keychain']);
    const names: string[] = [];
    const lines = dump.split('\n');
    let foundService = false;

    for (const line of lines) {
      // Look for our service name
      if (line.includes('0x00000007 <blob>=') && line.includes(`"${SERVICE}"`)) {
        foundService = true;
        continue;
      }
      // The account line follows the service line in the same record
      if (foundService && line.includes('"acct"<blob>=')) {
        const match = line.match(/="([^"]*)"/);
        if (match?.[1]) {
          names.push(match[1]);
        }
        foundService = false;
      }
      // Reset on new keychain entry boundary
      if (line.startsWith('keychain:') || line.startsWith('class:')) {
        foundService = false;
      }
    }

    return [...new Set(names)].sort();
  } catch {
    return [];
  }
}
