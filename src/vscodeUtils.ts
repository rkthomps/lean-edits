import * as vscode from "vscode";
import { extensionLog, waitUntilFocused, tryAcquireLock, releaseLock, waitForLockRelease } from "./common";

const EXCLUDE_KEY = "**/.changes";
const DECLINED_KEY = "changesFilesExcludeDeclined";
const LOCK_KEY = "filesExcludeLock";
const RECOVERY_HINT = `You can change this anytime by running "LeanEdits: Hide .changes/ from search and git" from the command palette.`;

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

async function writeFilesExcludeEntry(): Promise<void> {
    const config = vscode.workspace.getConfiguration("files");
    const exclude = { ...config.get<Record<string, boolean>>("exclude", {}), [EXCLUDE_KEY]: true };
    await config.update("exclude", exclude, vscode.ConfigurationTarget.Global);
    extensionLog(`Added .changes to VSCode files.exclude`);
}

async function promptAndApplyFilesExclude(globalState: vscode.Memento): Promise<void> {
    const add = await askUserToAddChangesToFilesExclude();
    if (add) {
        await writeFilesExcludeEntry();
        await globalState.update(DECLINED_KEY, undefined);
    } else {
        await globalState.update(DECLINED_KEY, true);
        vscode.window.showInformationMessage(
            `.changes/ will remain visible in file search. ${RECOVERY_HINT}`,
            "Got it"
        );
    }
}

/**
 * Add .changes to VSCode's files.exclude user setting so it is hidden
 * from the file explorer and quick-open file picker.
 */
export async function excludeChangesFromVscode(globalState: vscode.Memento, force: boolean = false): Promise<void> {
    if (filesExcludeHasChangesEntry()) {
        extensionLog(`.changes already in VSCode files.exclude`);
        return;
    }
    if (force) {
        await writeFilesExcludeEntry();
        await globalState.update(DECLINED_KEY, undefined);
        return;
    }

    while (true) {
        if (filesExcludeHasChangesEntry()) return;
        if (globalState.get<boolean>(DECLINED_KEY)) {
            extensionLog(`User previously declined adding .changes to files.exclude; skipping.`);
            return;
        }

        await waitUntilFocused();
        if (filesExcludeHasChangesEntry()) return;
        if (globalState.get<boolean>(DECLINED_KEY)) return;

        if (await tryAcquireLock(globalState, LOCK_KEY)) {
            try {
                if (filesExcludeHasChangesEntry()) return;
                if (globalState.get<boolean>(DECLINED_KEY)) return;
                await promptAndApplyFilesExclude(globalState);
            } finally {
                await releaseLock(globalState, LOCK_KEY);
            }
            return;
        }

        // Another window is prompting; wait for it to finish, then re-check.
        await waitForLockRelease(globalState, LOCK_KEY);
    }
}
