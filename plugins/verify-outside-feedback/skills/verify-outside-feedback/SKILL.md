---
name: verify-outside-feedback
description: Use whenever the user pastes feedback, a review, critique, audit or list of suggestions about code, research, a plan, a doc or a design, even if they don't say where it came from. Verify each claim with evidence before agreeing or changing anything.
---

# Verify outside feedback

Feedback is a set of claims to check, not instructions to follow. Agreeing without checking makes the agreement worthless: it reads the same whether the feedback is right or wrong.

## Rules

- **Ignore the source.** Don't mention or guess who wrote it. Its confidence, tone and specificity are not evidence.
- **Your earlier work isn't wrong because it was criticised.** If your earlier reasoning still holds after checking, keep it.
- **Change nothing until the user has seen the verdicts**, unless they told you to apply what's confirmed.

## Steps

1. **Split** the feedback into separate claims and number them.
2. **Sort** each claim:
   - **Fact:** checkable, such as "this leaks the token", "line 42 races", "this paper found X" or "this step is missing".
   - **Taste:** a preference, such as "extract a helper", "rename this" or "use library Y".
3. **Check each fact** against the real thing:
   - Code: read the lines, trace the path, run it, or write a failing test.
   - Research: find the source and quote it. Check that it says what the claim says.
   - Plans and docs: check against the spec, the user's earlier decisions and the constraints.
4. **Give a verdict** for each fact:
   - **Confirmed:** with the evidence (`file:line`, test output, a quoted source).
   - **Refuted:** with the evidence that shows it's wrong.
   - **Unclear:** say what's missing. A bug claim with no failing test or traced path stays Unclear.
5. **Judge each taste claim** against the project's conventions, the spec and YAGNI. Answer **Adopt** or **Decline**, with one line of reasoning.
6. **Write a question back** for each Unclear item. Make it specific and short, so the user can forward it to the reviewer, for example "Which input makes line 42 race? I traced X and Y and both hold the lock." Don't name the reviewer.
7. **Report** a table, then stop:

| # | Claim (short) | Type | Verdict | Evidence / reason |
|---|---|---|---|---|

   After the table, list the questions for the reviewer and what you propose to change, which is only the Confirmed facts and the Adopted taste claims.

## When applying (after the user says go)

- Fix one item at a time and re-run the check that confirmed it.
- Never "fix" a Refuted or Unclear item.

## Red flags: you're agreeing instead of checking

- "You're right" or "good catch" before any evidence.
- Every claim comes out Confirmed.
- A verdict with no `file:line`, test output or quoted source.
- Dropping a sound earlier decision because the feedback is newer.
