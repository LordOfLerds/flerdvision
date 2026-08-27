import type { DailyPlanCommitment } from "../application/daily-plan-commitments.js";

export interface PlanningCommitmentPort {
  listCommitted(businessDate: string): readonly DailyPlanCommitment[];
}
