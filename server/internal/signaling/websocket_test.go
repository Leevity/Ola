package signaling

import (
	"bufio"
	"net"
	"strings"
	"testing"
)

func testWebSocketPair(t *testing.T) (*WebSocketConn, net.Conn) {
	t.Helper()
	server, client := net.Pipe()
	conn := &WebSocketConn{
		conn: server,
		buf:  bufio.NewReadWriter(bufio.NewReader(server), bufio.NewWriter(server)),
	}
	t.Cleanup(func() {
		_ = server.Close()
		_ = client.Close()
	})
	return conn, client
}

func maskedFrame(opcode byte, final bool, payload []byte) []byte {
	first := opcode
	if final {
		first |= 0x80
	}
	mask := [4]byte{1, 2, 3, 4}
	frame := []byte{first, 0x80 | byte(len(payload)), mask[0], mask[1], mask[2], mask[3]}
	for index, value := range payload {
		frame = append(frame, value^mask[index%4])
	}
	return frame
}

func TestReadTextRequiresMaskedFinalClientFrame(t *testing.T) {
	conn, client := testWebSocketPair(t)
	done := make(chan error, 1)
	go func() {
		_, err := client.Write(maskedFrame(0x1, true, []byte("hello")))
		done <- err
	}()
	payload, err := conn.ReadText()
	if err != nil || string(payload) != "hello" {
		t.Fatalf("read masked text: payload=%q err=%v", payload, err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	conn, client = testWebSocketPair(t)
	go func() { _, _ = client.Write([]byte{0x81, 0x01, 'x'}) }()
	if _, err := conn.ReadText(); err == nil || !strings.Contains(err.Error(), "must be masked") {
		t.Fatalf("expected unmasked frame rejection, got %v", err)
	}

	conn, client = testWebSocketPair(t)
	go func() { _, _ = client.Write(maskedFrame(0x1, false, []byte("x"))) }()
	if _, err := conn.ReadText(); err == nil || !strings.Contains(err.Error(), "fragmented") {
		t.Fatalf("expected fragmented frame rejection, got %v", err)
	}
}
