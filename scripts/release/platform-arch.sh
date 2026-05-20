#!/bin/bash

release_target_usage() {
  echo "Usage: $1 <platform: mac|win|linux> <arch: x64|arm64>"
}

resolve_release_target_platform_arch() {
  local platform="$1"
  local arch="$2"

  case "$platform" in
    mac)
      RELEASE_PLATFORM_ARCH="darwin-$arch"
      RELEASE_EXE_SUFFIX=""
      ;;
    win)
      RELEASE_PLATFORM_ARCH="win32-$arch"
      RELEASE_EXE_SUFFIX=".exe"
      ;;
    linux)
      RELEASE_PLATFORM_ARCH="linux-$arch"
      RELEASE_EXE_SUFFIX=""
      ;;
    *)
      echo "Error: Unsupported platform '$platform'"
      return 1
      ;;
  esac

  case "$arch" in
    x64|arm64) ;;
    *)
      echo "Error: Unsupported architecture '$arch'"
      return 1
      ;;
  esac
}

detect_release_host_platform() {
  case "$(uname -s)" in
    Darwin)
      RELEASE_HOST_PLATFORM="mac"
      ;;
    Linux)
      RELEASE_HOST_PLATFORM="linux"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      RELEASE_HOST_PLATFORM="win"
      ;;
    *)
      echo "Error: Unsupported host platform $(uname -s)"
      return 1
      ;;
  esac
}
