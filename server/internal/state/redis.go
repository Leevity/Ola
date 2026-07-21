package state

import (
	"context"
	"errors"
	"log"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"ola-remote-server/internal/signaling"
)

const revokeChannel = "ola:remote:device-revoked"
const signalChannel = "ola:remote:signal"
const deviceOnlineTTL = 75 * time.Second
const deviceRemoteAllowedTTL = 75 * time.Second
const pairingCodePrefix = "ola:remote:pairing:code:"
const pairingDevicePrefix = "ola:remote:pairing:device:"
const remoteTicketPrefix = "ola:remote:ticket:"
const remoteSessionPrefix = "ola:remote:session:"
const remoteDeviceSessionsPrefix = "ola:remote:device-sessions:"

type RedisState struct {
	client *redis.Client
}

func NewRedisState(ctx context.Context, addr string) (*RedisState, error) {
	client := redis.NewClient(&redis.Options{Addr: addr})
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, err
	}
	return &RedisState{client: client}, nil
}

func (s *RedisState) Close() error { return s.client.Close() }

var revokeDeviceScript = redis.NewScript(`
local sessions = redis.call('SMEMBERS', KEYS[3])
for _, sessionID in ipairs(sessions) do
  local sessionKey = ARGV[4] .. sessionID
  local controller = redis.call('HGET', sessionKey, 'controller')
  local controlled = redis.call('HGET', sessionKey, 'controlled')
  if controller then redis.call('SREM', ARGV[5] .. controller, sessionID) end
  if controlled then redis.call('SREM', ARGV[5] .. controlled, sessionID) end
  redis.call('DEL', sessionKey)
end
redis.call('DEL', KEYS[3])
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('DEL', KEYS[2])
redis.call('PUBLISH', ARGV[3], ARGV[6])
return #sessions
`)

func (s *RedisState) RevokeDevice(deviceID string) {
	if deviceID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	now := time.Now().UnixMilli()
	if _, err := revokeDeviceScript.Run(ctx, s.client, []string{
		"ola:remote:revoked:" + deviceID,
		"ola:remote:allowed:" + deviceID,
		remoteDeviceSessionsPrefix + deviceID,
	}, now, int64((10*time.Minute)/time.Millisecond), revokeChannel, remoteSessionPrefix,
		remoteDeviceSessionsPrefix, deviceID).Result(); err != nil {
		log.Printf("publish remote device revocation: %v", err)
	}
}

func (s *RedisState) ConsumeRemoteTicket(id string, expiresAt time.Time) bool {
	ttl := time.Until(expiresAt)
	if id == "" || ttl <= 0 {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	consumed, err := s.client.SetNX(ctx, remoteTicketPrefix+id, "1", ttl).Result()
	return err == nil && consumed
}

var saveRemoteSessionScript = redis.NewScript(`
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
for index = 2, 3 do
  local sessions = redis.call('SMEMBERS', KEYS[index])
  for _, sessionID in ipairs(sessions) do
    if redis.call('EXISTS', ARGV[8] .. sessionID) == 0 then
      redis.call('SREM', KEYS[index], sessionID)
    end
  end
  if redis.call('SCARD', KEYS[index]) > 0 then return -1 end
end
redis.call('HSET', KEYS[1],
  'accountID', ARGV[1], 'controller', ARGV[2], 'controlled', ARGV[3],
  'startedAt', ARGV[4], 'expiresAt', ARGV[5])
redis.call('PEXPIRE', KEYS[1], ARGV[6])
for index = 2, 3 do
  redis.call('SADD', KEYS[index], ARGV[7])
  local currentTTL = redis.call('PTTL', KEYS[index])
  if currentTTL < tonumber(ARGV[6]) then redis.call('PEXPIRE', KEYS[index], ARGV[6]) end
end
return 1
`)

func (s *RedisState) SaveRemoteSession(session signaling.SharedAuthorizedSession) error {
	ttl := time.Until(session.ExpiresAt)
	if session.ID == "" || ttl <= 0 {
		return errors.New("invalid remote session lease")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	created, err := saveRemoteSessionScript.Run(ctx, s.client, []string{
		remoteSessionPrefix + session.ID,
		remoteDeviceSessionsPrefix + session.Controller,
		remoteDeviceSessionsPrefix + session.Controlled,
	}, session.AccountID, session.Controller, session.Controlled, session.StartedAt.UnixMilli(),
		session.ExpiresAt.UnixMilli(), ttl.Milliseconds(), session.ID, remoteSessionPrefix).Int()
	if err != nil {
		return err
	}
	if created == -1 {
		return signaling.ErrRemoteDeviceBusy
	}
	if created != 1 {
		return errors.New("remote session already exists")
	}
	return nil
}

func (s *RedisState) GetRemoteSession(sessionID string) (signaling.SharedAuthorizedSession, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	values, err := s.client.HGetAll(ctx, remoteSessionPrefix+sessionID).Result()
	if err != nil || len(values) == 0 {
		return signaling.SharedAuthorizedSession{}, false
	}
	startedAt, startErr := strconv.ParseInt(values["startedAt"], 10, 64)
	expiresAt, expiryErr := strconv.ParseInt(values["expiresAt"], 10, 64)
	if startErr != nil || expiryErr != nil || time.Now().UnixMilli() >= expiresAt {
		return signaling.SharedAuthorizedSession{}, false
	}
	return signaling.SharedAuthorizedSession{
		ID: sessionID, AccountID: values["accountID"], Controller: values["controller"],
		Controlled: values["controlled"], StartedAt: time.UnixMilli(startedAt),
		ExpiresAt: time.UnixMilli(expiresAt),
	}, true
}

var deleteRemoteSessionScript = redis.NewScript(`
local controller = redis.call('HGET', KEYS[1], 'controller')
local controlled = redis.call('HGET', KEYS[1], 'controlled')
if controller then redis.call('SREM', ARGV[1] .. controller, ARGV[2]) end
if controlled then redis.call('SREM', ARGV[1] .. controlled, ARGV[2]) end
return redis.call('DEL', KEYS[1])
`)

func (s *RedisState) DeleteRemoteSession(sessionID string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := deleteRemoteSessionScript.Run(ctx, s.client,
		[]string{remoteSessionPrefix + sessionID}, remoteDeviceSessionsPrefix, sessionID).Result(); err != nil {
		log.Printf("delete shared remote session: %v", err)
	}
}

func (s *RedisState) PublishSignal(payload []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	return s.client.Publish(ctx, signalChannel, payload).Err()
}

func (s *RedisState) TouchDevice(deviceID string) {
	if deviceID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	pipe := s.client.TxPipeline()
	pipe.Set(ctx, "ola:remote:online:"+deviceID, "1", deviceOnlineTTL)
	pipe.Expire(ctx, "ola:remote:allowed:"+deviceID, deviceRemoteAllowedTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		log.Printf("refresh remote device lease: %v", err)
	}
}

func (s *RedisState) IsDeviceOnline(deviceID string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	count, err := s.client.Exists(ctx, "ola:remote:online:"+deviceID).Result()
	return err == nil && count > 0
}

func (s *RedisState) RevokedAt(deviceID string) (time.Time, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	value, err := s.client.Get(ctx, "ola:remote:revoked:"+deviceID).Result()
	if err != nil {
		return time.Time{}, false
	}
	millis, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return time.Time{}, false
	}
	return time.UnixMilli(millis), true
}

func (s *RedisState) SetDeviceRemoteAllowed(deviceID string, allowed bool) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	key := "ola:remote:allowed:" + deviceID
	var err error
	if allowed {
		err = s.client.Set(ctx, key, "1", deviceRemoteAllowedTTL).Err()
	} else {
		err = s.client.Del(ctx, key).Err()
	}
	if err != nil {
		log.Printf("set remote device permission: %v", err)
	}
}

func (s *RedisState) IsDeviceRemoteAllowed(deviceID string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	count, err := s.client.Exists(ctx, "ola:remote:allowed:"+deviceID).Result()
	return err == nil && count > 0
}

var consumeAttemptScript = redis.NewScript(`
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`)

func (s *RedisState) ConsumePairingAttempt(key string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	count, err := consumeAttemptScript.Run(ctx, s.client,
		[]string{"ola:remote:pairing-failures:" + key}, int((5*time.Minute)/time.Second)).Int()
	return err == nil && count <= 5
}

func (s *RedisState) ClearPairingFailures(key string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := s.client.Del(ctx, "ola:remote:pairing-failures:"+key).Err(); err != nil {
		log.Printf("clear pairing failures: %v", err)
	}
}

func (s *RedisState) ConsumeAuthAttempt(key string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	count, err := consumeAttemptScript.Run(ctx, s.client,
		[]string{"ola:remote:auth-failures:" + key}, int((15*time.Minute)/time.Second)).Int()
	return err == nil && count <= 10
}

func (s *RedisState) ClearAuthFailures(key string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := s.client.Del(ctx, "ola:remote:auth-failures:"+key).Err(); err != nil {
		log.Printf("clear authentication failures: %v", err)
	}
}

var consumeRegistrationScript = redis.NewScript(`
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`)

func (s *RedisState) ConsumeRegistrationAttempt(key string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	count, err := consumeRegistrationScript.Run(ctx, s.client,
		[]string{"ola:remote:registration-attempts:" + key}, int((time.Hour)/time.Second)).Int()
	return err == nil && count <= 5
}

func (s *RedisState) SaveEphemeralPairing(code, deviceID string, ttl time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	pipe := s.client.TxPipeline()
	pipe.Set(ctx, pairingCodePrefix+code, deviceID, ttl)
	pipe.SAdd(ctx, pairingDevicePrefix+deviceID, code)
	pipe.Expire(ctx, pairingDevicePrefix+deviceID, ttl)
	_, err := pipe.Exec(ctx)
	return err
}

var consumePairingScript = redis.NewScript(`
local device = redis.call('GET', KEYS[1])
if not device then return nil end
local ttl = redis.call('PTTL', KEYS[1])
redis.call('DEL', KEYS[1])
redis.call('SREM', ARGV[1] .. device, ARGV[2])
return {device, ttl}
`)

func (s *RedisState) ConsumeEphemeralPairing(code string) (string, time.Time, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result, err := consumePairingScript.Run(ctx, s.client, []string{pairingCodePrefix + code},
		pairingDevicePrefix, code).Slice()
	if err == redis.Nil || len(result) != 2 {
		return "", time.Time{}, errors.New("pairing code is invalid or expired")
	}
	if err != nil {
		return "", time.Time{}, err
	}
	deviceID, ok := result[0].(string)
	ttlMillis, okTTL := result[1].(int64)
	if !ok || !okTTL || ttlMillis <= 0 {
		return "", time.Time{}, errors.New("pairing code is invalid or expired")
	}
	return deviceID, time.Now().Add(time.Duration(ttlMillis) * time.Millisecond), nil
}

var revokePairingsScript = redis.NewScript(`
local codes = redis.call('SMEMBERS', KEYS[1])
for _, code in ipairs(codes) do redis.call('DEL', ARGV[1] .. code) end
redis.call('DEL', KEYS[1])
return #codes
`)

func (s *RedisState) RevokeEphemeralPairings(deviceID string) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	count, err := revokePairingsScript.Run(ctx, s.client,
		[]string{pairingDevicePrefix + deviceID}, pairingCodePrefix).Int()
	return count, err
}

func (s *RedisState) RevokeAccountToken(id string, expiresAt time.Time) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	ttl := time.Until(expiresAt)
	if ttl <= 0 {
		return
	}
	if err := s.client.Set(ctx, "ola:remote:token-revoked:"+id, "1", ttl).Err(); err != nil {
		log.Printf("revoke account token: %v", err)
	}
}

func (s *RedisState) IsAccountTokenRevoked(id string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	count, err := s.client.Exists(ctx, "ola:remote:token-revoked:"+id).Result()
	return err == nil && count > 0
}

func (s *RedisState) SubscribeRevocations(
	ctx context.Context,
	callback func(string),
	ready chan<- struct{},
) {
	subscription := s.client.Subscribe(ctx, revokeChannel)
	defer subscription.Close()
	if _, err := subscription.Receive(ctx); err != nil {
		log.Printf("subscribe remote revocations: %v", err)
		return
	}
	close(ready)
	for message := range subscription.Channel() {
		callback(message.Payload)
	}
}

func (s *RedisState) SubscribeSignals(
	ctx context.Context,
	callback func([]byte),
	ready chan<- struct{},
) {
	subscription := s.client.Subscribe(ctx, signalChannel)
	defer subscription.Close()
	if _, err := subscription.Receive(ctx); err != nil {
		log.Printf("subscribe shared signals: %v", err)
		return
	}
	close(ready)
	for message := range subscription.Channel() {
		callback([]byte(message.Payload))
	}
}

type LocalRevoker interface {
	RevokeDevice(deviceID string)
}

type Coordinator struct {
	local  LocalRevoker
	shared *RedisState
}

func NewCoordinator(local LocalRevoker, shared *RedisState) *Coordinator {
	return &Coordinator{local: local, shared: shared}
}

func (c *Coordinator) RevokeDevice(deviceID string) {
	c.local.RevokeDevice(deviceID)
	c.shared.RevokeDevice(deviceID)
}

func (c *Coordinator) SetDeviceRemoteAllowed(deviceID string, allowed bool) {
	if local, ok := c.local.(interface{ SetDeviceRemoteAllowed(string, bool) }); ok {
		local.SetDeviceRemoteAllowed(deviceID, allowed)
	}
	c.shared.SetDeviceRemoteAllowed(deviceID, allowed)
}

func (c *Coordinator) IsDeviceRemoteAllowed(deviceID string) bool {
	return c.shared.IsDeviceRemoteAllowed(deviceID)
}

func (c *Coordinator) TouchDevice(deviceID string) { c.shared.TouchDevice(deviceID) }

func (c *Coordinator) IsDeviceOnline(deviceID string) bool {
	return c.shared.IsDeviceOnline(deviceID)
}

func (c *Coordinator) ConsumePairingAttempt(key string) bool {
	return c.shared.ConsumePairingAttempt(key)
}
func (c *Coordinator) ClearPairingFailures(key string) { c.shared.ClearPairingFailures(key) }
func (c *Coordinator) ConsumeAuthAttempt(key string) bool {
	return c.shared.ConsumeAuthAttempt(key)
}
func (c *Coordinator) ClearAuthFailures(key string) { c.shared.ClearAuthFailures(key) }
func (c *Coordinator) ConsumeRegistrationAttempt(key string) bool {
	return c.shared.ConsumeRegistrationAttempt(key)
}
func (c *Coordinator) RevokeAccountToken(id string, expiresAt time.Time) {
	c.shared.RevokeAccountToken(id, expiresAt)
}
func (c *Coordinator) IsAccountTokenRevoked(id string) bool {
	return c.shared.IsAccountTokenRevoked(id)
}
func (c *Coordinator) SaveEphemeralPairing(code, deviceID string, ttl time.Duration) error {
	return c.shared.SaveEphemeralPairing(code, deviceID, ttl)
}
func (c *Coordinator) ConsumeEphemeralPairing(code string) (string, time.Time, error) {
	return c.shared.ConsumeEphemeralPairing(code)
}
func (c *Coordinator) RevokeEphemeralPairings(deviceID string) (int, error) {
	return c.shared.RevokeEphemeralPairings(deviceID)
}
