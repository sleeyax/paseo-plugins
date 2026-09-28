import type { SubmitStep } from "../../shared/submit.ts";

/**
 * The steps of a submit as an adapter takes them, each recorded as done or failed as it goes, so a
 * failure part-way still reports the steps before it. An adapter decides from `run`'s answer whether
 * the next step is worth trying, and records one it does not try with `skip`.
 */
export class SubmitSteps {
  readonly steps: SubmitStep[] = [];

  /**
   * Runs one step and records how it went: its value, or undefined when it failed. `note` turns the
   * value into what a done step reports beside its label, like what a check found.
   */
  async run<T>(
    id: string,
    label: string,
    action: () => Promise<T>,
    note: (value: T) => string | null = () => null,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      const value = await action();
      this.steps.push({ id, label, status: "done", message: note(value) });
      return { ok: true, value };
    } catch (error) {
      // Any failure, not only a `ForgeError`: throwing here would lose the steps that already landed.
      this.steps.push({ id, label, status: "failed", message: error instanceof Error ? error.message : String(error) });
      return { ok: false };
    }
  }

  skip(id: string, label: string, message: string): void {
    this.steps.push({ id, label, status: "skipped", message });
  }
}
