// Terminal output. Human messages are French; `--json` prints exactly one
// JSON document on stdout and keeps progress off it.

const LABELS = {
  queued: "en file d'attente",
  pending: 'en attente',
  running: 'en cours',
  in_progress: 'en cours',
  started: 'en cours',
  building: 'en cours',
  verifying: 'en cours',
  succeeded: 'réussie',
  passed: 'réussie',
  verified: 'réussie',
  failed: 'échouée',
  rejected: 'refusée',
  refused: 'refusée',
  error: 'en erreur',
  approved: 'approuvée',
  cancelled: 'annulée',
  canceled: 'annulée',
  expired: 'expirée',
};

export function label(status) {
  if (!status) return 'en attente';
  return LABELS[status] || status;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} Kio`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} Mio`;
}

function formatElapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} min ${String(seconds % 60).padStart(2, '0')} s` : `${seconds} s`;
}

export function createUi({ stdout, stderr, json = false, now = Date.now }) {
  const tty = Boolean(stderr.isTTY);
  let progressActive = false;
  let lastProgress = '';
  let startedAt = null;

  const endProgress = () => {
    if (progressActive && tty) stderr.write('\n');
    progressActive = false;
  };

  return {
    json,
    /** A human line on stdout (silent in JSON mode). */
    say(line = '') {
      if (json) return;
      endProgress();
      stdout.write(`${line}\n`);
    },
    /** A line that must reach the user even in JSON mode (login URL). */
    notice(line) {
      endProgress();
      stderr.write(`${line}\n`);
    },
    status(status) {
      if (json) return;
      startedAt ??= now();
      const text =
        `Construction : ${label(status?.build?.status)} · ` +
        `Vérification : ${label(status?.verification?.status)} · ${formatElapsed(now() - startedAt)}`;
      if (tty) {
        stderr.write(`\r\x1b[2K${text}`);
        progressActive = true;
      } else {
        // Without a terminal, print only changes (CI logs, agents).
        const key = text.replace(/ · [^·]*$/, '');
        if (key !== lastProgress) stderr.write(`${text}\n`);
        lastProgress = key;
      }
    },
    endProgress,
    result(value) {
      if (!json) return;
      endProgress();
      stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    },
    error(error) {
      endProgress();
      if (json) {
        stdout.write(`${JSON.stringify({ ok: false, error: error.toJSON() }, null, 2)}\n`);
        return;
      }
      stderr.write(`Erreur : ${error.message}\n`);
      if (error.hint) stderr.write(`${error.hint}\n`);
      if (error.details?.requestId) stderr.write(`Référence : ${error.details.requestId}\n`);
    },
  };
}

/** Human report of a factory_status payload. */
export function describeStatus(ui, status, phase) {
  if (!status) return;
  ui.say(`Version ${status.version ?? '?'} (${status.versionId ?? '?'})`);
  ui.say(`  Construction : ${label(status.build?.status)}`);
  ui.say(`  Vérification : ${label(status.verification?.status)}`);
  if (status.review?.status) ui.say(`  Revue : ${label(status.review.status)}`);
  const failure =
    (status.build?.error && { stage: 'la construction', ...status.build.error }) ||
    (status.verification?.error && { stage: 'la vérification', ...status.verification.error });
  if (failure) {
    ui.say(`Échec de ${failure.stage} : ${failure.message || 'erreur inconnue'}${failure.code ? ` (${failure.code})` : ''}`);
  } else if (phase === 'failed') {
    ui.say('Échec du déploiement.');
  }
  if (status.previewUrl) ui.say(`Aperçu : ${status.previewUrl}`);
  if (status.publishable) ui.say('Cette version peut être publiée.');
  if (status.nextStep) ui.say(`Étape suivante : ${status.nextStep}`);
}
