package httpapi

import (
	"net/http"

	"ola-remote-server/internal/modelgateway"
	"ola-remote-server/internal/store"
)

func (api *API) modelList(w http.ResponseWriter, r *http.Request, account store.Account) {
	if teamID := r.Header.Get("X-Ola-Team-Id"); teamID != "" {
		config, ok := api.control.providerFor(account.ID, teamID)
		if !ok {
			writeError(w, http.StatusForbidden, "team access or model configuration is unavailable")
			return
		}
		api.models.ModelsWithConfig(w, r, providerConfig(config))
		return
	}
	api.models.Models(w, r)
}

func (api *API) modelChatCompletions(w http.ResponseWriter, r *http.Request, account store.Account) {
	if teamID := r.Header.Get("X-Ola-Team-Id"); teamID != "" {
		config, ok := api.control.providerFor(account.ID, teamID)
		if !ok {
			writeError(w, http.StatusForbidden, "team access or model configuration is unavailable")
			return
		}
		api.models.ChatCompletionsWithConfig(w, r, providerConfig(config))
		return
	}
	api.models.ChatCompletions(w, r)
}

func providerConfig(config modelConfigRecord) modelgateway.ProviderConfig {
	return modelgateway.ProviderConfig{BaseURL: config.BaseURL, Model: config.Model, APIKey: config.APIKey}
}
