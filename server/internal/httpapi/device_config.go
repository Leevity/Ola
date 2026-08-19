package httpapi

import (
	"net/http"
	"strings"

	"ola-remote-server/internal/store"
)

func (api *API) deviceConfig(w http.ResponseWriter, r *http.Request, account store.Account) {
	if r.Method != http.MethodGet && r.Method != http.MethodPut {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/devices/")
	deviceID := strings.TrimPrefix(strings.TrimSuffix(path, "/config"), "/")
	if !strings.HasSuffix(path, "/config") || !validRemoteIdentifier(deviceID) {
		writeError(w, http.StatusNotFound, "device config not found")
		return
	}
	if r.Method == http.MethodGet {
		config, err := api.store.GetDeviceConfig(account.ID, deviceID)
		if err != nil {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, config)
		return
	}
	var req struct {
		Version int64 `json:"version"`
		Config  any   `json:"config"`
	}
	if !readJSON(w, r, &req) || req.Version < 0 || req.Config == nil {
		writeError(w, http.StatusBadRequest, "version and config are required")
		return
	}
	config, err := api.store.PutDeviceConfig(account.ID, deviceID, req.Version, req.Config)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, config)
}
