#!/usr/bin/env bash
# Builds and reloads every plugin the daemon runs from this checkout, as it stands.
# Getting the checkout current is the caller's job.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

for tool in paseo pnpm jq; do
  if ! command -v "$tool" >/dev/null; then
    echo "Error: $tool not found on PATH" >&2
    exit 1
  fi
done

listing=$(paseo plugin ls --json)
mapfile -t plugins < <(jq -r --arg root "$root/" '.[] | select(.path | startswith($root)) | "\(.id)\t\(.path)"' <<<"$listing")

if [ "${#plugins[@]}" -eq 0 ]; then
  echo "No plugins installed from $root"
  exit 0
fi

# A reload closes every session on the plugin's provider, including the one running this.
hosting_provider=""
if [ -n "${PASEO_AGENT_ID:-}" ]; then
  hosting_provider=$(paseo inspect "$PASEO_AGENT_ID" --json | jq -r '.Provider // empty')
fi

workspace_installed=0

run_manifest_build() {
  local id=$1 dir=$2 line
  local -a build argv
  mapfile -t build < <(jq -c '.build // [] | .[]' "$dir/paseo-plugin.json")

  for line in ${build[@]+"${build[@]}"}; do
    mapfile -t argv < <(jq -r '.[]' <<<"$line")

    # One frozen install covers the whole pnpm workspace.
    if [ "${argv[*]}" = "pnpm install --frozen-lockfile" ]; then
      [ "$workspace_installed" -eq 0 ] || continue
      workspace_installed=1
    fi

    echo "==> $id: ${argv[*]}"
    if ! (cd "$dir" && "${argv[@]}" </dev/null); then
      echo "Error: build failed for $id, nothing was reloaded" >&2
      exit 1
    fi
  done
}

for plugin in "${plugins[@]}"; do
  IFS=$'\t' read -r id dir <<<"$plugin"
  run_manifest_build "$id" "$dir"
done

failed=0
for plugin in "${plugins[@]}"; do
  IFS=$'\t' read -r id dir <<<"$plugin"

  if [ "$id" = "$hosting_provider" ]; then
    echo "Skipped reload of $id: it hosts this session. Run: paseo plugin reload $id --json"
    continue
  fi

  status=$(paseo plugin reload "$id" --json | jq -r '.status') || status="reload failed"
  echo "$id: $status"
  if [ "$status" != "running" ]; then
    failed=1
    paseo plugin logs "$id" >&2 || true
  fi
done

exit "$failed"
