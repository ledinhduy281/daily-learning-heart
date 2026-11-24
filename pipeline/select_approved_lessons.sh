set -euo pipefail

destination=$1
validator="$PWD/pipeline/validate_lesson.py"
snapshots=$(mktemp -d)
trap 'rm -rf "$snapshots"' EXIT
approved="$snapshots/approved"
mkdir -p "$approved/data"
printf 'window.EBM_BRIEFINGS_DATA = {"briefings":[]};\n' > "$approved/data/briefings.js"
revisions=$(git log --first-parent --reverse --format=%H -- data/briefings.js data/rotation_state.json)

while read -r revision; do
  snapshot="$snapshots/$revision"
  mkdir "$snapshot"
  if ! git archive "$revision" | tar -x -C "$snapshot"; then
    echo "::warning::Skipping unreadable lesson revision $revision"
    rm -r "$snapshot"
    continue
  fi
  bundle="$snapshot/data/briefings.js"
  if [[ ! -f "$bundle" || ! -f "$snapshot/data/rotation_state.json" ]]; then
    echo "::warning::Skipping incomplete lesson revision $revision (missing bundle or rotation state)"
    rm -r "$snapshot"
    continue
  fi
  if [[ -f "$snapshot/pipeline/validate_lesson.py" ]]; then
    cp "$validator" "$snapshot/pipeline/validate_lesson.py"
    if ! (cd "$snapshot" && python3 -m pipeline.validate_lesson --previous "$approved/data/briefings.js"); then
      echo "::warning::Skipping invalid lesson bundle from $revision"
      rm -r "$snapshot"
      continue
    fi
  elif ! python3 -m pipeline.validate_lesson --bundle "$bundle" --allow-predating-pipeline; then
    echo "::warning::Skipping invalid pre-gate bundle from $revision"
    rm -r "$snapshot"
    continue
  fi
  rm -r "$approved"
  approved="$snapshot"
done <<< "$revisions"

test -f "$approved/data/rotation_state.json"
mkdir -p "$destination"
cp "$approved/data/briefings.js" "$approved/data/rotation_state.json" "$destination/"
