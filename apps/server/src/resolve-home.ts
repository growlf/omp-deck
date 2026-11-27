import os from "node:os";

/**
 * Resolve the user's home directory, honoring the same env the tests override
 * (Bun's os.homedir() ignores HOME/USERPROFILE).
 */
export function resolveHome(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir();
}
