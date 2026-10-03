export function createAssignmentAccess({
  hasDevice,
  hasResearchAccount,
  canAccessDevice,
  researchWorkspaceFor,
  operatorForUsername,
  hasCapability,
  manageAssignmentsCapability,
  canManagePerson,
  canSelfProgress,
}) {
  function assignmentScopeAllowed(assignment, operator) {
    if (assignment.deviceId && !canAccessDevice(operator, assignment.deviceId)) return false;
    if (assignment.accountId && !researchWorkspaceFor(operator, assignment.accountId)) return false;
    return true;
  }

  function assigneeScopeAllowed(assignment, username) {
    const assignee = operatorForUsername(username);
    return Boolean(assignee) && assignmentScopeAllowed(assignment, assignee);
  }

  function canViewAssignment(assignment, operator) {
    if (assignment.assignee === operator.username || assignment.createdBy === operator.username) {
      return assignmentScopeAllowed(assignment, operator);
    }
    return hasCapability(operator, manageAssignmentsCapability)
      && canManagePerson(operator, assignment.assignee)
      && assignmentScopeAllowed(assignment, operator);
  }

  function publicAssignmentFor(assignment, operator) {
    const canProgress = canSelfProgress(operator.role)
      && assignment.assignee === operator.username
      && ["assigned", "in_progress"].includes(assignment.status);
    return { ...assignment, canProgress };
  }

  function validateAssignmentScope(body, operator) {
    const deviceId = body.deviceId ?? null;
    const accountId = body.accountId ?? null;
    if (deviceId !== null) {
      if (typeof deviceId !== "string" || !hasDevice(deviceId)) return { error: "unknown device", status: 400 };
      if (!canAccessDevice(operator, deviceId)) return { error: "not authorized for this device", status: 403 };
    }
    if (accountId !== null) {
      if (typeof accountId !== "string" || !hasResearchAccount(accountId)) return { error: "unknown research account", status: 400 };
      if (!researchWorkspaceFor(operator, accountId)) return { error: "not authorized for this research account", status: 403 };
    }
    return { deviceId, accountId };
  }

  return { assignmentScopeAllowed, assigneeScopeAllowed, canViewAssignment, publicAssignmentFor,
    validateAssignmentScope };
}

export function registerAssignmentRoutes({
  app,
  requireCapability,
  capabilities,
  assignmentStatuses,
  assignmentStore,
  access,
  expireAssignments,
  operatorForUsername,
  hasCapability,
  canManagePerson,
  canSelfProgress,
  logAuditBestEffort,
  broadcastDeviceList,
  broadcastPresence,
}) {
  const { assignmentScopeAllowed, assigneeScopeAllowed, canViewAssignment, publicAssignmentFor,
    validateAssignmentScope } = access;

  app.get("/api/assignments", requireCapability(capabilities.VIEW_ASSIGNMENTS), (req, res) => {
    expireAssignments();
    res.json({ assignments: assignmentStore.list().filter(item => canViewAssignment(item, req.currentOperator))
      .map(item => publicAssignmentFor(item, req.currentOperator)) });
  });

  app.post("/api/assignments", requireCapability(capabilities.MANAGE_ASSIGNMENTS), (req, res, next) => {
    try {
      expireAssignments();
      const { assignee, instructions } = req.body || {};
      if (typeof assignee !== "string" || !operatorForUsername(assignee)) return res.status(400).json({ error: "unknown or inactive assignee" });
      if (!canManagePerson(req.currentOperator, assignee)) return res.status(403).json({ error: "not authorized to assign this person" });
      const scope = validateAssignmentScope(req.body || {}, req.currentOperator);
      if (scope.error) return res.status(scope.status).json({ error: scope.error });
      if (!assigneeScopeAllowed(scope, assignee)) {
        return res.status(403).json({ error: "assignee is not authorized for the referenced phone or account" });
      }
      const assignment = assignmentStore.create({
        instructions,
        assignee,
        createdBy: req.currentOperator.username,
        deviceId: scope.deviceId,
        accountId: scope.accountId,
        startAt: req.body?.startAt ?? null,
        endAt: req.body?.endAt ?? null,
        exclusive: req.body?.exclusive ?? true,
        recurrence: req.body?.recurrence ?? "once",
        timezone: req.body?.timezone ?? "UTC",
      });
      logAuditBestEffort({ operator: req.currentOperator.username, type: "assignment_created",
        deviceId: assignment.deviceId, detail: {
          assignmentId: assignment.id, assignee: assignment.assignee, accountId: assignment.accountId,
          startAt: assignment.startAt, endAt: assignment.endAt, exclusive: assignment.exclusive,
          recurrence: assignment.recurrence, occurrence: assignment.occurrence,
        } }, "Assignment creation audit write");
      broadcastDeviceList();
      broadcastPresence();
      res.status(201).json({ assignment });
    } catch (error) {
      if (/overlaps/.test(error.message)) return res.status(409).json({ error: error.message });
      if (/instructions|deviceId|accountId|schedule|startAt|endAt|exclusive|recurrence/.test(error.message)) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  app.patch("/api/assignments/:assignmentId", requireCapability(capabilities.VIEW_ASSIGNMENTS), (req, res, next) => {
    try {
      expireAssignments();
      const current = assignmentStore.get(req.params.assignmentId);
      if (!current) return res.status(404).json({ error: "unknown assignment" });
      if (!canViewAssignment(current, req.currentOperator)) return res.status(403).json({ error: "not authorized for this assignment" });
      const hasManage = hasCapability(req.currentOperator, capabilities.MANAGE_ASSIGNMENTS)
        && canManagePerson(req.currentOperator, current.assignee)
        && assignmentScopeAllowed(current, req.currentOperator);
      const wantsReassign = Object.prototype.hasOwnProperty.call(req.body || {}, "assignee");
      const wantsStatus = Object.prototype.hasOwnProperty.call(req.body || {}, "status");
      const wantsSchedule = ["startAt", "endAt", "exclusive"].some(key => Object.prototype.hasOwnProperty.call(req.body || {}, key));
      if ([wantsReassign, wantsStatus, wantsSchedule].filter(Boolean).length > 1) {
        return res.status(400).json({ error: "change assignee, status, or schedule separately" });
      }
      if (!wantsReassign && !wantsStatus && !wantsSchedule) return res.status(400).json({ error: "status, assignee, or schedule is required" });

      let assignment;
      if (wantsReassign) {
        if (!hasManage) return res.status(403).json({ error: "assignment management capability required" });
        if (typeof req.body.assignee !== "string" || !operatorForUsername(req.body.assignee)) return res.status(400).json({ error: "unknown or inactive assignee" });
        if (!canManagePerson(req.currentOperator, req.body.assignee)) return res.status(403).json({ error: "not authorized to assign this person" });
        if (!assigneeScopeAllowed(current, req.body.assignee)) {
          return res.status(403).json({ error: "assignee is not authorized for the referenced phone or account" });
        }
        assignment = assignmentStore.reassign(current.id, req.body.assignee, req.currentOperator.username);
      } else if (wantsStatus) {
        if (!assignmentStatuses.includes(req.body.status)) return res.status(400).json({ error: "invalid assignment status" });
        const ownWorkerProgress = canSelfProgress(req.currentOperator.role)
          && current.assignee === req.currentOperator.username
          && ((current.status === "assigned" && req.body.status === "in_progress")
            || (current.status === "in_progress" && req.body.status === "completed"));
        if (!hasManage && !ownWorkerProgress) return res.status(403).json({ error: "assignment management capability required" });
        assignment = assignmentStore.setStatus(current.id, req.body.status, req.currentOperator.username);
      } else {
        if (!hasManage) return res.status(403).json({ error: "assignment management capability required" });
        assignment = assignmentStore.reschedule(current.id, {
          startAt: Object.hasOwn(req.body, "startAt") ? req.body.startAt : current.startAt ?? null,
          endAt: Object.hasOwn(req.body, "endAt") ? req.body.endAt : current.endAt ?? null,
          exclusive: Object.hasOwn(req.body, "exclusive") ? req.body.exclusive : current.exclusive !== false,
        }, req.currentOperator.username);
      }
      logAuditBestEffort({ operator: req.currentOperator.username, type: "assignment_updated",
        deviceId: assignment.deviceId, detail: { assignmentId: assignment.id, assignee: assignment.assignee, status: assignment.status } },
      "Assignment update audit write");
      broadcastDeviceList();
      broadcastPresence();
      res.json({ assignment: publicAssignmentFor(assignment, req.currentOperator) });
    } catch (error) {
      if (/cannot move|cannot start|in-progress|terminal|invalid assignment|overlaps/.test(error.message)) return res.status(409).json({ error: error.message });
      if (/schedule|startAt|endAt|exclusive|recurrence/.test(error.message)) return res.status(400).json({ error: error.message });
      next(error);
    }
  });
}
