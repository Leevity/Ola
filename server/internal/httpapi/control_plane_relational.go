package httpapi

import (
	"net/http"
	"strings"
	"time"

	"ola-remote-server/internal/store"
)

func teamFromOrganization(value store.Organization) teamRecord {
	return teamRecord{ID: value.ID, Name: value.Name, Status: value.Status, CreatedBy: value.CreatedBy, CreatedAt: value.CreatedAt}
}

func memberFromOrganizationMember(value store.OrganizationMember) teamMemberRecord {
	return teamMemberRecord{TeamID: value.OrganizationID, UserID: value.AccountID, Email: value.Email, Name: value.DisplayName, Role: controlRole(value.Role)}
}

func applicationFromOrganizationApplication(value store.OrganizationApplication) teamApplicationRecord {
	return teamApplicationRecord{ID: value.ID, TeamID: value.OrganizationID, Name: value.Name, Applicant: value.ApplicantID, Email: value.Email, Status: value.Status, CreatedAt: value.CreatedAt}
}

func modelFromConfig(value store.ModelConfig) modelConfigRecord {
	return modelConfigRecord{ID: value.ID, TeamID: value.OrganizationID, ProviderID: value.Provider, Model: value.Model, Enabled: value.Enabled, IsDefault: value.IsDefault, UpdatedAt: value.UpdatedAt}
}

func (api *API) controlMeRelational(w http.ResponseWriter, r *http.Request, account store.Account) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	members, err := api.control.repository.ListMemberships(account.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "unable to load memberships")
		return
	}
	teams, err := api.control.repository.ListOrganizations(account.ID, false)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "unable to load teams")
		return
	}
	resultTeams := make([]teamRecord, 0, len(teams))
	for _, team := range teams {
		resultTeams = append(resultTeams, teamFromOrganization(team))
	}
	resultMembers := make([]teamMemberRecord, 0, len(members))
	role := controlRoleFor(account)
	for _, member := range members {
		resultMembers = append(resultMembers, memberFromOrganizationMember(member))
		if role == rolePersonal && member.Role == string(roleTeamAdmin) {
			role = roleTeamAdmin
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"account": account, "role": role, "teams": resultTeams, "memberships": resultMembers})
}

func (api *API) controlTeamsRelational(w http.ResponseWriter, r *http.Request, account store.Account) {
	if r.Method == http.MethodGet {
		items, err := api.control.repository.ListOrganizations(account.ID, controlRoleFor(account) == roleSystemAdmin)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "unable to load teams")
			return
		}
		result := make([]teamRecord, 0, len(items))
		for _, item := range items {
			result = append(result, teamFromOrganization(item))
		}
		writeJSON(w, http.StatusOK, map[string]any{"teams": result})
		return
	}
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if !readJSON(w, r, &req) || !validBoundedText(req.Name, 100) {
		writeError(w, http.StatusBadRequest, "team name is required")
		return
	}
	team := teamRecord{ID: controlID("team"), Name: strings.TrimSpace(req.Name), Status: "pending", CreatedBy: account.ID, CreatedAt: time.Now()}
	if controlRoleFor(account) == roleSystemAdmin {
		team.Status = "approved"
	}
	memberRole := roleMember
	if team.Status == "approved" {
		memberRole = roleTeamAdmin
	}
	var application *store.OrganizationApplication
	if team.Status == "pending" {
		application = &store.OrganizationApplication{ID: controlID("app"), OrganizationID: team.ID, Name: team.Name, ApplicantID: account.ID, Email: account.Email, Status: "pending", CreatedAt: team.CreatedAt}
	}
	err := api.control.repository.CreateOrganization(store.Organization{ID: team.ID, Name: team.Name, Status: team.Status, CreatedBy: team.CreatedBy, CreatedAt: team.CreatedAt}, store.OrganizationMember{OrganizationID: team.ID, AccountID: account.ID, Email: account.Email, DisplayName: account.DisplayName, Role: string(memberRole)}, application)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "unable to create team")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"team": team, "role": memberRole})
}

func (api *API) controlApplicationsRelational(w http.ResponseWriter, r *http.Request, account store.Account) {
	if controlRoleFor(account) != roleSystemAdmin {
		writeError(w, http.StatusForbidden, "system administrator role required")
		return
	}
	if r.Method == http.MethodGet {
		items, err := api.control.repository.ListOrganizationApplications()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "unable to load team applications")
			return
		}
		result := make([]teamApplicationRecord, 0, len(items))
		for _, item := range items {
			result = append(result, applicationFromOrganizationApplication(item))
		}
		writeJSON(w, http.StatusOK, map[string]any{"applications": result})
		return
	}
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var req struct {
		TeamID string `json:"teamId"`
		Action string `json:"action"`
	}
	if !readJSON(w, r, &req) || !validRemoteIdentifier(req.TeamID) || (req.Action != "approve" && req.Action != "reject") {
		writeError(w, http.StatusBadRequest, "invalid team application action")
		return
	}
	team, application, err := api.control.repository.ReviewOrganizationApplication(req.TeamID, req.Action)
	if err != nil {
		if strings.Contains(err.Error(), "already") {
			writeError(w, http.StatusConflict, err.Error())
		} else {
			writeError(w, http.StatusNotFound, "team application not found")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"team": teamFromOrganization(team), "application": applicationFromOrganizationApplication(application)})
}

func (api *API) controlModelsRelational(w http.ResponseWriter, r *http.Request, account store.Account) {
	if r.Method == http.MethodGet {
		teamID := r.URL.Query().Get("teamId")
		if !validRemoteIdentifier(teamID) || !api.canAccessTeamModels(account, teamID) {
			writeError(w, http.StatusForbidden, "team membership required")
			return
		}
		items, err := api.control.repository.ListModelConfigs(teamID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "unable to load models")
			return
		}
		result := make([]modelConfigRecord, 0, len(items))
		for _, item := range items {
			result = append(result, modelFromConfig(item))
		}
		writeJSON(w, http.StatusOK, map[string]any{"models": result})
		return
	}
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var req struct {
		TeamID     string `json:"teamId"`
		ProviderID string `json:"providerId"`
		Model      string `json:"model"`
		IsDefault  bool   `json:"isDefault"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !validRemoteIdentifier(req.TeamID) || !validBoundedText(req.Model, 160) || req.ProviderID != "platform-default" {
		writeError(w, http.StatusBadRequest, "invalid model configuration")
		return
	}
	if !api.isTeamAdmin(account, req.TeamID) {
		writeError(w, http.StatusForbidden, "team administrator role required")
		return
	}
	item := store.ModelConfig{ID: controlID("model"), OrganizationID: req.TeamID, Provider: req.ProviderID, Model: strings.TrimSpace(req.Model), Enabled: true, IsDefault: req.IsDefault, UpdatedAt: time.Now()}
	if err := api.control.repository.AddModelConfig(item); err != nil {
		writeError(w, http.StatusInternalServerError, "unable to save model configuration")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"model": modelFromConfig(item)})
}

func (api *API) controlMembersRelational(w http.ResponseWriter, r *http.Request, account store.Account) {
	teamID := r.URL.Query().Get("teamId")
	if !validRemoteIdentifier(teamID) {
		writeError(w, http.StatusBadRequest, "invalid team ID")
		return
	}
	if !api.isTeamAdmin(account, teamID) {
		writeError(w, http.StatusForbidden, "team administrator role required")
		return
	}
	if r.Method == http.MethodGet {
		items, err := api.control.repository.ListOrganizationMembers(teamID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "unable to load members")
			return
		}
		result := make([]teamMemberRecord, 0, len(items))
		for _, item := range items {
			result = append(result, memberFromOrganizationMember(item))
		}
		writeJSON(w, http.StatusOK, map[string]any{"members": result})
		return
	}
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var req struct {
		Email string `json:"email"`
		Name  string `json:"displayName"`
	}
	if !readJSON(w, r, &req) || !validBoundedText(req.Email, 254) || !strings.Contains(req.Email, "@") {
		writeError(w, http.StatusBadRequest, "valid member email is required")
		return
	}
	member, err := api.control.repository.AddOrganizationMember(teamID, req.Email)
	if err != nil {
		writeError(w, http.StatusConflict, "member account must exist and cannot already belong to the team")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"member": memberFromOrganizationMember(member)})
}
