import { workspace } from "vscode";

export type LeanEditsConfig = {
  participantName?: string | undefined;
  enabled: boolean;
  publicRepoOnly: boolean;
};

// Currently unused.
// Scaffolding in case we need to provide configuration.
export function load_config(): LeanEditsConfig {
  const config = workspace.getConfiguration("lean-edits");
  return {
    participantName: config.get<string>("participantName"),
    enabled: config.get<boolean>("enabled", true) ?? true,
    publicRepoOnly: config.get<boolean>("publicRepoOnly", true) ?? true,
  };
}
