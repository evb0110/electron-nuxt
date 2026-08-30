#!/bin/bash

append_packaged_family_root() {
  local staged_root="$1"
  local existing_root
  for existing_root in ${packaged_family_roots[@]+"${packaged_family_roots[@]}"}; do
    if [ "$existing_root" = "$staged_root" ]; then
      return
    fi
  done
  packaged_family_roots+=("$staged_root")
}
