import type { Platform, PublicationFormat } from "./model.js";
import type { UiLocator } from "./platform-ui.js";

export interface SemanticInteractiveElement {
  index: number;
  tag: string;
  role?: string;
  name: string;
  type?: string;
  href?: string;
  checked?: boolean;
  selected?: boolean;
  disabled: boolean;
}

export interface SemanticSurfaceSnapshot {
  capturedAt: string;
  platform: Platform;
  format: PublicationFormat;
  stepKey: string;
  currentUrl: string;
  title: string;
  elements: readonly SemanticInteractiveElement[];
}

export interface SurfaceAgentRequest {
  schemaVersion: 1;
  objective: "LOCATE_SAFE_UI_STEP";
  stepKey: string;
  action: "CLICK" | "SET_FILE" | "FILL" | "FINAL_BOUNDARY";
  safety: {
    finalActionMayBeLocated: true;
    finalActionMayBeInvoked: false;
    credentialsIncluded: false;
    inputValuesIncluded: false;
  };
  builtInCandidates: readonly UiLocator[];
  snapshot: SemanticSurfaceSnapshot;
}

export interface SurfaceAgentProposal {
  schemaVersion: 1;
  stepKey: string;
  locators: readonly UiLocator[];
  rationale: string;
}

export interface SurfaceAgentPort {
  propose(request: SurfaceAgentRequest): Promise<SurfaceAgentProposal | null>;
}
