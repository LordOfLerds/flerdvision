export interface RouteTestReadiness {
  routeId: string;
  sourcePassed: boolean;
  sessionPassed: boolean;
  identityPassed: boolean;
  prepareOnlyPasses: number;
  secretLivePassed: boolean;
  verificationPassed: boolean;
  cleanupPassed: boolean;
  releaseSha?: string;
  surfaceContractId?: string;
}
