package httpapi

import (
	"net/http"
	"os"
	"strings"
	"time"

	"ola-remote-server/internal/auth"
	"ola-remote-server/internal/modelgateway"
	"ola-remote-server/internal/store"
)

type publicWorkspace struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Name     string `json:"name"`
	Role     string `json:"role"`
	Revision string `json:"revision,omitempty"`
}

type publicModelResource struct {
	ID                   string `json:"id"`
	Model                string `json:"model"`
	ProviderName         string `json:"providerName"`
	DisplayName          string `json:"displayName,omitempty"`
	Enabled              bool   `json:"enabled"`
	IsDefault            bool   `json:"isDefault"`
	SupportsVision       bool   `json:"supportsVision"`
	SupportsFunctionCall bool   `json:"supportsFunctionCall"`
	Category             string `json:"category"`
	Protocol             string `json:"protocol,omitempty"`
	Revision             string `json:"revision,omitempty"`
}

func (api *API) registerAccountModelRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/account/workspaces", api.withAuth(api.accountWorkspaces))
	mux.HandleFunc("/api/account/workspaces/", api.withAuth(api.accountWorkspaceResources))
	mux.HandleFunc("/api/account/model-access-ticket", api.withAuth(api.issueModelAccessTicket))
}

func (api *API) accountWorkspaces(w http.ResponseWriter, r *http.Request, account store.Account) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	items := []publicWorkspace{{ID: "ola-personal-" + account.ID, Kind: "personal", Name: "Ola Personal", Role: "owner"}}
	if api.control.repository != nil {
		organizations, err := api.control.repository.ListOrganizations(account.ID, false)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "unable to load workspaces")
			return
		}
		memberships, err := api.control.repository.ListMemberships(account.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "unable to load workspace memberships")
			return
		}
		roles := make(map[string]string, len(memberships))
		for _, membership := range memberships {
			roles[membership.OrganizationID] = membership.Role
		}
		for _, organization := range organizations {
			if organization.Status != "approved" {
				continue
			}
			role := roles[organization.ID]
			if role == "" {
				role = "member"
			}
			items = append(items, publicWorkspace{ID: organization.ID, Kind: "team", Name: organization.Name, Role: role})
		}
	} else {
		api.control.mu.RLock()
		for teamID, team := range api.control.teams {
			if team.Status != "approved" {
				continue
			}
			for _, member := range api.control.members[teamID] {
				if member.UserID == account.ID {
					items = append(items, publicWorkspace{ID: teamID, Kind: "team", Name: team.Name, Role: string(member.Role)})
					break
				}
			}
		}
		api.control.mu.RUnlock()
	}
	writeJSON(w, http.StatusOK, map[string]any{"workspaces": items})
}

func (api *API) accountWorkspaceResources(w http.ResponseWriter, r *http.Request, account store.Account) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	workspaceID := strings.TrimPrefix(r.URL.Path, "/api/account/workspaces/")
	workspaceID = strings.TrimSuffix(workspaceID, "/model-resources")
	if workspaceID == "" || !strings.HasSuffix(r.URL.Path, "/model-resources") {
		writeError(w, http.StatusNotFound, "workspace resource route not found")
		return
	}
	if workspaceID == "ola-personal-"+account.ID {
		writeJSON(w, http.StatusOK, map[string]any{"resources": []publicModelResource{api.personalResource()}})
		return
	}
	config, ok := api.control.providerFor(account.ID, workspaceID)
	if !ok || !config.Enabled {
		writeError(w, http.StatusForbidden, "workspace model resource is unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"resources": []publicModelResource{resourceFromConfig(config)}})
}

func (api *API) issueModelAccessTicket(w http.ResponseWriter, r *http.Request, account store.Account) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var request struct {
		WorkspaceID string `json:"workspaceId"`
		ResourceID  string `json:"resourceId"`
		SessionID   string `json:"sessionId"`
		DeviceID    string `json:"deviceId"`
	}
	if !readJSON(w, r, &request) || strings.TrimSpace(request.WorkspaceID) == "" || strings.TrimSpace(request.ResourceID) == "" || strings.TrimSpace(request.SessionID) == "" || strings.TrimSpace(request.DeviceID) == "" {
		writeError(w, http.StatusBadRequest, "invalid model access request")
		return
	}
	device, ok := api.store.GetDevice(request.DeviceID)
	if !ok || device.AccountID != account.ID {
		writeError(w, http.StatusForbidden, "device is not registered for this account")
		return
	}
	parentClaims, err := auth.ParseToken([]byte(api.cfg.JWTSecret), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid account token")
		return
	}
	var resource publicModelResource
	if request.WorkspaceID == "ola-personal-"+account.ID && request.ResourceID == "personal-default" {
		resource = api.personalResource()
	} else {
		config, found := api.control.providerFor(account.ID, request.WorkspaceID)
		if !found || !config.Enabled || config.ID != request.ResourceID {
			writeError(w, http.StatusForbidden, "model resource is unavailable")
			return
		}
		resource = resourceFromConfig(config)
	}
	ticket, err := auth.IssueModelAccessTicket([]byte(api.cfg.JWTSecret), auth.ModelAccessClaims{
		AccountID: account.ID, ParentTokenID: parentClaims.ID, DeviceID: device.ID, WorkspaceID: request.WorkspaceID,
		ResourceID: request.ResourceID, SessionID: request.SessionID, Model: resource.Model,
	}, 10*time.Minute)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "unable to issue model access ticket")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ticket": ticket, "expiresAt": time.Now().Add(10 * time.Minute).Unix()})
}

func (api *API) personalResource() publicModelResource {
	model := strings.TrimSpace(os.Getenv("OLA_MODEL_DEFAULT"))
	if model == "" {
		model = "team-default"
	}
	return publicModelResource{ID: "personal-default", Model: model, ProviderName: "Ola", DisplayName: model, Enabled: true, IsDefault: true, SupportsFunctionCall: true, Category: "chat", Protocol: "openai-chat", Revision: "server"}
}

func resourceFromConfig(config modelConfigRecord) publicModelResource {
	return publicModelResource{ID: config.ID, Model: config.Model, ProviderName: "Ola", DisplayName: config.Model, Enabled: config.Enabled, IsDefault: config.IsDefault, SupportsFunctionCall: true, Category: "chat", Protocol: "openai-chat", Revision: config.UpdatedAt.UTC().Format(time.RFC3339Nano)}
}

func (api *API) modelTicketClaims(w http.ResponseWriter, r *http.Request) (*auth.ModelAccessClaims, bool) {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		writeError(w, http.StatusUnauthorized, "missing model access ticket")
		return nil, false
	}
	claims, err := auth.ParseModelAccessTicket([]byte(api.cfg.JWTSecret), strings.TrimPrefix(header, "Bearer "))
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid model access ticket")
		return nil, false
	}
	device, ok := api.store.GetDevice(claims.DeviceID)
	if !ok || device.AccountID != claims.AccountID {
		writeError(w, http.StatusUnauthorized, "model access device is unavailable")
		return nil, false
	}
	if api.tokens.IsAccountTokenRevoked(claims.ParentTokenID) {
		writeError(w, http.StatusUnauthorized, "model access ticket has been revoked")
		return nil, false
	}
	return claims, true
}

func (api *API) modelChatWithTicket(w http.ResponseWriter, r *http.Request) {
	claims, ok := api.modelTicketClaims(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	config, valid := api.ticketProviderConfig(claims)
	if !valid {
		writeError(w, http.StatusForbidden, "model resource is no longer available")
		return
	}
	api.models.ChatCompletionsWithConfig(w, r, config)
}

func (api *API) modelResponsesWithTicket(w http.ResponseWriter, r *http.Request) {
	claims, ok := api.modelTicketClaims(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	config, valid := api.ticketProviderConfig(claims)
	if !valid {
		writeError(w, http.StatusForbidden, "model resource is no longer available")
		return
	}
	api.models.ResponsesWithConfig(w, r, config)
}

func (api *API) ticketProviderConfig(claims *auth.ModelAccessClaims) (modelgateway.ProviderConfig, bool) {
	if claims.WorkspaceID != "ola-personal-"+claims.AccountID {
		config, ok := api.control.providerFor(claims.AccountID, claims.WorkspaceID)
		if !ok || !config.Enabled || config.ID != claims.ResourceID || config.Model != claims.Model {
			return modelgateway.ProviderConfig{}, false
		}
	}
	baseURL := strings.TrimRight(os.Getenv("OLA_MODEL_BASE_URL"), "/")
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	return modelgateway.ProviderConfig{BaseURL: baseURL, APIKey: os.Getenv("OLA_MODEL_API_KEY"), Model: claims.Model, Explicit: true}, modelgateway.IsSafeProviderBaseURL(baseURL)
}

func (api *API) modelChatEndpoint(w http.ResponseWriter, r *http.Request) {
	if _, err := auth.ParseModelAccessTicket([]byte(api.cfg.JWTSecret), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")); err == nil {
		api.modelChatWithTicket(w, r)
		return
	}
	api.withAuth(api.modelChatCompletions)(w, r)
}

func (api *API) modelResponsesEndpoint(w http.ResponseWriter, r *http.Request) {
	if _, err := auth.ParseModelAccessTicket([]byte(api.cfg.JWTSecret), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")); err == nil {
		api.modelResponsesWithTicket(w, r)
		return
	}
	api.withAuth(api.modelResponses)(w, r)
}
