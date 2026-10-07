/** A repository as a git remote names it, reduced to what two spellings of one remote share. */
export type RemoteRepository = { host: string; project: string };

/**
 * Reads `https://github.com/o/r.git`, `git@github.com:o/r.git`, `ssh://git@github.com:22/o/r` and the
 * like, lower-cased: GitHub and GitLab both treat paths case-insensitively. Null for anything else,
 * a local path included.
 */
export function parseRemoteUrl(remote: string): RemoteRepository | null {
  const text = remote.trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return normalize(scp[1]!, scp[2]!);

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol) || url.hostname === "") return null;
  return normalize(url.hostname, url.pathname);
}

function normalize(host: string, pathname: string): RemoteRepository | null {
  const project = pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  if (!project.includes("/")) return null;
  return { host: host.toLowerCase().replace(/^www\./, ""), project };
}

export function isSameRepository(remote: string, repository: RemoteRepository): boolean {
  const parsed = parseRemoteUrl(remote);
  return (
    parsed !== null && parsed.host === repository.host.toLowerCase() && parsed.project === repository.project.toLowerCase()
  );
}
