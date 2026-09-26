/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const dotenv = require("dotenv");

let mainWindow = null;
let serverProcess = null;
let serverUrl = null;

function installStableUserDataPath() {
  const stableUserDataPath = path.join(app.getPath("appData"), "youtube-uploader");
  app.setPath("userData", stableUserDataPath);
}

installStableUserDataPath();

function isInternalAppUrl(targetUrl) {
  if (!serverUrl) {
    return false;
  }

  try {
    const parsedTarget = new URL(targetUrl);
    const parsedServer = new URL(serverUrl);

    return (
      parsedTarget.protocol === parsedServer.protocol &&
      parsedTarget.hostname === parsedServer.hostname &&
      parsedTarget.port === parsedServer.port
    );
  } catch {
    return false;
  }
}

function navigateHome() {
  if (!mainWindow || mainWindow.isDestroyed() || !serverUrl) {
    return;
  }

  void mainWindow.loadURL(serverUrl);
}

function goBackOrHome() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.webContents.canGoBack()) {
    mainWindow.webContents.goBack();
    return;
  }

  navigateHome();
}

function goForward() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.webContents.canGoForward()) {
    mainWindow.webContents.goForward();
  }
}

function refreshCurrentPage() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.reload();
}

function installAppMenu() {
  const template = [
    {
      label: "Deno YouTube Upload Helper",
      submenu: [
        {
          label: "처음 화면",
          accelerator: "Ctrl+Shift+H",
          click: navigateHome,
        },
        { type: "separator" },
        {
          label: "종료",
          accelerator: "Alt+F4",
          role: "quit",
        },
      ],
    },
    {
      label: "이동",
      submenu: [
        {
          label: "뒤로가기",
          accelerator: "Alt+Left",
          click: goBackOrHome,
        },
        {
          label: "앞으로가기",
          accelerator: "Alt+Right",
          click: goForward,
        },
        {
          label: "새로고침",
          accelerator: "Ctrl+R",
          click: refreshCurrentPage,
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();

    tester.once("error", () => resolve(false));
    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, "127.0.0.1");
  });
}

async function waitForUrl(url, timeoutMs = 120000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function loadEnvFile() {
  const candidate = process.env.DENO_UPLOAD_HELPER_ENV_FILE?.trim();
  if (!candidate) return;
  if (!path.isAbsolute(candidate)) {
    throw new Error("DENO_UPLOAD_HELPER_ENV_FILE must be an absolute path.");
  }
  dotenv.config({ path: candidate, override: false });
}

function loadSavedDesktopSettings() {
  try {
    const settingsPath = path.join(resolveUploadRuntimeRoot(), "youtube-settings.json");

    if (!fs.existsSync(settingsPath)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return null;
  }
}

function resolveUploadRuntimeRoot() {
  const explicit = process.env.DENO_UPLOAD_HELPER_RUNTIME_ROOT?.trim();
  if (explicit) {
    if (!path.isAbsolute(explicit)) {
      throw new Error("DENO_UPLOAD_HELPER_RUNTIME_ROOT must be an absolute path.");
    }
    return path.resolve(explicit);
  }
  return path.join(app.getPath("userData"), "runtime");
}

function resolveConfiguredRedirectUri() {
  const settings = loadSavedDesktopSettings();
  const configuredRedirectUri =
    settings?.redirectUri ||
    process.env.GOOGLE_REDIRECT_URI ||
    "http://localhost:3000/api/oauth/callback";

  try {
    return new URL(configuredRedirectUri);
  } catch {
    return new URL("http://localhost:3000/api/oauth/callback");
  }
}

async function ensureServerUrl() {
  if (serverUrl) {
    return serverUrl;
  }

  if (!app.isPackaged && process.env.APP_URL) {
    serverUrl = process.env.APP_URL;
    return serverUrl;
  }

  const appPath = app.getAppPath();
  loadEnvFile();

  const redirectUrl = resolveConfiguredRedirectUri();
  const configuredPort = Number(redirectUrl.port || 3000);
  const portAvailable = await checkPortAvailable(configuredPort);

  if (!portAvailable) {
    throw new Error(
      `OAuth callback port ${configuredPort} is already in use. Close the app or process using localhost:${configuredPort} and try again.`,
    );
  }

  const builtAppRoot = appPath;
  const serverScript = path.join(appPath, "electron", "next-server.cjs");
  const hasBuildOutput = fs.existsSync(
    path.join(builtAppRoot, "desktop-bundle", "server-entry.json"),
  );

  if (!fs.existsSync(serverScript)) {
    throw new Error("Bundled desktop Next server launcher not found.");
  }

  serverProcess = spawn(process.execPath, [serverScript], {
    cwd: builtAppRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(configuredPort),
      HOSTNAME: "127.0.0.1",
      NODE_ENV: hasBuildOutput ? "production" : "development",
      NEXT_TELEMETRY_DISABLED: "1",
      DENO_UPLOAD_HELPER_RUNTIME_ROOT: resolveUploadRuntimeRoot(),
      STUDIO_UPLOADER_APP_ROOT: builtAppRoot,
      STUDIO_UPLOADER_FORCE_DEV: hasBuildOutput ? "0" : "1",
    },
    stdio: "ignore",
    windowsHide: true,
  });

  serverUrl = `http://127.0.0.1:${configuredPort}`;
  await waitForUrl(serverUrl);
  return serverUrl;
}

async function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    title: "Deno YouTube Upload Helper",
    backgroundColor: "#f3f4f6",
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isInternalAppUrl(url)) {
      return;
    }

    event.preventDefault();
    void shell.openExternal(url);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalAppUrl(url)) {
      return { action: "allow" };
    }

    shell.openExternal(url);
    return { action: "deny" };
  });

  const url = await ensureServerUrl();
  await mainWindow.loadURL(url);
  mainWindow.maximize();
  mainWindow.show();
}

app.whenReady().then(async () => {
  try {
    installAppMenu();
    await createWindow();
  } catch (error) {
    dialog.showErrorBox(
      "Deno YouTube Upload Helper start failed",
      error instanceof Error ? error.message : "Unknown startup error",
    );
    app.quit();
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
});
