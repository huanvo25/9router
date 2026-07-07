"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

// Get claude settings path based on OS
const getClaudeSettingsPath = () => {
  const homeDir = os.homedir();
  return path.join(homeDir, ".claude", "settings.json");
};

const getClaudeGatewayModelsPath = () => {
  const homeDir = os.homedir();
  return path.join(homeDir, ".claude", "cache", "gateway-models.json");
};

const normalizeClaudeCodeBaseUrl = (value) => {
  return String(value || "").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
};

const normalizeModelList = (models) => {
  return [
    ...new Set(
      (Array.isArray(models) ? models : [])
        .map((model) => String(model || "").trim())
        .filter(Boolean)
    ),
  ];
};

const writeClaudeGatewayModelCache = async (baseUrl, models) => {
  const normalizedBaseUrl = normalizeClaudeCodeBaseUrl(baseUrl);
  const normalizedModels = normalizeModelList(models);
  if (!normalizedBaseUrl || normalizedModels.length === 0) return;

  const cachePath = getClaudeGatewayModelsPath();
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify({
    baseUrl: normalizedBaseUrl,
    fetchedAt: Date.now(),
    models: normalizedModels.map((id) => ({ id })),
  }, null, 2));
};

const removeClaudeGatewayModelCache = async (baseUrl) => {
  const normalizedBaseUrl = normalizeClaudeCodeBaseUrl(baseUrl);
  const cachePath = getClaudeGatewayModelsPath();
  try {
    const cache = JSON.parse(await fs.readFile(cachePath, "utf-8"));
    const cacheBaseUrl = normalizeClaudeCodeBaseUrl(cache?.baseUrl);
    if (!normalizedBaseUrl || cacheBaseUrl === normalizedBaseUrl) {
      await fs.unlink(cachePath);
    }
  } catch {
    // Cache cleanup is best effort; settings reset should still succeed.
  }
};

const getClaudeCodeEditorSettingsPaths = () => {
  const homeDir = os.homedir();
  if (os.platform() === "darwin") {
    return [
      path.join(homeDir, "Library", "Application Support", "Code", "User", "settings.json"),
      path.join(homeDir, "Library", "Application Support", "Code - Insiders", "User", "settings.json"),
      path.join(homeDir, "Library", "Application Support", "Cursor", "User", "settings.json"),
      path.join(homeDir, "Library", "Application Support", "Trae", "User", "settings.json"),
    ];
  }
  if (os.platform() === "win32") {
    const appData = process.env.APPDATA || path.join(homeDir, "AppData", "Roaming");
    return [
      path.join(appData, "Code", "User", "settings.json"),
      path.join(appData, "Code - Insiders", "User", "settings.json"),
      path.join(appData, "Cursor", "User", "settings.json"),
      path.join(appData, "Trae", "User", "settings.json"),
    ];
  }
  return [
    path.join(homeDir, ".config", "Code", "User", "settings.json"),
    path.join(homeDir, ".config", "Code - Insiders", "User", "settings.json"),
    path.join(homeDir, ".config", "Cursor", "User", "settings.json"),
    path.join(homeDir, ".config", "Trae", "User", "settings.json"),
  ];
};

const updateEnvArray = (current, env) => {
  const values = new Map(
    Array.isArray(current)
      ? current
        .filter((item) => item && typeof item.name === "string")
        .map((item) => [item.name, item.value == null ? "" : String(item.value)])
      : []
  );
  Object.entries(env).forEach(([name, value]) => {
    values.set(name, value == null ? "" : String(value));
  });
  return Array.from(values, ([name, value]) => ({ name, value }));
};

const removeEnvKeys = (current, keys) => {
  if (!Array.isArray(current)) return current;
  const keySet = new Set(keys);
  return current.filter((item) => !keySet.has(item?.name));
};

const syncClaudeCodeEditorSettings = async (env) => {
  await Promise.all(getClaudeCodeEditorSettingsPaths().map(async (settingsPath) => {
    let settings;
    try {
      settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    } catch {
      return;
    }

    settings["claudeCode.environmentVariables"] = updateEnvArray(
      settings["claudeCode.environmentVariables"],
      env
    );
    settings.claudeCode = settings.claudeCode || {};
    settings.claudeCode.environmentVariables = updateEnvArray(
      settings.claudeCode.environmentVariables,
      env
    );
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  }));
};

const resetClaudeCodeEditorSettings = async () => {
  await Promise.all(getClaudeCodeEditorSettingsPaths().map(async (settingsPath) => {
    let settings;
    try {
      settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    } catch {
      return;
    }

    settings["claudeCode.environmentVariables"] = removeEnvKeys(
      settings["claudeCode.environmentVariables"],
      RESET_ENV_KEYS
    );
    if (settings.claudeCode) {
      settings.claudeCode.environmentVariables = removeEnvKeys(
        settings.claudeCode.environmentVariables,
        RESET_ENV_KEYS
      );
    }
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  }));
};


// Check if claude CLI is installed (via which/where or config file exists)
const checkClaudeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where claude" : "which claude";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getClaudeSettingsPath());
      return true;
    } catch {
      return false;
    }
  }
};

// Read current settings
const readSettings = async () => {
  try {
    const settingsPath = getClaudeSettingsPath();
    const content = await fs.readFile(settingsPath, "utf-8");
    // Tolerate JSONC (trailing commas) and treat unparseable files as "no config"
    // rather than throwing a 500 that the UI misreads as "tool not installed".
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    return null;
  }
};

// GET - Check claude CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkClaudeInstalled();
    
    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Claude CLI is not installed",
      });
    }

    const settings = await readSettings();
    const has9Router = !!(settings?.env?.ANTHROPIC_BASE_URL);

    return NextResponse.json({
      installed: true,
      settings: settings,
      has9Router: has9Router,
      settingsPath: getClaudeSettingsPath(),
    });
  } catch (error) {
    console.log("Error checking claude settings:", error);
    return NextResponse.json(
      { error: "Failed to check claude settings" },
      { status: 500 }
    );
  }
}

// POST - Backup old fields and write new settings
export async function POST(request) {
  try {
    const { env, availableModels, enforceAvailableModels, modelOverrides, model } = await request.json();
    
    if (!env || typeof env !== "object") {
      return NextResponse.json(
        { error: "Invalid env object" },
        { status: 400 }
      );
    }
    if (availableModels !== undefined && (!Array.isArray(availableModels) || availableModels.some((m) => typeof m !== "string"))) {
      return NextResponse.json(
        { error: "Invalid availableModels array" },
        { status: 400 }
      );
    }
    if (modelOverrides !== undefined && (!modelOverrides || typeof modelOverrides !== "object" || Array.isArray(modelOverrides))) {
      return NextResponse.json(
        { error: "Invalid modelOverrides object" },
        { status: 400 }
      );
    }
    if (model !== undefined && typeof model !== "string") {
      return NextResponse.json(
        { error: "Invalid model value" },
        { status: 400 }
      );
    }

    const settingsPath = getClaudeSettingsPath();
    const claudeDir = path.dirname(settingsPath);

    // Ensure .claude directory exists
    await fs.mkdir(claudeDir, { recursive: true });

    // Read current settings
    let currentSettings = {};
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      currentSettings = JSON.parse(content);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    const normalizedAvailableModels = availableModels !== undefined
      ? normalizeModelList(availableModels)
      : undefined;

    // Claude Code appends its own Anthropic API paths, so keep the configured
    // endpoint at the host root even if a generic OpenAI-style URL is selected.
    if (env.ANTHROPIC_BASE_URL) {
      env.ANTHROPIC_BASE_URL = normalizeClaudeCodeBaseUrl(env.ANTHROPIC_BASE_URL);
    }
    if ((normalizedAvailableModels || currentSettings.availableModels || []).length > 0) {
      env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY || "1";
    }

    // Merge new env with existing settings
    const newSettings = {
      ...currentSettings,
      hasCompletedOnboarding: true,
      env: {
        ...(currentSettings.env || {}),
        ...env,
      },
    };
    if (availableModels !== undefined) {
      newSettings.availableModels = normalizedAvailableModels;
    }
    if (enforceAvailableModels !== undefined) {
      newSettings.enforceAvailableModels = !!enforceAvailableModels;
    }
    if (modelOverrides !== undefined) {
      newSettings.modelOverrides = modelOverrides;
    }
    if (model !== undefined) {
      newSettings.model = model;
    }

    // Write new settings
    await fs.writeFile(settingsPath, JSON.stringify(newSettings, null, 2));
    await writeClaudeGatewayModelCache(
      newSettings.env?.ANTHROPIC_BASE_URL,
      normalizedAvailableModels || newSettings.availableModels
    );
    await syncClaudeCodeEditorSettings(newSettings.env);

    return NextResponse.json({
      success: true,
      message: "Settings updated successfully",
    });
  } catch (error) {
    console.log("Error updating claude settings:", error);
    return NextResponse.json(
      { error: "Failed to update claude settings" },
      { status: 500 }
    );
  }
}

// Fields to remove when resetting
const RESET_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTIONS",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "API_TIMEOUT_MS",
];

const RESET_TOP_LEVEL_KEYS = [
  "availableModels",
  "enforceAvailableModels",
  "modelOverrides",
  "model",
];

// DELETE - Reset settings (remove env fields)
export async function DELETE() {
  try {
    const settingsPath = getClaudeSettingsPath();

    // Read current settings
    let currentSettings = {};
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      currentSettings = JSON.parse(content);
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({
          success: true,
          message: "No settings file to reset",
        });
      }
      throw error;
    }

    const previousBaseUrl = currentSettings.env?.ANTHROPIC_BASE_URL;

    // Remove specified env fields
    if (currentSettings.env) {
      RESET_ENV_KEYS.forEach((key) => {
        delete currentSettings.env[key];
      });
      
      // Clean up empty env object
      if (Object.keys(currentSettings.env).length === 0) {
        delete currentSettings.env;
      }
    }
    RESET_TOP_LEVEL_KEYS.forEach((key) => {
      delete currentSettings[key];
    });

    // Write updated settings
    await fs.writeFile(settingsPath, JSON.stringify(currentSettings, null, 2));
    await removeClaudeGatewayModelCache(previousBaseUrl);
    await resetClaudeCodeEditorSettings();

    return NextResponse.json({
      success: true,
      message: "Settings reset successfully",
    });
  } catch (error) {
    console.log("Error resetting claude settings:", error);
    return NextResponse.json(
      { error: "Failed to reset claude settings" },
      { status: 500 }
    );
  }
}
