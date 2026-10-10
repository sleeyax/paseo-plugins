import assert from "node:assert/strict";
import test from "node:test";
import { readOnlyCommand } from "./read-only-command.ts";

test("commands that only read are read-only, pipelines and lists of them included", () => {
  for (const command of [
    "git log --oneline abc123..def456",
    "git diff --no-ext-diff --no-color --diff-algorithm=myers -U3 -M abc...def -- 'src/a b.ts'",
    "git -C /repo --no-pager show def456:src/upload.ts",
    "git diff --name-status abc...def | head -50",
    "git grep -n 'retry(' -- '*.ts'",
    "git log --output-indicator-new=+ -p abc..def",
    "rg -n \"uploadWith\\(\" src",
    "ls src/*.ts",
    "cat src/upload.ts | wc -l",
    "find src -name '*.ts' -type f",
    "grep -rn retry src 2>/dev/null",
    "git diff abc...def 2>&1 | tail -n 20",
    "cd src && ls -la; pwd",
    "wc -l < src/upload.ts",
    "jq .scripts package.json",
    "sort -u names.txt",
  ]) {
    assert.equal(readOnlyCommand(command), true, command);
  }
});

test("commands that write, run another program or are not followed are not read-only", () => {
  for (const command of [
    "",
    "rm -rf .",
    "git checkout main",
    "git fetch origin",
    "git branch feature",
    "git -c core.pager='sh -c id' log",
    "git diff --output=out.txt",
    "git diff --ext-diff",
    "git grep -Ovim retry",
    "git diff *",
    "find . -name '*.ts' -delete",
    "find . -exec rm {} ;",
    "find . -de*",
    "sort -o names.txt names.txt",
    "sort -uo names.txt names.txt",
    "sort --compress-program=sh names.txt",
    "rg --pre ./run.sh retry",
    "tree -o out.txt",
    "file -C -m magic",
    "cat a > b",
    "cat a >> b",
    "cat a 1>b",
    "cat <<EOF",
    "cat <(ls)",
    "echo $(rm -rf .)",
    'echo "`rm -rf .`"',
    "(ls)",
    "ls & rm -rf .",
    "FOO=bar git log",
    "xargs rm < files",
    "sed -i s/a/b/ file",
    "awk '{ system(\"rm x\") }' file",
    "/bin/rm x",
    "ls; rm x",
    "ls 'unterminated",
    "ls # comment",
  ]) {
    assert.equal(readOnlyCommand(command), false, command);
  }
});
