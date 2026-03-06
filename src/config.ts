import { workspace } from "vscode";

export type LeanEditsConfig = {
  participantName?: string | undefined;
  enabled: boolean;
};

// Currently unused. 
// Scaffolding in case we need to provide configuration.
export function load_config(): LeanEditsConfig {
  const config = workspace.getConfiguration("lean-edits");
  return {
    participantName: config.get<string>("participantName"),
    enabled: config.get<boolean>("enabled", true) ?? true
  };
}
