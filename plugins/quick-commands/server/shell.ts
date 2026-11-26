import os from "node:os";

/** The daemon's `SHELL`, else the account's shell from the passwd database, else `/bin/sh`. */
export function loginShell(env: Record<string, string | undefined> = process.env, accountShell: () => string | null = passwdShell): string {
  const fromEnv = env.SHELL?.trim();
  if (fromEnv?.startsWith("/")) return fromEnv;
  const fromAccount = accountShell()?.trim();
  if (fromAccount?.startsWith("/")) return fromAccount;
  return "/bin/sh";
}

/** `-l` without `-i`: there is no terminal, and an interactive shell would print job-control warnings into every run's output. */
export function shellArgs(command: string): string[] {
  return ["-lc", command];
}

function passwdShell(): string | null {
  try {
    return os.userInfo().shell;
  } catch {
    return null;
  }
}
