'use strict';

const REFERENCE_RE = /^(change|ticket|run|artifact|policy|secret|identity|certificate|team|user|pager):[A-Za-z0-9][A-Za-z0-9._:/-]{2,220}$/;
const SAFE_TEXT_RE = /^[^\u0000-\u001f\u007f]{2,200}$/;
const POSITIVE_INTEGER_MAX = 2_147_483_647;
const PERCENT_MAX = 100;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createValidator({ now = new Date() } = {}) {
  const errors = [];
  const currentTime = now instanceof Date ? now.getTime() : Date.parse(now);

  function issue(path, code) {
    errors.push({ path, code });
  }

  function objectAt(value, path, keys) {
    if (!isObject(value)) {
      issue(path, 'object_required');
      return {};
    }
    for (const key of keys) {
      if (!Object.hasOwn(value, key)) issue(path + '.' + key, 'required');
    }
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) issue(path + '.' + key, 'unexpected_field');
    }
    return value;
  }

  function text(value, path, { min = 2, max = 200, pattern = SAFE_TEXT_RE } = {}) {
    if (typeof value !== 'string' || value.length < min || value.length > max ||
        value.trim() !== value || !pattern.test(value)) {
      issue(path, 'invalid_text');
      return false;
    }
    return true;
  }

  function reference(value, path) {
    if (typeof value !== 'string' || !REFERENCE_RE.test(value)) {
      issue(path, 'invalid_reference');
      return false;
    }
    return true;
  }

  function boolean(value, path, expected = true) {
    if (typeof value !== 'boolean' || value !== expected) {
      issue(path, expected ? 'must_be_true' : 'must_be_false');
      return false;
    }
    return true;
  }

  function integer(value, path, { min = 1, max = POSITIVE_INTEGER_MAX } = {}) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      issue(path, 'invalid_integer');
      return false;
    }
    return true;
  }

  function percent(value, path) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > PERCENT_MAX) {
      issue(path, 'invalid_percentage');
      return false;
    }
    return true;
  }

  function timestamp(value, path, { maxAgeDays = null } = {}) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
      issue(path, 'invalid_utc_timestamp');
      return null;
    }
    const parsed = Date.parse(value);
    const normalized = value.includes('.')
      ? value.replace(/\.(\d{1,3})Z$/, (_match, fraction) => '.' + fraction.padEnd(3, '0') + 'Z')
      : value.replace(/Z$/, '.000Z');
    // Date.parse accepts some impossible dates; an exact UTC round-trip rejects them.
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
      issue(path, 'invalid_utc_timestamp');
      return null;
    }
    if (parsed > currentTime) {
      issue(path, 'timestamp_in_future');
      return null;
    }
    if (maxAgeDays !== null && currentTime - parsed > maxAgeDays * 86_400_000) {
      issue(path, 'evidence_expired');
    }
    return parsed;
  }

  function endpoint(value, path, suffix) {
    if (typeof value !== 'string' || value.length > 2048) {
      issue(path, 'invalid_endpoint');
      return;
    }
    let parsed;
    try { parsed = new URL(value); } catch {
      issue(path, 'invalid_endpoint');
      return;
    }
    if (parsed.protocol !== 'https:' || !parsed.hostname ||
        parsed.username || parsed.password || parsed.search || parsed.hash ||
        parsed.pathname !== suffix) {
      issue(path, 'endpoint_must_be_https_otlp');
    }
  }

  return {
    errors,
    objectAt,
    text,
    reference,
    boolean,
    integer,
    percent,
    timestamp,
    endpoint,
    currentTime
  };
}

/**
 * Validate the vendor-neutral evidence contract for a production OTLP
 * collector/backend. This validates declarations and evidence references; it
 * does not verify the referenced ticketing system, secret manager, network,
 * collector, backend, or load-test execution.
 *
 * @param {unknown} manifest
 * @param {{now?: Date|string}} [options]
 * @returns {{ready:boolean, errors:Array<{path:string,code:string}>}}
 */
function validateObservabilityDeploymentManifest(manifest, options = {}) {
  const v = createValidator(options);
  const root = v.objectAt(manifest, '$', [
    'schemaVersion', 'environment', 'deploymentId', 'sourceRevision', 'decision', 'backend',
    'transport', 'governance', 'owners', 'delivery', 'evidence'
  ]);

  if (root.schemaVersion !== 1) v.errors.push({ path: '$.schemaVersion', code: 'unsupported_version' });
  if (typeof root.sourceRevision !== 'string' || !/^[0-9a-f]{40}$/i.test(root.sourceRevision)) {
    v.errors.push({ path: '$.sourceRevision', code: 'full_git_revision_required' });
  }
  if (root.environment !== 'production') v.errors.push({ path: '$.environment', code: 'must_be_production' });
  v.text(root.deploymentId, '$.deploymentId', { max: 120 });

  const decision = v.objectAt(root.decision, '$.decision', [
    'status', 'approvedAt', 'approvedBy', 'changeReference'
  ]);
  if (decision.status !== 'approved') v.errors.push({ path: '$.decision.status', code: 'approval_required' });
  const approvedAt = v.timestamp(decision.approvedAt, '$.decision.approvedAt');
  v.text(decision.approvedBy, '$.decision.approvedBy');
  v.reference(decision.changeReference, '$.decision.changeReference');

  const backend = v.objectAt(root.backend, '$.backend', [
    'provider', 'service', 'deploymentModel', 'region', 'dataResidency', 'dataClassification'
  ]);
  for (const field of ['provider', 'service', 'region', 'dataResidency', 'dataClassification']) {
    v.text(backend[field], '$.backend.' + field);
  }
  if (!['managed', 'self-hosted'].includes(backend.deploymentModel)) {
    v.errors.push({ path: '$.backend.deploymentModel', code: 'invalid_deployment_model' });
  }

  const transport = v.objectAt(root.transport, '$.transport', [
    'protocol', 'tracesEndpoint', 'logsEndpoint', 'tlsMode', 'minimumTlsVersion',
    'authentication', 'network', 'secretManagement'
  ]);
  if (transport.protocol !== 'otlp-http') v.errors.push({ path: '$.transport.protocol', code: 'unsupported_protocol' });
  v.endpoint(transport.tracesEndpoint, '$.transport.tracesEndpoint', '/v1/traces');
  v.endpoint(transport.logsEndpoint, '$.transport.logsEndpoint', '/v1/logs');
  if (!['tls', 'mtls'].includes(transport.tlsMode)) v.errors.push({ path: '$.transport.tlsMode', code: 'tls_required' });
  if (!['1.2', '1.3'].includes(transport.minimumTlsVersion)) v.errors.push({ path: '$.transport.minimumTlsVersion', code: 'unsupported_tls_minimum' });

  const auth = v.objectAt(transport.authentication, '$.transport.authentication', ['mode', 'credentialReference']);
  if (!['mtls', 'workload-identity', 'bearer-token', 'api-key'].includes(auth.mode)) {
    v.errors.push({ path: '$.transport.authentication.mode', code: 'unsupported_authentication' });
  }
  if (auth.mode === 'workload-identity') {
    if (typeof auth.credentialReference !== 'string' || !/^identity:[A-Za-z0-9][A-Za-z0-9._-]{1,79}\/[A-Za-z0-9._/-]{1,120}$/.test(auth.credentialReference)) {
      v.errors.push({ path: '$.transport.authentication.credentialReference', code: 'identity_reference_required' });
    }
  } else if (auth.mode === 'mtls') {
    if (typeof auth.credentialReference !== 'string' || !/^certificate:[A-Za-z0-9][A-Za-z0-9._-]{1,79}\/[A-Za-z0-9._/-]{1,120}$/.test(auth.credentialReference)) {
      v.errors.push({ path: '$.transport.authentication.credentialReference', code: 'certificate_reference_required' });
    }
  } else if (typeof auth.credentialReference !== 'string' || !/^secret:[A-Za-z0-9][A-Za-z0-9._-]{1,79}\/[A-Za-z0-9._/-]{1,120}$/.test(auth.credentialReference)) {
    v.errors.push({ path: '$.transport.authentication.credentialReference', code: 'secret_reference_required' });
  }
  if ((transport.tlsMode === 'mtls') !== (auth.mode === 'mtls')) {
    v.errors.push({ path: '$.transport.authentication.mode', code: 'mtls_mode_mismatch' });
  }

  const network = v.objectAt(transport.network, '$.transport.network', [
    'privateIngress', 'ingressRestricted', 'egressRestricted'
  ]);
  v.boolean(network.privateIngress, '$.transport.network.privateIngress');
  v.boolean(network.ingressRestricted, '$.transport.network.ingressRestricted');
  v.boolean(network.egressRestricted, '$.transport.network.egressRestricted');

  const secrets = v.objectAt(transport.secretManagement, '$.transport.secretManagement', [
    'manager', 'rotationOwner', 'rotationPeriodDays', 'lastRotatedAt'
  ]);
  v.text(secrets.manager, '$.transport.secretManagement.manager');
  v.text(secrets.rotationOwner, '$.transport.secretManagement.rotationOwner');
  v.integer(secrets.rotationPeriodDays, '$.transport.secretManagement.rotationPeriodDays', { max: 3650 });
  const lastRotation = v.timestamp(secrets.lastRotatedAt, '$.transport.secretManagement.lastRotatedAt');
  if (lastRotation !== null && Number.isInteger(secrets.rotationPeriodDays) &&
      secrets.rotationPeriodDays > 0 &&
      v.currentTime - lastRotation > secrets.rotationPeriodDays * 86_400_000) {
    v.errors.push({ path: '$.transport.secretManagement.lastRotatedAt', code: 'rotation_overdue' });
  }

  const governance = v.objectAt(root.governance, '$.governance', [
    'retentionDays', 'deletionSlaDays', 'legalHoldSupported', 'legalHoldProcedureReference',
    'retentionPolicyReference', 'deletionProcedureReference', 'accessControl'
  ]);
  v.integer(governance.retentionDays, '$.governance.retentionDays', { max: 36500 });
  v.integer(governance.deletionSlaDays, '$.governance.deletionSlaDays', { max: 36500 });
  if (typeof governance.legalHoldSupported !== 'boolean') {
    v.errors.push({ path: '$.governance.legalHoldSupported', code: 'explicit_policy_required' });
  }
  if (governance.legalHoldSupported === true) {
    v.reference(governance.legalHoldProcedureReference, '$.governance.legalHoldProcedureReference');
  } else if (governance.legalHoldSupported === false && governance.legalHoldProcedureReference !== null) {
    v.errors.push({ path: '$.governance.legalHoldProcedureReference', code: 'must_be_null_when_unsupported' });
  }
  v.reference(governance.retentionPolicyReference, '$.governance.retentionPolicyReference');
  v.reference(governance.deletionProcedureReference, '$.governance.deletionProcedureReference');

  const access = v.objectAt(governance.accessControl, '$.governance.accessControl', [
    'model', 'leastPrivilegeVerified', 'accessLoggingEnabled', 'reviewCadenceDays', 'lastReviewedAt'
  ]);
  v.text(access.model, '$.governance.accessControl.model');
  v.boolean(access.leastPrivilegeVerified, '$.governance.accessControl.leastPrivilegeVerified');
  v.boolean(access.accessLoggingEnabled, '$.governance.accessControl.accessLoggingEnabled');
  v.integer(access.reviewCadenceDays, '$.governance.accessControl.reviewCadenceDays', { max: 3650 });
  const reviewedAt = v.timestamp(access.lastReviewedAt, '$.governance.accessControl.lastReviewedAt');
  if (reviewedAt !== null && Number.isInteger(access.reviewCadenceDays) &&
      access.reviewCadenceDays > 0 &&
      v.currentTime - reviewedAt > access.reviewCadenceDays * 86_400_000) {
    v.errors.push({ path: '$.governance.accessControl.lastReviewedAt', code: 'access_review_overdue' });
  }

  const owners = v.objectAt(root.owners, '$.owners', [
    'serviceOwner', 'technicalOwner', 'dataOwner', 'securityOwner', 'onCallRoute'
  ]);
  for (const field of ['serviceOwner', 'technicalOwner', 'dataOwner', 'securityOwner', 'onCallRoute']) {
    v.text(owners[field], '$.owners.' + field);
  }

  const delivery = v.objectAt(root.delivery, '$.delivery', ['queue', 'retry', 'capacity', 'recovery', 'alerting']);
  const queue = v.objectAt(delivery.queue, '$.delivery.queue', [
    'durable', 'encryptedAtRest', 'survivesRestart', 'restoreTested', 'capacityRecords', 'overflowPolicy'
  ]);
  for (const field of ['durable', 'encryptedAtRest', 'survivesRestart', 'restoreTested']) {
    v.boolean(queue[field], '$.delivery.queue.' + field);
  }
  v.integer(queue.capacityRecords, '$.delivery.queue.capacityRecords');
  if (Number.isInteger(queue.capacityRecords) &&
      ((Number.isInteger(delivery.capacity?.expectedBurstRecords) && queue.capacityRecords < delivery.capacity.expectedBurstRecords) ||
       (Number.isInteger(delivery.capacity?.validatedBurstRecords) && queue.capacityRecords < delivery.capacity.validatedBurstRecords))) {
    v.errors.push({ path: '$.delivery.queue.capacityRecords', code: 'below_validated_burst' });
  }
  if (!['backpressure', 'reject', 'drop-oldest', 'drop-newest'].includes(queue.overflowPolicy)) {
    v.errors.push({ path: '$.delivery.queue.overflowPolicy', code: 'explicit_overflow_policy_required' });
  }

  const retry = v.objectAt(delivery.retry, '$.delivery.retry', [
    'strategy', 'maxAttempts', 'initialDelayMs', 'maxDelayMs', 'jitterEnabled',
    'deadLetterQueueEnabled', 'redriveProcedureReference'
  ]);
  if (retry.strategy !== 'bounded-exponential-backoff') v.errors.push({ path: '$.delivery.retry.strategy', code: 'unsupported_retry_strategy' });
  v.integer(retry.maxAttempts, '$.delivery.retry.maxAttempts', { max: 100 });
  v.integer(retry.initialDelayMs, '$.delivery.retry.initialDelayMs');
  v.integer(retry.maxDelayMs, '$.delivery.retry.maxDelayMs');
  if (Number.isInteger(retry.initialDelayMs) && Number.isInteger(retry.maxDelayMs) &&
      retry.maxDelayMs < retry.initialDelayMs) {
    v.errors.push({ path: '$.delivery.retry.maxDelayMs', code: 'must_cover_initial_delay' });
  }
  v.boolean(retry.jitterEnabled, '$.delivery.retry.jitterEnabled');
  v.boolean(retry.deadLetterQueueEnabled, '$.delivery.retry.deadLetterQueueEnabled');
  v.reference(retry.redriveProcedureReference, '$.delivery.retry.redriveProcedureReference');

  const capacity = v.objectAt(delivery.capacity, '$.delivery.capacity', [
    'expectedPeakRecordsPerSecond', 'validatedSustainedRecordsPerSecond',
    'expectedBurstRecords', 'validatedBurstRecords', 'loadTestDurationSeconds',
    'observedLossPercent', 'allowedLossPercent', 'maxObservedQueueUtilizationPercent'
  ]);
  v.integer(capacity.expectedPeakRecordsPerSecond, '$.delivery.capacity.expectedPeakRecordsPerSecond');
  v.integer(capacity.validatedSustainedRecordsPerSecond, '$.delivery.capacity.validatedSustainedRecordsPerSecond');
  v.integer(capacity.expectedBurstRecords, '$.delivery.capacity.expectedBurstRecords');
  v.integer(capacity.validatedBurstRecords, '$.delivery.capacity.validatedBurstRecords');
  v.integer(capacity.loadTestDurationSeconds, '$.delivery.capacity.loadTestDurationSeconds');
  v.percent(capacity.observedLossPercent, '$.delivery.capacity.observedLossPercent');
  v.percent(capacity.allowedLossPercent, '$.delivery.capacity.allowedLossPercent');
  v.percent(capacity.maxObservedQueueUtilizationPercent, '$.delivery.capacity.maxObservedQueueUtilizationPercent');
  if (Number.isInteger(capacity.expectedPeakRecordsPerSecond) &&
      Number.isInteger(capacity.validatedSustainedRecordsPerSecond) &&
      capacity.validatedSustainedRecordsPerSecond < capacity.expectedPeakRecordsPerSecond) {
    v.errors.push({ path: '$.delivery.capacity.validatedSustainedRecordsPerSecond', code: 'below_expected_peak' });
  }
  if (Number.isInteger(capacity.expectedBurstRecords) && Number.isInteger(capacity.validatedBurstRecords) &&
      capacity.validatedBurstRecords < capacity.expectedBurstRecords) {
    v.errors.push({ path: '$.delivery.capacity.validatedBurstRecords', code: 'below_expected_burst' });
  }
  if (typeof capacity.allowedLossPercent === 'number' && capacity.allowedLossPercent >= 100) {
    v.errors.push({ path: '$.delivery.capacity.allowedLossPercent', code: 'loss_tolerance_cannot_allow_total_loss' });
  }
  if (typeof capacity.observedLossPercent === 'number' && typeof capacity.allowedLossPercent === 'number' &&
      capacity.observedLossPercent > capacity.allowedLossPercent) {
    v.errors.push({ path: '$.delivery.capacity.observedLossPercent', code: 'loss_exceeds_approved_tolerance' });
  }
  if (typeof capacity.maxObservedQueueUtilizationPercent === 'number' &&
      capacity.maxObservedQueueUtilizationPercent >= 100) {
    v.errors.push({ path: '$.delivery.capacity.maxObservedQueueUtilizationPercent', code: 'queue_saturated' });
  }

  const recovery = v.objectAt(delivery.recovery, '$.delivery.recovery', [
    'passed', 'outageDurationSeconds', 'totalRecordsSubmitted', 'recordsRecovered',
    'recordsLost', 'recoveryTimeSeconds', 'targetRecoveryTimeSeconds'
  ]);
  v.boolean(recovery.passed, '$.delivery.recovery.passed');
  for (const field of ['outageDurationSeconds', 'totalRecordsSubmitted', 'recordsRecovered', 'recoveryTimeSeconds', 'targetRecoveryTimeSeconds']) {
    v.integer(recovery[field], '$.delivery.recovery.' + field);
  }
  integerZero(recovery.recordsLost, '$.delivery.recovery.recordsLost', v);
  if (Number.isInteger(recovery.totalRecordsSubmitted) && Number.isInteger(recovery.recordsRecovered) &&
      Number.isInteger(recovery.recordsLost) &&
      recovery.totalRecordsSubmitted !== recovery.recordsRecovered + recovery.recordsLost) {
    v.errors.push({ path: '$.delivery.recovery.totalRecordsSubmitted', code: 'recovery_record_count_mismatch' });
  }
  if (Number.isInteger(recovery.recoveryTimeSeconds) && Number.isInteger(recovery.targetRecoveryTimeSeconds) &&
      recovery.recoveryTimeSeconds > recovery.targetRecoveryTimeSeconds) {
    v.errors.push({ path: '$.delivery.recovery.recoveryTimeSeconds', code: 'recovery_target_missed' });
  }
  if (Number.isInteger(recovery.totalRecordsSubmitted) && recovery.totalRecordsSubmitted > 0 &&
      Number.isInteger(recovery.recordsLost) &&
      typeof capacity.allowedLossPercent === 'number') {
    const observedLoss = (recovery.recordsLost / recovery.totalRecordsSubmitted) * 100;
    if (observedLoss > capacity.allowedLossPercent) {
      v.errors.push({ path: '$.delivery.recovery.recordsLost', code: 'recovery_loss_exceeds_tolerance' });
    }
  }

  const alerting = v.objectAt(delivery.alerting, '$.delivery.alerting', [
    'exportFailures', 'queueSaturation', 'droppedRecords', 'unauthorizedAccess',
    'alertOwner', 'incidentRunbookReference'
  ]);
  for (const field of ['exportFailures', 'queueSaturation', 'droppedRecords', 'unauthorizedAccess']) {
    v.boolean(alerting[field], '$.delivery.alerting.' + field);
  }
  v.text(alerting.alertOwner, '$.delivery.alerting.alertOwner');
  v.reference(alerting.incidentRunbookReference, '$.delivery.alerting.incidentRunbookReference');

  const evidence = v.objectAt(root.evidence, '$.evidence', [
    'networkSecurity', 'redactionReview', 'accessReview', 'dataGovernance',
    'loadTest', 'outageRecovery', 'backupRestore', 'incidentExercise'
  ]);
  for (const field of ['networkSecurity', 'redactionReview', 'accessReview', 'dataGovernance',
    'loadTest', 'outageRecovery', 'backupRestore', 'incidentExercise']) {
    const evidencePath = '$.evidence.' + field;
    const item = v.objectAt(evidence[field], evidencePath, ['reference', 'executedAt', 'validForDays']);
    v.reference(item.reference, evidencePath + '.reference');
    v.integer(item.validForDays, evidencePath + '.validForDays', { max: 36500 });
    const executedAt = v.timestamp(item.executedAt, evidencePath + '.executedAt', {
      maxAgeDays: Number.isInteger(item.validForDays) ? item.validForDays : null
    });
    if (executedAt !== null && approvedAt !== null && executedAt > approvedAt) {
      v.errors.push({ path: evidencePath + '.executedAt', code: 'evidence_after_approval' });
    }
  }

  return Object.freeze({
    ready: v.errors.length === 0,
    errors: Object.freeze(v.errors.map(error => Object.freeze(error)))
  });
}

function integerZero(value, path, validator) {
  if (!Number.isSafeInteger(value) || value < 0 || value > POSITIVE_INTEGER_MAX) {
    validator.errors.push({ path, code: 'invalid_integer' });
    return false;
  }
  return true;
}

module.exports = { validateObservabilityDeploymentManifest };
