package pairing

import (
	"crypto/rand"
	"fmt"
)

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func GenerateCode() (string, error) {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	for i := range buf {
		buf[i] = alphabet[int(buf[i])%len(alphabet)]
	}
	return fmt.Sprintf("%s-%s", string(buf[:4]), string(buf[4:])), nil
}

func NormalizeCode(code string) string {
	out := make([]byte, 0, 9)
	for i := 0; i < len(code); i++ {
		c := code[i]
		if c == '-' || c == ' ' || c == '\t' {
			continue
		}
		if c >= 'a' && c <= 'z' {
			c -= 'a' - 'A'
		}
		out = append(out, c)
	}
	if len(out) == 8 {
		return fmt.Sprintf("%s-%s", string(out[:4]), string(out[4:]))
	}
	return string(out)
}
