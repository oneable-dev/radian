import { main } from "./app/bootstrap.ts";
import { reportUnexpected } from "./errors.ts";

try {
  const result = await main();
  if (!result.ok) { console.error(`[${result.error.code}] ${result.error.message}`); process.exitCode = 1; }
} catch (error) { reportUnexpected(error, "application"); process.exitCode = 1; }
