# AICT Assessment Prefill

A REST API that lets an external system prefill answers on an AI Control Tower
governance assessment, so a human reviews and submits rather than typing from
scratch.

**Status: proof of concept.** Built and validated on a PDI. Not production
hardened — see [Before production](#before-production).

---

## Contents

| File | What it is | For |
|---|---|---|
| `README.md` | This document — what it does and how to use it | Anyone |
| `openapi.json` | Full API spec with schemas and examples | API consumers |
| `INTERNALS.md` | Method-by-method reference | Whoever maintains it |
| `AIGovAssessmentPrefill.js` | Script Include — all the logic | — |

Scope: `x_1675350_aict_a_0` ("AICT agents")
Base path: `/api/x_1675350_aict_a_0/prefill`

---

## How it works

An AI Control Tower governance task has one smart assessment. The API resolves
that assessment, tells you which questions still need answering, and writes
answers back.

### The resolution chain

```
sn_ai_governance_assessment_task          the task the caller names
        │ related_record  (document_id)
        ▼
sn_grc_ai_gov_ai_system_task              the AI system task
        │
sn_smart_asmt_scope_item.record           scope item points here
        │
sn_smart_asmt_m2m_instance_scope_item     link table
        │
sn_smart_asmt_instance                    the assessment
        │
sn_smart_asmt_question_instance           the questions
```

Scope items sit on the **AI system task**, not the governance task, so
resolution hops through `related_record`. Both routes are attempted and
`diagnose` reports which one worked (`resolved_via`).

### Questions are matched by text

There is no stable question code on the platform tables and we did not add one.
The caller sends back the exact question text it received from the GET. Both
sides are normalised before comparison — markup, HTML entities, non-breaking
spaces, smart quotes and dashes are all flattened — but wording is not.

This is why the caller should **GET immediately before POSTing** rather than
caching. A reworded question then appears in `unmatched` instead of silently
going unfilled.

If two questions on one assessment normalise to identical text, neither is
written and both are reported in `ambiguous`.

---

## The four rules

These are properties of the API, not configuration.

**1. Prefill only.** Never submits an assessment, never changes task state. A
human owner still completes and submits.

**2. Never overwrites.** A question already answered — by a person or by the
platform's Automate Response — is skipped and counted, never updated.

**3. Never touches automated questions.** Anything with
`is_automated_response` is owned by the assessment engine.

**4. Never coerces.** A value that does not match the question type is
rejected, not reshaped.

Why this matters: when an assessment closes,
`processDataOnAssessmentClosure` turns its answers into risk statements and
control objectives. Prefilled content propagates into GRC records, so the
guarantees are not cosmetic.

---

## Where answers are stored

Worth knowing, because it is not obvious and the first implementation got it
wrong.

**Choice questions** (radio, dropdown, checkbox) store the answer in **two**
places, and the platform writes both:

| Location | What it holds |
|---|---|
| `question_instance.selected_response_options` | glide_list of **definition** option sys_ids |
| `response_option_instance.is_option_selected` | per-option boolean |

Writing only the second saves the answer without it appearing on the form.
Note the list takes the *definition* option sys_id
(`sn_smart_asmt_response_option`), not the instance one.

`selected_response_options` is written **first**, because it is the
authoritative field — the per-option booleans mirror it. If the mirror then
fails, the answer is still correctly recorded and the response carries a
`warnings` entry. Writing the mirror first would leave options visibly ticked
with no recorded answer, which `_isAnswered` would then report as unanswered.

**Everything else** uses one column, chosen by question type:

| Question type | Column |
|---|---|
| Textbox, Barcode | `text_response` |
| Number | `number_response` |
| Calendar | `date_response`, or `date_time_response` when `enable_time` |
| Reference | `reference_response_record` |
| Radio / Dropdown / Checkbox | `selected_response_options` |
| Attachment | *(not prefillable)* |

The type lives in `sn_smart_asmt_question.question_type` — a reference, not a
string field called `type`. The mapping mirrors
`AssessmentInstanceUtilSNC._getFieldContainingResponse` and reads the same
system properties, so it follows the platform if those change.

---

## Query cost

Options for the whole assessment are read in two queries and cached per call —
one for the option instances, one for the labels of just the definitions in
use. The earlier shape ran a query per question plus a dot-walk per option row,
and repeated it inside every write.

---

## Conditional visibility

Questions can be hidden until another question is answered a particular way.
The evaluated result is stored, so we read it rather than re-implementing the
condition engine:

```
question_instance.visibility_result
        ▼
sn_smart_asmt_condition_result_set.result     boolean: 1 visible, 0 hidden
```

No `visibility_result` means the question has no condition. A dangling
reference is treated as visible — for a prefill, offering a hidden question is
safer than silently dropping one.

### Driver questions

A question whose answer controls others' visibility is a *driver*. The caller
cannot know which those are, so the API works it out: `condition_result.record`
names the question instance each condition tests.

Answers to drivers are written first, then
`SmartAsmtCommonUtils.reevaluateConditionsForConditionSet` is called, which
recomputes visibility. Questions revealed by that become writable **in the same
call**. The response reports `drivers_detected` and `reevaluation`.

Observed behaviour on a real assessment:

```
before   open 15   answered 2   not_applicable 5
POST     prefilled 2, reevaluation triggered for 1
after    open 18   answered 4   not_applicable 0
```

---

## Script Include reference

`AIGovAssessmentPrefill`, in scope `x_1675350_aict_a_0`.

### `getTaskQuestions(taskRef, includeAnswered)`

`taskRef` is a governance task number or sys_id. Returns applicable, unanswered
questions with their exact text, type and valid option labels, plus `counts`.

Pass `includeAnswered = true` to also return answered questions, each with
`answered: true`.

### `prefill(taskRef, answers, opts)`

`answers` is an array of `{question, value|options, justification, source}`.
`opts` accepts `{dry_run, correlation_id}`.

Returns a reconciliation report: how many were written, how many were skipped
and why, and which failed.

### `diagnose(taskRef)`

Build-time helper. Reports the resolution chain, which route worked, the
question types the template uses, whether the AI Assist plugin is active, and a
per-table read/write access check including whether the two platform Script
Includes are reachable cross-scope.

Run this as the **integration user**, not as admin — admin masks cross-scope
restrictions entirely.

### Configuration

Flags on `this.CFG`:

| Flag | Default | Effect |
|---|---|---|
| `MARK_RESPONDED` | `true` | Sets `is_responded` so the value renders |
| `MARK_AI_SUGGESTED` | `false` | See note below |
| `PROVENANCE_MARKER` | `[AI-PREFILL]` | Prefixed to the justification |
| `REQUIRE_JUSTIFICATION` | `true` | Reject an answer with no stated basis |
| `REEVALUATE_CONDITIONS` | `true` | Recompute visibility after driver answers |
| `MAX_ANSWERS` | `200` | Payload ceiling |

No `gs.info` tracing: the response payload carries the full reconciliation, so
logging it again only duplicated it. `gs.error` remains on two genuine failure
paths.

**On `MARK_AI_SUGGESTED`:** `is_response_ai_suggested` belongs to Now Assist
Response Assist and means the answer came from the platform's own suggestion
engine. Ours comes from an external system, so setting it would be wrong on the
facts — and it is a no-op unless `com.sn_smart_ai_assist` is active. Left
`false` deliberately.

---

## Provenance

Every prefilled answer carries:

- `justification` prefixed `[AI-PREFILL] (source) <the caller's justification>`
- `last_responded_by` / `last_responded_on`
- `sys_updated_by` / `sys_updated_on`, and the `sys_audit` history if auditing
  is on for the table

All set server-side. A caller cannot assert otherwise.

Note that `justification` is user-editable, so a responder could overwrite the
marker. `sys_audit` retains the original.

---

## Writing through the platform

Writes go through `sn_smart_asmt.AssessmentInstanceUtil.updateQuestionInstance`
rather than a raw `GlideRecord.update()`. That gives us the platform's own
state assertion and error handling for free, and the write behaves the same as
a form answer. A refusal comes back as `platform_refused` with the platform's
message. If the class is unreachable cross-scope, it falls back to a direct
write and logs a warning.

Value validation is also the platform's job — its before-update business rules
abort a bad value. The one exception is a date column, where a malformed value
can be stored empty rather than refused, so the shape is checked locally.

---

## Client pattern

```
1. GET  /tasks/{task}/questions
2. Draft answers for the returned questions only
3. POST /tasks/{task}/prefill  with dry_run: true
4. Show planned + rejected to a human
5. On approval, POST with dry_run: false
6. Log the response. unmatched should be empty.
```

Re-running is safe. A second call reports everything under
`skipped_already_answered` and writes nothing.

If `not_applicable` was non-zero and you answered a driver, GET again — more
questions may now be open.

---

## Reading the response

Every question on the assessment lands in exactly one bucket:

```
open + already_answered + not_applicable + automated + not_prefillable = total
```

| Bucket | Meaning | Caller action |
|---|---|---|
| `open` | Applicable, unanswered, writable | These are the ones to answer |
| `already_answered` | A person or the engine got there first | None — correct behaviour |
| `not_applicable` | Hidden by an unmet condition | May open up after a driver answer |
| `automated` | Platform-owned | Stop sending these |
| `not_prefillable` | Read-only, or attachment type | Cannot be written by anyone |

And on the POST:

| Field | Meaning |
|---|---|
| `unmatched` | Text matched nothing — the GET and POST drifted apart |
| `ambiguous` | Duplicate wording on the assessment; neither written |
| `rejected` | Per-question validation failures; the rest still wrote |
| `planned` | Dry run only: exactly what would be written |

### Rejection reasons

| `reason` | Cause |
|---|---|
| `invalid_option` | Label not in the option set. `valid_options` lists what is accepted |
| `cardinality` | Several options sent to a single-select question |
| `justification_required` | `justification` missing or empty |
| `type_mismatch` | Value does not fit the type, or no option given for a choice question |
| `no value supplied` | Neither `value` nor `options` present |
| `platform_refused` | The platform's own validation aborted the write |

---

## Before production

This is a POC. Known gaps:

**Security**
- No ACLs yet. The `aict_prefill` role exists but is not enforced on the
  resources. Set *Requires authentication: true* and the required role on each
  resource before this leaves the PDI.
- Everything so far has been tested as **admin**. Cross-scope write access for
  a service account is unproven — run `diagnose` as the integration user.
- Basic auth is fine for a POC. Production should use OAuth 2.0, and if the
  consumer is a developer tool running on a laptop, per-user authorisation code
  flow rather than a shared credential.
- **Delete the `/diagnose` resource.** It exposes internal table structure.

**Untested paths**
- Only choice questions have been exercised. `text_response`,
  `number_response`, `date_response` and `reference_response_record` have never
  been written by this code.
- The `is_automated_response` exclusion has never fired — the test template has
  no automated questions.
- Multi-select (checkbox) questions untested; the test template is all
  single-select.

**Deployment**
- Cross-scope privileges (`sys_scope_privilege`) were auto-granted on the PDI.
  They are part of the application and must travel with it, or it fails on
  another instance with security errors.

**Operational**
- No rate limiting or idempotency key. Re-running is safe because of the
  never-overwrite rule, but there is no protection against a runaway caller
  beyond `MAX_ANSWERS`.
