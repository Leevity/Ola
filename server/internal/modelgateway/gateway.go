package modelgateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"time"
)

// Gateway is a small OpenAI-compatible control-plane adapter. Provider secrets
// are read only by the server process and are never returned to the browser.
type Gateway struct {
	client  *http.Client
	baseURL string
	apiKey  string
	model   string
}

type ProviderConfig struct {
	BaseURL string
	APIKey  string
	Model   string
	// Explicit means this is a selected tenant/provider configuration. Missing
	// fields must fail closed and must never inherit the server default key.
	Explicit bool
}

func New() *Gateway {
	baseURL := strings.TrimRight(os.Getenv("OLA_MODEL_BASE_URL"), "/")
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	model := os.Getenv("OLA_MODEL_DEFAULT")
	if model == "" {
		model = "team-default"
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = safeDialContext
	return &Gateway{client: &http.Client{
		Timeout: 120 * time.Second,
		Transport: transport,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}, baseURL: baseURL, apiKey: os.Getenv("OLA_MODEL_API_KEY"), model: model}
}

func (g *Gateway) Models(w http.ResponseWriter, r *http.Request) {
	g.ModelsWithConfig(w, r, ProviderConfig{})
}

func (g *Gateway) ModelsWithConfig(w http.ResponseWriter, r *http.Request, override ProviderConfig) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	config := g.config(override)
	if config.Explicit && config.APIKey == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": map[string]string{"message": "Selected model provider is unavailable"}})
		return
	}
	if config.APIKey == "" {
		writeJSON(w, http.StatusOK, map[string]any{"object": "list", "data": []any{map[string]any{"id": config.Model, "object": "model", "owned_by": "ola"}}})
		return
	}
	g.proxyWithConfig(w, r, "/models", nil, config)
}

func (g *Gateway) ChatCompletions(w http.ResponseWriter, r *http.Request) {
	g.ChatCompletionsWithConfig(w, r, ProviderConfig{})
}

func (g *Gateway) ChatCompletionsWithConfig(w http.ResponseWriter, r *http.Request, override ProviderConfig) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	config := g.config(override)
	if _, ok := payload["model"]; !ok {
		payload["model"] = config.Model
	}
	normalized, _ := json.Marshal(payload)
	g.proxyWithConfig(w, r, "/chat/completions", normalized, config)
}

func (g *Gateway) proxy(w http.ResponseWriter, r *http.Request, path string, body []byte) {
	g.proxyWithConfig(w, r, path, body, g.config(ProviderConfig{}))
}

func (g *Gateway) proxyWithConfig(w http.ResponseWriter, r *http.Request, path string, body []byte, config ProviderConfig) {
	if config.APIKey == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": map[string]string{"message": "No model provider is configured"}})
		return
	}
	if !IsSafeProviderBaseURL(config.BaseURL) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": map[string]string{"message": "Selected model provider is unavailable"}})
		return
	}
	requestBody := bytes.NewReader(body)
	request, err := http.NewRequestWithContext(r.Context(), r.Method, strings.TrimRight(config.BaseURL, "/")+path, requestBody)
	if err != nil {
		http.Error(w, "provider request failed", http.StatusBadGateway)
		return
	}
	request.Header.Set("Authorization", "Bearer "+config.APIKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := g.client.Do(request)
	if err != nil {
		http.Error(w, "model provider unavailable", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	for key, values := range response.Header {
		for _, value := range values {
			if key == "Content-Type" || key == "Cache-Control" {
				w.Header().Add(key, value)
			}
		}
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, response.Body)
}

// IsSafeProviderBaseURL is deliberately strict because this process holds the
// platform credential used for model requests. Origins must be HTTPS public
// endpoints without URL credentials or an address that reaches local networks.
func IsSafeProviderBaseURL(value string) bool {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return false
	}
	if address, err := netip.ParseAddr(host); err == nil {
		return isPublicAddress(address)
	}
	return true
}

func safeDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	if len(addresses) == 0 {
		return nil, fmt.Errorf("model provider host has no addresses")
	}
	for _, candidate := range addresses {
		if !isPublicAddress(candidate) {
			return nil, fmt.Errorf("model provider host resolves to a private address")
		}
	}
	// Dial the already validated address rather than the hostname. Re-resolving
	// here would permit a DNS rebinding response between validation and connect.
	return (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort(addresses[0].String(), port))
}

func isPublicAddress(address netip.Addr) bool {
	return address.IsValid() && !address.IsPrivate() && !address.IsLoopback() &&
		!address.IsLinkLocalUnicast() && !address.IsLinkLocalMulticast() &&
		!address.IsUnspecified() && !address.IsMulticast()
}

func (g *Gateway) config(override ProviderConfig) ProviderConfig {
	if override.Explicit {
		if override.Model == "" {
			override.Model = g.model
		}
		return override
	}
	if override.BaseURL == "" {
		override.BaseURL = g.baseURL
	}
	if override.APIKey == "" {
		override.APIKey = g.apiKey
	}
	if override.Model == "" {
		override.Model = g.model
	}
	return override
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
