// Source deployment through the MCP developer tools (deploy contract, section 2).

import fs from 'node:fs';
import path from 'node:path';

import { MANIFEST_FILE, buildSourceArchive, readProject } from './archive.js';
import { CliError, usageError } from './errors.js';
import { networkError, sleep } from './http.js';
import { ToolError } from './mcp.js';

export const TOOLS = Object.freeze({
  prepare: 'factory_deploy_prepare',
  complete: 'factory_deploy_complete',
  status: 'factory_status',
});

const RETRYABLE_COMPLETE_CODES = new Set([
  'AI_FACTORY_UPLOAD_NOT_RECEIVED',
  'AI_FACTORY_QUARANTINE_UNAVAILABLE',
]);
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

const IN_PROGRESS = new Set(['queued', 'pending', 'running', 'in_progress', 'started', 'building', 'verifying']);
const FAILED = new Set(['failed', 'rejected', 'error', 'cancelled', 'canceled', 'expired', 'refused']);

/**
 * Where a version stands: `in_progress` until the build and its verification
 * settle, then `ready` or `failed`. Review is reported but never waited for.
 */
export function phaseOf(status) {
  const build = status?.build?.status;
  const verification = status?.verification?.status;
  if (FAILED.has(build) || status?.build?.error) return 'failed';
  if (build !== 'succeeded') return 'in_progress';
  if (FAILED.has(verification) || status?.verification?.error) return 'failed';
  if (status?.previewUrl || status?.publishable) return 'ready';
  if (!verification || IN_PROGRESS.has(verification)) return 'in_progress';
  return 'ready';
}

export function failureOf(status) {
  if (status?.build?.error || FAILED.has(status?.build?.status)) {
    return { stage: 'build', ...(status.build.error || {}) };
  }
  if (status?.verification?.error || FAILED.has(status?.verification?.status)) {
    return { stage: 'verification', ...(status.verification.error || {}) };
  }
  return null;
}

/** Make sure the member sees the developer tools before doing any work. */
export async function requireTools(mcp, names) {
  const available = new Set((await mcp.listTools()).map((tool) => tool.name));
  const missing = names.filter((name) => !available.has(name));
  if (missing.length) {
    throw new CliError(
      'Les outils de déploiement ne sont pas disponibles pour ce Workspace.',
      {
        code: 'DEVELOPER_TOOLS_UNAVAILABLE',
        details: { missing },
        hint:
          'Il faut le droit « Publier des applications » et l\'interrupteur « Agents IA externes » ' +
          'activé (Paramètres > Intégrations). Vérifiez aussi le Workspace choisi lors de « zenextia login ».',
      },
    );
  }
}

export async function uploadSource(target, buffer, { retryDelayMs = 2000 } = {}) {
  if (!target?.url) {
    throw new CliError('Réponse de préparation invalide (cible d\'envoi absente).', {
      code: 'PREPARE_INVALID_RESPONSE',
    });
  }
  const method = (target.method || 'PUT').toUpperCase();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response;
    try {
      response = await fetch(target.url, {
        method,
        headers: target.headers || {},
        body: buffer,
        redirect: 'manual',
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt === 1) {
        await sleep(retryDelayMs);
        continue;
      }
      throw networkError(target.url, error);
    }
    await response.body?.cancel();
    if (response.ok) return;
    // Create-only target: a 412 on the retry means the first attempt landed;
    // factory_deploy_complete checks size and SHA-256 anyway.
    if (attempt === 2 && response.status === 412) return;
    if (attempt === 1 && response.status >= 500) {
      await sleep(retryDelayMs);
      continue;
    }
    throw new CliError(`Envoi de l'archive refusé par le stockage (HTTP ${response.status}).`, {
      code: 'SOURCE_UPLOAD_FAILED',
      hint: 'Relancez « zenextia deploy » : le lien d\'envoi est de courte durée.',
    });
  }
}

async function completeUpload(mcp, uploadId, { retryDelayMs, onRetry }) {
  try {
    return await mcp.callTool(TOOLS.complete, { uploadId });
  } catch (error) {
    if (!(error instanceof ToolError) || !(error.retryable || RETRYABLE_COMPLETE_CODES.has(error.code))) {
      throw error;
    }
    onRetry?.(error);
    await sleep(retryDelayMs);
    return mcp.callTool(TOOLS.complete, { uploadId });
  }
}

export async function pollStatus(mcp, { installationId, versionId }, options = {}) {
  const { pollIntervalMs = 3000, timeoutMs = 30 * 60 * 1000, onStatus, now = Date.now } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    const status = await mcp.callTool(TOOLS.status, { installationId, ...(versionId ? { versionId } : {}) });
    onStatus?.(status);
    const phase = phaseOf(status);
    if (phase !== 'in_progress') return { phase, status };
    if (now() >= deadline) return { phase: 'timeout', status };
    await sleep(pollIntervalMs);
  }
}

/**
 * Archive, prepare, upload, complete and (unless `wait` is false) follow the
 * build and its verification.
 */
export async function deploy({ dir, origin, store, mcp, wait = true, hooks = {}, ...options }) {
  const project = readProject(dir);
  const archive = buildSourceArchive(project.root, options.limits);
  hooks.onArchive?.(archive, project);

  await mcp.connect();
  await requireTools(mcp, Object.values(TOOLS));

  const prepared = await mcp.callTool(TOOLS.prepare, {
    manifest: project.manifest,
    sourceSha256: archive.sha256,
    sourceBytes: archive.bytes,
  });
  if (!prepared?.uploadId || !prepared?.installationId) {
    throw new CliError('Réponse de préparation invalide.', { code: 'PREPARE_INVALID_RESPONSE' });
  }
  hooks.onPrepared?.(prepared);

  await uploadSource(prepared.target, archive.buffer, options);
  hooks.onUploaded?.(prepared);

  const completed = await completeUpload(mcp, prepared.uploadId, {
    retryDelayMs: options.retryDelayMs ?? 2000,
    onRetry: hooks.onCompleteRetry,
  });
  hooks.onQueued?.(completed);

  const record = {
    installationId: prepared.installationId,
    versionId: prepared.versionId,
    version: project.manifest.version,
    uploadId: prepared.uploadId,
    buildId: completed?.buildId ?? null,
    sourceSha256: archive.sha256,
    deployedAt: new Date().toISOString(),
  };
  store.saveDeployment(origin, project.manifest.id, record);

  const summary = {
    applicationId: project.manifest.id,
    version: project.manifest.version,
    installationId: prepared.installationId,
    versionId: prepared.versionId,
    uploadId: prepared.uploadId,
    buildId: record.buildId,
    source: { sha256: archive.sha256, bytes: archive.bytes, entries: archive.entries.length },
  };
  if (!wait) return { ...summary, phase: 'queued', status: null };

  const { phase, status } = await pollStatus(
    mcp,
    { installationId: prepared.installationId, versionId: prepared.versionId },
    { ...options, onStatus: hooks.onStatus },
  );
  return { ...summary, phase, status };
}

/** Resolve the installation to query from a flag or the last deployment of a project. */
export function resolveInstallation({ dir, installationId, versionId, origin, store }) {
  if (installationId) return { installationId, versionId: versionId || undefined };
  const file = path.join(path.resolve(dir), MANIFEST_FILE);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    throw usageError(`Impossible de lire ${file}.`, {
      code: 'MANIFEST_INVALID',
      hint: 'Indiquez le dossier du projet ou --installation <id>.',
    });
  }
  const record = manifest?.id ? store.deployment(origin, manifest.id) : null;
  if (!record) {
    throw usageError(`Aucun déploiement connu de « ${manifest?.id ?? '?'} » sur ${origin} depuis ce poste.`, {
      code: 'DEPLOYMENT_UNKNOWN',
      hint: 'Lancez « zenextia deploy » ou passez --installation <id>.',
    });
  }
  return {
    installationId: record.installationId,
    versionId: versionId || record.versionId,
    applicationId: manifest.id,
  };
}
