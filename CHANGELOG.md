# Change Log

All notable changes to the "lean-vacuum" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Initial release

## [0.0.6] - 2026-04-22

### Fixed
- If multiple lean folders are open, only one will ask the participant for their name. 
  The participant's name will appear in the global config for the extension which is visible from other workspaces. 
- If multiple lean folders are open, only one will ask the participant whether they want to:
  1. Add `.changes` to their global .gitignore (so they are ignored across all repos).
  2. Add `.changes` to their VSCode files.exclude (so they are excluded when searching for files).
- If a participant later wants to add `.changes` directories to their global .gitignore and vscode files.exclude, they 
  can run the command: "LeanEdits: Hide .changes/ from search and git"

### Added
- Testing script for testing multiple workspaces with a clean extension and environment: `scripts/test-extension.sh`

