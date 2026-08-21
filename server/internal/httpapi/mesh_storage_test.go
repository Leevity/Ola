package httpapi

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestMeshEventsAreNotPersistedInControlPlaneSnapshot(t *testing.T) {
	data, err := json.Marshal(&controlPlane{
		MeshNodes: map[string]meshNodeRecord{},
		MeshEvents: map[string][]meshEventRecord{
			"node-target": {{Payload: json.RawMessage(`{"command":"sensitive"`)}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte("sensitive")) || bytes.Contains(data, []byte("meshEvents")) {
		t.Fatalf("mesh event payload must not be present in control-plane snapshot: %s", data)
	}
}
