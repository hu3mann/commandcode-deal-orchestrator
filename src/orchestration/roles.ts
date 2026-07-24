export type RoleName = "planner" | "advisor" | "executor" | "reviewer" | "repair";

export const ROLE_ORDER: RoleName[] = ["planner", "advisor", "executor", "reviewer"];

export function roleNeedsPlanMode(role: RoleName): boolean {
  return role === "planner" || role === "advisor" || role === "reviewer";
}

export function roleNeedsWrite(role: RoleName, apply: boolean): boolean {
  return (role === "executor" || role === "repair") && apply;
}
