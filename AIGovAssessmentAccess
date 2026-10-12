// AIGovAssessmentAccess
// Who may read or answer a smart assessment. Separate from the prefill logic
// because it is the security control and gets reviewed on its own terms.
//
// Delegates to sn_smart_asmt.AssessmentAccessControl — the same class the
// platform's own ACLs on sn_smart_asmt_question_instance call. Deliberately
// coarser than those ACLs: it answers "is this user involved in this
// assessment at all", so a stranger gets a clean 403 instead of an empty
// question list. The precise per-field rule stays with the ACLs, enforced by
// GlideRecordSecure on the write.
//
// Fails closed. If the platform class cannot be reached, access is denied.

var AIGovAssessmentAccess = Class.create();

AIGovAssessmentAccess.prototype = {

    initialize: function () {
        this.INSTANCE_TABLE = 'sn_smart_asmt_instance';
        this.ACTOR_ROLE = 'sn_smart_asmt.actor';
        this.ADMIN_ROLE = 'sn_smart_asmt.assessment_admin';
        this.READER_ROLE = 'sn_smart_asmt.assessment_reader';
    },

    // primary owner, then assessment contributor, then any persona
    canRespond: function (instanceId) {
        var ctx = this._context(instanceId);
        if (ctx.error) return { allowed: false, reason: ctx.error };

        var ac = ctx.accessControl, inst = ctx.instance;

        if (ac.currentUserIsPrimaryOwnerInAsmt(inst))
            return { allowed: true, via: 'primary_owner' };

        if (ac.isCurrentUserAssessmentContributor(inst))
            return { allowed: true, via: 'assessment_contributor' };

        if (ac.currentUserIsActorInAsmt(inst))
            return { allowed: true, via: 'actor' };

        return { allowed: false,
                 reason: 'not an assessor on this assessment',
                 user: gs.getUserName() };
    },

    // wider than canRespond: the requestor and reader-role holders can see
    // an assessment without being able to answer it
    canRead: function (instanceId) {
        var ctx = this._context(instanceId);
        if (ctx.error) return { allowed: false, reason: ctx.error };

        var ac = ctx.accessControl, inst = ctx.instance;

        if (ac.currentUserIsActorInAsmt(inst))
            return { allowed: true, via: 'actor' };

        if (ac.currentUserIsRequestorOfAsmt(inst))
            return { allowed: true, via: 'requestor' };

        if (ac.currentUserHasRoleForReadAccessOfAsmt(inst))
            return { allowed: true, via: 'reader_role' };

        if (gs.hasRole(this.ADMIN_ROLE))
            return { allowed: true, via: 'assessment_admin' };

        return { allowed: false,
                 reason: 'no read access to this assessment',
                 user: gs.getUserName() };
    },

    // every signal at once, for diagnose and for working out why a
    // legitimate user was refused
    describe: function (instanceId) {
        var out = {
            user: gs.getUserName(),
            is_admin: gs.hasRole('admin'),
            has_actor_role: gs.hasRole(this.ACTOR_ROLE),
            has_assessment_admin: gs.hasRole(this.ADMIN_ROLE),
            has_reader_role: gs.hasRole(this.READER_ROLE),
            collaboration_plugin: GlidePluginManager.isActive('com.sn_smart_collab')
        };

        var ctx = this._context(instanceId);
        if (ctx.error) { out.error = ctx.error; return out; }

        var ac = ctx.accessControl, inst = ctx.instance;
        out.assessment = inst.getValue('number');
        out.assessment_state = inst.getDisplayValue('state');

        out.signals = {
            primary_owner: ac.currentUserIsPrimaryOwnerInAsmt(inst),
            assessor: ac.currentUserIsAssessorInAsmt(inst),
            actor: ac.currentUserIsActorInAsmt(inst),
            assessment_contributor: ac.isCurrentUserAssessmentContributor(inst),
            requestor: ac.currentUserIsRequestorOfAsmt(inst)
        };

        out.can_respond = this.canRespond(instanceId);
        out.can_read = this.canRead(instanceId);

        var sec = new GlideRecordSecure('sn_smart_asmt_question_instance');
        sec.addQuery('assessment_instance', instanceId);
        sec.setLimit(1);
        sec.query();
        out.acl = sec.next()
            ? { secure_read: true, can_write: sec.canWrite() }
            : { secure_read: false, can_write: false };

        if (out.is_admin)
            out.warning = 'running as admin — admin_overrides is 1 on these ACLs, ' +
                          'so every signal here passes regardless of configuration';

        return out;
    },

    _context: function (instanceId) {
        if (gs.nil(instanceId)) return { error: 'no assessment instance' };

        var inst = new GlideRecord(this.INSTANCE_TABLE);
        if (!inst.get(instanceId)) return { error: 'assessment instance not found' };

        try {
            return { instance: inst,
                     accessControl: new sn_smart_asmt.AssessmentAccessControl() };
        } catch (e) {
            gs.error('[AIGovAssessmentAccess] AssessmentAccessControl unreachable: ' + e);
            return { error: 'authorisation check unavailable' };
        }
    },

    type: 'AIGovAssessmentAccess'
};
