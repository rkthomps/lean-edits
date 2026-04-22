import vscode, { workspace } from "vscode";
import { execSync } from "child_process";
import assert from "assert";
import os from "os";
import path from "path";


import {
  logChange,
  updateConcreteCheckpoints,
  cleanupOldCommitDirs,
  getWorkspacePath,
  getBaseCommit,
  getChangesDir
} from "./tracking";

import { ignoreChanges, isOriginPublic } from "./gitUtils";
import { excludeChangesFromVscode } from "./vscodeUtils";

import { upload } from "./upload";

import { LeanEditsConfig, load_config } from "./config";

import { EXTENSION_NAME, CONSENT_URL, extensionLog, waitUntilFocused, tryAcquireLock, releaseLock, waitForLockRelease } from "./common";

const NAME_LOCK_KEY = "nameInputLock";
import { readFileSync } from "fs";
import { all } from "axios";


function createStatusBar(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  item.command = `${EXTENSION_NAME}.toggleEnabled`;
  return item;
}


class LeanEditsController {
  private updateCheckpointTimer: NodeJS.Timeout | null;
  private uploadTimer: NodeJS.Timeout | null;
  private config: LeanEditsConfig;
  private statusBarItem: vscode.StatusBarItem;
  private originPublic: boolean;

  constructor(config: LeanEditsConfig) {
    this.updateCheckpointTimer = null;
    this.uploadTimer = null;
    this.config = config;
    extensionLog(`config.enabled: ${config.enabled}, config.participantName: ${config.participantName}, config.publicRepoOnly: ${config.publicRepoOnly}`);
    this.originPublic = !config.publicRepoOnly;
    this.statusBarItem = createStatusBar();
    this.renderStatusBar();
  }

  getStatusBarItem(): vscode.StatusBarItem {
    return this.statusBarItem;
  }

  renderStatusBar() {
    if (this.effectivelyEnabled()) {
      this.statusBarItem.text = `LeanEdits: ON`;
    } else if (this.config.enabled && !this.nameNonempty()) {
      this.statusBarItem.text = `LeanEdits: OFF (Name Required)`;
    } else if (this.config.enabled && this.config.publicRepoOnly && !this.originPublic) {
      this.statusBarItem.text = `LeanEdits: OFF (Private Workspace)`;
    } else {
      assert(!this.config.enabled)
      this.statusBarItem.text = `LeanEdits: OFF (Disabled)`;
    }
    this.statusBarItem.show();
  }

  getConfig(): LeanEditsConfig {
    return this.config;
  }

  updateConfig(config: LeanEditsConfig) {
    this.config = config;
  }

  setOriginPublic(value: boolean) {
    this.originPublic = value;
    this.renderStatusBar();
  }

  nameNonempty(): boolean {
    return this.config.participantName !== undefined && this.config.participantName.trim() !== "";
  }

  cantBeEnabledReason(): string | null {
    if (!this.nameNonempty()) {
      return "Name is required";
    }
    if (this.config.publicRepoOnly && !this.originPublic) {
      return "Workspace is private";
    }
    return null;
  }

  canBeEnabled(): boolean {
    const publicRepoOk = !this.config.publicRepoOnly || this.originPublic;
    return this.nameNonempty() && publicRepoOk;
  }

  effectivelyEnabled(): boolean {
    return this.config.enabled && this.canBeEnabled();
  }

  setUploadTimer(wsPath: string) {
    if (this.uploadTimer) {
      return;
    }
    extensionLog(`setting upload timer`);
    this.uploadTimer = setTimeout(async () => {
      let time = await timeit(async () => {
        if (this.effectivelyEnabled()) {
          let participantName = this.config.participantName!;
          let [baseCommit, _] = getBaseCommit(wsPath, participantName);
          let changesDir = getChangesDir(wsPath, baseCommit);
          extensionLog(`sending upload request`);
          await upload(changesDir);
        }
      });
      extensionLog(`uploaded changes in ${time}ms`);
      this.uploadTimer = null;
    }, UPLOAD_TIME_MS);
  }


  setCheckpointTimer(wsPath: string) {
    if (this.updateCheckpointTimer) {
      clearTimeout(this.updateCheckpointTimer);
    }

    this.updateCheckpointTimer = setTimeout(async () => {
      let time = await timeit(async () => {
        if (this.effectivelyEnabled()) {
          const participantName = this.config.participantName!;
          return updateConcreteCheckpoints(wsPath, this.config, participantName);
        }
      });
      extensionLog(`updated concrete checkpoints in ${time}ms`);
    }, CHECKPOINT_TIME_MS);
  }
}


function showConsentUrl() {
  const openForm = "Open Consent Form";
  const completeForm = "I have completed the form";
  vscode.window.showWarningMessage(
    "Please ensure you've completed the LeanEdits Consent Form before using the extension.",
    { modal: true },
    openForm,
    completeForm
  ).then(selection => {
    if (selection === openForm) {
      vscode.env.openExternal(
        vscode.Uri.parse(CONSENT_URL)
      );
    }
  });
}


async function askForName(): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    title: "LeanEdits",
    prompt: "Enter your name (as written on the consent form)",
    placeHolder: "Your name",
    ignoreFocusOut: true, // keeps the box open if the user clicks outside
    validateInput: (value) => {
      if (!value.trim()) {
        return "Name cannot be empty";
      } else {
        return null;
      }
    },
  });
  return name; // undefined if user cancels
}

let controller: LeanEditsController | undefined = undefined;


export function getController(): LeanEditsController {
  if (controller === undefined) {
    controller = new LeanEditsController(load_config());
  }
  return controller;
}


/** 
 * Returns the time of an operation in milliseconds.
*/
async function timeit<T>(f: () => Promise<T>): Promise<number> {
  const start = process.hrtime.bigint();
  await f();
  const end = process.hrtime.bigint();
  return Number(end - start) / 1_000_000;
}

const UPLOAD_TIME_MS = 5 * 60 * 1000;
// const UPLOAD_TIME_MS = 20 * 1000;
const CHECKPOINT_TIME_MS = 3 * 1000;



export async function activate(context: vscode.ExtensionContext) {
  // Right now no need for the config
  console.log("[lean-edits] activating");
  const controller = getController();
  console.log(`[lean-edits] effectively enabled: ${controller.effectivelyEnabled()}`);
  console.log(`[lean-edits] participant name: ${controller.getConfig().participantName}`);

  // Show consent command
  const showConsentCommand = vscode.commands.registerCommand(`${EXTENSION_NAME}.showConsentUrl`, () => {
    showConsentUrl();
  });
  context.subscriptions.push(showConsentCommand);

  // Ignore .changes directory in global gitignore and VSCode file search.
  // Sequenced so the two prompts don't overlap; each waits for window focus
  // and respects a permanent "declined" flag in globalState.
  (async () => {
    await ignoreChanges(context.globalState);
    await excludeChangesFromVscode(context.globalState);
  })();

  // Recovery command for users who previously declined the .changes/ prompts.
  const hideChangesCommand = vscode.commands.registerCommand(`${EXTENSION_NAME}.hideChanges`, async () => {
    await ignoreChanges(context.globalState, true);
    await excludeChangesFromVscode(context.globalState, true);
    vscode.window.showInformationMessage(`.changes/ is now hidden from file search and git.`);
  });
  context.subscriptions.push(hideChangesCommand);

  // Toggle enabled/disabled command 
  const toggleEnabledCommand = vscode.commands.registerCommand(`${EXTENSION_NAME}.toggleEnabled`, async () => {
    const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
    const controller = getController();
    if (controller.canBeEnabled()) {
      const enabled = config.get<boolean>("enabled", true);
      await config.update(
        "enabled",
        !enabled,
        vscode.ConfigurationTarget.Global
      );

      vscode.window.showInformationMessage(
        `LeanEdits ${!enabled ? "enabled" : "disabled"}`
      );
    } else {
      if (!config.get<boolean>("enabled", true)) {
        await config.update(
          "enabled",
          true,
          vscode.ConfigurationTarget.Global
        );
      }
      vscode.window.showWarningMessage(
        `Cannot enable LeanEdits: ${controller.cantBeEnabledReason()}`
      )
    }
    controller.updateConfig(load_config());
    controller.renderStatusBar();
  });
  context.subscriptions.push(toggleEnabledCommand);

  // Status bar item
  context.subscriptions.push(controller.getStatusBarItem());


  // Show consent form & Ask for participant name if not set.
  // Two-window safety: only the focused window prompts (waitUntilFocused),
  // and only one window at a time runs the prompt (globalState lock).
  if (!controller.nameNonempty()) {
    while (true) {
      await waitUntilFocused();
      controller.updateConfig(load_config());
      if (controller.nameNonempty()) break;

      if (await tryAcquireLock(context.globalState, NAME_LOCK_KEY)) {
        try {
          controller.updateConfig(load_config());
          if (controller.nameNonempty()) break;
          showConsentUrl();
          const name = await askForName();
          if ((name !== undefined) && (name.trim() !== "")) {
            const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
            await config.update(
              "participantName",
              name,
              vscode.ConfigurationTarget.Global
            );
            controller.updateConfig(load_config());
          }
        } finally {
          await releaseLock(context.globalState, NAME_LOCK_KEY);
        }
        break;
      }

      // Another window is prompting; wait for it to finish, then re-check.
      await waitForLockRelease(context.globalState, NAME_LOCK_KEY);
    }
    controller.renderStatusBar();
  }

  // Check if repo is public, accounting for the Git extension loading repos asynchronously
  const checkOriginPublic = async () => {
    let allPublic = true;
    for (let ws of workspace.workspaceFolders ?? []) {
      const isPublic = await isOriginPublic(ws.uri.fsPath);
      allPublic = allPublic && isPublic;
    }
    controller.setOriginPublic(allPublic);
  };

  const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
  if (gitExtension) {
    const api = gitExtension.getAPI(1);

    const handleRepo = async (repo: any) => {
      if (repo.state.remotes.length > 0) {
        await checkOriginPublic();
      } else {
        const stateDisposable = repo.state.onDidChange(async () => {
          if (repo.state.remotes.length > 0) {
            stateDisposable.dispose();
            await checkOriginPublic();
          }
        });
        context.subscriptions.push(stateDisposable);
      }
    };

    // Register the listener first, then check if repos are already loaded,
    // to avoid a race where onDidOpenRepository fires during the name prompt.
    const disposable = api.onDidOpenRepository(async (repo: any) => {
      disposable.dispose();
      await handleRepo(repo);
    });
    context.subscriptions.push(disposable);

    if (api.repositories.length > 0) {
      disposable.dispose();
      await handleRepo(api.repositories[0]);
    }
  }



  // Initial checkpoint update and cleanup
  if (controller.effectivelyEnabled()) {
    for (let ws of workspace.workspaceFolders ?? []) {
      let wsPath = ws.uri.fsPath;
      let time = await timeit(async () => {
        const participantName = controller.getConfig().participantName!;
        return updateConcreteCheckpoints(wsPath, controller.getConfig(), participantName);
      });
      console.log(`[lean-edits] initial concrete checkpoint update in ${time}ms`);
      await cleanupOldCommitDirs(wsPath, upload);
    }
  }

  // On change events
  const changeHook = workspace.onDidChangeTextDocument(async (e) => {
    if (e.contentChanges.length === 0) {
      return; // VsCode fires changes with 0 length. We should not record these.
    }
    let wsPath = getWorkspacePath(e.document);
    let controller = getController();
    if (wsPath === undefined) {
      return;
    }
    if (!controller.effectivelyEnabled()) {
      return;
    }
    controller.setCheckpointTimer(wsPath);
    controller.setUploadTimer(wsPath);
    const config = controller.getConfig();
    const time = await timeit(async () => {
      const participantName = controller.getConfig().participantName!;
      return logChange(e, config, participantName);
    });
    // console.log(`[lean-edits] logged change in ${time}ms`);
  });
  context.subscriptions.push(changeHook);


  // On configuration change events
  const configHook = workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("lean-edits")) {
      const config = load_config();
      getController().updateConfig(config);
      getController().renderStatusBar();
    }
  });
  context.subscriptions.push(configHook);

  // Sync Checkpoints Command
  const syncCheckpointsCommand = vscode.commands.registerCommand(`${EXTENSION_NAME}.syncCheckpoints`, async () => {
    let wsFolders = workspace.workspaceFolders;
    if (!wsFolders || wsFolders.length === 0) {
      return;
    }
    for (let ws of wsFolders) {
      const participantName = getController().getConfig().participantName!;
      updateConcreteCheckpoints(ws.uri.fsPath, getController().getConfig(), participantName);
    }
  });
  context.subscriptions.push(syncCheckpointsCommand);

  // Upload Command
  const uploadCommand = vscode.commands.registerCommand(`${EXTENSION_NAME}.uploadChanges`, async () => {
    let wsFolders = workspace.workspaceFolders;
    if (!wsFolders || wsFolders.length === 0) {
      vscode.window.showErrorMessage("No workspace folder found. Please open a folder in VSCode to upload changes.");
      return;
    }
    for (let ws of wsFolders) {
      let wsPath = ws.uri.fsPath;
      const participantName = getController().getConfig().participantName!;
      let [baseCommit, _] = getBaseCommit(wsPath, participantName);
      let changesDir = getChangesDir(wsPath, baseCommit);
      extensionLog(`sending upload request`);
      await upload(changesDir);
    }
  });
  context.subscriptions.push(uploadCommand);
  console.log("[lean-edits] activated");
}

export function deactivate(): void {

}
