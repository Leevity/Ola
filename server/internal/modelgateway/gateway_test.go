package modelgateway

import "testing"

func TestIsSafeProviderBaseURL(t *testing.T) {
	for _, value := range []string{
		"https://api.openai.com/v1",
		"https://models.example.com/api/",
	} {
		if !IsSafeProviderBaseURL(value) {
			t.Fatalf("expected public HTTPS URL to be allowed: %s", value)
		}
	}

	for _, value := range []string{
		"http://models.example.com/v1",
		"https://user:secret@models.example.com/v1",
		"https://localhost/v1",
		"https://127.0.0.1/v1",
		"https://169.254.169.254/latest",
		"https://10.0.0.1/v1",
		"https://[::1]/v1",
	} {
		if IsSafeProviderBaseURL(value) {
			t.Fatalf("expected unsafe provider URL to be rejected: %s", value)
		}
	}
}
