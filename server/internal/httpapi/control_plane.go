package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
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
	ID         string    `json:"id"`
	TeamID     string    `json:"teamId"`
	ProviderID string    `json:"providerId"`
	Model      string    `json:"model"`
	Enabled    bool      `json:"enabled"`
	IsDefault  bool      `json:"isDefault"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type controlPlane struct {
	mu           sync.RWMutex
	repository   store.ControlPlaneRepository
	migrationErr error
	teams        map[string]teamRecord
	members      map[string][]teamMemberRecord
	applications map[string]teamApplicationRecord
	models       map[string][]modelConfigRecord
	statePath    string
	persistence  controlPlanePersistence
	// MeshNodes is exported so it is included in the existing control-plane JSON
	// snapshot. Device credentials never appear here; only public Node metadata
	// and capability manifests are persisted. MeshEvents intentionally stays
	// process-local so task payloads are never written to the state snapshot.
	MeshNodes  map[string]meshNodeRecord    `json:"meshNodes"`
	MeshEvents map[string][]meshEventRecord `json:"-"`
	// Ticket nonces are intentionally memory-only while Mesh remains status-only.
	// They expire with the signed ticket and prevent a live bearer ticket from
	// publishing more than one event. The future persistent queue will move this
	// replay ledger into the same encrypted transaction as event delivery.
	UsedMeshTicketNonces map[string]int64 `json:"-"`
}

// The control plane intentionally keeps its maps private so callers cannot
// mutate authorization state without the lock.  JSON does not serialize private
// fields, therefore an explicit snapshot prevents a restart from silently
// dropping teams, memberships, and model selections.
func (p *controlPlane) MarshalJSON() ([]byte, error) {
	if p.repository != nil {
		// Organizations, members, applications, and model configuration live in
		// relational tables. The legacy snapshot remains only for mesh metadata.
		return json.Marshal(struct {
			MeshNodes map[string]meshNodeRecord `json:"meshNodes"`
		}{p.MeshNodes})
	}
	return json.Marshal(struct {
		Teams        map[string]teamRecord            `json:"teams"`
		Members      map[string][]teamMemberRecord    `json:"members"`
		Applications map[string]teamApplicationRecord `json:"applications"`
		Models       map[string][]modelConfigRecord   `json:"models"`
		MeshNodes    map[string]meshNodeRecord        `json:"meshNodes"`
	}{p.teams, p.members, p.applications, p.models, p.MeshNodes})
}

func (p *controlPlane) UnmarshalJSON(data []byte) error {
	var snapshot struct {
		Teams        map[string]teamRecord            `json:"teams"`
		Members      map[string][]teamMemberRecord    `json:"members"`
		Applications map[string]teamApplicationRecord `json:"applications"`
		Models       map[string][]modelConfigRecord   `json:"models"`
		MeshNodes    map[string]meshNodeRecord        `json:"meshNodes"`
	}
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return err
	}
	if p.repository == nil {
		// The in-memory test/file-store mode retains the legacy representation.
		// Production skips these fields even if an old snapshot still contains
		// them, preventing stale authorization data from being resurrected.
		if snapshot.Teams != nil {
			p.teams = snapshot.Teams
		}
		if snapshot.Members != nil {
			p.members = snapshot.Members
		}
		if snapshot.Applications != nil {
			p.applications = snapshot.Applications
		}
		if snapshot.Models != nil {
			p.models = snapshot.Models
		}
	}
	if snapshot.MeshNodes != nil {
		p.MeshNodes = snapshot.MeshNodes
	}
	return nil
}

func (p *controlPlane) providerFor(accountID, teamID string) (modelConfigRecord, bool) {
	if p.repository != nil {
		config, ok, err := p.repository.ProviderForOrganization(accountID, teamID)
		if err != nil || !ok {
			return modelConfigRecord{}, false
		}
		return modelConfigRecord{ID: config.ID, TeamID: config.OrganizationID, ProviderID: config.Provider, Model: config.Model, Enabled: config.Enabled, IsDefault: config.IsDefault, UpdatedAt: config.UpdatedAt}, true
	}
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
	plane := &controlPlane{teams: map[string]teamRecord{}, members: map[string][]teamMemberRecord{}, applications: map[string]teamApplicationRecord{}, models: map[string][]modelConfigRecord{}, MeshNodes: map[string]meshNodeRecord{}, MeshEvents: map[string][]meshEventRecord{}, UsedMeshTicketNonces: map[string]int64{}, statePath: os.Getenv("OLA_CONTROL_PLANE_STATE_PATH")}
	plane.persistence, _ = source.(controlPlanePersistence)
	plane.repository, _ = source.(store.ControlPlaneRepository)
	if plane.persistence != nil {
		if bytes, err := plane.persistence.LoadControlPlaneState(); err == nil {
			if plane.repository != nil {
				if migrator, ok := source.(store.LegacyControlPlaneMigrator); ok {
					plane.migrationErr = migrator.MigrateLegacyControlPlaneSnapshot(bytes)
				}
			}
			_ = json.Unmarshal(bytes, plane)
		}
	} else if plane.statePath != "" {
		if bytes, err := os.ReadFile(plane.statePath); err == nil {
			_ = json.Unmarshal(bytes, plane)
		}
	}
	if plane.MeshNodes == nil {
		plane.MeshNodes = map[string]meshNodeRecord{}
	}
	if plane.MeshEvents == nil {
		plane.MeshEvents = map[string][]meshEventRecord{}
	}
	if plane.UsedMeshTicketNonces == nil {
		plane.UsedMeshTicketNonces = map[string]int64{}
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
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		// Control-plane IDs are stored in PostgreSQL UUID columns. The prefix is
		// intentionally not encoded in the persisted identifier.
		return fmt.Sprintf("00000000-0000-4000-8000-%012x", time.Now().UnixNano()&0xffffffffffff)
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return hex.EncodeToString(buf[:4]) + "-" + hex.EncodeToString(buf[4:6]) + "-" +
		hex.EncodeToString(buf[6:8]) + "-" + hex.EncodeToString(buf[8:10]) + "-" + hex.EncodeToString(buf[10:])
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
	if api.control.migrationErr != nil {
		writeError(w, http.StatusServiceUnavailable, "control-plane migration requires operator attention")
		return
	}
	if api.control.repository != nil {
		api.controlMeRelational(w, r, account)
		return
	}
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
	if api.control.migrationErr != nil {
		writeError(w, http.StatusServiceUnavailable, "control-plane migration requires operator attention")
		return
	}
	if api.control.repository != nil {
		api.controlTeamsRelational(w, r, account)
		return
	}
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
	if api.control.migrationErr != nil {
		writeError(w, http.StatusServiceUnavailable, "control-plane migration requires operator attention")
		return
	}
	if api.control.repository != nil {
		api.controlApplicationsRelational(w, r, account)
		return
	}
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
	if api.control.migrationErr != nil {
		writeError(w, http.StatusServiceUnavailable, "control-plane migration requires operator attention")
		return
	}
	if api.control.repository != nil {
		api.controlModelsRelational(w, r, account)
		return
	}
	teamID := r.URL.Query().Get("teamId")
	if r.Method == http.MethodPost {
		teamID = ""
	}
	if r.Method == http.MethodGet {
		if !api.canAccessTeamModels(account, teamID) {
			writeError(w, http.StatusForbidden, "team membership required")
			return
		}
		api.control.mu.RLock()
		defer api.control.mu.RUnlock()
		models := api.control.models[teamID]
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
		TeamID     string `json:"teamId"`
		ProviderID string `json:"providerId"`
		Model      string `json:"model"`
		IsDefault  bool   `json:"isDefault"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !validBoundedText(req.TeamID, 128) || !validBoundedText(req.Model, 160) || req.ProviderID != "platform-default" {
		writeError(w, http.StatusBadRequest, "invalid model configuration")
		return
	}
	api.control.mu.Lock()
	defer api.control.mu.Unlock()
	if !api.isTeamAdmin(account, req.TeamID) {
		writeError(w, http.StatusForbidden, "team administrator role required")
		return
	}
	if req.IsDefault {
		for i := range api.control.models[req.TeamID] {
			api.control.models[req.TeamID][i].IsDefault = false
		}
	}
	model := modelConfigRecord{ID: controlID("model"), TeamID: req.TeamID, ProviderID: req.ProviderID, Model: strings.TrimSpace(req.Model), Enabled: true, IsDefault: req.IsDefault, UpdatedAt: time.Now()}
	api.control.models[req.TeamID] = append(api.control.models[req.TeamID], model)
	api.control.persistLocked()
	writeJSON(w, http.StatusCreated, map[string]any{"model": model})
}

func (api *API) canAccessTeamModels(account store.Account, teamID string) bool {
	if api.control.repository != nil {
		if controlRoleFor(account) == roleSystemAdmin {
			return true
		}
		allowed, err := api.control.repository.CanAccessOrganization(account.ID, teamID)
		return err == nil && allowed
	}
	if controlRoleFor(account) == roleSystemAdmin {
		return true
	}
	api.control.mu.RLock()
	defer api.control.mu.RUnlock()
	for _, member := range api.control.members[teamID] {
		if member.UserID == account.ID {
			return true
		}
	}
	return false
}

func (api *API) isTeamAdmin(account store.Account, teamID string) bool {
	if api.control.repository != nil {
		if controlRoleFor(account) == roleSystemAdmin {
			return true
		}
		allowed, err := api.control.repository.IsOrganizationAdmin(account.ID, teamID)
		return err == nil && allowed
	}
	if controlRoleFor(account) == roleSystemAdmin {
		return true
	}
	for _, member := range api.control.members[teamID] {
		if member.UserID == account.ID && member.Role == roleTeamAdmin {
			return true
		}
	}
	return false
}

func (api *API) controlMembers(w http.ResponseWriter, r *http.Request, account store.Account) {
	if api.control.migrationErr != nil {
		writeError(w, http.StatusServiceUnavailable, "control-plane migration requires operator attention")
		return
	}
	if api.control.repository != nil {
		api.controlMembersRelational(w, r, account)
		return
	}
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
