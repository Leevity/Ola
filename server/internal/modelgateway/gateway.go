package modelgateway

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
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
	return &Gateway{client: &http.Client{Timeout: 120 * time.Second}, baseURL: baseURL, apiKey: os.Getenv("OLA_MODEL_API_KEY"), model: model}
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

func (g *Gateway) config(override ProviderConfig) ProviderConfig {
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
