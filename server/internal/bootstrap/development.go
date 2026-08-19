package bootstrap

import (
	"log"
	"os"

	"ola-remote-server/internal/store"
)

type DevAccount struct {
	Email       string
	Password    string
	DisplayName string
}

var DefaultDevelopmentAccounts = []DevAccount{
	{Email: "admin@ola.test", Password: "OlaAdmin123!", DisplayName: "Ola System Admin"},
	{Email: "team-admin@ola.test", Password: "OlaTeam123!", DisplayName: "Ola Team Admin"},
	{Email: "user@ola.test", Password: "OlaUser123!", DisplayName: "Ola Basic User"},
}

// SeedDevelopmentAccounts creates predictable local-only accounts for manually
// inspecting the role-based control plane. It is deliberately never called in production.
func SeedDevelopmentAccounts(st store.Store) {
	if os.Getenv("OLA_REMOTE_DEV_SEED") == "0" {
		return
	}
	for _, account := range DefaultDevelopmentAccounts {
		if _, err := st.Login(account.Email, account.Password); err == nil {
			continue
		}
		if _, err := st.RegisterAccount(account.Email, account.Password, account.DisplayName); err != nil {
			log.Printf("development account %s was not seeded: %v", account.Email, err)
			continue
		}
		log.Printf("development account ready: %s", account.Email)
	}
}
