export function registerAuditPeopleRoutes({
  app,
  requireCapability,
  capabilities,
  auditLog,
  listAssignments,
  listPeople,
  deviceLabelFor,
  canViewAssignment,
  hasCapability,
  canManagePerson,
  canAccessDevice,
}) {
  function authorizedAuditEvents(operator, { operator: operatorFilter, deviceId, limit = 200 } = {}) {
    return auditLog.listAuthorizedEvents(operator, { operator: operatorFilter, deviceId, limit });
  }

  function publicPeople(viewer = null) {
    const visibleAssignments = viewer
      ? listAssignments().filter(item => canViewAssignment(item, viewer))
      : [];
    return listPeople().map(person => {
      const assignment = visibleAssignments.find(item => item.assignee === person.username
        && ["assigned", "in_progress"].includes(item.status)) ?? null;
      const visibleDeviceIds = person.currentDeviceIds.filter(id => viewer && canAccessDevice(viewer, id));
      return {
        ...person,
        canAssign: Boolean(viewer && hasCapability(viewer, capabilities.MANAGE_ASSIGNMENTS)
          && canManagePerson(viewer, person.username)),
        currentDeviceIds: visibleDeviceIds,
        currentPhones: visibleDeviceIds.map(id => ({ id, label: deviceLabelFor(id) })),
        assignment: assignment ? {
          id: assignment.id,
          deviceId: assignment.deviceId,
          status: assignment.status,
          startAt: assignment.startAt ?? null,
          endAt: assignment.endAt ?? null,
        } : null,
      };
    });
  }

  app.get("/api/audit", requireCapability(capabilities.VIEW_AUDIT), (req, res) => {
    const { operator, deviceId, limit } = req.query;
    res.json({ events: authorizedAuditEvents(req.currentOperator, { operator, deviceId, limit }) });
  });

  app.get("/api/people", requireCapability(capabilities.VIEW_PEOPLE), (req, res) => {
    res.json({ people: publicPeople(req.currentOperator) });
  });

  return { authorizedAuditEvents, publicPeople };
}
