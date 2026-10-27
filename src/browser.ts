import { execFile } from "node:child_process";
import { BrowserError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";

export function validateBrowserUrl(url: string): Result<string, BrowserError> {
  // oxlint-disable-next-line eslint/no-control-regex -- Reject control characters before passing URLs to an OS launcher.
  if (/[\u0000-\u001f\u007f]/u.test(url) || !/^https?:\/\//iu.test(url) || !URL.canParse(url)) {
    return err(new BrowserError("Only HTTP(S) URLs can be opened in the browser."));
  }
  return ok(url);
}

// Run on the attached UI host, not in the Agent/runtime process. Never invoke a shell.
export function openBrowserUrl(url: string): Promise<Result<void, BrowserError>> {
  const checked = validateBrowserUrl(url);
  if (!checked.ok) return Promise.resolve(checked);
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32.exe"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", checked.value] : [checked.value];
  return new Promise((resolve) =>
    execFile(command, args, { timeout: 5000 }, (error) =>
      resolve(
        error
          ? err(
              new BrowserError(
                "Could not confirm opening the browser. Copy the URL and open it manually; it may already have opened.",
                { cause: error },
              ),
            )
          : ok(undefined),
      ),
    ),
  );
}
