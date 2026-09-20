package httpapi

import (
	"net/http"
	"os"
	"strings"

	"ola-remote-server/internal/modelgateway"
	"ola-remote-server/internal/store"
)

func (api *API) modelList(w http.ResponseWriter, r *http.Request, account store.Account) {
	if teamID := r.Header.Get("X-Ola-Team-Id"); teamID != "" {
		if api.control.migrationErr != nil {
			writeError(w, http.StatusServiceUnavailable, "team model configuration is temporarily unavailable")
			return
		}
		config, ok := api.control.providerFor(account.ID, teamID)
		if !ok {
			writeError(w, http.StatusForbidden, "team access or model configuration is unavailable")
			return
		}
		provider, ok := providerConfig(config)
		if !ok {
			writeError(w, http.StatusServiceUnavailable, "selected model provider is unavailable")
			return
		}
		api.models.ModelsWithConfig(w, r, provider)
		return
	}
	api.models.Models(w, r)
}

func (api *API) modelChatCompletions(w http.ResponseWriter, r *http.Request, account store.Account) {
	if teamID := r.Header.Get("X-Ola-Team-Id"); teamID != "" {
		if api.control.migrationErr != nil {
			writeError(w, http.StatusServiceUnavailable, "team model configuration is temporarily unavailable")
			return
		}
		config, ok := api.control.providerFor(account.ID, teamID)
		if !ok {
			writeError(w, http.StatusForbidden, "team access or model configuration is unavailable")
			return
		}
		provider, ok := providerConfig(config)
		if !ok {
			writeError(w, http.StatusServiceUnavailable, "selected model provider is unavailable")
			return
		}
		api.models.ChatCompletionsWithConfig(w, r, provider)
		return
	}
	api.models.ChatCompletions(w, r)
}

func (api *API) modelResponses(w http.ResponseWriter, r *http.Request, account store.Account) {
	if teamID := r.Header.Get("X-Ola-Team-Id"); teamID != "" {
		if api.control.migrationErr != nil {
			writeError(w, http.StatusServiceUnavailable, "team model configuration is temporarily unavailable")
			return
		}
		config, ok := api.control.providerFor(account.ID, teamID)
		if !ok {
			writeError(w, http.StatusForbidden, "team access or model configuration is unavailable")
			return
		}
		provider, ok := providerConfig(config)
		if !ok {
			writeError(w, http.StatusServiceUnavailable, "selected model provider is unavailable")
			return
		}
		api.models.ResponsesWithConfig(w, r, provider)
		return
	}
	api.models.Responses(w, r)
}

func providerConfig(config modelConfigRecord) (modelgateway.ProviderConfig, bool) {
	// The browser never supplies URLs or credentials. Provider origins and
	// credentials are deployment-owned configuration only.
	if config.ProviderID != "platform-default" {
		return modelgateway.ProviderConfig{}, false
	}
	baseURL := strings.TrimRight(os.Getenv("OLA_MODEL_BASE_URL"), "/")
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	if !modelgateway.IsSafeProviderBaseURL(baseURL) {
		return modelgateway.ProviderConfig{}, false
	}
	return modelgateway.ProviderConfig{
		BaseURL:  baseURL,
		APIKey:   os.Getenv("OLA_MODEL_API_KEY"),
		Model:    config.Model,
		Explicit: true,
	}, true
}
