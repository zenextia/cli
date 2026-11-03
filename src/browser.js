import { spawn } from 'node:child_process';

/**
 * The platform command that opens a URL in the default browser.
 * On Windows, rundll32 receives the URL as a plain argument: `cmd /c start`
 * would reinterpret `&` and `%` in the query string.
 */
export function browserCommand(url, platform = process.platform) {
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

export function openBrowser(url) {
  if (!/^https?:\/\//i.test(url)) return Promise.resolve(false);
  const [command, args] = browserCommand(url);
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
