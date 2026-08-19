package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"ola-remote-server/internal/store"
)

type controlRole string

const (
	roleSystemAdmin controlRole = "system_admin"
	roleTeamAdmin   controlRole = "team_admin"
	roleMember      controlRole = "member"
	rolePersonal    controlRole = "personal_user"
)

type teamRecord struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Status    string    `json:"status"`
	CreatedBy string    `json:"createdBy"`
	CreatedAt time.Time `json:"createdAt"`
}

type teamMemberRecord struct {
	TeamID string      `json:"teamId"`
	UserID string      `json:"userId"`
	Email  string      `json:"email"`
	Name   string      `json:"displayName"`
	Role   controlRole `json:"role"`
}

type teamApplicationRecord struct {
	ID        string    `json:"id"`
	TeamID    string    `json:"teamId"`
	Name      string    `json:"name"`
	Applicant string    `json:"applicant"`
	Email     string    `json:"email"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`
}

type modelConfigRecord struct {
	ID            string    `json:"id"`
	TeamID        string    `json:"teamId"`
	Provider      string    `json:"provider"`
	Model         string    `json:"model"`
	BaseURL       string    `json:"baseUrl"`
	Enabled       bool      `json:"enabled"`
	IsDefault     bool      `json:"isDefault"`
	CredentialSet bool      `json:"credentialSet"`
	APIKey        string    `json:"-"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

type controlPlane struct {
	mu           sync.RWMutex
	teams        map[string]teamRecord
	members      map[string][]teamMemberRecord
	applications map[string]teamApplicationRecord
	models       map[string][]modelConfigRecord
	statePath    string
	persistence  controlPlanePersistence
}

func (p *controlPlane) providerFor(accountID, teamID string) (modelConfigRecord, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if teamID == "" {
		return modelConfigRecord{}, false
	}
	member := false
	for _, item := range p.members[teamID] {
		if item.UserID == accountID {
			member = true
			break
		}
	}
	if !member {
		return modelConfigRecord{}, false
	}
	for _, item := range p.models[teamID] {
		if item.Enabled && item.IsDefault {
			return item, true
		}
	}
	for _, item := range p.models[teamID] {
		if item.Enabled {
			return item, true
		}
	}
	return modelConfigRecord{}, false
}

type controlPlanePersistence interface {
	LoadControlPlaneState() ([]byte, error)
	SaveControlPlaneState([]byte) error
}

func newControlPlane(source any) *controlPlane {
	plane := &controlPlane{teams: map[string]teamRecord{}, members: map[string][]teamMemberRecord{}, applications: map[string]teamApplicationRecord{}, models: map[string][]modelConfigRecord{}, statePath: os.Getenv("OLA_CONTROL_PLANE_STATE_PATH")}
	plane.persistence, _ = source.(controlPlanePersistence)
	if plane.persistence != nil {
		if bytes, err := plane.persistence.LoadControlPlaneState(); err == nil {
			_ = json.Unmarshal(bytes, plane)
		}
	} else if plane.statePath != "" {
		if bytes, err := os.ReadFile(plane.statePath); err == nil {
			_ = json.Unmarshal(bytes, plane)
		}
	}
	return plane
}

func (p *controlPlane) persistLocked() {
	data, err := json.Marshal(p)
	if err != nil {
		return
	}
	if p.persistence != nil {
		_ = p.persistence.SaveControlPlaneState(data)
		return
	}
	if p.statePath == "" {
		return
	}
	temporary := p.statePath + ".tmp"
	if err := os.WriteFile(temporary, data, 0600); err == nil {
		_ = os.Rename(temporary, p.statePath)
	}
}

func controlID(prefix string) string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return prefix + "-" + time.Now().Format("20060102150405")
	}
	return prefix + "-" + hex.EncodeToString(buf)
}

func systemAdminEmails() map[string]bool {
	result := map[string]bool{}
	for _, email := range strings.Split(os.Getenv("OLA_SYSTEM_ADMIN_EMAILS"), ",") {
		if normalized := strings.ToLower(strings.TrimSpace(email)); normalized != "" {
			result[normalized] = true
		}
	}
	return result
}

func controlRoleFor(account store.Account) controlRole {
	if systemAdminEmails()[strings.ToLower(account.Email)] {
		return roleSystemAdmin
	}
	return rolePersonal
}

func (api *API) registerControlPlaneRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/control/me", api.withAuth(api.controlMe))
	mux.HandleFunc("/api/control/teams", api.withAuth(api.controlTeams))
	mux.HandleFunc("/api/control/team-applications", api.withAuth(api.controlApplications))
	mux.HandleFunc("/api/control/models", api.withAuth(api.controlModels))
	mux.HandleFunc("/api/control/members", api.withAuth(api.controlMembers))
}

func (api *API) controlMe(w http.ResponseWriter, r *http.Request, account store.Account) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	api.control.mu.RLock()
	defer api.control.mu.RUnlock()
	role := controlRoleFor(account)
	teams := make([]teamRecord, 0)
	memberships := make([]teamMemberRecord, 0)
	for teamID, team := range api.control.teams {
		for _, member := range api.control.members[teamID] {
			if member.UserID == account.ID {
				teams = append(teams, team)
				memberships = append(memberships, member)
			}
		}
	}
	if role == rolePersonal {
		for _, member := range memberships {
			if member.Role == roleTeamAdmin {
				role = roleTeamAdmin
				break
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"account": account, "role": role, "teams": teams, "memberships": memberships})
}

func (api *API) controlTeams(w http.ResponseWriter, r *http.Request, account store.Account) {
	if r.Method == http.MethodGet {
		api.control.mu.RLock()
		defer api.control.mu.RUnlock()
		result := make([]teamRecord, 0)
		for teamID, team := range api.control.teams {
			for _, member := range api.control.members[teamID] {
				if member.UserID == account.ID || controlRoleFor(account) == roleSystemAdmin {
					result = append(result, team)
					break
				}
			}
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
	api.control.mu.Lock()
	defer api.control.mu.Unlock()
	team := teamRecord{ID: controlID("team"), Name: strings.TrimSpace(req.Name), Status: "pending", CreatedBy: account.ID, CreatedAt: time.Now()}
	if controlRoleFor(account) == roleSystemAdmin {
		team.Status = "approved"
	}
	api.control.teams[team.ID] = team
	memberRole := roleMember
	if team.Status == "approved" {
		memberRole = roleTeamAdmin
	}
	api.control.members[team.ID] = []teamMemberRecord{{TeamID: team.ID, UserID: account.ID, Email: account.Email, Name: account.DisplayName, Role: memberRole}}
	if team.Status == "pending" {
		api.control.applications[team.ID] = teamApplicationRecord{ID: controlID("app"), TeamID: team.ID, Name: team.Name, Applicant: account.ID, Email: account.Email, Status: "pending", CreatedAt: time.Now()}
	}
	api.control.persistLocked()
	writeJSON(w, http.StatusCreated, map[string]any{"team": team, "role": memberRole})
}

func (api *API) controlApplications(w http.ResponseWriter, r *http.Request, account store.Account) {
	if controlRoleFor(account) != roleSystemAdmin {
		writeError(w, http.StatusForbidden, "system administrator role required")
		return
	}
	if r.Method == http.MethodGet {
		api.control.mu.RLock()
		defer api.control.mu.RUnlock()
		result := make([]teamApplicationRecord, 0, len(api.control.applications))
		for _, item := range api.control.applications {
			result = append(result, item)
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
	if !readJSON(w, r, &req) || req.TeamID == "" || (req.Action != "approve" && req.Action != "reject") {
		writeError(w, http.StatusBadRequest, "invalid team application action")
		return
	}
	api.control.mu.Lock()
	defer api.control.mu.Unlock()
	team, ok := api.control.teams[req.TeamID]
	if !ok {
		writeError(w, http.StatusNotFound, "team not found")
		return
	}
	if req.Action == "approve" {
		team.Status = "approved"
		api.control.teams[team.ID] = team
		members := api.control.members[team.ID]
		if len(members) > 0 {
			members[0].Role = roleTeamAdmin
			api.control.members[team.ID] = members
		}
	}
	app := api.control.applications[req.TeamID]
	if req.Action == "approve" {
		app.Status = "approved"
	} else {
		app.Status = "rejected"
	}
	api.control.applications[req.TeamID] = app
	api.control.persistLocked()
	writeJSON(w, http.StatusOK, map[string]any{"team": team, "application": app})
}

func (api *API) controlModels(w http.ResponseWriter, r *http.Request, account store.Account) {
	if r.Method == http.MethodGet {
		api.control.mu.RLock()
		defer api.control.mu.RUnlock()
		models := api.control.models[r.URL.Query().Get("teamId")]
		if models == nil {
			models = make([]modelConfigRecord, 0)
		}
		writeJSON(w, http.StatusOK, map[string]any{"models": models})
		return
	}
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var req struct {
		TeamID    string `json:"teamId"`
		Provider  string `json:"provider"`
		Model     string `json:"model"`
		BaseURL   string `json:"baseUrl"`
		IsDefault bool   `json:"isDefault"`
		APIKey    string `json:"apiKey"`
	}
	if !readJSON(w, r, &req) || !validBoundedText(req.TeamID, 128) || !validBoundedText(req.Provider, 80) || !validBoundedText(req.Model, 160) {
		writeError(w, http.StatusBadRequest, "invalid model configuration")
		return
	}
	api.control.mu.Lock()
	defer api.control.mu.Unlock()
	allowed := false
	for _, member := range api.control.members[req.TeamID] {
		if member.UserID == account.ID && (member.Role == roleTeamAdmin || controlRoleFor(account) == roleSystemAdmin) {
			allowed = true
		}
	}
	if !allowed {
		writeError(w, http.StatusForbidden, "team administrator role required")
		return
	}
	if req.IsDefault {
		for i := range api.control.models[req.TeamID] {
			api.control.models[req.TeamID][i].IsDefault = false
		}
	}
	model := modelConfigRecord{ID: controlID("model"), TeamID: req.TeamID, Provider: strings.TrimSpace(req.Provider), Model: strings.TrimSpace(req.Model), BaseURL: strings.TrimSpace(req.BaseURL), Enabled: true, IsDefault: req.IsDefault, CredentialSet: strings.TrimSpace(req.APIKey) != "", APIKey: strings.TrimSpace(req.APIKey), UpdatedAt: time.Now()}
	api.control.models[req.TeamID] = append(api.control.models[req.TeamID], model)
	api.control.persistLocked()
	writeJSON(w, http.StatusCreated, map[string]any{"model": model})
}

func (api *API) controlMembers(w http.ResponseWriter, r *http.Request, account store.Account) {
	teamID := r.URL.Query().Get("teamId")
	if !validRemoteIdentifier(teamID) {
		writeError(w, http.StatusBadRequest, "invalid team ID")
		return
	}
	api.control.mu.Lock()
	defer api.control.mu.Unlock()
	allowed := false
	for _, member := range api.control.members[teamID] {
		if member.UserID == account.ID && (member.Role == roleTeamAdmin || controlRoleFor(account) == roleSystemAdmin) {
			allowed = true
			break
		}
	}
	if !allowed {
		writeError(w, http.StatusForbidden, "team administrator role required")
		return
	}
	if r.Method == http.MethodGet {
		members := api.control.members[teamID]
		if members == nil {
			members = make([]teamMemberRecord, 0)
		}
		writeJSON(w, http.StatusOK, map[string]any{"members": members})
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
	for _, member := range api.control.members[teamID] {
		if strings.EqualFold(member.Email, strings.TrimSpace(req.Email)) {
			writeError(w, http.StatusConflict, "member already exists")
			return
		}
	}
	member := teamMemberRecord{TeamID: teamID, UserID: "pending:" + strings.ToLower(strings.TrimSpace(req.Email)), Email: strings.ToLower(strings.TrimSpace(req.Email)), Name: strings.TrimSpace(req.Name), Role: roleMember}
	api.control.members[teamID] = append(api.control.members[teamID], member)
	api.control.persistLocked()
	writeJSON(w, http.StatusCreated, map[string]any{"member": member})
}
