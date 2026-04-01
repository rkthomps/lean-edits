
import { execSync } from "child_process";
import os from "os";
import path from "path";
import fs from "fs";
import https from "https";

import * as vscode from "vscode";

import assert from "assert";
import { extensionLog } from "./common";
import { getBaseCommit } from "./tracking";


const IGNORE_CHANGES = [
    "# Ignore the .changes directory used by Lean Vacuum to track changes",
    ".changes/"
].join(os.EOL);


function gitExists(): boolean {
    try {
        execSync("git --version", { stdio: "ignore" });
        return true;
    } catch (error) {
        return false;
    }
}

function getDefaultGlobalGitignorePath(): string {
    const homeDir = os.homedir();
    return path.join(homeDir, ".gitignore_global");
}


function getGlobalGitignorePath(): string | undefined {
    assert(gitExists(), "Git is not installed or not found in PATH");
    try {
        const result = execSync("git config --global core.excludesfile", {
            encoding: "utf-8",
        }).trim();
        if (result.length === 0) {
            return undefined;
        }
        return result;
    }
    catch (error) {
        return undefined;
    }
}


function gitIgnoreExists(gitignorePath: string): boolean {
    return fs.existsSync(gitignorePath);
}


function gitIgnoreHasChangesEntry(gitignorePath: string): boolean {
    const contents = fs.readFileSync(gitignorePath, "utf-8");
    const lines = contents.split("\n").map(line => line.trim());
    return lines.includes(".changes/");
}


async function askUserToAddChangesToGitignore(gitignorePath: string): Promise<boolean> {
    const selection = await vscode.window.showInformationMessage(
        `Add .changes/ to global .gitignore at ${gitignorePath}?`,
        "Add",
        "No"
    );
    if (selection === "Add") {
        return true;
    } else {
        return false;
    }
}


async function askUserToCreateAndAddChangesToGitignore(): Promise<boolean> {
    const selection = await vscode.window.showInformationMessage(
        `Create a global .gitignore file at ${getDefaultGlobalGitignorePath()} and add .changes/ to it?`,
        "Create and Add",
        "No"
    );
    if (selection === "Create and Add") {
        return true;
    } else {
        return false;
    }
}


/**
 * Parses a GitHub remote URL (HTTPS or SSH) and returns "owner/repo",
 * or undefined if the URL is not a GitHub URL.
 */
function parseGitHubOwnerRepo(remoteUrl: string): string | undefined {
    const httpsMatch = remoteUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (httpsMatch) { return httpsMatch[1]; }
    const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch) { return sshMatch[1]; }
    return undefined;
}


function checkGitHubRepoPublic(ownerRepo: string): Promise<boolean> {
    return new Promise((resolve) => {
        const req = https.request({
            hostname: "api.github.com",
            path: `/repos/${ownerRepo}`,
            method: "GET",
            headers: { "User-Agent": "lean-edits-vscode" },
        }, (res) => {
            resolve(res.statusCode === 200);
            res.resume();
        });
        req.on("error", () => resolve(false));
        req.setTimeout(5000, () => { req.destroy(); resolve(false); });
        req.end();
    });
}


/**
 * Checks whether the origin remote of the given workspace is a public GitHub repo.
 * Returns false if there is no git repo, no origin remote, the remote is not GitHub,
 * or the repo is private/unreachable.
 */
export async function isOriginPublic(wsPath: string): Promise<boolean> {
    const [baseCommit] = getBaseCommit(wsPath, "foo-bar");
    if (baseCommit.type !== "git") { return false; }
    const origin = baseCommit.remotes.find(r => r.name === "origin");
    if (!origin) { return false; }
    const remoteUrl = origin.fetchUrl ?? origin.pushUrl;
    if (!remoteUrl) { return false; }
    const ownerRepo = parseGitHubOwnerRepo(remoteUrl);
    if (!ownerRepo) { return false; }
    return checkGitHubRepoPublic(ownerRepo);
}


/**
 * Add .changes to the global gitignore
 */
export async function ignoreChanges(): Promise<void> {
    const currentGitignore = getGlobalGitignorePath();
    if (currentGitignore !== undefined) {
        if (gitIgnoreExists(currentGitignore) && gitIgnoreHasChangesEntry(currentGitignore)) {
            extensionLog(`.changes already in global gitignore at ${currentGitignore}`);
            return;
        } else {
            const add = await askUserToAddChangesToGitignore(currentGitignore);
            if (add) {
                await fs.promises.appendFile(currentGitignore, os.EOL + IGNORE_CHANGES + os.EOL, "utf-8");
                extensionLog(`Added .changes to global gitignore at ${currentGitignore}`);
            }
        }
    } else {
        const createAndAdd = await askUserToCreateAndAddChangesToGitignore();
        if (createAndAdd) {
            const defaultPath = getDefaultGlobalGitignorePath();
            await fs.promises.appendFile(defaultPath, os.EOL + IGNORE_CHANGES + os.EOL, "utf-8");
            execSync(`git config --global core.excludesfile ${defaultPath}`);
            extensionLog(`Created global gitignore at ${defaultPath} and added .changes to it`);
        }
    }
}