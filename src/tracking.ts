import fs = require("fs");
import path = require("path");
import os = require("os");
import { LeanEditsConfig } from "./config";

import { Edit, NewContentConcreteCheckpoint } from "./types";

import {
  extensions,
  workspace,
  TextDocument,
  TextDocumentChangeEvent,
} from "vscode";

// import type { Repository, GitExtension } from 'vscode.git';


export const CHANGES_NAME = ".changes";
export const CONCRETE_NAME = "concrete-history"; // ASSUMPTION: A file being edited must first exist on disk.
export const EDITS_NAME = "edits-history";


interface Remote {
  name: string;
  fetchUrl: string | null;
  pushUrl: string | null;
}

interface LocalState {
  type: "local";
  hostname: string;
  osUsername: string;
  workspaceName: string;
  consentName: string;
}

interface GitState {
  type: "git";
  hostname: string;
  osUsername: string;
  workspaceName: string;
  head: string;
  lastTag: string | null;
  remotes: Remote[];
  consentName: string;
}


type BaseCommit = GitState | LocalState;

function isSubpath(p1: string, p2: string) {
  const relpath = path.relative(p1, p2);
  return relpath && !relpath.startsWith("..") && !path.isAbsolute(relpath);
}

export function getLocalState(wsPath: string, consentName: string): LocalState {
  const workspaceName = path.basename(wsPath);
  return {
    type: "local",
    hostname: os.hostname(),
    osUsername: os.userInfo().username,
    workspaceName: workspaceName,
    consentName: consentName,
  };
}

function workingTreeFiles(wsPath: string, repo: any): string[] {
  return repo.state.workingTreeChanges.map((change: any) => {
    return change.uri.fsPath;
  });
}

export function getBaseCommit(wsPath: string, consentName: string): [BaseCommit, string[] | null] {
  // console.log(`[lean-edits] getting git extension for workspace: ${wsPath}`);
  const gitExtension = extensions.getExtension("vscode.git")?.exports;
  const localState = getLocalState(wsPath, consentName);
  if (!gitExtension) {
    return [localState, null];
  }

  const api = gitExtension.getAPI(1);
  const repos = api.repositories;
  if (repos.length === 0) {
    return [localState, null];
  }

  const repo = repos.find((r: any) => wsPath.startsWith(r.rootUri.fsPath));
  if (!repo) {
    return [localState, null];
  }

  const remotes = repo.state.remotes.map((r: any) => ({
    name: r.name,
    fetchUrl: r.fetchUrl ?? null,
    pushUrl: r.pushUrl ?? null,
  }));

  // const remote = repo.state.remotes[0]?.fetchUrl || "";
  const commit = repo.state.HEAD?.commit || "";

  const baseCommit: GitState = {
    type: "git",
    hostname: localState.hostname,
    osUsername: localState.osUsername,
    workspaceName: localState.workspaceName,
    head: commit,
    lastTag: null, /* TODO: For now, not shelling out to git to get the last tag */
    remotes: remotes,
    consentName: localState.consentName,
  };

  const modifiedFiles = workingTreeFiles(wsPath, repo);

  return [baseCommit, modifiedFiles];

}




/**
 * Defines whether a directory is essential for tracking.
 */
function isEssentialDir(dir: string, config: LeanEditsConfig): boolean {
  const notLakeDir = !dir.endsWith(".lake");
  const notGitDir = !dir.endsWith(".git");
  const notChangesDir = !dir.endsWith(CHANGES_NAME);
  return notLakeDir && notGitDir && notChangesDir;
}

/**
 * Defines whether a file is essential for tracking.
 */
function isEssentialFile(file: string, config: LeanEditsConfig): boolean {
  const isLakeFileLean = path.basename(file) === "lakefile.lean";
  const isLakeFileToml = path.basename(file) === "lakefile.toml";
  const isLeanToolChain = path.basename(file) === "lean-toolchain";
  const isLeanSrc = file.endsWith(".lean");
  return isLakeFileLean || isLakeFileToml || isLeanToolChain || isLeanSrc;
}


/**
 * Recursively finds all essential files in a directory. 
 */
function findEssentialFiles(
  root: string,
  fileFilter: (file: string) => boolean,
  dirFilter: (dir: string) => boolean
): string[] {
  const rootStat = fs.lstatSync(root);
  if (rootStat.isDirectory()) {
    if (!dirFilter(root)) {
      return [];
    } else {
      let localChildren = fs
        .readdirSync(root)
        .map((c) => path.join(root, c))
        .sort();
      let allChildren: string[] = [];
      for (let child of localChildren) {
        allChildren = allChildren.concat(
          findEssentialFiles(child, fileFilter, dirFilter)
        );
      }
      return allChildren;
    }
  } else {
    if (fileFilter(root)) {
      return [root];
    } else {
      return [];
    }
  }
}



/**
 * 
 * @returns The workspace in which this document resides. Returns undefined  
 * if no workspace can be found.
 */
export function getWorkspacePath(d: TextDocument): string | undefined {
  let wsFolders = workspace.workspaceFolders;
  if (wsFolders === undefined || wsFolders.length === 0) {
    console.warn("No workspace folders open. Will not save changes.");
    return undefined;
  }

  let candidates = [];
  const docPath = d.uri.fsPath;
  for (let folder of wsFolders) {
    if (isSubpath(folder.uri.fsPath, docPath)) {
      if (!path.isAbsolute(folder.uri.fsPath)) {
        throw new Error(`Workspace folder path ${folder.uri.fsPath} is not absolute`);
      }
      candidates.push(folder.uri.fsPath);
    }
  }

  if (candidates.length === 0) {
    console.warn("No workspace folder is an ancestor of document " + d.uri.fsPath);
    return undefined;
  }

  // Pick the longest path
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}


export interface TrackedFileResult {
  files: string[];
  baseCommit: BaseCommit;
}


/**
 * Get the tracked files in a workspace. 
 * This includes the following files:
 * - If there is no .git history, all of the files of interest in the workspace. 
 * - If there is a .git history, the intersection of the files of interest and 
 *   the files **modified** since the last commit. 
 * 
 * - TODO: The last commit could be the base commit.
 */
export function getTrackedFiles(
  wsPath: string,
  config: LeanEditsConfig,
  consentName: string
): TrackedFileResult {
  const [baseCommit, modifiedFiles] = getBaseCommit(wsPath, consentName);

  let filesToTrack: string[] = [];
  if (modifiedFiles !== null) {
    filesToTrack = modifiedFiles.filter((f) => isEssentialFile(f, config));
    console.log(`[lean-edits] tracked files in workspace: ${wsPath}: ${filesToTrack.length}`);
    return {
      files: filesToTrack,
      baseCommit,
    };
  } else {
    const allFiles = findEssentialFiles(
      wsPath,
      (f) => isEssentialFile(f, config),
      (d) => isEssentialDir(d, config)
    );

    return {
      files: allFiles,
      baseCommit,
    };
  }
}

function getCommitName(baseCommit: BaseCommit): string {
  if ("head" in baseCommit) {
    return baseCommit.head;
  } else {
    return "no-git";
  }
}

export function getChangesDir(wsPath: string, baseCommit: BaseCommit): string {
  const commitName = getCommitName(baseCommit);
  return path.join(wsPath, CHANGES_NAME, commitName);
}

function getMetadataLoc(wsPath: string, baseCommit: BaseCommit): string {
  const changesDir = getChangesDir(wsPath, baseCommit);
  return path.join(changesDir, "metadata.json");
}


function getEditsDir(wsPath: string, baseCommit: BaseCommit, filePath: string): string {
  const commitName = getCommitName(baseCommit);
  const fileRelPath = path.relative(wsPath, filePath);
  return path.join(wsPath, CHANGES_NAME, commitName, fileRelPath, EDITS_NAME);
}

/**
 * Returns the location of the given file's concrete checkpoint directory.
 */
function getConcreteCheckpointDir(wsPath: string, baseCommit: BaseCommit, filePath: string): string {
  const commitName = getCommitName(baseCommit);
  const fileRelPath = path.relative(wsPath, filePath);
  return path.join(wsPath, CHANGES_NAME, commitName, fileRelPath, CONCRETE_NAME);
}


/**
 * Updates the concrete checkpoint for a given file in the workspace. 
 * Simply checks if the file has been modified since the last checkpoint
 * was saved.
 * @param wsPath : The workspace path e.g. /work
 * @param filePath : The file path to update e.g. /work/file
 * @param config 
 * @param baseCommit 
 * @returns 
 */
function updateConcreteCheckpoint(
  wsPath: string,
  filePath: string,
  config: LeanEditsConfig,
  baseCommit: BaseCommit,
): void {
  const fileStat = fs.lstatSync(filePath);
  const concreteDir = getConcreteCheckpointDir(wsPath, baseCommit, filePath);

  if (fs.existsSync(concreteDir)) {
    const changeStat = fs.lstatSync(concreteDir);
    if (fileStat.mtime < changeStat.mtime) {
      // No update needed
      return;
    }
  }

  const newCheckpoint = NewContentConcreteCheckpoint.fromLeanFile(filePath);
  const checkpointSavePath = path.join(
    concreteDir,
    fileStat.mtime.getTime().toString()
  );
  newCheckpoint.save(checkpointSavePath);
}


function saveMetadata(wsPath: string, metadata: BaseCommit): void {
  const metadataDir = getMetadataLoc(wsPath, metadata);
  const parentDir = path.dirname(metadataDir);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
  fs.writeFileSync(metadataDir, JSON.stringify(metadata));
}

/**
 * Updates the concrete checkpoints for all tracked files in the workspace.
 * This ensures that we can reproduce the state of the workspace when we  
 * want to replay an edit.
 */
export function updateConcreteCheckpoints(
  wsPath: string,
  config: LeanEditsConfig,
  consentName: string
): void {
  console.log(`[lean-edits] updating concrete checkpoints for workspace: ${wsPath}`);
  const { files, baseCommit } = getTrackedFiles(wsPath, config, consentName);
  for (const filePath of files) {
    updateConcreteCheckpoint(wsPath, filePath, config, baseCommit);
  }
  saveMetadata(wsPath, baseCommit);
}



/**
 * Logs a text document change to disk synchronously. 
 * Updates the concrete checkpoint for document associated with the change. 
 */
export function logChange(
  change: TextDocumentChangeEvent,
  config: LeanEditsConfig,
  consentName: string
): void {
  const wsPath = getWorkspacePath(change.document);
  if (wsPath === undefined) {
    return;
  }

  const filePath = change.document.uri.fsPath;
  const [baseCommit, _] = getBaseCommit(wsPath, consentName);

  updateConcreteCheckpoint(wsPath, filePath, config, baseCommit);
  const time = new Date();
  const newEdit = Edit.fromChange(change, time);
  const editsDir = getEditsDir(wsPath, baseCommit, filePath);
  const saveLoc = path.join(editsDir, time.getTime().toString());
  newEdit.save(saveLoc);
}

