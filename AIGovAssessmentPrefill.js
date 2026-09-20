// =============================================================================
// AIGovAssessmentPrefill
//
// Prefills unanswered questions on an AI governance assessment from an
// external source.
//
//   getTaskQuestions(taskRef, includeAnswered)  what this task still needs
//   prefill(taskRef, answers, opts)             write, or preview with dry_run
//   diagnose(taskRef)                           chain, types and access report
//
// Rules, in order of precedence:
//   1. never submits an assessment or changes task state
//   2. never overwrites an existing answer
//   3. never writes to a question the platform answers itself
//   4. never coerces a value to fit a type
// =============================================================================

var AIGovAssessmentPrefill = Class.create();

AIGovAssessmentPrefill.prototype = {

    initialize: function () {

        this.CFG = {
            // Mark the question answered so the value renders on the form.
            MARK_RESPONDED: true,

            // is_response_ai_suggested belongs to Now Assist Response Assist
            // and means the answer came from the platform's own suggestion
            // engine. Ours comes from an external system, so this stays false.
            MARK_AI_SUGGESTED: false,

            PROVENANCE_MARKER: '[AI-PREFILL]',
            REQUIRE_JUSTIFICATION: true,

            // Recompute visibility after writing a question others depend on,
            // so questions revealed by this call become writable in it.
            REEVALUATE_CONDITIONS: true,

            DEBUG: true,

            MAX_ANSWERS: 200
        };

        this.T = {
            TASK: 'sn_ai_governance_assessment_task',
            SCOPE_ITEM: 'sn_smart_asmt_scope_item',
            M2M: 'sn_smart_asmt_m2m_instance_scope_item',
            INSTANCE: 'sn_smart_asmt_instance',
            QUESTION_INST: 'sn_smart_asmt_question_instance',
            OPTION_INST: 'sn_smart_asmt_response_option_instance',
            QUESTION_DEF: 'sn_smart_asmt_question',
            OPTION_DEF: 'sn_smart_asmt_response_option',
            RESULT_SET: 'sn_smart_asmt_condition_result_set'
        };

        // Same properties and defaults the platform uses.
        var p = function (name, dflt) { return gs.getProperty('sn_smart_asmt.' + name, dflt); };
        this.QT = {
            CALENDAR:   p('calender_question_type_id',   'a43696cb7771211058119a372e5a9989'),
            CHECKBOX:   p('checkbox_question_type_id',   'fb759e8b7771211058119a372e5a99b3'),
            DROPDOWN:   p('dropdown_question_type_id',   '28a59e8b7771211058119a372e5a99a5'),
            NUMBER:     p('number_question_type_id',     'bcc667b2ff2121104a47ffda03cb14a6'),
            RADIO:      p('radio_question_type_id',      'ec551e8b7771211058119a372e5a9921'),
            REFERENCE:  p('reference_question_type_id',  '0ad512cb7771211058119a372e5a99d2'),
            TEXTBOX:    p('textbox_question_type_id',    '2396e3b2ff2121104a47ffda03cb1428'),
            ATTACHMENT: p('attachment_question_type_id', '80669acb7771211058119a372e5a9936'),
            BARCODE:    p('barcode_question_type_id',    'b343af16ff0522106c23ffffffffff81')
        };

        this.WF = {
            COMPLETED: gs.getProperty('sn_smart_asmt.completed_workflow_state',
                                      'b0db445acb26211093b90cbfe8076d5a'),
            CANCELLED: gs.getProperty('sn_smart_asmt.cancelled_workflow_state',
                                      'f3db045acb26211093b90cbfe8076dc2')
        };

        this._meta = {};
        this._visCache = {};
    },

    // Mirrors AssessmentInstanceUtilSNC._getFieldContainingResponse.
    _responseField: function (meta) {
        switch (meta.typeId) {
            case this.QT.RADIO:
            case this.QT.CHECKBOX:
            case this.QT.DROPDOWN:   return 'selected_response_options';
            case this.QT.NUMBER:     return 'number_response';
            case this.QT.REFERENCE:  return 'reference_response_record';
            case this.QT.TEXTBOX:
            case this.QT.BARCODE:    return 'text_response';
            case this.QT.CALENDAR:   return meta.enableTime ? 'date_time_response'
                                                            : 'date_response';
            default:                 return null;     // attachment, or unknown
        }
    },

    _isChoiceType: function (meta) {
        return meta.typeId === this.QT.RADIO ||
               meta.typeId === this.QT.CHECKBOX ||
               meta.typeId === this.QT.DROPDOWN;
    },

    _publicType: function (meta) {
        if (this._isChoiceType(meta)) return 'choice';
        switch (meta.typeId) {
            case this.QT.NUMBER:     return 'number';
            case this.QT.REFERENCE:  return 'reference';
            case this.QT.CALENDAR:   return meta.enableTime ? 'date_time' : 'date';
            case this.QT.TEXTBOX:
            case this.QT.BARCODE:    return 'text';
            case this.QT.ATTACHMENT: return 'attachment';
            default:                 return 'unknown';
        }
    },

    _questionMeta: function (defSysId) {
        if (this._meta[defSysId]) return this._meta[defSysId];

        var meta = { typeId: null, enableTime: false, mandatory: null,
                     readonly: false, multi: false };

        var d = new GlideRecord(this.T.QUESTION_DEF);
        if (d.get(defSysId)) {
            meta.typeId     = d.getValue('question_type');
            meta.enableTime = (d.getValue('enable_time') + '') === 'true';
            meta.readonly   = (d.getValue('readonly_response') + '') === 'true';
            if (d.isValidField('mandatory'))
                meta.mandatory = (d.getValue('mandatory') == '1');
        }
        meta.multi = (meta.typeId === this.QT.CHECKBOX);

        this._meta[defSysId] = meta;
        return meta;
    },

    // =========================================================================
    // READ
    // =========================================================================
    getTaskQuestions: function (taskRef, includeAnswered) {
        var out = { success: false, questions: [] };

        var taskGR = this._getTask(taskRef);
        if (!taskGR) { out.error = 'task not found'; return out; }

        var instanceId = this._getInstance(taskGR);
        if (gs.nil(instanceId)) { out.error = 'no assessment instance for task'; return out; }

        var counts = { open: 0, already_answered: 0, not_applicable: 0,
                       automated: 0, not_prefillable: 0 };

        var qGR = new GlideRecord(this.T.QUESTION_INST);
        qGR.addQuery('assessment_instance', instanceId);
        qGR.orderBy('order');
        qGR.query();

        while (qGR.next()) {
            var meta = this._questionMeta(qGR.getValue('assessment_question'));

            if (this._isAutomated(qGR)) { counts.automated++; continue; }

            if (meta.readonly || !this._responseField(meta)) {
                counts.not_prefillable++;
                continue;
            }

            if (!this._isApplicable(qGR)) { counts.not_applicable++; continue; }

            var answered = this._isAnswered(qGR, meta);
            if (answered) {
                counts.already_answered++;
                if (!includeAnswered) continue;
            } else {
                counts.open++;
            }

            var entry = {
                question: qGR.getDisplayValue('assessment_question'),   // match key
                answered: answered,
                type: this._publicType(meta),
                mandatory: meta.mandatory
            };
            if (this._isChoiceType(meta)) {
                entry.options = this._options(qGR.getUniqueValue());
                entry.select = meta.multi ? 'multiple' : 'single';
            }
            out.questions.push(entry);
        }

        out.success = true;
        out.task = taskGR.getValue('number');
        out.task_state = taskGR.getValue('state');
        out.instance = instanceId;
        out.counts = counts;

        if (counts.not_applicable)
            out.visibility_note = counts.not_applicable + ' question(s) are hidden by ' +
                'a condition that is not currently met.';

        return out;
    },

    // =========================================================================
    // WRITE
    //   answers: [ { question, value | options[], justification, source, driver } ]
    //   opts:    { dry_run, correlation_id }
    // =========================================================================
    prefill: function (taskRef, answers, opts) {
        opts = opts || {};
        this._dry = (opts.dry_run === true);
        this._cid = opts.correlation_id || gs.generateGUID();
        this._visCache = {};

        var r = {
            success: false, dry_run: this._dry, correlation_id: this._cid,
            prefilled: 0, skipped_already_answered: 0, skipped_not_applicable: 0,
            skipped_automated: 0, skipped_not_prefillable: 0,
            unmatched: [], ambiguous: [], rejected: [], planned: []
        };

        if (!answers || !answers.length) { r.error = 'answers array is empty'; return r; }
        if (answers.length > this.CFG.MAX_ANSWERS) { r.error = 'too many answers'; return r; }

        var taskGR = this._getTask(taskRef);
        if (!taskGR) { r.error = 'task not found'; return r; }
        r.task = taskGR.getValue('number');

        var instanceId = this._getInstance(taskGR);
        if (gs.nil(instanceId)) { r.error = 'no assessment instance for task'; return r; }
        r.instance = instanceId;

        // The platform gates on the assessment workflow state, not task state.
        var inst = new GlideRecord(this.T.INSTANCE);
        if (inst.get(instanceId)) {
            var st = inst.getValue('state') + '';
            if (st === this.WF.COMPLETED || st === this.WF.CANCELLED) {
                r.error = 'assessment is completed or cancelled';
                r.assessment_state = inst.getDisplayValue('state');
                return r;
            }
        }

        var map = this._questionMap(instanceId, r);

        // Answers to questions that other questions' visibility depends on
        // are written first. Which ones those are is discovered from the
        // condition results — the caller cannot know the conditional logic.
        // An explicit driver:true still forces the first pass.
        var drivers = this._driverQuestionInstances(instanceId);
        var first = [], rest = [];
        for (var i = 0; i < answers.length; i++) {
            var qid = map[this._norm(answers[i].question)];
            var isDriver = answers[i].driver === true ||
                           (qid && qid !== '__AMBIGUOUS__' && drivers[qid]);
            (isDriver ? first : rest).push(answers[i]);
        }
        r.drivers_detected = first.length;

        this._apply(first, map, r);

        // Re-evaluation between passes, so questions revealed by a driver
        // answer become writable within this same call.
        if (first.length && !this._dry && this.CFG.REEVALUATE_CONDITIONS) {
            this._reevaluate(first, map, r);
            this._visCache = {};
        }

        this._apply(rest, map, r);

        r.success = true;
        return r;
    },

    // Question instances that some condition tests. Answering one of these
    // can change another question's visibility.
    _driverQuestionInstances: function (instanceId) {
        var drivers = {};

        // the result sets in play on this assessment
        var sets = {};
        var q = new GlideRecord(this.T.QUESTION_INST);
        q.addQuery('assessment_instance', instanceId);
        q.addNotNullQuery('visibility_result');
        q.query();
        while (q.next()) sets[q.getValue('visibility_result')] = true;

        var ids = [];
        for (var s in sets) ids.push(s);
        if (!ids.length) return drivers;

        var cr = new GlideRecord('sn_smart_asmt_condition_result');
        cr.addQuery('condition_result_set', 'IN', ids.join(','));
        cr.addQuery('table', this.T.QUESTION_INST);
        cr.query();
        while (cr.next()) {
            var rec = cr.getValue('record');
            if (!gs.nil(rec)) drivers[rec] = true;
        }
        return drivers;
    },

    // Best effort. If unreachable, dependent questions stay hidden for this
    // call and the caller can re-run.
    _reevaluate: function (batch, map, r) {
        var util;
        try {
            util = new sn_smart_asmt.SmartAsmtCommonUtils();
        } catch (e) {
            r.reevaluation = 'unavailable: ' + e;
            return;
        }
        var done = 0;
        for (var i = 0; i < batch.length; i++) {
            var key = this._norm(batch[i].question);
            var qid = map[key];
            if (!qid || qid === '__AMBIGUOUS__') continue;
            try {
                util.reevaluateConditionsForConditionSet(qid);
                done++;
            } catch (e2) {
                gs.warn('[AIGovAssessmentPrefill] reevaluate failed for ' + qid + ': ' + e2);
            }
        }
        r.reevaluation = 'triggered for ' + done + ' question(s)';
    },

    _apply: function (batch, map, r) {
        for (var i = 0; i < batch.length; i++) {
            var ans = batch[i];
            var key = this._norm(ans.question);

            if (!key) { r.rejected.push({ question: '', reason: 'empty question text' }); continue; }
            if (!map[key]) { r.unmatched.push(ans.question); continue; }
            if (map[key] === '__AMBIGUOUS__') continue;

            var qGR = new GlideRecord(this.T.QUESTION_INST);
            if (!qGR.get(map[key])) { r.unmatched.push(ans.question); continue; }

            var meta = this._questionMeta(qGR.getValue('assessment_question'));

            if (this._isAutomated(qGR)) { r.skipped_automated++; continue; }
            if (meta.readonly || !this._responseField(meta)) {
                r.skipped_not_prefillable++; continue;
            }
            if (!this._isApplicable(qGR)) { r.skipped_not_applicable++; continue; }
            if (this._isAnswered(qGR, meta)) { r.skipped_already_answered++; continue; }

            if (this.CFG.REQUIRE_JUSTIFICATION && gs.nil(ans.justification)) {
                r.rejected.push({ question: ans.question, reason: 'justification_required' });
                continue;
            }

            if (this._write(qGR, ans, meta, r)) r.prefilled++;
        }
    },

    _write: function (qGR, ans, meta, r) {
        return this._isChoiceType(meta) ? this._writeChoice(qGR, ans, meta, r)
                                        : this._writeValue(qGR, ans, meta, r);
    },

    // A choice answer lives in two places and the platform writes both:
    // question_instance.selected_response_options (definition option sys_ids),
    // and is_option_selected on each option instance.
    _writeChoice: function (qGR, ans, meta, r) {
        var wanted = ans.options || (gs.nil(ans.value) ? [] : [ans.value]);
        if (!wanted.length) {
            r.rejected.push({ question: ans.question, reason: 'type_mismatch',
                              expected: 'choice', detail: 'no option supplied' });
            return false;
        }

        var byLabel = {}, valid = [];
        var oGR = new GlideRecord(this.T.OPTION_INST);
        oGR.addQuery('question_instance', qGR.getUniqueValue());
        oGR.query();
        while (oGR.next()) {
            var label = this._optionLabel(oGR);
            byLabel[this._norm(label)] = { instance: oGR.getUniqueValue(),
                                           definition: oGR.getValue('assessment_response_option') };
            valid.push(label);
        }

        var targets = [], defIds = [];
        for (var w = 0; w < wanted.length; w++) {
            var hit = byLabel[this._norm(wanted[w])];
            if (!hit) {
                r.rejected.push({ question: ans.question, reason: 'invalid_option',
                                  received: wanted[w], valid_options: valid });
                return false;
            }
            targets.push(hit.instance);
            defIds.push(hit.definition);
        }

        if (!meta.multi && targets.length > 1) {
            r.rejected.push({ question: ans.question, reason: 'cardinality',
                              detail: 'single select received ' + targets.length + ' options' });
            return false;
        }

        if (this._dry) {
            r.planned.push({ question: ans.question, options: wanted, type: 'choice',
                             field: 'selected_response_options' });
            return true;
        }

        for (var t = 0; t < targets.length; t++) {
            var sel = new GlideRecord(this.T.OPTION_INST);
            if (!sel.get(targets[t])) continue;
            sel.setValue('is_option_selected', true);
            sel.update();
        }

        // single select: clear the siblings, as the platform does
        if (!meta.multi && targets.length === 1) {
            var others = new GlideRecord(this.T.OPTION_INST);
            others.addQuery('question_instance', qGR.getUniqueValue());
            others.addQuery('sys_id', '!=', targets[0]);
            others.setValue('is_option_selected', false);
            others.updateMultiple();
        }

        if (!this._update(qGR, 'selected_response_options', defIds.join(','), ans, r))
            return false;

        this._log(qGR, ans, wanted.join(', '), r);
        return true;
    },

    _writeValue: function (qGR, ans, meta, r) {
        if (gs.nil(ans.value)) {
            r.rejected.push({ question: ans.question, reason: 'no value supplied' });
            return false;
        }

        var field = this._responseField(meta);
        var problem = this._validate(ans.value, meta);
        if (problem) {
            r.rejected.push({ question: ans.question, reason: 'type_mismatch',
                              expected: this._publicType(meta), detail: problem });
            return false;
        }

        if (this._dry) {
            r.planned.push({ question: ans.question, value: ans.value,
                             type: this._publicType(meta), field: field });
            return true;
        }

        if (!this._update(qGR, field, ans.value, ans, r)) return false;

        this._log(qGR, ans, ans.value, r);
        return true;
    },

    // The only place that writes. Routes through the platform utility so the
    // state assertion and AI flag are the platform's; falls back to a direct
    // write if that class is unreachable cross-scope.
    _update: function (qGR, field, value, ans, r) {
        // justification and provenance first, so one update carries everything
        if (qGR.isValidField('justification')) {
            var j = this.CFG.PROVENANCE_MARKER + ' ';
            if (!gs.nil(ans.source)) j += '(' + ans.source + ') ';
            j += (gs.nil(ans.justification) ? '' : ans.justification);
            qGR.setValue('justification', j.substring(0, 4000));
        }
        if (this.CFG.MARK_RESPONDED) qGR.setValue('is_responded', true);
        qGR.setValue('last_responded_by', gs.getUserID());
        qGR.setValue('last_responded_on', new GlideDateTime().getValue());

        try {
            new sn_smart_asmt.AssessmentInstanceUtil()
                .updateQuestionInstance(qGR, field, value, this.CFG.MARK_AI_SUGGESTED);
            return true;
        } catch (e) {
            // the utility throws {message, status} for a refused response
            if (e && e.message) {
                r.rejected.push({ question: ans.question, reason: 'platform_refused',
                                  detail: String(e.message), status: e.status || null });
                return false;
            }
            gs.warn('[AIGovAssessmentPrefill] utility unavailable, writing direct: ' + e);
            qGR.setValue(field, value);
            return qGR.update() ? true : false;
        }
    },

    _log: function (qGR, ans, written, r) {
        if (!this.CFG.DEBUG) return;
        gs.info('[AIGovAssessmentPrefill] ' + this._cid + ' ' + r.task +
                ' | ' + qGR.getDisplayValue('assessment_question') +
                ' = ' + String(written).substring(0, 200) +
                ' | source: ' + (ans.source || 'unspecified'));
    },

    // =========================================================================
    // state checks
    // =========================================================================
    _isAutomated: function (qGR) {
        return qGR.getValue('is_automated_response') == '1';
    },

    // One column per question type. Scanning every column reads an unrelated
    // default as an answer: currency_response is "0" on every row.
    _isAnswered: function (qGR, meta) {
        if (qGR.getValue('is_responded') == '1') return true;

        if (meta.typeId === this.QT.ATTACHMENT)
            return parseInt(qGR.getValue('attachment_count'), 10) > 0;

        var field = this._responseField(meta);
        if (!field) return false;

        var v = qGR.getValue(field);
        return !(gs.nil(v) || v === '' || v === 'null');
    },

    // visibility_result -> condition_result_set.result. No result set means no
    // condition. A dangling reference fails open: offering a hidden question is
    // safer here than silently dropping one.
    _isApplicable: function (qGR) {
        var vr = qGR.getValue('visibility_result');
        if (gs.nil(vr)) return true;
        if (this._visCache[vr] !== undefined) return this._visCache[vr];

        var set = new GlideRecord(this.T.RESULT_SET);
        var visible = set.get(vr) ? (set.getValue('result') == '1') : true;
        this._visCache[vr] = visible;
        return visible;
    },

    // Validation is the platform's job — its before-update business rules
    // abort a bad value, surfacing as platform_refused. The exception is a
    // date column, where a malformed value can be stored empty not refused.
    _validate: function (value, meta) {
        if (meta.typeId !== this.QT.CALENDAR) return null;

        var v = String(value).trim();
        var ok = meta.enableTime
            ? /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(v)
            : /^\d{4}-\d{2}-\d{2}$/.test(v);

        return ok ? null : 'expected ' +
            (meta.enableTime ? 'YYYY-MM-DD HH:MM:SS' : 'YYYY-MM-DD') +
            ', received "' + v + '"';
    },

    // =========================================================================
    // resolution
    // =========================================================================
    _getTask: function (ref) {
        var gr = new GlideRecord(this.T.TASK);
        if (/^[0-9a-f]{32}$/i.test(ref)) return gr.get(ref) ? gr : null;
        gr.addQuery('number', ref);
        gr.setLimit(1);
        gr.query();
        return gr.next() ? gr : null;
    },

    // Scope items sit on the AI system task referenced by related_record,
    // not on the governance task itself. Both routes are tried.
    _getInstance: function (taskGR) {
        this._lastRoute = null;

        var id = this._instanceFromScopeRecord(taskGR.getUniqueValue());
        if (id) { this._lastRoute = 'governance_task'; return id; }

        if (taskGR.isValidField('related_record')) {
            var related = taskGR.getValue('related_record');
            if (!gs.nil(related)) {
                id = this._instanceFromScopeRecord(related);
                if (id) { this._lastRoute = 'related_record'; return id; }
            }
        }
        return null;
    },

    _instanceFromScopeRecord: function (recordSysId) {
        var s = new GlideRecord(this.T.SCOPE_ITEM);
        s.addQuery('record', recordSysId);
        s.query();
        while (s.next()) {
            var m = new GlideRecord(this.T.M2M);
            m.addQuery('scope_item', s.getUniqueValue());
            m.orderByDesc('sys_updated_on');
            m.setLimit(1);
            m.query();
            if (m.next()) return m.getValue('assessment_instance');
        }
        return null;
    },

    _questionMap: function (instanceId, r) {
        var map = {};
        var qGR = new GlideRecord(this.T.QUESTION_INST);
        qGR.addQuery('assessment_instance', instanceId);
        qGR.query();
        while (qGR.next()) {
            var text = qGR.getDisplayValue('assessment_question');
            var key = this._norm(text);
            if (!key) continue;
            if (map[key]) {
                if (map[key] !== '__AMBIGUOUS__') r.ambiguous.push(text);
                map[key] = '__AMBIGUOUS__';
                continue;
            }
            map[key] = qGR.getUniqueValue();
        }
        return map;
    },

    _options: function (questionInstanceId) {
        var labels = [];
        var oGR = new GlideRecord(this.T.OPTION_INST);
        oGR.addQuery('question_instance', questionInstanceId);
        oGR.orderBy('order');
        oGR.query();
        while (oGR.next()) labels.push(this._optionLabel(oGR));
        return labels;
    },

    _optionLabel: function (optionInstanceGR) {
        var label = optionInstanceGR.assessment_response_option.text_label + '';
        if (gs.nil(label) || label === 'undefined')
            label = optionInstanceGR.getDisplayValue('assessment_response_option');
        return label;
    },

    _norm: function (s) {
        if (s === null || s === undefined) return '';
        return String(s)
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"').replace(/&#3[49];/g, "'")
            .replace(/[   ]/g, ' ')
            .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
            .replace(/[–—]/g, '-')
            .replace(/\s+/g, ' ')
            .trim().toLowerCase();
    },

    // =========================================================================
    // DIAGNOSE
    // =========================================================================
    diagnose: function (taskRef) {
        var out = { task_ref: taskRef, steps: [], question_types: {} };

        var taskGR = this._getTask(taskRef);
        if (!taskGR) { out.steps.push('task NOT FOUND on ' + this.T.TASK); return out; }

        out.task = taskGR.getValue('number');
        out.task_sys_id = taskGR.getUniqueValue();
        out.task_state = taskGR.getValue('state');
        if (taskGR.isValidField('related_record'))
            out.related_record = taskGR.getValue('related_record');
        out.steps.push('task found');

        var instanceId = this._getInstance(taskGR);
        out.instance = instanceId;
        out.resolved_via = this._lastRoute;
        out.steps.push(instanceId ? 'instance resolved' : 'NO INSTANCE');

        if (instanceId) {
            var inst = new GlideRecord(this.T.INSTANCE);
            if (inst.get(instanceId)) {
                out.assessment_number = inst.getValue('number');
                out.assessment_state = inst.getDisplayValue('state');
                out.template = inst.getDisplayValue('assessment_template');
                out.template_id = inst.getValue('assessment_template');
            }

            var q = new GlideRecord(this.T.QUESTION_INST);
            q.addQuery('assessment_instance', instanceId);
            q.query();
            while (q.next()) {
                var m = this._questionMeta(q.getValue('assessment_question'));
                var label = this._publicType(m) + (m.readonly ? ' (readonly)' : '');
                out.question_types[label] = (out.question_types[label] || 0) + 1;
            }
        }

        out.ai_assist_plugin = GlidePluginManager.isActive('com.sn_smart_ai_assist');
        out.access = this._accessCheck();
        return out;
    },

    _accessCheck: function () {
        var access = { _running_as: gs.getUserName() };
        [this.T.TASK, this.T.SCOPE_ITEM, this.T.M2M, this.T.INSTANCE,
         this.T.QUESTION_INST, this.T.OPTION_INST, this.T.QUESTION_DEF,
         this.T.RESULT_SET].forEach(function (t) {
            var e = { valid: false, read: false, write: false };
            try {
                var gr = new GlideRecord(t);
                e.valid = gr.isValid();
                if (e.valid) { e.read = gr.canRead(); e.write = gr.canWrite(); }
            } catch (err) { e.error = String(err); }
            access[t] = e;
        });

        // the two classes the write path depends on
        try {
            new sn_smart_asmt.AssessmentInstanceUtil();
            access._AssessmentInstanceUtil = 'reachable';
        } catch (e1) { access._AssessmentInstanceUtil = 'UNREACHABLE: ' + e1; }
        try {
            new sn_smart_asmt.SmartAsmtCommonUtils();
            access._SmartAsmtCommonUtils = 'reachable';
        } catch (e2) { access._SmartAsmtCommonUtils = 'UNREACHABLE: ' + e2; }

        return access;
    },

    type: 'AIGovAssessmentPrefill'
};
