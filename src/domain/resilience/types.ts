/**
 * Resilience engine contract (Part 2.5). FROZEN: the dashboard builds against these types.
 * Pure data; no React. Runtime risk is separate from build status (RoomStatus) on purpose.
 */

// ---------- Scenario definition (simulated world) ----------

export type FaultType = 'connection_pool_exhaustion' | 'bad_deploy' | 'memory_leak';

export type EdgeKind = 'sync' | 'async';

/** Where an edge came from. Scan edges are text-matched, so they get low propagation weight. */
export type EdgeProvenance = 'scenario' | 'scan-heuristic' | 'log-inferred';

export interface ServiceSpec {
  id: string;
  name: string;
  layer: 'foundation' | 'core' | 'service' | 'gateway';
  baseRps: number;
  baseP95Ms: number;
  baseErrorRate: number;
}

/** caller (source) depends on callee (target). Failure flows target -> source. */
export interface DependencyEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  /** 0..1, share of the callee's degradation that reaches the caller. */
  weight: number;
  provenance: EdgeProvenance;
  retries: number;
  hasBreaker: boolean;
}

export interface FaultInjection {
  serviceId: string;
  faultType: FaultType;
  startTick: number;
  /** Ticks from first symptom to full intensity. */
  rampTicks: number;
}

export interface GroundTruth {
  rootServiceId: string;
  faultType: FaultType;
  faultStartTick: number;
}

export interface ResilienceScenario {
  id: string;
  name: string;
  description: string;
  seed: number;
  totalTicks: number;
  tickSeconds: number;
  services: ServiceSpec[];
  edges: DependencyEdge[];
  faults: FaultInjection[];
  groundTruth: GroundTruth;
  /** True when built from a scanned repo's inferred topology. */
  isScannedRepo: boolean;
}

// ---------- Observations (the only thing the analysis reads) ----------

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface LogEvent {
  id: string;
  tick: number;
  serviceId: string;
  level: LogLevel;
  message: string;
  /** Set by the template miner. */
  templateId?: string;
}

export interface MetricObservation {
  tick: number;
  serviceId: string;
  rps: number;
  errorRate: number;
  p95Ms: number;
}

export interface LogTemplate {
  id: string;
  template: string;
  count: number;
  level: LogLevel;
  firstSeenTick: number;
  lastSeenTick: number;
  serviceIds: string[];
  /** First seen after the baseline window and within the last 10 ticks. */
  isNew: boolean;
}

// ---------- Analysis results ----------

export type AnalysisStatus = 'ok' | 'insufficient_evidence' | 'no_anomaly';

export type RiskTier = 'healthy' | 'watch' | 'high' | 'critical' | 'failed';

export interface SignalPoint {
  tick: number;
  errorRate: number;
  p95Ms: number;
  /** 0..1 */
  anomalyScore: number;
}

export interface AnomalySignal {
  serviceId: string;
  status: AnalysisStatus;
  /** 0..1, current anomaly strength. */
  score: number;
  /** Robust z-scores against the baseline window (median / MAD). */
  errorZ: number;
  latencyZ: number;
  /** First tick where drift persisted for 2 ticks. */
  onsetTick: number | null;
  observedFailed: boolean;
  firstObservedFailureTick: number | null;
  history: SignalPoint[];
}

export interface EvidenceRef {
  kind: 'log' | 'metric' | 'graph';
  serviceId: string;
  tick: number;
  text: string;
  templateId?: string;
}

export interface RootCauseComponents {
  temporal: number;
  severity: number;
  dependency: number;
  logEvidence: number;
  upstreamImpact: number;
}

export interface RootCauseCandidate {
  serviceId: string;
  rank: number;
  /** Weighted sum of components, 0..1. */
  score: number;
  /** Share of total candidate score, 0..1. Relative, not a certainty. */
  confidence: number;
  components: RootCauseComponents;
  reasons: string[];
  evidence: EvidenceRef[];
}

export interface RootCauseResult {
  status: AnalysisStatus;
  candidates: RootCauseCandidate[];
  weights: RootCauseComponents;
}

export interface ServiceForecast {
  serviceId: string;
  /** 0..1 relative risk estimate (max of own drift and weighted upstream pressure). */
  risk: number;
  tier: RiskTier;
  etaTicks: number | null;
  band: { lowTicks: number; highTicks: number } | null;
}

export interface FailureForecast {
  status: AnalysisStatus;
  /** Always shown next to forecast numbers. */
  label: string;
  horizonTicks: number;
  next: (ServiceForecast & { etaSeconds: number | null; basis: string }) | null;
  byService: Record<string, ServiceForecast>;
}

export interface CascadeProjection {
  status: AnalysisStatus;
  seedServiceId: string | null;
  /** Ordered service ids along the predicted spread, seed first. */
  path: string[];
  pathEdgeIds: string[];
  affectedServiceIds: string[];
  affectedCount: number;
  totalServices: number;
  blastRadiusPct: number;
  /** 0..1 projected failure likelihood per service (relative). */
  byService: Record<string, number>;
}

// ---------- Recovery ----------

export type RecoveryStrategyId = 'restart' | 'rollback' | 'scale_out' | 'isolate' | 'failover' | 'rate_limit';

export interface StrategyOutcome {
  strategyId: RecoveryStrategyId | 'do_nothing';
  name: string;
  targetServiceId: string;
  affectedServiceIds: string[];
  affectedCount: number;
  blastRadiusPct: number;
  /** Compared with do_nothing. */
  servicesSaved: number;
  timeToRecoverTicks: number | null;
  /** 0..1 mean degradation left at the end of the horizon. */
  residualRisk: number;
  /** 0..1 fixed per strategy (user impact / operational risk). */
  sideEffectRisk: number;
  score: number;
  contained: boolean;
  tradeoffs: string[];
  assumptions: string[];
}

export interface RecoveryScoreWeights {
  blast: number;
  residual: number;
  recovery: number;
  sideEffect: number;
}

export interface RecoveryComparison {
  status: AnalysisStatus;
  method: 'scenario-twin-replay';
  note: string;
  applyAtTick: number;
  horizonTicks: number;
  targetServiceId: string | null;
  baseline: StrategyOutcome | null;
  /** Best first. */
  outcomes: StrategyOutcome[];
  recommendedId: RecoveryStrategyId | null;
  recommendedReason: string;
  weights: RecoveryScoreWeights;
}

// ---------- Playback + snapshot ----------

export interface AppliedStrategy {
  strategyId: RecoveryStrategyId;
  targetServiceId: string;
  tick: number;
}

export interface PlaybackState {
  scenarioId: string;
  tick: number;
  playing: boolean;
  speed: 1 | 2 | 4;
  injectedFaults: FaultInjection[];
  applied: AppliedStrategy | null;
}

export type PlaybackAction =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'step' }
  | { type: 'reset' }
  | { type: 'setSpeed'; speed: 1 | 2 | 4 }
  | { type: 'selectScenario'; scenarioId: string }
  | { type: 'inject'; serviceId: string; faultType: FaultType }
  /** Applying while another fix is active rewinds to that decision tick, so fixes are compared fairly. */
  | { type: 'applyStrategy'; strategyId: RecoveryStrategyId; targetServiceId: string }
  /** Removes the applied fix and rewinds to the tick it was applied. */
  | { type: 'clearStrategy' };

export interface ServiceView {
  id: string;
  name: string;
  layer: ServiceSpec['layer'];
  tier: RiskTier;
  risk: number;
  anomalyScore: number;
  /** Last 20 anomaly scores, for node sparklines. */
  sparkline: number[];
  onsetTick: number | null;
  observedFailed: boolean;
  etaTicks: number | null;
  rootCauseRank: number | null;
  latest: MetricObservation | null;
}

export interface SelfCheck {
  /** False when there is no ground truth to compare against. */
  available: boolean;
  groundTruthRootId: string;
  topCandidateId: string | null;
  rootCauseCorrect: boolean | null;
  /** Earliest engine warning (anomaly onset) on any service, from observations only. */
  firstWarningTick: number | null;
  /** From the simulated world (ground truth), up to the current tick. */
  actualFirstFailureTick: number | null;
  leadTimeTicks: number | null;
  leadTimeSeconds: number | null;
  /** Twin run to scenario end, no action. */
  affectedWithoutAction: number;
  /** Twin run to scenario end with the applied strategy; null if none applied. */
  affectedWithApplied: number | null;
}

export interface AppliedOutcome extends AppliedStrategy {
  state: 'watching' | 'contained' | 'spread';
  containedAtTick: number | null;
  stillFailedServiceIds: string[];
}

export interface ResilienceSnapshot {
  scenario: {
    id: string;
    name: string;
    description: string;
    totalTicks: number;
    tickSeconds: number;
    isScannedRepo: boolean;
  };
  tick: number;
  /** HH:MM:SS of simulated time. */
  simTimeLabel: string;
  isFinished: boolean;
  /** True on the tick the first service fails in the world. */
  shouldAutoPause: boolean;
  services: ServiceView[];
  riskByRoomId: Record<string, RiskTier>;
  graph: { nodes: ServiceSpec[]; edges: DependencyEdge[] };
  signals: Record<string, SignalPoint[]>;
  anomalies: Record<string, AnomalySignal>;
  forecast: FailureForecast;
  cascade: CascadeProjection;
  rootCause: RootCauseResult;
  recovery: RecoveryComparison;
  /** Last 200 lines, oldest first. */
  logs: LogEvent[];
  templates: LogTemplate[];
  injectedFaults: FaultInjection[];
  applied: AppliedOutcome | null;
  selfCheck: SelfCheck;
}

/** Compact, redacted summary sent with /api/investigate. */
export interface ResilienceInvestigationContext {
  scenarioId: string;
  tick: number;
  roomRisk: { tier: RiskTier; risk: number; etaTicks: number | null; rootCauseRank: number | null } | null;
  forecast: Array<{ roomId: string; risk: number; etaTicks: number | null }>;
  rootCauses: Array<{ roomId: string; score: number; confidence: number; reasons: string[] }>;
  cascadePath: string[];
  blastRadiusPct: number;
  strategies: Array<{ id: string; score: number; blastAfterPct: number; ttrTicks: number | null; tradeoffs: string[] }>;
  recommendedStrategy: string | null;
  sampleLogs: string[];
  label: string;
}
