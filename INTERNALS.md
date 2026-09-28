# AIGovAssessmentPrefill — Internals

Maintainer's guide to the Script Include. Every method, what it does, what it
returns, and why it exists.

Scope: `x_1675350_aict_a_0` · 27 methods · 3 public

- [Call flow](#call-flow)
- [Public methods](#public-methods)
- [Resolution](#resolution)
- [Question metadata](#question-metadata)
- [State checks](#state-checks)
- [Conditions and drivers](#conditions-and-drivers)
- [The write path](#the-write-path)
- [Utilities](#utilities)
- [Instance state](#instance-state)
- [Where to change things](#where-to-change-things)

---

## Call flow

### GET — `getTaskQuestions`

```
getTaskQuestions
├── _getTask                     number or sys_id → task GlideRecord
├── _getInstance                 task → assessment instance sys_id
│   └── _instanceFromScopeRecord      scope_item → m2m → instance
└── for each question_instance
    ├── _questionMeta            type, readonly, mandatory  (cached)
    ├── _isAutomated             → counts.automated
    ├── _responseField           null → counts.not_prefillable
    ├── _isApplicable            false → counts.not_applicable
    ├── _isAnswered              true → counts.already_answered
    ├── _isChoiceType
    ├── _options                 valid option labels, from the cached index
    │   └── _optionIndex         built once: two queries for the assessment
    └── _publicType              the label the API exposes
```

Nothing is written on this path.

### POST — `prefill`

```
prefill
├── _getTask
├── _getInstance
├── (assessment workflow state gate — inline)
├── _questionMap                 normalised text → question_instance sys_id
│   └── _norm
├── _driverQuestionInstances     which questions other questions depend on
├── _apply (driver batch)
├── _reevaluate                  recompute visibility
└── _apply (remaining batch)

_apply  (per answer)
├── _norm → map lookup           miss → unmatched
├── _questionMeta
├── _isAutomated                 → skipped_automated
├── _responseField / readonly    → skipped_not_prefillable
├── _isApplicable                → skipped_not_applicable
├── _isAnswered                  → skipped_already_answered
├── (justification check)        → rejected
└── _write
    ├── _writeChoice   ── _optionIndex, _norm, _update
    └── _writeValue    ── _responseField, _validate, _update
```

`_update` is the only method that persists anything.

---

## Public methods

### `getTaskQuestions(taskRef, includeAnswered)`

| Param | Type | Notes |
|---|---|---|
| `taskRef` | string | Governance task number or 32-char sys_id |
| `includeAnswered` | boolean | Optional. `true` also returns answered questions |

Returns `{success, task, task_state, instance, counts, questions[], visibility_note?}`
or `{success: false, error, questions: []}`.

Walks every question instance on the assessment and sorts it into one of five
buckets. Only `open` questions are returned by default. `counts` always
accounts for every question, so the five numbers sum to the total.

Sets `visibility_note` when `counts.not_applicable > 0`, because those
questions may open up once a driver is answered.

### `prefill(taskRef, answers, opts)`

| Param | Type | Notes |
|---|---|---|
| `taskRef` | string | Task number or sys_id |
| `answers` | array | `{question, value \| options[], justification, source?, driver?}` |
| `opts` | object | `{dry_run, correlation_id}` |

Returns the reconciliation report. `success: true` means the call ran — it does
**not** mean every answer was written. Per-question failures are in `rejected`.

Order of operations matters:

1. Resolve the task and instance; bail if either fails
2. Gate on the **assessment** workflow state (completed/cancelled), not task state
3. Build the text → question map
4. Split answers into driver and non-driver batches
5. Write drivers, recompute conditions, write the rest

Step 5 is why a single call can fill questions that were hidden when it started.

### `diagnose(taskRef)`

Build-time helper, no writes. Returns the resolution chain step by step, which
route resolved (`resolved_via`), the assessment details, a count of question
types in use, whether the AI Assist plugin is active, and `_accessCheck()`.

**Run as the integration user, not admin** — admin masks cross-scope
restrictions entirely, so a clean report as admin proves nothing.

---

## Resolution

### `_getTask(ref)` → GlideRecord | null

Accepts either a task number or a sys_id, detected by a 32-hex-char regex.
Returns a GlideRecord positioned on the task, or null.

### `_getInstance(taskGR)` → string | null

Finds the assessment instance for a governance task. Tries two routes and
records which worked in `this._lastRoute`:

| Route | Meaning |
|---|---|
| `governance_task` | Scope item points at the governance task directly |
| `related_record` | Scope item points at the AI system task it references |

On the tested instance, `related_record` is the live route — scope items sit on
`sn_grc_ai_gov_ai_system_task`, not on the governance task. Route one is kept
as a cheap fallback in case that differs elsewhere.

### `_instanceFromScopeRecord(recordSysId)` → string | null

The actual two-hop query:

```
sn_smart_asmt_scope_item WHERE record = <sys_id>
  └── sn_smart_asmt_m2m_instance_scope_item WHERE scope_item = <that>
        ORDER BY sys_updated_on DESC, LIMIT 1
        → assessment_instance
```

Takes the most recently updated link, so a re-assessed record resolves to its
current assessment.

### `_questionMap(instanceId, r)` → object

Builds `{normalised question text: question_instance sys_id}` in one query.

Collision handling matters: if two questions normalise to the same text, the
entry becomes the sentinel `'__AMBIGUOUS__'` and the question text is pushed to
`r.ambiguous`. `_apply` skips those, so neither question is written. Silently
picking the first would land an answer on the wrong question.

---

## Question metadata

### `_questionMeta(defSysId)` → object

Reads `sn_smart_asmt_question` once per definition and caches on
`this._meta`. Returns:

| Field | Source | Notes |
|---|---|---|
| `typeId` | `question_type` | **A reference, not a string field named `type`** |
| `enableTime` | `enable_time` | Date vs date-time |
| `readonly` | `readonly_response` | Excluded from prefill |
| `mandatory` | `mandatory` | Static definition value |
| `multi` | derived | True when type is checkbox |

The `question_type` gotcha is worth flagging: an earlier version read a field
called `type`, got null, and fell back to writing everything into
`text_response`. Dates and numbers would have landed in a text column silently.

### `_responseField(meta)` → string | null

Maps question type to the column holding its answer. Mirrors
`AssessmentInstanceUtilSNC._getFieldContainingResponse`.

| Type | Column |
|---|---|
| Radio, Dropdown, Checkbox | `selected_response_options` |
| Number | `number_response` |
| Reference | `reference_response_record` |
| Textbox, Barcode | `text_response` |
| Calendar | `date_response` / `date_time_response` |
| Attachment, unknown | `null` |

`null` means the question cannot be prefilled at all, which is how attachment
questions get excluded.

### `_isChoiceType(meta)` → boolean

True for radio, dropdown and checkbox. Decides which write path runs.

### `_publicType(meta)` → string

Translates the internal type sys_id into the label the API exposes:
`choice`, `text`, `number`, `date`, `date_time`, `reference`, `attachment`,
`unknown`. Consumers never see sys_ids.

---

## State checks

### `_isAutomated(qGR)` → boolean

Reads `is_automated_response`. True means the platform's Automate Response owns
this question — typically the hidden driver questions used to drive conditional
visibility from record data. Writing to one fights the engine and can cascade
into other automated answers.

### `_isAnswered(qGR, meta)` → boolean

Two checks, in order:

1. `is_responded == '1'` — set when a response saves, cleared when removed
2. The **one** column this question type uses, via `_responseField`

Attachment questions check `attachment_count > 0` instead.

Checking only the type's own column is deliberate. An earlier version scanned
all six response columns, and since `currency_response` defaults to `"0"` on
every row, every question read as answered and the endpoint did nothing. This
mirrors `AssessmentInstanceUtilSNC._checkResponsePopulatedBasedOnQuestionType`.

### `_isApplicable(qGR)` → boolean

Conditional visibility, read from the engine's stored result:

```
question_instance.visibility_result
  → sn_smart_asmt_condition_result_set.result    1 = visible, 0 = hidden
```

No `visibility_result` means no condition, so the question is always visible.

Two design choices:

- **Cached** on `this._visCache`. Several questions typically share one result
  set — on the test instance all five hidden questions pointed at the same row.
- **Fails open.** A dangling reference is treated as visible. For a prefill
  that is the safe direction: worst case we offer a question that is hidden,
  and the owner sees the answer when it appears. Failing closed would silently
  drop questions with no signal to the caller.

### `_validate(value, meta)` → string | null

Returns a reason when invalid, null when fine. **Only checks date columns.**

Everything else is the platform's job — its before-update business rules
(`Validate text response`, `Validate number response`, `Validate reference
response`) abort a bad value, which surfaces as `platform_refused`. Choice
answers are validated by option-label matching in `_writeChoice`.

Dates are the exception because a malformed value can be stored empty rather
than refused, which would look like a successful write.

---

## Conditions and drivers

### `_driverQuestionInstances(instanceId)` → object

Returns `{question_instance sys_id: true}` for every question that some
condition tests — the drivers.

```
question_instance WHERE visibility_result IS NOT NULL
  → collect distinct visibility_result ids
     → condition_result WHERE condition_result_set IN (those)
                          AND table = 'sn_smart_asmt_question_instance'
        → record         ← the driver question instance
```

This exists so the caller never has to declare which questions are drivers.
They cannot know the template's conditional logic, and asking them to would be
the same mistake as asking them to evaluate visibility themselves. An explicit
`driver: true` on an answer still forces the first pass, as an override.

### `_reevaluate(batch, map, r)` → void

Calls `sn_smart_asmt.SmartAsmtCommonUtils.reevaluateConditionsForConditionSet`
for each question written in the driver batch. That recomputes
`condition_result_set.result`, so questions revealed by those answers become
writable in the second `_apply` pass.

Best effort by design. If the class is unreachable cross-scope it records
`r.reevaluation = 'unavailable: ...'` and continues — dependent questions
simply stay hidden for this call and the caller can re-run. A failure here
should never fail the whole prefill.

Skipped entirely on a dry run.

---

## The write path

### `_apply(batch, map, r)` → void

The main loop. Per answer: normalise, look up, re-fetch the question instance
fresh, run the four skip checks, check justification, write. Mutates the report
object `r` as it goes.

Re-fetching rather than reusing a cached GlideRecord matters — the second pass
must see changes the first pass made.

### `_write(qGR, ans, meta, r)` → boolean

One-line branch on `_isChoiceType`.

### `_writeChoice(qGR, ans, meta, r)` → boolean

Handles radio, dropdown and checkbox.

1. Read this question's options from `_optionIndex` (already cached)
2. Resolve every requested label; any miss → `rejected` with `valid_options`
3. Single-select given more than one option → `rejected` with `cardinality`
4. Dry run stops here, recording to `planned`
5. **`_update` with `selected_response_options`** = the definition sys_ids
6. Mirror onto the option instances: `is_option_selected = true` on each target
7. Single-select: clear `is_option_selected` on the siblings

**Both storage locations are written**, because the platform writes both. The
list field on the question instance is what the form reads; the per-option
booleans are what report and PDF code reads.

**Order matters.** The authoritative field goes first. If step 5 is refused,
nothing has been touched. If the mirror in 6–7 then fails, the answer is still
correctly recorded and the report carries a `warnings` entry rather than
unwinding a good write.

Writing the mirror first — which is what an earlier version did — could leave
options visibly ticked on the form with no recorded answer, since
`is_responded` and `selected_response_options` are both set inside `_update`.
`_isAnswered` would then report that question as unanswered while the form
showed it filled in.

Step 5 takes the `sn_smart_asmt_response_option` sys_id, not the
`sn_smart_asmt_response_option_instance` one. Easy to get wrong.

### `_writeValue(qGR, ans, meta, r)` → boolean

Everything non-choice. Resolves the column, validates, then `_update`. Simpler
because there is exactly one place to write.

### `_update(qGR, field, value, ans, r)` → boolean

**The only method that persists anything.** Sets, in one update:

- `justification` — `[AI-PREFILL] (source) <caller's justification>`
- `is_responded` (when `MARK_RESPONDED`)
- `last_responded_by`, `last_responded_on`
- the response column itself, via the platform

The write goes through
`sn_smart_asmt.AssessmentInstanceUtil.updateQuestionInstance(qGR, field, value, isAI)`
rather than a raw `update()`. That gives us the platform's state assertion and
error handling, and makes the write behave like a form answer.

The utility **throws** `{message, status}` on refusal rather than returning
false. Caught and turned into a `platform_refused` rejection carrying the
platform's own message.

If the class is unreachable (thrown without a `.message`), it logs a warning
and falls back to a direct `setValue` + `update`.

`isAI` is `CFG.MARK_AI_SUGGESTED`, deliberately `false` — see the README.

---

## Utilities

### `_optionIndex(instanceId)` → object

Every option on the assessment, keyed by question instance:

```
{ <question_instance sys_id>: [ { label, instance, definition, selected } ] }
```

Two queries, cached on the call for the life of the request. Pass 1 reads the
option instances for the assessment and collects the definition sys_ids in use;
pass 2 reads the labels for just those definitions. Nothing is dot-walked.

The shape it replaced ran one query per question and dot-walked
`assessment_response_option.text_label` per option row — 22 queries plus 66
lookups on a 22-question template, repeated inside every write. Invalidated
(`this._optIdx = null`) after a choice write, since the `selected` flags go
stale.

### `_options(questionInstanceId, instanceId)` → string[]

Option labels for one question, in `order`, read from the index. Used by the
GET so the caller only ever sends a label that will match.

### `_norm(s)` → string

The normaliser behind all text matching. Strips HTML tags, decodes entities,
collapses non-breaking spaces, folds smart quotes and en/em dashes to ASCII,
collapses whitespace, trims, lowercases.

Applied to **both** sides of every comparison — question text and option
labels. Most "identical" strings that fail to match differ by a `&nbsp;` or a
curly apostrophe nobody can see.

It deliberately does **not** strip punctuation or normalise wording. A reworded
question should surface in `unmatched`, not be fuzzy-matched to something else.

### `_accessCheck()` → object

Per-table `valid` / `read` / `write` for all eight tables, plus reachability of
the two platform Script Includes, plus `_running_as`.

Exists because in a scoped application a blocked table returns zero rows on
read and throws on write — indistinguishable from "no data" without this.

---

## Instance state

Set in `initialize`, or during a call:

| Property | Set in | Purpose |
|---|---|---|
| `CFG` | initialize | Behaviour flags |
| `T` | initialize | Table names |
| `QT` | initialize | Question type sys_ids, from system properties |
| `WF` | initialize | Completed/cancelled workflow state sys_ids |
| `_meta` | `_questionMeta` | Per-definition metadata cache |
| `_visCache` | `_isApplicable` | Condition result cache; reset per `prefill` |
| `_optIdx` | `_optionIndex` | Option index; cleared after a choice write |
| `_optIdxFor` | `_optionIndex` | Instance the index was built for |
| `_dry` | `prefill` | Dry run flag |
| `_cid` | `prefill` | Correlation id for this run |
| `_lastRoute` | `_getInstance` | Which resolution route worked |

`QT` and `WF` read the same `gs.getProperty` names the platform uses, with the
same defaults. If ServiceNow changes a question type sys_id, both follow.

**Not thread-safe across calls.** `_dry`, `_cid`, `_visCache` and `_optIdx` are
per-call state on the instance. Create a new `AIGovAssessmentPrefill()` per request —
the REST resources already do.

---

## Where to change things

| To do this | Change |
|---|---|
| Support a new question type | `QT`, `_responseField`, `_publicType`, and `_isAnswered` if it stores answers unusually |
| Change which questions are skipped | `_isAutomated`, `_isApplicable`, `_isAnswered`, or the `readonly` check in `_apply` |
| Change the provenance marker | `CFG.PROVENANCE_MARKER`, written in `_update` |
| Allow overwriting (do not) | The `_isAnswered` check in `_apply` |
| Add a new rejection reason | Push to `r.rejected` and document the enum in `openapi.json` |
| Change text matching tolerance | `_norm` — but read the note about not fuzzy-matching first |
| Turn off condition recomputation | `CFG.REEVALUATE_CONDITIONS` |

### Platform dependencies

If either becomes unreachable, the code degrades rather than failing:

| Class | Used for | Fallback |
|---|---|---|
| `sn_smart_asmt.AssessmentInstanceUtil` | The write itself | Direct `GlideRecord.update()` |
| `sn_smart_asmt.SmartAsmtCommonUtils` | Condition recomputation | Skipped; reported in `reevaluation` |

`diagnose` reports both under `access._AssessmentInstanceUtil` and
`access._SmartAsmtCommonUtils`.

### Tables touched

| Table | Access |
|---|---|
| `sn_ai_governance_assessment_task` | read |
| `sn_smart_asmt_scope_item` | read |
| `sn_smart_asmt_m2m_instance_scope_item` | read |
| `sn_smart_asmt_instance` | read |
| `sn_smart_asmt_question` | read |
| `sn_smart_asmt_condition_result_set` | read |
| `sn_smart_asmt_condition_result` | read |
| `sn_smart_asmt_question_instance` | **read + write** |
| `sn_smart_asmt_response_option_instance` | **read + write** |

Only the last two need write access. If either shows `write: false` in
`diagnose`, prefill cannot work regardless of what else is configured.
