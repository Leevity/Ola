package signaling

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const websocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const websocketReadTimeout = 90 * time.Second
const websocketWriteTimeout = 10 * time.Second

type WebSocketConn struct {
	conn net.Conn
	buf  *bufio.ReadWriter
	mu   sync.Mutex
}

func AcceptWebSocket(
	w http.ResponseWriter,
	r *http.Request,
	responseProtocol string,
) (*WebSocketConn, error) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return nil, errors.New("missing websocket upgrade header")
	}
	if !headerContainsToken(r.Header.Get("Connection"), "upgrade") {
		return nil, errors.New("missing websocket connection upgrade token")
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		return nil, errors.New("unsupported websocket version")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	decodedKey, err := base64.StdEncoding.DecodeString(key)
	if err != nil || len(decodedKey) != 16 {
		return nil, errors.New("missing websocket key")
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("http hijacking is not supported")
	}
	conn, buf, err := hijacker.Hijack()
	if err != nil {
		return nil, err
	}
	accept := websocketAcceptKey(key)
	response := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n"
	if responseProtocol != "" {
		response += "Sec-WebSocket-Protocol: " + responseProtocol + "\r\n"
	}
	response += "\r\n"
	if _, err := conn.Write([]byte(response)); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return &WebSocketConn{conn: conn, buf: buf}, nil
}

func headerContainsToken(value, token string) bool {
	for _, item := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(item), token) {
			return true
		}
	}
	return false
}

func websocketAcceptKey(key string) string {
	hash := sha1.Sum([]byte(key + websocketGUID))
	return base64.StdEncoding.EncodeToString(hash[:])
}

func (c *WebSocketConn) ReadText() ([]byte, error) {
	for {
		opcode, payload, err := c.readFrame()
		if err != nil {
			return nil, err
		}
		switch opcode {
		case 0x1:
			return payload, nil
		case 0x8:
			return nil, io.EOF
		case 0x9:
			_ = c.writeFrame(0xA, payload)
		case 0xA:
			continue
		default:
			return nil, errors.New("unsupported websocket frame")
		}
	}
}

func (c *WebSocketConn) WriteText(payload []byte) error {
	return c.writeFrame(0x1, payload)
}

func (c *WebSocketConn) WritePing() error {
	return c.writeFrame(0x9, nil)
}

func (c *WebSocketConn) Close() error {
	_ = c.writeFrame(0x8, nil)
	return c.conn.Close()
}

func (c *WebSocketConn) readFrame() (byte, []byte, error) {
	if err := c.conn.SetReadDeadline(time.Now().Add(websocketReadTimeout)); err != nil {
		return 0, nil, err
	}
	header := make([]byte, 2)
	if _, err := io.ReadFull(c.buf, header); err != nil {
		return 0, nil, err
	}
	if header[0]&0x70 != 0 {
		return 0, nil, errors.New("websocket reserved bits are not supported")
	}
	if header[0]&0x80 == 0 {
		return 0, nil, errors.New("fragmented websocket frames are not supported")
	}
	opcode := header[0] & 0x0F
	masked := header[1]&0x80 != 0
	if !masked {
		return 0, nil, errors.New("client websocket frame must be masked")
	}
	length := uint64(header[1] & 0x7F)
	switch length {
	case 126:
		ext := make([]byte, 2)
		if _, err := io.ReadFull(c.buf, ext); err != nil {
			return 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(ext))
	case 127:
		ext := make([]byte, 8)
		if _, err := io.ReadFull(c.buf, ext); err != nil {
			return 0, nil, err
		}
		length = binary.BigEndian.Uint64(ext)
	}
	if length > 1<<20 {
		return 0, nil, errors.New("websocket frame is too large")
	}
	if opcode >= 0x8 && length > 125 {
		return 0, nil, errors.New("websocket control frame is too large")
	}
	var maskKey []byte
	maskKey = make([]byte, 4)
	if _, err := io.ReadFull(c.buf, maskKey); err != nil {
		return 0, nil, err
	}
	payload := make([]byte, int(length))
	if _, err := io.ReadFull(c.buf, payload); err != nil {
		return 0, nil, err
	}
	for i := range payload {
		payload[i] ^= maskKey[i%4]
	}
	return opcode, payload, nil
}

func (c *WebSocketConn) writeFrame(opcode byte, payload []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.conn.SetWriteDeadline(time.Now().Add(websocketWriteTimeout)); err != nil {
		return err
	}
	header := []byte{0x80 | opcode}
	length := len(payload)
	if length < 126 {
		header = append(header, byte(length))
	} else if length <= 65535 {
		header = append(header, 126, byte(length>>8), byte(length))
	} else {
		header = append(header, 127)
		ext := make([]byte, 8)
		binary.BigEndian.PutUint64(ext, uint64(length))
		header = append(header, ext...)
	}
	if _, err := c.conn.Write(header); err != nil {
		return err
	}
	if length == 0 {
		return nil
	}
	_, err := c.conn.Write(payload)
	return err
}
