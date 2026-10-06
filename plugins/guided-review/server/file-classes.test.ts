import assert from "node:assert/strict";
import test from "node:test";
import { classifyPath, keepOwnWork, setAside } from "./file-classes.ts";

test("lockfiles are told apart by their names", () => {
  for (const lockfile of [
    "package-lock.json",
    "web/pnpm-lock.yaml",
    "yarn.lock",
    "npm-shrinkwrap.json",
    "bun.lockb",
    "Cargo.lock",
    "Gemfile.lock",
    "poetry.lock",
    "uv.lock",
    "flake.lock",
    "go.sum",
    "ios/Podfile.lock",
    "Package.resolved",
  ]) {
    assert.equal(classifyPath(lockfile), "lockfile", lockfile);
  }
});

test("generated files are told apart by suffix, infix or directory", () => {
  for (const generated of [
    "dist/app.min.js",
    "static/site.min.css",
    "dist/app.js.map",
    "api/upload.pb.go",
    "py/upload_pb2.py",
    "lib/model.g.dart",
    "src/schema.generated.ts",
    "src/__generated__/graphql.ts",
    "src/__snapshots__/view.test.tsx.snap",
  ]) {
    assert.equal(classifyPath(generated), "generated", generated);
  }
});

test("anything else is left for the guide agent", () => {
  for (const source of ["src/lock.ts", "src/lockfile.ts", "package.json", "src/generated.ts", "docs/minify.md", "Makefile"]) {
    assert.equal(classifyPath(source), null, source);
  }
});

test("a guide of the own work also sets aside the files it does not change, by either path of a renamed one", () => {
  const file = (path: string, previousPath: string | null = null) => ({ path, previousPath });
  const files = [file("src/own.ts"), file("src/theirs.ts"), file("src/moved.ts", "src/old.ts"), file("pnpm-lock.yaml")];

  const split = keepOwnWork(setAside(files), ["src/own.ts", "src/old.ts", "pnpm-lock.yaml"]);

  assert.deepEqual(split.sent, [file("src/own.ts"), file("src/moved.ts", "src/old.ts")]);
  assert.deepEqual(split.setAside, [
    { path: "pnpm-lock.yaml", category: "lockfile" },
    { path: "src/theirs.ts", category: "foreign" },
  ]);
});
