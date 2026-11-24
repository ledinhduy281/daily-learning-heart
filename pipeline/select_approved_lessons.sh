set -euo pipefail

destination=$1
validator="$PWD/pipeline/validate_lesson.py"
snapshots=$(mktemp -d)
trap 'rm -rf "$snapshots"' EXIT
approved="$snapshots/approved"
mkdir "$approved"
printf 'window.EBM_BRIEFINGS_DATA = {"briefings":[]};\n' > "$approved/briefings.js"
revisions=$(git log --first-parent --reverse --format=%H -- data/briefings.js)

while read -r revision; do
  snapshot="$snapshots/revision"
  mkdir "$snapshot"
  git archive "$revision" | tar -x -C "$snapshot"
  bundle="$snapshot/data/briefings.js"
  if [[ -f "$snapshot/pipeline/validate_lesson.py" ]]; then
    cp "$validator" "$snapshot/pipeline/validate_lesson.py"
    if ! (cd "$snapshot" && python3 -m pipeline.validate_lesson --previous "$approved/briefings.js"); then
      echo "::warning::Skipping invalid lesson bundle from $revision"
      rm -r "$snapshot"
      continue
    fi
  elif ! python3 -m pipeline.validate_lesson --bundle "$bundle" --allow-predating-pipeline; then
    echo "::warning::Skipping invalid pre-gate bundle from $revision"
    rm -r "$snapshot"
    continue
  fi
  cp "$bundle" "$snapshot/data/rotation_state.json" "$approved/"
  rm -r "$snapshot"
done <<< "$revisions"

test -f "$approved/rotation_state.json"
mkdir -p "$destination"
cp "$approved/"* "$destination/"
