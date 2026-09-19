package httpapi

import (
	"regexp"
	"testing"
)

var uuidV4Pattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestControlIDsUsePostgresCompatibleUUIDv4(t *testing.T) {
	for i := 0; i < 16; i++ {
		if value := controlID("test"); !uuidV4Pattern.MatchString(value) {
			t.Fatalf("control ID must be UUID v4 for PostgreSQL storage, got %q", value)
		}
	}
}
