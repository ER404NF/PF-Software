(function publishPeopleAssignmentsController(root) {
  function createPeopleAssignmentsController({ elements, documentRef, windowRef, OptionCtor, requestJson,
    getProfileGeneration, requestActive, can, capabilities, getCurrentOperator, getDevices,
    displayRole, formatLastSeen, formatDate, showSurfaceMessage }) {
    if (!elements || !documentRef || !windowRef || !OptionCtor || typeof requestJson !== "function"
      || typeof getProfileGeneration !== "function" || typeof requestActive !== "function"
      || typeof can !== "function" || !capabilities || typeof getCurrentOperator !== "function"
      || typeof getDevices !== "function") throw new TypeError("people and assignments controller requires all dependencies");

    const { peopleList, peopleSummary, peopleError, peopleRefreshButton, assignmentsRefreshButton,
      assignmentCreateForm, assignmentAssignee, assignmentDevice, assignmentAccount, assignmentStart,
      assignmentEnd, assignmentRecurrence, assignmentExclusive, assignmentInstructions,
      assignmentsMessage, assignmentsList, assignmentsEmpty } = elements;
    let lastPeople = [];
    let peopleLastUpdatedAt = null;

    function renderPeople(people, { fresh = true, updatedAt = new Date() } = {}) {
      lastPeople = people;
      if (fresh) peopleLastUpdatedAt = updatedAt;
      peopleList.replaceChildren();
      const onlineCount = fresh ? people.filter(person => person.online).length : 0;
      peopleSummary.textContent = fresh
        ? `${onlineCount} online · ${people.length} staff`
        : `Presence unavailable while reconnecting.${peopleLastUpdatedAt ? ` Last updated ${peopleLastUpdatedAt.toLocaleTimeString()}.` : ""}`;
      for (const person of people) {
        const item = documentRef.createElement("li");
        const online = fresh && person.online;
        item.className = `person-row ${online ? "online" : "offline"}${fresh ? "" : " stale"}`;
        const dot = documentRef.createElement("span");
        dot.className = "presence-dot";
        dot.setAttribute("aria-label", fresh ? (online ? "Online" : "Offline") : "Presence unavailable");
        const details = documentRef.createElement("div");
        details.className = "person-details";
        const name = documentRef.createElement("strong");
        name.textContent = person.username;
        const meta = documentRef.createElement("span");
        const sessions = person.activeSessions > 1 ? ` · ${person.activeSessions} sessions` : "";
        meta.textContent = `${displayRole(person.role)} · ${fresh ? formatLastSeen(person.lastSeenAt) : "Status unavailable"}${fresh ? sessions : ""}`;
        details.append(name, meta);
        if (Array.isArray(person.currentPhones) && person.currentPhones.length) {
          const activity = documentRef.createElement("span");
          activity.className = "person-activity";
          activity.textContent = `On ${person.currentPhones.map(phone => phone.label).join(", ")}`;
          details.append(activity);
        }
        if (person.assignment) {
          const assignment = documentRef.createElement("span");
          assignment.className = "person-assignment";
          assignment.textContent = `${person.assignment.status.replaceAll("_", " ")}`
            + (person.assignment.deviceId ? ` · ${person.assignment.deviceId}` : "")
            + (person.assignment.startAt && person.assignment.endAt
              ? ` · ${formatDate(person.assignment.startAt)} → ${formatDate(person.assignment.endAt)}` : "");
          details.append(assignment);
        }
        item.append(dot, details);
        peopleList.append(item);
      }
    }

    function markPresenceUnavailable() {
      renderPeople(lastPeople, { fresh: false });
      peopleError.textContent = peopleLastUpdatedAt
        ? `Presence unavailable while reconnecting. Last updated ${peopleLastUpdatedAt.toLocaleTimeString()}.`
        : "Presence unavailable while reconnecting.";
    }

    async function refreshPeople() {
      const generation = getProfileGeneration();
      peopleError.textContent = "";
      try {
        const { body } = await requestJson("/api/people");
        if (!requestActive(generation, capabilities.VIEW_PEOPLE)) return false;
        renderPeople(Array.isArray(body.people) ? body.people : [], { fresh: true });
        if (can(capabilities.MANAGE_ASSIGNMENTS)) populateAssignmentForm();
        return true;
      } catch (error) {
        if (!requestActive(generation, capabilities.VIEW_PEOPLE)) return false;
        peopleError.textContent = error.message;
        return false;
      }
    }

    function populateAssignmentForm({ unavailableAssignee = null } = {}) {
      const selectedAssignee = assignmentAssignee.value;
      assignmentAssignee.replaceChildren();
      for (const person of lastPeople) {
        if (person.canAssign !== true) continue;
        const option = documentRef.createElement("option");
        option.value = person.username;
        option.textContent = `${person.username} (${displayRole(person.role)})`;
        assignmentAssignee.append(option);
      }
      if (unavailableAssignee && ![...assignmentAssignee.options].some(option => option.value === unavailableAssignee)) {
        const unavailable = new OptionCtor(`${unavailableAssignee} (no longer eligible)`, unavailableAssignee, true, true);
        unavailable.disabled = true;
        assignmentAssignee.append(unavailable);
      }
      if ([...assignmentAssignee.options].some(option => option.value === selectedAssignee)) assignmentAssignee.value = selectedAssignee;

      const selectedDevice = assignmentDevice.value;
      assignmentDevice.replaceChildren(new OptionCtor("No phone", ""));
      const allowed = getCurrentOperator()?.allowedDevices;
      for (const device of getDevices().filter(item => !Array.isArray(allowed) || allowed.includes(item.id))) {
        assignmentDevice.append(new OptionCtor(device.label, device.id));
      }
      assignmentDevice.value = [...assignmentDevice.options].some(option => option.value === selectedDevice) ? selectedDevice : "";
    }

    function assignmentNextStatuses(assignment) {
      if (assignment.status === "assigned") {
        const opensLater = assignment.startAt && Date.parse(assignment.startAt) > Date.now();
        return opensLater ? ["cancelled"] : ["in_progress", "cancelled"];
      }
      if (assignment.status === "in_progress") return ["completed", "cancelled"];
      return [];
    }

    function localInputToIso(value) {
      if (!value) return null;
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    }

    function isoToLocalInput(value) {
      if (!value) return "";
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return "";
      const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
      return local.toISOString().slice(0, 16);
    }

    function assignmentWindow(assignment) {
      if (!assignment.startAt || !assignment.endAt) return "Unscheduled";
      return `${formatDate(assignment.startAt)} → ${formatDate(assignment.endAt)}${assignment.exclusive === false ? " · shared" : " · exclusive"}`;
    }

    function assignmentRecurrenceLabel(assignment) {
      if (assignment.recurrence === "daily") return "Every day";
      if (assignment.recurrence === "weekly") return "Every week";
      return "Once";
    }

    function setAssignmentCardPending(card, value) {
      if (!card) return;
      card.setAttribute("aria-busy", String(value));
      for (const control of card.querySelectorAll("button, input, select")) control.disabled = value;
    }

    function showAssignmentError(messageEl, message, retry) {
      messageEl.replaceChildren(documentRef.createTextNode(`${message} `));
      if (retry) {
        const button = documentRef.createElement("button");
        button.type = "button";
        button.textContent = "Retry";
        button.addEventListener("click", retry);
        messageEl.append(button);
      }
    }

    function renderAssignments(assignments) {
      assignmentsList.replaceChildren();
      assignmentsEmpty.hidden = assignments.length > 0;
      for (const assignment of assignments) {
        const card = documentRef.createElement("article");
        card.className = "assignment-card";
        const heading = documentRef.createElement("div");
        heading.className = "assignment-card-heading";
        const title = documentRef.createElement("strong");
        title.textContent = assignment.instructions;
        const status = documentRef.createElement("span");
        status.className = `assignment-status ${assignment.status}`;
        status.textContent = assignment.status.replaceAll("_", " ");
        const recurrence = documentRef.createElement("span");
        recurrence.className = `assignment-recurrence ${assignment.recurrence || "once"}`;
        recurrence.textContent = assignmentRecurrenceLabel(assignment);
        const badges = documentRef.createElement("div");
        badges.className = "assignment-card-badges";
        badges.append(recurrence, status);
        heading.append(title, badges);
        const meta = documentRef.createElement("p");
        meta.textContent = `Assigned to ${assignment.assignee} by ${assignment.createdBy}`
          + (assignment.deviceId ? ` · Phone ${assignment.deviceId}` : "")
          + (assignment.accountId ? ` · Account ${assignment.accountId}` : "")
          + ` · ${assignmentWindow(assignment)}`
          + ((assignment.occurrence ?? 1) > 1 ? ` · Occurrence ${assignment.occurrence}` : "");
        const cardMessage = documentRef.createElement("p");
        cardMessage.className = "assignment-card-message";
        cardMessage.setAttribute("role", "alert");
        cardMessage.setAttribute("aria-live", "assertive");
        card.append(heading, meta, cardMessage);
        const controls = documentRef.createElement("div");
        controls.className = "assignment-controls";
        const actions = documentRef.createElement("div");
        actions.className = "assignment-actions";
        const nextStatuses = assignmentNextStatuses(assignment);
        const mayManage = can(capabilities.MANAGE_ASSIGNMENTS);
        const mayProgressOwnTask = assignment.canProgress === true;
        if (nextStatuses.length && (mayManage || mayProgressOwnTask)) {
          for (const nextStatus of nextStatuses.filter(value => mayManage || value !== "cancelled")) {
            const button = documentRef.createElement("button");
            button.type = "button";
            button.textContent = nextStatus === "in_progress" ? "Start" : nextStatus === "completed" ? "Complete" : "Cancel";
            button.addEventListener("click", () => {
              if (nextStatus === "cancelled"
                && !windowRef.confirm(`Cancel this assignment for ${assignment.assignee}? Completed work and history will remain visible.`)) return;
              void updateAssignment(assignment.id, { status: nextStatus }, { card, messageEl: cardMessage });
            });
            actions.append(button);
          }
        }
        if (nextStatuses.length && mayManage) {
          const manage = documentRef.createElement("details");
          manage.className = "assignment-manage";
          const manageSummary = documentRef.createElement("summary");
          manageSummary.textContent = "Manage assignment";
          const manageGrid = documentRef.createElement("div");
          manageGrid.className = "assignment-manage-grid";
          const reassign = documentRef.createElement("select");
          reassign.setAttribute("aria-label", `Reassign ${assignment.instructions}`);
          for (const option of assignmentAssignee.options) reassign.append(option.cloneNode(true));
          reassign.value = assignment.assignee;
          const reassignField = documentRef.createElement("label");
          reassignField.textContent = "Assignee";
          reassignField.append(reassign);
          const saveAssignee = documentRef.createElement("button");
          saveAssignee.type = "button";
          saveAssignee.textContent = "Save assignee";
          saveAssignee.addEventListener("click", async () => {
            const requestedAssignee = reassign.value;
            if (!requestedAssignee || requestedAssignee === assignment.assignee) {
              showAssignmentError(cardMessage, "Choose a different assignee before saving.");
              return;
            }
            const updated = await updateAssignment(assignment.id, { assignee: requestedAssignee }, {
              card, messageEl: cardMessage, onFailure: () => { reassign.value = assignment.assignee; },
            });
            if (!updated) reassign.value = assignment.assignee;
          });
          const scheduleStart = documentRef.createElement("input");
          scheduleStart.type = "datetime-local";
          scheduleStart.value = isoToLocalInput(assignment.startAt);
          scheduleStart.setAttribute("aria-label", `Start time for ${assignment.instructions}`);
          const scheduleEnd = documentRef.createElement("input");
          scheduleEnd.type = "datetime-local";
          scheduleEnd.value = isoToLocalInput(assignment.endAt);
          scheduleEnd.setAttribute("aria-label", `End time for ${assignment.instructions}`);
          const scheduleExclusive = documentRef.createElement("input");
          scheduleExclusive.type = "checkbox";
          scheduleExclusive.checked = assignment.exclusive !== false;
          scheduleExclusive.setAttribute("aria-label", `Exclusive schedule for ${assignment.instructions}`);
          const startField = documentRef.createElement("label");
          startField.textContent = "Starts";
          startField.append(scheduleStart);
          const endField = documentRef.createElement("label");
          endField.textContent = "Ends";
          endField.append(scheduleEnd);
          const exclusiveField = documentRef.createElement("label");
          exclusiveField.className = "assignment-manage-checkbox";
          exclusiveField.append(scheduleExclusive, "Exclusive time slot");
          const reschedule = documentRef.createElement("button");
          reschedule.type = "button";
          reschedule.textContent = "Update schedule";
          reschedule.addEventListener("click", () => updateAssignment(assignment.id, {
            startAt: localInputToIso(scheduleStart.value), endAt: localInputToIso(scheduleEnd.value),
            exclusive: scheduleExclusive.checked,
          }, { card, messageEl: cardMessage }));
          manageGrid.append(reassignField, saveAssignee, startField, endField, exclusiveField, reschedule);
          manage.append(manageSummary, manageGrid);
          controls.append(manage);
        }
        if (actions.childElementCount) controls.prepend(actions);
        if (controls.childElementCount) card.append(controls);
        const history = documentRef.createElement("details");
        history.className = "assignment-history";
        const summary = documentRef.createElement("summary");
        summary.textContent = `History (${assignment.history.length})`;
        const list = documentRef.createElement("ol");
        for (const event of assignment.history) {
          const item = documentRef.createElement("li");
          item.textContent = `${new Date(event.at).toLocaleString()} · ${event.actor} · ${event.action.replaceAll("_", " ")}`;
          list.append(item);
        }
        history.append(summary, list);
        card.append(history);
        assignmentsList.append(card);
      }
    }

    async function refreshAssignments() {
      const generation = getProfileGeneration();
      assignmentsMessage.textContent = "";
      try {
        const { body } = await requestJson("/api/assignments");
        if (!requestActive(generation, capabilities.VIEW_ASSIGNMENTS)) return false;
        renderAssignments(Array.isArray(body.assignments) ? body.assignments : []);
        return true;
      } catch (error) {
        if (!requestActive(generation, capabilities.VIEW_ASSIGNMENTS)) return false;
        assignmentsMessage.textContent = error.message;
        return false;
      }
    }

    async function updateAssignment(id, change, { card = null, messageEl = assignmentsMessage, onFailure = null } = {}) {
      showSurfaceMessage(messageEl, "");
      setAssignmentCardPending(card, true);
      try {
        await requestJson(`/api/assignments/${encodeURIComponent(id)}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change),
        });
        await refreshAssignments();
        return true;
      } catch (error) {
        onFailure?.();
        const retry = () => void updateAssignment(id, change, { card, messageEl, onFailure });
        showAssignmentError(messageEl, `${error.message} The assignment was not changed.`, retry);
        return false;
      } finally {
        setAssignmentCardPending(card, false);
      }
    }

    async function submitAssignment(event) {
      event.preventDefault();
      assignmentsMessage.textContent = "";
      const submit = assignmentCreateForm.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        await requestJson("/api/assignments", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            assignee: assignmentAssignee.value, instructions: assignmentInstructions.value,
            deviceId: assignmentDevice.value || null, accountId: assignmentAccount.value.trim() || null,
            startAt: localInputToIso(assignmentStart.value), endAt: localInputToIso(assignmentEnd.value),
            exclusive: assignmentExclusive.checked, recurrence: assignmentRecurrence.value,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          }),
        });
        assignmentInstructions.value = "";
        assignmentAccount.value = "";
        assignmentStart.value = "";
        assignmentEnd.value = "";
        assignmentRecurrence.value = "once";
        await refreshAssignments();
      } catch (error) {
        if (error.kind === "http" && error.status === 403) {
          const unavailableAssignee = assignmentAssignee.value;
          await refreshPeople();
          populateAssignmentForm({ unavailableAssignee });
          assignmentsMessage.textContent = `${error.message} Eligibility changed; the form was preserved and choices were refreshed.`;
        } else {
          assignmentsMessage.textContent = `${error.message} The assignment was not created.`;
        }
      } finally {
        submit.disabled = false;
      }
    }

    peopleRefreshButton.addEventListener("click", refreshPeople);
    assignmentsRefreshButton.addEventListener("click", refreshAssignments);
    assignmentCreateForm.addEventListener("submit", submitAssignment);

    return { renderPeople, markPresenceUnavailable, refreshPeople, populateAssignmentForm, renderAssignments,
      refreshAssignments, updateAssignment, assignmentWindow };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { createPeopleAssignmentsController };
  if (root) root.createPeopleAssignmentsController = createPeopleAssignmentsController;
})(typeof window !== "undefined" ? window : null);
