/** How each forge writes a change request's number: `#105` for a GitHub PR, `!3931` for a GitLab MR. */
export function numberLabel(forge: "github" | "gitlab", number: number): string {
  return `${forge === "gitlab" ? "!" : "#"}${number}`;
}
