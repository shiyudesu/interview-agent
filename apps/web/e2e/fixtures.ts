import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { test as base, expect } from "@playwright/test";

const WINDOWS_CHROME_PATH = "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe";
const execFileAsync = promisify(execFile);

export const test = base.extend({
  browser: [
    async ({ playwright }, use) => {
      if (process.env["CI"]) {
        const executablePath = process.env["PLAYWRIGHT_CHROME_PATH"]?.trim();
        const browser = await playwright.chromium.launch(
          executablePath ? { executablePath } : { channel: "chrome" },
        );
        try {
          await use(browser);
        } finally {
          await browser.close();
        }
        return;
      }

      const port = await availablePort();
      const windowsTempDirectory = await resolveWindowsTempDirectory();
      const userDataDirectory = await mkdtemp(
        join(windowsTempDirectory, "interview-agent-playwright-"),
      );
      const chromeProcess = startWindowsChrome(port, userDataDirectory);
      try {
        await waitForChrome(port, chromeProcess);
        const browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        try {
          await use(browser);
        } finally {
          await browser.close().catch(() => undefined);
        }
      } finally {
        await stopWindowsChrome(userDataDirectory);
        await stopProcess(chromeProcess);
        await removeUserDataDirectory(userDataDirectory);
      }
    },
    { scope: "worker" },
  ],
});

export { expect };

function startWindowsChrome(port: number, userDataDirectory: string): ChildProcess {
  const chrome = spawn(
    process.env["PLAYWRIGHT_CHROME_PATH"]?.trim() || WINDOWS_CHROME_PATH,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
      `--user-data-dir=${toWindowsPath(userDataDirectory)}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  chrome.stdout?.resume();
  chrome.stderr?.resume();
  return chrome;
}

async function waitForChrome(port: number, chromeProcess: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (chromeProcess.exitCode !== null) {
      throw new Error(`Windows Chrome exited before CDP became ready (${chromeProcess.exitCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        return;
      }
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Windows Chrome CDP endpoint did not become ready");
}

async function availablePort(): Promise<number> {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-Command",
    "$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0); $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop(); $port",
  ]);
  const port = Number.parseInt(stdout.trim(), 10);
  if (!Number.isInteger(port) || port < 1) {
    throw new Error("Could not allocate a Windows Chrome debugging port");
  }
  return port;
}

async function stopProcess(chromeProcess: ChildProcess): Promise<void> {
  if (chromeProcess.exitCode !== null) {
    return;
  }
  chromeProcess.kill();
  await Promise.race([
    new Promise<void>((resolve) => chromeProcess.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (chromeProcess.exitCode === null) {
    chromeProcess.kill("SIGKILL");
    await Promise.race([
      new Promise<void>((resolve) => chromeProcess.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

async function stopWindowsChrome(userDataDirectory: string): Promise<void> {
  const windowsDirectory = toWindowsPath(userDataDirectory).replaceAll("'", "''");
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `$chrome = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*${windowsDirectory}*' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1; if ($null -eq $chrome) { exit 0 }; Stop-Process -Id $chrome.ProcessId -Force -ErrorAction Stop`,
  ]);
}

async function resolveWindowsTempDirectory(): Promise<string> {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-Command",
    "[System.IO.Path]::GetTempPath()",
  ]);
  const match = /^([a-z]):\\(.*)$/iu.exec(stdout.trim());
  if (match === null) {
    throw new Error("Could not resolve the mounted Windows temporary directory");
  }
  return `/mnt/${match[1]?.toLowerCase()}/${match[2]?.replaceAll("\\", "/").replace(/\/+$/u, "")}`;
}

async function removeUserDataDirectory(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error.code !== "EACCES" && error.code !== "EPERM")
      ) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Windows Chrome user-data directory remained locked after shutdown");
}

function toWindowsPath(path: string): string {
  const match = /^\/mnt\/([a-z])\/(.*)$/iu.exec(path);
  if (match === null) {
    throw new Error("Windows Chrome user-data directory must be on a mounted Windows drive");
  }
  return `${match[1]?.toUpperCase()}:\\${match[2]?.replaceAll("/", "\\")}`;
}
