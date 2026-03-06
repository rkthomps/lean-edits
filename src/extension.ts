import vscode, { workspace } from "vscode";
import { execSync } from "child_process";
import assert from "assert";
import os from "os";
import path from "path";


import {
  logChange,
  updateConcreteCheckpoints,
  getWorkspacePath,
  getBaseCommit,
  getChangesDir
} from "./tracking";

import { ignoreChanges } from "./gitUtils";

import { upload } from "./upload";

import { LeanEditsConfig, load_config } from "./config";

import { EXTENSION_NAME, CONSENT_URL, extensionLog } from "./common";
import { readFileSync } from "fs";


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

  constructor(config: LeanEditsConfig) {
    this.updateCheckpointTimer = null;
    this.uploadTimer = null;
    this.config = config;
    this.statusBarItem = createStatusBar();
    this.renderStatusBar();
  }

  getStatusBarItem(): vscode.StatusBarItem {
    return this.statusBarItem;
  }

  renderStatusBar() {
    if (this.config.enabled) {
      this.statusBarItem.text = `LeanEdits: ON`;
    } else {
      this.statusBarItem.text = `LeanEdits: OFF`;
    }
    this.statusBarItem.show();
  }

  getConfig(): LeanEditsConfig {
    return this.config;
  }

  updateConfig(config: LeanEditsConfig) {
    this.config = config;
  }

  nameNonempty(): boolean {
    return this.config.participantName !== undefined && this.config.participantName.trim() !== "";
  }

  effectivelyEnabled(): boolean {
    return this.config.enabled && this.nameNonempty();
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


function getController(): LeanEditsController {
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
  console.log("[lean-edits] activated");
  const controller = getController();
  console.log(`[lean-edits] effectively enabled: ${controller.effectivelyEnabled()}`);
  console.log(`[lean-edits] participant name: ${controller.getConfig().participantName}`);

  // Show consent command
  const showConsentCommand = vscode.commands.registerCommand(`${EXTENSION_NAME}.showConsentUrl`, () => {
    showConsentUrl();
  });
  context.subscriptions.push(showConsentCommand);

  // Ignore .changes directory in global gitignore
  ignoreChanges();

  // Toggle enabled/disabled command 
  const toggleEnabledCommand = vscode.commands.registerCommand(`${EXTENSION_NAME}.toggleEnabled`, async () => {
    const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
    const enabled = config.get<boolean>("enabled", true);
    await config.update(
      "enabled",
      !enabled,
      vscode.ConfigurationTarget.Global
    );

    const controller = getController();
    controller.updateConfig(load_config());
    controller.renderStatusBar();
    vscode.window.showInformationMessage(
      `LeanEdits ${!enabled ? "enabled" : "disabled"}`
    );
  });
  context.subscriptions.push(toggleEnabledCommand);

  // Status bar item
  context.subscriptions.push(controller.getStatusBarItem());


  // Show consent form & Ask for participant name if not set.
  if (!controller.nameNonempty()) {
    showConsentUrl();
    const name = await askForName();
    const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
    await config.update(
      "participantName",
      name,
      vscode.ConfigurationTarget.Global
    );
    controller.updateConfig(load_config());
  }

  // Initial checkpoint update
  if (controller.effectivelyEnabled()) {
    for (let ws of workspace.workspaceFolders ?? []) {
      let wsPath = ws.uri.fsPath;
      let time = await timeit(async () => {
        const participantName = controller.getConfig().participantName!;
        return updateConcreteCheckpoints(wsPath, controller.getConfig(), participantName);
      });
      console.log(`[lean-edits] initial concrete checkpoint update in ${time}ms`);
    }
  }

  // On change events
  const changeHook = workspace.onDidChangeTextDocument(async (e) => {
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
    }
  });
  context.subscriptions.push(configHook);

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
}

export function deactivate(): void {

}
