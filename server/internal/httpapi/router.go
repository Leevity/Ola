package httpapi

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"ola-remote-server/internal/auth"
	"ola-remote-server/internal/config"
	"ola-remote-server/internal/pairing"
	"ola-remote-server/internal/store"
)

var remoteIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var pairingCodePattern = regexp.MustCompile(`^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$`)

func validBoundedText(value string, maxBytes int) bool {
	trimmed := strings.TrimSpace(value)
	return trimmed != "" && len(trimmed) <= maxBytes
}

func validRemoteIdentifier(value string) bool {
	return remoteIdentifierPattern.MatchString(value)
}

type API struct {
	cfg         config.Config
	store       store.Store
	revoker     DeviceSessionRevoker
	limiter     PairingAttemptLimiter
	tokens      AccountTokenRevoker
	pairing     EphemeralPairingState
	authLimiter AuthAttemptLimiter
}

type DeviceSessionRevoker interface {
	RevokeDevice(deviceID string)
}

type DevicePresence interface {
	TouchDevice(deviceID string)
	IsDeviceOnline(deviceID string) bool
}

type DeviceRemotePermission interface {
	SetDeviceRemoteAllowed(deviceID string, allowed bool)
	IsDeviceRemoteAllowed(deviceID string) bool
}

type SessionAuditReader interface {
	ListRemoteSessionAudits(accountID string, limit int) ([]store.RemoteSessionAudit, error)
}

func (api *API) remotePermission() DeviceRemotePermission {
	permission, _ := api.revoker.(DeviceRemotePermission)
	return permission
}

func (api *API) presence() DevicePresence {
	presence, _ := api.revoker.(DevicePresence)
	return presence
}

func NewRouter(cfg config.Config, st store.Store, revoker DeviceSessionRevoker) http.Handler {
	limiter, ok := revoker.(PairingAttemptLimiter)
	if !ok {
		limiter = newLocalPairingLimiter()
	}
	tokens, ok := revoker.(AccountTokenRevoker)
	if !ok {
		tokens = newLocalTokenRevoker()
	}
	api := &API{cfg: cfg, store: st, revoker: revoker, limiter: limiter, tokens: tokens}
	api.authLimiter, _ = revoker.(AuthAttemptLimiter)
	if api.authLimiter == nil {
		api.authLimiter = newLocalAuthLimiter()
	}
	api.pairing, _ = revoker.(EphemeralPairingState)
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/auth/register", api.register)
	mux.HandleFunc("/api/auth/login", api.login)
	mux.HandleFunc("/api/auth/me", api.withAuth(api.me))
	mux.HandleFunc("/api/auth/logout", api.logout)
	mux.HandleFunc("/api/devices/register", api.withAuth(api.registerDevice))
	mux.HandleFunc("/api/devices", api.withAuth(api.listDevices))
	mux.HandleFunc("/api/devices/", api.withAuth(api.deviceAction))
	mux.HandleFunc("/api/sessions", api.withAuth(api.listSessions))
	mux.HandleFunc("/api/pairing/create", api.withAuth(api.createPairing))
	mux.HandleFunc("/api/pairing/refresh", api.withAuth(api.createPairing))
	mux.HandleFunc("/api/pairing/revoke", api.withAuth(api.revokePairing))
	mux.HandleFunc("/api/pairing/resolve", api.withAuth(api.resolvePairing))
	return withCORS(mux, cfg.DevelopmentMode)
}

func (api *API) register(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	if !api.authLimiter.ConsumeRegistrationAttempt("register:" + directClientAddress(r)) {
		writeError(w, http.StatusTooManyRequests, "too many registration attempts; try again later")
		return
	}
	var req struct {
		Email       string `json:"email"`
		Password    string `json:"password"`
		DisplayName string `json:"displayName"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !validBoundedText(req.Email, 254) || !strings.Contains(req.Email, "@") ||
		len(req.Password) < 8 || len(req.Password) > 72 ||
		(strings.TrimSpace(req.DisplayName) != "" && len(strings.TrimSpace(req.DisplayName)) > 100) {
		writeError(w, http.StatusBadRequest, "invalid account registration fields")
		return
	}
	account, err := api.store.RegisterAccount(req.Email, req.Password, req.DisplayName)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	api.issue(w, account)
}

func (api *API) login(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !validBoundedText(req.Email, 254) || len(req.Password) < 8 || len(req.Password) > 72 {
		writeError(w, http.StatusUnauthorized, "invalid email or password")
		return
	}
	authKey := loginAttemptKey(r, req.Email)
	if !api.authLimiter.ConsumeAuthAttempt(authKey) {
		writeError(w, http.StatusTooManyRequests, "too many login attempts; try again later")
		return
	}
	account, err := api.store.Login(req.Email, req.Password)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid email or password")
		return
	}
	api.authLimiter.ClearAuthFailures(authKey)
	api.issue(w, account)
}

func (api *API) me(w http.ResponseWriter, r *http.Request, account store.Account) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"account": account})
}

func (api *API) logout(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	claims, ok := api.authenticate(w, r)
	if !ok {
		return
	}
	api.tokens.RevokeAccountToken(claims.ID, time.Unix(claims.ExpiresAt, 0))
	for _, device := range api.store.ListDevices(claims.AccountID) {
		if api.revoker != nil {
			api.revoker.RevokeDevice(device.ID)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (api *API) registerDevice(w http.ResponseWriter, r *http.Request, account store.Account) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var req struct {
		DeviceName  string `json:"deviceName"`
		Platform    string `json:"platform"`
		Fingerprint string `json:"fingerprint"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !validBoundedText(req.DeviceName, 100) || !validBoundedText(req.Platform, 40) ||
		len(strings.TrimSpace(req.Fingerprint)) > 512 {
		writeError(w, http.StatusBadRequest, "invalid device registration fields")
		return
	}
	device, err := api.store.RegisterDevice(account.ID, req.DeviceName, req.Platform, req.Fingerprint)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if presence := api.presence(); presence != nil {
		presence.TouchDevice(device.ID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"device": device})
}

func (api *API) listDevices(w http.ResponseWriter, r *http.Request, account store.Account) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	devices := api.store.ListDevices(account.ID)
	if presence := api.presence(); presence != nil {
		for index := range devices {
			devices[index].IsOnline = presence.IsDeviceOnline(devices[index].ID)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": devices})
}

func (api *API) listSessions(w http.ResponseWriter, r *http.Request, account store.Account) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	reader, ok := api.store.(SessionAuditReader)
	if !ok {
		writeError(w, http.StatusNotImplemented, "session audit query is unavailable")
		return
	}
	sessions, err := reader.ListRemoteSessionAudits(account.ID, 100)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to query session audits")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
}

func (api *API) deviceAction(w http.ResponseWriter, r *http.Request, account store.Account) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/devices/")
	deviceID, action, ok := strings.Cut(path, "/")
	if !ok || !validRemoteIdentifier(deviceID) {
		writeError(w, http.StatusNotFound, "device action not found")
		return
	}
	if action == "signaling-token" {
		owned := false
		for _, device := range api.store.ListDevices(account.ID) {
			if device.ID == deviceID {
				owned = true
				break
			}
		}
		if !owned {
			writeError(w, http.StatusNotFound, "device not found")
			return
		}
		token, err := auth.IssueDeviceToken([]byte(api.cfg.JWTSecret), account.ID, deviceID, api.cfg.DeviceTokenTTL)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"token": token, "expiresIn": int(api.cfg.DeviceTokenTTL.Seconds())})
		return
	}
	if action != "heartbeat" {
		writeError(w, http.StatusNotFound, "device action not found")
		return
	}
	device, err := api.store.HeartbeatDevice(account.ID, deviceID)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if presence := api.presence(); presence != nil {
		presence.TouchDevice(device.ID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"device": device})
}

func (api *API) createPairing(w http.ResponseWriter, r *http.Request, account store.Account) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var req struct {
		DeviceID string `json:"deviceId"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !validRemoteIdentifier(req.DeviceID) {
		writeError(w, http.StatusBadRequest, "invalid device ID")
		return
	}
	owned := false
	for _, device := range api.store.ListDevices(account.ID) {
		if device.ID == req.DeviceID {
			owned = true
			break
		}
	}
	if !owned {
		writeError(w, http.StatusNotFound, "device not found")
		return
	}
	if presence := api.presence(); presence != nil && !presence.IsDeviceOnline(req.DeviceID) {
		writeError(w, http.StatusConflict, "device is offline")
		return
	}
	if permission := api.remotePermission(); permission != nil {
		permission.SetDeviceRemoteAllowed(req.DeviceID, true)
	}
	code, err := pairing.GenerateCode()
	if err != nil {
		if permission := api.remotePermission(); permission != nil {
			permission.SetDeviceRemoteAllowed(req.DeviceID, false)
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	var pairingCode store.PairingCode
	if api.pairing != nil {
		err = api.pairing.SaveEphemeralPairing(code, req.DeviceID, api.cfg.PairingTTL)
		now := time.Now()
		pairingCode = store.PairingCode{Code: code, DeviceID: req.DeviceID,
			CreatedAt: now, ExpiresAt: now.Add(api.cfg.PairingTTL)}
	} else {
		pairingCode, err = api.store.SavePairingCode(code, req.DeviceID, api.cfg.PairingTTL)
	}
	if err != nil {
		if permission := api.remotePermission(); permission != nil {
			permission.SetDeviceRemoteAllowed(req.DeviceID, false)
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"code": pairingCode.Code, "expiresAt": pairingCode.ExpiresAt})
}

func (api *API) revokePairing(w http.ResponseWriter, r *http.Request, account store.Account) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var req struct {
		DeviceID string `json:"deviceId"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !validRemoteIdentifier(req.DeviceID) {
		writeError(w, http.StatusBadRequest, "invalid device ID")
		return
	}
	revoked, err := api.store.RevokePairingCodesForDevice(account.ID, req.DeviceID)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if api.pairing != nil {
		ephemeralRevoked, ephemeralErr := api.pairing.RevokeEphemeralPairings(req.DeviceID)
		if ephemeralErr != nil {
			writeError(w, http.StatusInternalServerError, ephemeralErr.Error())
			return
		}
		revoked += ephemeralRevoked
	}
	if api.revoker != nil {
		api.revoker.RevokeDevice(req.DeviceID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "revoked": revoked})
}

func (api *API) resolvePairing(w http.ResponseWriter, r *http.Request, account store.Account) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var req struct {
		Code               string `json:"code"`
		ControllerDeviceID string `json:"controllerDeviceId"`
		SessionID          string `json:"sessionId"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	normalizedCode := pairing.NormalizeCode(req.Code)
	if !pairingCodePattern.MatchString(normalizedCode) ||
		!validRemoteIdentifier(req.ControllerDeviceID) || !validRemoteIdentifier(req.SessionID) {
		writeError(w, http.StatusBadRequest, "invalid pairing request")
		return
	}
	attemptKey := account.ID + ":" + directClientAddress(r)
	if !api.limiter.ConsumePairingAttempt(attemptKey) {
		writeError(w, http.StatusTooManyRequests, "too many invalid pairing attempts; try again later")
		return
	}
	controller, ok := api.store.GetDevice(req.ControllerDeviceID)
	if !ok || controller.AccountID != account.ID || req.SessionID == "" {
		writeError(w, http.StatusBadRequest, "controller device not found")
		return
	}
	var pairingCode store.PairingCode
	var device store.Device
	var err error
	if api.pairing != nil {
		var deviceID string
		var expiresAt time.Time
		deviceID, expiresAt, err = api.pairing.ConsumeEphemeralPairing(normalizedCode)
		if err == nil {
			var found bool
			device, found = api.store.GetDevice(deviceID)
			if !found || (api.presence() != nil && !api.presence().IsDeviceOnline(deviceID)) {
				err = errors.New("device is unavailable")
			}
			pairingCode = store.PairingCode{Code: normalizedCode, DeviceID: deviceID, ExpiresAt: expiresAt}
		}
	} else {
		pairingCode, device, err = api.store.ResolvePairingCode(normalizedCode)
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ticket, err := auth.IssueRemoteSessionTicket([]byte(api.cfg.JWTSecret), auth.RemoteSessionClaims{
		ControllerAccount: controller.AccountID,
		ControllerDevice:  controller.ID,
		ControllerName:    controller.DeviceName,
		ControlledDevice:  device.ID,
		SessionID:         req.SessionID,
	}, api.cfg.SessionTTL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	api.limiter.ClearPairingFailures(attemptKey)
	iceServers := []map[string]string{{"urls": api.cfg.STUNURL}}
	if api.cfg.TURNURL != "" && api.cfg.TURNSecret != "" {
		turnUsername, turnCredential := issueTURNCredentials(
			api.cfg.TURNSecret, controller.ID, api.cfg.TURNCredentialTTL,
		)
		iceServers = append(iceServers, map[string]string{
			"urls": api.cfg.TURNURL, "username": turnUsername, "credential": turnCredential,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"deviceId":      device.ID,
		"accountId":     device.AccountID,
		"deviceName":    device.DeviceName,
		"platform":      device.Platform,
		"expiresAt":     pairingCode.ExpiresAt,
		"sessionId":     req.SessionID,
		"sessionTicket": ticket,
		"iceServers":    iceServers,
	})
}

func directClientAddress(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}

func loginAttemptKey(r *http.Request, email string) string {
	digest := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return fmt.Sprintf("login:%s:%x", directClientAddress(r), digest[:12])
}

func (api *API) issue(w http.ResponseWriter, account store.Account) {
	token, err := auth.IssueToken([]byte(api.cfg.JWTSecret), account.ID, account.Email)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "account": account})
}

func (api *API) withAuth(next func(http.ResponseWriter, *http.Request, store.Account)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, ok := api.authenticate(w, r)
		if !ok {
			return
		}
		account, ok := api.store.GetAccount(claims.AccountID)
		if !ok {
			writeError(w, http.StatusUnauthorized, "account not found")
			return
		}
		next(w, r, account)
	}
}

func (api *API) authenticate(w http.ResponseWriter, r *http.Request) (*auth.Claims, bool) {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		writeError(w, http.StatusUnauthorized, "missing bearer token")
		return nil, false
	}
	claims, err := auth.ParseToken([]byte(api.cfg.JWTSecret), strings.TrimPrefix(header, "Bearer "))
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid token")
		return nil, false
	}
	if claims.ID == "" || api.tokens.IsAccountTokenRevoked(claims.ID) {
		writeError(w, http.StatusUnauthorized, "token revoked")
		return nil, false
	}
	return claims, true
}

func withCORS(next http.Handler, developmentMode bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if developmentMode && isLocalDevelopmentOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			if developmentMode && isLocalDevelopmentOrigin(origin) {
				w.WriteHeader(http.StatusNoContent)
			} else {
				writeError(w, http.StatusForbidden, "cross-origin requests are disabled")
			}
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isLocalDevelopmentOrigin(origin string) bool {
	if origin == "" {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return false
	}
	return parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1"
}

func requireMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method == method {
		return true
	}
	writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	return false
}

func readJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, http.StatusBadRequest, "request body must contain one JSON object")
		return false
	}
	return true
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
