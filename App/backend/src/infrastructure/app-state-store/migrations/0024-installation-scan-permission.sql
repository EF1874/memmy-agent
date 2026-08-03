INSERT OR IGNORE INTO cloud_accounts (
  uuid,
  created_at,
  updated_at
) VALUES (
  'local-agent-sources',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

INSERT OR IGNORE INTO account_onboarding_state (
  uuid,
  scan_permission,
  created_at,
  updated_at
)
SELECT
  'local-agent-sources',
  COALESCE(
    (
      SELECT onboarding.scan_permission
      FROM account_onboarding_state onboarding
      JOIN app_settings settings ON settings.id = 'default'
      WHERE onboarding.uuid = settings.active_uuid
        AND onboarding.scan_permission != 'unset'
      LIMIT 1
    ),
    (
      SELECT scan_permission
      FROM account_onboarding_state
      WHERE uuid = 'local-byok-onboarding'
        AND scan_permission != 'unset'
      LIMIT 1
    ),
    (
      SELECT scan_permission
      FROM account_onboarding_state
      WHERE scan_permission != 'unset'
      ORDER BY updated_at DESC
      LIMIT 1
    ),
    'unset'
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

UPDATE account_onboarding_state
SET scan_permission = 'unset',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE uuid != 'local-agent-sources'
  AND scan_permission != 'unset';
