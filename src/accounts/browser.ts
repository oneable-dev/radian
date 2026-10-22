import { execFile } from "node:child_process";
import { BrowserError } from "../errors.ts";
import { err, ok, type Result } from "../result.ts";

export function openLoginUrl(url: string): Promise<Result<void, BrowserError>> {
  if (!URL.canParse(url) || !["https:", "http:"].includes(new URL(url).protocol)) return Promise.resolve(err(new BrowserError("Only HTTP(S) login URLs can be opened.")));
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise(resolve => execFile(command, args, { timeout: 5000 }, error => resolve(error
    ? err(new BrowserError("Could not open the browser. Copy the login URL and open it manually.")) : ok(undefined))));
}
