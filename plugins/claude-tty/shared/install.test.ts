import assert from "node:assert/strict";
import test from "node:test";
import {
  INSTALL_STEPS,
  failedStep,
  runningStep,
  startJob,
  stepOutput,
  withStepRunning,
  withStepSettled,
  type InstallJob,
} from "./install.ts";

function settleAll(job: InstallJob): InstallJob {
  return INSTALL_STEPS.reduce(
    (current, step) => withStepSettled(withStepRunning(current, step.id), step.id, { ok: true, detail: "done" }, 2),
    job,
  );
}

test("starts every step pending", () => {
  const job = startJob(1);
  assert.equal(job.state, "running");
  assert.equal(job.finishedAt, null);
  assert.deepEqual(
    job.steps.map((step) => step.id),
    INSTALL_STEPS.map((step) => step.id),
  );
  assert.ok(job.steps.every((step) => step.state === "pending"));
});

test("finishes the job only once the last step is ok", () => {
  let job = startJob(1);
  for (const step of INSTALL_STEPS.slice(0, -1)) {
    job = withStepSettled(withStepRunning(job, step.id), step.id, { ok: true, detail: "done" }, 2);
    assert.equal(job.state, "running");
  }
  const last = INSTALL_STEPS[INSTALL_STEPS.length - 1]!;
  job = withStepSettled(withStepRunning(job, last.id), last.id, { ok: true, detail: "done" }, 3);
  assert.equal(job.state, "ok");
  assert.equal(job.finishedAt, 3);
});

test("stops at the first failure and leaves the rest pending", () => {
  const job = withStepSettled(
    withStepRunning(startJob(1), "diagnose"),
    "diagnose",
    { ok: false, detail: "--diagnose --json exited 2", stderr: "claude is not on PATH", exitCode: 2 },
    4,
  );
  assert.equal(job.state, "failed");
  assert.equal(job.finishedAt, 4);
  assert.equal(failedStep(job)?.id, "diagnose");
  assert.equal(failedStep(job)?.exitCode, 2);
  assert.ok(job.steps.filter((step) => step.id !== "diagnose").every((step) => step.state === "pending"));
});

test("names the step in flight", () => {
  assert.equal(runningStep(startJob(1)), null);
  assert.equal(runningStep(withStepRunning(startJob(1), "diagnose"))?.id, "diagnose");
  assert.equal(runningStep(settleAll(startJob(1))), null);
});

test("clears an earlier attempt's output when a step restarts", () => {
  const failed = withStepSettled(startJob(1), "diagnose", { ok: false, detail: "no", stderr: "boom", exitCode: 1 }, 2);
  const retried = withStepRunning(failed, "diagnose");
  assert.equal(stepOutput(retried.steps.find((step) => step.id === "diagnose")!), "");
});

test("reads a step's output the way a terminal showed it", () => {
  const job = withStepSettled(startJob(1), "diagnose", { ok: false, detail: "no", stdout: "out\n", stderr: "err\n" }, 2);
  assert.equal(stepOutput(job.steps.find((step) => step.id === "diagnose")!), "out\nerr");
});
