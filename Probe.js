// probe_platform_refusal.js
// Background script, scope x_1675350_aict_a_0.
//
// Finds why sn_smart_asmt.AssessmentInstanceUtil.updateQuestionInstance throws
// "Unable to update question response" (406) for a text question while the same
// call succeeds for choice questions.
//
// Sections 1-3 are READ ONLY.
// Section 4 writes, and only when you set TRY_DIRECT_WRITE = true.

var TASK      = 'TASK0350987';
var Q_CONTAINS = 'human autonomy is safeguarded';   // enough of the question to find it
var TEST_VALUE = 'Probe write test.';

var TRY_DIRECT_WRITE = false;      // set true for section 4

(function () {

    var T = {
        TASK:          'sn_ai_governance_assessment_task',
        SCOPE_ITEM:    'sn_smart_asmt_scope_item',
        M2M:           'sn_smart_asmt_m2m_instance_scope_item',
        INSTANCE:      'sn_smart_asmt_instance',
        QUESTION_INST: 'sn_smart_asmt_question_instance',
        QUESTION_DEF:  'sn_smart_asmt_question'
    };

    var log = [], say = function (s) { log.push(s); };

    // ---------------------------------------------------------------- 1
    say('=== 1. WHERE THE ERROR IS THROWN ===');
    say('');

    var needle = 'Unable to update question response';
    var hits = 0;
    var si = new GlideRecord('sys_script_include');
    si.addQuery('script', 'CONTAINS', needle);
    si.query();
    while (si.next()) {
        hits++;
        var src = si.getValue('script') + '';
        say('  script include: ' + si.getValue('name') +
            '   (' + si.getValue('sys_scope') + ')');
        var at = src.indexOf(needle);
        while (at >= 0) {
            var from = src.lastIndexOf('\n', Math.max(0, at - 1400));
            say('  ----------------------------------------------------------------');
            say(src.substring(from < 0 ? 0 : from, at + 300));
            at = src.indexOf(needle, at + 1);
        }
    }
    if (!hits) {
        say('  not found in sys_script_include — checking sys_ui_message / messages');
        var m = new GlideRecord('sys_ui_message');
        m.addQuery('message', 'CONTAINS', needle);
        m.query();
        while (m.next()) say('  sys_ui_message: ' + m.getValue('key'));
    }

    // ---------------------------------------------------------------- 2
    say('');
    say('=== 2. updateQuestionInstance SOURCE ===');
    say('');

    var u = new GlideRecord('sys_script_include');
    u.addQuery('name', 'IN', 'AssessmentInstanceUtilSNC,AssessmentInstanceUtil');
    u.query();
    while (u.next()) {
        var s2 = u.getValue('script') + '';
        var k  = s2.indexOf('updateQuestionInstance');
        if (k < 0) { say('  ' + u.getValue('name') + ': method not present'); continue; }
        say('  --- ' + u.getValue('name') + ' ---');
        var end = s2.indexOf('\n    },', k);
        say(s2.substring(k, end > 0 ? end + 6 : k + 2500));
        say('');
    }

    // ---------------------------------------------------------------- 3
    say('');
    say('=== 3. THE RECORD WE ARE TRYING TO WRITE ===');
    say('');

    var instanceId = resolveInstance(TASK);
    if (!instanceId) { say('  !! no instance for ' + TASK); finish(); return; }

    var inst = new GlideRecord(T.INSTANCE);
    inst.get(instanceId);
    say('  assessment_instance: ' + instanceId);
    say('    state:          ' + inst.getValue('state') +
        '  (' + inst.getDisplayValue('state') + ')');
    if (inst.isValidField('workflow_state'))
        say('    workflow_state: ' + inst.getValue('workflow_state') +
            '  (' + inst.getDisplayValue('workflow_state') + ')');
    if (inst.isValidField('percent_complete'))
        say('    percent_complete: ' + inst.getValue('percent_complete'));

    var target = null;
    var qi = new GlideRecord(T.QUESTION_INST);
    qi.addQuery('assessment_instance', instanceId);
    qi.query();
    while (qi.next()) {
        var disp = qi.getDisplayValue('assessment_question') + '';
        if (disp.toLowerCase().indexOf(Q_CONTAINS.toLowerCase()) >= 0) {
            target = qi.getUniqueValue();
            break;
        }
    }

    if (!target) {
        say('  !! no question instance matching "' + Q_CONTAINS + '"');
        finish(); return;
    }

    var q = new GlideRecord(T.QUESTION_INST);
    q.get(target);
    say('');
    say('  question_instance: ' + target);
    dumpRow(q, T.QUESTION_INST, '    ');

    var def = new GlideRecord(T.QUESTION_DEF);
    if (def.get(q.getValue('assessment_question'))) {
        say('');
        say('  question definition: ' + def.getUniqueValue());
        say('    created:  ' + def.getValue('sys_created_on') +
            ' by ' + def.getValue('sys_created_by'));
        dumpRow(def, T.QUESTION_DEF, '    ');
    }

    say('');
    say('  TIMING CHECK — a question added to the template after the instance');
    say('  was generated is a common cause of a refused write:');
    say('    instance created:   ' + inst.getValue('sys_created_on'));
    say('    question created:   ' + (def.isValidRecord() ? def.getValue('sys_created_on') : '?'));
    say('    q-instance created: ' + q.getValue('sys_created_on'));

    // compare against a choice question that DOES accept writes
    say('');
    say('  --- a working choice question on the same instance, for contrast ---');
    var c = new GlideRecord(T.QUESTION_INST);
    c.addQuery('assessment_instance', instanceId);
    c.addQuery('sys_id', '!=', target);
    c.addNotNullQuery('selected_response_options');
    c.setLimit(1);
    c.query();
    if (c.next()) {
        say('  question_instance: ' + c.getUniqueValue() +
            '  "' + (c.getDisplayValue('assessment_question') + '').substring(0, 50) + '"');
        dumpRow(c, T.QUESTION_INST, '    ');
    } else {
        say('  (none answered yet — answer one choice question and re-run for the contrast)');
    }

    // ---------------------------------------------------------------- 4
    say('');
    say('=== 4. DIRECT WRITE TEST ===');
    say('');
    if (!TRY_DIRECT_WRITE) {
        say('  skipped (TRY_DIRECT_WRITE = false)');
        say('  Set it true to find out whether the refusal is the platform utility');
        say('  being strict, or the row genuinely not being writable.');
    } else {
        var w = new GlideRecord(T.QUESTION_INST);
        if (!w.get(target)) {
            say('  !! could not re-read the row');
        } else {
            w.setValue('text_response', TEST_VALUE);
            w.setValue('is_responded', true);
            var ok = w.update();
            say('  GlideRecord.update() returned: ' + ok);

            var v = new GlideRecord(T.QUESTION_INST);
            v.get(target);
            say('  text_response now: "' + v.getValue('text_response') + '"');
            say('  is_responded now:  ' + v.getValue('is_responded'));
            say('');
            say('  If this stuck, the row is writable and updateQuestionInstance is');
            say('  refusing for a reason section 1 will name.');
            say('  If it did NOT stick, a business rule is aborting the write.');
        }
    }

    finish();

    // ------------------------------------------------------------ helpers

    function dumpRow(gr, table, pad0) {
        var dd = new GlideRecord('sys_dictionary');
        dd.addQuery('name', table);
        dd.addNotNullQuery('element');
        dd.orderBy('element');
        dd.query();
        while (dd.next()) {
            var f = dd.getValue('element') + '';
            if (!gr.isValidField(f)) continue;
            if (f.indexOf('sys_') === 0 && f !== 'sys_id' &&
                f !== 'sys_created_on' && f !== 'sys_updated_on') continue;
            var val = gr.getValue(f);
            if (gs.nil(val) || val === '' || val === 'false') continue;
            say(pad0 + pad(f, 30) + String(val).substring(0, 60));
        }
    }

    function resolveInstance(ref) {
        var t = new GlideRecord(T.TASK);
        if (!(ref + '').match(/^[0-9a-f]{32}$/)) {
            t.addQuery('number', ref);
            t.setLimit(1);
            t.query();
            if (!t.next()) return null;
        } else if (!t.get(ref)) return null;

        var targets = [t.getUniqueValue()];
        if (t.isValidField('related_record')) {
            var rr = t.getValue('related_record');
            if (!gs.nil(rr)) targets.push(rr);
        }
        for (var i = 0; i < targets.length; i++) {
            var s = new GlideRecord(T.SCOPE_ITEM);
            s.addQuery('record', targets[i]);
            s.query();
            while (s.next()) {
                var mm = new GlideRecord(T.M2M);
                mm.addQuery('scope_item', s.getUniqueValue());
                mm.setLimit(1);
                mm.query();
                if (mm.next()) return mm.getValue('assessment_instance');
            }
        }
        return null;
    }

    function pad(s, n) {
        s = String(s === null || s === undefined ? '' : s);
        while (s.length < n) s += ' ';
        return s + ' ';
    }

    function finish() { gs.info('\n' + log.join('\n')); }

})();
