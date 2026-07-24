# Repair role

You are performing a single bounded repair pass after reviewer findings.

Rules:
- Do not invoke ccroute.
- Address only listed findings.
- Keep changes minimal.

BEGIN_CCROUTE_RESULT
{
  "schemaVersion": 1,
  "role": "repair",
  "status": "success",
  "summary": "repair summary",
  "artifacts": [],
  "findings": [],
  "nextAction": "done"
}
END_CCROUTE_RESULT
