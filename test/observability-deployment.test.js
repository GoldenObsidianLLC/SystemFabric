'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateObservabilityDeploymentManifest
} = require('../packages/observability/src/deployment-contract');

const NOW = '2026-11-01T23:40:00.000Z';

function validManifest() {
  return {
    schemaVersion: 1,
    environment: 'production',
    deploymentId: 'virgoscorpio_hub-prod-region-a',
    sourceRevision: '5d9a99541a23670c07af1425cbc21df454af19c8',
    decision: {
      status: 'approved',
      approvedAt: '2026-10-31T12:00:00.000Z',
      approvedBy: 'team:platform-architecture',
      changeReference: 'change:OBS-2026-117'
    },
    backend: {
      provider: 'Deployment approved provider',
      service: 'Production telemetry backend',
      deploymentModel: 'managed',
      region: 'deployment-region-a',
      dataResidency: 'approved-residency-boundary',
      dataClassification: 'internal-operational-telemetry'
    },
    transport: {
      protocol: 'otlp-http',
      tracesEndpoint: 'https://collector.example/v1/traces',
      logsEndpoint: 'https://collector.example/v1/logs',
      tlsMode: 'mtls',
      minimumTlsVersion: '1.2',
      authentication: {
        mode: 'mtls',
        credentialReference: 'certificate:virgoscorpio_hub/otel/client'
      },
      network: {
        privateIngress: true,
        ingressRestricted: true,
        egressRestricted: true
      },
      secretManagement: {
        manager: 'deployment-approved-secret-manager',
        rotationOwner: 'team:platform-security',
        rotationPeriodDays: 30,
        lastRotatedAt: '2026-10-25T12:00:00.000Z'
      }
    },
    governance: {
      retentionDays: 30,
      deletionSlaDays: 7,
      legalHoldSupported: true,
      legalHoldProcedureReference: 'policy:observability/legal-hold',
      retentionPolicyReference: 'policy:observability/retention',
      deletionProcedureReference: 'policy:observability/deletion',
      accessControl: {
        model: 'role-based-access-control',
        leastPrivilegeVerified: true,
        accessLoggingEnabled: true,
        reviewCadenceDays: 30,
        lastReviewedAt: '2026-10-25T12:00:00.000Z'
      }
    },
    owners: {
      serviceOwner: 'team:platform-engineering',
      technicalOwner: 'team:observability',
      dataOwner: 'team:data-governance',
      securityOwner: 'team:platform-security',
      onCallRoute: 'pager:virgoscorpio_hub-platform'
    },
    delivery: {
      queue: {
        durable: true,
        encryptedAtRest: true,
        survivesRestart: true,
        restoreTested: true,
        capacityRecords: 12000,
        overflowPolicy: 'backpressure'
      },
      retry: {
        strategy: 'bounded-exponential-backoff',
        maxAttempts: 12,
        initialDelayMs: 1000,
        maxDelayMs: 60000,
        jitterEnabled: true,
        deadLetterQueueEnabled: true,
        redriveProcedureReference: 'policy:observability/redrive'
      },
      capacity: {
        expectedPeakRecordsPerSecond: 500,
        validatedSustainedRecordsPerSecond: 750,
        expectedBurstRecords: 8000,
        validatedBurstRecords: 12000,
        loadTestDurationSeconds: 3600,
        observedLossPercent: 0,
        allowedLossPercent: 0,
        maxObservedQueueUtilizationPercent: 72
      },
      recovery: {
        passed: true,
        outageDurationSeconds: 300,
        totalRecordsSubmitted: 10000,
        recordsRecovered: 10000,
        recordsLost: 0,
        recoveryTimeSeconds: 90,
        targetRecoveryTimeSeconds: 180
      },
      alerting: {
        exportFailures: true,
        queueSaturation: true,
        droppedRecords: true,
        unauthorizedAccess: true,
        alertOwner: 'team:platform-on-call',
        incidentRunbookReference: 'policy:observability/incident-runbook'
      }
    },
    evidence: {
      networkSecurity: { reference: 'artifact:network-security-review-2026-10-25', executedAt: '2026-10-25T12:00:00.000Z', validForDays: 90 },
      redactionReview: { reference: 'artifact:redaction-test-report-2026-10-25', executedAt: '2026-10-25T12:00:00.000Z', validForDays: 90 },
      accessReview: { reference: 'artifact:access-review-2026-10-25', executedAt: '2026-10-25T12:00:00.000Z', validForDays: 30 },
      dataGovernance: { reference: 'artifact:data-governance-approval-2026-10-25', executedAt: '2026-10-25T12:00:00.000Z', validForDays: 90 },
      loadTest: { reference: 'run:observability-load-test-2026-10-30', executedAt: '2026-10-30T12:00:00.000Z', validForDays: 30 },
      outageRecovery: { reference: 'run:observability-outage-recovery-2026-10-30', executedAt: '2026-10-30T12:00:00.000Z', validForDays: 30 },
      backupRestore: { reference: 'run:observability-backup-restore-2026-10-30', executedAt: '2026-10-30T12:00:00.000Z', validForDays: 90 },
      incidentExercise: { reference: 'run:observability-incident-exercise-2026-10-30', executedAt: '2026-10-30T12:00:00.000Z', validForDays: 90 }
    }
  };
}

function errorCodes(result) {
  return new Set(result.errors.map(error => error.code));
}

test('complete, deployment-approved observability evidence satisfies the structural contract', () => {
  const result = validateObservabilityDeploymentManifest(validManifest(), { now: NOW });
  assert.equal(result.ready, true);
  assert.deepEqual(result.errors, []);
});

test('the contract fails closed for incomplete approval, backend choice, ownership and evidence', () => {
  const manifest = validManifest();
  manifest.decision.status = 'draft';
  manifest.backend.provider = '';
  manifest.owners.dataOwner = '';
  manifest.evidence.loadTest = '';
  const result = validateObservabilityDeploymentManifest(manifest, { now: NOW });

  assert.equal(result.ready, false);
  assert.ok(result.errors.some(error => error.path === '$.decision.status' && error.code === 'approval_required'));
  assert.ok(result.errors.some(error => error.path === '$.backend.provider'));
  assert.ok(result.errors.some(error => error.path === '$.owners.dataOwner'));
  assert.ok(result.errors.some(error => error.path === '$.evidence.loadTest'));
});

test('transport rejects HTTP, URL credentials, wrong OTLP paths and weak trust configuration', () => {
  const manifest = validManifest();
  manifest.transport.tracesEndpoint = 'http://collector.example/v1/traces';
  manifest.transport.logsEndpoint = 'https://user:secret@collector.example/v1/logs';
  manifest.transport.tlsMode = 'none';
  manifest.transport.network.privateIngress = false;
  manifest.transport.authentication.credentialReference = 'Bearer hard-coded-secret';
  const result = validateObservabilityDeploymentManifest(manifest, { now: NOW });

  assert.equal(result.ready, false);
  assert.ok(errorCodes(result).has('endpoint_must_be_https_otlp'));
  assert.ok(errorCodes(result).has('tls_required'));
  assert.ok(errorCodes(result).has('must_be_true'));
  assert.ok(errorCodes(result).has('certificate_reference_required'));
});

test('secret rotation and access-review age must fit their approved cadence', () => {
  const manifest = validManifest();
  manifest.transport.secretManagement.lastRotatedAt = '2026-09-01T12:00:00.000Z';
  manifest.governance.accessControl.lastReviewedAt = '2026-09-01T12:00:00.000Z';
  const result = validateObservabilityDeploymentManifest(manifest, { now: NOW });

  assert.ok(result.errors.some(error => error.code === 'rotation_overdue'));
  assert.ok(result.errors.some(error => error.code === 'access_review_overdue'));
});

test('measured throughput and burst must cover deployment demand; loss and queue pressure must remain within the approved envelope', () => {
  const manifest = validManifest();
  manifest.delivery.capacity.validatedSustainedRecordsPerSecond = 400;
  manifest.delivery.capacity.validatedBurstRecords = 7000;
  manifest.delivery.capacity.observedLossPercent = 1;
  manifest.delivery.capacity.allowedLossPercent = 0.1;
  manifest.delivery.capacity.maxObservedQueueUtilizationPercent = 100;
  manifest.delivery.queue.capacityRecords = 7000;
  const result = validateObservabilityDeploymentManifest(manifest, { now: NOW });

  assert.ok(result.errors.some(error => error.code === 'below_expected_peak'));
  assert.ok(result.errors.some(error => error.code === 'below_expected_burst'));
  assert.ok(result.errors.some(error => error.code === 'loss_exceeds_approved_tolerance'));
  assert.ok(result.errors.some(error => error.code === 'queue_saturated'));
  assert.ok(result.errors.some(error => error.code === 'below_validated_burst' && error.path === '$.delivery.queue.capacityRecords'));
});

test('outage recovery evidence must reconcile record counts and meet the approved recovery target', () => {
  const manifest = validManifest();
  manifest.delivery.recovery.recordsRecovered = 9000;
  manifest.delivery.recovery.recordsLost = 1000;
  manifest.delivery.recovery.recoveryTimeSeconds = 240;
  manifest.delivery.recovery.targetRecoveryTimeSeconds = 180;
  const result = validateObservabilityDeploymentManifest(manifest, { now: NOW });

  assert.ok(result.errors.some(error => error.code === 'recovery_loss_exceeds_tolerance'));
  assert.ok(result.errors.some(error => error.code === 'recovery_target_missed'));
});

test('strict contract rejects unrecognized properties that could carry unreviewed data or secrets', () => {
  const manifest = validManifest();
  manifest.transport.authentication.apiKey = 'DO_NOT_STORE_SECRET';
  const result = validateObservabilityDeploymentManifest(manifest, { now: NOW });

  assert.ok(result.errors.some(error =>
    error.path === '$.transport.authentication.apiKey' &&
    error.code === 'unexpected_field'
  ));
  assert.equal(result.ready, false);
});

test('legal-hold behavior and supported authentication identity types must be explicit', () => {
  const manifest = validManifest();
  manifest.governance.legalHoldSupported = false;
  manifest.governance.legalHoldProcedureReference = 'policy:observability/legal-hold';
  manifest.transport.tlsMode = 'tls';
  manifest.transport.authentication.mode = 'workload-identity';
  manifest.transport.authentication.credentialReference = 'identity:virgoscorpio_hub-prod';
  const result = validateObservabilityDeploymentManifest(manifest, { now: NOW });

  assert.ok(result.errors.some(error => error.code === 'must_be_null_when_unsupported'));
  assert.equal(result.errors.some(error => error.code === 'mtls_mode_mismatch'), false);
});

test('UTC timestamps reject impossible dates and timestamps in the future', () => {
  const impossible = validManifest();
  impossible.decision.approvedAt = '2026-02-30T12:00:00.000Z';
  const future = validManifest();
  future.decision.approvedAt = '2026-12-01T12:00:00.000Z';

  assert.ok(validateObservabilityDeploymentManifest(impossible, { now: NOW }).errors.some(error => error.code === 'invalid_utc_timestamp'));
  assert.ok(validateObservabilityDeploymentManifest(future, { now: NOW }).errors.some(error => error.code === 'timestamp_in_future'));
});

test('evidence references are dated, owner-expiring and must predate the approval decision', () => {
  const expired = validManifest();
  expired.evidence.loadTest.executedAt = '2026-01-01T00:00:00.000Z';
  expired.evidence.loadTest.validForDays = 30;
  const postApproval = validManifest();
  postApproval.evidence.loadTest.executedAt = '2026-11-01T12:00:00.000Z';

  assert.ok(validateObservabilityDeploymentManifest(expired, { now: NOW }).errors.some(error => error.code === 'evidence_expired'));
  assert.ok(validateObservabilityDeploymentManifest(postApproval, { now: NOW }).errors.some(error => error.code === 'evidence_after_approval'));
});

test('source revision must be a full Git commit and total-loss tolerance is not acceptable', () => {
  const manifest = validManifest();
  manifest.sourceRevision = '5d9a995';
  manifest.delivery.capacity.allowedLossPercent = 100;
  const result = validateObservabilityDeploymentManifest(manifest, { now: NOW });

  assert.ok(result.errors.some(error => error.code === 'full_git_revision_required'));
  assert.ok(result.errors.some(error => error.code === 'loss_tolerance_cannot_allow_total_loss'));
});

test('schema version and environment must be explicit and correct', () => {
  const manifest = validManifest();
  manifest.schemaVersion = 2;
  manifest.environment = 'development';
  const result = validateObservabilityDeploymentManifest(manifest, { now: NOW });

  assert.ok(result.errors.some(error => error.code === 'unsupported_version'));
  assert.ok(result.errors.some(error => error.code === 'must_be_production'));
});
