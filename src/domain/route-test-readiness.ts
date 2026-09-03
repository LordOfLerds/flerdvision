export interface RouteTestReadiness {
  routeId: string;
  sourcePassed: boolean;
  sessionPassed: boolean;
  identityPassed: boolean;
  prepareOnlyPasses: number;
  secretLivePassed: boolean;
  verificationPassed: boolean;
  cleanupPassed: boolean;
  /** Informational audit value; a differing release SHA alone never blocks execution. */
  releaseSha?: string;
  /** The surface fingerprint this readiness was proven against; missing means stale. */
  surfaceFingerprint?: string;
  surfaceContractId?: string;
}
