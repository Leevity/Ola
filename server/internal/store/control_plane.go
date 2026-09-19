package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Organization records are deliberately separate from the historical JSON
// control-plane snapshot. PostgreSQL is the authority in production.
type Organization struct {
	ID        string
	Name      string
	Status    string
	CreatedBy string
	CreatedAt time.Time
}

type OrganizationMember struct {
	OrganizationID string
	AccountID      string
	Email          string
	DisplayName    string
	Role           string
}

type OrganizationApplication struct {
	ID             string
	OrganizationID string
	Name           string
	ApplicantID    string
	Email          string
	Status         string
	CreatedAt      time.Time
}

type ModelConfig struct {
	ID             string
	OrganizationID string
	Provider       string
	Model          string
	Enabled        bool
	IsDefault      bool
	UpdatedAt      time.Time
}

// ControlPlaneRepository is intentionally optional: the memory store keeps
// fast isolated tests, while Postgres uses transactional relational state.
type ControlPlaneRepository interface {
	ListOrganizations(accountID string, includeAll bool) ([]Organization, error)
	ListMemberships(accountID string) ([]OrganizationMember, error)
	CreateOrganization(Organization, OrganizationMember, *OrganizationApplication) error
	ListOrganizationApplications() ([]OrganizationApplication, error)
	ReviewOrganizationApplication(organizationID, action string) (Organization, OrganizationApplication, error)
	CanAccessOrganization(accountID, organizationID string) (bool, error)
	IsOrganizationAdmin(accountID, organizationID string) (bool, error)
	ListModelConfigs(organizationID string) ([]ModelConfig, error)
	AddModelConfig(ModelConfig) error
	ProviderForOrganization(accountID, organizationID string) (ModelConfig, bool, error)
	ListOrganizationMembers(organizationID string) ([]OrganizationMember, error)
	AddOrganizationMember(organizationID, email string) (OrganizationMember, error)
}

// LegacyControlPlaneMigrator imports the old JSON snapshot exactly once when
// relational control-plane tables are empty. It deliberately omits legacy
// provider origins and credentials.
type LegacyControlPlaneMigrator interface {
	MigrateLegacyControlPlaneSnapshot(payload []byte) error
}

var _ ControlPlaneRepository = (*PostgresStore)(nil)
var _ LegacyControlPlaneMigrator = (*PostgresStore)(nil)

type legacyControlPlaneSnapshot struct {
	Teams map[string]struct {
		Name      string    `json:"name"`
		Status    string    `json:"status"`
		CreatedBy string    `json:"createdBy"`
		CreatedAt time.Time `json:"createdAt"`
	} `json:"teams"`
	Members      map[string][]legacyControlPlaneMember `json:"members"`
	Applications map[string]struct {
		TeamID    string    `json:"teamId"`
		Applicant string    `json:"applicant"`
		Email     string    `json:"email"`
		Status    string    `json:"status"`
		CreatedAt time.Time `json:"createdAt"`
	} `json:"applications"`
	Models map[string][]struct {
		ProviderID string `json:"providerId"`
		Model      string `json:"model"`
		Enabled    bool   `json:"enabled"`
		IsDefault  bool   `json:"isDefault"`
	} `json:"models"`
}

type legacyControlPlaneMember struct {
	UserID string `json:"userId"`
	Email  string `json:"email"`
	Role   string `json:"role"`
}

func (s *PostgresStore) MigrateLegacyControlPlaneSnapshot(payload []byte) error {
	if len(payload) == 0 {
		return nil
	}
	var snapshot legacyControlPlaneSnapshot
	if err := json.Unmarshal(payload, &snapshot); err != nil || len(snapshot.Teams) == 0 {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var existing int
	if err = tx.QueryRow(`SELECT COUNT(*) FROM organizations`).Scan(&existing); err != nil {
		return err
	}
	if existing != 0 {
		return tx.Commit()
	}

	teamIDs := make(map[string]string, len(snapshot.Teams))
	for legacyID, legacyTeam := range snapshot.Teams {
		members := snapshot.Members[legacyID]
		creatorID := lookupLegacyAccountID(tx, legacyTeam.CreatedBy, members)
		if creatorID == "" {
			// A snapshot from a different deployment must not create an orphaned
			// organization or guess account ownership. Failing the transaction is
			// safer than silently dropping a team's authorization state.
			return errors.New("legacy organization owner cannot be mapped to an account")
		}
		status := legacyTeam.Status
		if status != "approved" && status != "rejected" {
			status = "pending"
		}
		name := strings.TrimSpace(legacyTeam.Name)
		if name == "" || len(name) > 100 {
			return errors.New("legacy organization name is invalid")
		}
		createdAt := legacyTeam.CreatedAt
		if createdAt.IsZero() {
			createdAt = time.Now().UTC()
		}
		organizationID := randomID()
		if _, err = tx.Exec(`INSERT INTO organizations (id,name,status,created_by,created_at) VALUES ($1,$2,$3,$4,$5)`, organizationID, name, status, creatorID, createdAt); err != nil {
			return err
		}
		teamIDs[legacyID] = organizationID
		seenMembers := map[string]bool{}
		for _, legacyMember := range members {
			accountID := lookupLegacyAccountID(tx, legacyMember.UserID, []legacyControlPlaneMember{legacyMember})
			if accountID == "" || seenMembers[accountID] {
				continue
			}
			seenMembers[accountID] = true
			role := "member"
			if legacyMember.Role == "team_admin" || (accountID == creatorID && status == "approved") {
				role = "team_admin"
			}
			if _, err = tx.Exec(`INSERT INTO organization_members (organization_id,account_id,role) VALUES ($1,$2,$3)`, organizationID, accountID, role); err != nil {
				return err
			}
		}
		if !seenMembers[creatorID] {
			role := "member"
			if status == "approved" {
				role = "team_admin"
			}
			if _, err = tx.Exec(`INSERT INTO organization_members (organization_id,account_id,role) VALUES ($1,$2,$3)`, organizationID, creatorID, role); err != nil {
				return err
			}
		}
		defaultAssigned := false
		for _, legacyModel := range snapshot.Models[legacyID] {
			// Only the platform registry identifier is safe to retain. Prior
			// snapshots may contain arbitrary origins and browser-supplied keys.
			if legacyModel.ProviderID != "platform-default" || strings.TrimSpace(legacyModel.Model) == "" || len(legacyModel.Model) > 160 {
				continue
			}
			isDefault := legacyModel.IsDefault && !defaultAssigned
			if isDefault {
				defaultAssigned = true
			}
			if _, err = tx.Exec(`INSERT INTO model_configs (id,organization_id,provider,model,enabled,is_default,updated_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())`, randomID(), organizationID, legacyModel.ProviderID, strings.TrimSpace(legacyModel.Model), legacyModel.Enabled, isDefault); err != nil {
				return err
			}
		}
	}
	for legacyTeamID, legacyApplication := range snapshot.Applications {
		organizationID := teamIDs[legacyTeamID]
		if organizationID == "" {
			continue
		}
		applicantID := lookupLegacyAccountID(tx, legacyApplication.Applicant, nil)
		if applicantID == "" {
			applicantID = lookupLegacyAccountID(tx, "", []legacyControlPlaneMember{{Email: legacyApplication.Email}})
		}
		if applicantID == "" {
			return errors.New("legacy organization application owner cannot be mapped to an account")
		}
		status := legacyApplication.Status
		if status != "approved" && status != "rejected" {
			status = "pending"
		}
		createdAt := legacyApplication.CreatedAt
		if createdAt.IsZero() {
			createdAt = time.Now().UTC()
		}
		if _, err = tx.Exec(`INSERT INTO organization_applications (id,organization_id,applicant_id,status,created_at,reviewed_at) VALUES ($1,$2,$3,$4,$5,CASE WHEN $4='pending' THEN NULL ELSE NOW() END)`, randomID(), organizationID, applicantID, status, createdAt); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func lookupLegacyAccountID(tx *sql.Tx, legacyID string, members []legacyControlPlaneMember) string {
	legacyID = strings.TrimSpace(legacyID)
	if legacyID != "" {
		var accountID string
		if err := tx.QueryRow(`SELECT id::text FROM accounts WHERE id::text=$1`, legacyID).Scan(&accountID); err == nil {
			return accountID
		}
	}
	for _, member := range members {
		email := strings.ToLower(strings.TrimSpace(member.Email))
		if email == "" {
			continue
		}
		var accountID string
		if err := tx.QueryRow(`SELECT id::text FROM accounts WHERE email=$1`, email).Scan(&accountID); err == nil {
			return accountID
		}
	}
	return ""
}

func (s *PostgresStore) ListOrganizations(accountID string, includeAll bool) ([]Organization, error) {
	query := `SELECT id,name,status,created_by,created_at FROM organizations`
	args := []any{}
	if !includeAll {
		query += ` WHERE id IN (SELECT organization_id FROM organization_members WHERE account_id=$1)`
		args = append(args, accountID)
	}
	query += ` ORDER BY created_at DESC`
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Organization{}
	for rows.Next() {
		var item Organization
		if err := rows.Scan(&item.ID, &item.Name, &item.Status, &item.CreatedBy, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) ListMemberships(accountID string) ([]OrganizationMember, error) {
	rows, err := s.db.Query(`SELECT m.organization_id,m.account_id,a.email,COALESCE(a.display_name,''),m.role
		FROM organization_members m JOIN accounts a ON a.id=m.account_id WHERE m.account_id=$1`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []OrganizationMember{}
	for rows.Next() {
		var item OrganizationMember
		if err := rows.Scan(&item.OrganizationID, &item.AccountID, &item.Email, &item.DisplayName, &item.Role); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) CreateOrganization(org Organization, member OrganizationMember, application *OrganizationApplication) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT INTO organizations (id,name,status,created_by,created_at) VALUES ($1,$2,$3,$4,$5)`, org.ID, org.Name, org.Status, org.CreatedBy, org.CreatedAt); err != nil {
		return err
	}
	if _, err = tx.Exec(`INSERT INTO organization_members (organization_id,account_id,role) VALUES ($1,$2,$3)`, member.OrganizationID, member.AccountID, member.Role); err != nil {
		return err
	}
	if application != nil {
		if _, err = tx.Exec(`INSERT INTO organization_applications (id,organization_id,applicant_id,status,created_at) VALUES ($1,$2,$3,$4,$5)`, application.ID, application.OrganizationID, application.ApplicantID, application.Status, application.CreatedAt); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *PostgresStore) ListOrganizationApplications() ([]OrganizationApplication, error) {
	rows, err := s.db.Query(`SELECT app.id,app.organization_id,o.name,app.applicant_id,a.email,app.status,app.created_at
		FROM organization_applications app JOIN organizations o ON o.id=app.organization_id JOIN accounts a ON a.id=app.applicant_id ORDER BY app.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []OrganizationApplication{}
	for rows.Next() {
		var item OrganizationApplication
		if err := rows.Scan(&item.ID, &item.OrganizationID, &item.Name, &item.ApplicantID, &item.Email, &item.Status, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) ReviewOrganizationApplication(organizationID, action string) (Organization, OrganizationApplication, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return Organization{}, OrganizationApplication{}, err
	}
	defer tx.Rollback()
	var org Organization
	if err = tx.QueryRow(`SELECT id,name,status,created_by,created_at FROM organizations WHERE id=$1 FOR UPDATE`, organizationID).Scan(&org.ID, &org.Name, &org.Status, &org.CreatedBy, &org.CreatedAt); err != nil {
		return Organization{}, OrganizationApplication{}, err
	}
	var app OrganizationApplication
	if err = tx.QueryRow(`SELECT app.id,app.organization_id,o.name,app.applicant_id,a.email,app.status,app.created_at FROM organization_applications app JOIN organizations o ON o.id=app.organization_id JOIN accounts a ON a.id=app.applicant_id WHERE app.organization_id=$1 FOR UPDATE`, organizationID).Scan(&app.ID, &app.OrganizationID, &app.Name, &app.ApplicantID, &app.Email, &app.Status, &app.CreatedAt); err != nil {
		return Organization{}, OrganizationApplication{}, err
	}
	if app.Status != "pending" {
		return Organization{}, OrganizationApplication{}, errors.New("application has already been reviewed")
	}
	if action == "approve" {
		org.Status, app.Status = "approved", "approved"
		if _, err = tx.Exec(`UPDATE organizations SET status='approved' WHERE id=$1`, organizationID); err != nil {
			return Organization{}, OrganizationApplication{}, err
		}
		if _, err = tx.Exec(`UPDATE organization_members SET role='team_admin' WHERE organization_id=$1 AND account_id=$2`, organizationID, org.CreatedBy); err != nil {
			return Organization{}, OrganizationApplication{}, err
		}
	} else if action == "reject" {
		org.Status = "rejected"
		app.Status = "rejected"
		if _, err = tx.Exec(`UPDATE organizations SET status='rejected' WHERE id=$1`, organizationID); err != nil {
			return Organization{}, OrganizationApplication{}, err
		}
	} else {
		return Organization{}, OrganizationApplication{}, errors.New("invalid application action")
	}
	if _, err = tx.Exec(`UPDATE organization_applications SET status=$2, reviewed_at=NOW() WHERE id=$1`, app.ID, app.Status); err != nil {
		return Organization{}, OrganizationApplication{}, err
	}
	return org, app, tx.Commit()
}

func (s *PostgresStore) CanAccessOrganization(accountID, organizationID string) (bool, error) {
	var exists bool
	err := s.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM organization_members WHERE organization_id=$1 AND account_id=$2)`, organizationID, accountID).Scan(&exists)
	return exists, err
}

func (s *PostgresStore) IsOrganizationAdmin(accountID, organizationID string) (bool, error) {
	var exists bool
	err := s.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM organization_members WHERE organization_id=$1 AND account_id=$2 AND role='team_admin')`, organizationID, accountID).Scan(&exists)
	return exists, err
}

func (s *PostgresStore) ListModelConfigs(organizationID string) ([]ModelConfig, error) {
	rows, err := s.db.Query(`SELECT id,organization_id,provider,model,enabled,is_default,updated_at FROM model_configs WHERE organization_id=$1 ORDER BY updated_at DESC`, organizationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ModelConfig{}
	for rows.Next() {
		var item ModelConfig
		if err := rows.Scan(&item.ID, &item.OrganizationID, &item.Provider, &item.Model, &item.Enabled, &item.IsDefault, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) AddModelConfig(config ModelConfig) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE`, config.OrganizationID); err != nil {
		return err
	}
	if config.IsDefault {
		if _, err = tx.Exec(`UPDATE model_configs SET is_default=false,updated_at=NOW() WHERE organization_id=$1`, config.OrganizationID); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(`INSERT INTO model_configs (id,organization_id,provider,model,enabled,is_default,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, config.ID, config.OrganizationID, config.Provider, config.Model, config.Enabled, config.IsDefault, config.UpdatedAt); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *PostgresStore) ProviderForOrganization(accountID, organizationID string) (ModelConfig, bool, error) {
	var item ModelConfig
	err := s.db.QueryRow(`SELECT c.id,c.organization_id,c.provider,c.model,c.enabled,c.is_default,c.updated_at FROM model_configs c
		JOIN organization_members m ON m.organization_id=c.organization_id WHERE c.organization_id=$1 AND m.account_id=$2 AND c.enabled=true
		ORDER BY c.is_default DESC,c.updated_at DESC LIMIT 1`, organizationID, accountID).Scan(&item.ID, &item.OrganizationID, &item.Provider, &item.Model, &item.Enabled, &item.IsDefault, &item.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return ModelConfig{}, false, nil
	}
	return item, err == nil, err
}

func (s *PostgresStore) ListOrganizationMembers(organizationID string) ([]OrganizationMember, error) {
	rows, err := s.db.Query(`SELECT m.organization_id,m.account_id,a.email,COALESCE(a.display_name,''),m.role FROM organization_members m JOIN accounts a ON a.id=m.account_id WHERE m.organization_id=$1 ORDER BY m.created_at`, organizationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []OrganizationMember{}
	for rows.Next() {
		var item OrganizationMember
		if err := rows.Scan(&item.OrganizationID, &item.AccountID, &item.Email, &item.DisplayName, &item.Role); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) AddOrganizationMember(organizationID, email string) (OrganizationMember, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	var member OrganizationMember
	err := s.db.QueryRow(`WITH account_match AS (SELECT id,email,COALESCE(display_name,'') AS display_name FROM accounts WHERE email=$2), inserted AS (
		INSERT INTO organization_members (organization_id,account_id,role) SELECT $1,id,'member' FROM account_match ON CONFLICT (organization_id,account_id) DO NOTHING RETURNING organization_id,account_id,role)
		SELECT i.organization_id,i.account_id,a.email,a.display_name,i.role FROM inserted i JOIN account_match a ON a.id=i.account_id`, organizationID, email).Scan(&member.OrganizationID, &member.AccountID, &member.Email, &member.DisplayName, &member.Role)
	if errors.Is(err, sql.ErrNoRows) {
		return OrganizationMember{}, errors.New("account not found or member already exists")
	}
	return member, err
}
