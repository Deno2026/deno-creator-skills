"use strict";

const { getSocialPublishingRuntimePaths, getUploadRuntimePaths, resolveUploadRuntimeRootDefault } = require("@deno/runtime-paths");
const { path, readJson, fail } = require("./common.cjs");
const { normalizeSettings } = require("./publish_manifest.cjs");
const PRODUCTION_ROOT = path.resolve(__dirname, "../../../..");
async function context(env = process.env) {
  const childEnv = { ...env, DENO_PRODUCTION_ROOT: PRODUCTION_ROOT, DENO_UPLOAD_HELPER_RUNTIME_ROOT: resolveUploadRuntimeRootDefault({ env, cwd: PRODUCTION_ROOT }) };
  const runtime = getSocialPublishingRuntimePaths({ env: childEnv });
  childEnv.DENO_SOCIAL_PUBLISHING_RUNTIME_ROOT = runtime.runtimeRoot;
  return { runtime, uploadRuntime: getUploadRuntimePaths({ env: childEnv }), settings: normalizeSettings((await readJson(runtime.settingsPath, true)) ?? {}, { env: childEnv }), env: childEnv, productionRoot: PRODUCTION_ROOT };
}
async function instagramSettings(runtime, socialSettings) {
  const value = await readJson(runtime.instagramSettingsPath, true);
  if (!value || !/^\d+$/.test(String(value.igUserId)) || typeof value.username !== "string" || !value.username) throw fail("INSTAGRAM_SETTINGS_INVALID");
  return { ...value, apiVersion: socialSettings.instagram.apiVersion };
}
async function threadsSettings(runtime) {
  const value = await readJson(runtime.threadsSettingsPath, true);
  if (!value || !/^\d+$/.test(String(value.threadsUserId)) || !value.username) throw fail("THREADS_SETTINGS_INVALID");
  return value;
}
async function xSettings(runtime) {
  const value = await readJson(runtime.xSettingsPath, true);
  if (!value?.clientId) throw fail("X_SETTINGS_INVALID");
  return value;
}
module.exports = { context, instagramSettings, threadsSettings, xSettings, PRODUCTION_ROOT };
