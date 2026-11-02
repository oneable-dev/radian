import type { ProviderUsage } from "../usage/model.ts";

export type AuthAssessment = {
  readonly status: "valid" | "reauth-required" | "indeterminate";
  readonly message: string;
};

// Callers gate automatic checking to supported canonical OAuth accounts.
export function assessAuthentication(usage: ProviderUsage): AuthAssessment {
  if (usage.status === "error" && usage.errorCode === "USAGE_AUTH_REQUIRED") {
    return {
      status: "reauth-required",
      message: "The provider login is unavailable. Sign in again to continue.",
    };
  }
  if (
    (usage.status === "ready" || usage.status === "unavailable") &&
    usage.errorCode === null &&
    usage.updatedAt !== null
  ) {
    return {
      status: "valid",
      message: "Authentication was confirmed by the account usage service.",
    };
  }

  return {
    status: "indeterminate",
    message: "Authentication could not be confirmed. No sign-in change was made.",
  };
}
