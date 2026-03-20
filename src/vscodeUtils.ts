import * as vscode from "vscode";
import { extensionLog } from "./common";

const EXCLUDE_KEY = "**/.changes";

function filesExcludeHasChangesEntry(): boolean {
    const config = vscode.workspace.getConfiguration("files");
    const exclude = config.get<Record<string, boolean>>("exclude", {});
    return EXCLUDE_KEY in exclude;
}

async function askUserToAddChangesToFilesExclude(): Promise<boolean> {
    const selection = await vscode.window.showInformationMessage(
        `Add .changes/ to VSCode's files.exclude setting so it's hidden from file search?`,
        "Add",
        "No"
    );
    return selection === "Add";
}

/**
 * Add .changes to VSCode's files.exclude user setting so it is hidden
 * from the file explorer and quick-open file picker.
 */
export async function excludeChangesFromVscode(): Promise<void> {
    if (filesExcludeHasChangesEntry()) {
        extensionLog(`.changes already in VSCode files.exclude`);
        return;
    }
    const add = await askUserToAddChangesToFilesExclude();
    if (add) {
        const config = vscode.workspace.getConfiguration("files");
        const exclude = { ...config.get<Record<string, boolean>>("exclude", {}), [EXCLUDE_KEY]: true };
        await config.update("exclude", exclude, vscode.ConfigurationTarget.Global);
        extensionLog(`Added .changes to VSCode files.exclude`);
    }
}
